# Pi Codex Toolkit 架构

> 状态：已实现至 Apply Patch MVP；Computer Use 的只读 Pi 0.84.4 live gate 已于 2026-08-29 通过
> 最后核对：2026-08-30

## 1. 结论

Pi Codex Toolkit 不是另一个 Codex 前端，也不接管 Pi 的 agent loop。它只在 Pi 已有生命周期上增加少量、边界明确的 OpenAI/Codex 能力：

1. 对官方 OpenAI/Codex Responses 请求做原生 Web Search 注入。
2. 以普通 Pi 工具为其他主模型提供 OpenAI sidecar search。
3. 在 Pi 决定需要压缩时，尝试 Codex Remote Compaction v2。
4. 以普通 Pi 工具提供 OpenAI/Codex 图像生成。
5. 以普通 Pi 工具提供 provider-neutral、兼容 Codex patch 语法的 `apply_patch`。
6. 通过 ChatGPT.app bundled Codex app-server、`node_repl` 与受信任的
   `@oai/sky/service`，以普通 Pi 工具桥接本机 Computer Use。

Pi 继续拥有对话、工具循环、会话树、自动压缩时机和普通编码工具。项目只增加边界明确的 Apply Patch 编辑原语，不复刻 Codex 的 shell、PTY、`view_image`、goal、plan、review 或 multi-agent 语义。

核心原则是：**增强 Pi，不在 Pi 里面再运行一套 Codex agent。**

能力默认按 provider-neutral 设计：只要主模型能调用普通 Pi 工具，Sidecar Search、Image Generation、Apply Patch 和 Computer Use 就不因主模型品牌而关闭。只有协议本身绑定当前 OpenAI/Codex Responses 会话时，Native Search 和 Remote Compaction 才限制 provider；Computer Use 的 image/UI 条件属于模态与运行环境限制，不是 provider 限制。

## 2. 范围

### 核心版本

| 能力 | 形态 | 主模型限制 | 实际执行方 | 验证状态 |
| --- | --- | --- | --- | --- |
| Native Web Search | 修改当前 Responses payload | 官方兼容的 OpenAI/Codex Responses route | Responses hosted tool | 两轮 live search 通过；大于 128k probe 待完成 |
| Sidecar Web Search | 普通 Pi 工具 `openai_web_search` | 任意可调用普通工具的主模型；另需选定 OpenAI/Codex executor | 独立 Responses + hosted `web_search` | Codex OAuth 协议与 Grok 主模型 RPC 验收通过；API-key 仅确定性覆盖，live 待完成 |
| Remote Compaction v2 | `session_before_compact` hook + checkpoint replay | 官方 `openai-codex` provider/API/endpoint | Codex Responses | 连续压缩、恢复、fork 与 fallback live gate 通过 |
| Image Generation | 普通 Pi 工具 `openai_generate_image` | 任意可调用工具的主模型；另需可用 OpenAI/Codex 认证 | 独立 Images API 请求 | Codex 与 Grok 主模型 OAuth live gate 均通过；API-key 只有确定性测试，live 待完成 |
| Apply Patch | 普通、顺序执行的 Pi 工具 `apply_patch` | 任意可调用普通工具的主模型 | Pi 当前工作目录下的本地文件系统 | parser、安全、commit、生命周期与 transport 确定性测试通过 |
| Computer Use | 六个静态、顺序执行的普通 Pi 工具 | MVP 要求模型支持 image input、macOS 且有交互 UI | ChatGPT.app bundled `codex app-server` → `node_repl/js` → `@oai/sky/service` | fake app-server 测试、只读 live gate 与 approval-mode 矩阵均通过 |
| 配置与状态 | `/pct` 命令和一个 JSON 文件 | 无 | Pi extension | 单元测试通过 |

### 实验性 Computer Use 边界

| 能力 | 形态 | 主模型限制 | 实际执行方 |
| --- | --- | --- | --- |
| Computer Use | 一组静态、顺序执行的普通 Pi 工具 | MVP 要求模型支持 image input、macOS 且有交互 UI | ChatGPT.app bundled `codex app-server` → `node_repl/js` → trusted Sky service |

Computer Use 已在默认关闭的实验开关后实现。它的本机依赖和协议漂移
风险明显高于 Responses 能力，因此发布有独立的只读验收门禁；该门禁已于
2026-08-29 在当前成套桌面组件上通过。

配置 schema 与菜单暴露 `computerUse.enabled` 以及 `Confirm`、`Always` 两种
approval mode，不暴露 backend、安装器、timeout 或兼容性设置。

### 为什么保留两条 Web Search 路径

Native Search 让当前官方 OpenAI/Codex 主模型直接使用 hosted tool；Sidecar Search 则让 Claude、Gemini 或其他支持普通 Pi 工具调用的主模型，通过一次独立 OpenAI Responses 请求获得答案与 sources。后者会增加一次 OpenAI 请求、延迟和费用。Toolkit 不自动附带完整主会话历史，但会把主模型生成的 query 原样发送给 executor；query 本身可能引用或概括会话内容。

用户不需要额外安装 `pi-web-access`。本项目只实现 OpenAI-only、query-only 的 sidecar，不复制它的多 provider router、抓取器或 fallback 系统。两条路径属于同一个 Web Search 能力，并在每轮互斥。

### 明确不做

- Codex backend mode、`dynamicTools` 或完整 Codex agent loop。
- 完整 Codex shell/PTY/`view_image`/goal/plan/review/multi-agent surface，或 Responses API 一等 `apply_patch_call` 协议的复刻。
- Browser、Playwright/CDP、in-app browser 或 Chrome 插件。
- 通用 `web_fetch`、任意 URL 正文抓取、`open/click/find` 或 Codex 私有 `alpha/search` 协议。
- 通用 MCP、apps、plugins marketplace。
- Computer Use 自动安装、自动启动 GUI 或自动授予 macOS 权限。
- 精确 model ID allowlist、`assumeNativeSearch` 或联网 capability probe。
- 通用 capability bus、provider registry、依赖注入容器或动态 MCP schema 镜像。
- `/doctor`、配置数据库、文件 watcher、配置迁移框架或通用敏感信息脱敏器。

## 3. 最小模块边界

一个 package 即可：

```text
src/
  index.ts
  config.ts
  commands.ts
  status.ts
  apply-patch.ts
  openai/
    route.ts
    request-pipeline.ts
    native-search.ts
    sidecar-search.ts
    remote-compaction.ts
    image-generation.ts
  computer-use/
    app-server-client.ts
    tools.ts
```

职责如下：

- `index.ts`：注册 hooks、命令和工具；不放协议逻辑。
- `config.ts`：唯一配置类型、默认值、读写和校验。
- `commands.ts`：`/pct config|status|reload` 的薄 UI。
- `status.ts`：把配置、当前模型和外部依赖投影成可读状态。
- `apply-patch.ts`：解析、校验、暂存并提交一次有界的本地 patch；不负责 provider routing。
- `openai/route.ts`：解析官方 route 与 Pi 认证；这是唯一允许凭据进入网络请求的边界。
- `openai/request-pipeline.ts`：一个确定顺序、幂等的 Responses payload pipeline。
- 四个 OpenAI feature 文件：各自拥有协议和结果转换，不实现通用 feature interface。
- `computer-use/app-server-client.ts`：JSONL-RPC 进程、握手、请求关联、超时和关闭。
- `computer-use/tools.ts`：固定的 Pi tool schema 与 MCP 内容转换。

不要提前把单个文件拆成 `service/controller/adapter` 层。只有一个文件变得难以测试时才继续拆分。

## 4. 数据流

### 4.1 当前主模型的 Responses 请求

```text
Pi 构造 provider payload
  → replay 兼容的 Remote Compaction checkpoint
  → 去重并注入 Native Web Search
  → 官方 Responses endpoint
```

只有一个 `before_provider_request` handler 运行这个 pipeline。每个 transform 必须：

- 在不适用时返回原 payload。
- 保留未知字段和其他扩展已经加入的内容。
- 对重复执行保持幂等。
- 不依赖本包内部 hook 的注册顺序。

Pi 对不同扩展的 hooks 仍按加载顺序串联。项目不尝试控制后置扩展；文档明确禁止同时启用重叠的 payload/compaction 扩展。

### 4.2 Sidecar Web Search

```text
任意可调用普通工具的主模型
  → openai_web_search({ query })
  → 用户选定的官方 OpenAI/Codex Responses executor + effort
  → hosted web_search（required）
  → answer + 去重后的 sources
  → 普通 Pi tool result
```

Sidecar 请求不自动附带 Pi 主会话历史，只发送工具参数中的 `query`，也不经过主模型的 Responses payload pipeline。该 query 由主模型生成，可能包含会话信息，并会原样发送给 executor。Sidecar 与 Native Search 只共享 official-route/auth 解析，不共享 request transform 或 response parser。

### 4.3 Image Generation

```text
任意主模型
  → openai_generate_image
  → 官方 route + Pi 中已有的 OpenAI/Codex 认证
  → Images generation endpoint
  → 唯一 artifact 文件 + Pi ImageContent
```

图像请求不携带主对话历史。当前 Codex 源码也使用独立 Images client，而不是让整个 Codex agent loop 执行一次 Responses turn。参见 [Codex image backend](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/backend.rs) 和 [image tool](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs)。

### 4.4 Apply Patch

```text
任意可调用普通工具的主模型
  → apply_patch（Codex-compatible raw patch 或 JSON { patch }）
  → 在 ctx.cwd 下解析并 preflight 全部 operation
  → 内存计算变更并暂存全部 replacement
  → 最后一次 cancellation 检查
  → 按 patch 顺序提交 mkdir/rename/unlink operation
```

由 Pi 选择 constrained grammar 或 JSON transport，两者进入同一个
provider-neutral executor。executor 使用 Pi 公开的 file-mutation queue，拒绝
可见 symlink 和 canonical 工作目录之外的路径，并在 staging 或 commit 前完成
完整 preflight。这是静态 containment 边界，不是 race-proof sandbox。

### 4.5 Computer Use

```text
Pi computer_use_* tool
  → 懒启动 ChatGPT.app bundled codex app-server
  → initialize → initialized
  → ephemeral thread/start，仅注入一个 node_repl MCP
  → mcpServer/tool/call(server = "node_repl", tool = "js")
  → 固定 JavaScript import @oai/sky
  → trusted @oai/sky/service 操作本机 App
  → text/image MCP content 转成 Pi tool result
```

`mcpServer/tool/call` 是 app-server 文档列出的非 experimental 接口；这里
不需要 `dynamicTools` 或 model turn。每个 Pi 调用只向 `node_repl/js` 发送
一个固定 source template；参数始终是 JSON data，不会成为可执行 source。
官方协议要求每个连接先完成 `initialize` 和 `initialized`，并要求 tool call
绑定有效 thread。参见 [Codex app-server 文档](https://learn.chatgpt.com/docs/app-server)。

该桥接只使用 `/Applications/ChatGPT.app/Contents/Resources` 下成套组件，
并要求 `<real CODEX_HOME>/computer-use/Codex Computer Use.app` helper 已安装。
它不搜索 PATH、不混用 Codex.app 或 plugin cache 组件、不启动 GUI、不安装
任何内容，也不修改 macOS 权限。ChatGPT GUI 是否必须预先运行不属于此实验契约。

state screenshot 从 helper 返回的本地 URL 读取。固定模板只接受 PNG 或 JPEG
magic，并以匹配的 MIME 返回原生 Pi image；未知字节直接失败。当前 helper 在
Calculator live probe 中实际返回 JPEG，因此不能继续强标为 PNG。

合法 Computer Use elicitation 有两种策略。`Confirm` 把某个 app 的首次请求交给
Pi，只有 Yes 才返回 Sky 的 session-persistent
`{ action: "accept", content: {}, _meta: { persist: "session" } }`；No 只作用于
当前调用且不缓存。`Always` 不显示 Pi confirmation，直接返回同样的 accept。canonical app 的
bundle identifier 由 Sky 提供；Toolkit 只在当前 client 的内存 Set 中保存已接受
identifier，命中时返回 node_repl 的 `computer-use-persisted-state` conversation
response。复用 client 时 `Confirm` 授权继续有效；session shutdown、禁用、失去
资格、tool 冲突或 approval mode 变化都会关闭 client 并清空 Set。`Always` 在新
Pi session 仍生效，是因为持久配置再次选择自动接受，并非全局保存授权。两种模式
都不绕过 macOS 权限。

## 5. 能力契约

### 5.1 Web Search

Web Search 是一个能力，两种执行路径。配置中的 `backend` 决定路径：

| backend | 行为 |
| --- | --- |
| `auto` | 当前主模型是官方兼容 Responses route 时用 native；否则使用已配置且可认证的 sidecar executor |
| `native` | 强制只做当前主模型 payload 注入；route 不兼容时 unavailable |
| `sidecar` | 强制只暴露 `openai_web_search`；executor 不可用时 unavailable |

`auto` 只在请求前选择路径，不是错误后的自动 fallback。任一 turn 最多启用一条 Toolkit 搜索路径；native 请求失败后不补发 sidecar，sidecar 失败后也不换 provider 或重试。

#### Native path

资格判断使用结构条件，不维护模型名单：

```text
configured
&& provider/api 是官方兼容的 Responses 实现
&& endpoint 通过 official-route 校验
```

这些条件只表示当前请求**具备注入资格**，不保证服务端接受该模型、reasoning 设置或输入长度。官方模型限制仍然适用，Responses Web Search 当前还要求输入不超过 128k context。项目不为此维护 allowlist 或本地 tokenizer。大于 128k 的 live probe 尚未执行，调用方应遵守服务端已公开的限制。

Native path 使用：

- `tool_choice: "auto"`，让当前主模型自行决定是否搜索。
- 配置的 `mode: "live" | "cached"` 和 `contextSize: "low" | "medium" | "high"`。
- 对 hosted tool 和 `include` 字段进行保留式合并与去重。

`cached` 映射到 `external_web_access: false`；`contextSize` 映射到 `search_context_size`。参见 [OpenAI Web Search 指南](https://developers.openai.com/api/docs/guides/tools-web-search)。

当前 Pi Responses parser 不完整保存 `web_search_call`、sources 和 `output_text.annotations`。因此 Native path 对外承诺是“原生 grounded search，引用 best effort”，不是完整的结构化搜索 UI。2026-08-29 的两轮 live probe 均正常完成，每轮观察到两个 source URL occurrence，且后续请求没有 replay 校验错误。

#### Sidecar path

Sidecar executor 是用户在 `/pct config` 中从 Pi model registry 明确选择的一个官方 OpenAI/Codex Responses `provider + model`。第二个菜单选择 `auto` 或 Pi 为该 Codex 模型报告的一个受支持 thinking level；它与主模型 thinking level 相互独立。这不是主模型 allowlist：Pi 的主模型仍可来自任意 provider；被选择的模型只负责执行独立搜索请求。配置不保存认证，调用前通过 Pi registry 取得刷新后的 key/headers，并再次验证 official route。

`openai_web_search` 只接受 `query`。独立请求：

- 不自动附带主会话历史，只把主模型生成的 `query` 原样发送给 executor；query 可能引用或概括会话内容。
- 使用 `{type: "web_search"}`、`tool_choice: "required"`、`store: false`。
- 请求 `web_search_call.action.sources`，并应用与 Native path 相同的 `mode` 和 `contextSize`。
- 等到 `response.completed`，要求至少出现一个 `web_search_call`。
- 返回简洁 answer、最多 20 条稳定去重后的可点击 sources，以及可用时的 token usage。20 是 Toolkit 固定输出预算，不是 hosted Search 的结果数量保证。
- 传递 abort signal，使用固定内部 timeout；dispatch 后不自动重试或切换 route。

保留的 API-key route 使用一次 feature-local 非流式 Responses 请求。Codex OAuth 通过 Pi 公共 Codex provider 使用 SSE 且重试次数为零；由于 live terminal response 缺少完整 output，一个小型 feature-local decoder 聚合 `response.output_item.done`，再要求一个 completed terminal event。Pi 规范化后的最终消息会丢失完整 sources 所需的原始 search-call 与 annotation 数据，因此不用于提取 sources。两条路径都不扩展成通用 OpenAI client。

当前 Pi model metadata 没有通用的普通工具调用能力标志。因此 Toolkit 不根据 provider/model ID 猜测 Sidecar 资格：executor route 可用时就暴露这个普通 Pi 工具。不能使用 Pi 普通工具的主模型也无法调用它，就像无法可靠使用 Pi 自带编码工具一样；由于本地没有符合条件的 executor，非 OpenAI 主模型调用 API-key Sidecar 的 live smoke 仍待完成。

Sidecar 自己解析原始 Responses 输出，因此可以可靠返回 sources；即使当前主模型本身是 OpenAI/Codex，用户也可以强制选择 sidecar 来换取更明确的来源。它会产生额外 OpenAI 模型与 hosted-search 费用和延迟；`/pct status` 必须显示 executor 与这项计费语义。

Codex OAuth 是本包已经 live 验证的 Sidecar 协议基线。它仍是 Pi 固定版本上观测到的 ChatGPT backend，不是面向第三方承诺的稳定公开 API。失败时不会切换到保留的 API-key route，也不会使用私有 `alpha/search`。

Sidecar Search 也不是确定性的网页抓取。Hosted `web_search` 可以在搜索过程中读取页面并返回 sources，但调用方不能把它当作 `fetch(url) → raw content`。ChatGPT 桌面端的内置 Browser 确实能打开和操作网站，但官方明确它不属于 Codex CLI/IDE 能力，app-server 也没有公开的通用 fetch RPC。因此第一版不提供 `openai_fetch_url`；未来 Computer Use 即使能操作可见 Browser，也仍按 UI 操作处理。参见 [ChatGPT Browser 文档](https://learn.chatgpt.com/docs/browser) 和 [Codex app-server 文档](https://learn.chatgpt.com/docs/app-server)。

如果本地已有名为 `web_search` 的普通工具，`/pct status` 只显示冲突警告。Toolkit 不禁用、替换或恢复其他扩展的工具。

### 5.2 Remote Compaction v2

Pi 继续决定何时压缩。扩展只订阅公开的 `session_before_compact`；不接管阈值、不 monkey-patch 私有 agent loop。当前 Pi 已在下一次 assistant 响应前运行自动压缩，因此旧扩展的 inline-compaction adapter 不再需要。

每个远端 checkpoint 必须采用双表示：

```text
CompactionEntry.summary
  = 唯一 marker + 有界的可读 fallback

CompactionEntry.details
  = 原始 opaque compaction item
  + 有界的 provider-visible 真实 user replay window
  + model / endpoint / account fingerprint / auth kind

CompactionResult.usage
  = 可选 provider usage（不在 details 中重复保存）
```

同一 model、官方 endpoint、账户和认证类型全部匹配时，普通请求把 marker summary 替换为：

```text
retained 真实 user messages → 一个 opaque compaction item → Pi kept tail
```

不兼容、关闭功能或无法取得兼容认证时，不 replay opaque 数据，继续使用可读 fallback。这使用户可以安全换模型、换 provider 或关闭功能，只是上下文质量退化为文本 fallback，不需要锁死会话。

这里不能原样照搬只保存 `encrypted_content` 的实现。Toolkit 保留当前 Codex 行为中 Pi 能忠实表达的子集：一个有界窗口内 provider-visible 的真实 user messages，随后恰好一个最新 compaction item；不复刻 Codex 私有的 agent-message、hook-prompt、image-budget 或 world-state 机制。发布前仍须通过连续两次压缩验证。参见固定版本的 [Codex `compact_remote_v2.rs`](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/core/src/compact_remote_v2.rs)。

请求还必须满足：

- 仅向规范化后的官方 endpoint 发送对应凭据。
- 发送 `x-codex-beta-features: remote_compaction_v2`。
- input 尾部恰好一个 `compaction_trigger`。
- 等到 `response.completed`。
- output 中恰好一个 compaction item；允许同时出现其他 output item。
- 原样保存 opaque item，不解码、不日志化。
- 自定义 compaction instructions 直接交回 Pi 原生压缩。
- 远端失败返回控制权给 Pi 原生压缩；双表示保证已有分支仍有可读上下文。

该功能默认关闭。远端成功后，entry 保存唯一 marker 与最多 12,000 字符的确定性 transcript excerpt。replay 前重新取得 OAuth，并严格匹配 provider、API、model、规范化 endpoint、认证类型和哈希后的账户身份。`/pct status` 只报告结构资格，不刷新凭据，也不声称账户已经 live 验证。

可参考 [pi-codex-compaction 的 dual representation](https://github.com/jvm/pi-mono/blob/0434813418e502b4b5b78559a0efb51058e28255/packages/pi-codex-compaction/src/remote-compaction.ts)，但 retained replay window 必须按当前 Codex 源码补齐后再发布。

### 5.3 Image Generation

第一版工具为 `openai_generate_image`，只做单张生成：

- 参数：`prompt`，可选 `size`、`quality`。
- 使用 `gpt-image-2` 和当前官方 Images API route。
- 主模型可以是 OpenAI 以外的模型，只要它支持普通工具调用，且 Pi 中另有可用 OpenAI/Codex 认证。
- route/auth 选择固定为：先复用当前主模型的兼容官方 OpenAI/Codex route；否则先选 `openai-codex` OAuth，再选 `openai` API key。`/pct status` 显示最终选择的 backend/account 类型，不增加 provider 选择器。
- Image Generation 不使用 Web Search executor 的 model 或 effort；chat model 仅作为固定 `gpt-image-2` 请求的认证载体。
- 文本主模型也可生成图片，但不能自行视觉验收。
- API-key 认证只发送到 `https://api.openai.com/v1/images/generations`；Codex OAuth 只发送到 `https://chatgpt.com/backend-api/codex/images/generations`。dispatch 前立即重新校验刷新后的 route。
- 只发送一次 JSON 请求并设置 `redirect: "manual"`；3xx 及其他终态失败都不重试，也不切换 backend。
- 原始 PNG 以独占创建方式保存到 `<getAgentDir()>/artifacts/pi-codex-toolkit/<uuid>.png`，不接受任意 `outputPath`，不覆盖已有文件。
- 返回含绝对路径的简短文本、一个 raw-base64 Pi `ImageContent`，以及不含 payload 的 path/MIME details，让 TUI、session 与 vision 模型按 Pi 原生机制消费。
- 请求 dispatch 后不自动重试，避免结果未知时重复计费或重复生成。
- 传递 Pi abort signal；若服务端已开始生成，只报告结果未知，不声称已经取消。
- 不把 prompt、base64 或图片写入 debug 日志。

公开 API-key 契约遵循 OpenAI Images API。ChatGPT/Codex OAuth endpoint 与 `chatgpt-account-id` header 固定依据 Codex `rust-v0.150.1` 源码，不对外宣称为公开第三方 OAuth API。其真实 Pi 0.84.4 OAuth 发布门禁已通过；本地没有对应凭据时，API-key live probe 明确保持 pending。

图片编辑、引用图上传和最近对话图片选择延后。它们需要上传确认和 headless 行为，不应挤进第一版生成工具。

Pi 自带 `read` 已支持 jpg/png/gif/webp/bmp，并把图片作为 attachment 返回，因此不增加 `view_image`。参见 [Pi read tool](https://github.com/earendil-works/pi/blob/6c87d9a026677b601e8278030dcf1ad97fe0bd86/packages/coding-agent/src/core/tools/read.ts#L213-L270)。

### 5.4 Apply Patch

`apply_patch` 默认关闭，只接受一个 `patch` 字符串。支持 grammar 的模型获得
有界的 Codex-compatible grammar；其他普通 tool caller 获得等价 JSON schema。
Add、Delete、Update、Move、多文件、多 hunk、`@@` locator 与
`*** End of File` 均进入同一个 parser 和 executor。exact、忽略行尾空白、完整
trim 三层匹配中，首个产生候选的层级必须恰好定位一处。

所有可预期失败都在 mutation 前发现：syntax/context 错误、路径冲突、containment、
可见 symlink、UTF-8、换行风格与文件类型。全部 replacement 暂存后再做最后一次
abort 检查。单个已提交路径是 atomic 的，但 move 或多文件 patch 不是 transaction；
commit 失败会如实报告已完成路径以及失败或 unknown operation。工具不自动 retry
或 rollback，并保留 UTF-8 BOM、LF/CRLF、末尾换行状态与普通 POSIX executable bit。

这是普通 Pi 工具，因此保留 `edit` 和 `write`，也不增加 provider/model routing
表。Pi 0.84.4 没有接入 Responses API typed `apply_patch_call` 的 transport seam，
所以本版不实现该一等协议。parser 与前三层 matcher 是 Codex commit
[`b8c8637`](https://github.com/openai/codex/tree/b8c86376a258e55efc8e5ecfbabc21c16c07d814)
的必要修改子集；随包 notices 记录其 Apache-2.0 来源。

### 5.5 Computer Use

MVP 只暴露六个高覆盖工具：

- `computer_use_list_apps`
- `computer_use_get_app_state`
- `computer_use_click`
- `computer_use_type_text`
- `computer_use_press_key`
- `computer_use_scroll`

`drag`、`set_value`、`select_text` 和 secondary action 在真实需求出现后再加。

所有 Computer Use 工具设置 `executionMode: "sequential"`，直接使用 Pi 的顺序执行语义，不自建 Promise queue。每个动作都保持为可见的 Pi tool call，不在一次隐藏调用里运行桌面 agent loop。

Computer Use MVP 要求当前模型 metadata 包含 image input。Computer Use 的 accessibility tree 理论上可支持文本模型，但这会引入截图过滤、坐标工具裁剪和两套提示语义；为保持简单，先不做 accessibility-only 模式。

app-server client 必须：

- 只使用成套的 ChatGPT.app `codex`、`cua_node/bin/node_repl`、bundled
  Node、bundled modules 与已安装的 Computer Use helper。
- 用同一个私有临时目录作为 app-server working directory、`CODEX_HOME` 与
  thread `cwd`，只注入一个 `node_repl` server，且只启用它的 `js` tool。
- 懒启动；Pi session shutdown 或关闭配置时终止进程。
- 完成 `initialize → initialized`。
- 使用一个 ephemeral thread。
- 给每个 RPC 设置超时并关联响应 ID。
- 每个 Pi tool call 只 dispatch 一个预定义 JavaScript template；不暴露
  arbitrary JavaScript、不启动 model turn，也不执行隐藏 state read。
- 不自动重试 click/type/key/scroll。timeout 或断线后提示结果未知，下一次先 `get_app_state`。
- dispatch 前响应 abort；dispatch 后不承诺撤销已经发生的桌面动作。
- 只处理 active thread、`serverName === "node_repl"` 且 connector metadata
  为 `connector_id === "computer-use"`、并带非空 canonical
  `_meta.tool_params.app` 的 form-mode elicitation，其余请求一律 decline。app id
  只 trim、不改变大小写。`Confirm` 的 Yes 返回 object content 和
  `_meta.persist === "session"` 并加入当前 client Set；No 返回 null content、不
  加入，下次仍询问。`Always` 对同一窄范围请求自动 accept，不显示 Pi
  confirmation；Set 命中时镜像 node_repl 的 persisted-state conversation response。
- 普通 turn、compaction、未改变配置的 `/pct reload` 和仍具资格的 model switch
  复用当前 client；禁用、失去资格、tool 冲突、session shutdown 或任一 approval
  mode 切换都会关闭 client。Set 生命周期严格等于 client，永不持久化。

Toolkit 永远不配置或 fallback 到旧的 direct
`mcp_servers.computer-use` / `SkyComputerUseClient mcp` 路径。未来如果迁移到
`cua_repl`，应在新的协议探针之后替换这一窄 runtime 边界；当前不实现
multi-backend adapter。`/pct status` 在便宜资格检查通过后，只执行一次
import/`sky.target === "mac"` probe，并在 `finally` 中关闭专用 probe client。

## 6. 认证与 official-route 边界

认证必须来自 Pi 的 model registry/auth API，不能解析私有 credential 文件，也不能从 ChatGPT.app 抽取 token。

route resolver 至少区分：

- ChatGPT/Codex OAuth：只发送到规范化后的 `https://chatgpt.com/backend-api/codex/...`。
- OpenAI API key：只发送到规范化后的 `https://api.openai.com/v1/...`。

拒绝 HTTP、userinfo、相似域名和任意第三方 gateway。未来若支持 gateway，必须使用独立凭据与显式配置，不能复用 ChatGPT OAuth。

这不是通用 SSRF 防御框架，而是防止把高价值认证发错目的地的最小必要边界。

## 7. 工具激活与生命周期

Toolkit 只修改自己拥有的 tool names。同步发生在：

- `session_start`
- `model_select`
- `/pct config` 保存后
- `/pct reload`

Pi 的 `setActiveTools` 会替换完整的 active-name 列表。因此同步时先读取当前列表，只增加或删除 Toolkit 自己的名字，并且只在列表变化时写回。如果 `getAllTools()` 显示同名工具最终由另一个扩展注册成功，Toolkit 只报告冲突，不修改该名字。

不要在每次请求或 `before_agent_start` 强制同步。否则会覆盖用户通过 Pi `/tools` 做的临时选择，还可能造成当前 prompt 与 tool schema 不一致。

`/pct config` 是持久配置；Pi `/tools` 是当前模型阶段的临时覆盖。模型切换或 `/pct reload` 后，持久配置再次生效。

同名 Pi 工具由扩展加载顺序决定实际实现。Toolkit 只用 Pi 的公开 tool metadata 做上述 ownership 检查，不禁用或重写其他扩展；以下重叠实现仍不能同时启用：

- 另一个 Remote Compaction extension。
- `pi-codex-computer-use` 与本项目 Computer Use。
- 另一个同名 `openai_generate_image` 或 `openai_web_search`。
- 另一个同名 `apply_patch`。

Pi 0.84.4 的公开 active-tool projection 不包含 constrained-sampling metadata。
Toolkit 只有在 winning name 和 `sourceInfo.path` 都确认属于本扩展注册时，才补回
本地 grammar；第三方 winner 保留自己的 JSON-visible schema，绝不会套用 Toolkit grammar。

## 8. 错误、取消与日志

### 错误原则

- 某项能力不可用时，只禁用或报错该能力，不阻止 extension 启动。
- Native Search/Remote Compaction 在不适用时不修改请求。
- Sidecar Search 错误直接返回当前 tool call；不自动 retry、换 executor 或回退 Native Search。
- Remote Compaction 失败交回 Pi 原生压缩。
- Apply Patch 在 commit 前完成 preflight 与 staging；partial commit 后不 retry 或 rollback，并报告已完成及失败/unknown operation。
- Image Generation 和有副作用的 Computer Use 调用不做 dispatch 后自动重试。
- app-server 退出时拒绝 pending requests，清空 ephemeral thread；下一次调用可重新启动。

### 调试日志

只用一个 `debug` boolean，输出到 stderr。允许记录：

- 时间、feature、provider/api/model ID。
- endpoint host，不含 path query 与认证。
- 请求耗时、HTTP/RPC 状态、request ID。
- content block 类型与数量。
- 不含 payload 的错误类别。

永远不记录 headers、token、prompt、tool arguments/result、截图、base64、opaque checkpoint 或可读 compaction fallback。无需实现通用 redactor；从源头不采集这些字段即可。

## 9. 协议探针状态

这些是 release gate，不是长期框架：

1. **Remote v2**：官方 Codex 连续两次压缩及 restart、resume、fork、disable、model mismatch 与正常 turn 检查均已通过。
2. **Web Search**：确定性 `off/native/sidecar/auto` 覆盖、Native 连续两轮和 OpenAI → 非 OpenAI → OpenAI 状态切换已通过。Codex OAuth 协议 probe 已用一次 hosted request 得到 answer 与 sources。随后，真实 Grok 4.6 RPC 会话选择 `openai-codex/gpt-5.4` 与 `low` executor effort，完成一次返回非空 answer/sources 的 Sidecar Search；Search 只 dispatch 一次，Grok 请求没有收到 native hosted Search tool。大于 128k input 与非 OpenAI 主模型调用 API-key Sidecar 的 live probe 仍待完成。
3. **Image Generation**：以 Codex 为主模型时，ChatGPT/Codex OAuth 的 Pi 图片结果与 follow-up live gate 已通过。同一 Grok 4.6 RPC 会话也完成一次 Images dispatch，返回有效的持久化 PNG，再完成无工具 follow-up；没有新增 Search 或 Images dispatch。OpenAI API-key live probe 仍待完成。
4. **Apply Patch**：确定性测试覆盖 grammar/JSON transport、parser/matcher、
   containment 与文件保真、staging cancellation、partial commit 报告、queue
   协调、激活与冲突。MVP 不需要 credentialed provider live gate，因为实际执行
   是本地普通 Pi 工具。
5. **Computer Use**：在隔离的真实 Pi probes 中只调用 `list_apps` 和一次
   benign `get_app_state`，确认原生 text/image blocks 与清理，再完成一个普通
   follow-up turn；live gate 不调用任何 action method。2026-08-29 的隔离探针已
   通过 bundled runtime preflight、`list_apps`、最终单次 `get_app_state` 的
   text/JPEG 结果、无工具 follow-up 与清理；没有 dispatch action、没有修改权限，
   也没有保留 app inventory、accessibility text 或 screenshot payload。修正后的
   client-Set 版本随后通过完整真实 Pi `Confirm` / `Always` 矩阵：同 app 的
   Yes-once、不同 app 独立确认、No 后再次询问、未变更配置的 `/pct reload`、
   `/new` 重置、跨 `/new` 的 `Always`，以及普通无工具 turn。该矩阵也只使用
   state read，且没有修改权限。

探针失败时缩小或暂缓对应能力，不为了通过探针而创建通用兼容层。

## 10. 交付顺序

1. Foundation：配置、`/pct`、状态、official-route/auth、debug metadata。
2. Core Search/Responses：统一 Web Search 配置、Native/Sidecar 两条路径与 Remote Compaction probe/实现。
3. Image Generation：单张生成、artifact、Pi 图片结果。
4. Apply Patch：一个默认关闭的 provider-neutral 工具、有界 parser、静态 containment 与 staged per-path commit。
5. Computer Use：通过窄 node_repl/Sky runtime 提供六个默认关闭工具，
   并保留独立只读 live gate。
6. 只有真实需求出现后，才评估网页抓取、图片编辑或更多 Computer Use 动作。

## 11. 关键验收标准

- 所有开关关闭时，当前 provider 请求与 Pi 原生压缩行为不变。
- 不兼容 provider/endpoint 时不发送 OpenAI/Codex 凭据，也不修改 payload。
- payload 合并不覆盖已有 tools、include 或未知字段。
- `auto/native/sidecar` 组合在模型切换后始终只启用一条 Toolkit 搜索路径；非 OpenAI 主模型可通过选定 executor 获得 answer 与可点击 sources。
- Sidecar 不自动附带完整主会话历史，只原样发送主模型生成的 query；失败不触发第二次搜索请求。
- Remote Compaction 经两次连续压缩和会话恢复后仍保持上下文；不兼容切换使用可读 fallback。
- 生成图片保存为唯一 artifact，并能在 Pi 中显示；不发生隐式重试。
- Apply Patch 的 grammar 与 JSON 调用共用 executor，保留文件格式，在 mutation 前发现可预期失败，并如实报告非 transaction commit failure。
- Computer Use 缺失或协议漂移不影响其他能力；桌面动作严格串行且不自动重放。
- `/pct status` 能说明每项已实现能力的有效状态及原因。
- debug 输出不含认证、提示词、图片或 checkpoint 内容。

## 12. 参考资料

- [Codex source](https://github.com/openai/codex)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
- [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [OpenAI Image Generation](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI Apply Patch](https://developers.openai.com/api/docs/guides/tools-apply-patch)
- [固定版本 Codex Apply Patch 源码](https://github.com/openai/codex/tree/b8c86376a258e55efc8e5ecfbabc21c16c07d814/codex-rs/apply-patch)
- [Pi source](https://github.com/earendil-works/pi)
- [pi-openai-toolkit](https://github.com/awoaCrim/pi-openai-toolkit)
- [pi-mono](https://github.com/jvm/pi-mono)
- [pi-web-access](https://github.com/nicobailon/pi-web-access)
- [pi-codex-computer-use](https://github.com/danecando/pi-codex-computer-use)
