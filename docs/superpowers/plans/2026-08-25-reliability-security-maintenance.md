# Reliability and Security Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with checkpoints. This plan requires single-agent inline execution and forbids subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one maintenance release that fixes every confirmed reliability, security, lifecycle, and diagnostics finding without changing Copilot/SAP tool ownership or the Local App Server safety profile.

**Architecture:** Keep the existing Provider → transport → backend boundaries. Implement the release as thirteen independently testable tasks on one isolated branch, using existing state machines and caches instead of adding frameworks. Tool lifecycle and reusable-Agent changes remain conditional on their approved hard gates.

**Tech Stack:** TypeScript 6, VS Code `LanguageModelChatProvider`, Node.js 24 HTTP/HTTPS and child processes, `node:test`, JSONL RPC, ChatGPT OAuth PKCE/SSE, VSIX packaging.

**Spec:** `docs/superpowers/specs/2026-08-25-reliability-security-maintenance-design.md`

## Global Constraints

- Execute inline with `superpowers:executing-plans`; do not dispatch subagents or parallel agents.
- Create one isolated worktree and one maintenance branch before Task 1; do not implement directly on `main`.
- Follow RED → GREEN → REFACTOR for every production change and preserve the observed RED output.
- Provider does not execute Copilot tools or write to SAP.
- Copilot/VS Code owns approval and tool execution; ABAP FS/ADT owns `adt://` writes and activation.
- Local App Server remains `approvalPolicy = never` and `sandbox = read-only`.
- Do not enable native `fileChange`, `commandExecution`, shell, patch, or MCP bypass paths.
- Do not reimplement, wrap, filter, or change schemas for replace/edit tools.
- `toolMode = required` means at least one supplied dynamic tool call, never a mandatory replace-tool call.
- Do not merge Provider and transport/session model caches.
- Do not pass the first model-discovery caller's signal into a shared cache load.
- Do not expose raw remote error messages.
- Do not add a callback framework, tracing framework, retired-call registry, or `ToolContinuationRegistry` redesign.
- Preserve unrelated `.vscode/` and `docs/2026-08-25-deep-code-review.md` files as untracked user content.

## File Responsibility Map

- `src/transports/app-server/process-supervisor.ts`: child-process ownership and terminal settlement.
- `src/transports/chatgpt-oauth/oauth-manager.ts`: sign-in, refresh single-flight, token-request cancellation, and token timeout.
- `src/transports/chatgpt-oauth/loopback-server.ts`: loopback request validation, callback lifetime, and HTTP connection closure.
- `src/transports/app-server/app-server-session.ts`: App Server initialization and transport-level model cache.
- `src/transports/app-server/app-server-transport.ts`: Local model option forwarding and turn/tool lifecycle.
- `src/transports/app-server/executable-locator.ts`: configured and automatically discovered Codex executables.
- `src/extension.ts`: command-level model invalidation and extension resource ownership.
- `src/security/redact.ts`: metadata-only redaction policy.
- `src/transports/app-server/jsonl-rpc-client.ts`: bounded JSONL framing.
- `src/transports/chatgpt-oauth/sse-parser.ts`: bounded SSE framing.
- `src/commands/diagnostics.ts`: safe error-code and unknown-error summaries.
- `src/providers/token-count.ts`: model-facing text, tool, and image token estimates.
- `src/transports/chatgpt-oauth/proxy-fetch.ts`: current per-request Agent implementation; production changes require Hard gate 2.
- `src/constants.ts`: shared identifiers and verified dead constants only.

---

### Task 1: Recover cleanly from asynchronous spawn failure

**Files:**
- Modify: `test/integration/process-supervisor.test.ts`
- Modify: `src/transports/app-server/process-supervisor.ts`

**Interfaces:**
- Consumes: injected `SpawnProcess` and existing `ChildRecord` settlement promises.
- Produces: unchanged `ProcessSupervisor.start(): Promise<JsonlRpcClient>` with failed pre-spawn records returning to `stopped`.

- [ ] **Step 1: Add a FakeChild pre-spawn failure helper and failing regression**

Add this method to `FakeChild`:

```ts
public failSpawn(error = new Error("spawn ENOENT")): void {
  this.emit("error", error);
  this.stdout?.emit("close");
  this.stderr.emit("close");
  this.emit("close");
}
```

Add the regression:

```ts
test("async spawn failure settles the record and permits a later start", async () => {
  const firstChild = new FakeChild("never", new PassThrough(), 0, true);
  const { supervisor, children } = injectedSupervisor((count) =>
    count === 1 ? firstChild : new FakeChild("any"),
  );

  const firstStart = supervisor.start();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  firstChild.failSpawn();

  await assert.rejects(
    firstStart,
    (error: unknown) => error instanceof CodexError
      && error.code === "process"
      && error.action === "spawnCodex",
  );
  assert.equal(supervisor.state, "stopped");
  assert.deepEqual(firstChild.killCalls, []);

  const replacement = await supervisor.start();
  assert.equal(children.length, 2);
  assert.equal(replacement.isClosed, false);
  await supervisor.stop();
});
```

- [ ] **Step 2: Run the focused test and record RED**

Run:

```powershell
npm run compile
node --test --test-name-pattern="async spawn failure" out/test/integration/process-supervisor.test.js
```

Expected: FAIL because termination waits on an unresolved `exitPromise`, returns `stopCodex`, or leaves the supervisor `stuck`.

- [ ] **Step 3: Add one pre-spawn terminal settlement path**

In `createRecord`, add a local helper with this behavior:

```ts
const settleBeforeSpawn = (error: CodexError): void => {
  if (record.spawnSettled) {
    return;
  }
  record.spawnSettled = true;
  record.exitObserved = true;
  record.state = "exited";
  child.removeListener("spawn", onSpawn);
  child.removeListener("error", onSpawnError);
  child.removeListener("exit", onExitBeforeSpawn);
  record.rejectSpawn(error);
  record.resolveExit();
  if (this.currentRecord === record) {
    this.currentRecord = undefined;
  }
};
```

Call it from `onSpawnError` with `processError("spawnCodex", cause)` and from `onExitBeforeSpawn` with `processError("startCodex")`. Preserve temporary stream-error containment until child/stream close events have been observed; do not remove all listeners inside the helper.

In `startInternal` retain the original `error` when cleanup reports a second failure for an already settled pre-spawn record:

```ts
try {
  await this.terminateRecord(record, error, false);
} catch (terminationError) {
  if (!record.exitObserved) {
    throw terminationError;
  }
}
throw error;
```

- [ ] **Step 4: Run process-supervisor integration tests**

```powershell
npm run compile
node --test out/test/integration/process-supervisor.test.js
```

Expected: PASS, including genuine non-exiting children still becoming `stuck` after bounded escalation.

- [ ] **Step 5: Verify and commit Task 1**

```powershell
npm run check
git add src/transports/app-server/process-supervisor.ts test/integration/process-supervisor.test.ts
git commit -m "fix(process): recover from asynchronous spawn failures"
```

---

### Task 2: Bound OAuth token requests without breaking shared refresh

**Files:**
- Modify: `test/unit/oauth-manager.test.ts`
- Modify: `test/unit/http-client.test.ts`
- Modify: `src/transports/chatgpt-oauth/oauth-manager.ts`
- Modify: `src/transports/chatgpt-oauth/http-client.ts`

**Interfaces:**
- Consumes: `ChatGptTokenSource.getAccessToken(forceRefresh?, signal?)`.
- Produces: `OAuthManager.getAccessToken(forceRefresh?: boolean, signal?: AbortSignal)` and manager-owned refresh flights with a 60,000 ms token timeout.

- [ ] **Step 1: Add RED tests for signal forwarding, timeout, and single-flight ownership**

Extend `OAuthRequestInit` expectations with `signal`. Add tests equivalent to:

```ts
test("last cancelled refresh waiter aborts the token request", async () => {
  const secrets = new MemorySecretStore();
  secrets.value = JSON.stringify(session({ expiresAt: 1_030 }));
  let receivedSignal: AbortSignal | undefined;
  const manager = new OAuthManager(secrets, {
    fetch: async (_url, init) => {
      receivedSignal = init?.signal;
      return new Promise<OAuthHttpResponse>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
    tokenTimeoutMs: 60_000,
    now: () => 1_000,
  });
  const caller = new AbortController();
  const refresh = manager.getAccessToken(true, caller.signal);
  await waitForCondition(() => receivedSignal !== undefined, "token signal");
  caller.abort();
  await assert.rejects(refresh, (error: unknown) =>
    error instanceof OAuthError && error.code === "token_request_cancelled");
  assert.equal(receivedSignal?.aborted, true);
});
```

```ts
test("one cancelled waiter does not abort a shared refresh", async () => {
  const secrets = new MemorySecretStore();
  secrets.value = JSON.stringify(session({ expiresAt: 1_030 }));
  const first = new AbortController();
  const second = new AbortController();
  let fetchCalls = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const manager = new OAuthManager(secrets, {
    fetch: async () => {
      fetchCalls += 1;
      await released;
      return response({ access_token: "shared", expires_in: 3_600 });
    },
    now: () => 1_000,
  });
  const firstResult = manager.getAccessToken(true, first.signal);
  const secondResult = manager.getAccessToken(true, second.signal);
  await waitForCondition(() => fetchCalls === 1, "one token request");
  first.abort();
  await assert.rejects(firstResult, (error: unknown) =>
    error instanceof OAuthError && error.code === "token_request_cancelled");
  release();
  assert.deepEqual(await secondResult, { token: "shared" });
  assert.equal(fetchCalls, 1);
});
```

Use `tokenTimeoutMs: 20` in the timeout unit test to assert a token flight aborts, clears itself, and one later pair of concurrent calls creates only one new fetch. Assert the production default constant remains exactly 60,000 ms. Add an HTTP-client mapping test asserting `token_request_timeout` becomes `CodexError("timeout")`.

Add a sign-in cancellation test: start authorization-code exchange with a fetch that waits on `init.signal`, call `manager.signOut()`, and assert the signal aborts, both `signIn` and manual callback settle, active sign-in state clears, and stored credentials are empty.

- [ ] **Step 2: Run the focused OAuth tests and record RED**

```powershell
npm run compile
node --test out/test/unit/oauth-manager.test.js out/test/unit/http-client.test.js
```

Expected: FAIL because `OAuthRequestInit` has no signal, `OAuthManager.getAccessToken` ignores caller cancellation, and token fetch has no manager-owned timeout.

- [ ] **Step 3: Implement manager-owned refresh flight cancellation**

Add the exact option and error codes:

```ts
export interface OAuthManagerOptions {
  fetch?: OAuthFetch;
  loopbackServer?: LoopbackServer;
  now?: () => number;
  expirySkewMs?: number;
  tokenTimeoutMs?: number;
}

export interface OAuthRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
```

Add `token_request_cancelled` and `token_request_timeout` to `OAuthErrorCode`. Extend `RefreshFlight` with one manager-owned `AbortController`, `waiters`, and `settled`. Each caller races the shared promise against its own signal, decrements `waiters` in `finally`, and aborts the manager controller only when no waiter remains. Clear `refreshPromise` in the existing generation-checked `finally`.

Give `ActiveSignIn` its own token-exchange `AbortController`, pass its signal into authorization-code exchange, and abort it from the existing `rejectActive`/sign-out path before loopback cleanup. Do not reuse a caller-owned refresh controller for sign-in.

On sign-out or lifecycle invalidation, abort the current refresh flight's manager-owned controller before clearing credentials. The generation checks remain authoritative if a non-cooperative fetch resolves after abort.

Wrap `postToken` with a 60-second manager timer and pass the combined manager signal to `fetchToken`. Map caller/lifecycle abort to `token_request_cancelled`, timer abort to `token_request_timeout`, and all other failures to `token_exchange_failed`. Do not add retry logic.

- [ ] **Step 4: Map OAuth timeout and cancellation in the HTTP client**

In `ChatGptHttpClient.mapError`, add:

```ts
if (error instanceof OAuthError && error.code === "token_request_timeout") {
  return new CodexError("timeout", { cause: error });
}
if (error instanceof OAuthError && error.code === "token_request_cancelled") {
  return new CodexError("cancelled", { cause: error });
}
```

Keep the existing caller-context check before this mapping so an HTTP request timeout remains distinguishable from an explicit cancellation.

- [ ] **Step 5: Run OAuth tests, then full check**

```powershell
npm run compile
node --test out/test/unit/oauth-manager.test.js out/test/unit/http-client.test.js out/test/integration/oauth-transport.test.js
npm run check
```

Expected: all pass; concurrent refresh tests observe one token fetch and no automatic retry.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/transports/chatgpt-oauth/oauth-manager.ts src/transports/chatgpt-oauth/http-client.ts test/unit/oauth-manager.test.ts test/unit/http-client.test.ts
git commit -m "fix(oauth): bound shared token refresh requests"
```

---

### Task 3: Preserve the loopback listener after wrong-state callbacks

**Files:**
- Modify: `test/integration/loopback-server.test.ts`
- Modify: `test/unit/oauth-manager.test.ts`
- Modify: `src/transports/chatgpt-oauth/loopback-server.ts`
- Modify: `src/transports/chatgpt-oauth/oauth-manager.ts`

**Interfaces:**
- Produces: `LoopbackServer.start(expectedState: string): Promise<LoopbackServerHandle>`.
- Preserves: five-minute timeout and fallback ports `1455`, `1457`.

- [ ] **Step 1: Add wrong-state and keep-alive RED regressions**

Add an HTTP integration test that starts the server with `expected-state`, sends a wrong-state callback, asserts HTTP 400, then sends the correct state and awaits the same handle's callback. Assert the timeout is not reset by the wrong request.

Add this assertion to the response helper path:

```ts
assert.equal(firstResponse.headers.connection, "close");
```

Use a keep-alive `http.Agent` and assert the correct callback plus `handle.close()` completes within 500 ms on the local test server.

- [ ] **Step 2: Run the loopback tests and record RED**

```powershell
npm run compile
node --test out/test/integration/loopback-server.test.js out/test/unit/oauth-manager.test.js
```

Expected: FAIL because the first valid-path request consumes the callback before OAuthManager validates state, and responses do not force connection close.

- [ ] **Step 3: Move state prevalidation into the loopback boundary**

Change both the interface and implementation:

```ts
export interface LoopbackServer {
  start(expectedState: string): Promise<LoopbackServerHandle>;
}
```

Pass `active.state` from `OAuthManager.signIn`. In `acceptCallback`, before `callbackSettled = true`, require exactly one non-empty `state` query value and compare it to `expectedState`. For mismatch, send a 400 response and return without closing the server or changing the existing timeout.

Add this header to every loopback response:

```ts
"connection": "close",
```

Keep OAuthManager's full constant-time state validation as defense in depth. Update fake loopback servers to accept and record the expected state.

Replace timeout message matching with a structured loopback error:

```ts
export type LoopbackErrorCode =
  | "callback_timeout"
  | "callback_close_failed"
  | "callback_response_failed";
```

The timeout handler rejects with `new LoopbackError("callback_timeout", "OAuth callback server timed out.")`; `OAuthManager.loopbackError` maps that code to `OAuthError("callback_timeout")` and no longer inspects `error.message`.

- [ ] **Step 4: Verify callback lifecycle and commit**

```powershell
npm run compile
node --test out/test/integration/loopback-server.test.js out/test/unit/oauth-manager.test.js
npm run check
git add src/transports/chatgpt-oauth/loopback-server.ts src/transports/chatgpt-oauth/oauth-manager.ts test/integration/loopback-server.test.ts test/unit/oauth-manager.test.ts
git commit -m "fix(oauth): validate callback state before consuming listener"
```

---

### Task 4: Align Local model refresh, silent discovery, and Windows executable selection

**Files:**
- Modify: `test/integration/app-server-session.test.ts`
- Modify: `test/integration/app-server-transport.test.ts`
- Modify: `test/unit/executable-locator.test.ts`
- Modify: `test/extension/suite/commands.test.ts`
- Modify: `test/extension/suite/provider.test.ts`
- Modify: `src/transports/app-server/app-server-session.ts`
- Modify: `src/transports/app-server/app-server-transport.ts`
- Modify: `src/transports/app-server/executable-locator.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: `AppServerTransportSession.listModels(forceRefresh?: boolean)`.
- Produces: `AppServerSession.listModels(forceRefresh = false)`.
- Preserves: shared Provider model discovery remains independent of any one caller's cancellation signal.

- [ ] **Step 1: Add RED tests for force refresh and one provider event**

Add a session/transport test with a mutable model response:

```ts
assert.equal((await transport.listModels({ silent: false }, signal))[0]?.id, "old");
available = [refreshedModel];
assert.equal((await transport.listModels({ silent: false }, signal))[0]?.id, "old");
assert.equal((await transport.listModels({ silent: false, forceRefresh: true }, signal))[0]?.id, "new");
```

Extract a `createLocalModelCatalogServices` helper in `extension.ts`, mirroring the existing ChatGPT helper, so the command suite can assert:

```ts
assert.equal(await services.refresh(), 1);
assert.equal(changeEvents, 1);
services.clear();
assert.equal(changeEvents, 2);
```

Retain the existing provider regression proving cancellation of the first caller does not abort the shared loader.

- [ ] **Step 2: Add RED tests for silent failure and Windows PATH discovery**

Add:

```ts
assert.deepEqual(
  await transport.listModels({ silent: true }, new AbortController().signal),
  [],
);
```

when session startup throws a recoverable `CodexError("process")`, while `{ silent: false }` still rejects.

For Windows locator tests, make both `C:\bin\codex` and `C:\bin\codex.exe` appear as files and assert automatic discovery returns only `codex.exe`. Keep a separate test proving an explicitly configured absolute extensionless file is returned unchanged.

- [ ] **Step 3: Run focused tests and record RED**

```powershell
npm run compile
node --test out/test/unit/executable-locator.test.js out/test/integration/app-server-session.test.js out/test/integration/app-server-transport.test.js
npm run test:extension
```

Expected: force refresh returns cached data, silent Local discovery rejects, Windows automatic discovery may select `codex`, and Local commands do not emit the Provider change event.

- [ ] **Step 4: Implement minimal cache-option propagation**

Change the interfaces and methods as follows:

```ts
listModels(forceRefresh = false): Promise<readonly CodexModel[]> {
  if (forceRefresh) {
    this.modelCache.clear();
  }
  return this.listModelsInternal();
}
```

Forward `options.forceRefresh === true` from `AppServerTransport.listModels`. For `options.silent === true`, return `[]` only for typed `process`, `authRequired`, or `incompatible` availability errors; do not hide `protocol`, tool, or security-boundary failures.

Create `createLocalModelCatalogServices(provider, session, providerCache, transportCache)` and use it for command refresh/clear. It clears both caches and calls `provider.invalidateModelInformation()` exactly once per operation.

Use this shape so command code can still read account metadata after refresh:

```ts
export const createLocalModelCatalogServices = (
  provider: CodexLanguageModelProvider,
  session: Pick<AppServerSession, "listModels">,
  providerCache: ModelCache,
  transportCache: ModelCache,
) => ({
  refresh: async (): Promise<number> => {
    providerCache.clear();
    transportCache.clear();
    const models = await session.listModels(true);
    provider.invalidateModelInformation();
    return models.length;
  },
  clear: (): void => {
    providerCache.clear();
    transportCache.clear();
    provider.invalidateModelInformation();
  },
});
```

- [ ] **Step 5: Restrict automatic Windows candidates**

Change automatic Windows candidates to:

```ts
const candidateNames = (platform: NodeJS.Platform): readonly string[] =>
  platform === "win32" ? ["codex.exe"] : ["codex"];
```

Do not apply this restriction to `configuredExecutable`; explicit absolute files remain supported and spawn failures retain their typed `spawnCodex` diagnostic.

- [ ] **Step 6: Verify and commit Task 4**

```powershell
npm run check
npm run test:extension
git add src/extension.ts src/transports/app-server/app-server-session.ts src/transports/app-server/app-server-transport.ts src/transports/app-server/executable-locator.ts test/integration/app-server-session.test.ts test/integration/app-server-transport.test.ts test/unit/executable-locator.test.ts test/extension/suite/commands.test.ts test/extension/suite/provider.test.ts
git commit -m "fix(models): align local refresh and executable discovery"
```

---

### Task 5: Apply Hard gate 1 to tool-continuation lifecycle

**Files:**
- Modify first: `test/integration/app-server-write-tool-continuation.test.ts`
- Conditional modify: `src/transports/app-server/app-server-transport.ts`
- Conditional modify only with explicit evidence: `src/transports/app-server/tool-continuations.ts`

**Interfaces:**
- Preserves: supplied tool call → Copilot result → original App Server continuation.
- Gate output: either a test-only PASS record or one minimal transport cleanup fix.

- [ ] **Step 1: Add the timeout-retention regression without production changes**

Add `releaseCount` to `WriteContinuationLease.release`. Construct the registry with a 20 ms timeout and make the pending tool promise observable without an unhandled rejection:

```ts
public releaseCount = 0;
public release(): void {
  this.releaseCount += 1;
}
```

Change the existing fire-and-forget continuation observer to terminate its own rejection chain safely while leaving `pendingToolCall` itself assertable:

```ts
void this.pendingToolCall.then(() => {
  // existing delta and turn/completed notifications
}).catch(() => undefined);
```

Add:

```ts
test("tool timeout releases the retained write turn and lease exactly once", async () => {
  const session = new WriteContinuationSession();
  const registry = new ToolContinuationRegistry({ timeoutMs: 20 });
  const transport = new AppServerTransport(session, registry);
  try {
    assert.equal((await collect(transport.generate(
      request([{ role: "user", parts: [{ kind: "text", text: "Edit ABAP." }] }], "timeout-1"),
      new AbortController().signal,
    )))[0]?.type, "tool-call");
    await assert.rejects(session.lease.pendingToolCall as Promise<unknown>);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(registry.size, 0);
    assert.equal(session.lease.releaseCount, 1);
  } finally {
    await transport.dispose();
  }
});
```

Also assert the existing successful write continuation still has `releaseCount === 1` only after the continuation emits `completed`.

Add a `completeTurn()` helper to `WriteContinuationLease` that emits its registered `turn/completed` notification. Add a second regression that surfaces the tool, calls `completeTurn()` before any Copilot result, waits one microtask, and observes whether the pending tool promise, registry, and lease settle. This is lifecycle evidence only: because early server completion is not the established successful write flow, a failure in only this regression is recorded as a follow-up under Hard gate 1 rather than automatically expanding production scope.

- [ ] **Step 2: Run the regression and enforce Hard gate 1**

```powershell
npm run compile
node --test out/test/integration/app-server-write-tool-continuation.test.js
```

Decision:

- PASS: do not change production lifecycle code; commit only the regression and record `Hard gate 1: PASS → no production change` in the commit body.
- FAIL with `releaseCount === 0`: continue to Step 3 because this directly retains the current ABAP write flow.
- FAIL only in the early-server-completion evidence test: record the result and stop this subcase with no production change unless a real current write-flow trace proves it occurs.
- Any failure requiring a registry redesign or new production file: stop execution and report to the user.

- [ ] **Step 3: If permitted, terminate the transport state from the existing reject boundary**

In `handleToolRequest`, wrap the registry rejection callback without changing registry schema. Defer transport cleanup by one microtask so `ToolContinuationRegistry.terminate` can finish `removeState` before `terminateState` calls back into registry cleanup:

```ts
reject: (error) => {
  reject(error);
  queueMicrotask(() => {
    if (!state.cleaned && !state.cleanupStarted) {
      void this.terminateState(state, error, !state.terminal);
    }
  });
},
```

Do not add terminal callback APIs. Rely on existing idempotent `terminateState`, `registry.cancel`, unsubscribe, interrupt, and lease release behavior.

- [ ] **Step 4: Verify all continuation terminal paths**

```powershell
npm run compile
node --test out/test/integration/app-server-write-tool-continuation.test.js out/test/integration/app-server-transport.test.js out/test/integration/app-server-required-tools.test.js out/test/integration/app-server-session-lease.test.js
npm run check
```

Expected: timeout, completion, failure, cancellation, and process exit release exactly once; successful ABAP edit continuation is unchanged.

- [ ] **Step 5: Commit the gate outcome**

If production changed:

```powershell
git add src/transports/app-server/app-server-transport.ts test/integration/app-server-write-tool-continuation.test.ts
git commit -m "fix(lifecycle): release timed-out tool continuations"
```

If production did not change:

```powershell
git add test/integration/app-server-write-tool-continuation.test.ts
git commit -m "test(lifecycle): verify continuation timeout cleanup"
```

---

### Task 6: Strengthen precise metadata redaction

**Files:**
- Modify: `test/unit/redact.test.ts`
- Modify: `src/security/redact.ts`

**Interfaces:**
- Produces: unchanged `redactMetadata(value: unknown): unknown` with exact-key and safe value-pattern handling.

- [ ] **Step 1: Add RED tests for gaps and safe fields**

```ts
test("redacts exact credential fields and URI userinfo without hiding safe diagnostics", () => {
  assert.deepEqual(redactMetadata({
    apiKey: "sk-project-secret",
    credential: "private-value",
    authorizationHeader: "Bearer bearer-secret",
    proxyUrl: "http://user:pass@proxy.example:7897/path?q=1",
    detail: "request used Authorization: Bearer bearer-secret",
    code: "requiredToolMissing",
    accountType: "chatgpt",
    modelId: "gpt-test",
  }), {
    apiKey: "[REDACTED]",
    credential: "[REDACTED]",
    authorizationHeader: "[REDACTED]",
    proxyUrl: "http://proxy.example:7897/path",
    detail: "request used Authorization: Bearer [REDACTED]",
    code: "requiredToolMissing",
    accountType: "chatgpt",
    modelId: "gpt-test",
  });
});
```

Add nested arrays, cycles, lowercase `bearer`, and non-token strings containing `sk` to prevent over-redaction.

- [ ] **Step 2: Run RED**

```powershell
npm run compile
node --test out/test/unit/redact.test.js
```

Expected: credential fields and URI userinfo remain visible.

- [ ] **Step 3: Implement exact-field and value-pattern redaction**

Keep the current broad content markers. Add normalized exact sensitive keys such as `apikey`, `credential`, `clientsecret`, and `authorizationheader`; do not add generic `key`, `code`, `state`, `account`, or `email` substring markers.

For URI-like values, parse with `URL`, clear `username`, `password`, `search`, and `hash`, then serialize. Fall back to existing query/fragment truncation when parsing fails. In remaining metadata strings, replace bounded `Bearer <token>` and `sk-<secret>` substrings with `[REDACTED]`; do not redact unrelated `sk` text or expose the surrounding sensitive content fields, which remain key-redacted as before.

- [ ] **Step 4: Verify and commit**

```powershell
npm run compile
node --test out/test/unit/redact.test.js out/test/integration/security-boundary.test.js
npm run check
git add src/security/redact.ts test/unit/redact.test.ts
git commit -m "fix(security): strengthen metadata redaction"
```

---

### Task 7: Calibrate and enforce JSONL/SSE framing limits

**Files:**
- Create: `test/fixtures/protocol-payload-sizes.json`
- Modify: `test/unit/jsonl-rpc-client.test.ts`
- Modify: `test/unit/sse-parser.test.ts`
- Modify: `src/transports/app-server/jsonl-rpc-client.ts`
- Modify: `src/transports/chatgpt-oauth/sse-parser.ts`

**Interfaces:**
- Produces: `JsonlRpcClientOptions.maxLineChars?: number`.
- Produces: `ResponsesSseParserOptions.maxPendingChars?: number` and `constructor(logger?: ResponsesSseLogger, options?: ResponsesSseParserOptions)` so the existing logger-only call remains valid.

- [ ] **Step 1: Record payload-size calibration evidence**

Create a JSON fixture containing byte counts for the repository icon and synthetic tool images at 1, 4, 8, and 16 MiB after base64 plus JSON envelope encoding:

```json
{
  "source": "deterministic image-bearing tool-result envelopes",
  "measurements": [
    { "rawBytes": 127111, "jsonlChars": 169622 },
    { "rawBytes": 1048576, "jsonlChars": 1398242 },
    { "rawBytes": 4194304, "jsonlChars": 5592546 },
    { "rawBytes": 8388608, "jsonlChars": 11184950 },
    { "rawBytes": 16777216, "jsonlChars": 22369762 }
  ],
  "p50JsonlChars": 5592546,
  "p95JsonlChars": 22369762,
  "maxJsonlChars": 22369762,
  "formula": "data URL base64 length plus JSON-RPC envelope",
  "selectedJsonlLimitChars": 33554432,
  "selectedSsePendingLimitChars": 16777216
}
```

Before production changes, verify with a one-off Node expression that every generated envelope below the selected limit fits and the 16 MiB raw fixture demonstrates the boundary. If actual envelope measurements contradict these limits, stop and revise the fixture and design evidence before implementation.

- [ ] **Step 2: Add RED boundary tests**

For JSONL, construct the client with `{ maxLineChars: 32 }`, push 33 characters without a newline, and assert termination with `CodexError("protocol")`. Also push a valid 31-character JSON line and assert it parses.

For SSE, construct with `new ResponsesSseParser(undefined, { maxPendingChars: 64 })`, push an unterminated 65-character frame, and assert a typed protocol failure. Add a second test that sends individually valid argument-delta frames whose accumulated `argumentsText` exceeds 64 characters. Because the parser currently returns events rather than throwing typed errors, define the approved minimal behavior as throwing `CodexError("protocol", { action: "parseChatGptSse" })`; the existing transport generator may propagate this typed error unchanged.

Add remote-failure tests with safe payloads:

```ts
assert.throws(
  () => parser.push('event: error\ndata: {"error":{"code":"rate_limit_exceeded","status":429,"message":"private"}}\n\n'),
  (error: unknown) => error instanceof CodexError
    && error.code === "rateLimited"
    && !String(error).includes("private"),
);
```

Map only allow-listed code/status categories: 401/403 → `unauthorized`, 429 or known rate-limit code → `rateLimited`, 408/504 → `timeout`, 5xx → `network`, and everything else → `protocol`. Never attach the remote message as cause or metadata.

- [ ] **Step 3: Run RED**

```powershell
npm run compile
node --test out/test/unit/jsonl-rpc-client.test.js out/test/unit/sse-parser.test.js
```

Expected: constructors reject unknown options or buffers grow past the test limits.

- [ ] **Step 4: Implement limits before retaining oversized strings**

Validate positive finite integer options. In JSONL `handleData`, after appending and draining complete lines, terminate if the remaining unterminated `lineBuffer.length` exceeds the configured limit. Also reject any complete line whose length exceeds the limit before `JSON.parse`.

In SSE `push` and `finish`, drain complete frames first, then reject if the remaining `pending.length` exceeds the configured limit. Apply the same bound to accumulated function-call `argumentsText` across delta frames. Clear pending/function-call state on failure. Do not include payload data in errors or logs.

- [ ] **Step 5: Verify chunking, Unicode, and large valid envelopes**

```powershell
npm run compile
node --test out/test/unit/jsonl-rpc-client.test.js out/test/unit/sse-parser.test.js out/test/integration/app-server-write-tool-continuation.test.js out/test/integration/oauth-transport.test.js
npm run check
```

- [ ] **Step 6: Commit Task 7**

```powershell
git add test/fixtures/protocol-payload-sizes.json test/unit/jsonl-rpc-client.test.ts test/unit/sse-parser.test.ts src/transports/app-server/jsonl-rpc-client.ts src/transports/chatgpt-oauth/sse-parser.ts
git commit -m "fix(protocol): bound JSONL and SSE frame buffers"
```

If implementation unexpectedly requires an `oauth-transport.ts` change rather than propagation of the typed parser error, stop before staging and report the production-file expansion.

---

### Task 8: Expand safe diagnostics without weakening typing

**Files:**
- Modify: `test/extension/suite/commands.test.ts`
- Modify: `src/commands/diagnostics.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Preserves: `DiagnosticsHistory.snapshot(): readonly CodexErrorCode[]`.
- Produces: `DiagnosticsHistory.unknownErrorCount(): number` and `DiagnosticsSnapshot.unknownErrorCount`.

- [ ] **Step 1: Add RED diagnostics tests**

```ts
const history = new DiagnosticsHistory();
history.record(new CodexError("requiredToolMissing"));
history.record(new Error("private failure"));
assert.deepEqual(history.snapshot(), ["requiredToolMissing"]);
assert.equal(history.unknownErrorCount(), 1);
```

Assert the JSON report contains `unknownErrorCount: 1` and never contains the unknown error message.

- [ ] **Step 2: Run RED**

```powershell
npm run compile
npm run test:extension
```

Expected: `requiredToolMissing` is discarded and no unknown counter exists.

- [ ] **Step 3: Implement the separate unknown counter**

Add `requiredToolMissing` to `SAFE_ERROR_CODES`. Increment `unknownCount` as `Math.min(MAX_ERROR_CODES, unknownCount + 1)` only when an error is non-cancelled and has no safe code. Reset it in `clear`. Add `unknownErrorCount()` without changing `snapshot()` typing. Add `unknownErrorCount` to `DiagnosticsSnapshot` and report output, populated by `extension.ts`.

- [ ] **Step 4: Verify and commit**

```powershell
npm run check
npm run test:extension
git add src/commands/diagnostics.ts src/extension.ts test/extension/suite/commands.test.ts
git commit -m "fix(diagnostics): report required-tool and unknown failures safely"
```

---

### Task 9: Add bounded MIME-aware image token estimates

**Files:**
- Modify: `test/extension/suite/provider.test.ts`
- Modify: `src/providers/token-count.ts`

**Interfaces:**
- Preserves: `countTokens(text | message): number`.
- Produces: image estimates in the inclusive range 256–2048 tokens based on encoded byte-size buckets.

- [ ] **Step 1: Add RED token-count tests**

Extend `countsTokens` with direct and tool-result image parts:

```ts
const messageWith = (part: vscode.LanguageModelDataPart): vscode.LanguageModelChatRequestMessage => ({
  role: vscode.LanguageModelChatMessageRole.User,
  name: undefined,
  content: [part],
});
const smallImage = new vscode.LanguageModelDataPart(new Uint8Array(32_000), "image/png");
const largeImage = new vscode.LanguageModelDataPart(new Uint8Array(2_000_000), "image/jpeg");
const binary = new vscode.LanguageModelDataPart(new Uint8Array(32_000), "application/pdf");
assert.equal(await provider.provideTokenCount(modelInfo, messageWith(smallImage), cancellation.token), 256);
assert.equal(await provider.provideTokenCount(modelInfo, messageWith(largeImage), cancellation.token), 2048);
assert.equal(await provider.provideTokenCount(modelInfo, messageWith(binary), cancellation.token), 1);
```

Add a tool-result test proving the image data is counted once and is not serialized as a huge `Uint8Array` object.

- [ ] **Step 2: Run RED**

```powershell
npm run compile
npm run test:extension
```

Expected: direct images count as the minimum one token and tool-result data is inconsistently serialized.

- [ ] **Step 3: Implement explicit content-part accounting**

Use these fixed buckets:

```ts
const imageTokens = (bytes: number): number => {
  if (bytes <= 64 * 1024) return 256;
  if (bytes <= 512 * 1024) return 512;
  if (bytes <= 1024 * 1024) return 1024;
  return 2048;
};
```

Count `LanguageModelDataPart` only when `mimeType.startsWith("image/")`. For `LanguageModelToolResultPart`, count safe serialized call metadata plus each text/image content part individually; do not JSON-stringify image byte arrays. Preserve the minimum return value of one.

- [ ] **Step 4: Verify and commit**

```powershell
npm run check
npm run test:extension
git add src/providers/token-count.ts test/extension/suite/provider.test.ts
git commit -m "fix(tokens): estimate image parts with bounded buckets"
```

---

### Task 10: Await one idempotent extension shutdown

**Files:**
- Modify: `test/extension/suite/commands.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: `createIdempotentAsyncDisposer(dispose: () => Promise<void>): () => Promise<void>`.
- Produces: `deactivate(): Promise<void>`.

- [ ] **Step 1: Add RED tests for shared cleanup and fast normal completion**

```ts
let calls = 0;
let release!: () => void;
const pending = new Promise<void>((resolve) => { release = resolve; });
const dispose = createIdempotentAsyncDisposer(async () => {
  calls += 1;
  await pending;
});
const first = dispose();
const second = dispose();
assert.equal(first, second);
assert.equal(calls, 1);
release();
await first;
```

Add an extension-level test double showing a responsive transport cleanup resolves without waiting for an artificial timer. Existing ProcessSupervisor tests continue to own the approximately seven-second stuck upper bound.

- [ ] **Step 2: Run RED**

```powershell
npm run compile
npm run test:extension
```

Expected: helper/export does not exist and `deactivate` returns void.

- [ ] **Step 3: Centralize transport ownership**

Implement the helper exactly once in `extension.ts`:

```ts
export const createIdempotentAsyncDisposer = (
  dispose: () => Promise<void>,
): (() => Promise<void>) => {
  let operation: Promise<void> | undefined;
  return () => {
    operation ??= Promise.resolve().then(dispose);
    return operation;
  };
};
```

Add a module-scoped active cleanup function. During activation, create one disposer around:

```ts
await Promise.allSettled([
  chatGptTransport.dispose(),
  localTransport.dispose(),
]);
```

Push a synchronous VS Code disposable that starts this same promise:

```ts
context.subscriptions.push({ dispose: () => { void disposeExtension(); } });
```

Remove the transports themselves from `context.subscriptions` to avoid separate unawaited disposal calls. Export:

```ts
export async function deactivate(): Promise<void> {
  await activeExtensionDisposal?.();
}
```

Use `context.subscriptions.push({ dispose: () => { void disposeExtension().catch(() => undefined); } });`. Keep the module-scoped disposer reference until `deactivate` has awaited it; then clear it only when it still refers to that same activation. Do not shorten ProcessSupervisor's existing kill bounds or add a fast-abandon path.

- [ ] **Step 4: Verify and commit**

```powershell
npm run check
npm run test:extension
git add src/extension.ts test/extension/suite/commands.test.ts
git commit -m "fix(lifecycle): await idempotent extension shutdown"
```

---

### Task 11: Apply Hard gate 2 to reusable proxy-aware Agents

**Files:**
- Create: `scripts/benchmark-proxy-agent.mjs`
- Create: `docs/superpowers/verification/2026-08-25-proxy-agent-benchmark.md`
- Conditional production files: none approved until benchmark review.

**Interfaces:**
- Gate output: benchmark evidence and either no production change or a user-approved follow-up file list.

- [ ] **Step 1: Create a deterministic local benchmark**

The script must start local origin and proxy servers, issue 100 sequential requests in each mode, and record connection count, median latency, total duration, cancellation latency, and shutdown latency for:

```js
const modes = [
  "current-direct-per-request-agent",
  "candidate-direct-shared-agent",
  "current-proxy-per-request-agent",
  "candidate-proxy-shared-agent",
  "candidate-no-proxy-bypass",
];
```

It must not contact ChatGPT, SAP, or any external host. Candidate Agent code remains inside the benchmark script.

Implement the benchmark around these concrete primitives:

```js
import { Agent, createServer, request } from "node:http";
import { performance } from "node:perf_hooks";

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1] ?? 0;
};

const once = (url, agent, signal) => new Promise((resolve, reject) => {
  const started = performance.now();
  const outgoing = request(url, { agent, signal }, (response) => {
    response.resume();
    response.once("end", () => resolve(performance.now() - started));
  });
  outgoing.once("error", reject);
  outgoing.end();
});

const runMode = async ({ name, target, proxyEnv, shared }) => {
  const sharedAgent = shared ? new Agent({ keepAlive: true, proxyEnv }) : undefined;
  const latencies = [];
  for (let index = 0; index < 100; index += 1) {
    const agent = sharedAgent ?? new Agent({ keepAlive: true, proxyEnv });
    latencies.push(await once(target, agent));
    if (!shared) agent.destroy();
  }
  const shutdownStarted = performance.now();
  sharedAgent?.destroy();
  return {
    name,
    medianMs: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    totalMs: latencies.reduce((sum, value) => sum + value, 0),
    shutdownMs: performance.now() - shutdownStarted,
  };
};
```

The complete script adds local origin/proxy `connection` counters, a `/slow` cancellation route, `NO_PROXY` direct-origin assertions, three internal rounds per invocation, `try/finally` server closure, and JSON table output. Treat a connection count mismatch or a route-isolation assertion as a failed gate, not benchmark noise.

- [ ] **Step 2: Run three benchmark rounds and record evidence**

```powershell
node scripts/benchmark-proxy-agent.mjs
node scripts/benchmark-proxy-agent.mjs
node scripts/benchmark-proxy-agent.mjs
```

Copy raw tables and medians into the verification Markdown file. Record environment versions from `node --version` and `$PSVersionTable.PSVersion`.

- [ ] **Step 3: Enforce Hard gate 2**

Gate is satisfied only when all three rounds consistently reduce connections or handshake/median latency, cancellation and shutdown do not materially regress, explicit proxy stays isolated, and `NO_PROXY` reaches origin directly.

- Gate not satisfied: commit benchmark evidence only with `perf(network): record rejected agent reuse experiment`; make no production change.
- Gate satisfied: stop and report the measured result plus the proposed exact production files (`proxy-fetch.ts`, its tests, and any required owner/disposal file). Wait for explicit approval before TDD production work.
- Any requirement for a networking framework or SAP proxy-path modification: reject the candidate and make no production change.

---

### Task 12: Remove only verified dead state

**Files:**
- Modify: `src/transports/chatgpt-oauth/oauth-manager.ts`
- Modify: `src/transports/app-server/app-server-transport.ts`
- Modify: `src/constants.ts`
- Modify tests only when they directly reference a removed symbol.

**Interfaces:**
- Produces no new interface and no behavior change.

- [ ] **Step 1: Prove each symbol is unused**

```powershell
rg -n "this\.session|session:" src/transports/chatgpt-oauth/oauth-manager.ts test
rg -n "invalidLeaseIdentity" src test
rg -n "RECOGNIZED_ABAP_TOOL_NAMES" src test
```

Expected evidence:

- OAuth `session` is assigned but never read.
- `invalidLeaseIdentity` compares immutable values copied from the same lease and cannot become true.
- `RECOGNIZED_ABAP_TOOL_NAMES` has no consumer.

If any real consumer appears after earlier tasks, do not remove that symbol.

- [ ] **Step 2: Remove one symbol group at a time and compile**

Remove the OAuth session field and assignments, then run `npm run typecheck`. Remove `invalidLeaseIdentity` and its unreachable branch, then run `npm run typecheck`. Remove the stale exported constant, then run `npm run typecheck`.

- [ ] **Step 3: Run complete regression and commit**

```powershell
npm run check
npm run test:extension
git add src/transports/chatgpt-oauth/oauth-manager.ts src/transports/app-server/app-server-transport.ts src/constants.ts
git commit -m "chore: remove verified dead state"
```

---

### Task 13: Release verification and VSIX packaging

**Files:**
- Modify only if already approved by the user: `package.json`, `package-lock.json`, `README.md`, release notes.
- Create: final verification record under `docs/superpowers/verification/` if the repository keeps verification artifacts.

**Interfaces:**
- Produces: tested VSIX and an evidence-backed release decision.

- [ ] **Step 1: Verify repository scope**

```powershell
git status --short
git diff main...HEAD --stat
git log --oneline main..HEAD
```

Confirm unrelated `.vscode/` and external review files remain untouched.

- [ ] **Step 2: Run automated verification from clean output**

```powershell
npm run clean
npm run check
npm run test:extension
npm run package:vsix
```

Expected: all commands exit 0 and a versioned VSIX appears under `dist/`.

- [ ] **Step 3: Run mandatory manual smoke tests**

Record actual outcomes for:

1. Missing Local executable → safe failure → corrected path → successful retry without reload.
2. Local model refresh updates the Copilot model picker once.
3. ChatGPT OAuth sign-in, wrong-state request resilience, cancellation, restart persistence, and model refresh.
4. ChatGPT-only proxy plus SAP/ABAP FS bypass configuration.
5. Copilot Agent opens an `adt://` object, receives supplied edit tools, performs edit, returns tool result, continues the model turn, and activates through ABAP FS/ADT.
6. Extension reload with a responsive Local child leaves no child process.

- [ ] **Step 4: Apply verification-before-completion**

Review fresh command outputs, test counts, VSIX path, both hard-gate outcomes, and manual results. Do not claim completion or publish if any mandatory item is missing.

- [ ] **Step 5: Commit approved release metadata only**

Use the version explicitly approved at execution time. Do not infer a release version or push/tag/release without a separate user instruction.
