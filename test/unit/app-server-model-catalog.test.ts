import assert from "node:assert/strict";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import {
  parseAppServerModels,
  type AppServerModelDiagnostics,
} from "../../src/transports/app-server/model-catalog.js";

test("maps App Server models in server order with capabilities and descriptions", () => {
  const models = parseAppServerModels({
    models: [
      {
        id: "gpt-5-codex",
        displayName: "GPT-5 Codex",
        description: "A deterministic coding model",
        version: "codex-5-2026-08",
        inputTokenLimit: 258_400,
        outputTokenLimit: 128_000,
        inputModalities: ["text", "image"],
        supportsTools: true,
        supportsParallelToolCalls: true,
      },
      {
        id: "gpt-4.1-codex",
        displayName: "GPT-4.1 Codex",
        description: "A second coding model",
        version: "codex-4.1",
        inputTokenLimit: 32_000,
        outputTokenLimit: 8_000,
        inputModalities: ["text"],
        supportsTools: false,
      },
    ],
  });

  assert.deepEqual(models, [
    {
      id: "gpt-5-codex",
      name: "GPT-5 Codex",
      family: "gpt",
      version: "codex-5-2026-08",
      maxInputTokens: 258_400,
      maxOutputTokens: 128_000,
      capabilities: { imageInput: true, toolCalling: true, parallelToolCalls: true },
      description: "A deterministic coding model",
    },
    {
      id: "gpt-4.1-codex",
      name: "GPT-4.1 Codex",
      family: "gpt",
      version: "codex-4.1",
      maxInputTokens: 32_000,
      maxOutputTokens: 8_000,
      capabilities: { imageInput: false, toolCalling: false, parallelToolCalls: false },
      description: "A second coding model",
    },
  ]);
});

test("omits invalid models and records only the missing field names", () => {
  const diagnostics: AppServerModelDiagnostics[] = [];
  const models = parseAppServerModels({
    models: [
      {
        id: "missing-output",
        displayName: "Missing output limit",
        inputTokenLimit: 1_000,
        inputModalities: ["text"],
      },
      {
        id: "valid",
        displayName: "Valid",
        inputTokenLimit: 2_000,
        outputTokenLimit: 500,
        inputModalities: ["text"],
        supportsTools: true,
      },
    ],
  }, (entry) => diagnostics.push(entry));

  assert.deepEqual(models.map((model) => model.id), ["valid"]);
  assert.deepEqual(diagnostics, [{ missingFields: ["outputTokenLimit"] }]);
});

test("rejects malformed model-list envelopes as protocol errors", () => {
  assert.throws(
    () => parseAppServerModels({ models: "not-an-array" }),
    (error: unknown) => error instanceof CodexError
      && error.code === "protocol"
      && error.action === "listModels",
  );
});
