# Pi Codex Toolkit

[English](README.md)

Pi Codex Toolkit 在不替代 [Pi](https://github.com/earendil-works/pi) agent
loop 的前提下，增加少量、边界明确的 OpenAI/Codex 能力。
本文描述 **0.2.0 版本**：在原有五项能力之上，增加 Shell Sessions、Code Mode、
Tool Discovery 和按模型匹配的执行规则。相对 0.1.0 的变化见[版本历史](CHANGELOG.md)。

八项能力全部默认关闭：

| 能力                 | 增加的功能                                                     | 主要条件                                                                            |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Web Search           | Native hosted search 或 `openai_web_search` Sidecar 工具       | 官方兼容 Responses route；Sidecar 还需要选定 OpenAI API-key 或 Codex OAuth executor |
| Remote Compaction v2 | 在 Pi 压缩边界创建并 replay Codex checkpoint                   | 官方 `openai-codex` OAuth route                                                     |
| Image Generation     | `openai_generate_image` 工具和持久化 PNG artifact              | 可用 OpenAI API-key 或 Codex OAuth image route                                      |
| Apply Patch          | provider-neutral 的 `apply_patch` 工具和 Codex 兼容 patch 语法 | 任意能调用普通 Pi 工具的主模型；Pi 在支持时使用 grammar sampling，否则使用 JSON     |
| Computer Use         | 六个实验性、顺序执行的桌面工具                                 | macOS、交互式 UI、支持 image input 的模型及成套 ChatGPT/Codex 组件                  |
| Shell Sessions       | 默认关闭的 `exec_command` / `write_stdin`，共用一个本地 executor | 任意能调用普通 Pi 工具的主模型                                                      |
| Code Mode            | 默认关闭的 `exec` / `wait`：以当前用户权限运行可信 JavaScript，每次调用使用全新 worker，不是安全沙箱 | 任意能调用普通 Pi 工具的主模型；支持时由 Pi 以 grammar sampling 发送原始 JavaScript，否则使用 JSON；`confirm` 模式下嵌套 `apply_patch` 需要确认 |
| Tool Discovery       | 默认关闭的 `find_tools`：显式 deferred 的 Toolkit 工具在被发现并加载前保持隐藏 | 任意能调用普通 Pi 工具的主模型；只管理 Toolkit 自有工具 |

## 环境要求

- Node.js 22.19.0 或更新版本。
- 需要 Pi 0.87 系列（`^0.87.0`）。不声明更早的 host 或 0.88 及之后的版本。带日期的
  host 验证与限制见 [架构验证](docs/zh/architecture.md#9-协议探针状态)。
- Provider 认证始终由 Pi 管理；Toolkit 配置不保存 API key 或 OAuth token。
- Computer Use 依赖另行安装的 ChatGPT/Codex 组件。本包不会安装或分发
  ChatGPT.app、Codex、`@oai/sky` 或 Computer Use helper。

## 安装

### 0.2.0 版本

以下命令在对应 npm 版本或 Git tag 可用后安装 0.2.0。版本元数据和本地打包
本身不代表已经发布。

通过 Pi 的包管理器安装确定版本的 npm 包：

```bash
pi install npm:pi-codex-toolkit@0.2.0
pi list
```

也可以安装对应的不可变 Git tag：

```bash
pi install https://github.com/duo/pi-codex-toolkit@v0.2.0
```

固定版本的 npm 与 Git 安装不会自动更新。升级时请显式安装新版本或新 tag。
移除时，从 `pi list` 复制完整 source 并执行 `pi remove <source>`。

### 从 0.1.0 升级

先将 Pi 升级到 0.87 系列；0.1.0 验证时使用的是 Pi 0.84.4。
安装上方一种固定版本来源，然后重启 Pi。只保留一个 Toolkit 安装来源，避免
重复注册工具。

现有有效配置保留原设置，新能力在显式启用前仍然关闭。不含 `execution` 节时，
旧 enabled 开关继续使用累加语义，不隐藏原生工具。在 `/pct config` → Execution
rules 中，先检查迁移预览再保存：初始 catch-all 规则对应旧开关（全关时生成空规则
列表），保存后规则取代这些开关。生效的 Shell 或 Code route 隐藏原生 `bash`；
生效的 Patch route
隐藏 `edit` 和 `write`。仅打开编辑器不会保存或迁移文件。选择迁移前先备份
配置，尤其是以后可能退回不认识执行规则的 0.1.0 时。见
[配置文档](docs/zh/configuration.md#从-010-升级)。

### 本地开发源码

在包含目标源码修订、且已备好开发依赖的 checkout 中，可单次加载而不写入 Pi
settings：

```bash
pi -e .
```

需要固定版本时使用版本 tag。源码本地验证不代表已发布到 npm，也不代表
已经从 registry 安装验证。

## 首次使用

启动 Pi 后使用：

```text
/pct status
/pct config
/pct reload
```

`/pct config` 用于显式开启能力，并可选择 Sidecar Search 的 executor model
与独立 effort；`/pct status` 说明配置状态、实际状态及
原因；手工修改 Toolkit 配置后用 `/pct reload` 重载。所有开关关闭时，
启动不会发出 Toolkit 网络请求、生成图片、执行 Remote Compaction、启动
GUI、启动 shell 进程、启动 Code Mode worker、启动 Computer Use 进程，也不会
暴露 Toolkit patch 写入路径。

配置文件通常位于：

```text
~/.pi/agent/extensions/pi-codex-toolkit.json
```

设置 `PI_CODING_AGENT_DIR` 时使用 Pi 解析后的 agent dir。完整 schema 与
资格条件见[配置文档](docs/zh/configuration.md)。

## 数据、费用与桌面边界

- Native Search 只修改当前兼容的 Responses 请求。
- Sidecar Search 会把生成的 query 原样放进一次独立 OpenAI Responses
  请求，增加延迟与费用。它不会自动附带完整 Pi 对话，但 query 可能概括
  对话内容。结果最多保留 20 条去重后的可点击 sources；这是 Toolkit 的
  输出预算，不是上游返回数量保证。
- Image Generation 每次发送一个独立请求，并把返回的 PNG 保存到 Pi agent
  dir；dispatch 后不重试，也不切换账户。
- Remote Compaction 把有界的 provider-visible 历史发送到官方 Codex route，
  并在 Pi session 中保存可读 fallback 和一个 opaque checkpoint。
- Apply Patch 的 grammar 与 JSON function 调用共用一个本地 executor。现有源文件
  （包括 `Delete File` 目标）必须是有效 UTF-8 文本，换行须统一为 LF 或 CRLF；
  非 UTF-8、裸 CR 和混合换行会在 mutation 前被拒绝。不支持二进制文件删除。
  `Update File` hunk 中的裸空行按空 context 行读取，context 以空行结尾的 hunk
  去掉该空行后同样可以匹配；`Add File` hunk 仍然严格，其中的裸空行会被拒绝。
  它拒绝可见 symlink 组件，并在逐文件原子提交前完成 staging；多文件 patch 不是
  transaction，静态 containment 也不防御恶意并发路径替换。它不是 Responses
  一等 `apply_patch_call` 协议。
- Computer Use 只在显式 status probe 或工具调用时启动隔离 bridge；不会安装
  组件、启动 GUI 或授予 macOS 权限。`Confirm` 在当前 Pi session 内按 app
  记住 Yes，No 后下次仍会询问；`Always` 只跳过 Toolkit confirmation，不绕过
  macOS 权限。不新增人工审批期限：经校验的异步审批等待不消耗剩余执行预算，
  可持续到答复、取消或失败。
- Shell Sessions 使用用户的本地进程权限，不是 sandbox 或 TTY。使用旧 enabled
  开关时原生 `bash` 仍可用；`execution` 规则选中直调 Shell 或 Code 时，会在该
  route 生效期间隐藏它，route 结束后恢复。短命令不一定需要轮询。命令只启动一次；leader 退出后，普通同进程组
  后代仍被管理。stop 有界升级并报告无法确认的清理。stdin 准入有上限；transport
  确认不证明应用已执行，delivery unknown 时不可自动重发。
- Code Mode 每次 `exec` 都在独立 worker thread 中以全新状态运行一段短
  JavaScript，不是安全沙箱；只应运行可信代码，使用当前用户的权限。`uses`
  声明并校验受支持的 `tools.<name>` adapter dispatch，不防御恶意 JavaScript，
  也不限制宿主环境权限。已声明的嵌套调用经过各工具现有 executor 自身的校验、
  禁用状态、顺序与文件 mutation queue。Pi 原生 `tool_call` / `tool_result` hook
  以及第三方权限拦截器只能看到外层 `exec` / `wait` 调用（含完整 `code` 与 `uses`），看不到嵌套调用；
  但有界的嵌套进度记录会随外层调用的 update 一起返回。
  `confirm` 的额外 Toolkit 确认**只适用于 `apply_patch`**，并且发生在嵌套调用
  真正执行时：headless 下只声明 Patch 的 cell 照常运行，只有真正的嵌套
  `apply_patch` 会在任何改动之前失败。shell 同样能修改文件，但保持直接 shell
  的权限语义。参数先校验再确认，等待后复查实时权限。
  完成会等待被跟踪的传递调用，包括结果序列化引入的工作；失败会封禁未 dispatch
  调用并协作 abort 未 settle 工作，不回滚。worker 终止支持 CPU-bound 取消，
  不保证强制终止所有 host effect；V8 limit 不限制 total RSS 或外部分配。
  独立 shell 控制信息不因 JS 返回值被省略/截断而丢失；Code Mode 清理不会停止
  已 yield 的独立 shell。
- Shell/Code 在 preview 丢失前保留解码 stream 或已发出/序列化的选定表示。
  私有文件惰性创建，handle 释放或功能禁用后仍可读，直到实际 Pi
  `session_shutdown`。已完整交付的小结果无需文件。通过可用的原生 `read` 或
  获授权 shell 读取返回路径，不可为恢复证据重跑副作用。capture 快照不是最终
  outcome receipt；partial、missing、unavailable 不代表完整证据。文件可能含
  密钥；没有聚合磁盘 quota，也不保证重启恢复。
- 禁用/冲突会请求清理，而非保证所有工作已消失。尝试 session switch/fork 会先
  清理执行；清理不完整则否决替换。即使操作被取消，部分工作也可能已停止，不会
  回滚；文件保留到实际 shutdown。未变更 `/pct reload` 和 model change 保留
  执行。Pi resource `/reload`、quit、紧急 teardown 在这里不可否决：可能残留
  工作/文件，报错也不保证替换后旧 handle 可用。
- Tool Discovery 是本地且默认关闭的。`find_tools` 在文件级
  `toolDiscovery.deferred` 显式列表中搜索，并只增量激活 Toolkit 自有且当前
  具资格的名字。它绝不执行工具、不授予权限、不复活被禁用或被用户过滤的能力、
  不替换冲突注册、也不启用第三方工具；new/resume/fork 后遗忘已加载名字，且
  不重放任何调用。

完整协议与失败边界见[架构文档](docs/zh/architecture.md)。

## 验证状态

统一的[验证与限制摘要](docs/zh/architecture.md#9-协议探针状态)区分历史
能力/模型探针（含 2026 年 9 月 10 日）、9 月 13 日修复测试与确定性公开 host
运行，以及后续源码级检查。它们均不代表新的安装或 GitHub Actions 结果。
历史 live 探针没有在修复后源码重跑；未测试的 API-key route、平台与 UI 路径
仍未获验证。不声明 Code Mode 或 Tool Discovery 的普适 token/延迟收益。

## 开发

这些命令作用于选定 checkout。公开文档仅限 `docs/en/`、
`docs/zh/` 和 `docs/third-party/`；私有研究同时排除在公开 Git 导出和 npm 之外。
本地打包不等于选定新版本。

```bash
npm ci --ignore-scripts
npm test
npm run test:coverage
npm run test:coverage:project
npm run typecheck
npm run lint
npm run format:check
npm pack --dry-run --ignore-scripts
```

详细文档：

- [架构](docs/zh/architecture.md)
- [配置](docs/zh/configuration.md)
- [English architecture](docs/en/architecture.md)
- [English configuration](docs/en/configuration.md)

版本说明维护在 [CHANGELOG.md](CHANGELOG.md)；缺陷请通过
[GitHub Issues](https://github.com/duo/pi-codex-toolkit/issues) 反馈。

## 许可证

Pi Codex Toolkit 采用 [Apache License 2.0](LICENSE)。项目包含 OpenAI
Codex Apply Patch 实现的修改部分；归属与许可证详情见 [NOTICE](NOTICE) 和
[docs/third-party](docs/third-party/)。
