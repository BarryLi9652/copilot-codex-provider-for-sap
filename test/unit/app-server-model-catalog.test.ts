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

test("maps the current App Server model shape with safe Copilot defaults", () => {
  const models = parseAppServerModels(
    {
      data: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "A current App Server model",
          hidden: false,
          supportedReasoningEfforts: [
            {
              reasoningEffort: "low",
              description: "Fast responses with lighter reasoning",
            },
          ],
          defaultReasoningEffort: "low",
          inputModalities: ["text", "image"],
          supportsPersonality: true,
          isDefault: true,
        },
      ],
      nextCursor: null,
    },
    { dynamicToolsAvailable: true },
  );

  assert.deepEqual(models, [
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      family: "gpt",
      version: "gpt-5.6-sol",
      maxInputTokens: 128_000,
      maxOutputTokens: 16_000,
      capabilities: {
        imageInput: true,
        toolCalling: true,
        parallelToolCalls: false,
      },
      description: "A current App Server model",
    },
  ]);
});

test("defaults missing legacy input modalities to image support", () => {
  const models = parseAppServerModels({
    data: [
      {
        id: "legacy-codex",
        model: "legacy-codex",
        displayName: "Legacy Codex",
        hidden: false,
      },
    ],
  });

  assert.equal(models[0]?.capabilities.imageInput, true);
});

test("does not advertise tool calling without a successful dynamic-tools probe", () => {
  const models = parseAppServerModels(
    {
      data: [
        {
          id: "unprobed-codex",
          model: "unprobed-codex",
          displayName: "Unprobed Codex",
          hidden: false,
        },
      ],
    },
    { dynamicToolsAvailable: false },
  );

  assert.equal(models[0]?.capabilities.toolCalling, false);
});

test("does not advertise tool calling for malformed explicit tool metadata", () => {
  const models = parseAppServerModels(
    {
      data: [
        {
          id: "malformed-tools-codex",
          model: "malformed-tools-codex",
          displayName: "Malformed Tools Codex",
          hidden: false,
          supportsTools: "yes",
        },
      ],
    },
    { dynamicToolsAvailable: true },
  );

  assert.equal(models[0]?.capabilities.toolCalling, false);
});

test("omits invalid models and records only the missing field names", () => {
  const diagnostics: AppServerModelDiagnostics[] = [];
  const models = parseAppServerModels(
    {
      models: [
        {
          id: "missing-output",
          displayName: "Missing output limit",
          inputTokenLimit: 1_000,
          outputTokenLimit: "invalid",
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
    },
    { dynamicToolsAvailable: false },
    (entry) => diagnostics.push(entry),
  );

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
