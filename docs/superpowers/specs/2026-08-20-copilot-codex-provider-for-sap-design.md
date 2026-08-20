# Copilot Codex Provider for SAP — V1 设计规格

- 日期：2026-08-20
- 状态：已批准
- 目标项目：`D:\WANG, LEON BINYU\CodexProjects\copilot-codex-provider-for-sap`
- 首版交付方式：本机开发、VSIX 自用或内部测试

## 1. 背景

本项目提供一个 VS Code 扩展，让 GitHub Copilot Chat/Agent 可以选择 Codex 模型，并尽量保留官方 Copilot 模型对工具、虚拟工作区和 SAP ABAP 开发插件的协作效果。

V1 同时实现两条互相隔离的 Codex 访问路线：

1. `Codex · ChatGPT OAuth`：扩展独立完成 ChatGPT OAuth PKCE 登录，调用 ChatGPT 的 Codex 私有后端。
2. `Codex · Local CLI`：扩展启动本机 Codex App Server 子进程，通过结构化 JSONL RPC 访问，并复用 Codex 自己已有的 ChatGPT 登录状态。

项目参考 `openai-oauth-copilot-chat` 的 Provider 边界、流式解析、SecretStorage、模型发现和工具转换思路，但不会照搬其实现，也不会把私有端点、OAuth 假设或协议结构散布到共享核心中。

## 2. 目标

- 通过稳定的 VS Code `LanguageModelChatProvider` 出现在 Copilot 模型选择器中。
- 将两条访问路线显示为两个独立 Provider，不进行隐式切换。
- 支持文本流式输出、取消、模型动态发现和完整工具调用闭环。
- 完整转发 Copilot 本次提供的工具，使 ABAP FS 的 Language Model Tools 可被 Codex 调用。
- 使用标准 VS Code API 安全识别 SAP ADT、ABAP 文档、诊断、选择区和 `adt://` 虚拟工作区上下文。
- 将私有后端协议与 App Server 实验协议隔离在可替换适配层中。
- 生成可安装的 VSIX，并通过自动化测试与人工端到端测试验证。

## 3. 非目标

- 不实现 OpenAI 官方 API、API Key 或 OpenAI/Agents SDK 路线。
- 不拦截或代理 GitHub Copilot 的内部网络请求。
- 不创建自定义 Copilot `@participant` 作为主要入口。
- 不连接 SAP ADT MCP Server；该能力留给后续版本。
- 不依赖 ABAP FS 或 SAP ADT 的内部模块、私有 TypeScript API 或未记录命令参数。
- 不扫描完整 SAP 工作区，不批量提取 SAP 对象，不自动修改或激活 SAP 对象。
- V1 不发布到 VS Code Marketplace，也不承诺私有协议的长期稳定性。

## 4. 核心架构决策

采用“单扩展、共享核心、双传输适配器”架构。

```text
GitHub Copilot Chat / Agent
            │
            ├── Codex · ChatGPT OAuth
            │       └── OAuth + Codex 私有后端 + SSE
            │
            └── Codex · Local CLI
                    └── Codex App Server + JSONL RPC

两条路线共享：消息模型、工具模型、流式事件、错误分类、SAP 上下文和脱敏日志
两条路线隔离：认证、模型目录、连接状态、重试、进程、会话与协议适配
```

扩展通过两个 `languageModelChatProviders` contribution 和两个 Provider 实例注册模型。Copilot 继续负责会话编排、工具选择后的审批和工具执行；本扩展只负责模型调用、格式转换和流式桥接。

## 5. 组件边界

### 5.1 Extension Bootstrap

负责扩展激活、Provider 注册、命令注册、配置监听和资源释放。它不包含后端协议逻辑。

### 5.2 Provider Layer

每个 Provider 将 VS Code 请求转换成共享的标准请求，并把共享事件写回 VS Code 响应流。Provider 不直接处理 OAuth、HTTP、SSE、子进程或 JSONL。

### 5.3 Core Domain

定义与具体后端无关的结构：

- 角色消息和多模态内容
- 工具定义、工具调用和工具结果
- 文本增量、工具调用、完成、用量和错误事件
- 模型能力和上下文限制
- 取消、超时和关联 ID

核心传输边界为 `CodexTransport`，至少提供模型发现、生成请求、取消和释放能力。两个实现必须返回相同的标准事件，不允许 Provider 根据后端类型解析协议细节。

### 5.4 ChatGPT OAuth Transport

包含 PKCE、凭据刷新、私有模型目录、私有 Responses 请求、SSE 分帧和私有事件映射。当前已知私有端点被封装在单一版本化协议配置中，例如：

- `https://chatgpt.com/backend-api/codex/models`
- `https://chatgpt.com/backend-api/codex/responses`

这些端点不是公共兼容 API，任何字段或事件变化都只修改该适配器。

### 5.5 Codex App Server Transport

包含 Codex 可执行文件定位、子进程管理、JSONL RPC、初始化、登录状态、`model/list`、thread/turn 生命周期和 `dynamicTools` 桥接。

App Server 使用 stdio，每行一个 JSON 消息。扩展必须先完成初始化和能力探测，再把模型暴露给 Copilot。WebSocket、Unix socket 和旧 MCP 接口不属于 V1。

### 5.6 Tool Bridge

负责三种格式之间的无损转换：

- VS Code Language Model Tools
- Codex 私有后端 function tools
- App Server `dynamicTools`

工具名称、说明、输入 JSON Schema 和调用 ID 必须保留。工具结果中的文本和内联图片按后端能力转换；不支持的内容返回明确的转换错误，不能静默丢弃。

### 5.7 SAP Context Adapter

只使用标准 VS Code API 检测和读取上下文，不拥有 SAP 连接，也不直接调用 ADT 后端。

### 5.8 Observability and Security

集中处理关联 ID、耗时、状态码、协议版本、能力探测和日志脱敏。默认不收集遥测。

## 6. 普通请求数据流

1. Copilot 把完整消息历史、当前可用工具、模型选项和取消信号交给 Provider。
2. Provider 将请求转换为标准结构，并添加有限的 SAP 上下文元数据。
3. Provider 调用对应 `CodexTransport`。
4. Transport 流式产生标准事件。
5. Provider 将文本事件写为 VS Code 文本片段，将工具调用事件写为 `LanguageModelToolCallPart`。
6. Copilot 展示结果，或执行工具后再次调用同一 Provider。

Provider 不保存普通聊天历史。每次请求以 Copilot 提供的完整历史为准，避免本扩展中的会话状态与 Copilot 会话分叉。

## 7. OAuth 路线的工具闭环

1. 将 Copilot 本次提供的工具完整发送到 Codex 私有后端。
2. 私有后端产生 function call 时，Transport 输出标准工具调用事件。
3. Provider 将其转换为 `LanguageModelToolCallPart` 并结束当前生成阶段。
4. Copilot 负责审批和执行工具。
5. 下一次 Provider 请求包含相同 `callId` 的工具结果。
6. 消息转换器把工具结果纳入新的私有后端请求，模型继续生成。

扩展不自行调用 ABAP FS 工具，也不绕过 Copilot 的审批流程。

## 8. Local CLI 路线的工具续接状态机

App Server 的 `dynamicTools` 是实验能力，服务端调用工具时会向客户端发起 RPC 请求。为了仍由 Copilot 执行工具，扩展采用可暂停的续接状态机：

```text
running
  ├── text/event ───────────────> running
  ├── dynamic tool request ─────> waitingForTool
  ├── completed ────────────────> completed
  └── cancel/error ─────────────> terminated

waitingForTool
  ├── matching result ──────────> running
  ├── timeout/cancel ───────────> terminated
  └── process exit ─────────────> terminated
```

具体流程：

1. 启动 turn 时，只把 Copilot 本次提供的工具注册为 `dynamicTools`。
2. App Server 发起动态工具 RPC 时，扩展保存 RPC 请求 ID、thread ID、turn ID、call ID 和到期时间。
3. Provider 把工具调用交给 Copilot并结束当前响应阶段，但 App Server 子进程和该 RPC 仍保持等待。
4. Copilot 执行工具后再次调用 Provider。
5. Provider 从消息中查找匹配 `callId` 的工具结果，将新响应流绑定到原 turn，并回复暂存的 App Server RPC。
6. App Server 继续原 turn，后续文本或工具调用继续转给新的响应流。

多个并行工具请求分别按 `callId` 保存，收到全部所需结果后再继续。若调用丢失、超时、取消或进程崩溃，扩展必须清除全部相关状态，并向 Copilot 返回可理解的错误。

App Server 进程按需启动并长期复用；每个 Copilot 生成链使用独立临时 Codex thread。工具链结束后释放 thread 映射，不将其作为长期 Copilot 会话存储。

## 9. App Server 安全边界

- 工具执行和审批归 Copilot/VS Code 所有。
- App Server 的原生命令执行、补丁、文件写入和其他本地变更请求一律拒绝。
- thread 使用最小权限和只读沙箱配置。
- 不允许 App Server 自行发现并调用未由 Copilot 提供的动态工具。
- 不把 SAP 连接凭据、ADT token 或扩展 SecretStorage 内容发给 App Server。
- App Server 不支持必需的实验能力时，Local CLI Provider 返回空模型目录并通过诊断命令说明不兼容原因；不得静默切换到 OAuth。

## 10. ABAP FS 集成

目标扩展 ID 为 `murbani.vscode-abap-remote-fs`。集成规则：

- 运行时检测扩展是否安装和激活，但不把它设为扩展激活的硬依赖。
- 完整转发 Copilot 本次提供的全部 Language Model Tools，不维护易过期的固定工具白名单。
- 可识别 `get_abap_object_lines`、`search_abap_objects`、`search_abap_object_lines`、`get_object_by_uri`、`get_abap_object_info`、`find_where_used` 和 `get_abap_object_workspace_uri` 等常用工具，用于诊断和轻量提示。
- 不导入 ABAP FS 的 `client/src`、文件系统注册表、连接注册表或工具注册表。
- 不通过遍历虚拟目录模拟 SAP 对象搜索；优先使用 ABAP FS 已提供的语义工具。
- `adt://` URI 始终作为不透明 `vscode.Uri` 处理。读取虚拟文件只使用已打开的 `TextDocument` 或 `vscode.workspace.fs`，不使用 Node.js 本地文件 API和 `Uri.fsPath`。
- 已打开且未保存的 ABAP 内容以 `TextDocument.getText()` 为准。

## 11. SAP ADT for VS Code 集成

目标扩展 ID 为 `SAPSE.adt-vscode`。V1 只使用稳定的标准 VS Code API：

- 检测扩展安装和激活状态。
- 获取活动文档 URI、language ID、选择范围、dirty 状态和该文档诊断。
- 将 `adt://` 和其他虚拟 URI 保持原样。
- 如果 SAP ADT 将工具通过 Copilot 标准工具列表暴露，则按普通工具完整转发。
- 不调用未公开的 SAP ADT TypeScript API。
- 不依赖未记录命令的参数或返回结构。
- 不连接 `http://localhost:2236/mcp` 或其他 ADT MCP 地址。

## 12. SAP 上下文策略

- 不扫描工作区，不自动读取多个 SAP 对象。
- 仅注入扩展存在状态、活动文档元数据、选择范围、dirty 状态和相关诊断摘要。
- 用户存在非空选择区时，可把选择文本作为有限上下文；不自动重复注入完整活动文档。
- 完整源码由 Copilot 已构造的消息提供，或由 ABAP FS 工具按需获取。
- ABAP 会话附加简短规则：优先使用语义搜索工具；不要递归遍历虚拟目录；修改、激活和传输相关操作必须来自用户明确请求并经过 Copilot 审批。
- 未安装 ABAP FS 或 SAP ADT 时，两条 Provider 仍作为普通 Codex 模型工作。

## 13. OAuth、凭据与模型目录

### 13.1 ChatGPT OAuth

- 使用 Authorization Code + PKCE。
- 每次登录生成新的 verifier、challenge 和随机 state，并严格验证回调 state。
- 通过 VS Code URI handler 接收回调。
- Access token、refresh token 和必要的到期元数据仅保存到 VS Code `SecretStorage`。
- Token 即将过期时单飞刷新，避免并发刷新覆盖。
- `invalid_grant`、撤销或不可恢复的 401 会清除本扩展凭据并要求重新登录。
- 不读取或导入 `~/.codex/auth.json`。
- 不提供任意私有后端地址设置，避免凭据被发送到非预期主机。
- 登录前明确告知用户该路线依赖非公共私有接口，可能随服务更新失效。

### 13.2 Local CLI 登录

- 使用 App Server `account/read` 判断状态。
- 复用 Codex 自己管理的 ChatGPT 登录。
- 不读取、复制、修改或导出 Codex 认证文件。
- 未登录时提供操作指导，不由扩展伪造或复制认证状态。

### 13.3 模型目录

- OAuth Provider 从私有 Codex models 端点动态获取模型。
- Local CLI Provider 从 App Server `model/list` 动态获取模型。
- 只暴露满足文本输入、文本输出和所需工具能力的模型。
- 两个 Provider 使用独立缓存、刷新和错误状态。
- 模型信息短期缓存；扩展启动、登录状态变化和用户执行“刷新模型”时重新探测。
- 不合并同名模型，也不在两条路线间回退。

## 14. Codex 可执行文件定位与进程管理

定位顺序：

1. 用户在本扩展设置中选择的 Codex 可执行文件绝对路径。
2. 当前扩展宿主环境的 `PATH`。
3. 经过验证的已知安装位置探测。

禁止硬编码带版本号的 WindowsApps 目录。启动时使用可执行文件路径和固定参数数组，不通过 shell 拼接命令。

进程管理规则：

- 首次使用 Local CLI 时惰性启动。
- 初始化、能力探测和模型发现均有独立超时。
- stderr 进入脱敏诊断，不作为协议输入。
- 子进程退出时使所有相关 turn 失败并清理暂存工具请求。
- 下次用户请求最多自动重启一次；连续失败后打开断路状态，等待用户手动重启或修复配置。
- 扩展停用时终止子进程并释放监听器。

## 15. 用户命令与配置

V1 提供以下命令：

- ChatGPT 登录
- ChatGPT 退出
- 刷新 OAuth Provider 模型
- 选择或检查 Codex 可执行文件
- 启动、重启和停止 Local App Server
- 刷新 Local CLI Provider 模型
- 显示脱敏诊断
- 清理本扩展保存的凭据与缓存

配置保持最小化，包括 Codex 可执行文件路径、请求超时、工具等待超时、诊断日志级别和 SAP 选择区最大字符数。私有后端主机、OAuth token、ADT token 和任意 shell 参数不作为普通设置暴露。

## 16. 错误处理

统一错误类别：认证、限流、网络、超时、取消、私有协议、App Server 协议、进程、工具转换、工具续接、SAP 虚拟文件和扩展不可用。

规则：

- OAuth 401 只允许刷新并重试一次。
- 429 尊重服务端 `Retry-After`，不进行无限重试。
- 流式输出开始后不自动重放整个请求，避免重复工具调用。
- SSE 和 JSONL 严格校验关键字段；未知非关键事件写入脱敏诊断后忽略。
- App Server 崩溃不会影响 OAuth Provider，反之亦然。
- 取消会中止 HTTP、turn 或暂存工具请求，并释放所有关联状态。
- 用户错误信息必须给出下一步操作，例如重新登录、选择 Codex 路径、升级 Codex、刷新模型或查看诊断。

## 17. 日志和数据保护

默认不记录或遥测以下内容：

- OAuth token、Cookie、Authorization header
- 用户提示词和模型完整回复
- ABAP 源码、工具参数和工具结果
- SAP 用户、密码、ADT token 和连接信息
- 带敏感查询参数的 SAP URI

诊断只保留事件类型、后端类型、协议版本、能力标记、耗时、HTTP 状态码、进程退出码和随机关联 ID。必要的错误片段必须先经过字段级脱敏和长度限制。

## 18. 工程结构

```text
src/
  extension.ts
  core/
  providers/
  transports/
    chatgpt-oauth/
    app-server/
  sap/
  security/
  commands/
test/
  unit/
  integration/
  fixtures/
docs/
  superpowers/specs/
```

项目采用 TypeScript strict mode，最低 VS Code engine 为 `^1.125.0`。构建、测试和打包脚本通过 npm 执行；本地 npm 缓存和 VS Code 测试运行时下载目录配置在项目内部并加入 `.gitignore`。

## 19. 测试策略

开发阶段遵循测试驱动开发。

### 19.1 单元测试

- VS Code 消息与标准消息互转
- 私有后端消息和工具格式转换
- SSE 分帧、跨 chunk 事件和终止事件
- JSONL 分帧、RPC 关联和乱序响应
- 并行 call ID、工具结果匹配和超时清理
- OAuth state、PKCE、刷新单飞和失效清理
- 模型能力过滤
- URI、诊断和选择区上下文限制
- 日志脱敏和错误分类

### 19.2 集成测试

- 模拟 OAuth 服务与私有 Codex 后端
- 模拟 App Server 子进程和 JSONL RPC
- 动态工具暂停、Copilot 结果续接和继续流式生成
- App Server 崩溃、重启、版本不兼容和缺失能力
- HTTP 401、429、5xx、断流和取消

### 19.3 VS Code Extension Host 测试

- Provider 注册和动态模型目录
- 测试 Language Model Tool 的调用闭环
- 模拟 `adt://` FileSystemProvider
- dirty ABAP 文档、选择区和诊断
- ABAP FS/SAP ADT 缺失时的降级行为

### 19.4 人工端到端矩阵

在安装 GitHub Copilot Chat、ABAP FS 和 SAP ADT 的 VS Code 中验证：

1. VSIX 安装、激活和卸载。
2. 两个 Provider 独立出现在模型选择器中。
3. OAuth 登录、模型发现和普通流式对话。
4. Local App Server 登录复用、模型发现和普通流式对话。
5. 两条路线各完成至少一次 ABAP FS 工具调用、Copilot 执行和结果续接。
6. 取消生成、工具超时、OAuth 失效和 App Server 崩溃。
7. `adt://` 活动文档、dirty 内容、选择区和诊断识别。
8. 未经用户明确请求不发生 SAP 写入、激活或本地命令执行。

## 20. V1 验收标准

- TypeScript 类型检查、单元测试、集成测试和 Extension Host 测试通过。
- VSIX 可成功构建、安装和激活。
- Copilot 模型选择器显示两个独立 Provider，并分别动态展示可用模型。
- OAuth 路线可完成登录、普通流式回复和工具调用闭环。
- Local CLI 路线可复用本机登录，完成普通流式回复和工具调用闭环。
- ABAP FS 工具由 Codex 选择、由 Copilot 审批执行，并把结果返回同一生成链。
- SAP ADT 和 `adt://` 当前上下文可通过标准 VS Code API 安全识别。
- 两条路线在认证、进程、模型、错误和取消方面互不影响。
- 日志检查确认不包含凭据、提示词、ABAP 源码或工具结果。
- 代码、测试、文档、依赖与开发缓存均位于目标项目内。

## 21. 已知风险与缓解

### 私有后端变化

风险：端点、OAuth 元数据、请求字段或 SSE 事件可能变化。

缓解：版本化协议配置、严格解析、模型动态发现、契约测试和明确诊断。

### App Server 实验协议变化

风险：`dynamicTools`、thread/turn 或事件结构可能变化。

缓解：初始化能力探测、协议适配层、假服务器契约测试和不兼容时快速失败。

### Provider 工具续接复杂度

风险：Copilot 的下一次请求与暂存 App Server RPC 无法匹配，或并行工具造成状态泄漏。

缓解：只以 call ID 关联、有限状态机、超时、取消清理、每生成链独立 thread 和高覆盖率集成测试。

### SAP 数据与写操作风险

风险：模型可能请求读取过多对象或调用写入、激活类工具。

缓解：不扫描工作区、只转发当前工具、最小上下文、工具执行归 Copilot 审批、App Server 原生写能力全部拒绝。

## 22. 项目写入边界

开发代理只能修改：

`D:\WANG, LEON BINYU\CodexProjects\copilot-codex-provider-for-sap`

不得修改其他项目、用户配置、Codex 配置、ABAP FS 源码或 SAP ADT 源码。自动化测试使用模拟 SecretStorage。只有用户主动执行真实 OAuth 登录时，VS Code 才会写入其平台管理的 SecretStorage；Local CLI 始终由 Codex 自己管理既有登录状态。

如果后续实现需要子代理，只允许使用用户指定的 `gpt-5.6-luna`、`max` 推理和 fast/priority 服务配置。

## 23. 参考资料

- [VS Code Language Model Chat Provider](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [VS Code Language Model Tools](https://code.visualstudio.com/api/extension-guides/ai/tools)
- [VS Code Virtual Workspaces](https://code.visualstudio.com/api/extension-guides/virtual-workspaces)
- [OpenAI Codex App Server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [ABAP Remote FS](https://github.com/marcellourbani/vscode_abap_remote_fs)
- [SAP ADT for VS Code](https://marketplace.visualstudio.com/items?itemName=SAPSE.adt-vscode)
- [SAP ADT for VS Code documentation](https://help.sap.com/docs/abap-cloud/abap-development-tools-for-visual-studio-code/abap-development-tools-for-visual-studio-code?version=sap_cross_product_abap)
- [Reference: openai-oauth-copilot-chat](https://github.com/grikomsn/openai-oauth-copilot-chat)
