import { randomUUID } from "node:crypto";

import { CodexError } from "../../core/errors.js";
import { OAuthError, type OAuthManager } from "./oauth-manager.js";
import {
  CHATGPT_CODEX_PROFILE,
} from "./profile.js";
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
  getAccessToken(forceRefresh?: boolean): Promise<OAuthCredentials>;
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

const defaultFetch: ChatGptFetch = async (url, init = {}) => {
  const response = await globalThis.fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return response as unknown as ChatGptHttpResponse;
};

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
    private readonly tokenSource: ChatGptTokenSource | OAuthManager,
    options: ChatGptHttpClientOptions = {},
  ) {
    this.fetch = options.fetch ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? CHATGPT_DEFAULT_REQUEST_TIMEOUT_MS;
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
      try {
        payload = await response.json();
      } catch (error) {
        throw new CodexError("protocol", { action: "showDiagnostics", cause: error });
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
    try {
      this.assertActive(context);
      const response = await this.request(
        CHATGPT_CODEX_PROFILE.responsesUrl,
        "text/event-stream",
        JSON.stringify(body),
        context,
      );
      this.assertActive(context);
      if (response.body === null) {
        throw new CodexError("protocol", { action: "showDiagnostics" });
      }

      const reader = response.body.getReader();
      try {
        while (true) {
          this.assertActive(context);
          const result = await reader.read();
          this.assertActive(context);
          if (result.done) {
            return;
          }
          if (result.value !== undefined) {
            yield result.value;
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      throw this.mapError(error, context);
    } finally {
      context.dispose();
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
    let credentials = await this.tokenSource.getAccessToken();
    this.assertActive(context);

    let response = await this.fetchOnce(url, accept, body, credentials, requestIds, context);
    this.assertActive(context);
    if (response.status === 401) {
      await this.discardBody(response);
      credentials = await this.tokenSource.getAccessToken(true);
      this.assertActive(context);
      response = await this.fetchOnce(url, accept, body, credentials, requestIds, context);
      this.assertActive(context);
      if (response.status === 401) {
        await this.discardBody(response);
        throw new CodexError("unauthorized", { action: "signIn" });
      }
    }

    if (!response.ok) {
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

  private async discardBody(response: ChatGptHttpResponse): Promise<void> {
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
