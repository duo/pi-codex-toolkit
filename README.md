# Pi Codex Toolkit

[简体中文](README.zh-CN.md)

Pi Codex Toolkit adds a small set of bounded OpenAI and Codex capabilities to
[Pi](https://github.com/earendil-works/pi) without replacing Pi's agent loop.
Version 0.1.0 is the first public release.

All capabilities are off by default:

| Capability           | What it adds                                                               | Main requirement                                                                                                     |
| -------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Web Search           | Native hosted search or the `openai_web_search` Sidecar tool               | An official compatible Responses route; Sidecar additionally needs a selected OpenAI API-key or Codex OAuth executor |
| Remote Compaction v2 | Codex checkpoint creation and replay at Pi's compaction boundary           | Official `openai-codex` OAuth route                                                                                  |
| Image Generation     | The `openai_generate_image` tool and saved PNG artifacts                   | Usable OpenAI API-key or Codex OAuth image route                                                                     |
| Apply Patch          | The provider-neutral `apply_patch` tool with Codex-compatible patch syntax | Any main model that can call ordinary Pi tools; Pi uses grammar sampling when supported and JSON otherwise           |
| Computer Use         | Six experimental sequential desktop tools                                  | macOS, interactive UI, an image-input model, and the paired ChatGPT/Codex components                                 |

## Requirements

- Node.js 22.19.0 or newer.
- Pi 0.84.4 is the currently verified version.
- Provider authentication remains owned by Pi. Toolkit configuration never
  stores API keys or OAuth tokens.
- Computer Use depends on separately installed ChatGPT/Codex components. This
  package neither installs nor redistributes ChatGPT.app, Codex, `@oai/sky`,
  or the Computer Use helper.

## Install

Install the exact npm release through Pi's package manager:

```bash
pi install npm:pi-codex-toolkit@0.1.0
pi list
```

You can also install the matching immutable Git tag:

```bash
pi install https://github.com/duo/pi-codex-toolkit@v0.1.0
```

To try a local checkout for one run without adding it to Pi settings:

```bash
git clone https://github.com/duo/pi-codex-toolkit.git
cd pi-codex-toolkit
npm ci
pi -e .
```

Versioned npm and Git installs do not advance automatically. To update, install
the newer version or tag explicitly. To remove the package, copy its exact
source from `pi list` into `pi remove <source>`.

## First run

Start Pi and use:

```text
/pct status
/pct config
/pct reload
```

`/pct config` enables capabilities explicitly and lets Sidecar Search choose
its executor model and independent effort. `/pct status` explains their
configured and effective state. `/pct reload` rereads the Toolkit config after
a manual edit. With every switch off, startup performs no Toolkit network
request, image generation, remote compaction, GUI launch, or Computer Use
process start, and exposes no Toolkit patch mutation path.

The config file is normally:

```text
~/.pi/agent/extensions/pi-codex-toolkit.json
```

Pi's resolved agent directory is used when `PI_CODING_AGENT_DIR` is set. See
[configuration](docs/en/configuration.md) for the schema and eligibility rules.

## Data, cost, and desktop boundaries

- Native Search modifies only the current compatible Responses request.
- Sidecar Search sends the generated query verbatim in a separate OpenAI
  Responses request and can add latency and cost. It does not automatically
  attach the full Pi conversation, although the generated query may summarize
  conversation content. It returns at most 20 deduplicated clickable sources;
  this is a Toolkit output budget, not an upstream result-count guarantee.
- Image Generation sends one separate request and saves the returned PNG under
  Pi's agent directory. It never retries or switches accounts after dispatch.
- Remote Compaction sends a bounded provider-visible history to the official
  Codex route and stores a readable fallback plus one opaque checkpoint in the
  Pi session.
- Apply Patch uses one local executor for Pi's grammar and JSON-function call
  paths. It rejects visible symlink components and stages replacements before
  committing each file atomically, but a multi-file patch is not a transaction
  and hostile concurrent path replacement is outside this static-containment
  boundary. It is not the Responses first-class `apply_patch_call` protocol.
- Computer Use starts its isolated bridge only for an explicit status probe or
  tool call. It never installs components, launches the GUI, or grants macOS
  permissions. `Confirm` remembers Yes per app for the current Pi session and
  asks again after No; `Always` skips only the Toolkit confirmation and never
  bypasses macOS permissions.

See the [architecture](docs/en/architecture.md) for the complete protocol and
failure boundaries.

## Verification status

Deterministic tests cover all five capabilities, official route validation,
failure behavior, loader integration, and the all-off default.

Real Pi 0.84.4 probes have completed for:

- two consecutive Native Web Search turns and an
  OpenAI → non-OpenAI → OpenAI status cycle;
- one Codex OAuth Sidecar Search protocol call with a non-empty answer and
  sources;
- one Grok-main RPC sequence with an explicit Codex OAuth Search executor and
  effort: one Sidecar Search, one Image Generation, then a no-tool follow-up,
  with one Search dispatch, one Images dispatch, and no native Search tool on
  the Grok request;
- consecutive Remote Compaction, restart, resume, fork, and a normal turn;
- Codex OAuth Image Generation with a persisted native image result and a
  normal follow-up;
- read-only Computer Use `list_apps` and `get_app_state`, plus a normal
  follow-up; and
- the corrected client-Set build's complete real-Pi `Confirm` / `Always`
  matrix: same-app Yes-once, independent app confirmation, No-then-reprompt,
  unchanged `/pct reload`, `/new` reset, `Always` across `/new`, and a normal
  no-tool turn.

No desktop action or macOS permission change was part of either Computer Use
live gate.

The following live probes remain pending because no eligible local OpenAI
API-key provider/model is configured:

- API-key Sidecar Search from a non-OpenAI main model; and
- API-key Image Generation.

The Native Web Search input-above-128k probe is also pending. Codex OAuth
Sidecar Search uses Pi's official provider boundary and is the supported
Sidecar baseline; it does not use Codex's private `alpha/search` endpoint.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run format:check
npm pack --dry-run --ignore-scripts
```

Detailed documentation:

- [Architecture](docs/en/architecture.md)
- [Configuration](docs/en/configuration.md)
- [中文架构](docs/zh/architecture.md)
- [中文配置](docs/zh/configuration.md)

Release notes are maintained in [CHANGELOG.md](CHANGELOG.md). Report defects
through [GitHub Issues](https://github.com/duo/pi-codex-toolkit/issues).

## License

Pi Codex Toolkit is licensed under the [Apache License 2.0](LICENSE). It
includes modified portions of OpenAI Codex's Apply Patch implementation; see
[NOTICE](NOTICE) and [docs/third-party](docs/third-party/) for attribution and
license details.
