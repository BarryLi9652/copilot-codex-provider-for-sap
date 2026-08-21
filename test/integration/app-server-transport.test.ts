import assert from "node:assert/strict";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import type { CodexModel, CodexRequest, TransportEvent } from "../../src/core/types.js";
import type {
  AppServerDynamicTool,
  AppServerSecurityFailure,
  AppServerTransportLease,
  AppServerTransportSession,
  AppServerTurnStartParams,
} from "../../src/transports/app-server/app-server-transport.js";
import type { AppServerSessionClient } from "../../src/transports/app-server/app-server-session.js";
import { AppServerTransport } from "../../src/transports/app-server/app-server-transport.js";
import { APP_SERVER_THREAD_CONFIG } from "../../src/transports/app-server/safety-profile.js";
import type {
  Disposable,
  JsonRpcId,
  JsonRpcServerNotificationHandler,
  JsonRpcServerRequestHandler,
} from "../../src/transports/app-server/protocol.js";
import { ToolContinuationRegistry } from "../../src/transports/app-server/tool-continuations.js";

const model: CodexModel = {
  id: "fake-codex",
  name: "Fake Codex",
  family: "fake",
  version: "1.0.0",
  maxInputTokens: 16_000,
  maxOutputTokens: 4_000,
  capabilities: { imageInput: true, toolCalling: true, parallelToolCalls: true },
};

const tools = [
  {
    name: "lookup_a",
    description: "Look up A.",
    inputSchema: { type: "object", properties: { key: { type: "string" } } },
  },
  {
    name: "lookup_b",
    description: "Look up B.",
    inputSchema: { type: "object", properties: { key: { type: "string" } } },
  },
] as const;

const initialRequest: CodexRequest = {
  requestId: "request-1",
  modelId: model.id,
  messages: [{ role: "user", parts: [{ kind: "text", text: "Look up both values." }] }],
  tools,
  toolMode: "auto",
  instructions: "",
};

class FakeAppServerClient implements AppServerSessionClient {
  public readonly requests: Array<{ method: string; params: unknown }> = [];
  public readonly serverRequestHandlers = new Map<string, JsonRpcServerRequestHandler>();
  public readonly notificationHandlers = new Map<string, JsonRpcServerNotificationHandler>();
  public readonly pendingToolCalls: Promise<unknown>[] = [];
  public mode: "parallel" | "hold" | "error" = "parallel";
  public closed = false;
  private threadNumber = 0;
  private turnNumber = 0;

  public get isClosed(): boolean {
    return this.closed;
  }

  public request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      this.threadNumber += 1;
      return Promise.resolve({ thread: { id: `thread-${this.threadNumber}` } } as T);
    }
    if (method === "turn/start") {
      this.turnNumber += 1;
      const turnId = `turn-${this.turnNumber}`;
      queueMicrotask(() => this.emitTurn(turnId));
      return Promise.resolve({ turn: { id: turnId }, status: "started" } as T);
    }
    if (method === "turn/interrupt") {
      return Promise.resolve({ interrupted: true } as T);
    }
    if (method === "thread/unsubscribe") {
      return Promise.resolve({ unsubscribed: true } as T);
    }
    return Promise.reject(new Error(`unexpected fake method: ${method}`));
  }

  public notify(): void {}

  public onServerRequest(method: string, handler: JsonRpcServerRequestHandler): Disposable {
    this.serverRequestHandlers.set(method, handler);
    return {
      dispose: () => {
        if (this.serverRequestHandlers.get(method) === handler) {
          this.serverRequestHandlers.delete(method);
        }
      },
    };
  }

  public onServerNotification(
    method: string,
    handler: JsonRpcServerNotificationHandler,
  ): Disposable {
    this.notificationHandlers.set(method, handler);
    return {
      dispose: () => {
        if (this.notificationHandlers.get(method) === handler) {
          this.notificationHandlers.delete(method);
        }
      },
    };
  }

  public async emitServerRequest(method: string, params: unknown, id: JsonRpcId): Promise<unknown> {
    const handler = this.serverRequestHandlers.get(method);
    if (handler === undefined) {
      throw new Error(`fake handler not registered: ${method}`);
    }
    return handler(params, id);
  }

  private emitTurn(turnId: string): void {
    if (this.mode === "error") {
      void this.notificationHandlers.get("turn/failed")?.({
        threadId: "thread-1",
        turnId,
        error: { message: "fake turn failed" },
      });
      return;
    }

    const first = this.emitServerRequest("item/tool/call", {
      threadId: "thread-1",
      turnId,
      callId: "call-1",
      name: "lookup_a",
      input: { key: "a" },
    }, 101);
    const second = this.emitServerRequest("item/tool/call", {
      threadId: "thread-1",
      turnId,
      callId: "call-2",
      name: "lookup_b",
      input: { key: "b" },
    }, 102);
    this.pendingToolCalls.push(
      first.then(() => undefined, () => undefined),
      second.then(() => undefined, () => undefined),
    );
    if (this.mode === "hold") {
      return;
    }
    void Promise.all([second, first]).then(() => {
      void this.notificationHandlers.get("item/agentMessage/delta")?.({
        threadId: "thread-1",
        turnId,
        delta: "both values resolved",
      });
      void this.notificationHandlers.get("turn/completed")?.({
        threadId: "thread-1",
        turnId,
        status: "completed",
      });
    });
  }
}

class FakeLease implements AppServerTransportLease {
  public readonly generation = 1;
  public readonly leaseId = "fake-lease-1";
  public readonly capabilities = { dynamicTools: true };

  public constructor(private readonly client: FakeAppServerClient) {}

  public async startThread(
    dynamicTools: readonly AppServerDynamicTool[],
  ): Promise<{ threadId: string }> {
    const response = await this.client.request<{ thread: { id: string } }>("thread/start", {
      ...APP_SERVER_THREAD_CONFIG,
      dynamicTools,
    });
    return { threadId: response.thread.id };
  }

  public async startTurn(params: AppServerTurnStartParams): Promise<{ turnId: string }> {
    const response = await this.client.request<{ turn: { id: string } }>("turn/start", {
      threadId: params.threadId,
      model: params.modelId,
      input: params.input,
    });
    return { turnId: response.turn.id };
  }

  public interrupt(threadId: string, turnId: string): Promise<void> {
    return this.client.request("turn/interrupt", { threadId, turnId }).then(() => undefined);
  }

  public unsubscribe(threadId: string): Promise<void> {
    return this.client.request("thread/unsubscribe", { threadId }).then(() => undefined);
  }

  public onNotification(
    method: "turn/started" | "item/agentMessage/delta" | "turn/usage" | "turn/completed" | "turn/failed" | "turn/error",
    handler: JsonRpcServerNotificationHandler,
  ): Disposable {
    return this.client.onServerNotification(method, handler);
  }

  public onToolCall(handler: JsonRpcServerRequestHandler): Disposable {
    return this.client.onServerRequest("item/tool/call", handler);
  }

  public onSecurityFailure(_handler: (failure: AppServerSecurityFailure) => void): Disposable {
    return { dispose: () => undefined };
  }

  public onProcessExit(_handler: (error: CodexError) => void): Disposable {
    return { dispose: () => undefined };
  }

  public release(): void {}
}

class FakeSession implements AppServerTransportSession {
  public constructor(public readonly client: FakeAppServerClient) {}

  public listModels(): Promise<readonly CodexModel[]> {
    return Promise.resolve([model]);
  }

  public acquireTransportLease(): Promise<AppServerTransportLease> {
    return Promise.resolve(new FakeLease(this.client));
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

async function collect(iterable: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> {
  const events: TransportEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

test("starts a configured thread, surfaces parallel dynamic tools, and resumes the original turn", async () => {
  const client = new FakeAppServerClient();
  const session = new FakeSession(client);
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const transport = new AppServerTransport(session, registry);

  const firstEvents = await collect(transport.generate(initialRequest, new AbortController().signal));
  assert.deepEqual(firstEvents, [
    { type: "tool-call", callId: "call-1", name: "lookup_a", input: { key: "a" } },
    { type: "tool-call", callId: "call-2", name: "lookup_b", input: { key: "b" } },
  ]);

  const threadStart = client.requests.find(({ method }) => method === "thread/start");
  assert.deepEqual(threadStart?.params, {
    ...APP_SERVER_THREAD_CONFIG,
    dynamicTools: [
      {
        type: "function",
        name: "lookup_a",
        description: "Look up A.",
        inputSchema: tools[0].inputSchema,
        deferLoading: false,
      },
      {
        type: "function",
        name: "lookup_b",
        description: "Look up B.",
        inputSchema: tools[1].inputSchema,
        deferLoading: false,
      },
    ],
  });

  const continuationRequest: CodexRequest = {
    ...initialRequest,
    requestId: "request-2",
    messages: [{
      role: "user",
      parts: [
        {
          kind: "tool-result",
          callId: "call-2",
          content: [{ kind: "text", text: "result-b" }],
        },
        {
          kind: "tool-result",
          callId: "call-1",
          content: [{ kind: "text", text: "result-a" }],
        },
      ],
    }],
  };
  const secondEvents = await collect(transport.generate(
    continuationRequest,
    new AbortController().signal,
  ));

  assert.deepEqual(secondEvents, [
    { type: "text-delta", text: "both values resolved" },
    { type: "completed" },
  ]);
  assert.equal(client.requests.filter(({ method }) => method === "turn/start").length, 1);
  assert.equal(client.requests.filter(({ method }) => method === "thread/unsubscribe").length, 1);
  assert.equal((await Promise.all(client.pendingToolCalls)).length, 2);
  assert.equal(registry.size, 0);
  await transport.dispose();
});

test("interrupts and unsubscribes a waiting turn on disposal, detaching server handlers", async () => {
  const client = new FakeAppServerClient();
  client.mode = "hold";
  const transport = new AppServerTransport(
    new FakeSession(client),
    new ToolContinuationRegistry({ now: () => 500 }),
  );
  const first = collect(transport.generate(initialRequest, new AbortController().signal));
  const events = await first;
  assert.deepEqual(events, [
    { type: "tool-call", callId: "call-1", name: "lookup_a", input: { key: "a" } },
    { type: "tool-call", callId: "call-2", name: "lookup_b", input: { key: "b" } },
  ]);

  await transport.dispose();
  assert.equal(client.requests.some(({ method }) => method === "turn/interrupt"), true);
  assert.equal(client.requests.some(({ method }) => method === "thread/unsubscribe"), true);
  assert.equal(client.serverRequestHandlers.size, 0);
  assert.equal(client.notificationHandlers.size, 0);
  await Promise.allSettled(client.pendingToolCalls);
});

test("interrupts and unsubscribes a paused turn when its cancellation signal aborts", async () => {
  const client = new FakeAppServerClient();
  client.mode = "hold";
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const transport = new AppServerTransport(new FakeSession(client), registry);
  const cancellation = new AbortController();
  const iterator = transport.generate(initialRequest, cancellation.signal)[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.deepEqual(first.value, {
    type: "tool-call",
    callId: "call-1",
    name: "lookup_a",
    input: { key: "a" },
  });
  cancellation.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(client.requests.some(({ method }) => method === "turn/interrupt"), true);
  assert.equal(client.requests.some(({ method }) => method === "thread/unsubscribe"), true);
  assert.equal(registry.size, 0);
  assert.ok(iterator.return !== undefined);
  await iterator.return();
  await Promise.allSettled(client.pendingToolCalls);
  await transport.dispose();
});

test("cleans up a failed turn and preserves a typed transport error", async () => {
  const client = new FakeAppServerClient();
  client.mode = "error";
  const transport = new AppServerTransport(
    new FakeSession(client),
    new ToolContinuationRegistry({ now: () => 500 }),
  );

  await assert.rejects(
    collect(transport.generate(initialRequest, new AbortController().signal)),
    (error: unknown) => error instanceof CodexError && error.code === "protocol",
  );
  assert.equal(client.requests.some(({ method }) => method === "thread/unsubscribe"), true);
  await transport.dispose();
});
