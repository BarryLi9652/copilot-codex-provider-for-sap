# Copilot Codex Provider for SAP — Reliability and Security Maintenance Design

- Date: 2026-08-25
- Status: Approved in chat; awaiting written-spec review
- Delivery strategy: Scheme B — one release branch, independently testable TDD batches
- Source review: `docs/2026-08-25-deep-code-review.md`
- Baseline: local `main` at `cc7472d`

## 1. Purpose

This maintenance release addresses the findings from the 2026-08-25 deep code review that are confirmed by the current code. The work stays in one release branch, but each concern is implemented as an independently testable and revertible commit.

The release improves process recovery, OAuth cancellation, model refresh visibility, Windows executable discovery, continuation cleanup, redaction, protocol resource limits, diagnostics, shutdown, and selected low-risk cleanup. It does not change the product's provider or SAP safety architecture.

## 2. Scope classification

This is architectural maintenance rather than a bounded bugfix because it crosses process supervision, OAuth, provider discovery, protocol parsing, tool-continuation lifecycle, diagnostics, and network resource ownership.

"One release" does not mean "one patch": every batch must independently pass its RED → GREEN → REFACTOR cycle and have a separate commit. A failing or unjustified optional batch must not block shipping the already verified mandatory batches.

## 3. In-scope findings

### 3.1 Mandatory reliability fixes

1. Recover `ProcessSupervisor` from asynchronous spawn failures without entering `stuck` or masking the original spawn error.
2. Apply cancellation and bounded timeout behavior to OAuth token requests.
3. Invalidate Local Provider model information after local model refresh and extension-data clearing.
4. Prevent automatic Windows discovery from selecting unsupported extensionless/npm shell shims, while preserving explicit-path compatibility and actionable diagnostics.
5. Verify App Server turn and lease cleanup after tool-continuation timeout or terminal completion, and fix it only when a RED regression demonstrates retained state.

### 3.2 Mandatory security and resource fixes

1. Extend structured redaction for sensitive field names, authorization values, and URI user information without broadly suppressing safe diagnostic fields such as error codes.
2. Add explicit upper bounds to unterminated JSONL input and pending SSE event data.
3. Validate the OAuth callback state before consuming the only callback opportunity.
4. Close the OAuth loopback response connection promptly.

### 3.3 Mandatory contract, diagnostics, and shutdown fixes

1. Make Local model `forceRefresh` behavior consistent across provider, transport, and session caches.
2. Include `requiredToolMissing` in safe diagnostics.
3. Represent unknown failures in diagnostics without inserting an invalid value into `CodexErrorCode[]`.
4. Add a conservative, documented image-token estimate instead of always counting image data as zero.
5. Define `silent` discovery as non-interactive: it must not open login UI, and an unavailable provider must return no models without a user-facing prompt.
6. Await asynchronous transport disposal during extension deactivation.

### 3.4 Conditional performance and cleanup work

1. Evaluate reusable HTTP/HTTPS agents for ChatGPT OAuth and transport requests.
2. Remove state or constants proven unused by static search and tests, including the write-only OAuth session field and stale ABAP tool-name constants.
3. Remove or replace assertions that cannot become false under the current ownership model, such as `invalidLeaseIdentity`, only when their removal does not weaken a meaningful invariant.

## 4. Explicit exclusions

The following review suggestions are not implemented:

- No `proxyEnv` fallback for unsupported Node versions; the extension's supported VS Code runtime already provides the required Node capability.
- No direct propagation of a first caller's `AbortSignal` into shared model discovery. This would break the tested single-flight behavior where one caller can cancel without cancelling another caller's discovery.
- No direct display or logging of remote `payload.error.message`. Only bounded, allow-listed status or category information may be mapped into local typed errors.
- No consolidation of all model caches. Provider and transport/session caches retain distinct sharing and cancellation responsibilities.
- No broad framework, tracing subsystem, callback framework, retired-call registry, or `ToolContinuationRegistry` rewrite.

## 5. Safety architecture invariants

These invariants are release blockers:

- The Provider never executes Copilot-supplied tools.
- The Provider never writes to SAP directly.
- Copilot/VS Code continues to own tool approval and execution.
- ABAP FS or the virtual workspace continues to perform actual `adt://` edits and activation.
- Local App Server continues to use `approvalPolicy = never` and `sandbox = read-only`.
- Native `fileChange`, `commandExecution`, shell, and patch capabilities remain disabled.
- No MCP path may bypass Copilot.
- `replace_string_in_file`, `replace_string_in_abap_object`, and similar tools are not reimplemented, wrapped, filtered, or assigned new schemas or replace-specific continuations.
- All supplied tools continue to be forwarded. Capability recognition may only influence SAP instructions and safe diagnostics.
- `toolMode = required` continues to mean that at least one supplied dynamic tool must be called during the turn; it never means that a replace tool is mandatory.

## 6. Implementation batches

### Batch 1 — Process failure recovery

Primary production area:

- `src/transports/app-server/process-supervisor.ts`

Required tests:

- An asynchronously emitted spawn error with no subsequent natural `exit` event settles startup promptly.
- The supervisor returns to `stopped`, retains the original `spawnCodex` error, and can start again.
- Existing stop, restart, SIGTERM, SIGKILL, and genuine stuck-process behavior remains unchanged.

The fix must give every process record exactly one terminal settlement path. It must not classify a process as stuck merely because the child failed before it could start.

### Batch 2 — OAuth cancellation and loopback completion

Primary production areas:

- `src/transports/chatgpt-oauth/oauth-manager.ts`
- `src/transports/chatgpt-oauth/http-client.ts`
- `src/transports/chatgpt-oauth/loopback-server.ts`

Required tests:

- Aborting sign-in or refresh aborts the underlying token request and clears any active-flight state.
- Token requests time out with a typed local timeout error.
- A callback with the wrong state cannot consume the valid callback opportunity.
- A keep-alive callback client receives completion promptly and the listener closes.
- PKCE, loopback-only binding, redirect path validation, and secret storage behavior remain unchanged.

Timeout values must be configurable through existing request timeout policy or an internal bounded default; no second conflicting timeout configuration is introduced.

### Batch 3 — Local model discovery consistency

Primary production areas:

- `src/extension.ts`
- `src/providers/codex-provider.ts`
- `src/transports/app-server/app-server-transport.ts`
- `src/transports/app-server/app-server-session.ts`
- `src/transports/app-server/executable-locator.ts`

Required tests:

- Refresh and extension-data clearing invalidate every relevant Local model cache and emit the provider change event once.
- `forceRefresh` reaches the transport/session cache boundary.
- Cancelling one model-list caller does not cancel a shared request still awaited by another caller.
- Automatic Windows discovery accepts a native `codex.exe` and rejects unsupported shell shims.
- An explicitly configured invalid or unsupported path produces a safe, actionable error.
- Silent discovery never opens interactive UI.

The cache layers are not merged in this batch.

### Batch 4 — Tool-continuation lifecycle

Primary production areas, subject to the lifecycle gate below:

- `src/transports/app-server/app-server-transport.ts`
- `src/transports/app-server/tool-continuations.ts` only if a failing regression proves a minimal registry change is required

Required tests:

- Supplied tool call → Copilot tool result → model continuation still completes.
- Multiple supplied tools continue independently.
- Tool timeout releases the associated transport turn and lease.
- Server completion, failure, cancellation, and process exit each release state exactly once.
- A late tool result cannot resume a completed or timed-out turn.
- The existing ABAP edit-and-activate continuation regression remains green.

#### Hard gate 1 — lifecycle scope

Production code may be changed only after a RED regression demonstrates the retained `TurnState` or lease.

- `PASS`: make no production lifecycle change.
- `FAIL`, but unrelated to the current write flow: record a follow-up issue and do not expand this release.
- `FAIL` and directly breaks or retains the current write flow: implement the smallest state-terminal notification needed.
- If the fix requires a registry redesign, terminal callback framework, retired-call registry, or changes to tool ownership, stop the batch and request explicit scope approval.

### Batch 5 — Redaction and protocol resource limits

Primary production areas:

- `src/security/redact.ts`
- `src/transports/app-server/jsonl-rpc-client.ts`
- `src/transports/chatgpt-oauth/sse-parser.ts`

Required tests:

- Known sensitive keys and authorization/token value patterns are redacted.
- URI credentials are removed while safe host and path information can remain.
- Safe fields such as `code`, account type, model ID, and correlation ID are not indiscriminately redacted.
- Oversized unterminated JSONL and SSE input fails with a typed bounded-resource/protocol error.
- Valid large tool payloads below the selected limit continue to parse.
- Existing chunk-boundary and Unicode streaming tests remain green.

Limits must be selected from repository fixtures or explicit stress tests. A limit is not accepted merely because it appears in the external review.

### Batch 6 — Diagnostics, token estimation, and shutdown

Primary production areas:

- `src/commands/diagnostics.ts`
- `src/providers/token-count.ts`
- `src/extension.ts`
- narrowly related error types if required

Required tests:

- `requiredToolMissing` appears in safe diagnostics.
- Unknown errors are counted or categorized separately without violating `CodexErrorCode` typing.
- Image/data parts receive a conservative non-zero estimate without counting arbitrary non-image data as images.
- Extension deactivation awaits idempotent transport disposal and leaves no managed child process running.

### Batch 7 — Conditional network performance experiment and cleanup

Primary production areas are not approved in advance. They may be added only after the performance gate is satisfied and the exact files are reported before implementation.

#### Hard gate 2 — performance evidence

Reusable Agent production changes are allowed only when all of the following are true:

1. A repeatable benchmark compares the current per-request Agent behavior with the candidate under the same proxy and non-proxy conditions.
2. At least three runs show a consistent benefit in connection count, handshake overhead, or median request latency, with no material regression in cancellation or shutdown latency.
3. Tests prove that ChatGPT proxy configuration cannot leak into SAP/ABAP FS traffic, `NO_PROXY` behavior is preserved, configuration changes retire incompatible agents, and extension deactivation closes owned agents.
4. Agent ownership and disposal fit existing transport boundaries without a new networking framework.

If evidence is absent, noisy, or the implementation requires a new framework, no production Agent change is made. The benchmark result records either `gate satisfied → candidate may enter TDD` or `gate not satisfied → no production change`.

Dead-code cleanup may proceed only for symbols proven unused and only in the batch already touching the owning module. It must not change behavior or trigger unrelated refactoring.

## 7. Error handling and observability

- Original typed errors remain the primary user-facing failure source; cleanup failures must not overwrite them.
- Remote error bodies are treated as untrusted. Only safe, bounded categories are surfaced.
- Buffer-limit failures include protocol, limit category, and correlation metadata, but never payload contents.
- Diagnostics preserve the existing safe-code design and add a separate representation for unknown failures.
- No new full tracing or diagnostics architecture is introduced.

## 8. Test and verification strategy

Every batch follows strict TDD:

1. Add one minimal regression and run it to observe the expected failure.
2. Implement only enough production code to pass that regression.
3. Refactor only code introduced or directly exposed by the fix.
4. Run the focused unit/integration suite.
5. Run `npm run check` before committing the batch.

Before release completion, run:

- `npm run check`
- `npm run test:extension`
- `npm run package:vsix`
- Manual Local CLI startup, failure recovery, model refresh, and cancellation smoke tests
- Manual ChatGPT OAuth sign-in, restart persistence, proxy, cancellation, and model refresh smoke tests
- Manual Copilot ABAP virtual-workspace edit, supplied-tool continuation, write, and activation regression

No completion claim or release packaging is valid without fresh command output.

## 9. Commit and rollback structure

Expected commit boundaries:

1. `fix(process): recover from asynchronous spawn failures`
2. `fix(oauth): bound token requests and validate callbacks`
3. `fix(models): align local discovery and executable selection`
4. `fix(lifecycle): release terminal tool continuations` — only if Hard gate 1 permits it
5. `fix(security): strengthen redaction and protocol limits`
6. `fix(diagnostics): improve safe reporting and shutdown`
7. `perf(network): reuse disposable proxy-aware agents` — only if Hard gate 2 permits it
8. `chore: remove verified dead state` — only where already touched

Each commit must be independently testable and revertible. A failed optional batch is omitted rather than folded into another commit.

## 10. Definition of done

The release is complete when:

- Every mandatory production change has RED evidence, a minimal GREEN implementation, and focused regressions; the lifecycle batch may instead record a passing regression and make no production change as required by Hard gate 1.
- Both hard gates were applied and their outcome was recorded, including when the outcome is no production change.
- Full unit, integration, and extension tests pass.
- A VSIX packages successfully.
- Local CLI and ChatGPT OAuth manual smoke tests pass.
- The complete Copilot → supplied edit tool → ABAP FS/ADT write and activation workflow passes without Provider-side execution.
- No safety invariant or explicit exclusion in this design changed.
- The release branch contains separate, reviewable commits and no unrelated user files.
