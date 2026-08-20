# Copilot Codex Provider for SAP V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个可安装的 VS Code 扩展，在 Copilot 模型选择器中提供独立的 ChatGPT OAuth/Codex 私有后端与本机 Codex App Server 两条模型路线，并保持 ABAP FS 工具和 SAP ADT 虚拟工作区上下文可用。

**Architecture:** 一个扩展注册两个 `LanguageModelChatProvider`，共享标准消息、模型、事件、工具和错误类型；OAuth 与 App Server 分别实现 `CodexTransport`。Copilot/VS Code 始终拥有工具审批与执行权，Local CLI 通过 App Server `dynamicTools` 的暂停/续接状态机把工具调用交回 Copilot。

**Tech Stack:** TypeScript 6、VS Code Extension API `^1.125.0`、Node.js 内置 `fetch`/`crypto`/`http`/`child_process`/`node:test`、`@vscode/test-electron`、`@vscode/vsce`、npm。

**Spec:** `docs/superpowers/specs/2026-08-20-copilot-codex-provider-for-sap-design.md`

## Global Constraints

- 只能修改 `D:\WANG, LEON BINYU\CodexProjects\copilot-codex-provider-for-sap`。
- 不实现 OpenAI 官方 API、API Key 或 OpenAI/Agents SDK 路线。
- 最低 VS Code engine 为 `^1.125.0`；仅使用稳定 VS Code API。
- TypeScript 开启 strict mode；运行时代码不依赖第三方包。
- 两个 Provider 必须独立显示、独立认证、独立缓存、独立故障，不允许静默回退。
- App Server 必须使用 `approvalPolicy: "never"`、`sandbox: "read-only"`，并通过 thread config 关闭 shell、unified exec、web、apps、plugins、multi-agent、computer 和 browser 能力。
- 工具由 Copilot/VS Code 审批和执行；扩展不得自行调用 ABAP FS 工具或写入 SAP。
- 不连接 SAP ADT MCP Server，不导入 ABAP FS/SAP ADT 内部模块。
- OAuth token 仅保存到 VS Code `SecretStorage`；不得读取或修改 `~/.codex/auth.json`。
- 默认不记录 token、Cookie、提示词、模型正文、ABAP 源码、工具参数、工具结果或敏感 SAP URI。
- npm cache 使用项目内 `.npm-cache`，VS Code 测试运行时使用项目内 `.vscode-test`。
- 如使用子代理，只允许 `gpt-5.6-luna`、`max` 推理、fast/priority 服务配置。

---

## File Map

```text
.editorconfig                         text formatting
.gitignore                            project-local caches/build outputs
.npmrc                                project-local npm cache
.vscodeignore                         VSIX inclusion rules
package.json                          extension manifest, commands, settings, scripts
tsconfig.json                         strict TypeScript build
src/extension.ts                      composition root and lifecycle
src/constants.ts                      vendor/command/config/extension IDs
src/core/types.ts                     normalized domain and CodexTransport contract
src/core/errors.ts                    typed failures and user actions
src/core/cancellation.ts              CancellationToken -> AbortSignal bridge
src/core/model-cache.ts               five-minute isolated model cache
src/core/empty-transport.ts           unavailable-route behavior during composition
src/security/redact.ts                recursive metadata redaction
src/security/logger.ts                metadata-only output channel logger
src/providers/message-adapter.ts      VS Code request -> normalized request
src/providers/response-adapter.ts     normalized events -> VS Code response parts
src/providers/codex-provider.ts       generic LanguageModelChatProvider
src/providers/token-count.ts          deterministic token estimate
src/transports/chatgpt-oauth/profile.ts          versioned private protocol profile
src/transports/chatgpt-oauth/oauth-store.ts      SecretStorage-backed session store
src/transports/chatgpt-oauth/pkce.ts             PKCE/state/JWT claim helpers
src/transports/chatgpt-oauth/loopback-server.ts  localhost callback lifecycle
src/transports/chatgpt-oauth/oauth-manager.ts    sign-in, refresh, sign-out
src/transports/chatgpt-oauth/model-catalog.ts    private model normalization
src/transports/chatgpt-oauth/request-codec.ts    normalized request -> private Responses body
src/transports/chatgpt-oauth/sse-parser.ts       incremental SSE parser
src/transports/chatgpt-oauth/http-client.ts      authenticated HTTP and one 401 retry
src/transports/chatgpt-oauth/oauth-transport.ts  CodexTransport implementation
src/transports/app-server/protocol.ts            minimal guarded JSONL RPC protocol
src/transports/app-server/jsonl-rpc-client.ts    bidirectional request/response client
src/transports/app-server/executable-locator.ts  configured/PATH/Windows alias lookup
src/transports/app-server/process-supervisor.ts  child lifecycle and restart breaker
src/transports/app-server/safety-profile.ts      no-native-tools thread overrides
src/transports/app-server/model-catalog.ts       model/list normalization
src/transports/app-server/transcript.ts          Copilot history -> one turn input
src/transports/app-server/tool-continuations.ts  pending callId state machine
src/transports/app-server/app-server-transport.ts CodexTransport implementation
src/sap/context.ts                    safe active editor/diagnostic context
src/sap/instructions.ts               concise ABAP tool-use guidance
src/commands/register-commands.ts     management commands
src/commands/diagnostics.ts           redacted diagnostic report
test/unit/**                          pure node:test suites
test/integration/**                   fake HTTP/App Server contract suites
test/extension/run-test.ts            @vscode/test-electron launcher
test/extension/suite/index.ts         extension test entry
test/extension/suite/provider.test.ts Provider and tool round-trip tests
test/extension/suite/sap.test.ts      adt://, dirty document, selection, diagnostics
test/fixtures/**                      protocol fixtures without real credentials/code
scripts/fake-app-server.mjs           deterministic JSONL child process
README.md                             installation, use, warnings
SECURITY.md                           credential and SAP data boundaries
CHANGELOG.md                          V1 release notes
docs/testing.md                       automated/manual verification matrix
```

### Task 1: Scaffold the extension and register two empty providers

**Files:**
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `.npmrc`
- Create: `.vscodeignore`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/constants.ts`
- Create: `src/extension.ts`
- Create: `src/providers/unavailable-provider.ts`
- Test: `test/unit/manifest.test.ts`

**Interfaces:**
- Produces: `CHATGPT_VENDOR_ID = "copilot-codex.chatgpt-oauth"`
- Produces: `LOCAL_VENDOR_ID = "copilot-codex.local-cli"`
- Produces: `UnavailableProvider implements vscode.LanguageModelChatProvider`

- [ ] **Step 1: Create the project-local toolchain files without provider contributions**

Use `name: "copilot-codex-provider-for-sap"`, `displayName: "Copilot Codex Provider for SAP"`, `description: "Use Codex through ChatGPT OAuth or a local Codex App Server in GitHub Copilot Chat, with SAP ABAP tooling support."`, `version: "0.1.0"`, `publisher: "leonbwang"`, `private: true`, `license: "UNLICENSED"`, `main: "./out/src/extension.js"`, `engines.vscode: "^1.125.0"`, categories `AI`, `Chat`, and `Machine Learning`, and these scripts:

```json
{
  "scripts": {
    "clean": "node -e \"require('node:fs').rmSync('out',{recursive:true,force:true})\"",
    "compile": "npm run clean && tsc -p .",
    "typecheck": "tsc -p . --noEmit",
    "test:unit": "npm run compile && node --test \"out/test/unit/**/*.test.js\"",
    "test:integration": "npm run compile && node --test \"out/test/integration/**/*.test.js\"",
    "test:extension": "npm run compile && node out/test/extension/run-test.js",
    "test": "npm run test:unit && npm run test:integration",
    "check": "npm run typecheck && npm test",
    "package": "npm run check && npm run test:extension && vsce package --no-dependencies --out dist/copilot-codex-provider-for-sap-0.1.0.vsix",
    "vscode:prepublish": "npm run compile"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/vscode": "^1.125.0",
    "@vscode/test-electron": "^2.5.2",
    "@vscode/vsce": "^3.9.2",
    "typescript": "^6.0.3"
  }
}
```

Set `.npmrc` to `cache=.npm-cache` and `update-notifier=false`. Ignore `.npm-cache/`, `.vscode-test/`, `node_modules/`, `out/`, `dist/`, and `*.vsix`.

- [ ] **Step 2: Install dependencies inside the project**

Run:

```powershell
npm install
```

Expected: `package-lock.json` and `node_modules/` are created; npm cache files appear only under `.npm-cache/`.

- [ ] **Step 3: Write the failing manifest contract test**

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest contributes two independent Codex providers", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.deepEqual(
    manifest.contributes.languageModelChatProviders.map((entry: { vendor: string }) => entry.vendor),
    ["copilot-codex.chatgpt-oauth", "copilot-codex.local-cli"],
  );
});
```

- [ ] **Step 4: Run the test and verify the missing contribution failure**

Run: `npm run test:unit`

Expected: FAIL because `contributes.languageModelChatProviders` is absent.

- [ ] **Step 5: Add both contributions, activation events, constants, and an empty provider**

Manifest entries:

```json
"activationEvents": [
  "onLanguageModelChatProvider:copilot-codex.chatgpt-oauth",
  "onLanguageModelChatProvider:copilot-codex.local-cli"
],
"contributes": {
  "languageModelChatProviders": [
    { "vendor": "copilot-codex.chatgpt-oauth", "displayName": "Codex · ChatGPT OAuth" },
    { "vendor": "copilot-codex.local-cli", "displayName": "Codex · Local CLI" }
  ]
}
```

`UnavailableProvider` returns `[]` from model discovery, throws a supplied user-facing error from chat, and estimates `Math.ceil(textLength / 4)` tokens. Register two instances in `activate()` and push both disposables to `context.subscriptions`.

- [ ] **Step 6: Verify scaffold and commit**

Run: `npm run typecheck && npm run test:unit`

Expected: PASS.

```powershell
git add .editorconfig .gitignore .npmrc .vscodeignore package.json package-lock.json tsconfig.json src test/unit/manifest.test.ts
git commit -m "chore: scaffold dual Codex provider extension"
```

### Task 2: Define the shared transport domain, errors, cancellation, and model cache

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/errors.ts`
- Create: `src/core/cancellation.ts`
- Create: `src/core/model-cache.ts`
- Create: `src/core/empty-transport.ts`
- Test: `test/unit/core-types.test.ts`
- Test: `test/unit/model-cache.test.ts`

**Interfaces:**
- Produces: `CodexTransport.listModels(options, signal): Promise<readonly CodexModel[]>`
- Produces: `CodexTransport.generate(request, signal): AsyncIterable<TransportEvent>`
- Produces: `CodexTransport.dispose(): Promise<void>`
- Produces: `CodexError`, `CodexErrorCode`, `ModelCache`

- [ ] **Step 1: Define failing transport-event and isolated-cache checks**

```ts
test("model cache shares one in-flight refresh and expires after five minutes", async () => {
  let calls = 0;
  let now = 0;
  const cache = new ModelCache(300_000, () => now);
  const load = async () => [{ id: `model-${++calls}` }] as CodexModel[];
  const [a, b] = await Promise.all([cache.get(load), cache.get(load)]);
  assert.equal(calls, 1);
  assert.equal(a[0].id, b[0].id);
  now = 300_001;
  assert.equal((await cache.get(load))[0].id, "model-2");
});
```

Also assert that `CodexError` preserves `code`, `action`, `retryAfterMs`, and `cause` without serializing request content.

- [ ] **Step 2: Run the focused tests and verify missing exports**

Run: `npm run compile && node --test out/test/unit/core-types.test.js out/test/unit/model-cache.test.js`

Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Implement the exact normalized contracts**

```ts
export type JsonObject = Readonly<Record<string, unknown>>;
export type ToolResultPart =
  | { kind: "text"; text: string }
  | { kind: "image"; mimeType: string; data: Uint8Array };

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; mimeType: string; data: Uint8Array }
  | { kind: "tool-call"; callId: string; name: string; input: unknown }
  | { kind: "tool-result"; callId: string; content: readonly ToolResultPart[] };

export interface CodexMessage {
  role: "user" | "assistant";
  name?: string;
  parts: readonly MessagePart[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface CodexModel {
  id: string;
  name: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: { imageInput: boolean; toolCalling: boolean; parallelToolCalls: boolean };
}

export interface CodexRequest {
  requestId: string;
  modelId: string;
  messages: readonly CodexMessage[];
  tools: readonly ToolSpec[];
  toolMode: "auto" | "required";
  instructions: string;
}

export type TransportEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "completed" };

export interface CodexTransport {
  listModels(options: { silent: boolean; forceRefresh?: boolean }, signal: AbortSignal): Promise<readonly CodexModel[]>;
  generate(request: CodexRequest, signal: AbortSignal): AsyncIterable<TransportEvent>;
  dispose(): Promise<void>;
}
```

Use explicit error codes: `authRequired`, `unauthorized`, `rateLimited`, `network`, `timeout`, `cancelled`, `protocol`, `process`, `incompatible`, `toolContinuation`, and `sapContext`.

- [ ] **Step 4: Implement cancellation and cache behavior**

`toAbortSignal(token)` must abort immediately if already cancelled and return `{ signal, dispose }`. `ModelCache.clear()` must discard both cached values and a rejected in-flight promise. `EmptyTransport` returns no models and throws its configured `CodexError` from `generate()`; it performs no fallback.

- [ ] **Step 5: Run tests and commit**

Run: `npm run typecheck && npm run test:unit`

Expected: PASS.

```powershell
git add src/core test/unit/core-types.test.ts test/unit/model-cache.test.ts
git commit -m "feat: define shared Codex transport domain"
```

### Task 3: Add metadata-only redacted diagnostics

**Files:**
- Create: `src/security/redact.ts`
- Create: `src/security/logger.ts`
- Test: `test/unit/redact.test.ts`

**Interfaces:**
- Produces: `redactMetadata(value: unknown): unknown`
- Produces: `SafeLogger.event(name: string, metadata: Record<string, unknown>): void`
- Consumes: `CodexError`

- [ ] **Step 1: Write failing redaction tests**

```ts
test("redacts credentials, content, tool payloads, and SAP query strings", () => {
  const redacted = redactMetadata({
    Authorization: "Bearer secret",
    refreshToken: "refresh-secret",
    prompt: "private ABAP source",
    toolResult: { source: "REPORT z_private." },
    uri: "adt://DEV/object?password=secret&client=100",
    status: 429,
  });
  assert.deepEqual(redacted, {
    Authorization: "[REDACTED]",
    refreshToken: "[REDACTED]",
    prompt: "[REDACTED]",
    toolResult: "[REDACTED]",
    uri: "adt://DEV/object",
    status: 429,
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm run compile && node --test out/test/unit/redact.test.js`

Expected: FAIL because `redactMetadata` is missing.

- [ ] **Step 3: Implement recursive allow-by-default metadata redaction**

Use a case-insensitive sensitive-key set containing `authorization`, `cookie`, `token`, `secret`, `password`, `prompt`, `message`, `content`, `source`, `arguments`, `input`, `output`, `toolResult`, and `tool_result`. Keep scalar operational fields such as `status`, `durationMs`, `provider`, `method`, `event`, `requestId`, and `exitCode`. Strip URI query and fragment.

- [ ] **Step 4: Implement `SafeLogger` with an injected output sink**

```ts
export type LogLevel = "error" | "warn" | "info" | "debug";
export interface LogSink { appendLine(value: string): void; }

export class SafeLogger {
  constructor(private readonly sink: LogSink, private readonly level: () => LogLevel) {}
  event(name: string, metadata: Record<string, unknown> = {}): void {
    this.sink.appendLine(JSON.stringify({ time: new Date().toISOString(), event: name, ...redactMetadata(metadata) }));
  }
}
```

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run test:unit`

Expected: PASS and no test output contains the fixture secrets.

```powershell
git add src/security test/unit/redact.test.ts
git commit -m "feat: add redacted provider diagnostics"
```

### Task 4: Implement the generic VS Code provider and adapters

**Files:**
- Delete: `src/providers/unavailable-provider.ts`
- Create: `src/providers/message-adapter.ts`
- Create: `src/providers/response-adapter.ts`
- Create: `src/providers/token-count.ts`
- Create: `src/providers/codex-provider.ts`
- Create: `test/extension/run-test.ts`
- Create: `test/extension/suite/index.ts`
- Create: `test/extension/suite/provider.test.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `CodexLanguageModelProvider implements vscode.LanguageModelChatProvider`
- Produces: `toCodexRequest(...)`
- Produces: `reportTransportEvent(...)`
- Consumes: `CodexTransport`, `CodexModel`, `TransportEvent`

- [ ] **Step 1: Add the extension-test launcher and failing fake-transport test**

Set `cachePath` to `path.join(projectRoot, ".vscode-test")`. In the suite, instantiate `CodexLanguageModelProvider` with a fake transport that returns one model and events:

```ts
async function* generate(): AsyncIterable<TransportEvent> {
  yield { type: "text-delta", text: "hello" };
  yield { type: "tool-call", callId: "call-1", name: "get_abap_object_lines", input: { uri: "adt://DEV/zcl_demo" } };
  yield { type: "completed" };
}
```

Assert the progress sink receives `LanguageModelTextPart("hello")` followed by a `LanguageModelToolCallPart` with the same call ID, name, and input.

- [ ] **Step 2: Run the extension test and verify missing provider failure**

Run: `npm run test:extension`

Expected: FAIL because `CodexLanguageModelProvider` does not exist.

- [ ] **Step 3: Implement message conversion**

Handle only stable parts:

```ts
if (part instanceof vscode.LanguageModelTextPart) { /* text */ }
else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) { /* image */ }
else if (part instanceof vscode.LanguageModelToolCallPart) { /* tool-call */ }
else if (part instanceof vscode.LanguageModelToolResultPart) { /* tool-result */ }
```

Do not use `LanguageModelThinkingPart` or other proposed API. Convert `options.tools` into `ToolSpec[]`, preserving `name`, `description`, and object input schema. Map `LanguageModelChatToolMode.Required` to `required`; otherwise use `auto`.

- [ ] **Step 4: Implement provider discovery, response streaming, and token counting**

`provideLanguageModelChatInformation` maps each `CodexModel` exactly to `LanguageModelChatInformation`. `provideLanguageModelChatResponse` creates one request ID, bridges cancellation, iterates transport events, and reports only text/tool-call parts. `provideTokenCount` counts UTF-16 text plus serialized tool metadata and returns `Math.ceil(chars / 4)` with a minimum of one.

- [ ] **Step 5: Replace bootstrap registration with injected providers**

In this task, inject a separate `EmptyTransport` into each Provider. Task 7 replaces only the ChatGPT instance with `ChatGptOAuthTransport`; Task 10 replaces only the Local instance with `AppServerTransport`. Keep two distinct instances and vendor IDs throughout.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run test:unit && npm run test:extension`

Expected: all tests PASS.

```powershell
git add package.json package-lock.json src/providers src/extension.ts test/extension
git rm src/providers/unavailable-provider.ts
git commit -m "feat: add generic VS Code language model provider"
```

### Task 5: Implement independent ChatGPT OAuth PKCE storage and login

**Files:**
- Create: `src/transports/chatgpt-oauth/profile.ts`
- Create: `src/transports/chatgpt-oauth/oauth-store.ts`
- Create: `src/transports/chatgpt-oauth/pkce.ts`
- Create: `src/transports/chatgpt-oauth/loopback-server.ts`
- Create: `src/transports/chatgpt-oauth/oauth-manager.ts`
- Test: `test/unit/pkce.test.ts`
- Test: `test/unit/oauth-manager.test.ts`
- Test: `test/integration/loopback-server.test.ts`

**Interfaces:**
- Produces: `OAuthManager.signIn(openExternal): Promise<OAuthSession>`
- Produces: `OAuthManager.completeManualCallback(url): Promise<OAuthSession>`
- Produces: `OAuthManager.getAccessToken(forceRefresh?): Promise<OAuthCredentials>`
- Produces: `OAuthManager.signOut(): Promise<void>`

- [ ] **Step 1: Define the versioned OAuth/private profile**

```ts
export const CHATGPT_CODEX_PROFILE = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  callbackPorts: [1455, 1457] as const,
  callbackPath: "/auth/callback",
  scope: "openid email profile offline_access",
  originator: "copilot-codex-provider-for-sap",
  modelsClientVersion: "0.146.0",
  modelsUrl: "https://chatgpt.com/backend-api/codex/models",
  responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
} as const;
```

Keep all private assumptions in this file.

- [ ] **Step 2: Write failing PKCE, state, session validation, and refresh-singleflight tests**

Assert verifier/challenge are base64url, callback state mismatch rejects before token exchange, malformed stored JSON is ignored, expiry within 60 seconds refreshes, and two simultaneous refresh calls make one token request.

- [ ] **Step 3: Run focused tests and verify failures**

Run: `npm run compile && node --test out/test/unit/pkce.test.js out/test/unit/oauth-manager.test.js`

Expected: FAIL because OAuth modules are absent.

- [ ] **Step 4: Implement SecretStorage abstraction and PKCE helpers**

```ts
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface OAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
}

export interface OAuthCredentials {
  token: string;
  accountId?: string;
}
```

Use secret key `copilotCodex.chatgptOAuth.v1`. Decode JWT only for optional account/email metadata; never treat unverified claims as authorization decisions.

- [ ] **Step 5: Implement loopback login with manual fallback**

Bind only `127.0.0.1`, try port 1455 then 1457, accept only `GET /auth/callback`, return escaped static HTML, and close on success, error, cancel, or 300-second timeout. Preserve the active `{ state, verifier, redirectUri }` so `completeManualCallback()` validates the same state.

- [ ] **Step 6: Implement code exchange, refresh, and one-session lifecycle**

POST URL-encoded `authorization_code` or `refresh_token` requests. Require non-empty access and refresh tokens, preserve the previous refresh token if the refresh response omits it, and clear stored credentials on `invalid_grant`.

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck && npm run test:unit && npm run test:integration`

Expected: PASS; tests use fake SecretStore/fetch and never open a real browser.

```powershell
git add src/transports/chatgpt-oauth test/unit/pkce.test.ts test/unit/oauth-manager.test.ts test/integration/loopback-server.test.ts
git commit -m "feat: add isolated ChatGPT OAuth flow"
```

### Task 6: Implement the private model catalog, request codec, and SSE parser

**Files:**
- Create: `src/transports/chatgpt-oauth/model-catalog.ts`
- Create: `src/transports/chatgpt-oauth/request-codec.ts`
- Create: `src/transports/chatgpt-oauth/sse-parser.ts`
- Create: `test/fixtures/chatgpt-models.json`
- Test: `test/unit/chatgpt-model-catalog.test.ts`
- Test: `test/unit/chatgpt-request-codec.test.ts`
- Test: `test/unit/sse-parser.test.ts`

**Interfaces:**
- Produces: `parseChatGptModels(payload): readonly CodexModel[]`
- Produces: `buildResponsesRequest(request, modelMetadata): Record<string, unknown>`
- Produces: `ResponsesSseParser.push(chunk): readonly TransportEvent[]`

- [ ] **Step 1: Create a realistic model fixture and failing catalog tests**

Fixture fields must include `slug`, `display_name`, `description`, `visibility`, `priority`, `context_window`, `max_context_window`, `effective_context_window_percent`, `auto_compact_token_limit`, `input_modalities`, `shell_type`, `supports_parallel_tool_calls`, `supported_reasoning_levels`, `default_reasoning_level`, and `comp_hash`.

Assert hidden models are filtered, priority ordering is preserved, image support derives from `input_modalities`, and tool calling requires `shell_type !== "disabled"`.

- [ ] **Step 2: Write failing request and chunk-boundary SSE tests**

The request test must assert:

```ts
assert.equal(body.store, false);
assert.equal(body.stream, true);
assert.deepEqual(body.tools, [{
  type: "function",
  name: "get_abap_object_lines",
  description: "Read ABAP lines",
  parameters: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
  strict: false,
}]);
```

The SSE test splits `response.output_text.delta` and `response.function_call_arguments.delta` across arbitrary byte boundaries, then asserts one text event and one parsed tool call.

- [ ] **Step 3: Run focused tests and verify missing implementations**

Run: `npm run compile && node --test out/test/unit/chatgpt-model-catalog.test.js out/test/unit/chatgpt-request-codec.test.js out/test/unit/sse-parser.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement strict catalog normalization and request encoding**

Use 95% effective context and 90% default compaction ratios when fields are absent. Preserve every tool schema. Convert normalized text, image, tool-call, and tool-result parts into Responses input items with exact call IDs. Set `parallel_tool_calls` from `CodexModel.capabilities.parallelToolCalls`, and set `tool_choice` to `required` only for Copilot's required mode. Do not include hosted web/image tools in V1.

- [ ] **Step 5: Implement incremental SSE parsing**

Recognize `response.output_text.delta`, `response.function_call_arguments.delta`, `response.output_item.done`, `response.completed`, `error`, and `response.failed`. Buffer arguments by item/call ID. Unknown events produce no user content and are reported only through the safe logger metadata path.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run test:unit`

Expected: PASS.

```powershell
git add src/transports/chatgpt-oauth test/fixtures/chatgpt-models.json test/unit/chatgpt-*.test.ts test/unit/sse-parser.test.ts
git commit -m "feat: add private Codex protocol codecs"
```

### Task 7: Complete the ChatGPT OAuth transport and Provider route

**Files:**
- Create: `src/transports/chatgpt-oauth/http-client.ts`
- Create: `src/transports/chatgpt-oauth/oauth-transport.ts`
- Test: `test/integration/oauth-transport.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: `ChatGptOAuthTransport implements CodexTransport`
- Consumes: `OAuthManager`, `ModelCache`, `buildResponsesRequest`, `ResponsesSseParser`

- [ ] **Step 1: Write an integration test with a fake fetch sequence**

Sequence: models 200, responses 401, refresh 200, responses 200 SSE. Assert exactly one forced refresh, one replay before any stream output, text deltas preserved, and an ABAP tool call retains its call ID.

- [ ] **Step 2: Add rate-limit, timeout, and cancellation tests**

Assert 429 maps to `CodexError("rateLimited")` with `retryAfterMs`; abort maps to `cancelled`; a 401 after refresh maps to `unauthorized`; no request is replayed after the response body starts streaming.

- [ ] **Step 3: Run the integration test and verify failure**

Run: `npm run compile && node --test out/test/integration/oauth-transport.test.js`

Expected: FAIL because transport files are missing.

- [ ] **Step 4: Implement authenticated HTTP and transport streaming**

Required headers are `Authorization`, `Accept`, `Content-Type`, `Originator`, `User-Agent`, optional `ChatGPT-Account-ID`, random `session-id`, and random `thread-id`. Models URL includes `client_version=0.146.0`. Use one AbortController for VS Code cancellation plus the configured request timeout.

- [ ] **Step 5: Wire the OAuth transport into the ChatGPT Provider**

Construct `OAuthStore(context.secrets)`, `OAuthManager`, `ChatGptOAuthTransport`, and `CodexLanguageModelProvider` in `activate()`. Leave the Local CLI route on `EmptyTransport` until Task 10.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run test && npm run test:extension`

Expected: PASS with no live network calls.

```powershell
git add src/transports/chatgpt-oauth src/extension.ts test/integration/oauth-transport.test.ts
git commit -m "feat: expose ChatGPT OAuth Codex models"
```

### Task 8: Implement JSONL RPC and App Server process supervision

**Files:**
- Create: `src/transports/app-server/protocol.ts`
- Create: `src/transports/app-server/jsonl-rpc-client.ts`
- Create: `src/transports/app-server/executable-locator.ts`
- Create: `src/transports/app-server/process-supervisor.ts`
- Create: `scripts/fake-app-server.mjs`
- Test: `test/unit/jsonl-rpc-client.test.ts`
- Test: `test/unit/executable-locator.test.ts`
- Test: `test/integration/process-supervisor.test.ts`

**Interfaces:**
- Produces: `JsonlRpcClient.request<T>(method, params, signal): Promise<T>`
- Produces: `JsonlRpcClient.notify(method, params): void`
- Produces: `JsonlRpcClient.onServerRequest(method, handler): Disposable`
- Produces: `ProcessSupervisor.start(): Promise<JsonlRpcClient>`
- Produces: `ProcessSupervisor.stop(): Promise<void>`

- [ ] **Step 1: Write failing JSONL correlation and malformed-line tests**

Feed fragmented lines, two out-of-order responses, a notification, and a server request. Assert responses resolve by numeric ID, notifications do not consume pending requests, and malformed JSON raises a protocol error without leaking the line body.

- [ ] **Step 2: Write failing executable lookup tests**

Test exact order: configured absolute executable, PATH candidates from `path.delimiter`, Windows app execution alias `%LOCALAPPDATA%\Microsoft\WindowsApps\codex.exe`. Reject directories and non-absolute configured paths.

- [ ] **Step 3: Write a deterministic fake App Server**

The script reads JSONL stdin and implements `initialize`, `account/read`, `model/list`, `thread/start`, `turn/start`, `turn/interrupt`, and `item/tool/call` response handling. It supports environment switches `FAKE_APP_SERVER_CRASH_AFTER_INIT=1` and `FAKE_APP_SERVER_NO_DYNAMIC_TOOLS=1`.

- [ ] **Step 4: Run focused tests and verify failures**

Run: `npm run compile && node --test out/test/unit/jsonl-rpc-client.test.js out/test/unit/executable-locator.test.js out/test/integration/process-supervisor.test.js`

Expected: FAIL.

- [ ] **Step 5: Implement JSONL RPC without shell execution**

Define the protocol envelope and turn input types in `protocol.ts`:

```ts
export type JsonRpcId = number | string;
export type JsonRpcMessage =
  | { id: JsonRpcId; method: string; params?: unknown }
  | { id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } }
  | { method: string; params?: unknown };
export type AppServerUserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string };
```

Spawn only with:

```ts
spawn(executable, ["app-server", "--listen", "stdio://"], {
  shell: false,
  windowsHide: true,
  cwd: safeCwd,
  stdio: ["pipe", "pipe", "pipe"],
});
```

Keep request and server-request maps separate. Reject all pending promises on exit. Treat stderr as redacted diagnostics only.

- [ ] **Step 6: Implement one-restart circuit breaking**

The first request after a crash may start a fresh process once. A second consecutive start/initialization failure opens the breaker until `restart()` is called. `stop()` is idempotent and waits for exit, then kills after a five-second grace period.

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck && npm run test`

Expected: PASS.

```powershell
git add src/transports/app-server scripts/fake-app-server.mjs test/unit/jsonl-rpc-client.test.ts test/unit/executable-locator.test.ts test/integration/process-supervisor.test.ts
git commit -m "feat: add Codex App Server process client"
```

### Task 9: Add App Server initialization, safety profile, account, and model discovery

**Files:**
- Create: `src/transports/app-server/safety-profile.ts`
- Create: `src/transports/app-server/model-catalog.ts`
- Create: `src/transports/app-server/app-server-session.ts`
- Test: `test/unit/app-server-safety.test.ts`
- Test: `test/unit/app-server-model-catalog.test.ts`
- Test: `test/integration/app-server-session.test.ts`

**Interfaces:**
- Produces: `APP_SERVER_THREAD_CONFIG`
- Produces: `AppServerSession.initialize(): Promise<AppServerCapabilities>`
- Produces: `AppServerSession.readAccount(): Promise<AppServerAccount>`
- Produces: `AppServerSession.listModels(): Promise<readonly CodexModel[]>`

- [ ] **Step 1: Write the safety-profile test before implementation**

Assert thread start params contain:

```ts
assert.equal(params.approvalPolicy, "never");
assert.equal(params.sandbox, "read-only");
assert.equal(params.ephemeral, true);
assert.equal(params.config["features.shell_tool"], false);
assert.equal(params.config["features.unified_exec"], false);
assert.equal(params.config["web_search"], "disabled");
assert.equal(params.config["features.apps"], false);
assert.equal(params.config["features.plugins"], false);
assert.equal(params.config["features.multi_agent"], false);
```

Also disable `code_mode`, `code_mode_only`, `browser_use`, `computer_use`, `image_generation`, and `standalone_web_search`; set `include_apps_instructions` and `include_collaboration_mode_instructions` to false.

- [ ] **Step 2: Write initialization/account/model tests**

Assert initialization sends client name `copilot_codex_provider_for_sap`, extension version, and `capabilities.experimentalApi: true`, then sends `initialized`. `account/read` must accept only account type `chatgpt` or `personalAccessToken`; API-key-only state is rejected because this project does not implement the official API route.

- [ ] **Step 3: Run tests and verify failures**

Run: `npm run compile && node --test out/test/unit/app-server-safety.test.js out/test/unit/app-server-model-catalog.test.js out/test/integration/app-server-session.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement guarded protocol parsing and model normalization**

Use these stable internal shapes after validation:

```ts
export interface AppServerCapabilities { dynamicTools: boolean; serverVersion?: string; }
export interface AppServerAccount { type: "chatgpt" | "personalAccessToken"; planType?: string; }
```

Call `model/list` with `{ includeHidden: false }`. Preserve server ordering. Map `id`, `displayName`, `description`, context limits, image modality, and tool support; if required fields are absent, omit that model and record only field names in diagnostics.

- [ ] **Step 5: Implement dynamic-tools capability failure behavior**

The fake server must accept an ephemeral `thread/start` containing one harmless dynamic tool and return success. If the method rejects `dynamicTools` or experimental API, throw `CodexError("incompatible", { action: "upgradeCodex" })`; the Local Provider returns no models until a manual restart/refresh.

- [ ] **Step 6: Reject native App Server actions defensively**

Register handlers that answer `deny` to command/file/permission approvals. If `item/started` reports `commandExecution` or `fileChange`, immediately call `turn/interrupt`, mark the turn as a security protocol failure, and emit no content from that item.

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck && npm run test`

Expected: PASS.

```powershell
git add src/transports/app-server test/unit/app-server-*.test.ts test/integration/app-server-session.test.ts
git commit -m "feat: enforce safe App Server capabilities"
```

### Task 10: Implement transcript encoding and dynamic tool continuation

**Files:**
- Create: `src/transports/app-server/transcript.ts`
- Create: `src/transports/app-server/tool-continuations.ts`
- Create: `src/transports/app-server/app-server-transport.ts`
- Test: `test/unit/app-server-transcript.test.ts`
- Test: `test/unit/tool-continuations.test.ts`
- Test: `test/integration/app-server-transport.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: `serializeTranscript(messages): UserInput[]`
- Produces: `ToolContinuationRegistry.capture(request): PendingContinuation`
- Produces: `ToolContinuationRegistry.resume(results, signal): AsyncIterable<TransportEvent> | undefined`
- Produces: `AppServerTransport implements CodexTransport`

- [ ] **Step 1: Write transcript tests**

Assert role boundaries and tool history are explicit and unambiguous:

```text
<copilot-history>
<message role="user">Read ZCL_DEMO</message>
<message role="assistant"><tool-call id="c1" name="get_abap_object_lines">{"uri":"adt://DEV/zcl_demo"}</tool-call></message>
<message role="user"><tool-result id="c1">CLASS zcl_demo DEFINITION.</tool-result></message>
</copilot-history>
<current-user-message>Explain the class.</current-user-message>
```

Escape literal closing tags in user text. Pass images as separate App Server image inputs when supported; otherwise return an `incompatible` error rather than dropping them.

- [ ] **Step 2: Write continuation state-machine tests**

Use one explicit pending-call shape:

```ts
export interface PendingToolCall {
  rpcId: JsonRpcId;
  threadId: string;
  turnId: string;
  callId: string;
  name: string;
  expiresAt: number;
  respond(result: { contentItems: readonly unknown[]; success: boolean }): void;
  reject(error: Error): void;
}
```

Cover one call, two parallel calls, duplicate result, unknown call ID, partial result set, 300-second timeout, cancellation, process exit, and late result after cleanup. Track `surfacedToCopilot` and an optional received result on every pending call. The registry key is the exact Copilot/App Server `callId`; no fuzzy matching is allowed.

- [ ] **Step 3: Run focused tests and verify failures**

Run: `npm run compile && node --test out/test/unit/app-server-transcript.test.js out/test/unit/tool-continuations.test.js out/test/integration/app-server-transport.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement dynamic tool registration**

Map each Copilot tool to a top-level App Server dynamic function:

```ts
{
  type: "function",
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  deferLoading: false,
}
```

Reject names outside `^[a-zA-Z0-9_-]{1,128}$` with a protocol error naming only the invalid tool name.

- [ ] **Step 5: Implement pause and resume across Provider calls**

When `item/tool/call` arrives, store its RPC responder. Before ending each Provider response, drain every pending call not yet marked `surfacedToCopilot` as a `tool-call` event. On a later `generate()` call, store every matching result first; if another parallel call is still unsurfaced, report that call and return without answering App Server. Only after every surfaced call has a result, answer the pending RPCs with `inputText`/data-URL `inputImage` content items, bind the new Provider response to the original turn, and continue until `turn/completed`. This sequentializes Copilot presentation without losing parallel App Server requests.

On completion, cancellation, timeout, security interruption, or process exit, call `thread/unsubscribe`, detach thread/turn listeners, and delete all call IDs for that generation chain.

- [ ] **Step 6: Wire Local CLI into the second Provider**

Create `ExecutableLocator`, `ProcessSupervisor`, `AppServerSession`, `ToolContinuationRegistry`, and `AppServerTransport` in `activate()`. Keep OAuth and Local instances completely separate.

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck && npm run test && npm run test:extension`

Expected: PASS, including two fake dynamic tools resolving out of order.

```powershell
git add src/transports/app-server src/extension.ts test/unit/app-server-transcript.test.ts test/unit/tool-continuations.test.ts test/integration/app-server-transport.test.ts
git commit -m "feat: bridge App Server tools through Copilot"
```

### Task 11: Add safe ABAP FS and SAP ADT context enrichment

**Files:**
- Create: `src/sap/context.ts`
- Create: `src/sap/instructions.ts`
- Test: `test/extension/suite/sap.test.ts`
- Modify: `src/providers/codex-provider.ts`
- Modify: `src/constants.ts`

**Interfaces:**
- Produces: `SapContextProvider.collect(): SapContext`
- Produces: `buildSapInstructions(context, toolNames): string`
- Consumes: active editor, diagnostics, extension registry, normalized tools

- [ ] **Step 1: Write extension-host tests with a fake `adt://` file system**

Register an in-memory `FileSystemProvider`, open `adt://DEV/src/zcl_demo.clas.abap`, edit without saving, select `METHODS run.`, and add one error diagnostic. Assert context uses `document.getText()` for the selection, preserves the URI string, reports `dirty: true`, and never reads `uri.fsPath`.

- [ ] **Step 2: Add extension-presence and bounded-context tests**

Use IDs `murbani.vscode-abap-remote-fs` and `SAPSE.adt-vscode`. Assert selection text is truncated to configuration default 16,000 characters, diagnostics are limited to 50 entries, and no full document text is returned when the selection is empty.

- [ ] **Step 3: Run extension tests and verify failure**

Run: `npm run test:extension`

Expected: FAIL because SAP context modules are absent.

- [ ] **Step 4: Implement context collection only through stable VS Code APIs**

```ts
export interface SapContext {
  abapFsInstalled: boolean;
  adtInstalled: boolean;
  activeDocument?: { uri: string; languageId: string; dirty: boolean; selection?: string };
  diagnostics: readonly { severity: string; message: string; range: string }[];
}
```

Never call `extensions.getExtension(...).exports`, undocumented commands, Node `fs`, or ADT MCP.

- [ ] **Step 5: Add concise ABAP guidance to both transports**

Instructions must say: prefer supplied semantic ABAP tools; do not recursively enumerate `adt://`; use open document text for unsaved content; request modifying/activating actions only after explicit user intent; Copilot owns approval/execution. Include recognized ABAP FS tool names only when those names are present in the current request.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run test && npm run test:extension`

Expected: PASS.

```powershell
git add src/sap src/providers/codex-provider.ts src/constants.ts test/extension/suite/sap.test.ts
git commit -m "feat: enrich Codex requests with safe SAP context"
```

### Task 12: Add management commands, settings, cache refresh, and diagnostics

**Files:**
- Create: `src/commands/register-commands.ts`
- Create: `src/commands/diagnostics.ts`
- Test: `test/extension/suite/commands.test.ts`
- Modify: `src/constants.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `registerCommands(services, context): readonly vscode.Disposable[]`
- Consumes: `OAuthManager`, both transports/caches, `ProcessSupervisor`, `SafeLogger`

- [ ] **Step 1: Write failing command registration tests**

Assert these commands exist and invoke only their own route:

```text
copilotCodex.chatgpt.signIn
copilotCodex.chatgpt.signInManual
copilotCodex.chatgpt.signOut
copilotCodex.chatgpt.refreshModels
copilotCodex.local.selectExecutable
copilotCodex.local.start
copilotCodex.local.restart
copilotCodex.local.stop
copilotCodex.local.refreshModels
copilotCodex.showDiagnostics
copilotCodex.clearExtensionData
```

`clearExtensionData` clears only this extension's OAuth secret, both model caches, continuation registry, and diagnostics; it must not call App Server logout or edit Codex config.

- [ ] **Step 2: Add exact configuration contributions**

```json
"copilotCodex.local.codexPath": { "type": "string", "default": "" },
"copilotCodex.requestTimeoutSeconds": { "type": "number", "default": 600, "minimum": 10 },
"copilotCodex.toolTimeoutSeconds": { "type": "number", "default": 300, "minimum": 30 },
"copilotCodex.catalogCacheMinutes": { "type": "number", "default": 5, "minimum": 1 },
"copilotCodex.sapSelectionMaxChars": { "type": "number", "default": 16000, "minimum": 1000 },
"copilotCodex.logLevel": { "type": "string", "enum": ["error", "warn", "info", "debug"], "default": "info" }
```

Do not contribute endpoint, token, Cookie, ADT token, arbitrary App Server arguments, or shell command settings.

- [ ] **Step 3: Run extension tests and verify failure**

Run: `npm run test:extension`

Expected: FAIL for missing commands/settings.

- [ ] **Step 4: Implement commands and management menus**

ChatGPT management shows sign-in state and private-interface warning before opening the browser. Local management shows resolved executable, process state, account type, dynamic-tools compatibility, and model count. Manual sign-in asks for the complete callback URL and passes it unchanged to `completeManualCallback()`.

- [ ] **Step 5: Implement redacted diagnostics report**

Report extension/VS Code/platform versions, provider availability, model counts, cache ages, resolved executable path with username segments replaced, App Server client version/capability flags, active SAP extension booleans, and last safe error codes. Do not include account email, tokens, prompts, source, tool bodies, or SAP connection authority.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run test && npm run test:extension`

Expected: PASS.

```powershell
git add package.json src/commands src/constants.ts src/extension.ts test/extension/suite/commands.test.ts
git commit -m "feat: add provider management and diagnostics"
```

### Task 13: Complete failure isolation and regression coverage

**Files:**
- Create: `test/integration/failure-isolation.test.ts`
- Create: `test/integration/security-boundary.test.ts`
- Modify: `src/core/errors.ts`
- Modify: `src/providers/codex-provider.ts`
- Modify: `src/transports/chatgpt-oauth/oauth-transport.ts`
- Modify: `src/transports/app-server/app-server-transport.ts`

**Interfaces:**
- Consumes: all route and error interfaces
- Produces: verified no-fallback and no-native-action behavior

- [ ] **Step 1: Write a failing two-route isolation test**

Crash the fake App Server while an OAuth fake stream succeeds. Assert OAuth still emits all text, Local emits only `process`, and neither transport calls the other transport's `generate()` or `listModels()`.

- [ ] **Step 2: Write security-boundary tests**

Feed App Server `commandExecution`, `fileChange`, command approval, file approval, permission approval, unknown native tool, and a legitimate `item/tool/call`. Assert native requests are denied/interrupted while the legitimate dynamic tool is forwarded to Copilot.

- [ ] **Step 3: Add stream replay regression tests**

For OAuth, emit one text delta then close the socket: assert no retry. For App Server, emit one tool call then crash: assert pending calls are cleared and late Copilot results receive `toolContinuation`, not a new turn.

- [ ] **Step 4: Run tests and verify at least one missing behavior**

Run: `npm run compile && node --test out/test/integration/failure-isolation.test.js out/test/integration/security-boundary.test.js`

Expected: FAIL before final isolation handling is applied.

- [ ] **Step 5: Apply explicit isolation and replay guards**

Add an OAuth `streamStarted` boolean before reading the first SSE event and permit 401 replay only while it is false. Add `AppServerTransport.terminateTurn(threadId, error)` to interrupt the turn, reject and delete every continuation for that thread, detach event listeners, and leave OAuth state untouched. In `CodexLanguageModelProvider`, map each non-cancellation `CodexError` to exactly one action: `signIn`, `refreshModels`, `selectCodex`, `restartCodex`, `upgradeCodex`, or `showDiagnostics`; return silently for `cancelled`.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run test && npm run test:extension`

Expected: PASS.

```powershell
git add src test/integration/failure-isolation.test.ts test/integration/security-boundary.test.ts
git commit -m "test: harden backend isolation and safety"
```

### Task 14: Document, package, and run the V1 acceptance matrix

**Files:**
- Create: `README.md`
- Create: `SECURITY.md`
- Create: `CHANGELOG.md`
- Create: `docs/testing.md`
- Modify: `.vscodeignore`
- Modify: `package.json`

**Interfaces:**
- Produces: `dist/copilot-codex-provider-for-sap-0.1.0.vsix`
- Consumes: all prior tasks

- [ ] **Step 1: Write the user documentation**

README sections: prerequisites, VSIX install, two independent model entries, ChatGPT OAuth login, Local Codex path/login, ABAP FS usage, SAP ADT limitations, private-interface warning, troubleshooting, diagnostics, and uninstall/data cleanup. State explicitly that V1 does not use the official OpenAI API and does not connect ADT MCP.

- [ ] **Step 2: Write security and testing documentation**

`SECURITY.md` documents SecretStorage, loopback callback ports 1455/1457, no CLI-token import, no prompt/source logging, App Server no-native-tools profile, Copilot-owned tool approval, and private-interface risk. `docs/testing.md` contains the exact automated commands and manual matrix from the spec.

- [ ] **Step 3: Run the full automated verification from a clean build**

Run:

```powershell
npm run clean
npm run typecheck
npm run test
npm run test:extension
```

Expected: all commands exit 0; `.vscode-test` remains inside the project.

- [ ] **Step 4: Build and inspect the VSIX**

Run:

```powershell
npm run package
npx vsce ls --tree
```

Expected: `dist/copilot-codex-provider-for-sap-0.1.0.vsix` exists; package contains compiled `out/src/**`, manifest, README, SECURITY, CHANGELOG, and license metadata; it excludes `.npm-cache`, `.vscode-test`, `node_modules`, source tests, fixtures, and real credentials.

- [ ] **Step 5: Run the manual VS Code/Copilot/SAP acceptance matrix**

Verify in a Development Host with GitHub Copilot Chat, ABAP FS, and SAP ADT installed:

1. Both Provider names appear independently.
2. OAuth login/model discovery/text stream works.
3. Local App Server reuses ChatGPT login/model discovery/text stream.
4. Each route completes one `get_abap_object_lines` call through Copilot and continues with its result.
5. `adt://` dirty selection and diagnostics influence the answer without scanning the workspace.
6. Cancelling either route stops only that route.
7. Crashing App Server does not affect OAuth.
8. No SAP write/activation, shell command, patch, ADT MCP call, token log, prompt log, or source log occurs.

- [ ] **Step 6: Record release evidence and commit**

Add a dated results table to `docs/testing.md` with command, exit code, VS Code version, Codex App Server version, ABAP FS version, SAP ADT version, and pass/fail for each manual case. Do not include account identity, SAP system authority, source, or tool payloads.

```powershell
git add README.md SECURITY.md CHANGELOG.md docs/testing.md .vscodeignore package.json package-lock.json
git commit -m "docs: package and verify V1 VSIX"
```

## Final Verification Gate

Before claiming completion, run:

```powershell
git status --short
npm run typecheck
npm run test
npm run test:extension
npm run package
```

Expected:

- `git status --short` is empty before or after committing generated release evidence; the VSIX itself may remain ignored under `dist/`.
- Every command exits 0.
- The two Provider entries remain independent.
- The manual acceptance table has no unresolved failures.
- No file outside the target project was modified by the implementation workflow; runtime SecretStorage and pre-existing Codex-managed authentication are the only platform-managed state used when the user explicitly tests real login.
