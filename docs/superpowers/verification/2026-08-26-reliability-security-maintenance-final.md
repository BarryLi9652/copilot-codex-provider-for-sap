# Reliability and security maintenance verification

Date: 2026-08-26 (Asia/Shanghai)

## Release decision

**HOLD — automated verification and VSIX packaging passed; the mandatory manual smoke tests must still be run against this exact VSIX before publish or release.**

This record does not authorize a version change, push, tag, GitHub release, Marketplace publish, or merge.

## Verified source scope

- Branch: `fix/reliability-security-maintenance`
- Verified HEAD before this record: `60d0c5958eab33dbeecf8c9f07d063291d21191a`
- Merge base with `main`: `7ae9b86e77e79c6098baba328453ca80d5516939`
- Commits ahead of `main`: 13
- Worktree status before this record: clean
- Diff: 32 files, 1,978 insertions, 158 deletions
- `git diff --check`: passed with no output
- The unrelated main-worktree `.vscode/` directory and `docs/2026-08-25-deep-code-review.md` remained untracked and untouched.
- No version, README, changelog, or release metadata was changed in this maintenance branch.

## Environment

- Windows `win32-x64`
- Node.js `v24.19.0`
- npm `11.17.0`
- PowerShell `7.6.4`
- Extension test host: VS Code `1.131.0`, downloaded and launched by the repository test runner

## Fresh automated verification

All commands below were run from a clean `out/` directory in the isolated maintenance worktree.

| Command | Result | Evidence |
|---|---|---|
| `npm run clean` | PASS | Exit code 0 |
| `npm run check` | PASS | TypeScript typecheck passed; unit 147/147; integration 116/116 |
| `npm run test:extension` | PASS | Exit code 0; 41 extension-host checks passed; extension host exited with code 0 |
| `npm run package:vsix` | PASS | Exit code 0; 90 files packaged |

Artifact:

- Path: `dist/codex-copilot-provider-for-sap-0.1.9.vsix`
- Size: 292,432 bytes (285.58 KB reported by `vsce`)
- SHA-256: `A7A6BBE760975984F80BEA84305E138F49FA8E145D800665ECBBA1CF4016B140`

The extension-host run covered command registration, idempotent shutdown, Local and ChatGPT model refresh notifications, persisted ChatGPT catalog restoration, proxy onboarding and SAP bypass settings, dynamic tool forwarding, SAP virtual-tool preactivation, supplied-tool continuation, SAP context framing, cancellation, and diagnostics behavior.

## Hard-gate outcomes

### Hard gate 1 — tool-continuation lifecycle

**SATISFIED with one bounded production fix.**

- The RED timeout regression demonstrated that an expired supplied tool call could leave its retained turn and lease unreleased.
- The minimal GREEN change terminates that exact turn after the registry rejects the call.
- The successful supplied edit-tool continuation remains green and releases once only after completion.
- The early-server-completion evidence case remains recorded without changing that path because it is not established as the current write flow.
- `ToolContinuationRegistry` was not redesigned, and no callback framework, retired-call registry, tracing framework, or diagnostics architecture was added.

### Hard gate 2 — reusable proxy-aware Agents

**SATISFIED, explicitly approved, implemented within the approved file ceiling, and regression-tested.**

- The nine-round benchmark is recorded in `docs/superpowers/verification/2026-08-25-proxy-agent-benchmark.md`.
- Direct origin connections fell from 100 to 1; median latency fell from 0.718 ms to 0.161 ms.
- Explicit proxy connections fell from 100 to 1; median latency fell from 1.276 ms to 0.862 ms.
- Explicit proxy routing remained isolated, `NO_PROXY` bypassed the proxy, and cancellation/shutdown did not materially regress.
- Production follow-up reused disposable ChatGPT-only Agents and connected their disposal to the existing extension shutdown owner.
- No SAP/ABAP FS networking path was modified.

## Safety architecture verification

The approved boundaries remain intact:

- Provider does not execute Copilot-supplied tools or directly modify SAP.
- Copilot/VS Code retains approval and tool execution ownership.
- ABAP FS/ADT retains actual `adt://` write and activation ownership.
- Local App Server remains `approvalPolicy = never` and `sandbox = read-only`.
- Native file changes, command execution, shell, and patch remain unavailable.
- No MCP bypass was introduced.
- Replace tools were not implemented, wrapped, schema-modified, filtered, or given replace-specific continuation logic.
- `toolMode = required` retains the generic meaning that the turn requires at least one supplied dynamic tool call.

## Mandatory manual smoke status

The automated suites exercise the relevant code paths, but they are not substitutes for the required live VS Code, ChatGPT account, Local CLI, proxy, and SAP system checks. The current artifact has not yet been installed and manually exercised, so none of the following is counted as a release PASS yet.

| # | Required smoke | Automated evidence | Current-artifact manual result |
|---:|---|---|---|
| 1 | Missing Local executable → safe failure → corrected path → successful retry without reload | Process recovery and executable discovery regressions pass | PENDING |
| 2 | Local model refresh updates the Copilot model picker once | Local catalog refresh/notification extension checks pass | PENDING |
| 3 | ChatGPT sign-in, wrong-state resilience, cancellation, restart persistence, and model refresh | OAuth, loopback, cancellation, persistence, and catalog regressions pass | PENDING |
| 4 | ChatGPT-only proxy plus SAP/ABAP FS bypass | Proxy isolation, `NO_PROXY`, onboarding, and SAP bypass regressions pass | PENDING |
| 5 | Live `adt://` edit → supplied tool result → continued model turn → ABAP FS/ADT activation | Supplied edit-tool and write-continuation regressions pass | PENDING |
| 6 | Reload with a responsive Local child leaves no orphan | Supervisor and awaited idempotent shutdown regressions pass | PENDING |

## Final release gate

Do not publish or call this release complete until all six manual rows above are rerun against the artifact whose SHA-256 is recorded here and changed from `PENDING` to evidence-backed PASS. Any failure returns the affected batch to systematic debugging; it does not authorize broader architecture changes.
