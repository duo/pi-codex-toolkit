# Pi Codex Toolkit 配置

> 范围：Pi 0.87 系列上的 0.2.0 版本。相比 0.1.0，schema 增加了新能力和可选的执行规则。见[带日期的验证与限制](architecture.md#9-协议探针状态)。

## 配置文件

当前源码使用一个全局配置文件：

```text
<getAgentDir()>/extensions/pi-codex-toolkit.json
```

默认 Pi agent dir 下通常是：

```text
~/.pi/agent/extensions/pi-codex-toolkit.json
```

如果设置了 `PI_CODING_AGENT_DIR`，使用 Pi 解析后的 agent dir，不硬编码 home 路径。

不提供项目覆盖、环境变量覆盖、CLI flag、文件 watcher 或多层继承。密钥永远不写入该文件。

## 0.2.0 配置 schema

此示例包含一条主动选择的执行规则；新建的默认配置不包含 `execution`。

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
  "shellSessions": {
    "enabled": false
  },
  "codeMode": {
    "enabled": false,
    "approvalMode": "confirm"
  },
  "execution": {
    "version": 1,
    "rules": [
      {
        "id": "astra",
        "match": "gpt-6-astra",
        "patch": true,
        "shell": false,
        "code": true
      }
    ]
  },
  "toolDiscovery": {
    "enabled": false,
    "deferred": [
      "openai_generate_image",
      "computer_use_list_apps",
      "computer_use_get_app_state",
      "computer_use_click",
      "computer_use_type_text",
      "computer_use_press_key",
      "computer_use_scroll"
    ]
  },
  "debug": false
}
```

所有已实现能力默认关闭。原因不是能力本身不安全，而是它们会产生额外
网络调用、费用、会话格式变化、本地文件修改或桌面操作，应由用户显式开启。

新文件不含 `execution`。在保存该节之前，`applyPatch.enabled`、
`shellSessions.enabled` 与 `codeMode.enabled` 保持原有的累加含义，
不隐藏 Pi 的 `bash` / `edit` / `write`。`execution` 出现之后，保存时会移除
这三个 `enabled` 字段；Patch、直调 Shell 与 Code 的唯一权威是有序的模型规则。
`codeMode.approvalMode` 保留。`match` 是大小写敏感的 glob（`*` / `?`），
匹配 `modelId`；当 pattern 含 `/` 时匹配 `provider/modelId`。首个命中的规则生效。

schema 没有 endpoint、model allowlist、timeout、retry、header、provider router 或 fallback 顺序字段。`sidecarModel` 是实际执行独立搜索请求的单个模型选择，不是主模型 allowlist。

## 从 0.1.0 升级

安装 Toolkit 0.2.0 前先升级到 Pi 0.87 系列。现有有效配置保留原设置，缺失的
新配置节使用关闭默认值；启动不会写入迁移结果或自动启用新能力。

执行规则是可选迁移。不含 `execution` 时，旧 enabled 开关仍为累加语义，Pi
原生工具继续可见。`/pct config` → Execution rules 会按旧开关预览一条
catch-all 规则，三个开关全关时则预览空规则列表。仅打开编辑器不会写文件，检查
草稿后再选择 Save。保存后规则
取代三个执行能力的 enabled 字段，生效的替代 route 按上文规则隐藏相应原生
工具。若可能降级，迁移前先备份配置：0.1.0 不读取该 schema，退回时应恢复其
配置，不能假设新规则会被旧版本保留使用。

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
- Computer Use on/off。
- Computer Use approval：`Confirm` 或 `Always`。
- Execution rules：增删改与重排模型 glob，以及互相独立的 Patch / 直调 Shell / Code 开关。从旧版配置打开该页会先预览一条 catch-all 规则，开关全关时则为空列表。编辑器使用 Pi 的 `select`/`input` 对话框。Save 会记录磁盘 revision，遇到已变更的文件时拒绝保存，而不是 last-writer-wins。
- Code Mode nested Apply Patch confirmation：`Confirm` 或 `Always`。
- Tool Discovery on/off。
- Debug metadata on/off。

不实现自定义 Settings 页面、tab、搜索或 scope 继承。

保存后立即更新内存配置，并只同步 Toolkit 自己拥有的 tools。若当前没有交互 UI，只显示配置文件路径，不等待输入。

### `/pct status`

显示当前 model/provider/API、配置路径和每项已实现能力的：

```text
configured: on | off
effective: active | deferred | unavailable | off
reason: 简短原因或空
```

`active` 表示模型现在就能调用该能力。`deferred` 表示该能力已配置且本来会是
`active`，但 Tool Discovery 在 `find_tools` 加载之前扣住了其 deferred 名字。
同一能力中未列入 deferred 集合的兄弟名字仍可能留在 active set。当 `effective`
为 `deferred` 时，`backend` / `transport` 保持与 active 时相同，`reason` 为空。

status 的 `deferred` 对应同一名字在 `find_tools` query 中的 `eligible`
（已配置、尚未加载、loader 可用），Computer Use 除外：`/pct status` 还会探测
`node_repl`，因此可能报告 `unavailable`，而只做静态检查的 query 仍报告
`eligible`。

上一次读取配置文件失败时，status 在各能力之前显示该错误，有细节时放在括号中
（见配置读写语义）：

```text
Config error: invalid-config (applyPatch.enabled must be true or false)
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

Shell Sessions 额外说明：只使用本地 pipe、没有 TTY、命令只启动一次且从不应重放。

Code Mode 额外说明：嵌套调用由 cell dispatch，per-call tool hook 与第三方权限
拦截器看不到它们。

Tool Discovery 额外显示已管理的 deferred 名字数量以及本 session 已加载的数量。
除非 `find_tools` loader 可用（discovery 已启用且本扩展拥有 `find_tools`），
这两个计数都是 0。同时说明只有显式管理的 Toolkit 自有工具才能被加载。

`effective backend: native` 只表示当前 route 通过结构资格检查并会注入 hosted tool，不保证服务端支持当前 model/reasoning/input 组合。Sidecar 状态必须明确提示它是一次独立 OpenAI 请求，会增加费用和延迟。

典型原因包括：

- `current-model-missing`
- `unsupported-provider`
- `unsupported-api`
- `unofficial-endpoint`
- `credential-mismatch`
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
- `shell-unavailable`
- `patch-unavailable`
- `shell-pair-unavailable`
- `code-pair-unavailable`
- `code-shell-pair-unavailable`
- `code-unavailable-did-not-promote-patch`
- `patch-unavailable-kept-native-editing`

最后六个只在 `execution` 规则生效时出现，指出被请求的 route 缺少哪个已准入的
工具：`patch-unavailable` 指自有的 `apply_patch`；`shell-pair-unavailable` 指
自有的 `exec_command` / `write_stdin` 这一对；`code-pair-unavailable` 指自有的
`exec` / `wait` 这一对；`code-shell-pair-unavailable` 表示该对已准入，但它依赖
的嵌套 Shell 对没有。`code-unavailable-did-not-promote-patch` 与
`patch-unavailable-kept-native-editing` 表示与 Code 一起请求的 Patch route 没有
生效：保留 Pi 原生编辑工具，且不可用的 Code 不会自动变成直调 Patch。这些行还会
区分自有名字缺失的两种原因：被其他扩展**可见地占用**时报
`conflicting-tool-name`；被宿主从投影里过滤掉（`--tools` 白名单、子代理角色）时
该名字从未被准入，因此该行给出对应 route 的准入说明，而不是冲突。旧的 enabled
开关行仍然把这两种情况都报成 `conflicting-tool-name`。规则没有请求的能力就是
`off`，不带原因。

`execution` 规则生效时，status 还会追加一段 `Execution rules:`，显示命中的规则、
requested 与 effective route、是否隐藏 `bash` 与 `edit` / `write`，以及同样的
note 名字。配置已保存但应用失败时，会在 config error 行之后出现一行
`Apply error:`；在后续应用成功之前，仍然沿用上一次已提交的工具投影。未确认的
Code Mode 清理也报在同一行，即使之后已有更新的 model 切换提交成功：该 manager
在清理成功前不再准入新 cell，其保留的 cell 仍可 `wait` 与 terminate，下一次
`/pct reload` 或 model 切换会重试清理，成功后重新绑定新的 manager。

其中三个描述的是 route 本身，而非缺少配置：`current-model-missing` 表示当前
session 没有 model 可供检查；`unsupported-api` 表示 provider 是 `openai` 或
`openai-codex`，但该 model 不使用对应 provider 的 Responses API
（`openai-responses` 与 `openai-codex-responses`）；`credential-mismatch` 表示
凭据种类与 route 不匹配，例如在 `api.openai.com` route 上使用 ChatGPT OAuth、在
`chatgpt.com` route 上使用 API key，或刷新后的凭据把请求移到了另一条 route。

### `/pct reload`

只重新读取 `pi-codex-toolkit.json`、更新内存并同步 Toolkit tools。不要调用 Pi 的全局 `ctx.reload()`。

手工修改配置文件后需要执行该命令。不做 watcher。

读取失败时不改动文件，并报告错误，例如
`Pi Codex Toolkit config error: invalid-config (applyPatch.enabled must be true or false); using all-off defaults.`
若 Pi 加载扩展以来已读取或保存过有效配置，消息改以 `using last known good settings.` 结尾。

## 配置读写语义

- 写入使用同目录临时文件加 rename，避免半写入 JSON。
- JSON 无效时不覆盖原文件。
- 配置文件不存在不算错误，表示使用全关闭默认值。
- 读取失败分三种。`invalid-json`：文件不是有效 JSON；没有细节，因为解析器的消息会引用文件内容。`invalid-config`：JSON 不是对象，或某个已知字段的类型或取值不对；细节给出第一个这样的字段及其要求，例如 `applyPatch.enabled must be true or false`。`config-read-failed`：无法读取文件；有系统错误码（如 `EACCES`）时，细节就是该错误码。细节从不重复无效的取值。
- 读取失败后，继续使用 Pi 加载扩展以来最后一次读取或保存的有效配置（last-known-good），没有则使用全关闭默认值，并在 status 显示错误。
- session 启动时若读取失败且存在交互 UI（TUI 或 RPC），以 warning 显示一次 `/pct reload` 的同一条消息。print 与 JSON 模式不额外输出，请改用 `/pct status`。
- 未知字段在运行时忽略，但通过 `/pct config` 保存时原样保留，包括已知对象内部的未知字段。
- Toolkit 保存会在 JSON 旁使用协作目录锁（`<config>.lock/`），加锁后重读文件，并以 `stale-revision` 或 `lock-held` 拒绝，而不是在协作写入者之间 last-writer-wins。这不会序列化锁协议之外的任意编辑器。`lock-held` 消息会写出锁目录；若读到了 owner 记录，还会写出该 owner 的 pid 以及它是否仍在运行。若所有保存都报 `lock-held` 且没有其他 Toolkit 进程在跑，可能是上次保存留下了 `<config>.lock/reclaim`；只有确认没有活着的写入者后，才可删除该目录（或整个 `.lock` 目录）。空的遗留 `reclaim/` 会自动回收；仍带 `owner` 文件的不会。
- `/pct config` 是持久权威；Pi `/tools` 的变更只作为当前模型阶段的临时选择。

## 资格判断

配置文件含 `execution` 节时，下面 Apply Patch、Shell Sessions 与 Code Mode 小节
描述的执行器与冲突规则不变，但开关变成命中的模型规则，而不是
`applyPatch.enabled`、`shellSessions.enabled` 或 `codeMode.enabled`；生效的
route 还会隐藏它替换的原生工具：Shell 或 Code 隐藏 `bash`，Patch 隐藏 `edit`
与 `write`。`read` 始终保留。

## 子 session

每个 Pi 进程各自读取同一份规则文件。子 agent 先用自己的模型匹配规则，再与宿主
实际准入的工具求交集：当启动器用只含原生名的 `--tools` 白名单启动子进程（例如
只允许使用 Pi 内置工具的角色），该子进程保持原生工具——没有任何自有执行
工具被准入，没有原生工具被隐藏，缺失的 route 只被报告，不会被自动补上。父进程自
己的规则不受影响；请求 Code 或 Shell 的规则也不会让子进程被排除的名字变得可用。

每次提交成功的同步后，扩展会在共享扩展事件总线上发布一条记录，频道为
`pi-codex-toolkit.execution-diagnostics`，schema 为 `version: 1`。内容包括解析
出的 `model`、`source`、`ruleId`、`requested` 与 `effective` 能力，
`admittedNames`、`visibleNames`、`nestedNames`、`hiddenNatives` 名称列表，准入
`notes`、`approvalTransport`、`cleanupPending`、`configRevision`，以及打包后的
`toolkit` 名称与版本——只有名称、标志与一个 revision，绝不包含环境变量、命令、
补丁或程序文本。apply 被拒绝时同样发布一条记录，`cleanupPending: true` 且描述仍
然生效的已提交 route；被取代的同步不发布任何记录。`/pct status` 以文本形式报告
规则、requested/effective route 与 notes。

嵌套 Apply Patch 审批需要具备对话框能力的上下文。交互式或 RPC session 会弹出确
认；无 UI 的子进程（`--mode json -p`）报告 `approvalTransport: "unavailable"`，
并在任何改动之前让那一次嵌套调用以 `approval-unavailable` 失败，同一 cell 中的
纯计算与 Shell 调用仍然运行。保存的审批模式不会被自动修改，也不会有另一条 route
重试被拒绝的改动。

### Web Search

`sidecarModel` 为 `null` 或：

```json
{
  "provider": "openai-codex",
  "model": "<Pi model id>",
  "thinkingLevel": "auto"
}
```

`provider` 可以是 `openai-codex` OAuth，也可以是保留的 `openai` API-key route。`/pct config` 从 Pi model registry 列出 provider/API/official endpoint 与 credential kind 通过结构校验的候选，由用户明确选择；Pi 的 scoped-model 列表非空时，该范围还会过滤候选。选定模型后，第二个菜单提供 `auto` 及 Pi 为该 Codex 模型报告的 thinking levels。`auto` 不覆盖 provider 默认值；executor 设置不会继承主模型 thinking level。旧配置缺少 `thinkingLevel` 时按 `auto` 读取。当前源码的 API-key route 只支持 `auto`。

Toolkit 不猜“最新”或“最便宜”的执行模型，不保存它的认证，也不维护 model ID allowlist。

`sidecarModel: null` 表示未配置 Sidecar executor，不会跟随主模型。backend `auto`
仍可在主模型受支持时选择 Native；否则 Sidecar 需要明确的 executor。默认 Codex
目录已移除 `gpt-5.4` 和 `gpt-5.4-mini`。当前 registry 找不到的显式 executor
保持 unavailable（`missing-sidecar-model`），通过 `/pct config` 重新选择。自定义
registry 仍可暴露这些 ID。

backend 解析规则固定为：

- `auto`：当前主模型是官方兼容 Responses route 时选择 native；否则在 `sidecarModel` 可认证时选择 sidecar；其余情况 unavailable。
- `native`：只做 payload 注入；当前 route 不兼容时 unavailable。
- `sidecar`：只激活 `openai_web_search`；executor 缺失、认证失败或 route 不兼容时 unavailable。

每轮最多一条 Toolkit 搜索路径。切换主模型时重新计算并同步 `openai_web_search` 的 active 状态，但不修改第三方工具。任何请求失败都不触发 native/sidecar 切换、provider fallback 或自动重试。

`mode` 同时作用于两条路径：`cached` 映射 `external_web_access: false`，`live` 使用外部访问。`contextSize` 映射 `search_context_size`。

Sidecar 不自动附带完整 Pi 主会话历史，只把主模型生成的 query 原样发送给选定 executor；query 本身可能引用或概括会话内容。它使用独立 OpenAI Responses 请求，返回 answer 与最多 20 条稳定去重后的可点击 sources；20 是 Toolkit 固定输出预算，不是 hosted Search 的结果数量控制。主模型必须能调用普通 Pi 工具。

Pi 当前没有可靠的通用普通工具调用能力标志。Toolkit 因此不为这项检查增加 provider/model 猜测或用户 override：Sidecar executor 可用时普通工具即为 active，不能使用 Pi 工具的模型自然无法调用它。

Codex OAuth Sidecar 通过 Pi 公共 provider 发送一次 streamed Responses 请求，
从 completed output items 聚合 answer 与 sources，不回退到私有 Search endpoint。
历史 OAuth 探针与未获 live 验证的 API-key route 见
[验证范围](architecture.md#9-协议探针状态)。

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

工具发送一次 `gpt-image-2` JSON 请求：`quality`、`size` 使用传入值或 `auto`，`background` 恒为 `auto`——工具没有 `background` 参数。请求不跟随重定向，dispatch 后任何失败都不重试，也不切换账户。

解码后的原始 PNG 以独占创建方式写入 `<getAgentDir()>/artifacts/pi-codex-toolkit/<uuid>.png`。结果包含带绝对路径的文本、一个 raw-base64 Pi `ImageContent`，以及仅含 path/MIME 的 details。Pi 对 vision 模型保留图片，对文本模型使用其标准省略占位符，同时保留路径文本。

API-key endpoint 属于公开 OpenAI API 行为。Codex OAuth endpoint 固定依据官方
Codex `rust-v0.150.1` 客户端，仍与源码耦合。历史 OAuth 探针与仅有确定性覆盖的
API-key route 见[验证范围](architecture.md#9-协议探针状态)；这些不验证新发布。

### Apply Patch

`applyPatch.enabled` 默认为 `false`。启用后，只要工具名没有被另一个扩展
占有，Toolkit 自己的 `apply_patch` 就对所有主模型激活。模型切换和
`/pct reload` 只重新同步开关与名字 ownership；Toolkit 不维护 provider 或
model allowlist。

工具只有一个 JSON 参数 `{ "patch": string }`。Pi 对声明支持 grammar tool 的
模型发送 Codex 兼容 Lark grammar，对其他能调用工具的模型使用同一定义的普通
JSON function；两条传输路径共用一个本地 executor。工具描述里带一个字面的最小
envelope，供没有 grammar 约束的 JSON 传输使用：

```text
*** Begin Patch
*** Add File: notes/todo.md
+first line
*** End Patch
```

给出示例并不放宽解析：首行与末行必须恰好是 `*** Begin Patch` 与
`*** End Patch`，不能带尾部标记，envelope 中任何位置出现回车符仍会被拒绝。
使用旧 enabled 开关时，Pi 内置的 `edit` 和 `write` 保持可用且不变；`execution`
规则选中 Patch 时，会在该 route 生效期间隐藏它们。

executor 支持 Add、Update、Delete、Move、多文件、多 hunk、locator 和
End of File。它先 preflight 整个 patch，拒绝绝对路径、向上遍历以及所有可见
symlink 组件，再 staging replacement，并按路径执行 rename/unlink commit。
可预测的 preflight 失败不会改变 target file。单次 replacement rename 是原子的，
但 Move 或多文件 patch 不是 transaction；后续文件系统失败可能留下已经提交的
早期操作，此时返回 partial/unknown，且不会重试。

现有源文件（包括 `Delete File` 目标）必须是有效 UTF-8 文本，换行须统一为 LF 或
CRLF；非 UTF-8、裸 CR 和混合换行会在 mutation 前被拒绝。不支持二进制文件删除。

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

历史只读 Computer Use 与 `Confirm` / `Always` 探针见
[验证范围](architecture.md#9-协议探针状态)。它们没有执行桌面 action 或修改
macOS 权限。

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

## Shell Sessions

Shell Sessions 只有一个启用开关，默认关闭：

```json
{
  "shellSessions": {
    "enabled": false
  }
}
```

它不依赖 Code Mode、provider route 或当前模型；任何支持普通 tool calling 的模型
都可以使用。启用且无同名冲突时，恰好激活两个 Toolkit 自有工具，作为一个原子
group：

- `exec_command` 启动一次命令，返回当前已产生的 output；仍在运行时返回 session handle。
  `running` 且已有 stdout/stderr 仍不是完成：用 `write_stdin` 轮询或停止，不要用 Code Mode `wait`。
- `write_stdin` 轮询同一进程、写入 stdin、关闭 stdin 或请求终止。

两个工具同时接受 Codex 拼写与既有字段名，同一对拼写永远是同一个字段：
`cmd`/`command`、`workdir`/`cwd`、`session_id`/`sessionId`、`chars`/`input`、
`yield_time_ms`/`yieldTimeMs`。只发一种拼写，或两处发送相同值；值不同会在任何
执行之前被拒绝。结果在既有 `sessionId`/`exitCode` 之外补充 `session_id` 与
`exit_code`。嵌套形式 `tools.exec_command(...)` 与 `tools.write_stdin(...)`
接受完全相同的字段。不受支持的 Codex 请求字段（`tty`、`shell`、`login`、
`sandbox_permissions`、`justification`、`with_escalated_permissions`、
`prefix_rule`、`timeout_ms`）按名字拒绝，不会被静默忽略；数字 handle 直接拒绝，
不做任何强制转换。

任一自有名字冲突会同时停用两个 Toolkit 名字，并保留获胜的第三方注册，规则与
Computer Use group 一致。无关工具名不受影响。使用旧 enabled 开关时原生 `bash`
同样不受影响；`execution` 规则生效时，已提交的直调 Shell 或 Code route 会在其
生效期间隐藏已准入的内置 `bash`，route 结束时再恢复。禁用请求清理；
不完整时保留实际 ownership，不承诺所有工作已消失。model switch 和未变更
`/pct reload` 保留 session。switch/fork veto、文件保留与不可取消 teardown 的
限制见[执行生命周期](#执行输出恢复与-session-生命周期)。

执行细节：

- 命令只通过 Pi 公开的 `getShellConfig()` 解析出的 shell 启动一次。`write_stdin`
  不会重新启动它，restart/resume 后也不会重放已保存的命令。当解析出的 shell 使用
  stdin command transport 时，命令会消费并关闭 stdin，因此该 session 不可交互。
- stdin、stdout、stderr 都是 pipe，不是 TTY。行式交互程序可用；全屏或仅 TTY
  程序不受支持，也不声称提供 TTY 语义。
- `yieldTimeMs`（`0..60000`，默认 `10000`）限制等待新 output/settlement，
  不是执行时长或端到端 deadline。即使零 yield，spawn establishment 与 capture
  I/O 也可能增加耗时。`maxOutputBytes`
  （`1024..262144`，默认 `51200`）将本次返回的 output 作为 stdout+stderr 的合并
  预算（先排空 stdout），并在 UTF-8 code point 边界截断，因此可能出现不完整行。
- `max_output_tokens`（`256..65536`）是同一预算的 token 拼写。它是有文档记载的
  保守代理：**每 token 4 字节**，并受既有字节上限约束，不是 provider 的真实
  tokenization。它与 `maxOutputBytes` 单位不同，同时给出时两个限制都生效，取
  更小的 payload 上限；两者都省略时仍是 `51200` 字节默认值。
- `write_stdin.input` 原样转发：不追加换行，也不隐式关闭 stdin。`closeStdin` 在写入后
  结束 pipe，便于等待 EOF 的程序退出。省略或空 input 只做轮询。stdin-transport
  session 上的非空 input 会以 `stdin-transport` 错误被拒绝。
- 每 session stdin 准入为 **262,144 UTF-8 字节 / 16 个 outstanding input 调用**，
  到 transport 与 request 都 settle 才释放。overload、EOF/broken pipe 后 input、
  非空 input 加 stop 均在发送前拒绝。重复 EOF 无害。EPIPE/write/end 错误明确
  报告 unknown delivery。`inputDelivery: written | unknown` 是 transport 结果，
  不是应用确认。预先 abort 不发送；提交后不可自动重发。
- 最多 16 个未 settle job。未读 terminal handle 在五分钟或多于 32 个时惰性淘汰；
  一个 terminal observer 释放 handle，其他排队 observer 收到 `stale-session`。
  文件另行保留。leader 退出后仍管理普通同组后代与继承 stream，包括重定向输出
  的 child；escaped group 不在范围内。
- stop 绕过安静 observation queue，向 POSIX group 发 `SIGTERM`，5 秒后升级
  `SIGKILL`，确认窗口为 5 秒，不沿用长 poll。`terminated` 加 `unknownOutcome`
  保留 handle 供 poll/stop 重试；close 可拒绝为 `cleanup-incomplete`。Windows
  `taskkill /PID <pid> /T /F` 有有限 timeout，但未在 Windows 真实验证。无 PTY
  或 restart reattachment。
- 取消直接调用的 `exec_command` 或 `write_stdin` 会停止 job。Code Mode cell
  失败、stop 或 close 会结束其嵌套 `write_stdin` 调用，但不停止它们轮询的
  shell：shell 继续运行，未读 output 与最终结果留给下一个读取者。
- shell 命令使用用户现有的本地进程权限，不是新的 sandbox。

状态 reason 为 `conflicting-tool-name` 与 `shell-unavailable`。后者表示无法解析可用
本地 shell，且只影响 Shell Sessions。

有限命令可在一次调用内完成；启用不要求轮询，也不把 Shell 限制于 Code/Fusion
角色。env 仍从 Pi 进程继承。嵌入方可以通过[调用 hook](#调用-hook)额外提供可信的
单次调用 overlay：它只对该次 spawn 合并到继承环境之上，不是模型参数，也不会修改
`process.env` 或影响其他 session。没有新增 quota、timeout、env 或 profile 配置。

2026 年 9 月 13 日离线 host 检查和另行记录的 9 月 10 日 live 报告见
[验证范围](architecture.md#9-协议探针状态)，包括 Grok 换行失败和未测试的
OpenAI route。

## Code Mode

Code Mode 是一个独立的默认关闭开关，不依赖当前模型或 provider：

```json
{
  "codeMode": {
    "enabled": false,
    "approvalMode": "confirm"
  }
}
```

启用且无同名冲突时，恰好激活两个 Toolkit 自有工具，作为一个原子 group：

- `exec` 以当前用户的权限运行一段支持 top-level await 的短可信 JavaScript，
  每次调用使用独立 worker 和全新状态，不是安全沙箱。只应运行可信代码。
  返回选定的 output 和有界 result；program 只运行一次，永不重放。
- `wait` 通过 `cell_id`（也可拼作 `cellId`）继续一个已 yield 的 cell，只返回新
  output，并可终止 cell。

调用方言：

- `exec` 以固定引用的上游 Codex freeform grammar 作为 `constrainedSampling`
  变体：支持 grammar tool 的 provider 直接发送**原始 JavaScript 源码**，由 Pi
  解码进该工具的 `code` 属性；不支持的 provider 仍用普通 JSON 发送同一段
  program。两条路径进入同一个 executor 和同一套校验。
- program 可以以一行 pragma 开头，例如
  `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`。只接受这两个
  选项；未知键、非法 JSON，或与同义调用参数不一致，都会在创建 worker 之前被
  拒绝。该 pragma 行会被替换为空行，因此源码行号不会偏移。
- `wait` 接受 `cell_id`/`cellId`、`yield_time_ms`/`yieldTimeMs`、`terminate`，
  以及 `max_tokens`（Codex 名称）、`max_output_tokens` 或字节单位的
  `maxOutputBytes`。handle 一律是 opaque 字符串：数字、OS PID 或
  `pct-shell-` session id 都会被拒绝，不做强制转换。
- 渲染结果以 `cell_id` 开头，运行中的 cell 保留上游的
  `Script running with cell ID <id>.` 文案；shell 结果在既有字段之外补充
  `session_id` 与 `exit_code`。
- 嵌套调用接受每个字段的两种拼写，
  `tools.apply_patch("*** Begin Patch … *** End Patch")` 既接受 envelope 字符串，
  也接受 `{patch: "…"}`。

组合约定：

- `exec.uses` 列出 program 可通过 `tools.<name>(args)` 调用的确切适配工具。
  **省略 `uses` 表示声明 cell 启动时已准入的全部 adapter**，只有显式 `[]` 才表示
  一个都不声明。无论哪种方式，该快照同时是这个 cell 的上限：之后的配置或模型
  变更不会扩大运行中的 cell，而收缩仍会在嵌套调用 dispatch 时生效。调用未声明的
  adapter 会在 cell 内失败。这是受支持的 adapter dispatch 与校验，不防御恶意
  JavaScript，也不限制宿主环境权限。
- 适配工具为 `exec_command`、`write_stdin` 和 Toolkit `apply_patch`。通过此 API
  只能调用显式适配的工具，其他 Pi 或 MCP 工具仍然是普通调用。
- `exec_command` / `write_stdin` 复用唯一的 Shell Sessions executor，因此嵌套
  shell 调用遵循相同的 session、顺序、output 与终止约定；要求 Shell Sessions
  已启用且无冲突，不存在第二个进程后端。
- `apply_patch` 复用 Toolkit Apply Patch 定义，包括 TypeBox 参数校验、路径
  containment、Pi 文件 mutation queue 和真实的 partial-commit 报告；要求
  Apply Patch 已启用，且 dispatch 时 Toolkit 仍拥有获胜的 `apply_patch` 名字。
- 先按实际 schema 校验再确认，queue/approval 等待后复查实时 config、abort 与
  visible foreign ownership（包括任一 shell sibling）。hidden/deferred 的直接
  名字不移除嵌套权限；被宿主从投影中过滤掉的名字根本没有准入，其 route 与嵌套
  adapter 都不可用。没有 discovery 时 `exec` 也提供完整内联调用说明。Pi 的工具
  描述在注册时固定，且没有受支持的方式更新已注册的描述，因此该说明列出的是这个
  构建**可能**暴露的 adapter：嵌套 `apply_patch` 标注为只在规则把 Patch 走 Code
  时才准入，并指向 `/pct status` 查看当前模型的实际准入集合；未准入的 adapter
  只会让那一次调用在 dispatch 时失败。
- 4 个 concurrent adapter slot 与 sequential Patch 顺序，独立于每 cell 的
  **16 个 outstanding request / 256 KiB 累计参数**。单个序列化 argument/reply/
  error 与累计正常 queued reply 各限 256 KiB，有界 control error 有另行 allowance。
  count 限制微小请求，bytes 限制 payload；ACK 释放 transport reservation，不释放
  effect 责任。这些是安全默认值，不是用户可调配置。
- 完成等待 tracked transitive call/reaction，包括选定值只序列化一次时引入的
  调用；caught error 保留 JS 语义。failure/terminate/close 封禁未发送工作，取消
  queue/approval waiter、协作 abort 未 settle dispatch。如实报告 effects/unknown，
  不 rollback/replay；worker exit 不等于 host effect settle。
- 独立 `shells` continuation 元数据跨 omitted/clipped/error JS 返回保留。
  已 yield 的 shell 仍归 Shell：通过已暴露的直接 `write_stdin`，或新 `exec`
  声明它来继续；`wait` 控制 cell，不控制 shell。cell 失败、stop 或 close 只结束
  其嵌套 poll，不停止这些 shell。

运行与生命周期：

- 每个 cell 是一个 `worker_threads` worker，配有全新的 `vm` context。受支持的
  cell API 暴露 `tools.<declared>`、`print(...)`、`console.log/warn/error` 和
  `text(value)`：字符串原样追加（不补换行），非字符串在可行时用
  `JSON.stringify` 序列化。没有 `store`、`load`、`notify`、`yield_control`、
  `ALL_TOOLS`、`image`、`audio`、`exit`、定时器、import 或跨 cell 状态，
  也不提供环境 `process`、`require`、`fetch` 或动态 `import()`。变量、import 与函数
  不跨 cell 保留，但 host-side effect 不隔离。worker 与 `vm` 均不是安全边界。
  worker 终止支持 CPU-bound 取消，不保证强制终止所有 host effect。
  64/8-MiB V8 generation limit 不限制 total heap/RSS 或外部分配。
  whole-value formatting/serialization 与任意 worker allocation 不在
  transport/heap 保证范围内。
- `yieldTimeMs`（`0..60000`，默认 `10000`）限制 `exec` / `wait` 的等待时长；
  未 settle 的 program 返回 opaque `cell_id` 供 `wait` 使用。`maxOutputBytes`
  （`1024..262144`，默认 `51200`）限制单次读取交付的 output；
  `max_output_tokens` / `max_tokens`（`256..65536`）是同一上限的 token 表达，
  按每 token 4 字节的保守代理换算并受该字节上限约束，不是 provider 的真实
  tokenization；同时给出时两个限制都生效，取更小者。每个 cell 的
  output buffer 为 256 KiB，result 32 KiB、error 4 KiB。若 cell 在报告自身
  error 时被中断，其 error 先给出该 error 的开头，再给出 cell 停止的原因
  （worker error 或 stop 原因，最多 1 KiB）；error recovery 文件只保留一次
  已报告的文本，后接该原因。最多运行 4 个 cell；
  16 个未读 terminal result 五分钟惰性淘汰。observation 串行，一个 terminal
  winner 释放 handle，排队 loser stale。stop 未确认时唤醒长 poll、保留 handle
  供再次 stop；未 settle effect 仍被管理。program 结束后才到达的 stop、abort 或
  close 改为返回 program 的结果；在未确认的 stop 之后才结束的 program 同样报告
  其结果，不带该 stop 的不确定性。program 结束后仍未退出的 worker（例如
  program 安排的 callback 仍占用它）会在短暂的宽限期后被终止。
- emitted text 按 literal 输出，选定结构化值在 details 保留结构。compact 最终
  rendering 独立限制为 **331,776 字节**，status、uncertainty、shell control/
  recovery 优先于 payload。`truncated`/`dropped` 和
  `clipping.{output,result,error}` 是 preview 事实，不证明 recovery 不完整。
  producer credit 只在 capture append 后归还；见[上限与恢复](architecture.md#59-执行输出恢复)。

权限边界：

- Pi 原生 `tool_call` / `tool_result` hook 只能看到外层 `exec` / `wait` 调用。
  外层调用的 `input` 包含完整 program `code` 与 `uses` 声明，因此 hook 或权限
  扩展可以在 cell 粒度检查或阻断。
- 嵌套调用不发出 `tool_call` / `tool_result`，按单次 tool call 拦截的第三方权限
  系统看不到它们。请把 `code` 与 `uses` 视为可审查表面。
- 外层调用会通过 Pi 普通的 partial-result 回调转发**有界进度记录**：嵌套调用的
  start、等待 approval，以及带 `ok` 或错误码的 end。每条记录只包含 adapter 名字、
  `cell_id`，以及已知时的 `session_id`——不含命令、patch、program 或参数文本，
  每次调用的条数也有上限。它们是外层调用上的 update，不是伪造的嵌套事件。
- `approvalMode` 为 `confirm`（默认）或 `always`。`confirm` 的 Pi UI 询问
  **只针对嵌套 `apply_patch`**，并且在该调用真正 dispatch 时才询问。headless 的
  `confirm` cell 只要没有实际调用 Patch 就照常运行并完成；只有真正的嵌套
  `apply_patch` 会在任何改动之前以 `approval-unavailable` 失败。计算得到的
  `tools[name]` 走同一条路径。非法嵌套参数不触发确认；拒绝/取消不发送。shell
  也能改文件，但保持 direct-shell authority 与外层 gate。`always` 只跳过额外
  Patch 确认，不跳过校验/实时权限，也不会自动改写已保存的模式。
  这不是通用 nested mutation permission 系统。

禁用 Code Mode 请求 cell 清理，不杀死已 yield 的独立 Shell session。文件跨
handle/disable 保留；清理不完整时保留 ownership。见下方共享生命周期。

带日期的 worker/adapter 测试、离线 host 验证与历史 live 对比见
[验证范围](architecture.md#9-协议探针状态)。live 运行未在修复后代码重跑，且
收益不一；Code Mode 保持可选、默认关闭，不承诺普适或按 provider 的收益。

## 调用 hook

没有任何配置项启用它。这是给自行加载 Toolkit 的嵌入方使用的代码级集成缝，并且
Toolkit **不自带调用方**：Pi 加载的默认 extension 导出不会安装任何 hook。

这个包**没有根导出**：Pi 通过 `pi.extensions` 清单里的入口（`./src/index.ts`）
加载它，因此嵌入方要显式导入该子路径。`import … from "pi-codex-toolkit"`
无法解析。

```ts
import { fileURLToPath } from "node:url";

import { createPiCodexToolkit } from "pi-codex-toolkit/src/index.ts";

export default createPiCodexToolkit({
  invocationHooks: {
    // 本次调用的可信环境。
    context: (call) => ({ env: { MY_CONTEXT_ID: idFor(call) } }),
    // 本次调用适用的策略。
    policy: (call) =>
      call.tool === "apply_patch" && call.path === "nested"
        ? { allow: false, reason: "patches are reviewed elsewhere" }
        : { allow: true },
  },
  // 可选。Pi 会把该 factory 注册的每个工具都归属到它加载的那个 extension
  // 文件——也就是本文件——Toolkit 会自行从宿主投影里解析这个身份。
  // 如果希望显式声明而不是自动探测，或者本 factory 的注册项根本没有进入
  // 宿主投影，就固定它。
  sourcePath: fileURLToPath(import.meta.url),
});
```

- `sourcePath` 是所有归属比较使用的 extension 身份：哪个 `apply_patch` /
  `exec_command` / `exec` winner 属于本扩展，从而决定哪些 route 可以生效、
  可以隐藏哪个内置工具。不提供时，factory 从 Pi 回报的注册项里读取——只有能
  被证明属于本 factory 的注册项才作数，因此第三方 winner 和同进程中的另一个
  Toolkit factory 都左右不了这个判断。当一个都证明不了时——`--tools` 白名单
  过滤掉了全部自有名字，或者它们都被别的扩展占走——身份保持**未解析，本
  factory 什么都不拥有**：它的执行 route 报告为不可用，不隐藏任何内置工具，
  也不认领任何注册项。这种状态不会被缓存，因此只要本 factory 自己的注册项重新
  可见，身份就会解析；希望那时仍固定身份，就显式给出 `sourcePath`。它只是身份，
  不是权限：不会让外部工具变成可调用。它同时也用来隔离"隐藏了哪些内置工具"这份
  记录：该记录按身份与 session 血缘分别保存，未解析的 factory 一条都不写入，而
  两个 factory 固定同一个 `sourcePath` 就是有意共用一份记录——后启动的那个会在
  自己 session 开始时重新采集这份共用记录，因此不要把同一个身份固定到两个同时
  运行的 factory 上。
- `call` 为 `{ tool: "exec_command" | "write_stdin" | "apply_patch", path:
  "direct" | "nested", cwd, cellId?, sessionId? }`：只有控制身份，不含命令、
  patch 或 program 文本。
- 两个 hook 对直接工具和嵌套 Code Mode adapter **完全一致**地生效：在归一化与
  准入之后，在 Code Mode 审批与 executor 之前。拒绝时以 hook 给出的理由失败且
  什么都不启动——被拒绝的嵌套 `apply_patch` 不会弹出确认对话框；hook 可以是
  同步或异步的。
- 异步 hook 可能比放行它的那次准入活得更久，因此两条路径在 hook 返回后、产生
  任何影响之前都会重新检查：期间被关闭的能力直接拒绝；直调 Shell 调用若其
  session 已被替换，也会拒绝，而不会派发到替换 session 的 manager 上。
- `context().env` 只针对该次 spawn 合并到 manager 捕获的环境之上。它不修改
  manager 的环境或 `process.env`，不会渗入下一次调用，也不会跨 session。
  overlay 格式非法时在 spawn 之前拒绝。
- 这条缝刻意保持通用：不依赖任何特定编排器，不自行读取环境变量，也不会为嵌套
  调用伪造 Pi `tool_call` / `tool_result` 事件。提供的环境与继承环境一样会传给
  子进程；Toolkit 不会生成某个编排器的任务标记。
- 未来的 Toolkit 权限引擎将接入同一条缝，而不是只拦截直接工具。

## 执行输出恢复与 session 生命周期

没有启用第二 executor/archive 的设置。Shell/Code 共享 session output owner：
只有 yield、spill 或 terminal preview loss 需要时，才在 OS temp 惰性独占创建
私有 UUID 文件。解码 stdout/stderr 或 emitted-text/序列化-selected-result/error
的独立累计 capture 在破坏性 preview 限制前发生，早期 prefix 不被此前 poll 消耗。
已完整返回的小 terminal 结果无需文件。这是解码/选定文本恢复，不保证二进制保真、
所有中间 JS 值，也不额外 capture source/argument/env/prompt。不上传；输出本身
可能含密钥。

recovery 包含 `state: capturing | complete | partial | unavailable`、可选
`path`、`bytes`、`capturedBytes` 与可选 `reason: io-error | io-timeout |
overload | source-error | missing | owner-closed`。提交字节与确认写入不同。
快照报告 capture，不是执行成功或最终 outcome receipt；旧 `capturing` 不证明
后来完整性。capture 错误保留有界 preview 与真实 execution outcome。

用可用的原生 `read` 按行范围、或获授权 shell 按显式范围读返回绝对路径。没有
handle lookup/recall 工具。文件跨 terminal-once delivery、handle pruning、
feature disable/conflict 保留。partial/unavailable/missing 表示证据不完整；
不为重建证据重跑副作用或重发 unknown stdin。**无聚合（或 per-job）磁盘 quota、
文件 TTL、restart 保证**，长 session 可增长磁盘用量。五分钟 pruning 只用于
handle。精确 capture/credit 上限、晚到 I/O 与 identity-safe cleanup 见
[架构 §5.9](architecture.md#59-执行输出恢复)。

- model change、未变更 Toolkit `/pct reload` 保留执行/文件。
- 经公开可取消 preflight 尝试 new/resume switch 或 fork/clone，先请求 Shell 与
  Code 清理。不完整则否决替换，保留实际 ownership/文件以便 control/cleanup retry。
  其他 extension 可随后取消；即使取消，部分工作也可能已停止，不回滚。
  仅 preflight 成功绝不删除文件。
- 实际 `session_shutdown` 是文件 expiry；producer cleanup 后关闭 owner，只删
  自有文件。Pi resource `/reload` 即使保留 conversation identity 也适用；
  `/pct reload` 不是 resource `/reload`。
- quit/resource reload/emergency teardown 在这里不可取消。失败可残留 work/file，
  shutdown 抛错不保证 factory replacement 后旧 handle 可用。escaped descendant、
  hung I/O、突然死亡使无条件清理保证不成立。无 replay/restart attachment。

## Tool Discovery

Tool Discovery 是独立的默认关闭开关，不依赖当前 model、provider 或 Code Mode：

```json
{
  "toolDiscovery": {
    "enabled": false,
    "deferred": [
      "openai_generate_image",
      "computer_use_list_apps",
      "computer_use_get_app_state",
      "computer_use_click",
      "computer_use_type_text",
      "computer_use_press_key",
      "computer_use_scroll"
    ]
  }
}
```

`deferred` 是显式管理集合，只能包含 Toolkit 自有工具名（`openai_web_search`、
`openai_generate_image`、`apply_patch`、两个 Shell Sessions 名字、两个 Code Mode
名字和六个 Computer Use 名字）；未知、外部和 `find_tools` 名字会使校验失败，并
保留 last-known-good 配置。编辑列表属于文件级操作；`/pct config` 只切换
Tool Discovery 本身。Computer Use group 是原子组：列表必须包含全部六个名字或
一个都不包含。

当 discovery 已启用且无冲突时，Toolkit 注册并激活一个普通工具 `find_tools`：

- `query` 在受管理集合的名字与 description 中搜索，最多返回 8 条匹配，每条
  包含一行摘要与状态（`active`、`eligible` 或 `unavailable: <reason>`）。
- `load` 接收精确的受管理名字，为下一个 model turn 添加具资格的名字。加载是
  增量且幂等的：绝不删除无关的 active tool，也绝不重放调用。请求原子组中某个
  成员会校验并加载整组；任一成员不具资格则整组被拒绝。Shell Sessions 与 Code
  Mode 两个 pair 采用联合校验而不是扩展加载：加载其中一个成员时兄弟成员也必须
  具资格，兄弟冲突或不存在则拒绝请求，但只激活被请求的名字。
- 至少需要提供 `query` 或 `load` 之一。不具资格或未管理的名字以 `rejected` 加
  原因返回，而不是让整个调用失败；参数格式错误或 `find_tools` 被禁用会在
  dispatch 前抛错。
- 加载不执行工具，也不授予权限。Pi 正常的下一轮 dispatch 仍会校验参数，并应用
  各工具自身的启用、ownership、审批与错误契约。

每次调用与同步时都会重新校验资格。一个名字只有在以下条件全部成立时才具资格：

- 该名字在可见 `getAllTools()` 中的胜出注册属于本 extension（第三方胜出者，
  或被 Pi `--tools` allowlist 移除而不存在的名字，都不可用）；
- 其 feature 配置已启用；
- 对于由决策控制的工具，同步使用的同一运行时决策报告该能力在当前
  model/session 下处于 active。

稳定的 discovery 原因包括：`disabled`（feature 关闭）、`not-registered`
（不在可见投影中）、`not-managed`（请求的名字不在受管 deferred 集合内）、
`conflicting-tool-name`（第三方胜出者）、`native-backend`
（Web Search 使用 native 路径，Sidecar 工具不在投影中），以及既有的 feature
原因，如 `unsupported-platform`、`no-interactive-ui`、`current-model-missing`、
`missing-openai-auth`、`missing-sidecar-model`。被拒绝的原子 group 中每个成员都
带上该 group 自身的原因：某个成员不在受管集合内时为
`group incomplete: <name> is not managed`，某个成员不具资格时为
`group blocked by <member>: <reason>`。

生命周期：

- 在本 session 通过 `find_tools` 加载之前，deferred 名字从普通投影中隐藏。已加载
  名字在配置未变化的 `/pct reload` 与普通 model change 后保持可见。
- 新的、resume 的或 fork 的 session 重新隐藏 deferred 名字。加载状态不会被持久化
  或重放。
- 禁用 discovery 或 `find_tools` 发生冲突会移除 `find_tools` 并恢复普通自有投影。
  禁用 discovery 同时会遗忘本 session 的加载，因此重新启用后重新隐藏。
- feature 冲突或 feature 被禁用只移除受影响的名字，保留无关工具。
- Discovery 只管理 Toolkit 自有工具。第三方工具只能通过具备可识别
  source/activation 契约的显式参与变得可发现。Toolkit 绝不猜测、重写或停用其他
  extension 的工具，也绝不把用户禁用或被 allowlist 过滤的名字视为可加载。

仅在 managed set 确实移除了本来会激活的 schema、且任务能接受额外一轮
discovery 时启用。带日期的 fixture 与 2026 年 9 月 10 日 live 对比见
[验证范围](architecture.md#9-协议探针状态)；这些测量不是当前 schema 大小，
也不代表普适的 token、延迟或选择收益。

## Debug

`debug: true` 只向 stderr 输出元数据：

- feature、provider/API/model。
- endpoint host。
- duration、status、request ID。
- content block 类型与数量。
- 无 payload 的错误类别。

不输出 headers、token、prompt、tool arguments/results、截图、base64、opaque checkpoint 或 compaction fallback。没有日志文件、日志级别、轮转或通用 redactor。

## 冲突说明

- 不要与另一个 Remote Compaction extension 同时启用；多个 `session_before_compact` handler 可能产生重复远端请求。
- 不要同时启用本项目 Computer Use 与 `pi-codex-computer-use`；工具名可能由加载顺序决定。
- 第三方 `apply_patch` 注册赢得同名 ownership 时，状态显示
  `conflicting-tool-name`；Toolkit 不替换或停用它。
- `pi-web-access` 可以共存，但不再是本项目的依赖。它的普通 `web_search` 与本项目任一 Web Search backend 同时启用时，`/pct status` 发出重复搜索路径警告；Toolkit 不主动关闭它。
- Toolkit 不主动探测、禁用或重写其他扩展。
- 第三方注册赢得 `find_tools`，或 Pi `--tools` allowlist 去掉该名字时，显示
  `conflicting-tool-name`；Tool Discovery 保持不激活，并恢复 deferred Toolkit
  名字的普通自有投影。Toolkit 不重写或停用第三方胜出者。
- 第三方注册赢得 `exec_command` 或 `write_stdin` 时，会同时停用两个 Toolkit
  shell 名字；Toolkit 不替换第三方工具。
- 第三方注册赢得 `exec` 或 `wait` 时，会同时停用两个 Toolkit Code Mode 名字；
  Toolkit 不替换第三方工具。
- 在执行规则下，Patch/Shell/Code 行只在存在**可见第三方胜出者**时报告
  `conflicting-tool-name`。被宿主从投影中过滤掉的名字（`--tools` allowlist 或
  受限 agent 角色）属于缺失，不是冲突：该 route 从未被准入，因此该行报告它的
  准入说明（`patch-unavailable`、`shell-pair-unavailable`、
  `code-pair-unavailable`、`code-shell-pair-unavailable`、
  `code-unavailable-did-not-promote-patch`、
  `patch-unavailable-kept-native-editing`），并与附加的 `Execution rules:` 块
  保持一致。旧版 flag 管理的行仍把缺失与冲突一并报告为
  `conflicting-tool-name`。
