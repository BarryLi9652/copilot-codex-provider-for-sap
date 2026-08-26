import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  createProxyAwareFetch,
  type ProxyAwareFetch,
} from "../../src/transports/chatgpt-oauth/proxy-fetch.js";

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

test("reuses direct connections and rejects new requests after idempotent disposal", async () => {
  let connections = 0;
  const origin = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  origin.on("connection", () => {
    connections += 1;
  });
  const originPort = await listen(origin);
  const fetch = createProxyAwareFetch({});

  try {
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`http://127.0.0.1:${originPort}/models`);
      assert.deepEqual(await response.json(), { ok: true });
    }
    assert.equal(connections, 1);
    assert.doesNotThrow(() => {
      fetch.dispose();
      fetch.dispose();
    });
    await assert.rejects(fetch(`http://127.0.0.1:${originPort}/after-dispose`));
  } finally {
    fetch.dispose?.();
    await close(origin);
  }
});

test("reuses the explicit proxy connection while preserving NO_PROXY and cancellation", async () => {
  let originHits = 0;
  let proxyConnections = 0;
  const origin = createServer((request, response) => {
    originHits += 1;
    if (request.url === "/slow") {
      setTimeout(() => {
        if (!response.destroyed) {
          response.end("slow");
        }
      }, 250).unref?.();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ route: "origin" }));
  });
  const proxy = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ route: "proxy", target: request.url }));
  });
  proxy.on("connection", () => {
    proxyConnections += 1;
  });
  const originPort = await listen(origin);
  const proxyPort = await listen(proxy);
  const target = `http://127.0.0.1:${originPort}/models`;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const proxiedFetch = createProxyAwareFetch({}, proxyUrl);
  const bypassedFetch = createProxyAwareFetch({
    HTTP_PROXY: proxyUrl,
    NO_PROXY: "127.0.0.1",
  });

  try {
    for (let index = 0; index < 3; index += 1) {
      const response = await proxiedFetch(target);
      assert.deepEqual(await response.json(), { route: "proxy", target });
    }
    assert.equal(proxyConnections, 1);
    assert.equal(originHits, 0);

    const bypassed = await bypassedFetch(target);
    assert.deepEqual(await bypassed.json(), { route: "origin" });
    assert.equal(proxyConnections, 1);
    assert.equal(originHits, 1);

    const controller = new AbortController();
    const pending = bypassedFetch(`http://127.0.0.1:${originPort}/slow`, {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    const afterCancellation = await bypassedFetch(target);
    assert.deepEqual(await afterCancellation.json(), { route: "origin" });
  } finally {
    proxiedFetch.dispose?.();
    bypassedFetch.dispose?.();
    await Promise.all([close(origin), close(proxy)]);
  }
});

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
  let proxiedFetch: ProxyAwareFetch | undefined;
  let bypassedFetch: ProxyAwareFetch | undefined;

  try {
    proxiedFetch = createProxyAwareFetch({ HTTP_PROXY: httpProxy });
    const proxiedResponse = await proxiedFetch(target);
    assert.deepEqual(await proxiedResponse.json(), { route: "proxy" });
    assert.deepEqual(proxyTargets, [target]);
    assert.equal(originHits, 0);

    proxyTargets.length = 0;
    bypassedFetch = createProxyAwareFetch({
      HTTP_PROXY: httpProxy,
      NO_PROXY: "127.0.0.1",
    });
    const bypassedResponse = await bypassedFetch(target);
    assert.deepEqual(await bypassedResponse.json(), { route: "origin" });
    assert.deepEqual(proxyTargets, []);
    assert.equal(originHits, 1);
  } finally {
    proxiedFetch?.dispose();
    bypassedFetch?.dispose();
    await Promise.all([close(origin), close(proxy)]);
  }
});

test("an explicit proxy overrides the environment without mutating it", async () => {
  const environmentTargets: string[] = [];
  const dedicatedTargets: string[] = [];
  const environmentProxy = createServer((request, response) => {
    environmentTargets.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ route: "environment" }));
  });
  const dedicatedProxy = createServer((request, response) => {
    dedicatedTargets.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ route: "dedicated" }));
  });
  const environmentPort = await listen(environmentProxy);
  const dedicatedPort = await listen(dedicatedProxy);
  const target = "http://origin.invalid/models";
  const environment: NodeJS.ProcessEnv = {
    HTTP_PROXY: `http://127.0.0.1:${environmentPort}`,
    NO_PROXY: "origin.invalid",
  };
  const initialEnvironment = { ...environment };
  let fetch: ProxyAwareFetch | undefined;

  try {
    fetch = createProxyAwareFetch(
      environment,
      `http://127.0.0.1:${dedicatedPort}`,
    );
    const response = await fetch(target);

    assert.deepEqual(await response.json(), { route: "dedicated" });
    assert.deepEqual(environmentTargets, []);
    assert.deepEqual(dedicatedTargets, [target]);
    assert.deepEqual(environment, initialEnvironment);
  } finally {
    fetch?.dispose();
    await Promise.all([close(environmentProxy), close(dedicatedProxy)]);
  }
});
