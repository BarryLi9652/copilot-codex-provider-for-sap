import assert from "node:assert/strict";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import type { CodexModel, CodexRequest, TransportEvent } from "../../src/core/types.js";
import {
  AppServerSession,
  type AppServerDynamicTool,
  type AppServerSessionClient,
  type AppServerSessionSupervisor,
  type AppServerTransportLease,
  type AppServerTransportSession,
  type AppServerTurnStartParams,
} from "../../src/transports/app-server/app-server-session.js";
import { AppServerTransport } from "../../src/transports/app-server/app-server-transport.js";
import type {
  Disposable,
  JsonRpcId,
  JsonRpcServerNotificationHandler,
  JsonRpcServerRequestHandler,
} from "../../src/transports/app-server/protocol.js";
import { APP_SERVER_THREAD_CONFIG } from "../../src/transports/app-server/safety-profile.js";
import { ToolContinuationRegistry } from "../../src/transports/app-server/tool-continuations.js";

class BoundaryClient implements AppServerSessionClient {
  public readonly requestHandlers = new Map<string, JsonRpcServerRequestHandler>();
  public readonly notificationHandlers = new Map<string, JsonRpcServerNotificationHandler>();
  public readonly requests: Array<{ method: string; params: unknown }> = [];

  public request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "initialize") {
      return Promise.resolve({
        protocolVersion: "1",
        serverInfo: { name: "boundary", version: "1.0.0" },
        capabilities: { experimentalApi: true, dynamicTools: true },
      } as T);
    }
    if (method === "thread/start") {
      return Promise.resolve({ thread: { id: "probe-thread" } } as T);
    }
    if (method === "turn/interrupt") {
      return Promise.resolve({ interrupted: true } as T);
    }
    return Promise.reject(new Error(`unexpected method: ${method}`));
  }

  public notify(): void {}

  public onServerRequest(method: string, handler: JsonRpcServerRequestHandler): Disposable {
    this.requestHandlers.set(method, handler);
    return { dispose: () => this.requestHandlers.delete(method) };
  }

  public onServerNotification(
    method: string,
    handler: JsonRpcServerNotificationHandler,
  ): Disposable {
    this.notificationHandlers.set(method, handler);
    return { dispose: () => this.notificationHandlers.delete(method) };
  }
}

class BoundarySupervisor implements AppServerSessionSupervisor {
  public readonly client = new BoundaryClient();
  public start(): Promise<AppServerSessionClient> { return Promise.resolve(this.client); }
  public restart(): Promise<AppServerSessionClient> { return Promise.resolve(this.client); }
  public stop(): Promise<void> { return Promise.resolve(); }
  public reportInitializationSuccess(): void {}
  public reportInitializationFailure(): Promise<void> { return Promise.resolve(); }
}

test("App Server approvals are denied and native command/file items are interrupted", async () => {
  const supervisor = new BoundarySupervisor();
  const session = new AppServerSession(supervisor, "0.1.0");
  await session.initialize();

  for (const method of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/permission/requestApproval",
  ]) {
    const handler = supervisor.client.requestHandlers.get(method);
    assert.ok(handler, `missing deny handler: ${method}`);
    assert.equal(await handler({}, `rpc-${method}`), "deny");
  }

  const started = supervisor.client.notificationHandlers.get("item/started");
  assert.ok(started);
  await started({
    threadId: "thread-native",
    turnId: "turn-command",
    item: { type: "commandExecution" },
  });
  await started({
    threadId: "thread-native",
    turnId: "turn-file",
    item: { type: "fileChange" },
  });
  assert.deepEqual(
    supervisor.client.requests
      .filter((entry) => entry.method === "turn/interrupt")
      .map((entry) => entry.params),
    [
      { threadId: "thread-native", turnId: "turn-command" },
      { threadId: "thread-native", turnId: "turn-file" },
    ],
  );
  assert.equal(session.hasSecurityProtocolFailure, true);
  await session.dispose();
});

const model: CodexModel = {
  id: "boundary-model",
  name: "Boundary Model",
  family: "test",
  version: "1",
  maxInputTokens: 1_000,
  maxOutputTokens: 500,
  capabilities: { imageInput: false, toolCalling: true, parallelToolCalls: false },
};

class ToolBoundaryLease implements AppServerTransportLease {
  public readonly generation = 1;
  public readonly leaseId = "boundary-lease";
  public readonly capabilities = { dynamicTools: true };
  public readonly turnStarts: AppServerTurnStartParams[] = [];
  private toolHandler: JsonRpcServerRequestHandler | undefined;

  public startThread(_tools: readonly AppServerDynamicTool[]): Promise<{ threadId: string }> {
    return Promise.resolve({ threadId: "boundary-thread" });
  }
  public startTurn(params: AppServerTurnStartParams): Promise<{ turnId: string }> {
    this.turnStarts.push(params);
    return Promise.resolve({ turnId: "boundary-turn" });
  }
  public interrupt(): Promise<void> { return Promise.resolve(); }
  public unsubscribe(): Promise<void> { return Promise.resolve(); }
  public onNotification(): Disposable { return { dispose: () => undefined }; }
  public onToolCall(handler: JsonRpcServerRequestHandler): Disposable {
    this.toolHandler = handler;
    return { dispose: () => { this.toolHandler = undefined; } };
  }
  public onSecurityFailure(): Disposable { return { dispose: () => undefined }; }
  public onProcessExit(): Disposable { return { dispose: () => undefined }; }
  public release(): void {}

  public emitTool(name: string, callId: string): Promise<unknown> {
    assert.ok(this.toolHandler);
    return Promise.resolve(this.toolHandler({
      threadId: "boundary-thread",
      turnId: "boundary-turn",
      callId,
      name,
      input: { key: "value" },
    }, `rpc-${callId}`));
  }
}

class ToolBoundarySession implements AppServerTransportSession {
  public readonly lease = new ToolBoundaryLease();
  public acquireTransportLease(): Promise<AppServerTransportLease> {
    return Promise.resolve(this.lease);
  }
  public listModels(): Promise<readonly CodexModel[]> { return Promise.resolve([model]); }
  public dispose(): Promise<void> { return Promise.resolve(); }
}

const collect = async (iterable: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> => {
  const events: TransportEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for boundary turn");
};

test("unknown native tools are rejected while declared dynamic tools reach Copilot", async () => {
  assert.equal(APP_SERVER_THREAD_CONFIG.approvalPolicy, "never");
  assert.equal(APP_SERVER_THREAD_CONFIG.sandbox, "read-only");
  const session = new ToolBoundarySession();
  const registry = new ToolContinuationRegistry();
  const transport = new AppServerTransport(session, registry, { supportsImages: false });
  const request: CodexRequest = {
    requestId: "boundary-request",
    modelId: model.id,
    messages: [{ role: "user", parts: [{ kind: "text", text: "lookup" }] }],
    tools: [{
      name: "lookup",
      description: "Look up data",
      inputSchema: { type: "object" },
    }],
    toolMode: "auto",
    instructions: "",
  };
  const pending = collect(transport.generate(request, new AbortController().signal));
  await waitFor(() => session.lease.turnStarts.length === 1);

  await assert.rejects(
    session.lease.emitTool("shell_command", "native-call"),
    (error: unknown) => error instanceof CodexError && error.code === "protocol",
  );
  const legitimateReply = session.lease.emitTool("lookup", "dynamic-call");
  assert.deepEqual(await pending, [{
    type: "tool-call",
    callId: "dynamic-call",
    name: "lookup",
    input: { key: "value" },
  }]);
  assert.equal(registry.has("native-call", {
    generation: 1,
    leaseId: "boundary-lease",
  }), false);
  await transport.dispose();
  await assert.rejects(legitimateReply);
});
