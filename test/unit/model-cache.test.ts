import assert from "node:assert/strict";
import test from "node:test";

import { ModelCache } from "../../src/core/model-cache.js";
import type { CodexModel } from "../../src/core/types.js";

const createModel = (id: string): CodexModel => ({
  id,
  name: id,
  family: "test",
  version: "1",
  maxInputTokens: 100,
  maxOutputTokens: 50,
  capabilities: {
    imageInput: false,
    toolCalling: false,
    parallelToolCalls: false,
  },
});

test("model cache shares one in-flight refresh and expires after five minutes", async () => {
  let calls = 0;
  let now = 0;
  const cache = new ModelCache(300_000, () => now);
  const load = async () => [createModel(`model-${++calls}`)];
  const [a, b] = await Promise.all([cache.get(load), cache.get(load)]);

  assert.equal(calls, 1);
  assert.equal(a[0]?.id, b[0]?.id);
  now = 300_001;
  assert.equal((await cache.get(load))[0]?.id, "model-2");
});

test("separate model caches do not share values or in-flight refreshes", async () => {
  let calls = 0;
  const load = async () => [createModel(`model-${++calls}`)];
  const first = new ModelCache(300_000);
  const second = new ModelCache(300_000);

  const [a, b] = await Promise.all([first.get(load), second.get(load)]);

  assert.equal(calls, 2);
  assert.equal(a[0]?.id, "model-1");
  assert.equal(b[0]?.id, "model-2");
});

test("clear discards populated cache data", async () => {
  let calls = 0;
  const cache = new ModelCache(300_000);
  const load = async () => [createModel(`model-${++calls}`)];

  assert.equal((await cache.get(load))[0]?.id, "model-1");
  cache.clear();

  assert.equal((await cache.get(load))[0]?.id, "model-2");
  assert.equal(calls, 2);
});

test("snapshot reports the cached model count and live age without loading", async () => {
  let now = 1_000;
  const cache = new ModelCache(300_000, () => now);

  assert.equal(cache.snapshot(), undefined);
  await cache.get(async () => [createModel("one"), createModel("two")]);
  now = 3_500;

  assert.deepEqual(cache.snapshot(), { modelCount: 2, ageMs: 2_500 });
  cache.clear();
  assert.equal(cache.snapshot(), undefined);
});

test("clear prevents a pending refresh from repopulating stale models", async () => {
  let calls = 0;
  let resolveStale!: (models: readonly CodexModel[]) => void;
  const staleRefresh = new Promise<readonly CodexModel[]>((resolve) => {
    resolveStale = resolve;
  });
  const cache = new ModelCache(300_000, () => 0);
  const pending = cache.get(async () => {
    calls += 1;
    return staleRefresh;
  });

  cache.clear();
  const fresh = await cache.get(async () => {
    calls += 1;
    return [createModel("fresh-model")];
  });

  assert.equal(fresh[0]?.id, "fresh-model");
  resolveStale([createModel("stale-model")]);
  assert.equal((await pending)[0]?.id, "stale-model");
  assert.equal(
    (await cache.get(async () => [createModel("unexpected-model")]))[0]?.id,
    "fresh-model",
  );
  assert.equal(calls, 2);
});

test("clear allows retry after a rejected refresh", async () => {
  let calls = 0;
  const cache = new ModelCache(300_000);
  const rejected = cache.get(async () => {
    calls += 1;
    throw new Error("refresh failed");
  });

  await assert.rejects(rejected, /refresh failed/);
  cache.clear();

  const models = await cache.get(async () => {
    calls += 1;
    return [createModel("fresh-model")];
  });

  assert.equal(calls, 2);
  assert.equal(models[0]?.id, "fresh-model");
});
