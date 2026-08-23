import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import { ChatGptHttpClient } from "../../src/transports/chatgpt-oauth/http-client.js";

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
};

const close = async (server: Server): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
};

test("default OAuth HTTP client routes ChatGPT requests through HTTPS_PROXY", async () => {
  let connectHits = 0;
  const proxy = createServer();
  proxy.on("connect", (_request, socket) => {
    connectHits += 1;
    socket.destroy();
  });
  const proxyPort = await listen(proxy);
  const previous = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
  };

  try {
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.NO_PROXY = "";
    const client = new ChatGptHttpClient({
      getAccessToken: async () => ({ token: "test-access-token" }),
    }, { timeoutMs: 3_000 });

    await assert.rejects(
      client.getModels(new AbortController().signal),
      (error: unknown) => error instanceof CodexError,
    );
    assert.equal(connectHits, 1);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await close(proxy);
  }
});
