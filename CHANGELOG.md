# Changelog

## 0.1.9 — 2026-08-24

- Fixed ChatGPT OAuth Fast mode by encoding the user-facing `fast` choice as the private backend's `service_tier: priority` value while continuing to omit the field for `modelDefault`.
- Added `Configure SAP Proxy Bypass` to the Manager; it explicitly merges SAP hosts into the VS Code user-level `http.noProxy` list without changing system proxy or process environment variables.
- Documented the boundary between VS Code `http.noProxy`, inherited `NO_PROXY`, Clash/Mihomo `DIRECT` rules, and independent ABAP FS/SAP ADT child processes.

## 0.1.8 — 2026-08-24

- Changed the Marketplace package identity to `leonbwang.codex-copilot-provider-for-sap` because the removed original identity is permanently reserved.
- Changed the Marketplace display name to `Codex Copilot Manager for SAP`; command IDs, provider IDs and settings keys remain unchanged.
- Added first-use ChatGPT proxy onboarding in `Codex Copilot Manager` plus a reusable `Configure ChatGPT Proxy` action.
- Documented Clash/Mihomo, environment-proxy fallback, Local CLI isolation, and SAP/ABAP FS `NO_PROXY` guidance without modifying system proxy settings.

## 0.1.7 — 2026-08-23

- Added per-request ChatGPT OAuth reasoning overrides: model default, none, low, medium, high, xhigh and max.
- Added an independent ChatGPT OAuth Fast service setting; reasoning effort and Fast can be combined.
- Leaving either setting at `modelDefault` omits the corresponding request field and preserves backend defaults.
- Replaced the command-palette command list with one `Codex Copilot Manager` Quick Pick while keeping existing internal command IDs registered for compatibility.
- Updated the quick start, settings reference and acceptance guidance for the Manager workflow.

## 0.1.6 — 2026-08-23

- Added an optional `copilotCodex.chatgpt.proxyUrl` setting used only by ChatGPT token exchange, token refresh, model discovery and responses.
- A configured ChatGPT proxy now overrides inherited proxy environment variables without mutating the VS Code process environment or affecting ABAP FS/SAP connections.
- Empty proxy configuration preserves the 0.1.5 environment-proxy fallback.

## 0.1.5 — 2026-08-23

- ChatGPT OAuth requests now honor `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` without changing global proxy state.
- Successful ChatGPT sign-in and manual callback completion now refresh the model catalog and notify Copilot with the actual model count.
- Existing ChatGPT sessions now restore the model catalog after VS Code reload without requiring another login.
- Startup restore failures remain non-interactive, preserve the stored session and record only safe diagnostics.

## 0.1.4 — 2026-08-22

- Local CLI now enforces Copilot required-tool turns instead of silently dropping `toolMode=required`.
- Added explicit Copilot-mediated ABAP write guidance while keeping native App Server file and command actions blocked.
- Added current-turn SAP capability classification for workspace URI resolution, create/edit, diagnostics and activation tools without filtering supplied tools.
- Added metadata-only lifecycle diagnostics for requested/surfaced tools, returned results, continuation resume and interrupted pending results.
- Added regression coverage for write-capable dynamic-tool continuation; `approvalPolicy: never` and `sandbox: read-only` remain unchanged.

## 0.1.3 — 2026-08-21

- Fixed Local CLI replies for current App Server nested turn notifications, per-item final-answer reconciliation, strict completion statuses, final-message-only responses, and current dynamic-tool request fields.

## 0.1.2 — 2026-08-21

- Restored Local CLI model discovery for the current official App Server `model/list` response shape.
- Added conservative Copilot token-budget fallbacks when App Server models omit token limits while preserving valid legacy limits.
- Advertised Copilot tool calling only after the dynamic-tools probe succeeds, rejected malformed explicit tool metadata, and applied the official legacy image-modality default.

## 0.1.1 — 2026-08-21

- Fixed Local CLI startup with current Codex App Server initialize responses that do not echo client capabilities.
- Accepted the current finite numeric `emittedAtMs` metadata on App Server notifications while rejecting malformed values and unknown fields.
- Kept dynamic-tools compatibility fail-closed by using the existing ephemeral read-only capability probe.

## 0.1.0 — 2026-08-21

- Added two independent Copilot language-model providers: ChatGPT OAuth and Local Codex App Server.
- Added browser OAuth PKCE with VS Code SecretStorage and manual callback completion.
- Added fixed-argv local App Server supervision, safe capability probing, model discovery and crash isolation.
- Added Copilot-owned dynamic-tool continuation with parallel calls, cancellation, generation isolation and late-result protection.
- Added bounded ABAP FS/SAP ADT active-editor context through stable VS Code APIs only.
- Added management commands, six safe settings, redacted diagnostics and model-cache controls.
- Added automated unit, integration and VS Code extension-host regression suites.

Known limitations:

- ChatGPT OAuth uses a private interface and may require updates when the backend changes.
- V1 does not use the official OpenAI API and does not connect ADT MCP.
- Real Copilot/OAuth/SAP acceptance requires the user's interactive accounts and SAP environment.
