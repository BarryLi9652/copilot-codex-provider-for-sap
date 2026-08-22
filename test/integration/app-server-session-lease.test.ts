import assert from "node:assert/strict";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import { AppServerSession, type AppServerSessionClient, type AppServerSessionSupervisor } from "../../src/transports/app-server/app-server-session.js";
import { APP_SERVER_THREAD_CONFIG } from "../../src/transports/app-server/safety-profile.js";
import type {
  Disposable,
  JsonRpcId,
  JsonRpcServerNotificationHandler,
  JsonRpcServerRequestHandler,
} from "../../src/transports/app-server/protocol.js";

class LeaseClient implements AppServerSessionClient {
  public readonly requests: Array<{ method: string; params: unknown }> = [];
  public readonly registrationOrder: string[] = [];
  public readonly requestHandlers = new Map<string, JsonRpcServerRequestHandler>();
  public readonly notificationHandlers = new Map<string, JsonRpcServerNotificationHandler>();
  public readonly terminationHandlers: Array<(error: CodexError) => void> = [];
  public emitPreResponseEvents = false;
  public readonly preResponseToolResponses: Promise<unknown>[] = [];
  public closed = false;
  private threadNumber = 0;
  private turnNumber = 0;

  public get isClosed(): boolean {
    return this.closed;
  }

  public request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "initialize") {
      return Promise.resolve({
        protocolVersion: "1",
        serverInfo: { name: "fake", version: "1.0.0" },
        capabilities: { experimentalApi: true, dynamicTools: true },
      } as T);
    }
    if (method === "thread/start") {
      this.threadNumber += 1;
      return Promise.resolve({ thread: { id: `thread-${this.threadNumber}` } } as T);
    }
    if (method === "turn/start") {
      this.turnNumber += 1;
      if (this.emitPreResponseEvents) {
        const threadId = "thread-2";
        const turnId = `turn-${this.turnNumber}`;
        this.notificationHandlers.get("turn/usage")?.({
          threadId,
          turnId: "stale-turn",
          usage: { inputTokens: 99 },
        });
        this.notificationHandlers.get("turn/usage")?.({
          threadId,
          turnId,
          usage: { inputTokens: 7, outputTokens: 3 },
        });
        this.notificationHandlers.get("turn/completed")?.({
          threadId,
          turn: { id: turnId, status: "completed", items: [], error: null },
        });
        const toolHandler = this.requestHandlers.get("item/tool/call");
        if (toolHandler !== undefined) {
          this.preResponseToolResponses.push(Promise.resolve(toolHandler({
            threadId,
            turnId: "stale-turn",
            callId: "stale-call",
            name: "lookup",
            input: {},
          }, "stale-rpc")));
          this.preResponseToolResponses.push(Promise.resolve(toolHandler({
            threadId,
            turnId,
            callId: "exact-call",
            name: "lookup",
            input: {},
          }, "exact-rpc")));
        }
      }
      return Promise.resolve({ turn: { id: `turn-${this.turnNumber}` } } as T);
    }
    if (method === "turn/interrupt") {
      return Promise.resolve({ interrupted: true } as T);
    }
    if (method === "thread/unsubscribe") {
      return Promise.resolve({ unsubscribed: true } as T);
    }
    return Promise.reject(new Error(`unexpected method ${method}`));
  }

  public notify(): void {}

  public onServerRequest(method: string, handler: JsonRpcServerRequestHandler): Disposable {
    this.registrationOrder.push(method);
    this.requestHandlers.set(method, handler);
    return { dispose: () => this.requestHandlers.delete(method) };
  }

  public onServerNotification(
    method: string,
    handler: JsonRpcServerNotificationHandler,
  ): Disposable {
    this.registrationOrder.push(method);
    this.notificationHandlers.set(method, handler);
    return { dispose: () => this.notificationHandlers.delete(method) };
  }

  public onDidTerminate(handler: (error: CodexError) => void): Disposable {
    this.terminationHandlers.push(handler);
    return { dispose: () => undefined };
  }

  public terminate(error = new CodexError("process")): void {
    this.closed = true;
    for (const handler of this.terminationHandlers) {
      handler(error);
    }
  }
}

class LeaseSupervisor implements AppServerSessionSupervisor {
  public readonly client = new LeaseClient();

  public start(): Promise<AppServerSessionClient> {
    return Promise.resolve(this.client);
  }

  public restart(): Promise<AppServerSessionClient> {
    return Promise.resolve(this.client);
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }

  public reportInitializationSuccess(): void {}

  public reportInitializationFailure(_client: AppServerSessionClient, _cause?: unknown): Promise<void> {
    return Promise.resolve();
  }
}

test("exposes only a generation-bound safe lease and cannot omit or override the thread safety profile", async () => {
  const supervisor = new LeaseSupervisor();
  const session = new AppServerSession(supervisor, "0.1.0");
  const lease = await session.acquireTransportLease();

  assert.equal("request" in session, false);
  assert.equal("getClient" in session, false);
  assert.equal(typeof lease.generation, "number");
  assert.equal(lease.leaseId.length > 0, true);
  assert.deepEqual(supervisor.client.registrationOrder.slice(0, 5), [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/permission/requestApproval",
    "item/started",
  ]);

  const dynamicTools = [{
    type: "function" as const,
    name: "lookup",
    description: "Look up a value.",
    inputSchema: { type: "object" },
    deferLoading: false as const,
  }];
  const thread = await lease.startThread(dynamicTools);
  const actualThreadStart = supervisor.client.requests.at(-1);
  assert.deepEqual(actualThreadStart, {
    method: "thread/start",
    params: { ...APP_SERVER_THREAD_CONFIG, dynamicTools },
  });
  assert.deepEqual(thread, { threadId: "thread-2" });

  const turn = await lease.startTurn({
    threadId: thread.threadId,
    modelId: "fake-codex",
    input: [{ type: "text", text: "hello" }],
  });
  assert.deepEqual(turn, { turnId: "turn-1" });
  assert.deepEqual(supervisor.client.requests.at(-1), {
    method: "turn/start",
    params: {
      threadId: "thread-2",
      model: "fake-codex",
      input: [{ type: "text", text: "hello" }],
    },
  });

  let processExit: CodexError | undefined;
  lease.onProcessExit((error) => { processExit = error; });
  await lease.interrupt(thread.threadId, turn.turnId);
  await lease.unsubscribe(thread.threadId);
  supervisor.client.terminate();
  assert.equal(processExit?.code, "process");

  lease.release();
  await session.dispose();
});

test("buffers only exact pre-response events and rejects stale-turn tool calls", async () => {
  const supervisor = new LeaseSupervisor();
  const session = new AppServerSession(supervisor, "0.1.0");
  const lease = await session.acquireTransportLease();
  const thread = await lease.startThread([]);
  const usage: unknown[] = [];
  const completed: unknown[] = [];
  const toolCalls: unknown[] = [];
  lease.onNotification("turn/usage", (params) => {
    usage.push(params);
  });
  lease.onNotification("turn/completed", (params) => {
    completed.push(params);
  });
  lease.onToolCall((params) => {
    toolCalls.push(params);
    return { accepted: true };
  });
  supervisor.client.emitPreResponseEvents = true;

  const turn = await lease.startTurn({
    threadId: thread.threadId,
    modelId: "fake-codex",
    input: [{ type: "text", text: "hello" }],
  });

  assert.deepEqual(usage, [{
    threadId: thread.threadId,
    turnId: turn.turnId,
    usage: { inputTokens: 7, outputTokens: 3 },
  }]);
  assert.deepEqual(completed, [{
    threadId: thread.threadId,
    turn: { id: turn.turnId, status: "completed", items: [], error: null },
  }]);
  assert.deepEqual(toolCalls, [{
    threadId: thread.threadId,
    turnId: turn.turnId,
    callId: "exact-call",
    name: "lookup",
    input: {},
  }]);
  await assert.rejects(
    supervisor.client.preResponseToolResponses[0],
    (error: unknown) => error instanceof CodexError && error.code === "protocol",
  );
  assert.deepEqual(await supervisor.client.preResponseToolResponses[1], { accepted: true });

  lease.release();
  await session.dispose();
});
