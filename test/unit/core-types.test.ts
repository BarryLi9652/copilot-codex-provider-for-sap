import assert from "node:assert/strict";
import test from "node:test";

import { toAbortSignal } from "../../src/core/cancellation.js";
import { CodexError } from "../../src/core/errors.js";
import { EmptyTransport } from "../../src/core/empty-transport.js";
import type {
  CodexMessage,
  CodexModel,
  CodexRequest,
  CodexTransport,
  TransportEvent,
} from "../../src/core/types.js";

const model: CodexModel = {
  id: "gpt-test",
  name: "GPT Test",
  family: "gpt",
  version: "1",
  maxInputTokens: 1_000,
  maxOutputTokens: 500,
  capabilities: {
    imageInput: true,
    toolCalling: true,
    parallelToolCalls: false,
  },
};

const request: CodexRequest = {
  requestId: "request-1",
  modelId: model.id,
  messages: [
    {
      role: "user",
      parts: [{ kind: "text", text: "hello" }],
    },
  ],
  tools: [],
  toolMode: "auto",
  instructions: "Answer briefly.",
};

test("shared transport contracts represent normalized model, request, and event data", () => {
  const events: TransportEvent[] = [
    { type: "text-delta", text: "hello" },
    { type: "tool-call", callId: "call-1", name: "lookup", input: { key: "value" } },
    { type: "usage", inputTokens: 3, outputTokens: 2 },
    { type: "completed" },
  ];

  const transport: CodexTransport = {
    listModels: async () => [model],
    generate: async function* (receivedRequest: CodexRequest): AsyncIterable<TransportEvent> {
      assert.equal(receivedRequest.requestId, request.requestId);
      yield* events;
    },
    dispose: async () => undefined,
  };

  assert.deepEqual(events, [
    { type: "text-delta", text: "hello" },
    { type: "tool-call", callId: "call-1", name: "lookup", input: { key: "value" } },
    { type: "usage", inputTokens: 3, outputTokens: 2 },
    { type: "completed" },
  ]);
  assert.equal(transport.listModels({ silent: true }, new AbortController().signal).then(
    (models) => models[0]?.id,
  ) instanceof Promise, true);
  assert.deepEqual(request.messages[0], {
    role: "user",
    parts: [{ kind: "text", text: "hello" }],
  } satisfies CodexMessage);
});

test("CodexError preserves typed metadata without serializing request content", () => {
  const cause = { request: "private prompt and ABAP source" };
  const error = new CodexError("protocol", {
    action: "showDiagnostics",
    retryAfterMs: 2_500,
    cause,
  });

  assert.equal(error.code, "protocol");
  assert.equal(error.action, "showDiagnostics");
  assert.equal(error.retryAfterMs, 2_500);
  assert.equal(error.cause, cause);
  assert.equal(JSON.stringify(error).includes("private prompt and ABAP source"), false);
});

test("toAbortSignal aborts an already-cancelled token immediately", () => {
  let registered = false;
  const bridge = toAbortSignal({
    isCancellationRequested: true,
    onCancellationRequested: () => {
      registered = true;
      return { dispose: () => undefined };
    },
  });

  assert.equal(bridge.signal.aborted, true);
  assert.equal(registered, false);
  bridge.dispose();
});

test("toAbortSignal bridges later cancellation and disposes the listener", () => {
  let cancel: (() => void) | undefined;
  let disposed = false;
  const bridge = toAbortSignal({
    isCancellationRequested: false,
    onCancellationRequested: (listener: (event: unknown) => void) => {
      cancel = () => listener(undefined);
      return { dispose: () => { disposed = true; } };
    },
  });

  assert.equal(bridge.signal.aborted, false);
  cancel?.();
  assert.equal(bridge.signal.aborted, true);
  bridge.dispose();
  assert.equal(disposed, true);
});

test("EmptyTransport exposes no models and throws only its configured error", async () => {
  const configured = new CodexError("incompatible", { action: "upgradeCodex" });
  const transport = new EmptyTransport(configured);

  assert.deepEqual(
    await transport.listModels({ silent: true }, new AbortController().signal),
    [],
  );
  assert.throws(
    () => transport.generate(request, new AbortController().signal),
    (error: unknown) => error === configured,
  );
  await transport.dispose();
});
