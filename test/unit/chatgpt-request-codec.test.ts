import { test } from "node:test";
import assert from "node:assert/strict";

import type { CodexModel, CodexRequest } from "../../src/core/types.js";
import { buildResponsesRequest, resolveChatGptRequestOverrides } from "../../src/transports/chatgpt-oauth/request-codec.js";
import { resolveModelReasoningEffort } from "../../src/core/model-effort.js";

const model: CodexModel = {
  id: "gpt-5-codex",
  name: "GPT-5 Codex",
  family: "gpt",
  version: "codex-5-2026-08",
  maxInputTokens: 258400,
  maxOutputTokens: 128000,
  capabilities: { imageInput: true, toolCalling: true, parallelToolCalls: true },
};

const request: CodexRequest = {
  requestId: "request-1",
  modelId: model.id,
  instructions: "System instruction.",
  toolMode: "required",
  tools: [{
    name: "get_abap_object_lines",
    description: "Read ABAP lines",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string" } },
      required: ["uri"],
    },
  }, {
    name: "write_abap_object",
    description: "Write ABAP lines",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string" },
        lines: { type: "array", items: { type: "string" } },
      },
      required: ["uri", "lines"],
      additionalProperties: false,
    },
  }],
  messages: [
    {
      role: "user",
      parts: [
        { kind: "text", text: "Read this object." },
        { kind: "image", mimeType: "image/png", data: new Uint8Array([0, 1, 2, 255]) },
      ],
    },
    {
      role: "assistant",
      parts: [
        { kind: "text", text: "I found the object." },
        { kind: "image", mimeType: "image/webp", data: new Uint8Array([5, 6]) },
      ],
    },
    {
      role: "assistant",
      parts: [{ kind: "tool-call", callId: "call-7", name: "get_abap_object_lines", input: {
        uri: "adt://DEV/zcl_demo",
      } }],
    },
    {
      role: "user",
      parts: [{ kind: "tool-result", callId: "call-7", content: [
        { kind: "text", text: "CLASS zcl_demo DEFINITION." },
        { kind: "image", mimeType: "image/jpeg", data: new Uint8Array([3, 4]) },
      ] }],
    },
  ],
};

test("encodes Responses flags, every tool schema, multimodal input, and exact tool IDs", () => {
  const body = buildResponsesRequest(request, model);

  assert.equal(body.model, "gpt-5-codex");
  assert.equal(body.instructions, "System instruction.");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.parallel_tool_calls, true);
  assert.equal(body.tool_choice, "required");
  assert.deepEqual(body.tools, [{
    type: "function",
    name: "get_abap_object_lines",
    description: "Read ABAP lines",
    parameters: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
    strict: false,
  }, {
    type: "function",
    name: "write_abap_object",
    description: "Write ABAP lines",
    parameters: {
      type: "object",
      properties: {
        uri: { type: "string" },
        lines: { type: "array", items: { type: "string" } },
      },
      required: ["uri", "lines"],
      additionalProperties: false,
    },
    strict: false,
  }]);

  assert.deepEqual(body.input, [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Read this object." },
        { type: "input_image", image_url: "data:image/png;base64,AAEC/w==" },
      ],
    },
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "I found the object." },
        { type: "input_image", image_url: "data:image/webp;base64,BQY=" },
      ],
    },
    {
      type: "function_call",
      call_id: "call-7",
      name: "get_abap_object_lines",
      arguments: "{\"uri\":\"adt://DEV/zcl_demo\"}",
    },
    {
      type: "function_call_output",
      call_id: "call-7",
      output: [
        { type: "input_text", text: "CLASS zcl_demo DEFINITION." },
        { type: "input_image", image_url: "data:image/jpeg;base64,AwQ=" },
      ],
    },
  ]);
});

test("uses automatic tool choice and disables parallel calls from model capabilities", () => {
  const body = buildResponsesRequest({ ...request, toolMode: "auto" }, {
    ...model,
    capabilities: { imageInput: true, toolCalling: true, parallelToolCalls: false },
  });

  assert.equal(body.tool_choice, "auto");
  assert.equal(body.parallel_tool_calls, false);
});

test("maps the Fast setting to the ChatGPT priority service tier", () => {
  const body = buildResponsesRequest(
    request,
    model,
    resolveChatGptRequestOverrides("high", "fast"),
  );

  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.equal(body.service_tier, "priority");
});

test("omits reasoning and service tier when no override is configured", () => {
  const body = buildResponsesRequest(request, model);

  assert.equal("reasoning" in body, false);
  assert.equal("service_tier" in body, false);
});

test("resolves explicit ChatGPT settings without changing model defaults", () => {
  assert.deepEqual(resolveChatGptRequestOverrides("max", "fast"), {
    reasoningEffort: "max",
    serviceTier: "priority",
  });
  assert.deepEqual(resolveChatGptRequestOverrides("modelDefault", "modelDefault"), {});
  assert.deepEqual(resolveChatGptRequestOverrides(undefined, undefined), {});
});

test("ignores malformed ChatGPT request override settings", () => {
  assert.deepEqual(resolveChatGptRequestOverrides("turbo", "ultrafast"), {});
  assert.deepEqual(resolveChatGptRequestOverrides(42, true), {});
});

test("resolves per-model reasoning effort overrides by model-id segment", () => {
  assert.equal(resolveModelReasoningEffort("gpt-5.6-luna"), "max");
  assert.equal(resolveModelReasoningEffort("gpt-5.6-terra"), "max");
  assert.equal(resolveModelReasoningEffort("gpt-5.6-sol"), "high");
  assert.equal(resolveModelReasoningEffort("gpt-5-codex"), undefined);
  assert.equal(resolveModelReasoningEffort(""), undefined);
  assert.equal(resolveModelReasoningEffort(undefined), undefined);
});

test("per-model effort wins over the global reasoning effort setting", () => {
  const sol = buildResponsesRequest(
    request,
    { ...model, id: "gpt-5.6-sol" },
    resolveChatGptRequestOverrides("low", "modelDefault"),
  );
  assert.deepEqual(sol.reasoning, { effort: "high", summary: "auto" });

  const other = buildResponsesRequest(
    request,
    { ...model, id: "gpt-5-codex" },
    resolveChatGptRequestOverrides("low", "modelDefault"),
  );
  assert.deepEqual(other.reasoning, { effort: "low", summary: "auto" });
});

test("request-scoped effort from the Copilot picker wins over per-model and global settings", () => {
  const body = buildResponsesRequest(
    { ...request, reasoningEffort: "xhigh" },
    { ...model, id: "gpt-5.6-sol" },
    resolveChatGptRequestOverrides("low", "modelDefault"),
  );
  assert.deepEqual(body.reasoning, { effort: "xhigh", summary: "auto" });
});

test("requests reasoning summary and encrypted reasoning replay (opencode parity)", () => {
  const body = buildResponsesRequest(request, model);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
});
