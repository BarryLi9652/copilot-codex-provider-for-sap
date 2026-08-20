import assert from "node:assert/strict";
import test from "node:test";
import { request, ServerResponse } from "node:http";
import { createServer, type Server } from "node:net";

import {
  LoopbackCallbackServer,
  LoopbackError,
} from "../../src/transports/chatgpt-oauth/loopback-server.js";

const requestUrl = (url: string, method = "GET"): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const clientRequest = request(url, { method }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    clientRequest.on("error", reject);
    clientRequest.end();
  });

const listenOn = (server: Server, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

const closeNetServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });

test("loopback callback accepts only the exact GET path and closes after one callback", async () => {
  const server = new LoopbackCallbackServer({ ports: [0], timeoutMs: 2_000 });
  const handle = await server.start();
  const redirect = new URL(handle.redirectUri);

  assert.equal(redirect.protocol, "http:");
  assert.equal(redirect.hostname, "localhost");
  assert.equal(redirect.pathname, "/auth/callback");
  assert.equal(handle.port, Number(redirect.port));

  const wrongPath = await requestUrl(
    `http://127.0.0.1:${handle.port}/not-the-callback?code=ignored&state=ignored`,
  );
  assert.equal(wrongPath.status, 404);
  const wrongMethod = await requestUrl(
    `http://127.0.0.1:${handle.port}/auth/callback?code=ignored&state=ignored`,
    "POST",
  );
  assert.equal(wrongMethod.status, 405);

  const callbackUrl =
    "http://127.0.0.1:" +
    `${handle.port}/auth/callback?code=abc&state=state-value&error_description=%3Cscript%3E`;
  const callbackResponse = await requestUrl(callbackUrl);
  assert.equal(callbackResponse.status, 200);
  assert.match(callbackResponse.body, /callback/i);
  assert.equal(callbackResponse.body.includes("<script>"), false);
  assert.equal(
    await handle.callback,
    `http://localhost:${handle.port}/auth/callback?code=abc&state=state-value&error_description=%3Cscript%3E`,
  );
  await handle.close();

  await assert.rejects(
    requestUrl(`http://127.0.0.1:${handle.port}/auth/callback?code=second&state=second`),
  );
});

test("loopback callback timeout closes the listener without contacting OAuth", async () => {
  const server = new LoopbackCallbackServer({ ports: [0], timeoutMs: 20 });
  const handle = await server.start();

  await assert.rejects(handle.callback, /timed out/i);
  await assert.rejects(
    requestUrl(`http://127.0.0.1:${handle.port}/auth/callback?code=late&state=late`),
  );
});

test("response-writer failure still closes once and rejects the callback safely", async () => {
  const server = new LoopbackCallbackServer({ ports: [0], timeoutMs: 100 });
  const handle = await server.start();
  const originalWriteHead = ServerResponse.prototype.writeHead;
  let resolveWriterReached!: () => void;
  const writerReached = new Promise<void>((resolve) => {
    resolveWriterReached = resolve;
  });
  const uncaughtErrors: Error[] = [];
  const uncaughtHandler = (error: Error): void => {
    uncaughtErrors.push(error);
  };
  process.on("uncaughtException", uncaughtHandler);
  ServerResponse.prototype.writeHead = function (
    statusCode: number,
    statusMessageOrHeaders?: string | Parameters<typeof originalWriteHead>[1],
    headers?: Parameters<typeof originalWriteHead>[1],
  ) {
    if (statusCode === 200) {
      resolveWriterReached();
      this.destroy();
      throw new Error("synthetic response writer failure");
    }
    if (typeof statusMessageOrHeaders === "string") {
      return Reflect.apply(
        originalWriteHead,
        this,
        [statusCode, statusMessageOrHeaders, headers],
      ) as ServerResponse;
    }
    return Reflect.apply(originalWriteHead, this, [statusCode, statusMessageOrHeaders]) as ServerResponse;
  };

  const clientRequest = request(
    `http://127.0.0.1:${handle.port}/auth/callback?code=code&state=state`,
  );
  clientRequest.on("error", () => undefined);
  clientRequest.end();

  try {
    await writerReached;
    await handle.close();
    const outcome = await Promise.race([
      handle.callback.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "unsettled" }>((resolve) => {
        setImmediate(() => resolve({ kind: "unsettled" }));
      }),
    ]);
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") {
      assert.ok(outcome.error instanceof LoopbackError);
      assert.equal((outcome.error.code as string), "callback_response_failed");
    }
    assert.deepEqual(uncaughtErrors, []);
  } finally {
    ServerResponse.prototype.writeHead = originalWriteHead;
    process.off("uncaughtException", uncaughtHandler);
    clientRequest.destroy();
    await handle.close();
  }
});

test("default production ports fall back from 1455 to 1457", async () => {
  const holder = createServer();
  let handle: Awaited<ReturnType<LoopbackCallbackServer["start"]>> | undefined;
  try {
    try {
      await listenOn(holder, 1455);
    } catch (error) {
      throw new Error(
        `Could not hold production fallback port 1455 for the test: ${String(error)}`,
        { cause: error },
      );
    }

    try {
      handle = await new LoopbackCallbackServer({ timeoutMs: 2_000 }).start();
    } catch (error) {
      throw new Error(
        `Production fallback failed to use port 1457 while 1455 was held: ${String(error)}`,
        { cause: error },
      );
    }
    assert.equal(handle.port, 1457);

    const callback = handle.callback;
    await handle.close();
    await assert.rejects(callback, /closed/i);
  } finally {
    if (handle) {
      await handle.close();
    }
    await closeNetServer(holder);
  }
});
