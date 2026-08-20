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

test("clear discards cached values and rejected in-flight refreshes", async () => {
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
