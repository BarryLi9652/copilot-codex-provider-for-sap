import { randomUUID } from "node:crypto";

import { CodexError } from "../../core/errors.js";
import { OAuthError } from "./oauth-manager.js";
import {
  CHATGPT_CODEX_PROFILE,
} from "./profile.js";
import { createProxyAwareFetch } from "./proxy-fetch.js";
import type { OAuthCredentials } from "./oauth-store.js";

export const CHATGPT_DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

export interface ChatGptRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface ChatGptHttpHeaders {
  get(name: string): string | null;
}

export interface ChatGptHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: ChatGptHttpHeaders;
  readonly body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}

export type ChatGptFetch = (
  url: string,
  init?: ChatGptRequestInit,
) => Promise<ChatGptHttpResponse>;

export interface ChatGptTokenSource {
  getAccessToken(forceRefresh?: boolean, signal?: AbortSignal): Promise<OAuthCredentials>;
}

export interface ChatGptHttpClientOptions {
  fetch?: ChatGptFetch;
  timeoutMs?: number;
  idFactory?: () => string;
  userAgent?: string;
  now?: () => number;
}

interface AbortContext {
  readonly signal: AbortSignal;
  readonly callerAborted: () => boolean;
  readonly timedOut: () => boolean;
  dispose(): void;
}

interface RequestIds {
  readonly sessionId: string;
  readonly threadId: string;
}

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError" ||
  error instanceof Error && error.name === "AbortError";

const isFiniteNonNegative = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

export class ChatGptHttpClient {
  private readonly fetch: ChatGptFetch;
  private readonly timeoutMs: number;
  private readonly idFactory: () => string;
  private readonly userAgent: string;
  private readonly now: () => number;

  public constructor(
    private readonly tokenSource: ChatGptTokenSource,
    options: ChatGptHttpClientOptions = {},
  ) {
    this.fetch = options.fetch ?? createProxyAwareFetch();
    const timeoutMs = options.timeoutMs ?? CHATGPT_DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a finite number greater than zero");
    }
    this.timeoutMs = timeoutMs;
    this.idFactory = options.idFactory ?? randomUUID;
    this.userAgent = options.userAgent ?? `codex_cli_rs/${CHATGPT_CODEX_PROFILE.modelsClientVersion}`;
    this.now = options.now ?? Date.now;
  }

  public async getModels(signal: AbortSignal): Promise<unknown> {
    return this.withAbort(signal, async (context) => {
      const response = await this.request(
        this.modelsUrl(),
        "application/json",
        undefined,
        context,
      );
      this.assertActive(context);
      let payload: unknown;
      let bodyRead = false;
      try {
        payload = await this.awaitWithContext(
          Promise.resolve().then(() => response.json()),
          context,
        );
        bodyRead = true;
      } catch (error) {
        if (error instanceof CodexError) {
          throw error;
        }
        throw new CodexError("protocol", { action: "showDiagnostics", cause: error });
      } finally {
        if (!bodyRead) {
          await this.cancelResponseBody(response);
        }
      }
      this.assertActive(context);
      return payload;
    });
  }

  public async *streamResponses(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const context = this.createAbortContext(signal);
    let response: ChatGptHttpResponse | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let readerDone = false;
    let cleanupPromise: Promise<void> | undefined;
    const cleanupBody = async (): Promise<void> => {
      if (cleanupPromise !== undefined) {
        return cleanupPromise;
      }

      cleanupPromise = (async () => {
        if (reader !== undefined) {
          if (!readerDone) {
            try {
              await reader.cancel();
            } catch {
              // Cleanup errors must never replace the primary safe transport error.
            }
          }
          try {
            reader.releaseLock();
          } catch {
            // A reader may already be released by an underlying stream implementation.
          }
          return;
        }
        if (response !== undefined) {
          await this.cancelResponseBody(response);
        }
      })();
      return cleanupPromise;
    };
    const onAbort = (): void => {
      void cleanupBody();
    };

    try {
      this.assertActive(context);
      response = await this.request(
        CHATGPT_CODEX_PROFILE.responsesUrl,
        "text/event-stream",
        JSON.stringify(body),
        context,
      );
      this.assertActive(context);
      if (response.body === null) {
        throw new CodexError("protocol", { action: "showDiagnostics" });
      }

      reader = response.body.getReader();
      context.signal.addEventListener("abort", onAbort, { once: true });
      while (true) {
        this.assertActive(context);
        const result = await reader.read();
        this.assertActive(context);
        if (result.done) {
          readerDone = true;
          return;
        }
        if (result.value !== undefined) {
          yield result.value;
        }
      }
    } catch (error) {
      throw this.mapError(error, context);
    } finally {
      context.dispose();
      await cleanupBody();
      context.signal.removeEventListener("abort", onAbort);
    }
  }

  private modelsUrl(): string {
    const url = new URL(CHATGPT_CODEX_PROFILE.modelsUrl);
    url.searchParams.set("client_version", CHATGPT_CODEX_PROFILE.modelsClientVersion);
    return url.toString();
  }

  private async request(
    url: string,
    accept: string,
    body: string | undefined,
    context: AbortContext,
  ): Promise<ChatGptHttpResponse> {
    const requestIds: RequestIds = {
      sessionId: this.idFactory(),
      threadId: this.idFactory(),
    };
    let credentials = await this.getAccessToken(false, context);
    this.assertActive(context);

    let response = await this.fetchOnce(url, accept, body, credentials, requestIds, context);
    this.assertActive(context);
    if (response.status === 401) {
      await this.cancelResponseBody(response);
      this.assertActive(context);
      credentials = await this.getAccessToken(true, context);
      this.assertActive(context);
      response = await this.fetchOnce(url, accept, body, credentials, requestIds, context);
      this.assertActive(context);
      if (response.status === 401) {
        await this.cancelResponseBody(response);
        this.assertActive(context);
        throw new CodexError("unauthorized", { action: "signIn" });
      }
    }

    if (!response.ok) {
      await this.cancelResponseBody(response);
      throw this.statusError(response);
    }
    return response;
  }

  private async fetchOnce(
    url: string,
    accept: string,
    body: string | undefined,
    credentials: OAuthCredentials,
    requestIds: RequestIds,
    context: AbortContext,
  ): Promise<ChatGptHttpResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.token}`,
      Accept: accept,
      "Content-Type": "application/json",
      Originator: CHATGPT_CODEX_PROFILE.originator,
      "User-Agent": this.userAgent,
      "session-id": requestIds.sessionId,
      "thread-id": requestIds.threadId,
    };
    if (credentials.accountId !== undefined && credentials.accountId.length > 0) {
      headers["ChatGPT-Account-ID"] = credentials.accountId;
    }

    return this.fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body }),
      signal: context.signal,
    });
  }

  private async cancelResponseBody(response: ChatGptHttpResponse): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // A failed 401 body is never surfaced or retried again.
    }
  }

  private statusError(response: ChatGptHttpResponse): CodexError {
    if (response.status === 429) {
      const retryAfterMs = this.retryAfterMs(response.headers.get("retry-after"));
      return new CodexError("rateLimited", {
        action: "retry",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    if (response.status === 408 || response.status === 504) {
      return new CodexError("timeout", { action: "retry" });
    }
    if (response.status >= 500) {
      return new CodexError("network", { action: "retry" });
    }
    return new CodexError("protocol", { action: "showDiagnostics" });
  }

  private retryAfterMs(value: string | null): number | undefined {
    if (value === null) {
      return undefined;
    }

    const seconds = Number(value.trim());
    if (isFiniteNonNegative(seconds)) {
      return Math.round(seconds * 1_000);
    }

    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? Math.max(0, timestamp - this.now())
      : undefined;
  }

  private async withAbort<T>(
    parentSignal: AbortSignal,
    operation: (context: AbortContext) => Promise<T>,
  ): Promise<T> {
    const context = this.createAbortContext(parentSignal);
    try {
      this.assertActive(context);
      return await operation(context);
    } catch (error) {
      throw this.mapError(error, context);
    } finally {
      context.dispose();
    }
  }

  private async getAccessToken(
    forceRefresh: boolean,
    context: AbortContext,
  ): Promise<OAuthCredentials> {
    const tokenPromise = Promise.resolve().then(() =>
      this.tokenSource.getAccessToken(forceRefresh, context.signal));
    return this.awaitWithContext(tokenPromise, context);
  }

  private async awaitWithContext<T>(
    promise: Promise<T>,
    context: AbortContext,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          context.signal.removeEventListener("abort", onAbort);
        }
      };
      const onAbort = (): void => {
        finish();
        reject(this.abortError(context));
      };

      context.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          finish();
          resolve(value);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
      if (context.signal.aborted) {
        onAbort();
      }
    });
  }

  private abortError(context: AbortContext): CodexError {
    if (context.callerAborted()) {
      return new CodexError("cancelled");
    }
    if (context.timedOut()) {
      return new CodexError("timeout");
    }
    return new CodexError("cancelled");
  }

  private createAbortContext(parentSignal: AbortSignal): AbortContext {
    const controller = new AbortController();
    let callerAborted = parentSignal.aborted;
    let timedOut = false;
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const onParentAbort = (): void => {
      callerAborted = true;
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };

    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    if (this.timeoutMs > 0 && Number.isFinite(this.timeoutMs)) {
      timeout = setTimeout(() => {
        if (!disposed && !controller.signal.aborted) {
          timedOut = true;
          controller.abort();
        }
      }, this.timeoutMs);
      const unref = (timeout as unknown as { unref?: () => void }).unref;
      unref?.call(timeout);
    }

    return {
      signal: controller.signal,
      callerAborted: () => callerAborted || parentSignal.aborted,
      timedOut: () => timedOut,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        parentSignal.removeEventListener("abort", onParentAbort);
        if (!controller.signal.aborted) {
          controller.abort();
        }
      },
    };
  }

  private assertActive(context: AbortContext): void {
    if (context.callerAborted()) {
      throw new CodexError("cancelled");
    }
    if (context.timedOut()) {
      throw new CodexError("timeout");
    }
    if (context.signal.aborted) {
      throw new CodexError("cancelled");
    }
  }

  private mapError(error: unknown, context: AbortContext): CodexError {
    if (error instanceof CodexError) {
      return error;
    }
    if (context.callerAborted()) {
      return new CodexError("cancelled", { cause: error });
    }
    if (context.timedOut()) {
      return new CodexError("timeout", { cause: error });
    }
    if (isAbortError(error)) {
      return new CodexError("network", { action: "retry", cause: error });
    }
    if (error instanceof OAuthError && error.code === "auth_required") {
      return new CodexError("authRequired", { action: "signIn", cause: error });
    }
    return new CodexError("network", { action: "retry", cause: error });
  }
}
