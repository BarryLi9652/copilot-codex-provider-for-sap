# Task 6 implementation report

Date: 2026-08-21
Worktree: D:/WANG, LEON BINYU/CodexProjects/copilot-codex-provider-for-sap/.worktrees/v1
Baseline: f0c8184 (OAuth boundary)
Branch: feat/v1

## Scope

Implemented only the pure Task 6 catalog, request codec, SSE parser, tests, and fixtures:

- src/transports/chatgpt-oauth/model-catalog.ts
- src/transports/chatgpt-oauth/request-codec.ts
- src/transports/chatgpt-oauth/sse-parser.ts
- test/fixtures/chatgpt-models.json
- test/unit/chatgpt-model-catalog.test.ts
- test/unit/chatgpt-request-codec.test.ts
- test/unit/sse-parser.test.ts

No live backend calls, endpoint changes, private HTTP transport, provider wiring, or runtime dependency additions were made.

## Exact model fixture

~~~~json
{
  "models": [
    {
      "slug": "gpt-5-codex",
      "display_name": "GPT-5 Codex",
      "description": "A coding model with image input and parallel tools.",
      "visibility": "list",
      "priority": 10,
      "context_window": 272000,
      "max_context_window": 400000,
      "effective_context_window_percent": 95,
      "auto_compact_token_limit": 240000,
      "input_modalities": ["text", "image"],
      "shell_type": "shell_command",
      "supports_parallel_tool_calls": true,
      "supported_reasoning_levels": ["low", "medium", "high"],
      "default_reasoning_level": "medium",
      "comp_hash": "codex-5-2026-08"
    },
    {
      "slug": "gpt-4.1-codex",
      "display_name": "GPT-4.1 Codex",
      "description": "A text-only compatibility model.",
      "visibility": "list",
      "priority": 20,
      "context_window": 128000,
      "max_context_window": 128000,
      "effective_context_window_percent": 90,
      "auto_compact_token_limit": 100000,
      "input_modalities": ["text"],
      "shell_type": "disabled",
      "supports_parallel_tool_calls": true,
      "supported_reasoning_levels": ["medium"],
      "default_reasoning_level": "medium",
      "comp_hash": "codex-4.1-2026-08"
    },
    {
      "slug": "gpt-hidden-codex",
      "display_name": "Hidden Codex",
      "description": "Must not appear in the provider catalog.",
      "visibility": "hide",
      "priority": 1,
      "context_window": 128000,
      "max_context_window": 128000,
      "effective_context_window_percent": 95,
      "auto_compact_token_limit": 100000,
      "input_modalities": ["text", "image"],
      "shell_type": "shell_command",
      "supports_parallel_tool_calls": true,
      "supported_reasoning_levels": ["high"],
      "default_reasoning_level": "high",
      "comp_hash": "hidden-2026-08"
    }
  ]
}
~~~~

The catalog test also uses exact fallback entries with context_window 1000, max_context_window 1200, and a missing effective/compaction field, plus a context_window-only entry. Expected normalized limits are respectively 950/200 and 950/100.

## Exact request fixture

The request test uses:

- model: gpt-5-codex
- tool: get_abap_object_lines
- description: Read ABAP lines
- schema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] }
- user text: Read this object.
- user image bytes: [0, 1, 2, 255], MIME image/png
- assistant call ID: call-7
- assistant tool input: { uri: "adt://DEV/zcl_demo" }
- tool result call ID: call-7
- tool result text: CLASS zcl_demo DEFINITION.
- tool result image bytes: [3, 4], MIME image/jpeg

The exact expected Responses fragments are:

~~~~json
{
  "store": false,
  "stream": true,
  "parallel_tool_calls": true,
  "tool_choice": "required",
  "tools": [
    {
      "type": "function",
      "name": "get_abap_object_lines",
      "description": "Read ABAP lines",
      "parameters": {
        "type": "object",
        "properties": { "uri": { "type": "string" } },
        "required": ["uri"]
      },
      "strict": false
    }
  ],
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Read this object." },
        { "type": "input_image", "image_url": "data:image/png;base64,AAEC/w==" }
      ]
    },
    {
      "type": "function_call",
      "call_id": "call-7",
      "name": "get_abap_object_lines",
      "arguments": "{\"uri\":\"adt://DEV/zcl_demo\"}"
    },
    {
      "type": "function_call_output",
      "call_id": "call-7",
      "output": [
        { "type": "input_text", "text": "CLASS zcl_demo DEFINITION." },
        { "type": "input_image", "image_url": "data:image/jpeg;base64,AwQ=" }
      ]
    }
  ]
}
~~~~

Automatic mode is separately asserted to produce tool_choice "auto" and to follow the model's parallel_tool_calls capability.

## Exact SSE fixtures

The primary stream combines CRLF and LF framing, arbitrary UTF-8 byte splits, text, and a function call:

~~~~ts
[
  "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}\r\n\r\n",
  "event: response.function_call_arguments.delta\n",
  "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"item-7\",\"call_id\":\"call-7\",\"delta\":\"{\\\"uri\\\":\"adt://DEV/\"}\"}\n\n",
  "event: response.output_item.done\n",
  "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"item-7\",\"type\":\"function_call\",\"call_id\":\"call-7\",\"name\":\"get_abap_object_lines\",\"arguments\":\"{\\\"uri\\\":\\\"adt://DEV/\\\"}\"}}\n\n"
].join("")
~~~~

Additional exact cases cover:

- a terminal function item omitting call_id while the delta supplied call-8;
- multiline data assembled from data: { and data: "type":"response.completed"};
- data: [DONE] after response.completed;
- unknown keepalive and unknown response events;
- malformed JSON, error, and response.failed events.

## Implementation summary

- Model catalog accepts either an array or an object with models, filters visibility !== "list", sorts by priority, maps family/version, derives image support from input_modalities, and enables tools only when shell_type is present and not "disabled".
- Effective input tokens are floor(context_window * effective_context_window_percent / 100), with a 95% default and a minimum of one.
- Automatic compaction is capped at floor(context_window * 0.9), with 90% used when auto_compact_token_limit is absent.
- Output tokens use the available total-window headroom (max_context_window - context_window) when the catalog exposes a larger maximum; otherwise they use the context window minus the capped compaction threshold, with a minimum of one.
- Request encoding preserves text, image bytes, tool-call names/inputs, tool-result content, exact call IDs, every tool schema, and model parallel-call capability. Images are emitted as data URLs. No hosted web/image tools are added.
- SSE parsing uses incremental TextDecoder state, handles UTF-8 splits, LF/CRLF/CR blank-event framing, multiline data, [DONE], text deltas, function argument deltas, completed output items, usage, completion, errors, and failures.
- Function arguments are buffered by item/call identity and emitted only after valid JSON parsing. Unknown/malformed/failed events produce no user content.
- Diagnostics receive only safe event metadata (event type); model, prompt, tool input/output, and remote payload content are not logged.

## TDD RED/GREEN record

RED command:

~~~~powershell
npm run compile && node --test out/test/unit/chatgpt-model-catalog.test.js out/test/unit/chatgpt-request-codec.test.js out/test/unit/sse-parser.test.js
~~~~

The initial focused run exited 1 because the three new production modules did not exist yet (with dependent missing-import diagnostics). No implementation was used to satisfy the tests.

GREEN focused command:

~~~~powershell
npm run compile && node --test out/test/unit/chatgpt-model-catalog.test.js out/test/unit/chatgpt-request-codec.test.js out/test/unit/sse-parser.test.js
~~~~

Result: 10 passed, 0 failed.

A later RED/GREEN edge-case cycle added buffered call identity fallback and the diagnostics-content assertion; both are green in the final result.

## Verification results

- npm run typecheck: PASS
- npm run test:unit: PASS, 47 passed, 0 failed
- npm test: PASS, 47 unit tests and 4 integration tests passed
- git diff --check: PASS before report/commit
- No live backend calls were made.

## Self-review

- Scope is limited to Task 6 files and this report.
- Strict TypeScript compilation passes.
- No external runtime package or provider wiring was introduced.
- Tool schemas are preserved without narrowing or replacement.
- Tool call IDs and serialized inputs/results remain stable.
- Image MIME types and bytes are preserved through base64 data URLs.
- Incremental UTF-8/SSE framing and malformed-event behavior are covered.
- Logger calls expose only event names/types; content-safe diagnostics are asserted.
- Endpoints, private transport, and extension/provider files remain unchanged.
- No subagents or project-external changes were used.

## Concerns

The catalog and SSE formats are private upstream protocols and may change; Task 7 still needs to connect these pure pieces to authenticated HTTP transport. Those integration concerns are intentionally outside Task 6.
