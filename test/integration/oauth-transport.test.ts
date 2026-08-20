import assert from "node:assert/strict";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import type {
  CodexModel,
  CodexRequest,
  TransportEvent,
} from "../../src/core/types.js";
import {
  OAuthManager,
  type OAuthFetch,
} from "../../src/transports/chatgpt-oauth/oauth-manager.js";
import {
  CHATGPT_CODEX_PROFILE,
} from "../../src/transports/chatgpt-oauth/profile.js";
import {
  type SecretStore,
} from "../../src/transports/chatgpt-oauth/oauth-store.js";
import {
  ChatGptOAuthTransport,
} from "../../src/transports/chatgpt-oauth/oauth-transport.js";
import type {
  ChatGptFetch,
  ChatGptHttpResponse,
} from "../../src/transports/chatgpt-oauth/http-client.js";

const encoder = new TextEncoder();

interface RecordedRequest {
  readonly url: string;
  readonly init: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  };
}

class FakeSecretStore implements SecretStore {
  public value: string | undefined;

  public async get(key: string): Promise<string | undefined> {
    assert.equal(key, "copilotCodex.chatgptOAuth.v1");
    return this.value;
  }

  public async store(key: string, value: string): Promise<void> {
    assert.equal(key, "copilotCodex.chatgptOAuth.v1");
    this.value = value;
  }

  public async delete(key: string): Promise<void> {
    assert.equal(key, "copilotCodex.chatgptOAuth.v1");
    this.value = undefined;
  }
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
  body: ChatGptHttpResponse["body"] = null,
): ChatGptHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    body,
    json: async () => payload,
  };
}

interface TrackedBody {
  readonly body: ChatGptHttpResponse["body"];
  readonly bodyCancelCalls: () => number;
  readonly readerCancelCalls: () => number;
  readonly releaseLockCalls: () => number;
  readonly readStarted: Promise<void>;
  readonly resolveRead: () => void;
}

interface FakeReadResult {
  done: boolean;
  value?: Uint8Array;
}

function createTrackedBody(options: {
  chunks?: readonly Uint8Array[];
  pendingRead?: boolean;
  cancelError?: Error;
  onCancel?: () => void;
} = {}): TrackedBody {
  let bodyCancelCount = 0;
  let readerCancelCount = 0;
  let releaseLockCount = 0;
  let pendingReadResolve: ((result: FakeReadResult) => void) | undefined;
  let resolveReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    resolveReadStarted = resolve;
  });
  const chunks = [...(options.chunks ?? [])];

  const finishPendingRead = (): void => {
    pendingReadResolve?.({ done: true });
    pendingReadResolve = undefined;
  };

  const reader = {
    read: async (): Promise<FakeReadResult> => {
      resolveReadStarted();
      const chunk = chunks.shift();
      if (chunk !== undefined) {
        return { done: false, value: chunk };
      }
      if (!options.pendingRead) {
        return { done: true };
      }
      return new Promise<FakeReadResult>((resolve) => {
        pendingReadResolve = resolve;
      });
    },
    cancel: async (): Promise<void> => {
      readerCancelCount += 1;
      options.onCancel?.();
      finishPendingRead();
      if (options.cancelError !== undefined) {
        throw options.cancelError;
      }
    },
    releaseLock: (): void => {
      releaseLockCount += 1;
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;

  const body = {
    getReader: () => reader,
    cancel: async (): Promise<void> => {
      bodyCancelCount += 1;
      options.onCancel?.();
      finishPendingRead();
      if (options.cancelError !== undefined) {
        throw options.cancelError;
      }
    },
  } as unknown as ReadableStream<Uint8Array>;

  return {
    body,
    bodyCancelCalls: () => bodyCancelCount,
    readerCancelCalls: () => readerCancelCount,
    releaseLockCalls: () => releaseLockCount,
    readStarted,
    resolveRead: finishPendingRead,
  };
}

function streamResponse(
  chunks: readonly Uint8Array[],
  status = 200,
): ChatGptHttpResponse {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body,
    json: async () => { throw new Error("stream response has no JSON payload"); },
  };
}

function streamFailureResponse(text: string): ChatGptHttpResponse {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls === 0) {
        pulls += 1;
        controller.enqueue(encoder.encode(text));
        setTimeout(() => controller.error(new Error("synthetic stream failure")), 0);
      }
    },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body,
    json: async () => { throw new Error("stream response has no JSON payload"); },
  };
}

function createRequest(
  modelId = "gpt-5-codex",
): CodexRequest {
  return {
    requestId: "request-1",
    modelId,
    instructions: "Answer using the supplied tools.",
    toolMode: "auto",
    tools: [{
      name: "get_abap_object_lines",
      description: "Read ABAP object lines.",
      inputSchema: {
        type: "object",
        properties: { uri: { type: "string" } },
        required: ["uri"],
      },
    }],
    messages: [{
      role: "user",
      parts: [{ kind: "text", text: "Read the object." }],
    }],
  };
}

function modelFromCatalog(): CodexModel {
  return {
    id: "gpt-5-codex",
    name: "GPT-5 Codex",
    family: "gpt",
    version: "codex-5-2026-08",
    maxInputTokens: 258_400,
    maxOutputTokens: 128_000,
    capabilities: {
      imageInput: true,
      toolCalling: true,
      parallelToolCalls: true,
    },
  };
}

function validModelPayload(): Record<string, unknown> {
  return {
    models: [{
      slug: "gpt-5-codex",
      display_name: "GPT-5 Codex",
      visibility: "list",
      context_window: 272_000,
      max_context_window: 400_000,
      input_modalities: ["text", "image"],
      shell_type: "shell_command",
      supports_parallel_tool_calls: true,
      comp_hash: "codex-5-2026-08",
    }],
  };
}

function sseChunks(): readonly Uint8Array[] {
  const stream = [
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello \"}\n\n",
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"world\"}\n\n",
    "event: response.output_item.done\n",
    "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"item-abap\",\"type\":\"function_call\",\"call_id\":\"call-abap\",\"name\":\"get_abap_object_lines\",\"arguments\":\"{\\\"uri\\\":\\\"adt://DEV/zcl_demo\\\"}\"}}\n\n",
    "event: response.completed\n",
    "data: {\"type\":\"response.completed\"}\n\n",
  ].join("");
  const bytes = encoder.encode(stream);
  return [bytes.slice(0, 17), bytes.slice(17, 71), bytes.slice(71)];
}

function header(request: RecordedRequest, name: string): string | undefined {
  const headers = request.init.headers ?? {};
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

test("OAuth transport refreshes once before replaying and preserves streamed text and ABAP call IDs", async () => {
  const secrets = new FakeSecretStore();
  secrets.value = JSON.stringify({
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: Number.MAX_SAFE_INTEGER,
    accountId: "acct-test",
  });
  const oauthRequests: string[] = [];
  const oauthFetch: OAuthFetch = async (_url, init) => {
    oauthRequests.push(String(init?.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "access-new", expires_in: 3_600 }),
    };
  };
  const oauthManager = new OAuthManager(secrets, { fetch: oauthFetch, now: () => 1_000 });
  const backendRequests: RecordedRequest[] = [];
  let backendCall = 0;
  const backendFetch: ChatGptFetch = async (url, init = {}) => {
    backendRequests.push({ url, init });
    backendCall += 1;
    if (backendCall === 1) {
      return jsonResponse({ models: [{
        slug: "gpt-5-codex",
        display_name: "GPT-5 Codex",
        visibility: "list",
        context_window: 272_000,
        max_context_window: 400_000,
        input_modalities: ["text", "image"],
        shell_type: "shell_command",
        supports_parallel_tool_calls: true,
        comp_hash: "codex-5-2026-08",
      }] });
    }
    if (backendCall === 2) {
      return jsonResponse({}, 401);
    }
    return streamResponse(sseChunks());
  };
  let id = 0;
  const transport = new ChatGptOAuthTransport(oauthManager, {
    fetch: backendFetch,
    idFactory: () => `test-id-${++id}`,
  });

  const models = await transport.listModels({ silent: false }, new AbortController().signal);
  const events: TransportEvent[] = [];
  for await (const event of transport.generate(createRequest(), new AbortController().signal)) {
    events.push(event);
  }

  assert.deepEqual(models, [modelFromCatalog()]);
  assert.equal(oauthRequests.length, 1);
  assert.equal(new URLSearchParams(oauthRequests[0]).get("grant_type"), "refresh_token");
  assert.deepEqual(backendRequests.map((request) => new URL(request.url).pathname), [
    "/backend-api/codex/models",
    "/backend-api/codex/responses",
    "/backend-api/codex/responses",
  ]);
  assert.equal(header(backendRequests[0], "authorization"), "Bearer access-old");
  assert.equal(header(backendRequests[1], "authorization"), "Bearer access-old");
  assert.equal(header(backendRequests[2], "authorization"), "Bearer access-new");
  assert.equal(header(backendRequests[0], "chatgpt-account-id"), "acct-test");
  assert.equal(header(backendRequests[1], "originator"), CHATGPT_CODEX_PROFILE.originator);
  assert.equal(header(backendRequests[1], "accept"), "text/event-stream");
  assert.equal(header(backendRequests[1], "content-type"), "application/json");
  assert.equal(header(backendRequests[1], "user-agent"), "codex_cli_rs/0.146.0");
  assert.equal(header(backendRequests[1], "session-id"), "test-id-3");
  assert.equal(header(backendRequests[1], "thread-id"), "test-id-4");
  assert.equal(header(backendRequests[2], "session-id"), header(backendRequests[1], "session-id"));
  assert.equal(header(backendRequests[2], "thread-id"), header(backendRequests[1], "thread-id"));
  assert.equal(new URL(backendRequests[0].url).searchParams.get("client_version"), "0.146.0");
  assert.deepEqual(events, [
    { type: "text-delta", text: "Hello " },
    { type: "text-delta", text: "world" },
    { type: "tool-call", callId: "call-abap", name: "get_abap_object_lines", input: {
      uri: "adt://DEV/zcl_demo",
    } },
    { type: "completed" },
  ]);
});

test("429 maps to a typed rate-limit error and preserves Retry-After milliseconds", async () => {
  const fetch: ChatGptFetch = async () => jsonResponse({}, 429, { "retry-after": "2.5" });
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, { fetch });

  await assert.rejects(
    transport.listModels({ silent: true }, new AbortController().signal),
    (error: unknown) => error instanceof CodexError &&
      error.code === "rateLimited" && error.retryAfterMs === 2_500,
  );
});

test("an aborted HTTP request maps to cancelled without replaying", async () => {
  const controller = new AbortController();
  let calls = 0;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const fetch: ChatGptFetch = async (_url, init = {}) => {
    calls += 1;
    resolveStarted();
    return new Promise<ChatGptHttpResponse>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, { fetch, timeoutMs: 10_000 });
  const pending = transport.listModels({ silent: true }, controller.signal);

  await started;
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
  assert.equal(calls, 1);
});

test("a request timeout maps to timeout", async () => {
  const fetch: ChatGptFetch = async (_url, init = {}) =>
    new Promise<ChatGptHttpResponse>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
    });
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, { fetch, timeoutMs: 5 });

  await assert.rejects(
    transport.listModels({ silent: true }, new AbortController().signal),
    (error: unknown) => error instanceof CodexError && error.code === "timeout",
  );
});

test("a second 401 after the forced refresh maps to unauthorized", async () => {
  let refreshCalls = 0;
  let requests = 0;
  const firstBody = createTrackedBody({ cancelError: new Error("first 401 body close failed") });
  const secondBody = createTrackedBody({ cancelError: new Error("second 401 body close failed") });
  const fetch: ChatGptFetch = async () => {
    requests += 1;
    return jsonResponse({}, 401, {}, requests === 1 ? firstBody.body : secondBody.body);
  };
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async (forceRefresh = false) => {
      if (forceRefresh) {
        refreshCalls += 1;
      }
      return { token: forceRefresh ? "access-new" : "access-old" };
    },
  }, { fetch });

  await assert.rejects(
    transport.listModels({ silent: true }, new AbortController().signal),
    (error: unknown) => error instanceof CodexError && error.code === "unauthorized",
  );
  assert.equal(refreshCalls, 1);
  assert.equal(requests, 2);
  assert.equal(firstBody.bodyCancelCalls(), 1);
  assert.equal(secondBody.bodyCancelCalls(), 1);
});

test("every non-2xx response body is cancelled before the typed status error", async () => {
  const body = createTrackedBody({ cancelError: new Error("status body close failed") });
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, {
    fetch: async () => jsonResponse({}, 429, { "retry-after": "1" }, body.body),
  });

  await assert.rejects(
    transport.listModels({ silent: true }, new AbortController().signal),
    (error: unknown) => error instanceof CodexError && error.code === "rateLimited",
  );
  assert.equal(body.bodyCancelCalls(), 1);
});

test("cancellation during first 401 body cleanup prevents refresh and replay", async () => {
  const controller = new AbortController();
  let refreshCalls = 0;
  let requests = 0;
  const body = createTrackedBody({ onCancel: () => controller.abort() });
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async (forceRefresh = false) => {
      if (forceRefresh) {
        refreshCalls += 1;
      }
      return { token: "access" };
    },
  }, {
    fetch: async () => {
      requests += 1;
      return jsonResponse({}, 401, {}, body.body);
    },
  });

  await assert.rejects(
    transport.listModels({ silent: true }, controller.signal),
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
  assert.equal(body.bodyCancelCalls(), 1);
  assert.equal(refreshCalls, 0);
  assert.equal(requests, 1);
});

test("pending token acquisition observes cancellation and returns promptly", async () => {
  const controller = new AbortController();
  let rejectToken!: (error: Error) => void;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const token = new Promise<{ token: string }>((resolve, reject) => {
    void resolve;
    rejectToken = reject;
  });
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => {
      resolveStarted();
      return token;
    },
  }, {
    fetch: async () => { throw new Error("fetch must not start"); },
  });
  const pending = transport.listModels({ silent: true }, controller.signal);
  await started;
  controller.abort();

  const timeout = Symbol("timed out");
  const outcome = await Promise.race([
    pending.then(() => "resolved", (error: unknown) => error),
    new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 100)),
  ]);
  assert.ok(outcome instanceof CodexError && outcome.code === "cancelled");
  rejectToken(new Error("late token rejection"));
  await Promise.allSettled([pending]);
  assert.notEqual(outcome, timeout);
});

test("pending token acquisition observes timeout and returns promptly", async () => {
  let rejectToken!: (error: Error) => void;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const token = new Promise<{ token: string }>((resolve, reject) => {
    void resolve;
    rejectToken = reject;
  });
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => {
      resolveStarted();
      return token;
    },
  }, {
    fetch: async () => { throw new Error("fetch must not start"); },
    timeoutMs: 5,
  });
  const pending = transport.listModels({ silent: true }, new AbortController().signal);
  await started;

  const timeout = Symbol("timed out");
  const outcome = await Promise.race([
    pending.then(() => "resolved", (error: unknown) => error),
    new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 100)),
  ]);
  assert.ok(outcome instanceof CodexError && outcome.code === "timeout");
  rejectToken(new Error("late token rejection"));
  await Promise.allSettled([pending]);
  assert.notEqual(outcome, timeout);
});

test("a stream failure after output starts does not replay the request", async () => {
  let modelsCalls = 0;
  let responseCalls = 0;
  const fetch: ChatGptFetch = async (url) => {
    if (url.includes("/models")) {
      modelsCalls += 1;
      return jsonResponse({ models: [{
        slug: "gpt-5-codex",
        display_name: "GPT-5 Codex",
        visibility: "list",
        context_window: 272_000,
        max_context_window: 400_000,
        input_modalities: ["text"],
        shell_type: "shell_command",
      }] });
    }
    responseCalls += 1;
    return streamFailureResponse("event: response.output_text.delta\ndata: {\"delta\":\"partial\"}\n\n");
  };
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, { fetch });
  const models = await transport.listModels({ silent: true }, new AbortController().signal);
  const events: TransportEvent[] = [];

  await assert.rejects(
    (async () => {
      for await (const event of transport.generate({ ...createRequest(), modelId: models[0]?.id ?? "" }, new AbortController().signal)) {
        events.push(event);
      }
    })(),
    (error: unknown) => error instanceof CodexError && error.code === "network",
  );

  assert.equal(modelsCalls, 1);
  assert.equal(responseCalls, 1);
  assert.deepEqual(events, [{ type: "text-delta", text: "partial" }]);
});

test("abort during a stream body read cancels the reader once before release", async () => {
  const controller = new AbortController();
  const body = createTrackedBody({ pendingRead: true });
  let responseCalls = 0;
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, {
    fetch: async (url) => url.includes("/models")
      ? jsonResponse(validModelPayload())
      : (responseCalls += 1, {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: body.body,
        json: async () => ({}),
      }),
  });
  await transport.listModels({ silent: true }, new AbortController().signal);
  const generation = (async () => {
    for await (const _event of transport.generate(createRequest(), controller.signal)) {
      // The tracked stream never yields a body chunk.
    }
  })();
  await body.readStarted;
  controller.abort();

  const timedOut = Symbol("timed out");
  const outcome = await Promise.race([
    generation.then(() => "resolved", (error: unknown) => error),
    new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 100)),
  ]);
  if (outcome === timedOut) {
    body.resolveRead();
    await Promise.allSettled([generation]);
    assert.fail("abort did not stop the pending body read promptly");
  }
  assert.ok(outcome instanceof CodexError && outcome.code === "cancelled");
  assert.equal(responseCalls, 1);
  assert.equal(body.readerCancelCalls(), 1);
  assert.equal(body.releaseLockCalls(), 1);
});

test("timeout during a stream body read cancels the reader once before release", async () => {
  const body = createTrackedBody({ pendingRead: true });
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, {
    timeoutMs: 5,
    fetch: async (url) => url.includes("/models")
      ? jsonResponse(validModelPayload())
      : {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: body.body,
        json: async () => ({}),
      },
  });
  await transport.listModels({ silent: true }, new AbortController().signal);
  const generation = (async () => {
    for await (const _event of transport.generate(createRequest(), new AbortController().signal)) {
      // The tracked stream never yields a body chunk.
    }
  })();
  await body.readStarted;

  const timedOut = Symbol("timed out");
  const outcome = await Promise.race([
    generation.then(() => "resolved", (error: unknown) => error),
    new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 100)),
  ]);
  if (outcome === timedOut) {
    body.resolveRead();
    await Promise.allSettled([generation]);
    assert.fail("timeout did not stop the pending body read promptly");
  }
  assert.ok(outcome instanceof CodexError && outcome.code === "timeout");
  assert.equal(body.readerCancelCalls(), 1);
  assert.equal(body.releaseLockCalls(), 1);
});

test("abort during model JSON body read cancels the response body", async () => {
  const controller = new AbortController();
  const body = createTrackedBody();
  let resolveJsonStarted!: () => void;
  const jsonStarted = new Promise<void>((resolve) => {
    resolveJsonStarted = resolve;
  });
  let resolveJson!: (payload: unknown) => void;
  const json = new Promise<unknown>((resolve) => {
    resolveJson = resolve;
  });
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, {
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: body.body,
      json: async () => {
        resolveJsonStarted();
        return json;
      },
    }),
  });
  const pending = transport.listModels({ silent: true }, controller.signal);
  await jsonStarted;
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
  assert.equal(body.bodyCancelCalls(), 1);
  resolveJson(validModelPayload());
  await Promise.allSettled([pending]);
});

test("timeout during model JSON body read cancels the response body", async () => {
  const body = createTrackedBody();
  let resolveJsonStarted!: () => void;
  const jsonStarted = new Promise<void>((resolve) => {
    resolveJsonStarted = resolve;
  });
  let resolveJson!: (payload: unknown) => void;
  const json = new Promise<unknown>((resolve) => {
    resolveJson = resolve;
  });
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, {
    timeoutMs: 5,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: body.body,
      json: async () => {
        resolveJsonStarted();
        return json;
      },
    }),
  });
  const pending = transport.listModels({ silent: true }, new AbortController().signal);
  await jsonStarted;

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexError && error.code === "timeout",
  );
  assert.equal(body.bodyCancelCalls(), 1);
  resolveJson(validModelPayload());
  await Promise.allSettled([pending]);
});

test("early async-iterator return cancels the reader once and observes cancel failure", async () => {
  const body = createTrackedBody({
    chunks: [encoder.encode("event: response.output_text.delta\ndata: {\"delta\":\"partial\"}\n\n")],
    pendingRead: true,
    cancelError: new Error("reader cancel failed"),
  });
  let requestSignal: AbortSignal | undefined;
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, {
    fetch: async (url, init = {}) => url.includes("/models")
      ? jsonResponse(validModelPayload())
      : (requestSignal = init.signal, {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: body.body,
        json: async () => ({}),
      }),
  });
  await transport.listModels({ silent: true }, new AbortController().signal);
  const iterator = transport.generate(createRequest(), new AbortController().signal)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.deepEqual(first.value, { type: "text-delta", text: "partial" });
  await assert.doesNotReject(async () => { await iterator.return?.(); });
  assert.equal(body.readerCancelCalls(), 1);
  assert.equal(body.releaseLockCalls(), 1);
  assert.equal(requestSignal?.aborted, true);
});

test("malformed and empty model catalogs map to protocol errors", async () => {
  for (const payload of [{}, { models: [] }]) {
    const transport = new ChatGptOAuthTransport({
      getAccessToken: async () => ({ token: "access" }),
    }, {
      fetch: async () => jsonResponse(payload),
    });

    await assert.rejects(
      transport.listModels({ silent: true }, new AbortController().signal),
      (error: unknown) => error instanceof CodexError && error.code === "protocol",
    );
  }
});

test("malformed and empty SSE bodies map to protocol errors", async () => {
  for (const chunks of [
    [encoder.encode("not-json")],
    [],
  ]) {
    const transport = new ChatGptOAuthTransport({
      getAccessToken: async () => ({ token: "access" }),
    }, {
      fetch: async (url) => url.includes("/models")
        ? jsonResponse(validModelPayload())
        : streamResponse(chunks),
    });
    await transport.listModels({ silent: true }, new AbortController().signal);
    const events: TransportEvent[] = [];

    await assert.rejects(
      (async () => {
        for await (const event of transport.generate(createRequest(), new AbortController().signal)) {
          events.push(event);
        }
      })(),
      (error: unknown) => error instanceof CodexError && error.code === "protocol",
    );
    assert.deepEqual(events, []);
  }
});

test("EOF without a terminal event flushes parser output before protocol failure", async () => {
  const finalFrame = encoder.encode(
    "event: response.output_text.delta\ndata: {\"delta\":\"flushed\"}",
  );
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, {
    fetch: async (url) => url.includes("/models")
      ? jsonResponse(validModelPayload())
      : streamResponse([finalFrame]),
  });
  await transport.listModels({ silent: true }, new AbortController().signal);
  const events: TransportEvent[] = [];

  await assert.rejects(
    (async () => {
      for await (const event of transport.generate(createRequest(), new AbortController().signal)) {
        events.push(event);
      }
    })(),
    (error: unknown) => error instanceof CodexError && error.code === "protocol",
  );
  assert.deepEqual(events, [{ type: "text-delta", text: "flushed" }]);
});

test("two OAuth transports have independent model caches", async () => {
  let modelCalls = 0;
  const fetch: ChatGptFetch = async () => {
    modelCalls += 1;
    return jsonResponse(validModelPayload());
  };
  const first = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, { fetch });
  const second = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, { fetch });

  await first.listModels({ silent: true }, new AbortController().signal);
  await second.listModels({ silent: true }, new AbortController().signal);

  assert.equal(modelCalls, 2);
});

test("forceRefresh invalidates only the requesting transport cache", async () => {
  let modelCalls = 0;
  const fetch: ChatGptFetch = async () => {
    modelCalls += 1;
    return jsonResponse(validModelPayload());
  };
  const first = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, { fetch });
  const second = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, { fetch });
  const signal = new AbortController().signal;

  await first.listModels({ silent: true }, signal);
  await second.listModels({ silent: true }, signal);
  await first.listModels({ silent: true, forceRefresh: true }, signal);
  await second.listModels({ silent: true }, signal);

  assert.equal(modelCalls, 3);
});

test("pre-aborted forceRefresh does not clear the valid model cache", async () => {
  let modelCalls = 0;
  const fetch: ChatGptFetch = async () => {
    modelCalls += 1;
    return jsonResponse(validModelPayload());
  };
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, { fetch });
  const firstSignal = new AbortController();
  await transport.listModels({ silent: true }, firstSignal.signal);
  firstSignal.abort();

  await assert.rejects(
    transport.listModels({ silent: true, forceRefresh: true }, firstSignal.signal),
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
  await transport.listModels({ silent: true }, new AbortController().signal);
  assert.equal(modelCalls, 1);
});

test("invalid request timeout values are rejected safely", () => {
  const tokenSource = { getAccessToken: async () => ({ token: "access" }) };
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => new ChatGptOAuthTransport(tokenSource, { timeoutMs }),
      (error: unknown) => error instanceof RangeError,
    );
  }
  assert.doesNotThrow(() => new ChatGptOAuthTransport(tokenSource, { timeoutMs: 1 }));
});

test("dispose cancels active requests and makes future use deterministic", async () => {
  const body = createTrackedBody({ pendingRead: true });
  let responseCalls = 0;
  const transport = new ChatGptOAuthTransport({
    getAccessToken: async () => ({ token: "access" }),
  }, {
    fetch: async (url) => url.includes("/models")
      ? jsonResponse(validModelPayload())
      : (responseCalls += 1, {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: body.body,
        json: async () => ({}),
      }),
  });
  await transport.listModels({ silent: true }, new AbortController().signal);
  const generation = (async () => {
    for await (const _event of transport.generate(createRequest(), new AbortController().signal)) {
      // The tracked stream never yields a body chunk.
    }
  })();
  await body.readStarted;

  await transport.dispose();
  const outcome = await Promise.race([
    generation.then(() => "resolved", (error: unknown) => error),
    new Promise<symbol>((resolve) => setTimeout(() => resolve(Symbol("timed out")), 100)),
  ]);
  assert.ok(outcome instanceof CodexError && outcome.code === "cancelled");
  assert.equal(body.readerCancelCalls(), 1);
  assert.equal(body.releaseLockCalls(), 1);
  assert.equal(responseCalls, 1);
  await assert.rejects(
    transport.listModels({ silent: true }, new AbortController().signal),
    (error: unknown) => error instanceof CodexError && error.code === "incompatible",
  );
  assert.throws(
    () => transport.generate(createRequest(), new AbortController().signal),
    (error: unknown) => error instanceof CodexError && error.code === "incompatible",
  );
});
