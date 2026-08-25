# V1 testing and acceptance

## Automated commands

```powershell
npm install
npm run clean
npm run typecheck
npm run test
npm run test:extension
npm run package
npx vsce ls --tree
```

All npm downloads and test runtimes remain under the project (`.npm-cache`, `.vscode-test`). The extension test launcher removes inherited `ELECTRON_RUN_AS_NODE` only for its VS Code Electron subprocess.

## Automated release evidence — 2026-08-21

| Command | Exit | Runtime | Result |
|---|---:|---|---|
| `npm run typecheck` | 0 | TypeScript 6.0.3 | PASS |
| `npm run test:unit` | 0 | Node 24 | PASS — 101/101 |
| `npm run test:integration` | 0 | Node 24 | PASS — 94/94 |
| `npm run test:extension` | 0 | VS Code 1.131.0 | PASS — 22/22 |
| `npm run package` | 0 | VSIX 0.1.0 | PASS — package created with 82 files |
| VSIX archive inspection | 0 | `@vscode/vsce` 3.9.2 / ZIP inspection | PASS — all required files present; 0 forbidden files; no embedded source in maps |

## 0.1.1 Local CLI compatibility evidence — 2026-08-21

| Check | Exit | Result |
|---|---:|---|
| Initialize-response regression | 0 | PASS — current App Server responses without echoed client capabilities are accepted; malformed and explicitly incompatible legacy responses remain rejected |
| JSONL notification regressions | 0 | PASS — finite numeric `emittedAtMs` is accepted; non-numeric metadata and unknown fields remain rejected |
| Real Codex App Server production chain | 0 | PASS — Codex CLI `0.148.0-alpha.9` reached `running` and the read-only probe reported `dynamicTools: true` through `ProcessSupervisor` and `AppServerSession` |
| `npm run test:unit` | 0 | PASS — 103/103 |
| `npm run test:integration` | 0 | PASS — 95/95 |
| `npm run test:extension` | 0 | PASS — 22/22 |
| `npm run package` | 0 | PASS — VSIX 0.1.1 created with 82 files |

## 0.1.2 App Server model-catalog evidence — 2026-08-21

| Check | Exit | Result |
|---|---:|---|
| Current official `model/list` regression | 0 | PASS — entries without token limits receive conservative Copilot metadata; malformed explicit limits remain rejected |
| Dynamic-tools capability gate | 0 | PASS — missing model-level tool metadata is advertised only after the read-only dynamic-tools probe succeeds; malformed explicit metadata remains fail-closed |
| Legacy input modalities | 0 | PASS — missing modalities default to text and image; malformed values remain fail-closed |
| Real Codex App Server production chain | 0 | PASS — 7 models discovered, 7 tool-capable, 3 image-capable, with fallback token budgets applied to all 7 |
| `npm run test:unit` | 0 | PASS — 107/107 |
| `npm run test:integration` | 0 | PASS — 95/95 |
| `npm run test:extension` | 0 | PASS — 22/22 |
| `npm run package` | 0 | PASS — VSIX 0.1.2 created with 82 files |

## 0.1.3 Local CLI reply evidence — 2026-08-21

| Check | Exit | Result |
|---|---:|---|
| Current nested turn completion | 0 | PASS — `params.threadId` plus `params.turn.id` is correlated before and after the `turn/start` response; failed current statuses remain fail-closed |
| Final-answer reconciliation | 0 | PASS — commentary and final-answer items remain distinct; final-only replies are surfaced; a partially streamed final item emits only its missing suffix |
| Current dynamic-tool request | 0 | PASS — `tool` / `arguments` fields reach Copilot while legacy `name` / `input` remains supported |
| Real Codex App Server production chain | 0 | PASS — `gpt-5.6-luna` returned text and a terminal completion through the compiled `ProcessSupervisor` → `AppServerSession` → `AppServerTransport` chain |
| `npm run test:unit` | 0 | PASS — 107/107 |
| `npm run test:integration` | 0 | PASS — 104/104 |
| `npm run test:extension` | 0 | PASS — 22/22 |
| `npm run package` | 0 | PASS — VSIX 0.1.3 created with 82 files |

## 0.1.4 Copilot-mediated ABAP write evidence — 2026-08-22

| Check | Exit | Result |
|---|---:|---|
| Required-tool contract regressions | 0 | PASS — required turns reject zero dynamic-tool calls; any supplied tool satisfies the generic contract; auto turns may complete without a call |
| SAP capability/instruction regressions | 0 | PASS — current-turn read/workspace URI/create/edit/diagnostics/activate capabilities are classified without filtering supplied tools |
| Write continuation regression | 0 | PASS — `replace_string_in_file` is surfaced to Copilot, its Host result resumes the original App Server turn, and the generic registry returns to size 0 |
| Metadata-only lifecycle regression | 0 | PASS — requested → surfaced → resultReceived → resumed order is recorded without prompt, URI, arguments, source or result content |
| Security boundary regression | 0 | PASS — approvals remain denied, native command/file actions remain interrupted, and declared dynamic tools still reach Copilot |
| `npm run typecheck` | 0 | PASS |
| `npm run test:unit` | 0 | PASS — 112/112 |
| `npm run test:integration` | 0 | PASS — 108/108 |
| `npm run test:extension` | 0 | PASS — 22/22 |
| `npm run package` | 0 | PASS — VSIX 0.1.4 created with 86 files |
| VSIX archive inspection | 0 | PASS — 86 entries; no `node_modules`, tests, Git/worktree data or TypeScript source files |

Interactive W01–W06 results are not inferred from automation:

| Case | Expected | 2026-08-22 result |
|---|---|---|
| W01 Local / Bypass Approvals / modify existing ABAP | resolve/read → edit dynamic tool → result → continuation → read-back/diagnostics | NOT RUN — interactive Copilot + SAP environment required |
| W02 Local / Default Approvals / modify existing ABAP | approval UI → Continue → Host edit → result → same turn resumes | NOT RUN — interactive Copilot + SAP environment required |
| W03 Reject approval | source unchanged; no false success; pending continuation terminates | NOT RUN — interactive Copilot + SAP environment required |
| W04 No write-capable supplied tool | no false completion claim and no native file change | NOT RUN — interactive Copilot + SAP environment required |
| W05 Create then edit | create → edit created object → read-back | NOT RUN — interactive Copilot + SAP environment required |
| W06 OAuth / Local A-B | run the same ABAP modification through both routes | NOT RUN — interactive Copilot + SAP environment required |

Detected local prerequisites (read-only inspection):

| Component | Version/status |
|---|---|
| Codex CLI | `0.148.0-alpha.9` |
| ABAP FS | `2.8.4` |
| SAP ADT for VS Code | `1.1.2` win32-x64 |
| GitHub Copilot Chat | Not detected in the default extensions directory; verify the target VS Code profile |

No account identity, SAP authority, source, callback URL or tool payload was recorded.

## 0.1.9 settings and Manager acceptance

Automated release evidence is recorded only after the final `npm run package` verification. The required regressions are:

| Check | Expected |
|---|---|
| Default request settings | `reasoning` and `service_tier` are absent from the ChatGPT OAuth request |
| Explicit reasoning | The selected `none`/`low`/`medium`/`high`/`xhigh`/`max` value is sent as `reasoning.effort` |
| Fast setting | User-facing `fast` sends `service_tier: priority` independently and can be combined with reasoning |
| Dynamic settings | A changed setting affects the next request without restarting VS Code |
| Command palette | Only `Codex Copilot Manager` is contributed as a visible command |
| Manager dispatch | Every existing management operation remains registered and the selected action reaches its existing safe handler |
| SAP proxy bypass | Manager preserves and de-duplicates existing VS Code `http.noProxy` entries; cancelling does not write settings |
| Safety regression | Local App Server safety, Copilot tool ownership and SAP/ABAP FS boundaries remain unchanged |

Interactive checks after installing the 0.1.9 VSIX:

1. Open `Codex Copilot Manager` from `Ctrl+Shift+P` and verify the ChatGPT OAuth, Local Codex and Extension groups.
2. Select `Open Settings`, leave both ChatGPT request settings at `modelDefault`, and confirm normal OAuth chat.
3. Set reasoning to `high`, send a new OAuth turn, then enable `fast` and send another turn.
4. Confirm Local CLI behavior and an ABAP FS edit/activation workflow are unchanged.

## Manual acceptance matrix

Run in a VS Code profile where GitHub Copilot Chat, ABAP FS and SAP ADT are enabled and the user explicitly authorizes login/SAP access.

| # | Case | Expected | 2026-08-21 result |
|---:|---|---|---|
| 1 | Provider visibility | `Codex · ChatGPT OAuth` and `Codex · Local CLI` appear separately | NOT RUN — target Copilot profile required |
| 2 | OAuth route | Login, model discovery and text streaming complete | NOT RUN — interactive ChatGPT login required |
| 3 | Local route | App Server reuses Codex-managed ChatGPT login; models/text stream | NOT RUN — interactive Development Host required |
| 4 | ABAP tool continuation | Each route completes one `get_abap_object_lines` call through Copilot and continues | NOT RUN — Copilot + SAP system required |
| 5 | Dirty `adt://` context | Unsaved selection and diagnostics affect answer without workspace scan | NOT RUN — SAP connection required |
| 6 | Cancellation isolation | Cancelling one route stops only that route | NOT RUN — interactive Copilot session required |
| 7 | Crash isolation | App Server crash does not affect OAuth | NOT RUN — interactive dual-route session required |
| 8 | Negative security check | No SAP write/activation, shell, patch, ADT MCP, token/prompt/source log | NOT RUN — inspect during cases 2–7 |

Automated equivalents cover provider independence, crash isolation, cancellation, dynamic-tool forwarding, native-action denial, prompt/source redaction, dirty `adt://` context and exact late-result behavior. They do not replace user acceptance against real accounts and a real SAP system.

## Manual evidence template

After user acceptance, replace each `NOT RUN` cell with `PASS` or `FAIL` and record only the date, VS Code version, Codex App Server version, ABAP FS version, SAP ADT version and safe error code if failed.

Never record account identity, SAP system authority, source, prompts, tokens, raw stderr or tool payloads.
