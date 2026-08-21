# Security

## Trust boundaries

- GitHub Copilot/VS Code owns tool approval and execution.
- This extension never executes shell commands, patches, SAP writes/activations, ADT MCP calls, or App Server native tools.
- The Local route starts only `codex app-server --listen stdio://` with a fixed argument list and a read-only/no-approval safety profile.
- OAuth and Local routes do not share credentials, caches, process state, continuations, or fallback behavior.

## Credentials

- ChatGPT OAuth uses PKCE and loopback callbacks on `127.0.0.1`, trying ports 1455 then 1457.
- OAuth tokens are stored only under this extension's VS Code SecretStorage key.
- The extension does not accept an OpenAI API key and does not implement the official OpenAI API.
- The extension does not read, import, copy, or log Codex CLI authentication files such as `~/.codex/auth.json`.
- The Local route relies on the Codex CLI/App Server to use its own existing ChatGPT login.

## Data minimization

- Logs and diagnostics are structurally redacted and bounded.
- Do not log account email, access/refresh tokens, Cookie values, prompts, source text, tool bodies, raw stderr, SAP connection authority, or callback URLs.
- SAP context uses only stable VS Code APIs, the active URI, a bounded non-empty selection, bounded diagnostics, and extension-presence booleans.
- Untrusted SAP context is placed in an escaped JSON data envelope and explicitly labelled as data, not instructions.

## App Server containment

Each thread is ephemeral with `approvalPolicy: never` and `sandbox: read-only`. Shell/unified execution, file changes, web/browser/computer use, image generation, apps/plugins and multi-agent features are disabled. Approval requests are answered `deny`; command/file items trigger turn interruption. Only dynamic tools declared by the current Copilot request are accepted, and their results return through Copilot continuation.

## Private-interface warning

The ChatGPT OAuth route calls a private ChatGPT Codex interface that may change without notice. This project provides no guarantee of endpoint stability or continued account compatibility. Do not use it as a security boundary for high-risk production automation.

## Reporting

Report vulnerabilities privately to the project owner. Include the extension version, VS Code version, safe error code, and minimal reproduction. Do not attach real tokens, account identity, SAP authority, source code, tool payloads, or raw private-backend responses.
