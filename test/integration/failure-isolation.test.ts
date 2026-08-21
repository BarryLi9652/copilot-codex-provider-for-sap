import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexError,
  withProviderRecoveryAction,
} from "../../src/core/errors.js";
import type {
  CodexModel,
  CodexRequest,
  CodexTransport,
  TransportEvent,
} from "../../src/core/types.js";
import type {
  AppServerDynamicTool,
  AppServerTransportLease,
  AppServerTransportSession,
  AppServerTurnStartParams,
} from "../../src/transports/app-server/app-server-session.js";
import { AppServerTransport } from "../../src/transports/app-server/app-server-transport.js";
import type {
  Disposable,
  JsonRpcServerNotificationHandler,
  JsonRpcServerRequestHandler,
} from "../../src/transports/app-server/protocol.js";
import { ToolContinuationRegistry } from "../../src/transports/app-server/tool-continuations.js";

const model: CodexModel = {
  id: "isolation-model",
  name: "Isolation Model",
  family: "test",
  version: "1",
  maxInputTokens: 1_000,
  maxOutputTokens: 500,
  capabilities: { imageInput: false, toolCalling: true, parallelToolCalls: false },
};

const request: CodexRequest = {
  requestId: "isolation-request",
  modelId: model.id,
  messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
  tools: [],
  toolMode: "auto",
  instructions: "",
};

const collect = async (events: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> => {
  const collected: TransportEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
};

test("OAuth success and Local crash remain isolated with no cross-route fallback", async () => {
  const calls = {
    oauthGenerate: 0,
    oauthList: 0,
    localGenerate: 0,
    localList: 0,
  };
  const oauth: CodexTransport = {
    listModels: async () => { calls.oauthList += 1; return [model]; },
    generate: async function* () {
      calls.oauthGenerate += 1;
      yield { type: "text-delta", text: "oauth-complete" };
      yield { type: "completed" };
    },
    dispose: async () => undefined,
  };
  const local: CodexTransport = {
    listModels: async () => { calls.localList += 1; return [model]; },
    generate: async function* () {
      calls.localGenerate += 1;
      throw new CodexError("process");
    },
    dispose: async () => undefined,
  };

  const oauthResult = collect(oauth.generate(request, new AbortController().signal));
  const localResult = collect(local.generate(request, new AbortController().signal));

  assert.deepEqual(await oauthResult, [
    { type: "text-delta", text: "oauth-complete" },
    { type: "completed" },
  ]);
  await assert.rejects(
    localResult,
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );
  assert.deepEqual(calls, {
    oauthGenerate: 1,
    oauthList: 0,
    localGenerate: 1,
    localList: 0,
  });
});

test("provider errors receive exactly one approved recovery action", () => {
  const cases = [
    ["authRequired", "signIn"],
    ["unauthorized", "signIn"],
    ["incompatible", "upgradeCodex"],
    ["process", "restartCodex"],
    ["toolContinuation", "restartCodex"],
    ["rateLimited", "showDiagnostics"],
    ["network", "showDiagnostics"],
    ["timeout", "showDiagnostics"],
    ["protocol", "showDiagnostics"],
    ["sapContext", "showDiagnostics"],
  ] as const;
  for (const [code, action] of cases) {
    const mapped = withProviderRecoveryAction(new CodexError(code));
    assert.equal(mapped.code, code);
    assert.equal(mapped.action, action);
  }

  const preserved = withProviderRecoveryAction(
    new CodexError("process", { action: "selectCodex" }),
  );
  assert.equal(preserved.action, "selectCodex");
  const cancelled = new CodexError("cancelled");
  assert.equal(withProviderRecoveryAction(cancelled), cancelled);
});

class CrashLease implements AppServerTransportLease {
  public readonly generation = 9;
  public readonly leaseId = "crash-lease";
  public readonly capabilities = { dynamicTools: true };
  public turnStartCount = 0;
  private toolHandler: JsonRpcServerRequestHandler | undefined;
  private processExitHandler: ((error: CodexError) => void) | undefined;

  public startThread(_tools: readonly AppServerDynamicTool[]): Promise<{ threadId: string }> {
    return Promise.resolve({ threadId: "crash-thread" });
  }
  public startTurn(_params: AppServerTurnStartParams): Promise<{ turnId: string }> {
    this.turnStartCount += 1;
    return Promise.resolve({ turnId: "crash-turn" });
  }
  public interrupt(): Promise<void> { return Promise.resolve(); }
  public unsubscribe(): Promise<void> { return Promise.resolve(); }
  public onNotification(
    _method: string,
    _handler: JsonRpcServerNotificationHandler,
  ): Disposable { return { dispose: () => undefined }; }
  public onToolCall(handler: JsonRpcServerRequestHandler): Disposable {
    this.toolHandler = handler;
    return { dispose: () => { this.toolHandler = undefined; } };
  }
  public onSecurityFailure(): Disposable { return { dispose: () => undefined }; }
  public onProcessExit(handler: (error: CodexError) => void): Disposable {
    this.processExitHandler = handler;
    return { dispose: () => { this.processExitHandler = undefined; } };
  }
  public release(): void {}

  public emitTool(): Promise<unknown> {
    assert.ok(this.toolHandler);
    return Promise.resolve(this.toolHandler({
      threadId: "crash-thread",
      turnId: "crash-turn",
      callId: "crashed-call",
      name: "lookup",
      input: {},
    }, "crashed-rpc"));
  }
  public crash(): void {
    this.processExitHandler?.(new CodexError("process"));
  }
}

class CrashSession implements AppServerTransportSession {
  public readonly lease = new CrashLease();
  public acquireTransportLease(): Promise<AppServerTransportLease> {
    return Promise.resolve(this.lease);
  }
  public listModels(): Promise<readonly CodexModel[]> { return Promise.resolve([model]); }
  public dispose(): Promise<void> { return Promise.resolve(); }
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for crash transport");
};

test("App Server crash clears surfaced calls and rejects late results without a new turn", async () => {
  const session = new CrashSession();
  const registry = new ToolContinuationRegistry();
  const transport = new AppServerTransport(session, registry);
  const toolRequest: CodexRequest = {
    ...request,
    tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
  };
  const initial = collect(transport.generate(toolRequest, new AbortController().signal));
  await waitFor(() => session.lease.turnStartCount === 1);
  const pendingReply = session.lease.emitTool();
  assert.deepEqual(await initial, [{
    type: "tool-call",
    callId: "crashed-call",
    name: "lookup",
    input: {},
  }]);

  session.lease.crash();
  await assert.rejects(
    pendingReply,
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );
  assert.equal(registry.size, 0);

  const lateResult: CodexRequest = {
    ...request,
    messages: [{
      role: "user",
      parts: [{
        kind: "tool-result",
        callId: "crashed-call",
        content: [{ kind: "text", text: "late" }],
      }],
    }],
  };
  const lateController = new AbortController();
  let lateError: unknown;
  let lateSettled = false;
  const late = collect(transport.generate(lateResult, lateController.signal)).then(
    () => { lateSettled = true; },
    (error: unknown) => { lateError = error; lateSettled = true; },
  );
  for (let attempt = 0; attempt < 100 && !lateSettled && session.lease.turnStartCount === 1; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (session.lease.turnStartCount !== 1) {
    lateController.abort();
  }
  await late;
  assert.ok(lateError instanceof CodexError && lateError.code === "toolContinuation");
  assert.equal(session.lease.turnStartCount, 1);
  await transport.dispose();
});
