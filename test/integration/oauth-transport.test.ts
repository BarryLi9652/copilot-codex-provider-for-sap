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

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): ChatGptHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    body: null,
    json: async () => payload,
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
  const fetch: ChatGptFetch = async () => {
    requests += 1;
    return jsonResponse({}, 401);
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
