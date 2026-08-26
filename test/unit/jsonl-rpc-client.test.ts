import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Writable } from "node:stream";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import { JsonlRpcClient } from "../../src/transports/app-server/jsonl-rpc-client.js";

const nextTick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

class ControlledWritable extends EventEmitter {
  public readonly writes: string[] = [];
  public blocked = false;
  public throwOnWrite = false;

  public write(chunk: string | Uint8Array): boolean {
    if (this.throwOnWrite) {
      throw new Error("synchronous write failure");
    }
    this.writes.push(Buffer.from(chunk).toString("utf8"));
    return !this.blocked;
  }
}

test("correlates fragmented CRLF responses while ignoring notifications", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const outbound: Record<string, unknown>[] = [];
  clientInput.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() !== "") {
        outbound.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  });

  const client = new JsonlRpcClient(
    { input: clientInput, output: serverOutput },
    { requestTimeoutMs: 1_000 },
  );
  const first = client.request<{ value: string }>("first", { order: 1 });
  const second = client.request<{ value: string }>("second", { order: 2 });

  await nextTick();
  assert.deepEqual(
    outbound.map((message) => message.method),
    ["first", "second"],
  );
  const firstId = outbound[0]?.id;
  const secondId = outbound[1]?.id;
  assert.equal(typeof firstId, "number");
  assert.equal(typeof secondId, "number");

  const serverRequestResult = new Promise<void>((resolve, reject) => {
    clientInput.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() === "") {
          continue;
        }
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id === 99) {
            assert.deepEqual(message.result, { pong: true });
            resolve();
          }
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  client.onServerRequest("server/ping", async (params) => {
    assert.deepEqual(params, { request: "value" });
    return { pong: true };
  });

  serverOutput.write(
    `{"method":"server/notice","params":{"ignored":true}}\r\n{"id":${secondId},"result":{"value":"second"}}\r`,
  );
  serverOutput.write(
    `\n{"id":99,"method":"server/ping","params":{"request":"value"}}\r\n{"id":${firstId},"result":{"value":"first"}}\n`,
  );

  assert.deepEqual(await first, { value: "first" });
  assert.deepEqual(await second, { value: "second" });
  await serverRequestResult;
  client.dispose();
  serverOutput.destroy();
  clientInput.destroy();
});

test("accepts finite emittedAtMs metadata on App Server notifications", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(
    { input: clientInput, output: serverOutput },
    { requestTimeoutMs: 1_000 },
  );
  let received: unknown;
  client.onServerNotification("thread/started", (params) => {
    received = params;
  });

  serverOutput.write(
    '{"method":"thread/started","params":{"thread":{"id":"thread-1"}},"emittedAtMs":1787299200000}\n',
  );
  await nextTick();

  assert.equal(client.isClosed, false);
  assert.deepEqual(received, { thread: { id: "thread-1" } });
  client.dispose();
  serverOutput.destroy();
  clientInput.destroy();
});

test("rejects non-numeric emittedAtMs metadata before dispatch", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(
    { input: clientInput, output: serverOutput },
    { requestTimeoutMs: 1_000 },
  );
  let dispatched = false;
  client.onServerNotification("thread/started", () => {
    dispatched = true;
  });

  serverOutput.write(
    '{"method":"thread/started","params":{},"emittedAtMs":"1787299200000"}\n',
  );
  await nextTick();

  assert.equal(client.isClosed, true);
  assert.equal(dispatched, false);
  clientInput.destroy();
});

test("rejects every pending request with a redacted protocol error on malformed JSONL", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(
    { input: clientInput, output: serverOutput },
    { requestTimeoutMs: 1_000 },
  );
  const pending = client.request("wait", {});
  const privateLine = '{"prompt":"private ABAP source and credentials"';
  serverOutput.write(`${privateLine}\r\n`);

  await assert.rejects(
    pending,
    (error: unknown) => {
      assert.ok(error instanceof CodexError);
      assert.equal(error.code, "protocol");
      assert.equal(JSON.stringify(error).includes("private ABAP source"), false);
      assert.equal(String(error).includes("private ABAP source"), false);
      return true;
    },
  );
  client.dispose();
  serverOutput.destroy();
  clientInput.destroy();
});

test("bounds unterminated JSONL input while accepting a complete line at the limit", async () => {
  const createClient = (
    serverOutput: PassThrough,
    clientInput: PassThrough,
    terminations: CodexError[],
  ): JsonlRpcClient => new JsonlRpcClient(
    { input: clientInput, output: serverOutput },
    {
      requestTimeoutMs: 1_000,
      maxLineChars: 32,
      onDidTerminate: (error: CodexError): void => {
        terminations.push(error);
      },
    },
  );

  const validOutput = new PassThrough();
  const validInput = new PassThrough();
  const validTerminations: CodexError[] = [];
  const validClient = createClient(validOutput, validInput, validTerminations);
  const method = "x".repeat(18);
  let dispatched = false;
  validClient.onServerNotification(method, () => {
    dispatched = true;
  });
  validOutput.write(`${JSON.stringify({ method })}\n`);
  await nextTick();
  assert.equal(dispatched, true);
  assert.equal(validClient.isClosed, false);
  assert.deepEqual(validTerminations, []);
  validClient.dispose();
  validOutput.destroy();
  validInput.destroy();

  const oversizedOutput = new PassThrough();
  const oversizedInput = new PassThrough();
  const oversizedTerminations: CodexError[] = [];
  const oversizedClient = createClient(oversizedOutput, oversizedInput, oversizedTerminations);
  oversizedOutput.write("x".repeat(33));
  await nextTick();
  assert.equal(oversizedClient.isClosed, true);
  assert.equal(oversizedTerminations.length, 1);
  assert.equal(oversizedTerminations[0]?.code, "protocol");
  oversizedClient.dispose();
  oversizedOutput.destroy();
  oversizedInput.destroy();

  const completeOutput = new PassThrough();
  const completeInput = new PassThrough();
  const completeTerminations: CodexError[] = [];
  const completeClient = createClient(completeOutput, completeInput, completeTerminations);
  completeOutput.write(`${JSON.stringify({ method: "x".repeat(20) })}\n`);
  await nextTick();
  assert.equal(completeClient.isClosed, true);
  assert.equal(completeTerminations[0]?.code, "protocol");
  completeClient.dispose();
  completeOutput.destroy();
  completeInput.destroy();
});

test("rejects invalid JSONL line limits", () => {
  for (const maxLineChars of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    const serverOutput = new PassThrough();
    const clientInput = new PassThrough();
    assert.throws(
      () => new JsonlRpcClient(
        { input: clientInput, output: serverOutput },
        { maxLineChars },
      ),
      (error: unknown) => error instanceof RangeError,
    );
    serverOutput.destroy();
    clientInput.destroy();
  }
});

test("retains safe remote JSON-RPC classification metadata without exposing its message", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(
    { input: clientInput, output: serverOutput },
    { requestTimeoutMs: 1_000 },
  );
  const pending = client.request("thread/start", {});
  serverOutput.write(JSON.stringify({
    id: 1,
    error: {
      code: -32602,
      message: "dynamicTools is unavailable: private server detail",
    },
  }) + "\n");

  await assert.rejects(
    pending,
    (error: unknown) => {
      assert.ok(error instanceof CodexError);
      assert.equal(error.code, "protocol");
      assert.equal(String(error).includes("private server detail"), false);
      const cause = (error as Error & { cause?: unknown }).cause;
      assert.ok(cause && typeof cause === "object");
      assert.equal(JSON.stringify(cause).includes("private server detail"), false);
      assert.equal((cause as { rpcCode?: number }).rpcCode, -32602);
      assert.equal(
        (cause as { rpcMessage?: string }).rpcMessage,
        "dynamicTools is unavailable: private server detail",
      );
      return true;
    },
  );
  client.dispose();
  serverOutput.destroy();
  clientInput.destroy();
});

test("cancellation removes the pending request and emits a cancellation notification", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const outbound: Record<string, unknown>[] = [];
  clientInput.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() !== "") {
        outbound.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  });
  const client = new JsonlRpcClient(
    { input: clientInput, output: serverOutput },
    { requestTimeoutMs: 1_000 },
  );
  const controller = new AbortController();
  const pending = client.request("cancel-me", {}, controller.signal);
  await nextTick();
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
  assert.deepEqual(outbound.map((message) => message.method), ["cancel-me", "$/cancelRequest"]);
  assert.deepEqual(outbound[1]?.params, { id: outbound[0]?.id });
  client.dispose();
  serverOutput.destroy();
  clientInput.destroy();
});

test("times out a pending request without exposing the request payload", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(
    { input: clientInput, output: serverOutput },
    { requestTimeoutMs: 10 },
  );
  const pending = client.request("timeout-me", { prompt: "private text" });

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexError && error.code === "timeout",
  );
  client.dispose();
  serverOutput.destroy();
  clientInput.destroy();
});

test("dispose rejects pending requests and prevents later writes", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(
    { input: clientInput, output: serverOutput },
    { requestTimeoutMs: 1_000 },
  );
  const pending = client.request("dispose-me", { prompt: "private text" });
  client.dispose();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
  assert.throws(
    () => client.notify("after-dispose"),
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );
  serverOutput.destroy();
  clientInput.destroy();
});

test("decodes a response split inside a UTF-8 code point and flushes an unterminated final line", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(
    { input: clientInput, output: serverOutput },
    { requestTimeoutMs: 1_000 },
  );
  const pending = client.request<{ text: string }>("unicode", {});
  const frame = Buffer.from('{"id":1,"result":{"text":"你好"}}', "utf8");
  const split = frame.indexOf(Buffer.from("好", "utf8")) + 1;
  serverOutput.write(frame.subarray(0, split));
  serverOutput.end(frame.subarray(split));

  assert.deepEqual(await pending, { text: "你好" });
  client.dispose();
  clientInput.destroy();
});

test("rejects malformed UTF-8 instead of replacing it into valid JSON", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(
    { input: clientInput, output: serverOutput },
    { requestTimeoutMs: 1_000 },
  );
  const pending = client.request("malformed-utf8", {});
  serverOutput.write(Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x31, 0x2c, 0x22, 0x72, 0x65, 0x73, 0x75, 0x6c, 0x74, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a]));

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexError && error.code === "protocol",
  );
  client.dispose();
  clientInput.destroy();
});

test("strictly rejects incomplete, ambiguous, extended, and malformed response envelopes", async () => {
  const invalidResponses = [
    '{"id":1}',
    '{"id":1,"result":null,"error":{"code":-1,"message":"bad"}}',
    '{"id":1,"result":null,"extra":true}',
    '{"id":1,"error":{"code":"-1","message":"bad"}}',
    '{"id":1,"error":{"code":-1}}',
    '{"id":1,"error":{"code":1e999,"message":"bad"}}',
  ];

  for (const response of invalidResponses) {
    const serverOutput = new PassThrough();
    const clientInput = new PassThrough();
    const client = new JsonlRpcClient(
      { input: clientInput, output: serverOutput },
      { requestTimeoutMs: 1_000 },
    );
    const pending = client.request("strict-response", {});
    serverOutput.write(`${response}\n`);
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof CodexError && error.code === "protocol",
      response,
    );
    client.dispose();
    serverOutput.destroy();
    clientInput.destroy();
  }
});

test("serializes backpressured writes and removes a cancelled queued request", async () => {
  const serverOutput = new PassThrough();
  const input = new ControlledWritable();
  input.blocked = true;
  const client = new JsonlRpcClient(
    { input: input as unknown as Writable, output: serverOutput },
    { requestTimeoutMs: Number.POSITIVE_INFINITY },
  );
  const first = client.request("first-queued", {});
  const controller = new AbortController();
  const second = client.request("second-queued", {}, controller.signal);

  await nextTick();
  assert.equal(input.writes.length, 1);
  controller.abort();
  await assert.rejects(
    second,
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
  input.blocked = false;
  input.emit("drain");
  client.dispose();
  await assert.rejects(
    first,
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
  assert.equal(input.writes.length, 1);
  serverOutput.destroy();
});

test("termination rejects queued writes and removes all owned stream listeners", async () => {
  const serverOutput = new PassThrough();
  const input = new ControlledWritable();
  input.blocked = true;
  const client = new JsonlRpcClient(
    { input: input as unknown as Writable, output: serverOutput },
    { requestTimeoutMs: Number.POSITIVE_INFINITY },
  );
  const pending = client.request("queued", {});
  client.onServerRequest("server/request", () => ({ ok: true }));
  client.dispose();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
  for (const event of ["data", "error", "end", "close", "drain"]) {
    assert.equal(serverOutput.listenerCount(event), 0, `output ${event}`);
    assert.equal(input.listenerCount(event), 0, `input ${event}`);
  }
  serverOutput.destroy();
});

test("termination preserves external listeners on caller-provided streams", async () => {
  const serverOutput = new PassThrough();
  const input = new ControlledWritable();
  const externalListener = (): void => undefined;
  const events = ["data", "error", "end", "finish", "close", "drain"];
  for (const event of events) {
    input.on(event, externalListener);
    serverOutput.on(event, externalListener);
  }
  const baseline = new Map(
    events.flatMap((event) => [
      [`input:${event}`, input.listenerCount(event)] as const,
      [`output:${event}`, serverOutput.listenerCount(event)] as const,
    ]),
  );
  const client = new JsonlRpcClient(
    { input: input as unknown as Writable, output: serverOutput },
    { requestTimeoutMs: Number.POSITIVE_INFINITY },
  );
  const pending = client.request("external-listeners", {});
  client.dispose();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
  for (const event of events) {
    assert.equal(input.listenerCount(event), baseline.get(`input:${event}`), `input ${event}`);
    assert.equal(serverOutput.listenerCount(event), baseline.get(`output:${event}`), `output ${event}`);
  }
  input.emit("drain");
  serverOutput.emit("end");
  serverOutput.emit("close");
  client.dispose();
  serverOutput.destroy();
});

test("notifies a termination observer exactly once", async () => {
  const serverOutput = new PassThrough();
  const input = new ControlledWritable();
  const terminations: CodexError[] = [];
  const options = {
    requestTimeoutMs: 1_000,
    onDidTerminate: (error: CodexError): void => {
      terminations.push(error);
    },
  } as unknown as { requestTimeoutMs: number; onDidTerminate: (error: CodexError) => void };
  const client = new JsonlRpcClient(
    { input: input as unknown as Writable, output: serverOutput },
    options,
  );

  const pending = client.request("termination-observer", {});
  serverOutput.emit("end");
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );
  client.dispose();

  assert.equal(terminations.length, 1);
  assert.equal(terminations[0]?.code, "process");
  serverOutput.destroy();
});

test("observes synchronous server-error write failures without an unhandled rejection", async () => {
  const serverOutput = new PassThrough();
  const input = new ControlledWritable();
  input.throwOnWrite = true;
  const client = new JsonlRpcClient(
    { input: input as unknown as Writable, output: serverOutput },
    { requestTimeoutMs: Number.POSITIVE_INFINITY },
  );
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    assert.doesNotThrow(() => {
      serverOutput.write('{"id":77,"method":"unknown/server/request"}\n');
    });
    await wait(10);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    client.dispose();
    serverOutput.destroy();
  }
  assert.deepEqual(unhandled, []);
});

test("maps input/output errors, end, and close to bounded typed termination", async () => {
  for (const event of ["input-error", "output-error", "end", "close"] as const) {
    const serverOutput = new PassThrough();
    const clientInput = new ControlledWritable();
    const client = new JsonlRpcClient(
      { input: clientInput as unknown as Writable, output: serverOutput },
      { requestTimeoutMs: 1_000 },
    );
    const pending = client.request("stream-lifecycle", {});
    if (event === "input-error") {
      clientInput.emit("error", new Error("input failed"));
    } else if (event === "output-error") {
      serverOutput.emit("error", new Error("output failed"));
    } else if (event === "end") {
      serverOutput.emit("end");
    } else {
      serverOutput.emit("close");
    }
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof CodexError && error.code === "process",
      event,
    );
    client.dispose();
    serverOutput.destroy();
  }
});

test("terminates once for Writable finish/close and Readable end/close with no queued-write leaks", async () => {
  const cases = [
    { source: "input", event: "error" },
    { source: "input", event: "finish" },
    { source: "input", event: "close" },
    { source: "output", event: "error" },
    { source: "output", event: "end" },
    { source: "output", event: "close" },
  ] as const;

  for (const { source, event } of cases) {
    const serverOutput = new PassThrough();
    const input = new ControlledWritable();
    input.blocked = true;
    const client = new JsonlRpcClient(
      { input: input as unknown as Writable, output: serverOutput },
      { requestTimeoutMs: 50 },
    );
    const first = client.request("lifecycle-first", {});
    const second = client.request("lifecycle-second", {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      if (source === "input") {
        if (event === "error") {
          input.emit("error", new Error("input failed"));
        } else {
          // Writable termination uses finish/close, not Readable end.
          input.emit(event);
        }
        input.emit(event === "finish" ? "close" : "finish");
        input.emit("drain");
      } else if (event === "error") {
        serverOutput.emit("error", new Error("output failed"));
      } else {
        serverOutput.emit(event);
        serverOutput.emit(event === "end" ? "close" : "end");
      }

      const outcomes = await Promise.allSettled([first, second]);
      assert.deepEqual(outcomes.map((outcome) => outcome.status), ["rejected", "rejected"]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          assert.ok(outcome.reason instanceof CodexError);
          assert.equal(outcome.reason.code, "process");
        }
      }
      assert.equal(client.isClosed, true);
      for (const stream of [input, serverOutput]) {
        for (const listener of ["data", "error", "end", "finish", "close", "drain"]) {
          assert.equal(stream.listenerCount(listener), 0, `${source} ${event} ${listener}`);
        }
      }
      await wait(10);
      assert.deepEqual(unhandled, []);
    } finally {
      client.dispose();
      process.off("unhandledRejection", onUnhandled);
      serverOutput.destroy();
    }
  }
});
