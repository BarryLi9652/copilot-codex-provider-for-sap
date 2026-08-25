import { Agent, createServer, request } from "node:http";
import { performance } from "node:perf_hooks";

const REQUESTS_PER_MODE = 100;
const INTERNAL_ROUNDS = 3;

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1] ?? 0;
};

const rounded = (value) => Math.round(value * 1_000) / 1_000;

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.removeListener("error", reject);
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      reject(new Error("local benchmark server did not expose an address"));
      return;
    }
    resolve(address.port);
  });
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

const once = (url, agent, signal) => new Promise((resolve, reject) => {
  const started = performance.now();
  const outgoing = request(url, { agent, signal }, (response) => {
    response.resume();
    response.once("end", () => resolve(performance.now() - started));
  });
  outgoing.once("error", reject);
  outgoing.end();
});

const cancellationLatency = async (url, agent) => {
  const controller = new AbortController();
  const started = performance.now();
  const pending = once(url, agent, controller.signal);
  setTimeout(() => controller.abort(), 10).unref?.();
  try {
    await pending;
    throw new Error("slow benchmark request completed before cancellation");
  } catch (error) {
    if (error?.name !== "AbortError" && error?.code !== "ABORT_ERR") {
      throw error;
    }
    return performance.now() - started;
  }
};

const snapshot = (counters) => ({ ...counters });

const difference = (after, before) => Object.fromEntries(
  Object.keys(after).map((key) => [key, after[key] - before[key]]),
);

const runMode = async ({ name, target, slowTarget, proxyEnv, shared, counters }) => {
  const before = snapshot(counters);
  const sharedAgent = shared ? new Agent({ keepAlive: true, proxyEnv }) : undefined;
  const latencies = [];
  const started = performance.now();
  for (let index = 0; index < REQUESTS_PER_MODE; index += 1) {
    const agent = sharedAgent ?? new Agent({ keepAlive: true, proxyEnv });
    latencies.push(await once(target, agent));
    if (!shared) {
      agent.destroy();
    }
  }
  const totalDurationMs = performance.now() - started;
  const afterRequests = snapshot(counters);

  const cancellationAgent = sharedAgent ?? new Agent({ keepAlive: true, proxyEnv });
  const cancelledInMs = await cancellationLatency(slowTarget, cancellationAgent);
  if (!shared) {
    cancellationAgent.destroy();
  }

  const shutdownStarted = performance.now();
  sharedAgent?.destroy();
  const shutdownMs = performance.now() - shutdownStarted;
  const deltas = difference(afterRequests, before);
  return {
    name,
    requests: REQUESTS_PER_MODE,
    originConnections: deltas.originConnections,
    proxyConnections: deltas.proxyConnections,
    originRequests: deltas.originRequests,
    proxyRequests: deltas.proxyRequests,
    medianMs: rounded(percentile(latencies, 0.5)),
    p95Ms: rounded(percentile(latencies, 0.95)),
    totalDurationMs: rounded(totalDurationMs),
    cancellationMs: rounded(cancelledInMs),
    shutdownMs: rounded(shutdownMs),
  };
};

const assertMode = (result) => {
  if (result.originRequests !== REQUESTS_PER_MODE) {
    throw new Error(`${result.name}: origin request isolation mismatch`);
  }
  const proxied = result.name.includes("proxy-") && !result.name.includes("no-proxy");
  const expectedProxyRequests = proxied ? REQUESTS_PER_MODE : 0;
  if (result.proxyRequests !== expectedProxyRequests) {
    throw new Error(`${result.name}: proxy route isolation mismatch`);
  }
  const expectedOriginConnections = result.name === "current-direct-per-request-agent"
    || proxied
    ? REQUESTS_PER_MODE
    : 1;
  if (result.originConnections !== expectedOriginConnections) {
    throw new Error(`${result.name}: origin connection count mismatch`);
  }
  const expectedProxyConnections = result.name === "current-proxy-per-request-agent"
    ? REQUESTS_PER_MODE
    : result.name === "candidate-proxy-shared-agent"
      ? 1
      : 0;
  if (result.proxyConnections !== expectedProxyConnections) {
    throw new Error(`${result.name}: proxy connection count mismatch`);
  }
};

const main = async () => {
  const counters = {
    originConnections: 0,
    proxyConnections: 0,
    originRequests: 0,
    proxyRequests: 0,
  };
  const origin = createServer((incoming, response) => {
    counters.originRequests += 1;
    if (incoming.url === "/slow") {
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { connection: "close" });
          response.end("slow");
        }
      }, 250).unref?.();
      return;
    }
    response.writeHead(200, { "content-length": "2" });
    response.end("ok");
  });
  origin.on("connection", () => {
    counters.originConnections += 1;
  });

  let originPort;
  const proxy = createServer((incoming, response) => {
    counters.proxyRequests += 1;
    let target;
    try {
      target = new URL(incoming.url ?? "");
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (target.hostname !== "127.0.0.1" || Number(target.port) !== originPort) {
      response.writeHead(502);
      response.end();
      return;
    }
    const upstream = request(target, {
      method: incoming.method,
      headers: incoming.headers,
      agent: false,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => {
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
    response.once("close", () => {
      if (!response.writableEnded) {
        upstream.destroy();
      }
    });
    incoming.pipe(upstream);
  });
  proxy.on("connection", () => {
    counters.proxyConnections += 1;
  });

  try {
    originPort = await listen(origin);
    const proxyPort = await listen(proxy);
    const originUrl = `http://127.0.0.1:${originPort}/benchmark`;
    const slowUrl = `http://127.0.0.1:${originPort}/slow`;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    const definitions = [
      {
        name: "current-direct-per-request-agent",
        target: originUrl,
        slowTarget: slowUrl,
        proxyEnv: {},
        shared: false,
      },
      {
        name: "candidate-direct-shared-agent",
        target: originUrl,
        slowTarget: slowUrl,
        proxyEnv: {},
        shared: true,
      },
      {
        name: "current-proxy-per-request-agent",
        target: originUrl,
        slowTarget: slowUrl,
        proxyEnv: { HTTP_PROXY: proxyUrl },
        shared: false,
      },
      {
        name: "candidate-proxy-shared-agent",
        target: originUrl,
        slowTarget: slowUrl,
        proxyEnv: { HTTP_PROXY: proxyUrl },
        shared: true,
      },
      {
        name: "candidate-no-proxy-bypass",
        target: originUrl,
        slowTarget: slowUrl,
        proxyEnv: { HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" },
        shared: true,
      },
    ];
    const rounds = [];
    for (let round = 1; round <= INTERNAL_ROUNDS; round += 1) {
      const results = [];
      for (const definition of definitions) {
        const result = await runMode({ ...definition, counters });
        assertMode(result);
        results.push(result);
      }
      rounds.push({ round, results });
    }
    console.log(JSON.stringify({
      environment: { node: process.version, platform: `${process.platform}-${process.arch}` },
      rounds,
    }, undefined, 2));
  } finally {
    proxy.closeAllConnections?.();
    origin.closeAllConnections?.();
    await Promise.allSettled([close(proxy), close(origin)]);
  }
};

await main();
