# Pi Codex Toolkit 架构

> 范围：Pi 0.87 系列上的 0.2.0 版本，不是历史 0.1.0 artifact。本指南统一汇总带日期的公开验证与限制，见 [§9](#9-协议探针状态)。历史运行保留各自原始修订和平台范围。

## 1. 结论

Pi Codex Toolkit 不是另一个 Codex 前端，也不接管 Pi 的 agent loop。它只在 Pi 已有生命周期上增加少量、边界明确的 OpenAI/Codex 能力：

1. 对官方 OpenAI/Codex Responses 请求做原生 Web Search 注入。
2. 以普通 Pi 工具为其他主模型提供 OpenAI sidecar search。
3. 在 Pi 决定需要压缩时，尝试 Codex Remote Compaction v2。
4. 以普通 Pi 工具提供 OpenAI/Codex 图像生成。
5. 以普通 Pi 工具提供 provider-neutral、兼容 Codex patch 语法的 `apply_patch`。
6. 通过 ChatGPT.app bundled Codex app-server、`node_repl` 与受信任的
   `@oai/sky/service`，以普通 Pi 工具桥接本机 Computer Use。
7. 提供默认关闭的可续跑 shell session（`exec_command` / `write_stdin`），
   无需第二个进程管理器即可继续运行中的进程。
8. 提供可选的默认关闭 Code Mode（`exec` / `wait`）：在有界 cell 中运行一段
   短 JavaScript，只把显式声明的适配工具经其现有 executor dispatch。

Pi 继续拥有对话、工具循环、会话树、自动压缩时机和普通编码工具。项目只增加边界明确的 Apply Patch 编辑原语、feature-local 的可续跑 shell session manager 与可选的、有界的 Code Mode cell manager，不复刻 Codex 的 shell 编排、PTY 终端仿真、`view_image`、goal、plan、review 或 multi-agent 语义。

核心原则是：**增强 Pi，不在 Pi 里面再运行一套 Codex agent。**

能力默认按 provider-neutral 设计：只要主模型能调用普通 Pi 工具，Sidecar Search、Image Generation、Apply Patch 和 Computer Use 就不因主模型品牌而关闭。只有协议本身绑定当前 OpenAI/Codex Responses 会话时，Native Search 和 Remote Compaction 才限制 provider；Computer Use 的 image/UI 条件属于模态与运行环境限制，不是 provider 限制。

## 2. 范围

### 当前源码能力

| 能力 | 形态 | 主模型限制 | 实际执行方 | 验证状态 |
| --- | --- | --- | --- | --- |
| Native Web Search | 修改当前 Responses payload | 官方兼容的 OpenAI/Codex Responses route | Responses hosted tool | 两轮 live search 通过；大于 128k probe 待完成 |
| Sidecar Web Search | 普通 Pi 工具 `openai_web_search` | 任意可调用普通工具的主模型；另需选定 OpenAI/Codex executor | 独立 Responses + hosted `web_search` | Codex OAuth 协议与 Grok 主模型 RPC 验收通过；API-key 仅确定性覆盖，live 待完成 |
| Remote Compaction v2 | `session_before_compact` hook + checkpoint replay | 官方 `openai-codex` provider/API/endpoint | Codex Responses | 连续压缩、恢复、fork 与 fallback live gate 通过 |
| Image Generation | 普通 Pi 工具 `openai_generate_image` | 任意可调用工具的主模型；另需可用 OpenAI/Codex 认证 | 独立 Images API 请求 | Codex 与 Grok 主模型 OAuth live gate 均通过；API-key 只有确定性测试，live 待完成 |
| Apply Patch | 普通、顺序执行的 Pi 工具 `apply_patch` | 任意可调用普通工具的主模型 | Pi 当前工作目录下的本地文件系统 | parser、安全、commit、生命周期与 transport 确定性测试通过 |
| Shell Sessions | 两个普通 Pi 工具 `exec_command` / `write_stdin`，共用一个本地 executor | 任意可调用普通工具的主模型 | 本地 `node:child_process` 进程组 | 修复后的进程/恢复 fixture 和公开 host 离线验证；模型报告仅为修复前证据（§9） |
| Code Mode | 两个普通 Pi 工具 `exec` / `wait`，共用一个有界 worker-per-cell 管理器 | 任意可调用普通工具的主模型；嵌套 adapter 遵循各自 feature 的启用状态 | 独立 `worker_threads` worker + 全新 `vm` context；显式 adapter 复用现有 shell/Apply Patch executor | 修复后的 settlement/权限/恢复 fixture 和公开 host 离线验证；无新模型效率结论（§9） |
| Tool Discovery | 一个普通 Pi 工具 `find_tools`，基于显式 deferred-name 目录 | 任意可调用普通工具的主模型；独立于 Code Mode，默认关闭 | 通过公开 `setActiveTools` 做本地增量 active-set 更新；执行仍走 Pi 正常下一轮 dispatch | 查询、加载与 fail-safe 生命周期确定性测试通过；description 精简与全量 deferral 已实测；历史 DeepSeek/Grok/Kimi 18/18 任务通过（9 ON discovery、9 OFF 基线），ON 增加轮次；非修复后测量 |
| Computer Use | 六个静态、顺序执行的普通 Pi 工具 | MVP 要求模型支持 image input、macOS 且有交互 UI | ChatGPT.app bundled `codex app-server` → `node_repl/js` → `@oai/sky/service` | fake app-server 测试、只读 live gate 与 approval-mode 矩阵均通过 |
| 配置与状态 | `/pct` 命令和一个 JSON 文件 | 无 | Pi extension | 单元测试通过 |

### 实验性 Computer Use 边界

| 能力 | 形态 | 主模型限制 | 实际执行方 |
| --- | --- | --- | --- |
| Computer Use | 一组静态、顺序执行的普通 Pi 工具 | MVP 要求模型支持 image input、macOS 且有交互 UI | ChatGPT.app bundled `codex app-server` → `node_repl/js` → trusted Sky service |

Computer Use 已在默认关闭的实验开关后实现。它的本机依赖和协议漂移
风险明显高于 Responses 能力，因此发布有独立的只读验收门禁；该门禁已于
2026 年 8 月 29 日在该探针当时配套的桌面组件上通过。

配置 schema 与菜单暴露 `computerUse.enabled` 以及 `Confirm`、`Always` 两种
approval mode，不暴露 backend、安装器、timeout 或兼容性设置。

### 为什么保留两条 Web Search 路径

Native Search 让当前官方 OpenAI/Codex 主模型直接使用 hosted tool；Sidecar Search 则让 Claude、Gemini 或其他支持普通 Pi 工具调用的主模型，通过一次独立 OpenAI Responses 请求获得答案与 sources。后者会增加一次 OpenAI 请求、延迟和费用。Toolkit 不自动附带完整主会话历史，但会把主模型生成的 query 原样发送给 executor；query 本身可能引用或概括会话内容。

用户不需要额外安装 `pi-web-access`。本项目只实现 OpenAI-only、query-only 的 sidecar，不复制它的多 provider router、抓取器或 fallback 系统。两条路径属于同一个 Web Search 能力，并在每轮互斥。

### 明确不做

- Codex backend mode、`dynamicTools` 或完整 Codex agent loop。
- 完整 Codex shell 编排/PTY 终端/`view_image`/goal/plan/review/multi-agent surface，或 Responses API 一等 `apply_patch_call` 协议的复刻。有界、本地、可续跑的 shell session 在范围内；terminal emulator、job-control 产品或远端进程托管不在范围内。
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
  execution-mode.ts
  execution-dialect.ts
  execution-invocation.ts
  execution-editor.ts
  execution-diagnostics.ts
  execution-output.ts
  bounded-text.ts
  tool-ownership.ts
  openai/
    route.ts
    request-pipeline.ts
    usage.ts
    native-search.ts
    sidecar-search.ts
    remote-compaction.ts
    image-generation.ts
  computer-use/
    app-server-client.ts
    lifecycle.ts
    tools.ts
  shell/
    manager.ts
    tools.ts
  code-mode/
    manager.ts
    adapters.ts
    tools.ts
  tool-discovery/
    directory.ts
    tools.ts
```

职责如下：

- `index.ts`：注册 hooks、命令和工具；不放协议逻辑。
- `config.ts`：唯一配置类型、默认值、读写和校验。
- `commands.ts`：`/pct config|status|reload` 的薄 UI。
- `status.ts`：把配置、当前模型和外部依赖投影成可读状态（`active`、`deferred`、`unavailable` 或 `off`）。
- `apply-patch.ts`：解析、校验、暂存并提交一次有界的本地 patch；不负责 provider routing。
- `openai/route.ts`：解析官方 route 与 Pi 认证；这是唯一允许凭据进入网络请求的边界。
- `openai/request-pipeline.ts`：一个确定顺序、幂等的 Responses payload pipeline。
- 四个 OpenAI feature 文件：各自拥有协议和结果转换，不实现通用 feature interface。
- `computer-use/app-server-client.ts`：单个 app-server 客户端：进程启动、JSONL-RPC 握手、就绪等待、请求关联与预算、传输重置与关闭。
- `computer-use/lifecycle.ts`：扩展侧 Computer Use 客户端的 owner：可复用的 runtime 客户端及其审批模式、专用状态探针、清理失败后仍被持有的客户端、拒绝过期调用方的生命周期围栏（epoch、preflight 计数、session 停止），以及唯一一条负责重试或释放的 `dispose`/`cleanup` 路径。
- `computer-use/tools.ts`：固定的 Pi tool schema 与 MCP 内容转换。
- `shell/manager.ts`：基于 `node:child_process` 的 session-owned 进程管理器；负责 ID、有界增量 output、stdin、终止、保留策略，以及窄 `start`/`write`/`close` executor 契约。
- `execution-mode.ts`：纯粹的模型规则匹配与 route 准入——glob、首个命中的规则、requested 与 effective route、准入 notes，以及某条 route 替换的原生名；不访问文件系统，也不访问 Pi 宿主。
- `execution-dialect.ts`：唯一受支持的 Codex 调用方言，由直调工具与嵌套 adapter 共用——接受的拼写、拒绝的冲突、不支持字段，以及有文档记载的 token→字节换算，全部在产生任何效果之前拒绝；纯函数，启用状态、归属与句柄查找仍属于各自的 manager。
- `execution-invocation.ts`：嵌入方通过 `createPiCodexToolkit` 安装的通用调用缝——一次可信的 per-call 环境与策略判定，在直调与嵌套两条路径上同样应用；不从任何特定编排器推导行为。
- `execution-editor.ts`：由 Pi `select`/`input` 对话框搭建的 `/pct config` 规则页——草稿的增删改排序、匹配预览与 legacy 迁移预览；自身不执行保存。
- `execution-diagnostics.ts`：每次提交成功的同步后发布到 `pi.events` 的有界 `version: 1` 记录——只有名称、标志与一个 config revision，外加打包 manifest 的身份；填充它的宿主读取由 `index.ts` 负责。
- `execution-output.ts`：独立累计文本 capture、惰性私有文件与显式 session 文件 owner；不是 executor、archive registry、quota 服务或模型 reducer。
- `bounded-text.ts`：Shell 与 Code Mode 共用的码点安全、按尾部截断的预览缓冲（`append`、`markDropped`、`drain`）；只做预览，不做 capture。
- `tool-ownership.ts`：对可见 Pi 工具做精确源路径归属判定（`owned` / `foreign` / `absent`），并提供 sync 与实时派发两条路径各自依赖的两个不同谓词。
- `openai/usage.ts`：唯一的 Responses `usage` 解析器，套用模型成本；Sidecar Search 与 Remote Compaction 共用。
- `shell/tools.ts`：两个普通 JSON tool definition、共享 adapter schema 与 literal 结果渲染；不管理进程。
- `code-mode/manager.ts`：worker-per-cell 生命周期、fresh-cell 状态、有界 output、yield/wait cursor、取消与保留策略；不放工具或 provider 协议。
- `code-mode/adapters.ts`：显式嵌套工具注册表，负责 schema 校验、实时权限、可取消的有界 gate、独立 shell 控制与仅针对 Apply Patch 的额外确认。
- `code-mode/tools.ts`：`exec` / `wait` 两个普通 JSON schema 与结果渲染；不放协议逻辑。
- `tool-discovery/directory.ts`：纯 managed-set 逻辑——固定 deferrable 名字列表、有界搜索排序、原子组展开与 load 校验；不触碰 Pi API 或配置存储。
- `tool-discovery/tools.ts`：唯一的 `find_tools` 定义与结果渲染，通过注入的 eligibility/activation callback 工作；本身绝不执行其他工具。

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
启动若始终未就绪——无论卡在握手、某次 readiness 轮询，还是 readiness 截止
时间——一律报告 `node-repl-unavailable`；`timeout` 只属于已派发的调用。

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

只有当前、通过校验、未命中缓存的异步确认等待，才暂停对应 invocation 的外层
请求预算。不新增人工确认截止时间：本地 UI 或 RPC frontend 若一直不回答，当前
工具/turn 可持续等待并保留资源，直到作出决定、host 取消/关闭或 runtime 失败。
缺少 confirmation handler 不会授权新 app；现有 headless 资格门禁不变。默认本地
TUI 中，Esc/No 关闭并拒绝当前确认，不一定终止整个 agent turn；host abort 是
独立的 invocation 取消路径。RPC 的操作键与可见对话框关闭行为取决于 frontend：
自有 cancellation signal 会取消 Pi 中待决的 confirmation promise，并使晚到回答
失去授权效力，但不保证远程 frontend 隐藏其对话框。

确认结束后，外层计时器只恢复剩余的非人工等待预算，progress 不续期。内层
120 秒参数、外层 130 秒默认值/上限、有限的 startup/probe 预算，以及上游 MCP
active-time 预算（已验证 bundle 中默认为 300 秒）均保持不变。Sky 可在 operation
期间暂停内层计时器，因此仍需更短的外层预算；120 秒不是桌面动作通用的墙钟
时限。超时或取消均不能证明桌面效果已经停止。已 dispatch 的动作被中断后仍为
unknown，必须显式成功调用 `get_app_state` 才能执行下一动作；不会自动观察或重放。

### 4.6 Shell Sessions

```text
普通 Pi tool call（exec_command | write_stdin）
  → 共享方言归一化（Codex 拼写、别名冲突、不受支持字段）
  → 校验参数
  → 调用缝（可信的单次调用环境，随后是适用策略）
  → session-owned 进程管理器（node:child_process）
  → 在破坏性 preview 限制前分别捕获解码 stdout/stderr
  → 有界增量结果 + 独立 control/recovery 元数据
  → Pi rendering/transcript
```

管理器是 feature-local 的。它暴露窄 `start`/`write`/`close` executor，供可选
Code Mode adapter 复用同一实例；不会增加第二个进程 backend。嵌套 adapter 运行
同一个归一化器与同一条调用缝，因此两个入口只有一套方言、一套策略。

### 4.7 Code Mode

```text
普通 Pi tool call（exec：grammar 原始源码或 JSON code | wait）
  → 首行 pragma + 方言归一化
  → 有界 JavaScript cell（worker_threads worker + 全新 vm context）
  → uses 中声明的工具的显式 adapter（省略时为准入快照）
  → dispatch 时的准入、调用缝、Patch 审批
  → 被适配 feature 的现有 executor
  → 以 producer credit 捕获已发出文本与序列化的选定 result/error
  → 有界 preview + 独立 shell control/recovery
  → Pi rendering/transcript（外层调用上另有有界嵌套进度）
```

外层调用是唯一的 `tool_call` / `tool_result` 事件。hook 只能通过外层调用的
`code` 与 `uses` 参数审查嵌套 dispatch；公开 extension API 无法发出
per-nested-call 事件。嵌套的 start/等待 approval/end 记录通过外层调用普通的
update 回调转发：只有控制身份与结果码，绝不是伪造的嵌套事件。

### 4.8 Tool Discovery

```text
deferred Toolkit 名字（toolDiscovery.deferred 显式条目）
  → 从普通 active-tool 投影中隐藏
  → 模型用 query 和/或 load 调用 find_tools
  → 逐名字复查 ownership + feature + runtime decision
  → 增量 setActiveTools([...active, ...eligible])
  → 下一个 model turn 暴露已加载工具
  → 实际调用仍由该工具自己的 executor 校验并执行
```

Discovery 只改变 Pi 暴露哪些已注册的 Toolkit 名字。它不调用其他 executor、不授予
权限，也不绕过任何嵌套 adapter 检查。未提供任一参数、列表格式错误、discovery 被
禁用或 `find_tools` 冲突时，调用会在任何状态变更前抛错。

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
trim 三层匹配中，首个产生候选的层级必须恰好定位一处。与 Codex 一致，
`Update File` hunk 中的裸空行按空 context 行读取，old line 以空行结尾的 hunk
去掉该空行后同样可以匹配，并保留非空的末尾新增行；与 Codex 不同，该重试不会退到
空 pattern，因此只有一行空 old line 的 hunk 仍报 context mismatch。`Add File`
hunk 仍然严格，其中的裸空行依旧被拒绝。

所有可预期失败都在 mutation 前发现：syntax/context 错误、路径冲突、containment、
可见 symlink、UTF-8、换行风格与文件类型。现有源文件（包括 `Delete File` 目标）
必须是有效 UTF-8 文本，换行须统一为 LF 或 CRLF；非 UTF-8、裸 CR 和混合换行会在
mutation 前被拒绝。不支持二进制文件删除。全部 replacement 暂存后再做最后一次
abort 检查。单个已提交路径是 atomic 的，但 move 或多文件 patch 不是 transaction；
commit 失败会如实报告已完成路径以及失败或 unknown operation。工具不自动 retry
或 rollback，并保留 UTF-8 BOM、LF/CRLF、末尾换行状态与普通 POSIX executable bit。
没有任何行的源文件（0 字节，或只有 BOM）没有可保留的换行风格与末尾换行状态，因此
Update 按 Add File 的方式写入新增内容：LF 换行并以换行结尾，有 BOM 时写在 BOM 之后。
非空源文件缺少的末尾换行是刻意保留的，这与 Codex `b8c8637` 不同：后者给每个非空
Update 输出补上末尾换行。例如对源文件 `"a\nb"` 分别应用 ` a`/`-b`、
` b`/`+c`/`*** End of File`、`-a`/`+z`/` b` 这三个 hunk，这里依次得到 `"a"`、
`"a\nb\nc"`、`"z\nb"`，Codex 则给每个结果补上末尾 `\n`。

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

### 5.6 Shell Sessions

Shell Sessions 默认关闭且 provider-neutral。它只增加两个自有名字——
`exec_command` 与 `write_stdin`——并作为一个原子 group 激活。任一名字冲突时，
两个 Toolkit 名字同时停用，保留获胜的第三方注册及所有无关 active tools。

管理器每个实例只通过 Pi 公开的 `getShellConfig()` 解析一次 shell。它用
`node:child_process` spawn：POSIX 下 `detached`、`windowsHide: true`、继承进程
环境、stdin/stdout/stderr 均为 pipe；`stdin` command transport 将命令写入 stdin
并结束该 pipe，因此该 session 的 stdin 不可交互，非空 `write_stdin` input 会被
拒绝。Shell Sessions 只使用 pipe：没有 PTY，也不声称 TTY 语义；未来 TTY 路径必须
先通过真实 PTY fixture。

契约：

- 直接工具与嵌套 adapter 共用一个方言归一化器：`cmd`/`command`、
  `workdir`/`cwd`、`session_id`/`sessionId`、`chars`/`input`、
  `yield_time_ms`/`yieldTimeMs` 以及 `max_output_tokens` 预算，都是既有字段的
  Codex 拼写。同值重复通过；值冲突、不受支持的 Codex 字段与数字 handle 在任何
  执行之前拒绝。结果补充 `session_id` 与 `exit_code`。
- 命令只启动一次，永不重新启动或重放。
- close 会封禁此前尚待准入的 start，包括等待 cwd 校验的调用。预先 abort 不执行；
  异步 ENOENT/EACCES 与同步 spawn 失败在零 yield 时也会以 `spawn-failed`
  settle，不占用 phantom running slot。之后显式重新启用可启动新工作。
- 破坏性 observation 串行并重新校验 handle；input/stop 不排在安静 poll 后。
  每个 session 最多 **262,144 UTF-8 字节、16 个 outstanding input 调用**，
  reservation 保留到 transport 与该次调用都 settle。这复用 stream/job envelope，
  不是 Node high-water mark 或磁盘 quota。
- input 原样转发，不自动加换行/EOF。`closeStdin` 排在已接受字节之后，重复 EOF
  无害；EOF/broken pipe 后的非空 input 或与 `terminate` 合并的非空 input 在发送
  前拒绝。`stdin-overload` 也不发送。EPIPE/write/end 失败为 `stdin-failed`，
  delivery unknown；提交后等待超时可返回 `inputDelivery: unknown`。`written`
  仅表示 transport callback，**不证明应用消费或执行**。发送前取消不写入，提交后
  取消可能留下 unknown delivery；绝不自动重发。
- 每个 stream 的 rolling preview 为 256 KiB，溢出丢弃最旧完整 code point 并置
  `dropped`。read 共用一个 `maxOutputBytes` 预算，stdout 优先。
  `truncated`/`dropped` 表示 preview 丢失，而非 capture 丢失；独立累计 prefix
  capture 发生在这些限制之前（§5.9）。
- POSIX 完成要求 leader 退出、普通进程组消失、两个 capture stream 结束。普通
  同组 child 即使重定向输出也仍被管理。50-ms group probe 不是丢弃继承 pipe 的
  截止时间；50-ms settle 可把短 output 与退出合并到一次调用。
- 最多 16 个未 settle job。终态未读 handle 超过五分钟或多于 32 个时惰性淘汰，
  最旧优先（不是瞬时硬上限）。一个 terminal observer 胜出，之后 `stale-session`；
  文件另有生命周期。仅出现 `sessionId` 不证明 job 仍活着。
- stop 向 group 发 `SIGTERM`，5 秒后升级 `SIGKILL`，确认窗口为 5 秒。
  unconfirmed stop observation 不沿用长 poll deadline：`terminated` 加
  `unknownOutcome` 保留 handle，供 `write_stdin` poll/stop 重试，不重跑命令。
  close 可拒绝为 `cleanup-incomplete` 并保留责任。Windows 的
  `taskkill /PID <pid> /T /F` 有有限 timeout；tree/自然后代行为未在真实 Windows
  验证。escaped group、PTY、重启 reattachment 不在范围内。
- 取消直接调用的 `exec_command` 或 `write_stdin` 会停止该 job。Code Mode cell
  失败、被 stop 或 close 时，其嵌套 `write_stdin` 调用结束但不停止 shell：仍在
  排队的调用立即返回，已在等待的调用在读取 output 前返回，output 与最终结果
  留给下一个读取者。已提交的 input 在 pipe 接受或拒绝之前仍计入预留。Pi 给
  同一条 assistant message 中的所有工具调用同一个取消 signal，顶层 observer
  会被一起取消，因此 shell 与 Code Mode 工具不设置 `executionMode`。
- command/cwd/limit/cap/stale 错误分类返回。本地 shell 在执行时惰性检查；status
  可报告 `shell-unavailable`，但不阻止 schema 暴露。其他功能继续工作。

使用旧 enabled 开关时保留原生 `bash`，该模式保持叠加语义。`execution` 规则生效
时，已提交的直调 Shell 或 Code route 在其生效期间隐藏已准入的内置 `bash`，route
结束时恢复；同名的第三方获胜注册、以及用户自己停用的 `bash` 都不被改动（见
§7）。有限命令可在一次调用内完成；提供 managed shell 不强迫轮询。
env 仍继承 Pi 进程环境；嵌入方可以通过调用缝（§5.10）追加可信的单次调用
overlay，只对该次 spawn 合并，不修改 manager 环境或 `process.env`。Toolkit 自身
仍不派生 Pi session/model metadata。执行清理与文件生命周期见 §7。

### 5.7 Code Mode

Code Mode 默认关闭且 provider-neutral。它只增加两个自有名字——`exec` 与
`wait`——并作为一个原子 group 激活。任一名字冲突时，两个 Toolkit 名字同时
停用，保留获胜的第三方注册及所有无关 active tools。它不按当前模型、provider
或 reasoning 设置限制，也绝不启动隐藏 model turn 或替代 agent loop。

每次 `exec` 启动一个带 inline bootstrap 与全新 `vm` context 的
`worker_threads` worker。只应以当前用户的权限运行可信 JavaScript：每次调用的
全新状态不是安全沙箱，worker 与 `vm` 均不是安全边界。受支持的 cell API 暴露
`tools.<declared>`、`print(...)`、`console.log/warn/error` 与 `text(value)`，
不提供环境 `process`、`require`、`fetch` 或动态 `import()`，也从不提供
`store`、`load`、`notify`、`yield_control`、`ALL_TOOLS`、image/audio helper、
`exit` 或定时器。变量、import 与函数不跨 cell
保留，但 host-side effect 不隔离。`worker.terminate()` 支持 CPU-bound 取消，
不保证强制终止所有 host effect。V8 generation limit 为 64/8 MiB，不保证
total heap/RSS 或外部分配上限。格式化/序列化可能在 transport 准入前分配完整
字符串。feature 关闭时不创建 worker。

契约：

- `exec.uses` 声明受支持的 `tools.<name>` adapter dispatch，不防御恶意
  JavaScript，也不限制宿主环境权限。manager 在启动任何 cell 前拒绝非适配
  名字，cell 内对未声明 adapter 的调用会失败。省略 `uses` 表示声明 cell 创建时
  已准入的 adapter，`[]` 表示一个都不声明；该快照同时是这个 cell 的上限，之后的
  扩张不会扩大运行中的 cell，而收缩仍在 dispatch 时生效。
- `exec` 以固定引用的上游 Codex freeform grammar 作为 `constrainedSampling`
  变体：支持 grammar 的 provider 直接发送原始 JavaScript，由 Pi 解码进 `code`，
  普通 JSON 形式作为 fallback。可选首行 `// @exec:` pragma 提供
  `yield_time_ms` 与 `max_output_tokens`；未知键、非法 JSON 或与显式参数冲突都
  在创建 worker 前拒绝，pragma 行被置空以保持源码行号。
  `max_output_tokens` / `max_tokens` 是有文档记载的每 token 4 字节代理，受既有
  字节上限约束，不是 provider 的真实 tokenization。
- 适配复用现有 executor：`exec_command` / `write_stdin` 使用唯一的 Shell
  Sessions manager，`apply_patch` 使用 Toolkit 定义及其 TypeBox 校验、
  containment、mutation queue 与真实的 partial-commit 报告。不添加私有 host
  import 或第二个 backend。
- **先校验再确认**：使用直接工具的实际 TypeBox schema，包括未知字段与范围。
  获得 queue slot 后、approval 等待后，复查 config、abort 与任一 shell sibling /
  Patch 的 visible foreign ownership。hidden、deferred 名字不等于 foreign
  winner：exposure 不是 authority。被 allowlist 过滤掉的名字同样不是 foreign
  winner，但它不是已准入的自有注册，因此其 route 从未被准入，其嵌套 adapter
  也不在 cell 的准入集合内。即使直接 schema/discovery 隐藏，`exec` 也内联提供
  三个 adapter 的完整精简调用契约。
- 保留 4 个 adapter slot；Patch 还有 sequential gate 和既有文件 queue。每 cell
  的 worker/host/adapter 准入限制为 **16 个 outstanding request**、**256 KiB
  累计序列化参数**；单个 argument/result/error payload 为 **256 KiB**。正常
  queued reply 有独立的 **256-KiB** 预算，到 `reply-received` 才释放。溢出返回
  有界 control error（另有最多 16 个有界 diagnostic 加 protocol 文本的 allowance）；
  已执行调用不可重放。count 限制微小请求开销，16 允许 4 个 active 加三批四调用；
  bytes 复用 cell-output envelope。这些是可注入的安全限制，不是实测最优 batch
  或全部分配上限。
- 成功完成等待 program 与被跟踪的传递工具调用，包括 Promise reaction，以及
  选定值**只序列化一次**时 getter/`toJSON` 引入的调用。参数序列化后也须再次
  检查准入：序列化就是用户代码。caught rejection 保留 JS 语义；floating/
  unhandled failure 不可静默成功。不保证任意未来 JS quiescence，也无隐式
  detached-call API。
- **修订后的 failed-cell 策略**：failure/termination/close 封禁新调用，独立取消
  未发送的 queue/approval waiter，不等待无视 abort 的前驱；协作 abort 已 dispatch
  未 settle 工作。effects 计数区分 completed/failed/cancelled/unsettled，不是
  逐文件 rollback receipt。无法交付 reply 或未 settle effect 明确为 unknown。
  worker 退出/terminal delivery 不释放 host effect 的 ownership；它仍占准入资源，
  close 可失败以供重试。
- 最多运行 4 个 cell，最多 16 个未读终态记录，五分钟惰性淘汰。每 cell 的观察串行，
  一个 terminal winner，其余 stale。worker stop 未确认则保留 `cellId`、唤醒长
  poll 并允许下一次有界 stop 尝试。program 结束后才到达的 stop、abort 或 close
  保留其已知结果；在未确认的 stop 之后才结束的 program 不再带该 stop 的临时
  不确定性。program 结束后仍未退出的 worker（例如 program 安排的 callback 仍
  占用它）会在短暂的宽限期后被终止。绝不重跑代码。
- 独立 `shells` 元数据来自实际 shell liveness，不依赖 JS 返回/打印值或单纯
  handle 存在；省略、截断和 failed return 都保留。已主动 yield 的 shell 仍由
  Shell 管理；用直接 `write_stdin`，或在新 `exec` 中声明 `write_stdin`，不能
  用 cell `wait`。Code Mode 清理不杀死这些独立 shell。cell 失败、stop 或 close
  只结束其对这类 shell 的嵌套 poll，不停止 shell；取消直接调用的
  `exec_command` 或 `write_stdin` 仍会停止 job。
- `yieldTimeMs`、`maxOutputBytes` 与 Shell 范围/默认值一致。emitted-output
  preview buffer 为 256 KiB，selected result 为 32 KiB，error 为 4 KiB。
  最终文本使用 literal string/compact JSON，限制为 **331,776 字节**（262,144 +
  32,768 + 4,096 + 32,768 control room）。status、uncertainty、shell/recovery
  在 clipped payload 前；预算内结构化值仍保留于 details。
  `clipping.{output,result,error}` 区分 preview 限制；见 §5.9。

权限边界：Pi 只为外层 `exec` / `wait` 调用发出 `tool_call` / `tool_result`，其
`input` 包含完整 `code` 与 `uses` 声明。通过公开 extension API 的嵌套 dispatch
无法发出这些事件，因此原生 per-nested-call hook 与第三方权限拦截器看不到嵌套
调用。嵌套的 start/等待 approval/end 记录通过外层调用普通的 update 回调转发：
包含 adapter 名字、`cell_id`、可选 `session_id` 与结果码，每次调用条数有上限，
且不是原生嵌套事件。Toolkit 保留外层 gate，校验 `uses` 的受支持 adapter
dispatch，并在调用会改文件的 `apply_patch` adapter 前增加 Toolkit
confirmation；这不等价于原生嵌套权限拦截，也不防御恶意代码。
`codeMode.approvalMode` 为 `"confirm"`（默认；要求对话框 UI，使用
`ctx.ui.confirm`）或 `"always"`（跳过这项额外确认）。此 gate 只分类 Apply
Patch；shell 也能改文件，但保持 direct-shell authority。确认发生在嵌套调用真正
dispatch 时：headless 的 `confirm` cell 只声明 Patch 时照常运行并完成，只有真正
的嵌套 `apply_patch` 会在任何改动之前以 `approval-unavailable` 失败；计算得到的
`tools[name]` 走同一路径，已保存的模式不会被自动改写。文档、`/pct status` 与
本节都公开该边界；合作式 opt-in hook 是未来可叠加的工作。

默认关闭使 `exec` / `wait` 不激活。未变更 `/pct reload` 和普通 model change
保留 cell。disable/conflict 请求清理；不完整时保留实际 ownership，不保证工具
wrapper 仍可用。session replacement 与恢复文件 expiry 见 §7；transcript 不会
重新创建执行。

### 5.8 Tool Discovery

Tool Discovery 是独立的默认关闭开关且 provider-neutral。它只增加一个自有普通名字
`find_tools`，并只隐藏 `toolDiscovery.deferred` 中显式列出的名字。它不依赖 Code
Mode、不改变任何 feature 的 executor，也不自己发起网络请求。

契约：

- `find_tools.query` 在受管理集合的名字与 description 中搜索，最多返回 8 条匹配，
  每条包含一行摘要与状态（`active`、`eligible` 或 `unavailable: <reason>`）。
- `find_tools.load` 接收精确的受管理名字，逐个重新校验，并以
  `[...active, ...eligible]` 增量添加，因此绝不删除无关 active tool，重复加载
  是 no-op。不具资格与未管理的名字在 `rejected` 中报告；只有格式错误、工具被
  禁用或缺少参数才会抛错。
- 一个名字只有在本 extension 拥有可见 `getAllTools()` winner、feature 已启用，
  且同步所用具的决策控制的 runtime decision 报告 active 时才具资格。第三方
  winner 或不存在的名字（例如被 Pi `--tools` allowlist 移除）不可用。
- Computer Use group 对 discovery 是原子组：配置列表必须包含全部六个名字或一个
  都不包含；组加载校验每个成员，任一成员不具资格则整组被拒绝。Shell Sessions
  与 Code Mode 是联合 pair：加载其中一个成员要求两个成员都具资格（兄弟成员冲突
  或不存在则拒绝请求），但只激活被请求的名字。
- deferred 名字在本 session 加载前保持隐藏。已加载名字在配置未变化的
  `/pct reload` 与普通 model change 后保留；新的、resume 的或 fork 的 session
  重新隐藏，且加载不会被持久化或重放。discovery 关闭期间 Toolkit 会遗忘本
  session 的加载，因此重新启用后重新隐藏。
- 禁用 discovery 或 `find_tools` 冲突（包括名字不存在）只移除 `find_tools` 并
  恢复普通自有投影。feature 被禁用或冲突只移除受影响的名字。`/pct status` 在
  某能力本来会是 `active`、但 Tool Discovery 仍扣住其全部 deferred 成员时报告
  `deferred`；`active` 表示模型现在就能调用。
- Discovery 只管理 Toolkit 自有工具。第三方工具需要具备可识别 source/activation
  契约的显式参与；Toolkit 绝不猜测第三方 executor、绝不重写其他 extension 的
  工具，也绝不把用户禁用的名字视为可加载。

只有在 managed set 确实移除了本来会激活的 schema、且任务能接受额外一轮
discovery 时才建议启用。[带日期的验证摘要](#9-协议探针状态)记录确定性覆盖、
历史测量与 live 运行限制；这些结果不承诺普适的 token、延迟或选择质量收益。

### 5.9 执行输出恢复

Shell/Code 为一个实际 Pi 执行 session 共享 `ExecutionOutputOwner`，而非通用
工具 archive。每条 shell 命令分别 capture 解码后的 stdout/stderr；每个 cell
capture 已发出文本与序列化的**选定** result/error。console object 保留已发出
文本（bounded-depth inspection），不是全部对象内部数据。不保证二进制保真或
每个中间 value/error，不额外归档源码、参数、env、prompt、reasoning；此机制
不上传、不调用 reducer 模型。但输出本身仍可能含这些敏感内容。

独立累计 prefix 不受 preview read 消耗；超过内存预算时 spill prefix 加后续文本，
而非仅 unread tail。yield 即使没有输出也发布稳定路径；terminal clipping 在
handle 释放前发布。已完整交付的小 terminal 结果无需文件。一个逻辑 capture
跨所有 poll，不为每次轮询复制日志。

- OS temp 下惰性 `mkdtemp` 私有目录，UUID 文件以 `wx`/0600 独占创建，不接受
  工具指定路径。identity-checked、nonrecursive 清理只删除自有文件，不删外来
  项或 image artifact。
- 每个 capture 最多 **16 个 pending chunk**、**max(2 × prefix budget, 64 KiB)**
  pending bytes。prefix 为每 shell stream/cell output 256 KiB、result 32 KiB、
  error 4 KiB。两倍预算容纳 prefix 与 producer chunk，count 限制微小 chunk
  开销。Shell 暂停 pipe 直到 append settle；Code 只有一个共享 producer credit，
  每 chunk 最多 8,192 UTF-16 units / 32 KiB，仅 worker 在 `Atomics.wait` 阻塞。
  host 在 **capture append 后**归还 credit；ACK/credit 不证明应用 effect。
- recovery 快照为 `{state, path?, bytes, capturedBytes, reason?}`。`bytes`
  是 producer 提交的 UTF-8 字节，`capturedBytes` 是确认写入字节（超时 write
  之后仍可能多写）。`capturing` 只是快照；`complete` 表示选定 capture 无已知
  丢失地结束，两者都不证明执行成功。`partial` 是不完整文件；`unavailable`
  包括 missing/replaced path。reason 有 `io-error`、`io-timeout`、`overload`、
  `source-error`、`missing`、`owner-closed`。
- capture fault 保留有界 preview 与实际执行 outcome，不 replay/rollback。
  worker 被中断时保守报告 partial/unavailable。过大的中间 RPC error 不会污染
  独立 selected final error 的 capture。I/O 默认等待 5 秒，超时原始 operation
  仍持有晚到清理责任，不等于所有 I/O 已停止。
- 用可用的原生 `read`（有界行范围）或获授权 shell（显式范围）读取绝对路径。
  路径不是 execution handle 或新 recall API。文件跨 terminal-once delivery、
  pruning、disable/conflict 保留，直到实际 `session_shutdown`（§7）。旧
  `capturing` 快照在 handle 过期后不能证明最终完整性/outcome。missing/partial
  必须如实报告，不为恢复重跑。
- **无 per-job/aggregate 磁盘 quota 或文件 TTL**，无跨重启 retention/scavenger。
  五分钟 pruning 只针对 handle。磁盘耗尽属于 capture failure，不是无限存储
  安全保证；长 session 可增长磁盘用量。突然死亡、不合作工作或挂起 storage 可留文件。

### 5.10 调用缝

直接工具与嵌套 Code Mode adapter 共用同一条通用调用缝：

```text
归一化后的调用 → 准入/ownership → invocationHooks.context(call)
  → invocationHooks.policy(call) → Code Mode Patch 审批（仅嵌套） → executor
```

`call` 为 `{ tool: "exec_command" | "write_stdin" | "apply_patch", path:
"direct" | "nested", cwd, cellId?, sessionId? }`——只有控制身份。嵌入方通过具名
的 `createPiCodexToolkit(options)` 工厂安装 hook；Pi 加载的默认 extension 导出
不安装任何 hook，Toolkit 也不自带调用方。

- `context().env` 是可信的单次调用 overlay，只对该次 spawn 合并到 manager 捕获
  的环境之上。它不修改该环境或 `process.env`，不会保留到下一次调用，也不会跨
  session；overlay 非法时在 spawn 前拒绝。
- `policy()` 在任何执行之前拒绝，并给出 hook 的理由。拒绝不是重试路径，也绝不
  改由另一个入口执行。
- 这条缝与编排器无关：不自行读取环境变量、不派生任务标记、不 import 私有代码，
  也不会为嵌套调用发出 Pi `tool_call` / `tool_result` 事件。提供的环境与继承
  环境一样传递给子进程。
- 另行规划的 Toolkit 权限引擎将接入此处，而不是只拦截直接工具。

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

在执行规则下，`/pct status` 区分自有执行名字不可用的两种情况：**可见第三方
胜出者**为 `conflicting-tool-name`；被宿主从投影中过滤掉的名字属于缺失，该行
改为报告已提交 route 的准入说明。因此各行与附加的 `Execution rules:` 块不会
互相矛盾。旧版 flag 管理的行仍把缺失与冲突一并报告为 `conflicting-tool-name`。

不要在每次请求或 `before_agent_start` 强制同步。否则会覆盖用户通过 Pi `/tools` 做的临时选择，还可能造成当前 prompt 与 tool schema 不一致。

`/pct config` 是持久配置；Pi `/tools` 是当前模型阶段的临时覆盖。模型切换或 `/pct reload` 后，持久配置再次生效。

同名 Pi 工具由扩展加载顺序决定实际实现。Toolkit 只用 Pi 的公开 tool metadata 做上述 ownership 检查，不禁用或重写其他扩展；以下重叠实现仍不能同时启用：

- 另一个 Remote Compaction extension。
- `pi-codex-computer-use` 与本项目 Computer Use。
- 另一个同名 `openai_generate_image` 或 `openai_web_search`。
- 另一个同名 `apply_patch`。
- 另一个同名 `exec_command` 或 `write_stdin`。Shell Sessions 是原子双名字
  group：任一冲突都会停用两个 Toolkit 名字，并保留第三方 winner。
- 另一个同名 `exec` 或 `wait`。Code Mode 是同样的原子双名字 group，冲突时
  请求清理 cell manager，不完整则保留实际 ownership。

execution manager 与输出文件生命周期分离：

| 事件 | 执行 / client 清理 | 已发布恢复文件 |
| --- | --- | --- |
| 普通 model change、未变更 Toolkit `/pct reload` | 保留 Shell/Code live work；仅在仍满足资格且 approval mode 相同时复用 Computer Use client；不重放 | 保留 |
| 功能禁用或 visible owned-name conflict | 封禁/请求对应 manager 清理；不完整则保留实际责任；仅 Code 清理不杀已 yield 的独立 shell | 保留共享 session owner |
| 经公开 `session_before_switch` / `session_before_fork` 尝试 new/resume switch 或 fork/clone | 独立尝试 Shell、Code 及所有自有 Computer Use client 清理；任一失败返回 `{cancel:true}` 否决替换，保留未完成清理的 ownership 以便重试 | 保留；成功清理后其他 extension 仍可能取消 |
| 实际 `session_shutdown` | 封禁执行；独立尝试 Shell、Code、Computer Use 清理；复用时只在确认 execution cleanup 后 rebind | expiry 边界：producer settle 后关闭 owner，只删自有文件 |

取消 switch/fork **不是 rollback**：一些 job 可能已经停止，成功完成的 Computer
Use client disposal 也可能已丢弃该 client 范围内的 app grants，包括其他 extension
随后取消的情况。若 preflight 成功但没有 shutdown，可启动新工作，旧文件仍保留。
Code 清理失败保留 manager，用于已有 cell 的控制和清理重试，不授权启动新 cell。
Computer Use 清理未完成时，在当前 factory 中保留可达的 client ownership；可通过 tool/status/
Toolkit reload 或再次切换 session 重试清理，不重放 action。两个公开 host 都验证了
真实 new-session guard；fork preflight 只有 factory 覆盖，未新测实际 fork/交互路径。

Toolkit `/pct reload` 只重读配置。Pi resource `/reload`、quit、紧急 teardown
在这里**没有可取消的 execution preflight**；shutdown hook 抛错无法阻止 host
替换。可能残留 work/file，factory 被替换后旧 handle 不可用，Computer Use cleanup
引用也不会跨 host 替换保留。即使 resource reload 保留 conversation identity，实际
shutdown 仍是文件 expiry 边界。不承诺 restart
attachment/replay，或无条件清理 escaped process/hung I/O。

Pi 0.84.4 的公开 active-tool projection 不包含 constrained-sampling metadata。
Toolkit 只有在 winning name 和 `sourceInfo.path` 都确认属于本扩展注册时，才补回
本地 grammar；第三方 winner 保留自己的 JSON-visible schema，绝不会套用 Toolkit grammar。

这个身份是 Pi 实际加载的那个 extension 文件，未必是 `src/index.ts`：嵌入方在自己的
extension 文件里默认导出 `createPiCodexToolkit(...)` 时，Pi 会把 Toolkit 的全部注册
都归属到那个文件。因此每个 factory 只解析一次自己的身份——依据宿主回报的
`sourceInfo.path`，且只统计 parameter schema 正是本 factory 传给 `registerTool`
的那些注册项，所以某个自有名字被第三方占用也左右不了结果——或者使用嵌入方显式提供的
`sourcePath`。这些 schema 对象按 factory 克隆（JSON 与校验行为完全一致），因此同一个
模块实例创建的两个 factory 不会互相冒认对方的注册项。当某个 factory 一个自有注册项都
证明不了时，身份保持未解析，它什么都不拥有：所有归属结果都是 `absent`，不启用任何
route，也不隐藏任何内置工具。这种状态不会被缓存；需要固定身份的嵌入方请显式给出
`sourcePath`。解析只决定身份，绝不会让第三方注册变得可调用。

这个身份同时也是"本扩展隐藏了哪些内置工具"这份记录的键。Pi 的 `session.reload()`
会用已被过滤的 active 列表重建 factory，因此 admitted-native baseline 与自有的
suppression 记录保存在进程内，先按解析出的身份、再按 session 血缘（session file，
否则 session id）归档。身份未解析的 factory 什么都不拥有，因此也不写入任何记录：
package 与 wrapper 同时加载、或同一模块创建的两个 SDK factory 并存时，胜出方的记录
都保持完整，所以把规则关掉再 reload 仍然会恢复 `bash`、`edit` 和 `write`。身份先于
这次 hydration 解析；在 `session_start` 仍未解析的 factory 会推迟到第一次解析成功的
同步再做。只有 reload 会继承该血缘的记录；resume 与 fork 都从宿主自己的默认值重新采集。

启用 Tool Discovery 且 `find_tools` loader 可用时，同一轮同步还会省略 `find_tools`
在本 session 中尚未加载的所有已配置 deferred 名字，并且只在 `find_tools` 自己的
可见 winner 属于 Toolkit 时才添加它。已加载的 deferred 名字随后遵循其 feature 的
普通规则。禁用 discovery 或失去 `find_tools` 名字会恢复普通自有投影；它绝不重写
或停用第三方注册，也绝不复活用户禁用的工具。`find_tools` 冲突不会遗忘本 session
的加载；只有禁用 discovery 才会。

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

- feature 与 provider/api/model ID；Remote Compaction 记录另有 `outcome`、
  `reason` 与 item 计数，它们同属本清单中的类别与计数。
- endpoint host，不含 path query 与认证。
- 请求耗时、HTTP/RPC 状态、request ID。
- content block 类型与数量。
- 不含 payload 的错误类别。

永远不记录 headers、token、prompt、tool arguments/result、截图、base64、opaque checkpoint 或可读 compaction fallback。无需实现通用 redactor；从源头不采集这些字段即可。

## 9. 协议探针状态

本自包含摘要区分源码测试、确定性 native host 检查、live 模型探针和发布 artifact。
公开文档不依赖原始开发日志；下方计数描述有界运行，不代表每项结果均可独立复现，
也不证明普适兼容性。

### 发布基线与源码级验证

**2026 年 9 月 13 日**的只读检查观察到 npm 0.1.0（2026 年 8 月 31 日发布）
和公开 annotated `v0.1.0` tag。所检查的 npm artifact 只有原始五项能力，不含
Shell Sessions、Code Mode 或 Tool Discovery。这是带日期的观测，不是新的
registry/默认分支查询、完整 Git/npm 字节一致性证明或包管理器安装测试。
当时的开发源码也使用 0.1.0 元数据，但不能用它标识那些已发布字节。0.2.0 是
独立的发布目标；下方历史检查不是对其最终 artifact 的验证。

**2026 年 9 月 15 日**的文档/分发检查仅涵盖源码 policy 与 focused 回归、
实际 dirty checkout npm 清单，以及一个显式选取的小型源码 archive。
两次离线 Pi 0.84.4 加载使用已有 peer 链接、合并 stdout/stderr、独立的八项
能力 configured/effective-off validator 和网络拦截，且不创建 Toolkit 配置或
artifact。这是 pack/unpack/loader 验证，不是新的 npm 安装、GitHub Actions
运行、live 模型探针或发布。公开文档仅包含 `docs/en/`、`docs/zh/` 和
`docs/third-party/`；私有研究排除在 Git 导出与 npm 之外，根目录和第三方的
license/notice 文件仍包含在内。

### 限定范围的测试工程检查

**2026 年 9 月 15 日**，本地 macOS arm64 / Node26.8.2 检查新增可选的
fixture ownership，执行真实 shutdown，覆盖部分 setup、body 失败和保留的
迟到清理责任。受控 Shell 探针区分并复现了启动 readiness 与延迟 observation
的测试竞态；修复使用明确的先后顺序，不改变 runtime budget，也不弱化
unknown-outcome 或精确输出断言。原外部失败的具体断言仍缺失，不能据此
推断 Linux 失败频率。

9 月 15 日最初仅覆盖 Web Search 的原生检查，在 `src/status.ts` 上实测
**38.90% lines / 11.11% functions / 100% branches**，另八个函数未执行。
这个历史 branch 数值并未验证整个模块。

同日的维护检查在 macOS arm64 / Node26.8.2 上将 `npm run test:coverage`
扩展为 **92 个共享显式契约和一个矩阵清单断言（93/93）**：保留原有 33 个
Web Search 案例，新增其余六个 selector 的 43 个案例、13 个完整投影和三个
涵盖全部八节的完整格式化输出。投影保留无外部工具冲突时独立的 Native Search
search-path warning 断言，也保留两种冲突并存的案例。
九个函数均执行，指定文件实测 **100% lines /
functions / branches**，无未覆盖范围。执行下限为 **98% lines / 100% functions /
100% branches**；两个百分点的有限 line 余量仅容纳小幅源码排版或计数变化，
不允许遗漏必需行为或降低任何 function/branch 门槛。仅运行真实 Web Search
子集时，34 个断言通过，但在这些合法下限下因实际覆盖率不足退出 1，完整诊断
已保留。不新增依赖或 remapper。这些是 Node 原生案例指标，不是 Istanbul
statement、整个 Vitest、项目/inline worker 覆盖率或穷尽语义保证。完整测试、
typecheck 和 format 仍独立运行。
现有 Linux Node22.19/24.20 CI lane 声明调用此公开源码命令；本地 Node26
结果和 type stripping 文档不能代替这些 lane 的实际验证。已有离线 host
探针与 Windows 限制保持不变。

### 历史修复与 synthetic host 检查

**源码修复证据（2026 年 9 月 13 日）：**独立 stage-3 审查记录了 **35 个文件、
516/516 项维护中测试通过**（已包含 focused 241/241），以及 macOS arm64 / Node
26.8.2 上的 typecheck/format 通过。仓库 **Pi 0.84.4** 与已安装 host **0.85.1**
的公开 root export、真实 resource loader/binding、普通 AgentSessionRuntime
turn 通过。当日审查的源码被暂存并解析到各自 host 的 peers；未更新或验证旧
Toolkit 安装 pin。

provider 为确定性本地 event stream，不是 live 模型或直接 ToolDefinition mock：
真实外层 `tool_call` 阻断时无 effect，`tool_result` 变换进入后续 provider context。
原生 `read` 恢复 Shell/Code 文件；隐藏 shell adapter 可用；headless Patch 确认
阻断；禁用后文件保留，实际 `newSession` 删除旧文件。注入 signal refusal 时否决
替换，之后控制和 replacement retry 成功。fetch 尝试为零；嵌套调用不发原生 hook。
无新 live/付费模型效率、Linux/Windows/最低 Node、交互 UI、实际 fork/resource
reload 或第三方组合结论。

**2026 年 9 月 14 日**的 Computer Use 跟进使用 synthetic native client 探针，
不是桌面或 live 模型：审批等待超过 135 秒但没有消耗所配置的执行预算；另一个
500-ms active 对照保留 unknown-outcome/inspection gate。维护中测试还覆盖
stale timer callback 和所有自有 client 的生命周期清理。这些 client 级检查不
验证 native factory/UI rendering、任意 RPC frontend 的视觉关闭、真实桌面
action 或强制 effect 终止。

### 历史能力 gate 与限制

以下为**历史能力 gate**，不是修复后重跑。Shell/Code/Discovery live 报告日期
为 2026 年 9 月 10 日；小 fixture 结果不验证现在改变后的提示、恢复或 failure
策略。其他能力保留 9 月 13 日审查前记录的范围；缺失的精确运行日期不以该审查
日期代替。API-key Search/Image live route 因探针环境没有符合条件的 provider/
model 而未测试。下方账户失败描述当时尝试，不是当前账户可用性：

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
6. **Shell Sessions**：确定性进程 fixture 覆盖 continuation、stdin、安静/突发
   output、UTF-8 chunk 边界、非零退出码、截断与 buffer drop、带子进程的终止、
   有界升级、stale handle、竞争 read、session 上限与 close。有界 live workflow
   已在 DeepSeek（`deepseek/deepseek-flash`，thinking `max`）与 Kimi
   （`kimi-coding/k3`，`max`）通过；Grok（`cliproxy-grok/grok-4.6`，`xhigh`）
   通过 continuation、终止与 stale handle，但在全部 4 次观测运行中模型都把
   interactive 换行错误转义（工具逐字转发已确认；仅 1/4 得到干净的
   `got:hello`）。随后强化的 `write_stdin` 描述在同一 route 的 6/6 次
   A1+A2 跟进运行中消除了该观测失败；这是有边界的缓解而非普适保证，其他
   route 或模型仍可能错误转义。OpenAI（`openai-codex`）为 **未执行**：
   账户拒绝 `gpt-5.4`，`gpt-5.6-luna`/`gpt-5.5` 返回 usage limit。不为 OpenAI
   声明 live support。这些是有界 workflow 和换行缓解观测，不是跨 provider
   support 保证。
7. **Code Mode**：确定性 worker、adapter、tool 与生命周期 fixture 覆盖 fresh
   state、wait cursor、CPU/output 上限、报错后的部分结果、被拒绝或未批准的
   dispatch、并发代码中的 sequential 顺序、默认不激活、原子冲突停用、禁用时
   释放 cell、未变更 `/pct reload` 与普通 model change 保留 cell，以及独立
   shell 不受影响。Pi 0.85.1 上针对 DeepSeek（`deepseek/deepseek-flash`，
   `max`）、Grok（`cliproxy-grok/grok-4.6`，`xhigh`）与 Kimi
   （`kimi-coding/k3`，`max`）的有界成对 live 验证在全部 33 次执行中结果正确：
   每个模型 3/3 次 `pair` 重复，加上 `single`、`filter` 与 `fault` 对照；
   每个 `fault` 场景只写入一次 marker，报告已完成的动作且不重试。该小型 fixture 的收益不一：组合调用有时减少顶层轮次
   （Grok 3 次调用 vs 6 次，DeepSeek 7 vs 6），但 token 与延迟并未稳定改善
   （DeepSeek 约 8 倍 output token 与约 3.5 倍 wall time；Grok 大致持平；Kimi
   除一次 14 轮、重试不可用 `setTimeout` helper 的离群运行外与普通模式相同）。
   live 验证还发现并修复了一个 adapter gating 缺陷：被用户 `--tools` allowlist
   从 `getAllTools()` 过滤掉的名字曾被误判为所有权冲突，导致所有嵌套 shell
   adapter 被停用（一次早期 probe 中模型因此编造了输出）；现在只有可见的第三方
   winner 才会停用 adapter。Code Mode 保持可选且默认关闭，不声明普适的 token
   或延迟收益。OpenAI（`openai-codex`）为 **未执行**：`gpt-5.6-luna`/
   `gpt-5.5`/`gpt-5.4` 返回 usage limit，因此不为 OpenAI 声明 live Code Mode
   support。这些对比只衡量指定的小型场景，不代表通用性能或恶意代码 containment。

8. **Tool Discovery**：确定性测试覆盖 managed-set 契约、精确/描述性/无匹配查询、
   有界结果、增量且幂等的加载、Computer Use 原子组校验、禁用与冲突名字拒绝、
   discovery 关闭/启用生命周期、reload 与 model change 保留、new/resume/fork
   重新隐藏、配置禁用拒绝，以及通过真实 extension factory 验证无关工具保留。
   历史 9 月 10 日 description 精简从 `write_stdin`、`exec`、`exec_command`
   和 `wait` 删除 1,029 个字符，schema/validator 不变。全开 DeepSeek fixture
   的 `tools` JSON 从 12,701 降至 11,672 字节；defer 全部 13 个名字后降至
   3,907 字节（11 → 5 个工具，−66.5%）。默认 deferred 集合（Image Generation
   与六个 Computer Use 工具）在 headless print mode 下为净负收益：这些工具
   本来未激活，而 `find_tools` 自身约占 1 KB。这些不是当前 schema 大小。DeepSeek
   （`deepseek/deepseek-flash`，`max`）、Grok（`cliproxy-grok/grok-4.6`，
   `xhigh`）与 Kimi（`kimi-coding/k3`，`max`）的有界 live 运行在 18/18 中正确
   完成任务（9 ON discovery、9 OFF 基线）；9 次 ON 执行 discover → load → call，
   多出 2–5 轮并消耗更多 token；Grok 效率最高，DeepSeek 最低。Discovery
   保持默认关闭，只给出条件性建议，不声明普适收益。OpenAI（`openai-codex`）为
   **未执行**：其 Codex 模型当时返回 usage limit。

探针失败时缩小或暂缓对应能力，不为了通过探针而创建通用兼容层。

**Pi 0.86.0 离线资格（2026-09-20）：** 开发依赖与 `^0.86.0` Pi peer；Sidecar/
Remote transcript 规范化；Remote capture 使用当前 tools 且忽略已保存 native
`systemMessage`；`session_tree` 后重新同步自有工具；SessionManager
persist/open/fork native compaction 状态；以及 host 树导航与 modeled
cache-warming transform 重放。同日的有界 live 验收用
`openai-codex/gpt-5.6-luna` 完成九次 Codex OAuth 请求：Sidecar 与 Native
Search、两次 Remote 压缩、禁用 Apply Patch 后的 open/fork 重放，以及一次
复用 SDK context/callback 的手动 warming 等价重放。当前模型没有 cache TTL，
host 报告 `cache lifetime unavailable`，自动 warming 请求为零；普通缓存仍然
命中。手动重放使用 4,874 个输入 token（其中 3,328 个缓存命中）和六个输出
token：Pi 的 `maxTokens: 1` 没有转换为 Codex wire 输出上限。按标准 API
价格折算为 $0.00038296，并非已核实的 OAuth 订阅扣费或长期节省证明。
Linux CI、API-key route 和其他模型/功能 live gate 不在本轮验收范围内。
本节更早的带日期记录未改写。

**Pi 0.87 系列离线资格（2026-09-22）：** peer 为 `^0.87.0`
（`>=0.87.0 <0.88.0`），开发依赖钉在 `0.87.0`。不再声明 0.86.x。在已安装的
Pi 0.87.0 上，两个 TypeScript 项目通过；发布检查改为期望该版本后，离线套件
通过。真实 `/pct status` print 运行退出码为 0，stdout 为空，全部能力关闭，
且没有写出 Toolkit 配置或 artifact。Codex Responses adapter 与 Codex
模型目录和 0.86.0 逐字节相同，这次 host 迁移不改产品逻辑。它不重复
2026-09-20 的 Codex OAuth live 验收，不新增 `context_edit` fixture，也不声明
Linux CI 或 0.88 兼容。上文 2026-09-20 的记录仍是历史记录。

## 10. 交付顺序

以下为历史实现顺序，不表示每项都随 0.1.0 发布。带日期的测量与源码验证见
[§9](#9-协议探针状态)。

1. Foundation：配置、`/pct`、状态、official-route/auth、debug metadata。
2. Core Search/Responses：统一 Web Search 配置、Native/Sidecar 两条路径与 Remote Compaction probe/实现。
3. Image Generation：单张生成、artifact、Pi 图片结果。
4. Apply Patch：一个默认关闭的 provider-neutral 工具、有界 parser、静态 containment 与 staged per-path commit。
5. Computer Use：通过窄 node_repl/Sky runtime 提供六个默认关闭工具，
   并保留独立只读 live gate。
6. Shell Sessions：一个默认关闭的 session-owned 进程管理器与两个普通工具，
   独立于 Code Mode，之后再做有界的四族 live 验证。
7. Code Mode：一个默认关闭的有界 cell manager 与两个普通工具，经显式
   adapter 复用 Shell Sessions 与 Apply Patch executor，而不是新增 backend。
8. 工具定义效率：先为显式管理的默认关闭 Toolkit 工具实现按需 discovery，再做
   定义精简，并按完整任务与 startup 成本衡量，而不是只数工具名。§9 的历史
   对比只支持有条件使用，不代表普适收益。
9. 只有真实需求出现后，才评估网页抓取、图片编辑或更多 Computer Use 动作。

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
- Shell Sessions 只启动一次、保留解码 UTF-8，将 job/stream/group settlement 与
  observation 分离。同 session 的独立恢复跨 preview/handle 丢失保留；input 与
  cleanup uncertainty 都不授权 replay。
- Code Mode 等待含 selected-value serialization 在内的 tracked transitive work，
  封禁 failed cell，保留未 settle effect 与独立 shell control，限制 transport/
  presentation，不声称 sandbox。
- 执行 disable/replacement cleanup 与 recovery expiry 遵循 §7，包括 failed
  preflight veto、无 rollback、不可取消 teardown 的限制。
- Tool Discovery 只加载显式管理、Toolkit 自有且当前具资格的名字；它不能复活被
  禁用或被用户过滤的能力、不能替换冲突注册、不能拆散 Computer Use 原子组，也不
  会移除无关 active tool；new/resume/fork 后不保留任何 discovery 状态。
- `/pct status` 能说明每项已实现能力的有效状态（`active`、`deferred`、`unavailable` 或 `off`）及原因。
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
