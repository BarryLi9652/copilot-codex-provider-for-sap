# Copilot Codex Provider for SAP

一个本地 VS Code 扩展，把 Codex 作为两个彼此独立的 GitHub Copilot Chat 模型提供方，并通过标准 VS Code API 增强 ABAP FS 与 SAP ADT for VS Code 的上下文体验。

V1 明确不使用官方 OpenAI API、不要求 API key，也不连接 ADT MCP。

## 功能

- `Codex · ChatGPT OAuth`：扩展独立完成浏览器 OAuth PKCE 登录，token 仅保存在 VS Code SecretStorage，直接访问 ChatGPT Codex 私有后端。
- `Codex · Local CLI`：启动本机 `codex app-server --listen stdio://`，复用 Codex CLI 已有 ChatGPT 登录；扩展不会读取、复制或记录 `~/.codex/auth.json`。
- 两条 route 的认证、缓存、进程、错误与失败状态完全独立，不自动 fallback。
- Copilot 拥有工具审批与执行权；扩展只转发动态工具调用，不执行 shell、patch、SAP 写入或激活。
- Local route 保留 Copilot 的 required-tool 语义：required turn 必须至少调用一个本轮 supplied dynamic tool，不绑定某个固定工具名。
- 从活动编辑器、未保存选区、诊断和扩展注册表收集有界 SAP 上下文；不会递归扫描 `adt://`。

## 前置条件

- VS Code 1.125.0 或更高版本。
- GitHub Copilot Chat（用于模型选择、工具审批与执行）。
- 使用 OAuth route：可用的 ChatGPT 账号和浏览器。
- 使用 Local route：本机 Codex CLI/App Server，且已通过 Codex 自身完成 ChatGPT 登录。
- SAP 开发可选：ABAP FS `murbani.vscode-abap-remote-fs` 和 SAP ADT for VS Code `SAPSE.adt-vscode`。

## 安装 VSIX

1. 构建或取得 `dist/copilot-codex-provider-for-sap-0.1.4.vsix`。
2. 在 VS Code 执行 `Extensions: Install from VSIX...`。
3. 重载窗口。
4. 在 Copilot Chat 模型选择器中分别选择 `Codex · ChatGPT OAuth` 或 `Codex · Local CLI`。

```powershell
code --install-extension .\dist\copilot-codex-provider-for-sap-0.1.4.vsix
```

## ChatGPT OAuth route

1. 执行 `Copilot Codex: Sign In with ChatGPT`。
2. 阅读私有接口风险提示并确认。
3. 在浏览器完成登录。
4. 如果 loopback 回调没有自动完成，保持登录流程打开，执行 `Copilot Codex: Complete ChatGPT Sign-In Manually`，粘贴完整 callback URL，不要编辑或裁剪。
5. 执行 `Copilot Codex: Refresh ChatGPT Models` 或重新打开模型选择器。

回调仅监听 loopback 地址，并按顺序尝试端口 1455、1457。OAuth session 不与 Local route 或 Codex CLI 共享。

## Local Codex CLI route

1. 在终端确认 `codex --version` 可用，并由 Codex CLI 自身完成 ChatGPT 登录。
2. 如果 `codex` 不在 PATH，执行 `Copilot Codex: Select Local Codex Executable`。
3. 重载 VS Code，使 executable 设置生效。
4. 执行 `Copilot Codex: Start Local Codex` 或直接选择 Local 模型。
5. 可使用 Start、Restart、Stop、Refresh Local Models 管理该 route。

扩展固定使用 `codex app-server --listen stdio://`，不允许配置任意 App Server 参数或 shell command。App Server thread 使用 `approvalPolicy: never`、`sandbox: read-only`、ephemeral thread，并关闭 native command/file/web/browser/app/plugin/multi-agent 等能力。

## ABAP FS 与 SAP ADT

- 扩展只读取标准 VS Code `TextDocument`、`TextEditor`、diagnostics 和 extension registry。
- `adt://` URI 保持为 URI 字符串；不会转换为本地 `fsPath`，也不会通过 Node `fs` 读取远程对象。
- 未保存内容来自活动文档的选区；空选区不会附加整份源码。
- 默认选区上限 16,000 字符，诊断上限 50 条，最终 SAP instruction 有 64,000 字符硬上限。
- SAP instruction 只根据当前 Copilot 请求实际提供的工具识别 search/read/workspace URI/create/edit/diagnostics/activate 能力；该识别不会过滤或改写 supplied tools。
- 用户明确要求修改且本轮存在 write-capable tool 时，Codex 会通过 Copilot supplied tool 请求实际修改，必要时先解析 `adt://` workspace URI，并在可用时通过 read/diagnostic tool 验证结果。
- 本轮没有 write-capable supplied tool 时，Codex 不得声称修改已经完成。
- 扩展不会调用 SAP ADT 私有 exports、未公开 command、ADT MCP，也不会直接修改或激活 SAP 对象。

V1 的“深度支持”依赖 Copilot/VS Code 提供的标准工具和审批机制。SAP ADT 或 ABAP FS 未公开为 Copilot tool 的能力，扩展不会绕过其边界。

## 设置

| 设置 | 默认值 | 说明 |
|---|---:|---|
| `copilotCodex.local.codexPath` | 空 | Local Codex executable 的绝对路径 |
| `copilotCodex.chatgpt.proxyUrl` | 空 | 仅用于 ChatGPT 登录令牌、模型发现和回复请求的 HTTP(S) 代理；修改后需重载 VS Code |
| `copilotCodex.requestTimeoutSeconds` | 600 | HTTP/RPC 请求超时，最小 10 秒 |
| `copilotCodex.toolTimeoutSeconds` | 300 | Copilot 工具 continuation 超时，最小 30 秒 |
| `copilotCodex.catalogCacheMinutes` | 5 | 每条 route 独立模型目录缓存时间 |
| `copilotCodex.sapSelectionMaxChars` | 16000 | 活动选区最大字符数 |
| `copilotCodex.logLevel` | info | `error`、`warn`、`info` 或 `debug` |

没有 endpoint、token、Cookie、ADT token、App Server args 或 shell command 设置。

## 诊断与排错

执行 `Copilot Codex: Show Diagnostics`。报告只包含版本、平台、provider 可用性、模型数/缓存年龄、用户名脱敏后的 executable、App Server 安全状态、SAP 扩展布尔值与安全错误码。Local tool lifecycle 日志只记录 tool mode/count、能力布尔值、tool name、状态和 pending count。

恢复动作包括 `signIn`、`refreshModels`、`selectCodex`、`restartCodex`、`upgradeCodex` 和 `showDiagnostics`。诊断和日志不应包含 token、账号邮箱、prompt、源码、工具 body、raw stderr 或 SAP system authority。

## 卸载与数据清理

先执行 `Copilot Codex: Clear Extension Data`，再卸载 VSIX。该命令只清除本扩展的 OAuth session/secret、两条 route 的模型缓存、continuation 状态、诊断与安全日志；不会注销 Codex App Server 账号、删除 Codex 配置或修改 SAP 连接。

卸载扩展不会删除 Codex CLI 自身管理的登录数据。

## 私有接口风险

ChatGPT OAuth route 使用未承诺稳定性的 ChatGPT Codex 私有接口，可能随服务端变化而失效。它不是官方 OpenAI API，也不应被当作官方 API 的兼容层。升级前请查看 `CHANGELOG.md`，并重新运行 `docs/testing.md` 中的验收矩阵。
