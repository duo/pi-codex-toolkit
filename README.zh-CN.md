# Pi Codex Toolkit

[English](README.md)

Pi Codex Toolkit 在不替代 [Pi](https://github.com/earendil-works/pi) agent
loop 的前提下，增加少量、边界明确的 OpenAI/Codex 能力。0.1.0 是首个公开
版本。

所有能力默认关闭：

| 能力                 | 增加的功能                                                     | 主要条件                                                                            |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Web Search           | Native hosted search 或 `openai_web_search` Sidecar 工具       | 官方兼容 Responses route；Sidecar 还需要选定 OpenAI API-key 或 Codex OAuth executor |
| Remote Compaction v2 | 在 Pi 压缩边界创建并 replay Codex checkpoint                   | 官方 `openai-codex` OAuth route                                                     |
| Image Generation     | `openai_generate_image` 工具和持久化 PNG artifact              | 可用 OpenAI API-key 或 Codex OAuth image route                                      |
| Apply Patch          | provider-neutral 的 `apply_patch` 工具和 Codex 兼容 patch 语法 | 任意能调用普通 Pi 工具的主模型；Pi 在支持时使用 grammar sampling，否则使用 JSON     |
| Computer Use         | 六个实验性、顺序执行的桌面工具                                 | macOS、交互式 UI、支持 image input 的模型及成套 ChatGPT/Codex 组件                  |

## 环境要求

- Node.js 22.19.0 或更新版本。
- 当前已验证的 Pi 版本为 0.84.4。
- Provider 认证始终由 Pi 管理；Toolkit 配置不保存 API key 或 OAuth token。
- Computer Use 依赖另行安装的 ChatGPT/Codex 组件。本包不会安装或分发
  ChatGPT.app、Codex、`@oai/sky` 或 Computer Use helper。

## 安装

通过 Pi 的包管理器安装确定版本的 npm 包：

```bash
pi install npm:pi-codex-toolkit@0.1.0
pi list
```

也可以安装对应的不可变 Git tag：

```bash
pi install https://github.com/duo/pi-codex-toolkit@v0.1.0
```

若只想临时测试本地 checkout、单次加载且不写入 Pi settings：

```bash
git clone https://github.com/duo/pi-codex-toolkit.git
cd pi-codex-toolkit
npm ci
pi -e .
```

固定版本的 npm 与 Git 安装不会自动更新。升级时请显式安装新版本或新 tag。
移除时，从 `pi list` 复制完整 source 并执行 `pi remove <source>`。

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
GUI、启动 Computer Use 进程，也不会暴露 Toolkit patch 写入路径。

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
- Apply Patch 的 grammar 与 JSON function 调用共用一个本地 executor。它拒绝
  可见 symlink 组件，并在逐文件原子提交前完成 staging；多文件 patch 不是
  transaction，静态 containment 也不防御恶意并发路径替换。它不是 Responses
  一等 `apply_patch_call` 协议。
- Computer Use 只在显式 status probe 或工具调用时启动隔离 bridge；不会安装
  组件、启动 GUI 或授予 macOS 权限。`Confirm` 在当前 Pi session 内按 app
  记住 Yes，No 后下次仍会询问；`Always` 只跳过 Toolkit confirmation，不绕过
  macOS 权限。

完整协议与失败边界见[架构文档](docs/zh/architecture.md)。

## 验证状态

确定性测试覆盖五项能力、official route 校验、失败行为、loader 集成及默认
全关闭状态。

以下真实 Pi 0.84.4 probe 已完成：

- Native Web Search 连续两轮，以及 OpenAI → 非 OpenAI → OpenAI 状态切换；
- 一次返回非空 answer 与 sources 的 Codex OAuth Sidecar Search 协议调用；
- 一次 Grok 主模型 RPC 序列：显式选择 Codex OAuth Search executor 与 effort，
  依次完成一次 Sidecar Search、一次 Image Generation 和无工具 follow-up；Search
  与 Images 各 dispatch 一次，Grok 请求没有收到 native Search tool；
- 连续 Remote Compaction、restart、resume、fork 与正常 turn；
- Codex OAuth Image Generation、持久化原生图片结果及正常 follow-up；
- 只读 Computer Use `list_apps`、`get_app_state` 及正常 follow-up；
- 修正后的 client-Set 版本完成真实 Pi `Confirm` / `Always` 矩阵：同 app 的
  Yes-once、不同 app 独立确认、No 后再次询问、未变更配置的 `/pct reload`、
  `/new` 重置、跨 `/new` 的 `Always`，以及普通无工具 turn。

两次 Computer Use live gate 都没有执行桌面 action 或修改 macOS 权限。

由于本地没有符合条件的 OpenAI API-key provider/model，以下 live probe 仍
未完成：

- 非 OpenAI 主模型调用 API-key Sidecar Search；
- API-key Image Generation。

Native Web Search 的大于 128k input probe 也仍未完成。Codex OAuth Sidecar
Search 通过 Pi 的官方 provider 边界执行，是当前支持的 Sidecar 基线；不会
使用 Codex 私有的 `alpha/search` endpoint。

## 开发

```bash
npm ci
npm test
npm run typecheck
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
