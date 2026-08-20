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
}

export type OAuthErrorCode =
  | "auth_required"
  | "browser_open_failed"
  | "callback_closed"
  | "callback_invalid"
  | "callback_state_mismatch"
  | "callback_timeout"
  | "oauth_failed"
  | "sign_in_in_progress"
  | "token_exchange_failed"
  | "token_response_invalid";

export class OAuthError extends Error {
  public readonly code: OAuthErrorCode;

  public constructor(code: OAuthErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OAuthError";
    this.code = code;
  }
}

interface ActiveSignIn {
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly server: LoopbackServerHandle;
  readonly promise: Promise<OAuthSession>;
  readonly resolve: (session: OAuthSession) => void;
  readonly reject: (error: Error) => void;
  callbackClaimed: boolean;
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
  private activeSignIn: ActiveSignIn | undefined;
  private session: OAuthSession | undefined;
  private refreshPromise: Promise<OAuthSession> | undefined;
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
  }

  public async signIn(openExternal: OpenExternal): Promise<OAuthSession> {
    if (this.activeSignIn) {
      throw new OAuthError("sign_in_in_progress", "An OAuth sign-in is already in progress.");
    }

    const pair = createPkcePair();
    const state = createOAuthState();
    const server = await this.loopbackServer.start();
    const pending = deferred<OAuthSession>();
    const active: ActiveSignIn = {
      state,
      verifier: pair.verifier,
      redirectUri: server.redirectUri,
      server,
      promise: pending.promise,
      resolve: pending.resolve,
      reject: pending.reject,
      callbackClaimed: false,
      settled: false,
    };
    this.activeSignIn = active;

    void server.callback.then(
      (url) => this.completeCallback(active, url).catch(() => undefined),
      (error: unknown) => {
        this.failActive(active, this.loopbackError(error));
      },
    );

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
      this.failActive(active, publicError);
      await server.close(publicError).catch(() => undefined);
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
    return this.completeCallback(active, url);
  }

  public async getAccessToken(forceRefresh = false): Promise<OAuthCredentials> {
    const stored = await this.store.load();
    if (!stored) {
      this.session = undefined;
      throw new OAuthError("auth_required", "ChatGPT authentication is required.");
    }

    this.session = stored;
    const shouldRefresh =
      forceRefresh || stored.expiresAt <= this.now() + this.expirySkewMs;
    if (!shouldRefresh) {
      return this.credentialsFrom(stored);
    }

    const generation = this.lifecycle;
    if (!this.refreshPromise) {
      const refresh = this.refreshSession(stored, generation);
      this.refreshPromise = refresh;
      void refresh.finally(() => {
        if (this.refreshPromise === refresh) {
          this.refreshPromise = undefined;
        }
      }).catch(() => undefined);
    }

    const refreshed = await this.refreshPromise;
    return this.credentialsFrom(refreshed);
  }

  public async signOut(): Promise<void> {
    const active = this.activeSignIn;
    const cancellation = new OAuthError(
      "callback_closed",
      "ChatGPT sign-in was cancelled.",
    );
    if (active) {
      this.failActive(active, cancellation);
      await active.server.close(cancellation).catch(() => undefined);
    }
    this.lifecycle += 1;
    this.session = undefined;
    await this.store.clear();
  }

  private buildAuthorizeUrl(active: ActiveSignIn, challenge: string): string {
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
    if (this.activeSignIn !== active || active.settled) {
      throw new OAuthError("callback_closed", "The OAuth callback is no longer active.");
    }
    if (active.callbackClaimed) {
      throw new OAuthError("callback_closed", "The OAuth callback was already handled.");
    }
    active.callbackClaimed = true;

    try {
      const code = this.validateCallback(active, url);
      const session = await this.exchangeAuthorizationCode(
        code,
        active.redirectUri,
        active.verifier,
      );
      await this.store.save(session);
      this.session = session;
      this.settleActive(active, session);
      await active.server.close().catch(() => undefined);
      return session;
    } catch (error) {
      const publicError = asError(
        error,
        new OAuthError("oauth_failed", "ChatGPT OAuth sign-in failed."),
      );
      this.failActive(active, publicError);
      await active.server.close(publicError).catch(() => undefined);
      throw publicError;
    }
  }

  private validateCallback(active: ActiveSignIn, callbackUrl: string): string {
    let parsed: URL;
    let expected: URL;
    try {
      parsed = new URL(callbackUrl);
      expected = new URL(active.redirectUri);
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
  ): Promise<OAuthSession> {
    const payload = await this.postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CHATGPT_CODEX_PROFILE.clientId,
      code_verifier: verifier,
    });
    return this.sessionFromTokenResponse(payload, true);
  }

  private async refreshSession(
    previous: OAuthSession,
    generation: number,
  ): Promise<OAuthSession> {
    const payload = await this.postToken({
      grant_type: "refresh_token",
      refresh_token: previous.refreshToken,
      client_id: CHATGPT_CODEX_PROFILE.clientId,
    });
    if (generation !== this.lifecycle) {
      throw new OAuthError("callback_closed", "ChatGPT authentication changed during refresh.");
    }

    const session = this.sessionFromTokenResponse(payload, false, previous);
    await this.store.save(session);
    this.session = session;
    return session;
  }

  private async postToken(fields: Record<string, string>): Promise<Record<string, unknown>> {
    let response: OAuthHttpResponse;
    try {
      response = await this.fetchToken(CHATGPT_CODEX_PROFILE.tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields).toString(),
      });
    } catch (error) {
      throw new OAuthError(
        "token_exchange_failed",
        "The ChatGPT OAuth token request failed.",
        error,
      );
    }

    const payload = await this.readJson(response);
    if (!response.ok) {
      if (isInvalidGrant(payload)) {
        await this.clearCredentials();
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

  private settleActive(active: ActiveSignIn, session: OAuthSession): void {
    if (active.settled) {
      return;
    }
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
    active.settled = true;
    if (this.activeSignIn === active) {
      this.activeSignIn = undefined;
    }
    active.reject(error);
  }

  private loopbackError(error: unknown): OAuthError {
    if (error instanceof Error && error.message.includes("timed out")) {
      return new OAuthError("callback_timeout", "ChatGPT OAuth callback timed out.");
    }
    return new OAuthError("callback_closed", "The ChatGPT OAuth callback server closed.");
  }

  private async clearCredentials(): Promise<void> {
    this.lifecycle += 1;
    this.session = undefined;
    await this.store.clear();
  }
}
