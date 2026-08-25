import assert from "node:assert/strict";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import {
  ChatGptHttpClient,
  type ChatGptFetch,
  type ChatGptHttpResponse,
} from "../../src/transports/chatgpt-oauth/http-client.js";
import { OAuthError } from "../../src/transports/chatgpt-oauth/oauth-manager.js";

test("a pending request timeout does not keep the Node event loop alive", async () => {
  const nativeSetTimeout = globalThis.setTimeout;
  let requestTimeout: ReturnType<typeof setTimeout> | undefined;
  globalThis.setTimeout = ((
    ...parameters: Parameters<typeof setTimeout>
  ): ReturnType<typeof setTimeout> => {
    const [callback, milliseconds, ...args] = parameters;
    const timer = nativeSetTimeout(callback, milliseconds, ...args);
    if (milliseconds === 60_000) {
      requestTimeout = timer;
    }
    return timer;
  }) as typeof setTimeout;

  const fetch: ChatGptFetch = async (_url, init = {}) =>
    new Promise<ChatGptHttpResponse>((_resolve, reject) => {
      const rejectAbort = (): void => reject(new DOMException("cancelled", "AbortError"));
      if (init.signal?.aborted) {
        rejectAbort();
        return;
      }
      init.signal?.addEventListener("abort", rejectAbort, { once: true });
    });
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;

  try {
    const client = new ChatGptHttpClient(
      { getAccessToken: async () => ({ token: "access" }) },
      { fetch, timeoutMs: 60_000 },
    );
    pending = client.getModels(controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(requestTimeout);
    assert.equal(requestTimeout.hasRef(), false);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    controller.abort();
    if (pending) {
      await Promise.allSettled([pending]);
    }
  }
});

test("maps an OAuth token timeout to a typed request timeout", async () => {
  const client = new ChatGptHttpClient({
    getAccessToken: async () => {
      throw new OAuthError(
        "token_request_timeout",
        "The ChatGPT OAuth token request timed out.",
      );
    },
  }, {
    fetch: async () => assert.fail("model request must not start without a token"),
  });

  await assert.rejects(
    client.getModels(new AbortController().signal),
    (error: unknown) => error instanceof CodexError && error.code === "timeout",
  );
});

test("maps an OAuth token cancellation to a typed request cancellation", async () => {
  const client = new ChatGptHttpClient({
    getAccessToken: async () => {
      throw new OAuthError(
        "token_request_cancelled",
        "The ChatGPT OAuth token request was cancelled.",
      );
    },
  }, {
    fetch: async () => assert.fail("model request must not start without a token"),
  });

  await assert.rejects(
    client.getModels(new AbortController().signal),
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
});
