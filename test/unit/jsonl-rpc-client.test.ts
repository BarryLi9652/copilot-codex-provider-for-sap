import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import { JsonlRpcClient } from "../../src/transports/app-server/jsonl-rpc-client.js";

const nextTick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

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
