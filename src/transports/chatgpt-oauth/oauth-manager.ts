import { timingSafeEqual } from "node:crypto";

import {
  CHATGPT_CODEX_PROFILE,
  CHATGPT_DEFAULT_TOKEN_LIFETIME_MS,
  CHATGPT_EXPIRY_SKEW_MS,
} from "./profile.js";
import {
  extractJwtMetadata,
  OAuthStore,
  type OAuthCredentials,
  type OAuthSession,
  type SecretStore,
} from "./oauth-store.js";
import { createOAuthState, createPkcePair } from "./pkce.js";
import {
  LoopbackCallbackServer,
  LoopbackError,
  type LoopbackServer,
  type LoopbackServerHandle,
} from "./loopback-server.js";

export interface OAuthHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface OAuthRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type OAuthFetch = (
  url: string,
  init?: OAuthRequestInit,
) => Promise<OAuthHttpResponse>;

export type OpenExternal = (
  url: string,
) => Promise<boolean | void> | boolean | void;

export interface OAuthManagerOptions {
  fetch?: OAuthFetch;
  loopbackServer?: LoopbackServer;
  now?: () => number;
  expirySkewMs?: number;
  tokenTimeoutMs?: number;
}

export type OAuthErrorCode =
  | "auth_required"
  | "browser_open_failed"
  | "callback_closed"
  | "callback_invalid"
  | "callback_state_mismatch"
  | "callback_timeout"
  | "callback_close_failed"
  | "callback_response_failed"
  | "oauth_failed"
  | "sign_in_in_progress"
  | "token_request_cancelled"
  | "token_exchange_failed"
  | "token_request_timeout"
  | "token_response_invalid";

export class OAuthError extends Error {
  public readonly code: OAuthErrorCode;
  public cleanupError: OAuthError | undefined;

  public constructor(code: OAuthErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OAuthError";
    this.code = code;
    this.cleanupError = undefined;
  }
}

interface ActiveSignIn {
  readonly generation: number;
  readonly state: string;
  readonly verifier: string;
  readonly tokenController: AbortController;
  server: LoopbackServerHandle | undefined;
  redirectUri: string | undefined;
  closePromise: Promise<OAuthError | undefined> | undefined;
  readonly promise: Promise<OAuthSession>;
  readonly resolve: (session: OAuthSession) => void;
  readonly reject: (error: Error) => void;
  callbackClaimed: boolean;
  terminal: boolean;
  settled: boolean;
}

interface RefreshFlight {
  readonly generation: number;
  readonly controller: AbortController;
  readonly promise: Promise<OAuthSession>;
  waiters: number;
  settled: boolean;
}

const defaultFetch: OAuthFetch = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  return response;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const isInvalidGrant = (value: unknown): boolean =>
  isRecord(value) && value.error === "invalid_grant";

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const asError = (value: unknown, fallback: OAuthError): OAuthError =>
  value instanceof OAuthError ? value : fallback;

export const OAUTH_TOKEN_REQUEST_TIMEOUT_MS = 60_000;

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

export class OAuthManager {
  private readonly store: OAuthStore;
  private readonly fetchToken: OAuthFetch;
  private readonly loopbackServer: LoopbackServer;
  private readonly now: () => number;
  private readonly expirySkewMs: number;
  private readonly tokenTimeoutMs: number;
  private activeSignIn: ActiveSignIn | undefined;
  private refreshPromise: RefreshFlight | undefined;
  private storageQueue: Promise<void> = Promise.resolve();
  private lifecycle = 0;

  public constructor(
    store: SecretStore | OAuthStore,
    options: OAuthManagerOptions = {},
  ) {
    this.store = store instanceof OAuthStore ? store : new OAuthStore(store);
    this.fetchToken = options.fetch ?? defaultFetch;
    this.loopbackServer = options.loopbackServer ?? new LoopbackCallbackServer();
    this.now = options.now ?? Date.now;
    this.expirySkewMs = options.expirySkewMs ?? CHATGPT_EXPIRY_SKEW_MS;
    this.tokenTimeoutMs = options.tokenTimeoutMs ?? OAUTH_TOKEN_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.tokenTimeoutMs) || this.tokenTimeoutMs <= 0) {
      throw new RangeError("tokenTimeoutMs must be positive");
    }
  }

  public async signIn(openExternal: OpenExternal): Promise<OAuthSession> {
    if (this.activeSignIn) {
      throw new OAuthError("sign_in_in_progress", "An OAuth sign-in is already in progress.");
    }
    this.abortRefreshFlight();

    const pair = createPkcePair();
    const state = createOAuthState();
    const pending = deferred<OAuthSession>();
    const active: ActiveSignIn = {
      generation: ++this.lifecycle,
      state,
      verifier: pair.verifier,
      tokenController: new AbortController(),
      server: undefined,
      redirectUri: undefined,
      closePromise: undefined,
      promise: pending.promise,
      resolve: pending.resolve,
      reject: pending.reject,
      callbackClaimed: false,
      terminal: false,
      settled: false,
    };
    this.activeSignIn = active;

    let server: LoopbackServerHandle;
    try {
      server = await this.loopbackServer.start(active.state);
      active.server = server;
      active.redirectUri = server.redirectUri;
    } catch (error) {
      await this.rejectActive(
        active,
        new OAuthError("oauth_failed", "The OAuth callback server could not be started.", error),
      );
      return active.promise;
    }

    if (active.terminal || this.activeSignIn !== active) {
      void this.observeCallback(active);
      await this.closeActiveServer(active);
      return active.promise;
    }

    void this.observeCallback(active);

    try {
      const opened = await openExternal(this.buildAuthorizeUrl(active, pair.challenge));
      if (opened === false) {
        throw new OAuthError(
          "browser_open_failed",
          "The browser could not be opened for ChatGPT sign-in.",
        );
      }
    } catch (error) {
      const publicError =
        error instanceof OAuthError
          ? error
          : new OAuthError(
              "browser_open_failed",
              "The browser could not be opened for ChatGPT sign-in.",
            );
      await this.rejectActive(active, publicError);
    }

    return active.promise;
  }

  public async completeManualCallback(url: string): Promise<OAuthSession> {
    const active = this.activeSignIn;
    if (!active) {
      throw new OAuthError(
        "callback_closed",
        "There is no active ChatGPT sign-in to complete.",
      );
    }
    if (active.server === undefined || active.redirectUri === undefined || active.terminal) {
      throw new OAuthError(
        "callback_closed",
        "The ChatGPT sign-in callback is not ready.",
      );
    }
    return this.completeCallback(active, url);
  }

  public async getAccessToken(
    forceRefresh = false,
    signal?: AbortSignal,
  ): Promise<OAuthCredentials> {
    const generation = this.lifecycle;
    const stored = await this.store.load();
    this.assertGeneration(generation);
    if (!stored) {
      throw new OAuthError("auth_required", "ChatGPT authentication is required.");
    }

    const shouldRefresh =
      forceRefresh || stored.expiresAt <= this.now() + this.expirySkewMs;
    if (!shouldRefresh) {
      return this.credentialsFrom(stored);
    }

    let flight = this.refreshPromise;
    if (flight?.generation !== generation) {
      const controller = new AbortController();
      const refresh = this.refreshSession(stored, generation, controller.signal);
      const createdFlight: RefreshFlight = {
        generation,
        controller,
        promise: refresh,
        waiters: 0,
        settled: false,
      };
      flight = createdFlight;
      this.refreshPromise = createdFlight;
      void refresh.finally(() => {
        createdFlight.settled = true;
        if (this.refreshPromise === createdFlight) {
          this.refreshPromise = undefined;
        }
      }).catch(() => undefined);
    }

    let refreshed: OAuthSession;
    try {
      refreshed = await this.awaitRefresh(flight, signal);
    } catch (error) {
      if (error instanceof OAuthError && error.code === "auth_required") {
        throw error;
      }
      this.assertGeneration(generation);
      throw error;
    }
    this.assertGeneration(generation);
    return this.credentialsFrom(refreshed);
  }

  private async awaitRefresh(
    flight: RefreshFlight,
    signal: AbortSignal | undefined,
  ): Promise<OAuthSession> {
    flight.waiters += 1;
    try {
      if (signal === undefined) {
        return await flight.promise;
      }
      if (signal.aborted) {
        throw new OAuthError("token_request_cancelled", "The ChatGPT OAuth token request was cancelled.");
      }
      return await new Promise<OAuthSession>((resolve, reject) => {
        const onAbort = (): void => {
          reject(new OAuthError(
            "token_request_cancelled",
            "The ChatGPT OAuth token request was cancelled.",
          ));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void flight.promise.then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", onAbort);
        }).catch(() => undefined);
      });
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled && !flight.controller.signal.aborted) {
        flight.controller.abort();
      }
    }
  }

  public async signOut(): Promise<void> {
    const active = this.activeSignIn;
    const cancellation = new OAuthError(
      "callback_closed",
      "ChatGPT sign-in was cancelled.",
    );
    this.abortRefreshFlight();
    this.lifecycle += 1;
    let callbackCleanupError: OAuthError | undefined;
    if (active) {
      const failure = await this.rejectActive(active, cancellation);
      callbackCleanupError = failure.cleanupError;
    }

    let clearError: OAuthError | undefined;
    try {
      await this.enqueueStorage(() => this.store.clear());
    } catch (error) {
      clearError = this.credentialsClearError(error);
    }

    if (callbackCleanupError !== undefined) {
      if (clearError !== undefined) {
        callbackCleanupError.cleanupError = clearError;
      }
      throw callbackCleanupError;
    }
    if (clearError !== undefined) {
      throw clearError;
    }
  }

  private buildAuthorizeUrl(active: ActiveSignIn, challenge: string): string {
    if (active.redirectUri === undefined) {
      throw new OAuthError("callback_closed", "The ChatGPT sign-in callback is not ready.");
    }
    const query = new URLSearchParams({
      client_id: CHATGPT_CODEX_PROFILE.clientId,
      response_type: "code",
      redirect_uri: active.redirectUri,
      scope: CHATGPT_CODEX_PROFILE.scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: active.state,
      originator: CHATGPT_CODEX_PROFILE.originator,
    });
    return `${CHATGPT_CODEX_PROFILE.authorizeUrl}?${query.toString()}`;
  }

  private async completeCallback(
    active: ActiveSignIn,
    url: string,
  ): Promise<OAuthSession> {
    if (this.activeSignIn !== active || active.settled || active.terminal) {
      throw new OAuthError("callback_closed", "The OAuth callback is no longer active.");
    }
    if (
      active.callbackClaimed ||
      active.server === undefined ||
      active.redirectUri === undefined
    ) {
      throw new OAuthError("callback_closed", "The OAuth callback was already handled.");
    }
    active.callbackClaimed = true;

    try {
      const code = this.validateCallback(active, url);
      const session = await this.exchangeAuthorizationCode(
        code,
        active.redirectUri,
        active.verifier,
        active.generation,
        active.tokenController.signal,
      );
      this.assertActiveGeneration(active);
      await this.saveIfCurrent(session, active.generation);
      this.assertActiveGeneration(active);
      const closeError = await this.closeActiveServer(active);
      if (closeError !== undefined) {
        throw closeError;
      }
      this.assertActiveGeneration(active);
      this.settleActive(active, session);
      return session;
    } catch (error) {
      const publicError = asError(
        error,
        new OAuthError("oauth_failed", "ChatGPT OAuth sign-in failed."),
      );
      throw await this.rejectActive(active, publicError);
    }
  }

  private validateCallback(active: ActiveSignIn, callbackUrl: string): string {
    let parsed: URL;
    let expected: URL;
    const redirectUri = active.redirectUri;
    if (redirectUri === undefined) {
      throw new OAuthError("callback_invalid", "The OAuth callback URL was invalid.");
    }
    try {
      parsed = new URL(callbackUrl);
      expected = new URL(redirectUri);
    } catch {
      throw new OAuthError("callback_invalid", "The OAuth callback URL was invalid.");
    }

    if (
      parsed.protocol !== "http:" ||
      parsed.origin !== expected.origin ||
      parsed.pathname !== CHATGPT_CODEX_PROFILE.callbackPath ||
      parsed.hash
    ) {
      throw new OAuthError("callback_invalid", "The OAuth callback URL was invalid.");
    }

    const returnedState = parsed.searchParams.get("state");
    if (!returnedState || !constantTimeEqual(returnedState, active.state)) {
      throw new OAuthError("callback_state_mismatch", "OAuth callback state mismatch.");
    }

    const authorizationError = nonEmptyString(parsed.searchParams.get("error"));
    if (authorizationError) {
      throw new OAuthError("callback_invalid", "ChatGPT authorization was denied.");
    }

    const code = nonEmptyString(parsed.searchParams.get("code"));
    if (!code) {
      throw new OAuthError("callback_invalid", "The OAuth callback did not contain a code.");
    }
    return code;
  }

  private async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
    verifier: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<OAuthSession> {
    const payload = await this.postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CHATGPT_CODEX_PROFILE.clientId,
      code_verifier: verifier,
    }, generation, signal);
    this.assertGeneration(generation);
    return this.sessionFromTokenResponse(payload, true);
  }

  private async refreshSession(
    previous: OAuthSession,
    generation: number,
    signal: AbortSignal,
  ): Promise<OAuthSession> {
    const payload = await this.postToken({
      grant_type: "refresh_token",
      refresh_token: previous.refreshToken,
      client_id: CHATGPT_CODEX_PROFILE.clientId,
    }, generation, signal);
    this.assertGeneration(generation);

    const session = this.sessionFromTokenResponse(payload, false, previous);
    this.assertGeneration(generation);
    await this.saveIfCurrent(session, generation);
    this.assertGeneration(generation);
    return session;
  }

  private async postToken(
    fields: Record<string, string>,
    generation?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: OAuthHttpResponse;
    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = (): void => controller.abort();
    if (signal?.aborted) {
      onParentAbort();
    } else {
      signal?.addEventListener("abort", onParentAbort, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.tokenTimeoutMs);
    timeout.unref?.();
    try {
      const request = Promise.resolve().then(() => this.fetchToken(CHATGPT_CODEX_PROFILE.tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields).toString(),
        signal: controller.signal,
      }));
      response = await new Promise<OAuthHttpResponse>((resolve, reject) => {
        const onAbort = (): void => reject(new OAuthError(
          timedOut ? "token_request_timeout" : "token_request_cancelled",
          timedOut
            ? "The ChatGPT OAuth token request timed out."
            : "The ChatGPT OAuth token request was cancelled.",
        ));
        if (controller.signal.aborted) {
          onAbort();
          return;
        }
        controller.signal.addEventListener("abort", onAbort, { once: true });
        void request.then(resolve, reject).finally(() => {
          controller.signal.removeEventListener("abort", onAbort);
        }).catch(() => undefined);
      });
    } catch (error) {
      if (error instanceof OAuthError) {
        throw error;
      }
      if (timedOut) {
        throw new OAuthError(
          "token_request_timeout",
          "The ChatGPT OAuth token request timed out.",
          error,
        );
      }
      if (signal?.aborted || controller.signal.aborted) {
        throw new OAuthError(
          "token_request_cancelled",
          "The ChatGPT OAuth token request was cancelled.",
          error,
        );
      }
      throw new OAuthError(
        "token_exchange_failed",
        "The ChatGPT OAuth token request failed.",
        error,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onParentAbort);
    }

    const payload = await this.readJson(response);
    if (!response.ok) {
      if (isInvalidGrant(payload)) {
        if (generation !== undefined) {
          await this.clearCredentialsIfCurrent(generation);
        } else {
          await this.clearCredentials();
        }
        throw new OAuthError(
          "auth_required",
          "ChatGPT authentication is required again.",
        );
      }
      throw new OAuthError(
        "token_exchange_failed",
        "The ChatGPT OAuth token request was rejected.",
      );
    }
    return payload;
  }

  private async readJson(response: OAuthHttpResponse): Promise<Record<string, unknown>> {
    try {
      const payload: unknown = await response.json();
      return isRecord(payload) ? payload : {};
    } catch {
      return {};
    }
  }

  private sessionFromTokenResponse(
    payload: Record<string, unknown>,
    requireRefreshToken: boolean,
    previous?: OAuthSession,
  ): OAuthSession {
    const accessToken = nonEmptyString(payload.access_token);
    const refreshToken = nonEmptyString(payload.refresh_token) ?? previous?.refreshToken;
    if (!accessToken || (requireRefreshToken && !refreshToken)) {
      throw new OAuthError(
        "token_response_invalid",
        "The ChatGPT OAuth token response was incomplete.",
      );
    }
    if (!refreshToken) {
      throw new OAuthError(
        "token_response_invalid",
        "The ChatGPT OAuth refresh response was incomplete.",
      );
    }

    const metadata = extractJwtMetadata(accessToken);
    const idToken = nonEmptyString(payload.id_token);
    const idMetadata = idToken === undefined ? {} : extractJwtMetadata(idToken);
    const expiresAt = this.expiresAt(payload, previous?.expiresAt);
    return {
      accessToken,
      refreshToken,
      expiresAt,
      ...(metadata.accountId ?? idMetadata.accountId ?? previous?.accountId
        ? { accountId: metadata.accountId ?? idMetadata.accountId ?? previous?.accountId }
        : {}),
      ...(metadata.email ?? idMetadata.email ?? previous?.email
        ? { email: metadata.email ?? idMetadata.email ?? previous?.email }
        : {}),
    };
  }

  private expiresAt(payload: Record<string, unknown>, previous?: number): number {
    const expiresIn = payload.expires_in;
    if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
      return this.now() + expiresIn * 1_000;
    }

    const expiresAt = payload.expires_at;
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
      return expiresAt < 1_000_000_000_000 ? expiresAt * 1_000 : expiresAt;
    }

    return previous ?? this.now() + CHATGPT_DEFAULT_TOKEN_LIFETIME_MS;
  }

  private credentialsFrom(session: OAuthSession): OAuthCredentials {
    return {
      token: session.accessToken,
      ...(session.accountId === undefined ? {} : { accountId: session.accountId }),
    };
  }

  private async observeCallback(active: ActiveSignIn): Promise<void> {
    const server = active.server;
    if (server === undefined) {
      return;
    }

    try {
      const url = await server.callback;
      if (active.terminal) {
        return;
      }
      await this.completeCallback(active, url);
    } catch (error) {
      if (active.terminal) {
        return;
      }
      await this.rejectActive(active, this.loopbackError(error));
    }
  }

  private settleActive(active: ActiveSignIn, session: OAuthSession): void {
    if (active.settled) {
      return;
    }
    active.terminal = true;
    active.settled = true;
    if (this.activeSignIn === active) {
      this.activeSignIn = undefined;
    }
    active.resolve(session);
  }

  private failActive(active: ActiveSignIn, error: Error): void {
    if (active.settled) {
      return;
    }
    active.terminal = true;
    active.settled = true;
    if (this.activeSignIn === active) {
      this.activeSignIn = undefined;
    }
    active.reject(error);
  }

  private async rejectActive(
    active: ActiveSignIn,
    primaryError: OAuthError,
  ): Promise<OAuthError> {
    if (active.settled) {
      return primaryError;
    }
    active.terminal = true;
    active.tokenController.abort();
    const cleanupError = await this.closeActiveServer(active, primaryError);
    const failure = this.withCleanupFailure(primaryError, cleanupError);
    this.failActive(active, failure);
    return failure;
  }

  private async closeActiveServer(
    active: ActiveSignIn,
    reason?: Error,
  ): Promise<OAuthError | undefined> {
    if (active.closePromise !== undefined) {
      return active.closePromise;
    }
    const server = active.server;
    if (server === undefined) {
      return undefined;
    }
    active.closePromise = (async () => {
      try {
        await server.close(reason);
        return undefined;
      } catch (error) {
        return this.closeOAuthError(error);
      }
    })();
    return active.closePromise;
  }

  private closeOAuthError(error: unknown): OAuthError {
    if (error instanceof OAuthError && error.code === "callback_close_failed") {
      return error;
    }
    return new OAuthError(
      "callback_close_failed",
      "The ChatGPT OAuth callback server could not be closed.",
      error,
    );
  }

  private withCleanupFailure(
    primaryError: OAuthError,
    cleanupError: OAuthError | undefined,
  ): OAuthError {
    if (cleanupError !== undefined && primaryError !== cleanupError) {
      primaryError.cleanupError = cleanupError;
    }
    return primaryError;
  }

  private assertGeneration(generation: number): void {
    if (this.lifecycle !== generation) {
      throw new OAuthError(
        "callback_closed",
        "ChatGPT authentication changed during the OAuth operation.",
      );
    }
  }

  private assertActiveGeneration(active: ActiveSignIn): void {
    if (
      this.activeSignIn !== active ||
      active.terminal ||
      this.lifecycle !== active.generation
    ) {
      throw new OAuthError(
        "callback_closed",
        "ChatGPT authentication changed during the OAuth operation.",
      );
    }
  }

  private async saveIfCurrent(session: OAuthSession, generation: number): Promise<void> {
    this.assertGeneration(generation);
    await this.enqueueStorage(async () => {
      this.assertGeneration(generation);
      await this.store.save(session);
      this.assertGeneration(generation);
    });
  }

  private enqueueStorage<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.storageQueue.then(operation, operation);
    this.storageQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private loopbackError(error: unknown): OAuthError {
    if (error instanceof LoopbackError) {
      if (error.code === "callback_timeout") {
        return new OAuthError("callback_timeout", "ChatGPT OAuth callback timed out.", error);
      }
      const cleanupError =
        error.code === "callback_response_failed"
          ? new OAuthError(
              "callback_response_failed",
              "The ChatGPT OAuth callback response could not be written.",
              error,
            )
          : this.closeOAuthError(error);
      if (error.primaryError !== undefined) {
        return this.withCleanupFailure(
          this.loopbackError(error.primaryError),
          cleanupError,
        );
      }
      return cleanupError;
    }
    return new OAuthError("callback_closed", "The ChatGPT OAuth callback server closed.");
  }

  private async clearCredentials(): Promise<void> {
    this.abortRefreshFlight();
    this.lifecycle += 1;
    await this.enqueueStorage(() => this.store.clear());
  }

  private credentialsClearError(error: unknown): OAuthError {
    return error instanceof OAuthError
      ? error
      : new OAuthError(
          "oauth_failed",
          "ChatGPT credentials could not be cleared.",
          error,
        );
  }

  private async clearCredentialsIfCurrent(generation: number): Promise<void> {
    this.assertGeneration(generation);
    this.abortRefreshFlight();
    this.lifecycle += 1;
    await this.enqueueStorage(() => this.store.clear());
    this.assertGeneration(generation + 1);
  }

  private abortRefreshFlight(): void {
    const flight = this.refreshPromise;
    if (flight !== undefined && !flight.controller.signal.aborted) {
      flight.controller.abort();
    }
  }
}
