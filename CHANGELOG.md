# Changelog

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
