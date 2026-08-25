import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatGptHttpClient,
  type ChatGptFetch,
  type ChatGptHttpResponse,
} from "../../src/transports/chatgpt-oauth/http-client.js";

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
