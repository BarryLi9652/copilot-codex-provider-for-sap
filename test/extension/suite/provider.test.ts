import assert from "node:assert/strict";

import * as vscode from "vscode";

import type {
  CodexModel,
  CodexRequest,
  CodexTransport,
  TransportEvent,
} from "../../../src/core/types.js";
import { CodexError } from "../../../src/core/errors.js";
import { CodexLanguageModelProvider } from "../../../src/providers/codex-provider.js";

const model: CodexModel = {
  id: "gpt-test",
  name: "GPT Test",
  family: "gpt",
  version: "1",
  maxInputTokens: 1_000,
  maxOutputTokens: 500,
  capabilities: {
    imageInput: false,
    toolCalling: true,
    parallelToolCalls: false,
  },
};

interface TrackableCancellation {
  token: vscode.CancellationToken;
  cancel(): void;
  disposeCount(): number;
}

function createTrackableCancellation(): TrackableCancellation {
  let cancellationRequested = false;
  let listener: (() => unknown) | undefined;
  let disposalCount = 0;
  const token = {
    get isCancellationRequested(): boolean {
      return cancellationRequested;
    },
    onCancellationRequested(callback: () => unknown): { dispose(): void } {
      listener = callback;
      return {
        dispose: () => {
          disposalCount += 1;
          listener = undefined;
        },
      };
    },
  } as unknown as vscode.CancellationToken;

  return {
    token,
    cancel: () => {
      cancellationRequested = true;
      listener?.();
    },
    disposeCount: () => disposalCount,
  };
}

async function streamsTextAndToolCalls(): Promise<void> {
  let receivedRequest: CodexRequest | undefined;
  const transport: CodexTransport = {
    listModels: async () => [model],
    generate: async function* (request: CodexRequest): AsyncIterable<TransportEvent> {
      receivedRequest = request;
      yield { type: "text-delta", text: "hello" };
      yield {
        type: "tool-call",
        callId: "call-1",
        name: "get_abap_object_lines",
        input: { uri: "adt://DEV/zcl_demo" },
      };
      yield { type: "completed" };
    },
    dispose: async () => undefined,
  };
  const provider = new CodexLanguageModelProvider(transport, "test-vendor");
  const parts: vscode.LanguageModelResponsePart[] = [];
  const cancellation = new vscode.CancellationTokenSource();

  await provider.provideLanguageModelChatResponse(
    {
      id: model.id,
      name: model.name,
      family: model.family,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: {
        imageInput: model.capabilities.imageInput,
        toolCalling: model.capabilities.toolCalling,
      },
    },
    [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new vscode.LanguageModelTextPart("request")],
      },
    ],
    {
      toolMode: vscode.LanguageModelChatToolMode.Auto,
      tools: [],
    },
    { report: (part) => parts.push(part) },
    cancellation.token,
  );
  cancellation.dispose();

  assert.equal(parts.length, 2);
  assert.ok(parts[0] instanceof vscode.LanguageModelTextPart);
  assert.equal((parts[0] as vscode.LanguageModelTextPart).value, "hello");
  assert.ok(parts[1] instanceof vscode.LanguageModelToolCallPart);
  assert.deepEqual(parts[1], new vscode.LanguageModelToolCallPart(
    "call-1",
    "get_abap_object_lines",
    { uri: "adt://DEV/zcl_demo" },
  ));
  assert.equal(receivedRequest?.toolMode, "auto");
}

async function disposesResponseCancellationListenerOnRequestBuildFailure(): Promise<void> {
  const expected = new Error("request build failed");
  const cancellation = createTrackableCancellation();
  let generateCalls = 0;
  const provider = new CodexLanguageModelProvider({
    listModels: async () => [model],
    generate: (): AsyncIterable<TransportEvent> => {
      generateCalls += 1;
      throw new Error("generate must not be called");
    },
    dispose: async () => undefined,
  }, {
    requestIdFactory: () => {
      throw expected;
    },
  });

  await assert.rejects(
    provider.provideLanguageModelChatResponse(
      {
        id: model.id,
        name: model.name,
        family: model.family,
        version: model.version,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: { imageInput: false, toolCalling: true },
      },
      [],
      { toolMode: vscode.LanguageModelChatToolMode.Auto },
      { report: () => undefined },
      cancellation.token,
    ),
    (error: unknown) => error === expected,
  );

  assert.equal(generateCalls, 0);
  assert.equal(cancellation.disposeCount(), 1);
}

async function preservesStableMessageParts(): Promise<void> {
  let receivedRequest: CodexRequest | undefined;
  const transport: CodexTransport = {
    listModels: async () => [model],
    generate: async function* (request: CodexRequest): AsyncIterable<TransportEvent> {
      receivedRequest = request;
      yield { type: "completed" };
    },
    dispose: async () => undefined,
  };
  const provider = new CodexLanguageModelProvider(transport, "test-vendor");
  const cancellation = new vscode.CancellationTokenSource();
  const image = vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png");
  const toolCall = new vscode.LanguageModelToolCallPart(
    "call-1",
    "lookup",
    { key: "value" },
  );
  const toolResult = new vscode.LanguageModelToolResultPart("call-1", [
    new vscode.LanguageModelTextPart("result"),
    image,
  ]);

  await provider.provideLanguageModelChatResponse(
    {
      id: model.id,
      name: model.name,
      family: model.family,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: { imageInput: true, toolCalling: true },
    },
    [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: "assistant",
        content: [new vscode.LanguageModelTextPart("answer"), image, toolCall],
      },
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [toolResult],
      },
    ],
    {
      toolMode: vscode.LanguageModelChatToolMode.Required,
      tools: [{
        name: "lookup",
        description: "Look up a value.",
        inputSchema: { type: "object", properties: { key: { type: "string" } } },
      }],
    },
    { report: () => undefined },
    cancellation.token,
  );
  cancellation.dispose();

  assert.ok(receivedRequest !== undefined);
  assert.match(receivedRequest.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(receivedRequest.modelId, "gpt-test");
  assert.deepEqual(receivedRequest.messages, [
    {
      role: "assistant",
      name: "assistant",
      parts: [
        { kind: "text", text: "answer" },
        { kind: "image", mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
        { kind: "tool-call", callId: "call-1", name: "lookup", input: { key: "value" } },
      ],
    },
    {
      role: "user",
      parts: [{
        kind: "tool-result",
        callId: "call-1",
        content: [
          { kind: "text", text: "result" },
          { kind: "image", mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
        ],
      }],
    },
  ]);
  assert.deepEqual(receivedRequest.tools, [{
    name: "lookup",
    description: "Look up a value.",
    inputSchema: { type: "object", properties: { key: { type: "string" } } },
  }]);
  assert.equal(receivedRequest.toolMode, "required");
}

async function cachesModelDiscovery(): Promise<void> {
  let listCalls = 0;
  const transport: CodexTransport = {
    listModels: async () => {
      listCalls += 1;
      return [model];
    },
    generate: async function* (): AsyncIterable<TransportEvent> {
      yield { type: "completed" };
    },
    dispose: async () => undefined,
  };
  const provider = new CodexLanguageModelProvider(transport, "test-vendor");
  const cancellation = new vscode.CancellationTokenSource();

  const first = await provider.provideLanguageModelChatInformation(
    { silent: true },
    cancellation.token,
  );
  const second = await provider.provideLanguageModelChatInformation(
    { silent: false },
    cancellation.token,
  );
  cancellation.dispose();

  assert.equal(listCalls, 1);
  assert.deepEqual(first, [{
    id: "gpt-test",
    name: "GPT Test",
    family: "gpt",
    version: "1",
    maxInputTokens: 1_000,
    maxOutputTokens: 500,
    capabilities: { imageInput: false, toolCalling: true },
  }]);
  assert.deepEqual(second, first);
}

async function skipsModelDiscoveryForPreCancelledToken(): Promise<void> {
  let listCalls = 0;
  const expected = new Error("pre-cancelled discovery must not start");
  const transport: CodexTransport = {
    listModels: () => {
      listCalls += 1;
      return Promise.reject(expected);
    },
    generate: async function* (): AsyncIterable<TransportEvent> {
      yield { type: "completed" };
    },
    dispose: async () => undefined,
  };
  const provider = new CodexLanguageModelProvider(transport, "test-vendor");
  const cancellation = new vscode.CancellationTokenSource();
  cancellation.cancel();
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    assert.deepEqual(
      await provider.provideLanguageModelChatInformation({ silent: true }, cancellation.token),
      [],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(listCalls, 0);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    cancellation.dispose();
  }
}

async function keepsSharedModelDiscoveryAliveWhenFirstCallerCancels(): Promise<void> {
  const firstCancellation = createTrackableCancellation();
  const secondCancellation = createTrackableCancellation();
  let listCalls = 0;
  let loaderSignal: AbortSignal | undefined;
  let resolveListStarted: (() => void) | undefined;
  const listStarted = new Promise<void>((resolve) => {
    resolveListStarted = resolve;
  });
  let resolveModels: ((models: readonly CodexModel[]) => void) | undefined;
  const transport: CodexTransport = {
    listModels: (_options, signal) => {
      listCalls += 1;
      loaderSignal = signal;
      return new Promise<readonly CodexModel[]>((resolve) => {
        resolveModels = resolve;
        resolveListStarted?.();
      });
    },
    generate: async function* (): AsyncIterable<TransportEvent> {
      yield { type: "completed" };
    },
    dispose: async () => undefined,
  };
  const provider = new CodexLanguageModelProvider(transport, "test-vendor");
  const firstPromise = provider.provideLanguageModelChatInformation(
    { silent: true },
    firstCancellation.token,
  );
  const secondPromise = provider.provideLanguageModelChatInformation(
    { silent: false },
    secondCancellation.token,
  );
  await listStarted;

  const timedOut = Symbol("timed out");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    firstCancellation.cancel();
    const firstResult = await Promise.race([
      firstPromise,
      new Promise<readonly vscode.LanguageModelChatInformation[] | typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), 250);
      }),
    ]);

    resolveModels?.([model]);
    const [firstModels, secondModels] = await Promise.all([firstPromise, secondPromise]);

    assert.notEqual(firstResult, timedOut, "cancelled caller did not stop waiting");
    assert.deepEqual(firstModels, []);
    assert.deepEqual(secondModels, [{
      id: "gpt-test",
      name: "GPT Test",
      family: "gpt",
      version: "1",
      maxInputTokens: 1_000,
      maxOutputTokens: 500,
      capabilities: { imageInput: false, toolCalling: true },
    }]);
    assert.equal(listCalls, 1);
    assert.equal(loaderSignal?.aborted, false);
    assert.equal(firstCancellation.disposeCount(), 1);
    assert.equal(secondCancellation.disposeCount(), 1);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    resolveModels?.([model]);
    await Promise.allSettled([firstPromise, secondPromise]);
  }
}

async function countsTokens(): Promise<void> {
  const provider = new CodexLanguageModelProvider({
    listModels: async () => [model],
    generate: async function* (): AsyncIterable<TransportEvent> {
      yield { type: "completed" };
    },
    dispose: async () => undefined,
  }, "test-vendor");
  const cancellation = new vscode.CancellationTokenSource();
  const modelInfo: vscode.LanguageModelChatInformation = {
    id: model.id,
    name: model.name,
    family: model.family,
    version: model.version,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: { imageInput: false, toolCalling: true },
  };

  assert.equal(await provider.provideTokenCount(modelInfo, "", cancellation.token), 1);
  const astralAndAscii = "😀😀a";
  assert.equal(astralAndAscii.length, 5);
  assert.equal([...astralAndAscii].length, 3);
  assert.equal(await provider.provideTokenCount(modelInfo, astralAndAscii, cancellation.token), 2);
  const message: vscode.LanguageModelChatRequestMessage = {
    role: vscode.LanguageModelChatMessageRole.Assistant,
    name: undefined,
    content: [
      new vscode.LanguageModelTextPart("abc"),
      new vscode.LanguageModelToolCallPart("c", "lookup", { key: "value" }),
    ],
  };
  const serializedTool = '{"callId":"c","name":"lookup","input":{"key":"value"}}';
  assert.equal(
    await provider.provideTokenCount(modelInfo, message, cancellation.token),
    Math.ceil(("abc".length + serializedTool.length) / 4),
  );
  cancellation.dispose();
}

async function handlesCancellation(): Promise<void> {
  let receivedSignal: AbortSignal | undefined;
  const transport: CodexTransport = {
    listModels: async () => [model],
    generate: (_request: CodexRequest, signal: AbortSignal): AsyncIterable<TransportEvent> => {
      receivedSignal = signal;
      throw new CodexError("cancelled");
    },
    dispose: async () => undefined,
  };
  const provider = new CodexLanguageModelProvider(transport, "test-vendor");
  const cancellation = new vscode.CancellationTokenSource();
  cancellation.cancel();

  await provider.provideLanguageModelChatResponse(
    {
      id: model.id,
      name: model.name,
      family: model.family,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: { imageInput: false, toolCalling: true },
    },
    [],
    { toolMode: vscode.LanguageModelChatToolMode.Auto },
    { report: () => undefined },
    cancellation.token,
  );

  assert.equal(receivedSignal?.aborted, true);
  cancellation.dispose();
}

async function mapsTypedTransportErrorsToOneRecoveryAction(): Promise<void> {
  const expected = new CodexError("network", { action: "retry" });
  const provider = new CodexLanguageModelProvider({
    listModels: async () => [model],
    generate: (): AsyncIterable<TransportEvent> => {
      throw expected;
    },
    dispose: async () => undefined,
  }, "test-vendor");
  const cancellation = new vscode.CancellationTokenSource();

  await assert.rejects(
    provider.provideLanguageModelChatResponse(
      {
        id: model.id,
        name: model.name,
        family: model.family,
        version: model.version,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: { imageInput: false, toolCalling: true },
      },
      [],
      { toolMode: vscode.LanguageModelChatToolMode.Auto },
      { report: () => undefined },
      cancellation.token,
    ),
    (error: unknown) => error instanceof CodexError
      && error.code === "network"
      && error.action === "showDiagnostics",
  );
  cancellation.dispose();
}

async function mapsModelDiscoveryErrorsToOneRecoveryAction(): Promise<void> {
  const provider = new CodexLanguageModelProvider({
    listModels: async () => {
      throw new CodexError("process", { action: "appServerExit" });
    },
    generate: async function* (): AsyncIterable<TransportEvent> {},
    dispose: async () => undefined,
  }, "test-vendor");
  const cancellation = new vscode.CancellationTokenSource();
  try {
    await assert.rejects(
      provider.provideLanguageModelChatInformation(
        { silent: false },
        cancellation.token,
      ),
      (error: unknown) => error instanceof CodexError
        && error.code === "process"
        && error.action === "restartCodex",
    );
  } finally {
    cancellation.dispose();
  }
}

export async function runProviderTests(): Promise<void> {
  const tests: readonly (readonly [string, () => Promise<void>])[] = [
    ["provider streams text and tool calls as Copilot response parts", streamsTextAndToolCalls],
    ["provider preserves stable Copilot message parts and required tools", preservesStableMessageParts],
    ["provider caches model discovery and maps the normalized capabilities", cachesModelDiscovery],
    ["provider skips discovery for a pre-cancelled token", skipsModelDiscoveryForPreCancelledToken],
    ["provider keeps shared discovery alive when the first caller cancels", keepsSharedModelDiscoveryAliveWhenFirstCallerCancels],
    ["provider disposes response cancellation listeners on request-build failure", disposesResponseCancellationListenerOnRequestBuildFailure],
    ["provider counts UTF-16 text and serialized tool metadata with a minimum of one", countsTokens],
    ["provider returns quietly when transport cancellation is requested", handlesCancellation],
    ["provider maps typed errors to one recovery action", mapsTypedTransportErrorsToOneRecoveryAction],
    ["provider maps model discovery errors to one recovery action", mapsModelDiscoveryErrorsToOneRecoveryAction],
  ];

  for (const [name, test] of tests) {
    await test();
    console.log(`✔ ${name}`);
  }
}
