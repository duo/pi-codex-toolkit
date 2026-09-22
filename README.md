# Pi Codex Toolkit

[简体中文](README.zh-CN.md)

Pi Codex Toolkit adds a small set of bounded OpenAI and Codex capabilities to
[Pi](https://github.com/earendil-works/pi) without replacing Pi's agent loop.
This README describes **version 0.2.0**, which adds Shell Sessions, Code Mode,
Tool Discovery and model-based execution rules to the original five
capabilities. See [release history](CHANGELOG.md) for changes since 0.1.0.

All eight capabilities are off by default:

| Capability           | What it adds                                                               | Main requirement                                                                                                     |
| -------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Web Search           | Native hosted search or the `openai_web_search` Sidecar tool               | An official compatible Responses route; Sidecar additionally needs a selected OpenAI API-key or Codex OAuth executor |
| Remote Compaction v2 | Codex checkpoint creation and replay at Pi's compaction boundary           | Official `openai-codex` OAuth route                                                                                  |
| Image Generation     | The `openai_generate_image` tool and saved PNG artifacts                   | Usable OpenAI API-key or Codex OAuth image route                                                                     |
| Apply Patch          | The provider-neutral `apply_patch` tool with Codex-compatible patch syntax | Any main model that can call ordinary Pi tools; Pi uses grammar sampling when supported and JSON otherwise           |
| Computer Use         | Six experimental sequential desktop tools                                  | macOS, interactive UI, an image-input model, and the paired ChatGPT/Codex components                                 |
| Shell Sessions       | Default-off `exec_command` and `write_stdin` tools over one local executor | Any main model that can call ordinary Pi tools                                                                       |
| Code Mode            | Default-off `exec` / `wait`: trusted JavaScript with the current user's authority in a fresh per-call worker, not a security sandbox | Any main model that can call ordinary Pi tools; Pi sends raw JavaScript through grammar sampling when supported and JSON otherwise; nested `apply_patch` needs confirmation in `confirm` mode |
| Tool Discovery       | Default-off `find_tools` that hides explicitly deferred Toolkit tools until they are discovered and loaded | Any main model that can call ordinary Pi tools; only Toolkit-owned names are managed |

## Requirements

- Node.js 22.19.0 or newer.
- Pi 0.87 series (`^0.87.0`). Older hosts and 0.88 or later are
  not claimed. Dated host qualification and its limits are recorded in
  [architecture verification](docs/en/architecture.md#9-protocol-probe-status).
- Provider authentication remains owned by Pi. Toolkit configuration never
  stores API keys or OAuth tokens.
- Computer Use depends on separately installed ChatGPT/Codex components. This
  package neither installs nor redistributes ChatGPT.app, Codex, `@oai/sky`,
  or the Computer Use helper.

## Install

### Version 0.2.0

These commands target 0.2.0 once its npm version or Git tag is available.
Version metadata and local packing alone do not establish publication.

Install the exact npm release through Pi's package manager:

```bash
pi install npm:pi-codex-toolkit@0.2.0
pi list
```

You can also install the matching immutable Git tag:

```bash
pi install https://github.com/duo/pi-codex-toolkit@v0.2.0
```

Versioned npm and Git installs do not advance automatically. To update, install
the newer version or tag explicitly. To remove the package, copy its exact
source from `pi list` into `pi remove <source>`.

### Upgrading from 0.1.0

Update Pi to the 0.87 series first; 0.1.0 was qualified with Pi 0.84.4.
Install one of the versioned sources above and restart Pi. Keep only one
Toolkit installation source to avoid duplicate tool registrations.

Existing valid configuration keeps its settings; the new capabilities remain
off unless explicitly enabled. Without an `execution` section, the legacy
enabled flags keep their additive behavior and do not hide native tools.
In `/pct config` → Execution rules, review the migration preview before
saving: the initial catch-all rule reflects the legacy flags (all-off produces
an empty rule list), and saved rules replace those flags. An active Shell or
Code route hides native `bash`; an active Patch route hides `edit` and `write`.
Opening the editor does not save
or migrate the file. Back up the config before opting in, especially if you
may return to 0.1.0, which does not understand execution rules. See
[configuration](docs/en/configuration.md#upgrading-from-010).

### Local development source

From a checkout containing the intended source revision, with its development
dependencies already provisioned, load it for one run without adding it to Pi
settings:

```bash
pi -e .
```

Use a version tag when you need a fixed release. Local source validation does
not establish npm publication or installation from the registry.

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
request, image generation, remote compaction, GUI launch, shell spawn, Code
Mode worker, or Computer Use process start, and exposes no Toolkit patch
mutation path.

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
  paths. Existing source files, including `Delete File` targets, must be valid
  UTF-8 text with consistent LF or CRLF; non-UTF-8, bare CR and mixed line endings
  are rejected before mutation. Binary deletion is unsupported.
  Inside an `Update File` hunk a bare empty line is read as an empty context
  line, and a hunk whose context ends with an empty line also matches without
  it; `Add File` hunks stay strict, so a bare empty line there is rejected.
  It rejects visible symlink components and stages replacements before
  committing each file atomically, but a multi-file patch is not a transaction
  and hostile concurrent path replacement is outside this static-containment
  boundary. It is not the Responses first-class `apply_patch_call` protocol.
- Computer Use starts its isolated bridge only for an explicit status probe or
  tool call. It never installs components, launches the GUI, or grants macOS
  permissions. `Confirm` remembers Yes per app for the current Pi session and
  asks again after No; `Always` skips only the Toolkit confirmation and never
  bypasses macOS permissions. No human approval deadline is added: validated
  asynchronous approval waiting does not consume the remaining execution budget
  and may continue until an answer, cancellation, or failure.
- Shell Sessions uses the user's local process authority, not a sandbox or
  TTY. Native `bash` remains available under the legacy enabled flags; an
  `execution` rule that routes direct Shell or Code hides it while that route
  holds and restores it when it ends. Short commands need not poll. Commands
  launch once. Ordinary same-process-group descendants remain owned after the
  leader exits; stop uses bounded escalation and reports unconfirmed cleanup.
  Stdin admission is bounded; a transport acknowledgement does not prove the
  application acted, and unknown delivery must not be resent automatically.
- Code Mode runs one short JavaScript program per `exec` call in a separate
  worker thread with fresh state, not a security sandbox. Run only trusted code
  with the current user's authority. `uses` declares and validates supported
  `tools.<name>` adapter dispatch; it does not contain hostile JavaScript or
  restrict ambient host authority. Declared nested calls go through each tool's
  existing executor with its own validation, disabled state, ordering, and file
  mutation queues. Pi's native `tool_call` / `tool_result` hooks and
  third-party permission interceptors see only the outer `exec` / `wait` call
  (including its full `code` and `uses`); they do not see nested calls, though
  bounded nested progress records travel on the outer call's own updates. In
  `confirm` mode extra Toolkit confirmation gates **only `apply_patch`**, at the
  actual nested call: a headless cell that merely declares Patch still runs, and
  only a real nested `apply_patch` fails before any mutation. Shell commands can
  also mutate files but retain direct-shell authority.
  Arguments are validated before confirmation and live authority is rechecked
  after waits. Completion settles tracked transitive calls, including work
  introduced by result serialization; failure fences unsent calls and
  cooperatively aborts unsettled work without rollback. Worker termination
  supports CPU-bound cancellation, not forced termination of all host effects;
  V8 limits do not bound total RSS or external allocations. Live shell controls
  survive omitted/clipped JS values. Code Mode cleanup does not stop
  already-yielded independent shells.
- Shell/Code recovery preserves decoded streams or emitted/serialized selected
  representations before preview loss. Private files are created lazily and
  remain readable after handle release and feature disablement until actual Pi
  `session_shutdown`. Small fully delivered results need no files. Read returned
  paths with an available native `read` or authorized shell tool; never rerun
  effects for recovery. Capture snapshots are not final-outcome receipts;
  partial, missing or unavailable capture is not complete evidence. Files may
  contain secrets; there is no aggregate disk quota or restart guarantee.
- Disabling/conflicting execution features requests cleanup, not guaranteed
  erasure of all work. Attempted session switch/fork cleans execution first and
  vetoes replacement if cleanup is incomplete. Some work may already stop even
  if the action is cancelled; files remain until actual shutdown. Unchanged
  `/pct reload` and model changes preserve execution. Pi resource `/reload`,
  quit and emergency teardown are not cancellable here: work/files may remain,
  and errors do not guarantee usable old handles after replacement.
- Tool Discovery is local and default-off. `find_tools` searches the explicit
  file-level `toolDiscovery.deferred` list and additively activates only
  Toolkit-owned, currently eligible names. It never executes a tool, grants
  permission, revives a disabled or user-filtered capability, replaces a
  conflicting registration, or enables a third-party tool; loaded names are
  forgotten on a new/resume/fork session and no call is replayed.

See the [architecture](docs/en/architecture.md) for the complete protocol and
failure boundaries.

## Verification status

The canonical [verification and limitations summary](docs/en/architecture.md#9-protocol-probe-status)
separates historical feature/model probes (including September 10, 2026), the
September 13 repair tests and deterministic public-host runs, and subsequent
source-only checks. None is a fresh installation or GitHub Actions result.
Historical live probes were not rerun on the repaired source; untested API-key
routes, platforms and UI paths remain unqualified. No universal Code Mode or
Tool Discovery token/latency benefit is claimed.

## Development

These commands operate on the selected checkout. Public documentation is
limited to `docs/en/`, `docs/zh/` and
`docs/third-party/`; private research is excluded from both public Git export
and npm. Local packing does not select a new release.

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
