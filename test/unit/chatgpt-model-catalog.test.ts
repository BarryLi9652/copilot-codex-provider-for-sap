import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChatGptModels } from "../../src/transports/chatgpt-oauth/model-catalog.js";

const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), "test", "fixtures", "chatgpt-models.json"),
  "utf8",
)) as unknown;

test("filters hidden models while preserving private catalog priority order", () => {
  const models = parseChatGptModels(fixture);

  assert.deepEqual(models.map((model) => model.id), ["gpt-5-codex", "gpt-4.1-codex"]);
  assert.deepEqual(models.map((model) => model.name), ["GPT-5 Codex", "GPT-4.1 Codex"]);
  assert.equal(models[0]?.family, "gpt");
  assert.equal(models[0]?.version, "codex-5-2026-08");
  assert.equal(models[0]?.maxInputTokens, 258400);
  assert.equal(models[0]?.maxOutputTokens, 128000);
});

test("derives image, tool, and parallel-call capabilities from catalog metadata", () => {
  const models = parseChatGptModels(fixture);

  assert.deepEqual(models.map((model) => model.capabilities), [
    { imageInput: true, toolCalling: true, parallelToolCalls: true },
    { imageInput: false, toolCalling: false, parallelToolCalls: false },
  ]);
});

test("uses effective-context and compaction fallbacks when private fields are absent", () => {
  const models = parseChatGptModels({
    models: [{
      slug: "fallback-codex",
      display_name: "Fallback Codex",
      description: "Fallback metadata test",
      visibility: "list",
      priority: 30,
      context_window: 1000,
      max_context_window: 1200,
      input_modalities: ["text"],
      shell_type: "shell_command",
      supports_parallel_tool_calls: false,
      supported_reasoning_levels: [],
      default_reasoning_level: "medium",
      comp_hash: "fallback",
    }],
  });

  assert.equal(models[0]?.maxInputTokens, 950);
  assert.equal(models[0]?.maxOutputTokens, 200);

  const defaultCompactionModels = parseChatGptModels({
    models: [{
      slug: "default-compaction-codex",
      display_name: "Default Compaction Codex",
      visibility: "list",
      priority: 40,
      context_window: 1000,
      input_modalities: ["text"],
      shell_type: "shell_command",
      supports_parallel_tool_calls: false,
    }],
  });

  assert.equal(defaultCompactionModels[0]?.maxInputTokens, 950);
  assert.equal(defaultCompactionModels[0]?.maxOutputTokens, 100);
});
