import assert from "node:assert/strict";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import {
  ToolContinuationRegistry,
  type PendingToolCallRequest,
  type ToolContinuationResult,
} from "../../src/transports/app-server/tool-continuations.js";

const signal = new AbortController().signal;

function request(
  callId: string,
  threadId = "thread-1",
  turnId = "turn-1",
  callbacks?: {
    respond?: (result: { contentItems: readonly unknown[]; success: boolean }) => void;
    reject?: (error: Error) => void;
  },
): PendingToolCallRequest {
  return {
    rpcId: `rpc-${callId}`,
    threadId,
    turnId,
    callId,
    name: "lookup",
    input: { callId },
    expiresAt: 1_000,
    respond: callbacks?.respond ?? (() => undefined),
    reject: callbacks?.reject ?? (() => undefined),
    continue: async function* () {
      yield { type: "text-delta", text: `continued-${callId}` };
      yield { type: "completed" };
    },
  };
}

function result(callId: string, text: string): ToolContinuationResult {
  return {
    callId,
    contentItems: [{ type: "inputText", text }],
    success: true,
  };
}

test("captures one call, surfaces it, responds with the exact result, and resumes its stream", async () => {
  const responses: unknown[] = [];
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const continuation = registry.capture(request("call-1", "thread-1", "turn-1", {
    respond: (value) => responses.push(value),
  }));

  assert.equal(continuation.calls[0]?.callId, "call-1");
  assert.deepEqual(registry.unsurfaced("thread-1", "turn-1").map((call) => call.callId), ["call-1"]);
  registry.markSurfaced("call-1");

  const stream = registry.resume([result("call-1", "done")], signal);
  assert.ok(stream !== undefined);
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }

  assert.deepEqual(responses, [{
    contentItems: [{ type: "inputText", text: "done" }],
    success: true,
  }]);
  assert.deepEqual(events, [
    { type: "text-delta", text: "continued-call-1" },
    { type: "completed" },
  ]);
  assert.equal(registry.size, 0);
});

test("holds parallel calls until every surfaced result arrives, even when results arrive out of order", async () => {
  const responses: string[] = [];
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  registry.capture(request("call-1", "thread-1", "turn-1", {
    respond: (value) => responses.push(String((value.contentItems[0] as { text: string }).text)),
  }));
  const second = registry.capture(request("call-2", "thread-1", "turn-1", {
    respond: (value) => responses.push(String((value.contentItems[0] as { text: string }).text)),
  }));
  assert.equal(second.calls.length, 2);
  registry.markSurfaced("call-1");

  assert.equal(registry.resume([result("call-1", "first")], signal), undefined);
  assert.deepEqual(responses, []);
  assert.deepEqual(registry.unsurfaced("thread-1", "turn-1").map((call) => call.callId), ["call-2"]);

  registry.markSurfaced("call-2");
  const stream = registry.resume([result("call-2", "second")], signal);
  assert.ok(stream !== undefined);
  for await (const _event of stream) {
    // Drain the continuation to exercise its cleanup path.
  }

  assert.deepEqual(responses, ["first", "second"]);
  assert.equal(registry.size, 0);
});

test("rejects duplicate and unknown result IDs without fuzzy matching", () => {
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  registry.capture(request("call-1"));
  registry.markSurfaced("call-1");

  registry.resume([result("call-1", "first")], signal);
  assert.throws(
    () => registry.resume([result("call-1", "duplicate")], signal),
    (error: unknown) => error instanceof CodexError && error.code === "toolContinuation",
  );
  assert.throws(
    () => registry.resume([result("call-10", "near miss")], signal),
    (error: unknown) => error instanceof CodexError && error.code === "toolContinuation",
  );
});

test("stores a partial result without answering until the remaining surfaced call is complete", () => {
  const responses: string[] = [];
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  registry.capture(request("call-1", "thread-1", "turn-1", {
    respond: (value) => responses.push(String((value.contentItems[0] as { text: string }).text)),
  }));
  registry.capture(request("call-2", "thread-1", "turn-1", {
    respond: (value) => responses.push(String((value.contentItems[0] as { text: string }).text)),
  }));
  registry.markSurfaced("call-1");
  registry.markSurfaced("call-2");

  assert.equal(registry.resume([result("call-2", "second")], signal), undefined);
  assert.deepEqual(responses, []);
  assert.deepEqual(registry.received("call-2"), result("call-2", "second"));
  assert.ok(registry.resume([result("call-1", "first")], signal) !== undefined);
  assert.deepEqual(responses, ["first", "second"]);
});

test("expires calls at the 300-second deadline and rejects late results after cleanup", () => {
  const rejected: Error[] = [];
  const registry = new ToolContinuationRegistry({ now: () => 700 });
  registry.capture({
    ...request("call-timeout"),
    expiresAt: 300_700,
    reject: (error) => rejected.push(error),
  });

  assert.equal(registry.expire(300_699), 0);
  assert.equal(registry.expire(300_700), 1);
  assert.equal(registry.size, 0);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0] instanceof CodexError);
  assert.equal((rejected[0] as CodexError).code, "timeout");
  assert.throws(
    () => registry.resume([result("call-timeout", "late")], signal),
    (error: unknown) => error instanceof CodexError && error.code === "toolContinuation",
  );
});

test("arms the exact pending-call expiry and clears it when the call is cleaned up", () => {
  let scheduled: { callback: () => void; milliseconds: number } | undefined;
  let cleared = 0;
  const registry = new ToolContinuationRegistry({
    now: () => 500,
    setTimeout: (callback, milliseconds) => {
      scheduled = { callback, milliseconds };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {
      cleared += 1;
    },
  });
  const rejected: Error[] = [];

  registry.capture({
    ...request("call-timer"),
    expiresAt: 800,
    reject: (error) => rejected.push(error),
  });

  assert.equal(scheduled?.milliseconds, 300);
  scheduled?.callback();
  assert.equal(registry.size, 0);
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as CodexError).code, "timeout");
  assert.equal(cleared, 1);
});

test("cancellation and process exit reject every pending call and leave no orphan IDs", () => {
  const rejected: string[] = [];
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  registry.capture({
    ...request("call-cancel", "thread-cancel", "turn-cancel"),
    reject: () => rejected.push("cancel"),
  });
  registry.capture({
    ...request("call-exit", "thread-exancel", "turn-exit"),
    reject: () => rejected.push("exit"),
  });

  registry.cancel("thread-cancel", "turn-cancel", new CodexError("cancelled"));
  registry.processExit(new CodexError("process"));

  assert.deepEqual(rejected.sort(), ["cancel", "exit"]);
  assert.equal(registry.size, 0);
  assert.deepEqual(registry.unsurfaced("thread-cancel", "turn-cancel"), []);
});

test("isolates reused call and turn IDs by generation and lease identity", () => {
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const firstIdentity = { generation: 1, leaseId: "lease-1" };
  const secondIdentity = { generation: 2, leaseId: "lease-2" };
  registry.capture({
    ...request("same-call", "reused-thread", "reused-turn"),
    ...firstIdentity,
  });
  registry.capture({
    ...request("same-call", "reused-thread", "reused-turn"),
    ...secondIdentity,
  });

  assert.equal(registry.size, 2);
  assert.equal(registry.has("same-call", firstIdentity), true);
  assert.equal(registry.has("same-call", secondIdentity), true);

  registry.cancel(
    "reused-thread",
    "reused-turn",
    new CodexError("cancelled"),
    firstIdentity,
  );
  assert.equal(registry.has("same-call", firstIdentity), false);
  assert.equal(registry.has("same-call", secondIdentity), true);
  assert.equal(registry.size, 1);

  registry.cleanup("reused-thread", "reused-turn", secondIdentity);
  assert.equal(registry.size, 0);
});

test("resume with empty results selects only the supplied generation and lease", () => {
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const firstIdentity = { generation: 1, leaseId: "lease-1" };
  const secondIdentity = { generation: 2, leaseId: "lease-2" };
  const firstResponses: unknown[] = [];
  registry.capture({
    ...request("first-call", "first-thread", "first-turn", {
      respond: (value) => firstResponses.push(value),
    }),
    ...firstIdentity,
  });
  registry.capture({
    ...request("second-call", "second-thread", "second-turn"),
    ...secondIdentity,
  });
  assert.equal(registry.resume([result("first-call", "ready")], signal, {
    ...firstIdentity,
    continueTurn: false,
  }), undefined);
  registry.markSurfaced("first-call", firstIdentity);

  assert.equal(registry.resume([], signal, {
    generation: 99,
    leaseId: "missing-lease",
    continueTurn: false,
  }), undefined);
  assert.deepEqual(firstResponses, []);
  assert.equal(registry.size, 2);

  assert.equal(registry.resume([], signal, {
    ...firstIdentity,
    continueTurn: false,
  }), undefined);
  assert.deepEqual(firstResponses, [{
    contentItems: [{ type: "inputText", text: "ready" }],
    success: true,
  }]);
  assert.equal(registry.has("first-call", firstIdentity), false);
  assert.equal(registry.has("second-call", secondIdentity), true);
  registry.cleanup("second-thread", "second-turn", secondIdentity);
});

test("process exit without thread IDs affects only the supplied identity", () => {
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const firstIdentity = { generation: 1, leaseId: "lease-1" };
  const secondIdentity = { generation: 2, leaseId: "lease-2" };
  const rejected: string[] = [];
  registry.capture({
    ...request("first-call", "first-thread", "first-turn", {
      reject: () => rejected.push("first"),
    }),
    ...firstIdentity,
  });
  registry.capture({
    ...request("second-call", "second-thread", "second-turn", {
      reject: () => rejected.push("second"),
    }),
    ...secondIdentity,
  });

  registry.processExit(
    new CodexError("process"),
    undefined,
    undefined,
    { generation: 99, leaseId: "missing-lease" },
  );
  assert.deepEqual(rejected, []);
  assert.equal(registry.size, 2);

  registry.processExit(
    new CodexError("process"),
    undefined,
    undefined,
    firstIdentity,
  );
  assert.deepEqual(rejected, ["first"]);
  assert.equal(registry.has("first-call", firstIdentity), false);
  assert.equal(registry.has("second-call", secondIdentity), true);
  registry.cleanup("second-thread", "second-turn", secondIdentity);
});
