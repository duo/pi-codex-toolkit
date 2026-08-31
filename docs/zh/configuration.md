# Pi Codex Toolkit 配置

> 状态：与 `architecture.md` 配套的第一版配置契约

## 配置文件

第一版只有一个全局配置文件：

```text
<getAgentDir()>/extensions/pi-codex-toolkit.json
```

默认 Pi agent dir 下通常是：

```text
~/.pi/agent/extensions/pi-codex-toolkit.json
```

如果设置了 `PI_CODING_AGENT_DIR`，使用 Pi 解析后的 agent dir，不硬编码 home 路径。

不提供项目覆盖、环境变量覆盖、CLI flag、文件 watcher 或多层继承。密钥永远不写入该文件。

## 第一版 schema

```json
{
  "webSearch": {
    "enabled": false,
    "backend": "auto",
    "mode": "live",
    "contextSize": "medium",
    "sidecarModel": null
  },
  "remoteCompaction": {
    "enabled": false
  },
  "imageGeneration": {
    "enabled": false
  },
  "applyPatch": {
    "enabled": false
  },
  "computerUse": {
    "enabled": false,
    "approvalMode": "confirm"
  },
  "debug": false
}
```

所有已实现能力默认关闭。原因不是能力本身不安全，而是它们会产生额外
网络调用、费用、会话格式变化、本地文件修改或桌面操作，应由用户显式开启。

不在第一版 schema 中预留 endpoint、model allowlist、timeout、retry、header、provider router 或 fallback 顺序。`sidecarModel` 是实际执行独立搜索请求的单个模型选择，不是主模型 allowlist。

## `/pct` 命令

### `/pct` 或 `/pct config`

使用 Pi 标准 `ctx.ui.select()` 的简单循环，提供：

- Web Search on/off。
- Web Search backend：`auto`、`native` 或 `sidecar`。
- Web Search mode：`live` 或 `cached`。
- Search context size：`low`、`medium` 或 `high`。
- Web Search executor：从 Pi model registry 中选择一个通过 official-route 校验的 OpenAI/Codex Responses 模型。
- Web Search executor effort：`auto` 或选定 Codex 模型支持的 thinking level。
- Remote Compaction on/off。
- Image Generation on/off。
- Apply Patch on/off。
- Computer Use on/off。
- Computer Use approval：`Confirm` 或 `Always`。
- Debug metadata on/off。

不实现自定义 Settings 页面、tab、搜索或 scope 继承。

保存后立即更新内存配置，并只同步 Toolkit 自己拥有的 tools。若当前没有交互 UI，只显示配置文件路径，不等待输入。

### `/pct status`

显示当前 model/provider/API、配置路径和每项已实现能力的：

```text
configured: on | off
effective: active | unavailable | off
reason: 简短原因或空
```

Web Search 额外显示：

```text
requested backend: auto | native | sidecar
effective backend: native | sidecar | unavailable | off
web search executor: provider/model | —
web search executor effort: auto | off | minimal | low | medium | high | xhigh | max | —
```

Image Generation 额外显示：

```text
backend: codex-oauth | api-key | —
```

Computer Use 额外显示：

```text
transport: node-repl | —
```

`effective backend: native` 只表示当前 route 通过结构资格检查并会注入 hosted tool，不保证服务端支持当前 model/reasoning/input 组合。Sidecar 状态必须明确提示它是一次独立 OpenAI 请求，会增加费用和延迟。

典型原因包括：

- `unsupported-provider`
- `unofficial-endpoint`
- `missing-openai-auth`
- `missing-sidecar-model`
- `unsupported-sidecar-effort`
- `conflicting-tool-name`
- `unsupported-platform`
- `no-interactive-ui`
- `model-has-no-image-input`
- `missing-chatgpt-desktop-component`
- `missing-computer-use-helper`
- `node-repl-unavailable`
- `incompatible-sky-target`

### `/pct reload`

只重新读取 `pi-codex-toolkit.json`、更新内存并同步 Toolkit tools。不要调用 Pi 的全局 `ctx.reload()`。

手工修改配置文件后需要执行该命令。第一版不做 watcher。

## 配置读写语义

- 写入使用同目录临时文件加 rename，避免半写入 JSON。
- JSON 无效时不覆盖原文件。
- 运行中已有 last-known-good 时继续使用，并在 status 显示错误。
- 冷启动读取失败时使用全关闭默认值。
- 未知字段在运行时忽略，但通过 `/pct config` 保存时原样保留，包括已知对象内部的未知字段。
- 不做跨进程锁；多个 Pi 实例同时保存时最后写入者获胜。
- `/pct config` 是持久权威；Pi `/tools` 的变更只作为当前模型阶段的临时选择。

## 资格判断

### Web Search

`sidecarModel` 为 `null` 或：

```json
{
  "provider": "openai-codex",
  "model": "<Pi model id>",
  "thinkingLevel": "auto"
}
```

`provider` 可以是 `openai-codex` OAuth，也可以是保留的 `openai` API-key route。`/pct config` 从 Pi model registry 列出 provider/API/official endpoint 与 credential kind 通过结构校验的候选，由用户明确选择；Pi 的 scoped-model 列表非空时，该范围还会过滤候选。选定模型后，第二个菜单提供 `auto` 及 Pi 为该 Codex 模型报告的 thinking levels。`auto` 不覆盖 provider 默认值；executor 设置不会继承主模型 thinking level。旧配置缺少 `thinkingLevel` 时按 `auto` 读取。本版本的 API-key route 只支持 `auto`。

Toolkit 不猜“最新”或“最便宜”的执行模型，不保存它的认证，也不维护 model ID allowlist。

backend 解析规则固定为：

- `auto`：当前主模型是官方兼容 Responses route 时选择 native；否则在 `sidecarModel` 可认证时选择 sidecar；其余情况 unavailable。
- `native`：只做 payload 注入；当前 route 不兼容时 unavailable。
- `sidecar`：只激活 `openai_web_search`；executor 缺失、认证失败或 route 不兼容时 unavailable。

每轮最多一条 Toolkit 搜索路径。切换主模型时重新计算并同步 `openai_web_search` 的 active 状态，但不修改第三方工具。任何请求失败都不触发 native/sidecar 切换、provider fallback 或自动重试。

`mode` 同时作用于两条路径：`cached` 映射 `external_web_access: false`，`live` 使用外部访问。`contextSize` 映射 `search_context_size`。

Sidecar 不自动附带完整 Pi 主会话历史，只把主模型生成的 query 原样发送给选定 executor；query 本身可能引用或概括会话内容。它使用独立 OpenAI Responses 请求，返回 answer 与最多 20 条稳定去重后的可点击 sources；20 是 Toolkit 固定输出预算，不是 hosted Search 的结果数量控制。主模型必须能调用普通 Pi 工具。

Pi 当前没有可靠的通用普通工具调用能力标志。Toolkit 因此不为这项检查增加 provider/model 猜测或用户 override：Sidecar executor 可用时普通工具即为 active，不能使用 Pi 工具的模型自然无法调用它。

Codex OAuth 是已经 live 验证的 Sidecar 协议基线。它通过 Pi 公共 provider
发送一次 streamed Responses 请求，从 completed output items 聚合 answer 与
sources，并且不回退到私有 Search endpoint。真实 Pi 0.84.4 Grok 主模型 RPC
门禁已通过：显式选择 Codex executor 与 `low` effort，只 dispatch 一次 Search，
且 Grok 请求没有收到 native hosted Search tool。保留的 API-key route 已有确定性
覆盖；由于本地没有符合条件的 `openai` provider/model，其 live 调用仍待完成。

当前本地存在普通 `web_search` tool 时只显示冲突警告，不自动关闭第三方工具。

### Remote Compaction

`remoteCompaction.enabled` 默认为 `false`。新建 checkpoint 必须使用官方 `openai-codex` Responses route、刷新后的 OAuth 与可用账户 claim。replay 必须严格匹配 checkpoint 中记录的 provider、API、model ID、规范化 endpoint、account fingerprint 和 auth kind。

关闭功能或切换到不兼容模型时，使用 compaction entry 的可读 fallback，不发送 opaque checkpoint。

`/pct status` 只报告无网络的结构状态。`active` 表示 model/provider/API/endpoint/OAuth 形状符合资格；刷新后的 token 与账户兼容性只在实际 compaction 或 replay 时检查。

### Image Generation

不依赖当前主模型 provider。只要主模型能调用普通工具，且 Pi model registry 中能解析出一个受支持的官方 OpenAI/Codex image route 与认证，即可启用。

route/auth 选择顺序固定为：当前主模型的兼容官方 OpenAI/Codex route → `openai-codex` OAuth → `openai` API key。`/pct status` 显示最终选择的 backend/account 类型，不提供额外 provider 选择器。

此选择与 `webSearch.sidecarModel` 相互独立：Search selector 选择 Responses
文本模型；Image Generation 的实际请求始终使用固定 `gpt-image-2`，所选 route
仅作为认证载体。

选中的 backend 显示为 `codex-oauth`、`api-key` 或 `—`。每次调用只通过 Pi 刷新这个已选模型，并在发送 prompt 前重新校验 official route。认证只映射到固定常量，不接受配置 URL：

```text
api-key     -> https://api.openai.com/v1/images/generations
codex-oauth -> https://chatgpt.com/backend-api/codex/images/generations
```

工具发送一次 `gpt-image-2` JSON 请求；`background`、`quality`、`size` 使用传入值或 `auto`。请求不跟随重定向，dispatch 后任何失败都不重试，也不切换账户。

解码后的原始 PNG 以独占创建方式写入 `<getAgentDir()>/artifacts/pi-codex-toolkit/<uuid>.png`。结果包含带绝对路径的文本、一个 raw-base64 Pi `ImageContent`，以及仅含 path/MIME 的 details。Pi 对 vision 模型保留图片，对文本模型使用其标准省略占位符，同时保留路径文本。

API-key endpoint 属于公开 OpenAI API 行为。Codex OAuth endpoint 固定依据官方 Codex `rust-v0.150.1` 客户端，仍与源码耦合；其真实 Pi 0.84.4 OAuth 发布门禁已由 Codex 与 Grok 主模型调用共同通过。由于本地没有 API-key provider，API-key live probe 仍待完成，但 wire contract 已有确定性测试。

### Apply Patch

`applyPatch.enabled` 默认为 `false`。启用后，只要工具名没有被另一个扩展
占有，Toolkit 自己的 `apply_patch` 就对所有主模型激活。模型切换和
`/pct reload` 只重新同步开关与名字 ownership；Toolkit 不维护 provider 或
model allowlist。

工具只有一个 JSON 参数 `{ "patch": string }`。Pi 对声明支持 grammar tool 的
模型发送 Codex 兼容 Lark grammar，对其他能调用工具的模型使用同一定义的普通
JSON function；两条传输路径共用一个本地 executor。Pi 内置的 `edit` 和
`write` 保持可用且不变。

executor 支持 Add、Update、Delete、Move、多文件、多 hunk、locator 和
End of File。它先 preflight 整个 patch，拒绝绝对路径、向上遍历以及所有可见
symlink 组件，再 staging replacement，并按路径执行 rename/unlink commit。
可预测的 preflight 失败不会改变 target file。单次 replacement rename 是原子的，
但 Move 或多文件 patch 不是 transaction；后续文件系统失败可能留下已经提交的
早期操作，此时返回 partial/unknown，且不会重试。

这是静态 containment，不是 race-proof sandbox。恶意进程并发替换已经校验的
路径组件不在当前 threat model 中。本工具也不同于 Responses 一等
`type: "apply_patch"` / `apply_patch_call` 协议；后者没有实现。

## Computer Use

Computer Use 有一个启用开关和一个 approval mode：

```json
{
  "computerUse": {
    "enabled": false,
    "approvalMode": "confirm"
  }
}
```

`/pct config` 中两个选项的标签固定为 `Confirm` 和 `Always`：

- `Confirm` 是默认值。某个 app 的第一个合法请求会打开 Pi 的
  `Computer Use access` 确认；Yes 会在当前 client 内存中记住该 canonical app；
  No 只拒绝本次调用，不缓存拒绝，因此下次同一 app 会再次询问。
- `Always` 对每个合法 Computer Use elicitation 自动接受，不显示 Toolkit
  confirmation；保存后的配置在后续 Pi session 仍然生效。

两种模式都保留 active thread、`node_repl`、form mode、`computer-use`
connector 与 canonical app 的严格检查；外来、畸形或缺少/空白 app 的
elicitation 仍会拒绝。`Always` 只跳过 Toolkit confirmation，不会授予或绕过
macOS 屏幕录制、辅助功能或其他系统权限。

Toolkit 只维护当前 client 内存中的 canonical app Set；没有 file/database/global
allowlist，也不缓存拒绝。在 `Confirm` 下，只要复用当前 client，普通 turn、
compaction、未改变配置的 `/pct reload` 和仍具资格的 model switch 都保留授权。
`/new`、`/resume`、`/fork`、Pi 全局 `/reload`、restart/quit、禁用 Computer Use、
切换 approval mode、失去资格或 tool name 冲突都会重置。因此从 `Always` 切回
`Confirm` 后会重新询问。

此前隔离的只读 Computer Use gate 与本次 client-Set 版本的完整真实 Pi
`Confirm` / `Always` 授权矩阵均已通过。该矩阵验证了同 app 的 Yes-once、
不同 app 独立确认、No 后再次询问、未变更配置的 `/pct reload`、`/new` 重置，
跨 `/new` 的 `Always`，以及普通无工具 turn；全程只使用 state read，且没有
修改 macOS 权限。

不提供 backend、可执行文件、timeout、安装器或 fallback 设置。

普通 session start 只做便宜的本地判断，不启动 app-server。用户显式执行
`/pct status` 时，Computer Use 可启动一个专用 probe client，只验证
`sky.target === "mac"` 后关闭；status 不列出 app、不读 app state，也不执行 action。

Computer Use MVP 要求：

```text
configured
&& macOS
&& interactive UI
&& current model supports image input
&& 成套 ChatGPT.app bundled components 存在
&& 已安装 Computer Use helper 存在
&& injected node_repl 能以 js 启动
&& @oai/sky 报告 target mac
```

成套组件固定来自 `/Applications/ChatGPT.app/Contents/Resources`：
`codex`、`cua_node/bin/node_repl`、`cua_node/bin/node` 与
`cua_node/lib/node_modules`。helper 固定为
`<real CODEX_HOME>/computer-use/Codex Computer Use.app`。Toolkit 不搜索 PATH、
不扫描 plugin cache、不安装或修复组件，也不修改全局 Codex 配置。

每次调用都经过 ChatGPT bundled app-server、一个隔离的 ephemeral thread、
`node_repl/js`、预定义 JavaScript 与 trusted `@oai/sky/service`。不会 fallback
到旧的 direct `mcp_servers.computer-use` 路径。`cua_repl` 只是未来可能替换
这一窄 runtime 的方向，当前既未实现也不可配置。

六个工具名为 `computer_use_list_apps`、`computer_use_get_app_state`、
`computer_use_click`、`computer_use_type_text`、`computer_use_press_key` 与
`computer_use_scroll`，并作为一个 group 激活。任何一个名字冲突都会禁用
Toolkit 自己的整组工具，但不修改冲突的第三方工具或其他 active tools。

需要指定 app 的工具接受 app 显示名称、完整 `.app` bundle 路径或无歧义的
bundle identifier。目标未知或无法解析时，应优先使用
`computer_use_list_apps` 返回的 identifier。PID、window ID 和裸 Mach-O
可执行文件路径都不是受支持的 target。显式坐标只能在 app 已解析后选择位置，
不能绕过 app resolution。

如果 `computer_use_list_apps` 中没有目标，目标所属项目必须提供真正的 `.app`，
用来容纳实际拥有窗口的 executable，并提供稳定的 bundle identifier。Toolkit
不会创建 app wrapper，也不会 fallback 到 PID、window、foreground 或 HID 控制。

## Debug

`debug: true` 只向 stderr 输出元数据：

- feature、provider/API/model。
- endpoint host。
- duration、status、request ID。
- content block 类型与数量。
- 无 payload 的错误类别。

不输出 headers、token、prompt、tool arguments/results、截图、base64、opaque checkpoint 或 compaction fallback。第一版没有日志文件、日志级别、轮转或通用 redactor。

## 冲突说明

- 不要与另一个 Remote Compaction extension 同时启用；多个 `session_before_compact` handler 可能产生重复远端请求。
- 不要同时启用本项目 Computer Use 与 `pi-codex-computer-use`；工具名可能由加载顺序决定。
- 第三方 `apply_patch` 注册赢得同名 ownership 时，状态显示
  `conflicting-tool-name`；Toolkit 不替换或停用它。
- `pi-web-access` 可以共存，但不再是本项目的依赖。它的普通 `web_search` 与本项目任一 Web Search backend 同时启用时，`/pct status` 发出重复搜索路径警告；Toolkit 不主动关闭它。
- 第一版不主动探测、禁用或重写其他扩展。
