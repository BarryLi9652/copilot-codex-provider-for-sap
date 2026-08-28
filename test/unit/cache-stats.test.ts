import { test } from "node:test";
import assert from "node:assert/strict";

import { CacheStatsTracker, formatCacheRate, formatTokens } from "../../src/core/cache-stats.js";

test("tracker starts empty with undefined cache rate", () => {
  const tracker = new CacheStatsTracker("Test");
  const snapshot = tracker.snapshot();

  assert.equal(snapshot.turns, 0);
  assert.equal(snapshot.inputTokens, 0);
  assert.equal(snapshot.cachedTokens, 0);
  assert.equal(snapshot.outputTokens, 0);
  assert.equal(snapshot.cacheRate, undefined);
});

test("tracker aggregates usage records and computes cache rate", () => {
  const tracker = new CacheStatsTracker("Test");
  tracker.record({ inputTokens: 1000, cachedTokens: 800, outputTokens: 50 });
  tracker.record({ inputTokens: 2000, cachedTokens: 1000, outputTokens: 150 });

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.turns, 2);
  assert.equal(snapshot.inputTokens, 3000);
  assert.equal(snapshot.cachedTokens, 1800);
  assert.equal(snapshot.outputTokens, 200);
  assert.equal(snapshot.cacheRate, 0.6);
});

test("tracker ignores empty usage records", () => {
  const tracker = new CacheStatsTracker("Test");
  tracker.record({});
  tracker.record({ inputTokens: undefined, cachedTokens: undefined, outputTokens: undefined });

  assert.equal(tracker.snapshot().turns, 0);
});

test("tracker clamps cache rate to 1", () => {
  const tracker = new CacheStatsTracker("Test");
  tracker.record({ inputTokens: 100, cachedTokens: 150 });

  assert.equal(tracker.snapshot().cacheRate, 1);
});

test("tracker reset clears accumulated stats", () => {
  const tracker = new CacheStatsTracker("Test");
  tracker.record({ inputTokens: 100, cachedTokens: 50 });
  tracker.reset();

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.turns, 0);
  assert.equal(snapshot.inputTokens, 0);
  assert.equal(snapshot.cacheRate, undefined);
});

test("tracker tracks last-turn context usage", () => {
  const tracker = new CacheStatsTracker("Test");
  tracker.record({ inputTokens: 1000, cachedTokens: 800, outputTokens: 50 });
  tracker.record({ inputTokens: 2500, cachedTokens: 2000, outputTokens: 120 });

  const snapshot = tracker.snapshot();
  // The latest turn's input approximates the session's current context size.
  assert.equal(snapshot.lastInputTokens, 2500);
  assert.equal(snapshot.lastOutputTokens, 120);
});

test("tracker keeps previous last-turn fields when an event omits them", () => {
  const tracker = new CacheStatsTracker("Test");
  tracker.record({ inputTokens: 1000, outputTokens: 50 });
  // A follow-up event carrying only output (e.g. a zero input delta).
  tracker.record({ outputTokens: 10 });

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.lastInputTokens, 1000);
  assert.equal(snapshot.lastOutputTokens, 10);
});

test("tracker reset clears last-turn context usage", () => {
  const tracker = new CacheStatsTracker("Test");
  tracker.record({ inputTokens: 1000, outputTokens: 50 });
  tracker.reset();

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.lastInputTokens, undefined);
  assert.equal(snapshot.lastOutputTokens, undefined);
});

test("formats tokens and rates for display", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(258400), "258.4k");
  assert.equal(formatTokens(1_500_000), "1.50M");
  assert.equal(formatCacheRate(0.847), "85%");
  assert.equal(formatCacheRate(1), "100%");
});
