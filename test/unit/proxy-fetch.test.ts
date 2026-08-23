import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createProxyAwareFetch } from "../../src/transports/chatgpt-oauth/proxy-fetch.js";

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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
};

test("routes requests through the environment proxy unless NO_PROXY matches", async () => {
  let originHits = 0;
  const proxyTargets: string[] = [];
  const origin = createServer((_request, response) => {
    originHits += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ route: "origin" }));
  });
  const proxy = createServer((request, response) => {
    proxyTargets.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ route: "proxy" }));
  });
  const originPort = await listen(origin);
  const proxyPort = await listen(proxy);
  const target = `http://127.0.0.1:${originPort}/models`;
  const httpProxy = `http://127.0.0.1:${proxyPort}`;

  try {
    const proxiedFetch = createProxyAwareFetch({ HTTP_PROXY: httpProxy });
    const proxiedResponse = await proxiedFetch(target);
    assert.deepEqual(await proxiedResponse.json(), { route: "proxy" });
    assert.deepEqual(proxyTargets, [target]);
    assert.equal(originHits, 0);

    proxyTargets.length = 0;
    const bypassedFetch = createProxyAwareFetch({
      HTTP_PROXY: httpProxy,
      NO_PROXY: "127.0.0.1",
    });
    const bypassedResponse = await bypassedFetch(target);
    assert.deepEqual(await bypassedResponse.json(), { route: "origin" });
    assert.deepEqual(proxyTargets, []);
    assert.equal(originHits, 1);
  } finally {
    await Promise.all([close(origin), close(proxy)]);
  }
});
