import assert from "node:assert/strict";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import type {
  CodexModel,
  CodexRequest,
  ToolResultPart,
  TransportEvent,
} from "../../src/core/types.js";
import {
  type AppServerDynamicTool,
  type AppServerSessionClient,
  type AppServerTransportLease,
  type AppServerTransportSession,
  type AppServerTurnStartParams,
  type AppServerUserInput,
} from "../../src/transports/app-server/app-server-session.js";
import { AppServerTransport } from "../../src/transports/app-server/app-server-transport.js";
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

const textOnlyModel: CodexModel = {
  ...model,
  capabilities: { ...model.capabilities, imageInput: false },
};

const tools = [{
  name: "lookup",
  description: "Look up a value.",
  inputSchema: { type: "object", properties: { key: { type: "string" } } },
}] as const;

const request = (messages: CodexRequest["messages"] = [
  { role: "user", parts: [{ kind: "text", text: "Look up the value." }] },
]): CodexRequest => ({
  requestId: `request-${Math.random()}`,
  modelId: model.id,
  messages,
  tools,
  toolMode: "auto",
  instructions: "",
});

const resultMessage = (
  callId: string,
  content: readonly ToolResultPart[],
): CodexRequest["messages"][number] => ({
  role: "user",
  parts: [{ kind: "tool-result", callId, content }],
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for fake App Server state");
};

async function collect(iterable: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> {
  const events: TransportEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

class FakeLease implements AppServerTransportLease {
  public readonly capabilities = { dynamicTools: true, serverVersion: "fake-1" };
  public readonly threadId: string;
  public readonly turnId: string;
  public readonly threadStarts: Array<{ dynamicTools: readonly AppServerDynamicTool[] }> = [];
  public readonly turnStarts: AppServerTurnStartParams[] = [];
  public readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  public readonly unsubscribes: Array<{ threadId: string }> = [];
  public releaseCount = 0;
  public interruptGate: Promise<void> | undefined;
  private readonly allNotifications = new Map<string, JsonRpcServerNotificationHandler[]>();
  private readonly allToolHandlers: JsonRpcServerRequestHandler[] = [];
  private readonly allSecurityHandlers: Array<(failure: {
    threadId: string;
    turnId: string;
    generation: number;
    leaseId: string;
  }) => void> = [];
  private readonly allProcessExitHandlers: Array<(error: CodexError) => void> = [];

  public constructor(
    public readonly generation: number,
    public readonly leaseId: string,
    private readonly selectedModel: CodexModel = model,
    ids?: { threadId: string; turnId: string },
    private readonly turnStartGate?: Promise<void>,
  ) {
    this.threadId = ids?.threadId ?? `${leaseId}-thread`;
    this.turnId = ids?.turnId ?? `${leaseId}-turn`;
  }

  public startThread(
    dynamicTools: readonly AppServerDynamicTool[],
    _signal?: AbortSignal,
  ): Promise<{ threadId: string }> {
    this.threadStarts.push({ dynamicTools });
    return Promise.resolve({ threadId: this.threadId });
  }

  public async startTurn(
    params: AppServerTurnStartParams,
    _signal?: AbortSignal,
  ): Promise<{ turnId: string }> {
    this.turnStarts.push(params);
    await this.turnStartGate;
    return { turnId: this.turnId };
  }

  public async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId });
    await this.interruptGate;
  }

  public async unsubscribe(threadId: string): Promise<void> {
    this.unsubscribes.push({ threadId });
  }

  public onNotification(
    method: string,
    handler: JsonRpcServerNotificationHandler,
  ): Disposable {
    const handlers = this.allNotifications.get(method) ?? [];
    handlers.push(handler);
    this.allNotifications.set(method, handlers);
    return {
      dispose: () => {
        const current = this.allNotifications.get(method) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) {
          current.splice(index, 1);
        }
      },
    };
  }

  public onToolCall(handler: JsonRpcServerRequestHandler): Disposable {
    this.allToolHandlers.push(handler);
    return {
      dispose: () => {
        const index = this.allToolHandlers.indexOf(handler);
        if (index >= 0) {
          this.allToolHandlers.splice(index, 1);
        }
      },
    };
  }

  public onSecurityFailure(handler: (failure: {
    threadId: string;
    turnId: string;
    generation: number;
    leaseId: string;
  }) => void): Disposable {
    this.allSecurityHandlers.push(handler);
    return { dispose: () => undefined };
  }

  public onProcessExit(handler: (error: CodexError) => void): Disposable {
    this.allProcessExitHandlers.push(handler);
    return { dispose: () => undefined };
  }

  public release(): void {
    this.releaseCount += 1;
  }

  public async emitNotification(method: string, params: unknown): Promise<void> {
    for (const handler of this.allNotifications.get(method) ?? []) {
      await handler(params);
    }
  }

  public emitToolCall(params: unknown, rpcId: JsonRpcId): Promise<unknown> {
    const handler = this.allToolHandlers.at(-1);
    if (handler === undefined) {
      return Promise.reject(new CodexError("protocol", { action: "lateToolCall" }));
    }
    return Promise.resolve(handler(params, rpcId));
  }

  public emitSecurityFailure(): void {
    for (const handler of this.allSecurityHandlers) {
      handler({
        threadId: this.threadId,
        turnId: this.turnId,
        generation: this.generation,
        leaseId: this.leaseId,
      });
    }
  }

  public emitProcessExit(error = new CodexError("process")): void {
    for (const handler of this.allProcessExitHandlers) {
      handler(error);
    }
  }

  public get selectedModelForTest(): CodexModel {
    return this.selectedModel;
  }

  public get allNotificationHandlerCount(): number {
    return [...this.allNotifications.values()]
      .reduce((count, handlers) => count + handlers.length, 0);
  }

  public get allToolHandlerCount(): number {
    return this.allToolHandlers.length;
  }
}

class FakeSession implements AppServerTransportSession {
  public readonly leases: FakeLease[] = [];
  public readonly client: AppServerSessionClient = {} as AppServerSessionClient;
  private nextGeneration = 1;

  public constructor(
    private readonly selectedModel: CodexModel = model,
    private readonly reuseTurnIds = false,
    private readonly turnStartGate?: Promise<void>,
  ) {}

  public acquireTransportLease(): Promise<AppServerTransportLease> {
    const lease = new FakeLease(
      this.nextGeneration,
      `lease-${this.nextGeneration}`,
      this.selectedModel,
      this.reuseTurnIds
        ? { threadId: "reused-thread", turnId: "reused-turn" }
        : undefined,
      this.turnStartGate,
    );
    this.nextGeneration += 1;
    this.leases.push(lease);
    return Promise.resolve(lease);
  }

  public listModels(): Promise<readonly CodexModel[]> {
    return Promise.resolve([this.selectedModel]);
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

test("ignores historical tool results while preserving them in the next turn transcript", async () => {
  const session = new FakeSession();
  const transport = new AppServerTransport(session, new ToolContinuationRegistry({ now: () => 500 }));
  const messages: CodexRequest["messages"] = [
    {
      role: "assistant",
      parts: [{ kind: "tool-call", callId: "historical-call", name: "lookup", input: { key: "old" } }],
    },
    resultMessage("historical-call", [{ kind: "text", text: "old result" }]),
    { role: "user", parts: [{ kind: "text", text: "Ask a new question." }] },
  ];

  const pending = collect(transport.generate(request(messages), new AbortController().signal));
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const lease = session.leases[0] as FakeLease;
  await lease.emitNotification("item/agentMessage/delta", {
    threadId: lease.threadId,
    turnId: lease.turnId,
    delta: "new answer",
  });
  await lease.emitNotification("turn/completed", {
    threadId: lease.threadId,
    turnId: lease.turnId,
  });

  assert.deepEqual(await pending, [
    { type: "text-delta", text: "new answer" },
    { type: "completed" },
  ]);
  const transcript = lease.turnStarts[0]?.input[0];
  assert.equal(transcript?.type, "text");
  assert.match(transcript?.type === "text" ? transcript.text : "", /historical-call/);
  assert.equal(lease.releaseCount, 1);
  await transport.dispose();
});

test("routes concurrent notifications only on exact thread, turn, and generation correlation", async () => {
  const session = new FakeSession();
  const transport = new AppServerTransport(session, new ToolContinuationRegistry({ now: () => 500 }));
  const first = collect(transport.generate(request(), new AbortController().signal));
  const second = collect(transport.generate(request(), new AbortController().signal));
  await waitFor(() => session.leases.length === 2 && session.leases.every((lease) => lease.turnStarts.length === 1));
  const lease1 = session.leases[0] as FakeLease;
  const lease2 = session.leases[1] as FakeLease;

  await lease1.emitNotification("item/agentMessage/delta", { threadId: lease1.threadId, delta: "missing turn" });
  await lease1.emitNotification("item/agentMessage/delta", { threadId: "stale-thread", turnId: lease1.turnId, delta: "stale" });
  await lease2.emitNotification("item/agentMessage/delta", { threadId: lease1.threadId, turnId: lease2.turnId, delta: "wrong thread" });
  await lease1.emitNotification("item/agentMessage/delta", {
    threadId: lease1.threadId,
    turnId: lease1.turnId,
    delta: "first",
  });
  await lease2.emitNotification("item/agentMessage/delta", {
    threadId: lease2.threadId,
    turnId: lease2.turnId,
    delta: "second",
  });
  await lease1.emitNotification("turn/completed", { threadId: lease1.threadId, turnId: lease1.turnId });
  await lease2.emitNotification("turn/completed", { threadId: lease2.threadId, turnId: lease2.turnId });

  assert.deepEqual(await first, [
    { type: "text-delta", text: "first" },
    { type: "completed" },
  ]);
  assert.deepEqual(await second, [
    { type: "text-delta", text: "second" },
    { type: "completed" },
  ]);
  await transport.dispose();
});

test("cleans the exact state on early iterator return without an abort signal", async () => {
  const session = new FakeSession();
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const transport = new AppServerTransport(session, registry);
  const iterator = transport.generate(request(), new AbortController().signal)[Symbol.asyncIterator]();
  const pendingFirst = iterator.next();
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const lease = session.leases[0] as FakeLease;
  const pendingTool = lease.emitToolCall({
    threadId: lease.threadId,
    turnId: lease.turnId,
    callId: "early-call",
    name: "lookup",
    input: { key: "value" },
  }, 1);
  assert.deepEqual(await pendingFirst, {
    done: false,
    value: { type: "tool-call", callId: "early-call", name: "lookup", input: { key: "value" } },
  });

  await iterator.return?.();
  assert.deepEqual(lease.interrupts, [{ threadId: lease.threadId, turnId: lease.turnId }]);
  assert.deepEqual(lease.unsubscribes, [{ threadId: lease.threadId }]);
  assert.equal(lease.releaseCount, 1);
  assert.equal(registry.size, 0);
  await assert.rejects(pendingTool, (error: unknown) => error instanceof Error);
  await transport.dispose();
});

test("replies exactly once when a result arrives before its parallel call is surfaced", async () => {
  const session = new FakeSession();
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const transport = new AppServerTransport(session, registry);
  const firstIterator = transport.generate(request(), new AbortController().signal)[Symbol.asyncIterator]();
  const firstPending = firstIterator.next();
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const lease = session.leases[0] as FakeLease;
  const firstTool = lease.emitToolCall({
    threadId: lease.threadId,
    turnId: lease.turnId,
    callId: "call-1",
    name: "lookup",
    input: { key: "one" },
  }, 1);
  assert.equal((await firstPending).value?.type, "tool-call");
  await firstIterator.next();

  const secondTool = lease.emitToolCall({
    threadId: lease.threadId,
    turnId: lease.turnId,
    callId: "call-2",
    name: "lookup",
    input: { key: "two" },
  }, 2);
  const continuation = collect(transport.generate(request([
    resultMessage("call-1", [{ kind: "text", text: "one" }]),
    resultMessage("call-2", [{ kind: "text", text: "two" }]),
  ]), new AbortController().signal));
  await lease.emitNotification("item/agentMessage/delta", {
    threadId: lease.threadId,
    turnId: lease.turnId,
    delta: "continued",
  });
  await lease.emitNotification("turn/completed", { threadId: lease.threadId, turnId: lease.turnId });

  assert.deepEqual(await continuation, [
    { type: "tool-call", callId: "call-2", name: "lookup", input: { key: "two" } },
    { type: "text-delta", text: "continued" },
    { type: "completed" },
  ]);
  assert.equal((await Promise.all([firstTool, secondTool])).length, 2);
  assert.equal(lease.interrupts.length, 0);
  await transport.dispose();
});

test("propagates a native security failure as a safe protocol error without content", async () => {
  const session = new FakeSession();
  const transport = new AppServerTransport(session, new ToolContinuationRegistry({ now: () => 500 }));
  const pending = collect(transport.generate(request(), new AbortController().signal));
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const lease = session.leases[0] as FakeLease;
  lease.emitSecurityFailure();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexError
      && error.code === "protocol"
      && error.action === "securityBoundary",
  );
  assert.deepEqual(lease.interrupts, [{ threadId: lease.threadId, turnId: lease.turnId }]);
  await transport.dispose();
});

test("rejects continuation images when the selected model does not support image input", async () => {
  const session = new FakeSession(textOnlyModel);
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const transport = new AppServerTransport(session, registry);
  const first = collect(transport.generate(request(), new AbortController().signal));
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const lease = session.leases[0] as FakeLease;
  const pendingTool = lease.emitToolCall({
    threadId: lease.threadId,
    turnId: lease.turnId,
    callId: "image-call",
    name: "lookup",
    input: { key: "image" },
  }, 1);
  await waitFor(() => registry.size === 1);
  await first;

  await assert.rejects(
    collect(transport.generate(request([resultMessage("image-call", [{
      kind: "image",
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    }])]), new AbortController().signal)),
    (error: unknown) => error instanceof CodexError && error.code === "incompatible",
  );
  assert.equal(lease.turnStarts.some((turn) => turn.input.some((item) => item.type === "image")), false);
  await assert.rejects(pendingTool, (error: unknown) => error instanceof Error);
  await transport.dispose();
});

test("denies late tool calls after terminal cleanup and leaves the registry empty", async () => {
  const session = new FakeSession();
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const transport = new AppServerTransport(session, registry);
  const pending = collect(transport.generate(request(), new AbortController().signal));
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const lease = session.leases[0] as FakeLease;
  await lease.emitNotification("turn/completed", { threadId: lease.threadId, turnId: lease.turnId });
  assert.deepEqual(await pending, [{ type: "completed" }]);

  await assert.rejects(
    lease.emitToolCall({
      threadId: lease.threadId,
      turnId: lease.turnId,
      callId: "late-call",
      name: "lookup",
      input: {},
    }, 9),
    (error: unknown) => error instanceof Error,
  );
  assert.equal(registry.size, 0);
  await transport.dispose();
});

test("maps exact usage events and terminates promptly on the lease process-exit hook", async () => {
  const session = new FakeSession();
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const transport = new AppServerTransport(session, registry);
  const pending = collect(transport.generate(request(), new AbortController().signal));
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const lease = session.leases[0] as FakeLease;
  await lease.emitNotification("turn/usage", {
    threadId: lease.threadId,
    turnId: lease.turnId,
    usage: { inputTokens: 7, outputTokens: 3 },
  });
  const iterator = transport.generate(request(), new AbortController().signal)[Symbol.asyncIterator]();
  await iterator.return?.();
  lease.emitProcessExit(new CodexError("process"));
  await assert.rejects(pending, (error: unknown) => error instanceof CodexError && error.code === "process");
  assert.deepEqual(lease.unsubscribes, [{ threadId: lease.threadId }]);
  await transport.dispose();
});

test("cleanup uses the old lease after the session has acquired a replacement generation", async () => {
  const session = new FakeSession();
  const transport = new AppServerTransport(session, new ToolContinuationRegistry({ now: () => 500 }));
  const iterator = transport.generate(request(), new AbortController().signal)[Symbol.asyncIterator]();
  const pending = iterator.next();
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const oldLease = session.leases[0] as FakeLease;
  const pendingTool = oldLease.emitToolCall({
    threadId: oldLease.threadId,
    turnId: oldLease.turnId,
    callId: "old-call",
    name: "lookup",
    input: {},
  }, 1);
  const pendingToolRejection = assert.rejects(pendingTool, (error: unknown) => error instanceof Error);
  assert.equal((await pending).value?.type, "tool-call");
  let resolveInterrupt!: () => void;
  oldLease.interruptGate = new Promise<void>((resolve) => { resolveInterrupt = resolve; });
  const returning = iterator.return?.();
  await waitFor(() => oldLease.interrupts.length === 1);
  const replacement = await session.acquireTransportLease();
  resolveInterrupt();
  assert.deepEqual(await returning, { done: true, value: undefined });
  await pendingToolRejection;

  assert.equal(oldLease.unsubscribes.length, 1);
  assert.equal((replacement as FakeLease).interrupts.length, 0);
  assert.equal((replacement as FakeLease).unsubscribes.length, 0);
  await transport.dispose();
});

test("a deferred turn start cannot resurrect state after transport disposal", async () => {
  let resolveTurnStart!: () => void;
  const turnStartGate = new Promise<void>((resolve) => {
    resolveTurnStart = resolve;
  });
  const session = new FakeSession(model, false, turnStartGate);
  const transport = new AppServerTransport(
    session,
    new ToolContinuationRegistry({ now: () => 500 }),
  );
  const controller = new AbortController();
  let outcome: { status: "resolved" } | { status: "rejected"; error: unknown } | undefined;
  const observed = collect(transport.generate(request(), controller.signal)).then(
    () => { outcome = { status: "resolved" }; },
    (error: unknown) => { outcome = { status: "rejected", error }; },
  );
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const lease = session.leases[0] as FakeLease;

  await transport.dispose();
  resolveTurnStart();
  try {
    await waitFor(() => outcome !== undefined);
  } finally {
    controller.abort();
    await observed;
  }

  assert.equal(outcome?.status, "rejected");
  assert.ok(outcome?.status === "rejected"
    && outcome.error instanceof CodexError
    && outcome.error.code === "cancelled");
  assert.deepEqual(lease.interrupts, [{ threadId: lease.threadId, turnId: lease.turnId }]);
  assert.deepEqual(lease.unsubscribes, [{ threadId: lease.threadId }]);
  assert.equal(lease.releaseCount, 1);
  assert.equal(lease.allNotificationHandlerCount, 0);
  assert.equal(lease.allToolHandlerCount, 0);
});

test("old generation cleanup cannot delete a replacement with reused thread, turn, and call IDs", async () => {
  const session = new FakeSession(model, true);
  const transport = new AppServerTransport(
    session,
    new ToolContinuationRegistry({ now: () => 500 }),
  );
  const oldInitial = collect(transport.generate(request(), new AbortController().signal));
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const oldLease = session.leases[0] as FakeLease;
  const oldTool = oldLease.emitToolCall({
    threadId: oldLease.threadId,
    turnId: oldLease.turnId,
    callId: "reused-call",
    name: "lookup",
    input: { generation: "old" },
  }, 1);
  let oldToolReturned = false;
  const oldToolResponse = oldTool.then(() => {
    oldToolReturned = true;
  });
  assert.deepEqual(await oldInitial, [{
    type: "tool-call",
    callId: "reused-call",
    name: "lookup",
    input: { generation: "old" },
  }]);
  const oldContinuation = transport.generate(request([
    resultMessage("reused-call", [{ kind: "text", text: "old result" }]),
  ]), new AbortController().signal)[Symbol.asyncIterator]();
  const oldContinuationFirst = oldContinuation.next();
  await waitFor(() => oldToolReturned);
  await oldToolResponse;

  const newIterator = transport.generate(request(), new AbortController().signal)[Symbol.asyncIterator]();
  const newFirst = newIterator.next();
  await waitFor(() => session.leases.length === 2 && session.leases[1]?.turnStarts.length === 1);
  const newLease = session.leases[1] as FakeLease;
  const newTool = newLease.emitToolCall({
    threadId: newLease.threadId,
    turnId: newLease.turnId,
    callId: "reused-call",
    name: "lookup",
    input: { generation: "new" },
  }, 2);
  assert.deepEqual((await newFirst).value, {
    type: "tool-call",
    callId: "reused-call",
    name: "lookup",
    input: { generation: "new" },
  });
  assert.equal(newLease.interrupts.length, 0);

  await oldLease.emitNotification("turn/completed", {
    threadId: oldLease.threadId,
    turnId: oldLease.turnId,
  });
  assert.deepEqual(await oldContinuationFirst, {
    done: false,
    value: { type: "completed" },
  });
  assert.deepEqual(await oldContinuation.next(), { done: true, value: undefined });

  await transport.dispose();
  await assert.rejects(newTool, (error: unknown) => error instanceof Error);
  assert.equal(oldLease.releaseCount, 1);
  assert.equal(newLease.releaseCount, 1);
  assert.equal(newLease.interrupts.length, 1);
  assert.equal(newLease.unsubscribes.length, 1);
});

test("turn failure cleans a paused keep-alive turn after one tool RPC has returned", async () => {
  const session = new FakeSession();
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const transport = new AppServerTransport(session, registry);
  const initial = collect(transport.generate(request(), new AbortController().signal));
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const lease = session.leases[0] as FakeLease;
  const firstTool = lease.emitToolCall({
    threadId: lease.threadId,
    turnId: lease.turnId,
    callId: "failed-call-1",
    name: "lookup",
    input: { key: "one" },
  }, 1);
  assert.deepEqual(await initial, [
    { type: "tool-call", callId: "failed-call-1", name: "lookup", input: { key: "one" } },
  ]);

  const continuation = transport.generate(request([
    resultMessage("failed-call-1", [{ kind: "text", text: "one" }]),
  ]), new AbortController().signal)[Symbol.asyncIterator]();
  const continuationFirst = continuation.next();
  await firstTool;
  const secondTool = lease.emitToolCall({
    threadId: lease.threadId,
    turnId: lease.turnId,
    callId: "failed-call-2",
    name: "lookup",
    input: { key: "two" },
  }, 2);
  const secondToolRejection = assert.rejects(secondTool, (error: unknown) => error instanceof Error);
  assert.deepEqual(await continuationFirst, {
    done: false,
    value: { type: "tool-call", callId: "failed-call-2", name: "lookup", input: { key: "two" } },
  });
  assert.deepEqual(await continuation.next(), { done: true, value: undefined });
  await lease.emitNotification("turn/failed", {
    threadId: lease.threadId,
    turnId: lease.turnId,
  });
  await waitFor(() => lease.interrupts.length === 1 && lease.unsubscribes.length === 1);

  assert.equal(registry.size, 0);
  assert.equal(lease.releaseCount, 1);
  await secondToolRejection;
  assert.equal(lease.allNotificationHandlerCount, 0);
  assert.equal(lease.allToolHandlerCount, 0);
  await transport.dispose();
});

test("turn error cleans a paused keep-alive turn directly", async () => {
  const session = new FakeSession();
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const transport = new AppServerTransport(session, registry);
  const initial = collect(transport.generate(request(), new AbortController().signal));
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const lease = session.leases[0] as FakeLease;
  const pendingTool = lease.emitToolCall({
    threadId: lease.threadId,
    turnId: lease.turnId,
    callId: "error-call",
    name: "lookup",
    input: { key: "error" },
  }, 1);
  const pendingToolRejection = assert.rejects(pendingTool, (error: unknown) => error instanceof Error);
  assert.deepEqual(await initial, [
    { type: "tool-call", callId: "error-call", name: "lookup", input: { key: "error" } },
  ]);

  await lease.emitNotification("turn/error", {
    threadId: lease.threadId,
    turnId: lease.turnId,
  });
  await waitFor(() => lease.interrupts.length === 1 && lease.unsubscribes.length === 1);

  assert.equal(registry.size, 0);
  assert.equal(lease.releaseCount, 1);
  await pendingToolRejection;
  assert.equal(lease.allNotificationHandlerCount, 0);
  assert.equal(lease.allToolHandlerCount, 0);
  await transport.dispose();
});

test("ignores historical image results when validating a live text-only continuation", async () => {
  const session = new FakeSession(textOnlyModel);
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const transport = new AppServerTransport(session, registry);
  const firstIterator = transport.generate(request(), new AbortController().signal)[Symbol.asyncIterator]();
  const first = firstIterator.next();
  await waitFor(() => session.leases.length === 1 && session.leases[0]?.turnStarts.length === 1);
  const lease = session.leases[0] as FakeLease;
  const pendingTool = lease.emitToolCall({
    threadId: lease.threadId,
    turnId: lease.turnId,
    callId: "live-text-call",
    name: "lookup",
    input: { key: "live" },
  }, 1);
  assert.deepEqual((await first).value, {
    type: "tool-call",
    callId: "live-text-call",
    name: "lookup",
    input: { key: "live" },
  });
  await firstIterator.next();

  const continuation = collect(transport.generate(request([
    resultMessage("historical-image", [{
      kind: "image",
      mimeType: "image/png",
      data: new Uint8Array([7, 8, 9]),
    }]),
    resultMessage("live-text-call", [{ kind: "text", text: "live result" }]),
  ]), new AbortController().signal));
  await lease.emitNotification("item/agentMessage/delta", {
    threadId: lease.threadId,
    turnId: lease.turnId,
    delta: "continued after live result",
  });
  await lease.emitNotification("turn/completed", {
    threadId: lease.threadId,
    turnId: lease.turnId,
  });

  assert.deepEqual(await continuation, [
    { type: "text-delta", text: "continued after live result" },
    { type: "completed" },
  ]);
  await pendingTool;
  await transport.dispose();
});
