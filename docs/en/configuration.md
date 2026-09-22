# Pi Codex Toolkit Configuration

> Scope: version 0.2.0 on Pi 0.87 series. This schema adds capabilities and optional execution rules beyond 0.1.0. See [dated verification and limits](architecture.md#9-protocol-probe-status).

## Configuration file

Current source uses one global file:

```text
<getAgentDir()>/extensions/pi-codex-toolkit.json
```

Under Pi's default agent directory, this is usually:

```text
~/.pi/agent/extensions/pi-codex-toolkit.json
```

When `PI_CODING_AGENT_DIR` is set, use Pi's resolved agent directory rather than a hard-coded home path.

There are no project overrides, environment overrides, CLI flags, file watchers, or layered inheritance. Secrets never enter this file.

## Version 0.2.0 schema

This example includes an opt-in execution rule; a new default configuration
does not include `execution`.

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

Every implemented capability is off by default. This is not because the
features are inherently unsafe; they create additional network requests, cost,
session-format changes, local file mutations, or desktop actions and should be
enabled explicitly.

Fresh files omit `execution`. Until that section is saved, `applyPatch.enabled`,
`shellSessions.enabled`, and `codeMode.enabled` keep their additive meaning and
do not hide Pi `bash` / `edit` / `write`. After `execution` is present, those
three `enabled` flags are removed on save; ordered model rules are the only
authority for Patch, direct Shell, and Code. `codeMode.approvalMode` remains.
`match` is a case-sensitive glob (`*` / `?`) against `modelId`, or against
`provider/modelId` when the pattern contains `/`. First match wins.

The schema has no fields for endpoints, model allowlists, timeouts, retries, headers, provider routers, or fallback order. `sidecarModel` selects the single model that actually executes standalone search requests; it is not a main-model allowlist.

## Upgrading from 0.1.0

Upgrade Pi to the 0.87 series before installing Toolkit 0.2.0. Existing valid
configuration keeps its settings and missing new sections use off defaults;
startup does not write a migration or enable a new capability.

Execution rules are opt-in. Without `execution`, the old enabled flags remain
additive and Pi's native tools remain visible. `/pct config` → Execution rules
previews one catch-all rule from those flags, or an empty rule list when all
three flags are off. Merely opening the editor does not write the file; review
the draft before choosing Save. Once saved, the
rules replace the three execution enabled flags, and active replacement routes
hide their native counterparts as described above. Preserve a config backup
before opting in if a downgrade is possible: 0.1.0 does not read this schema,
so restore its configuration rather than assuming the rules will carry back.

## `/pct` commands

### `/pct` or `/pct config`

Use a small loop around Pi's standard `ctx.ui.select()` with:

- Web Search on/off.
- Web Search backend: `auto`, `native`, or `sidecar`.
- Web Search mode: `live` or `cached`.
- Search context size: `low`, `medium`, or `high`.
- Web Search executor: one OpenAI/Codex Responses model from Pi's model registry that passes official-route validation.
- Web Search executor effort: `auto` or one thinking level supported by the selected Codex model.
- Remote Compaction on/off.
- Image Generation on/off.
- Computer Use on/off.
- Computer Use approval: `Confirm` or `Always`.
- Execution rules: add/edit/delete/reorder model globs and independent Patch / direct Shell / Code flags. Opening this page from a legacy file previews migration to one catch-all rule, or an empty list when all flags are off. The editor uses Pi `select`/`input` dialogs. Save records the disk revision and rejects a stale file instead of last-writer-wins.
- Code Mode nested Apply Patch confirmation: `Confirm` or `Always`.
- Tool Discovery on/off.
- Debug metadata on/off.

Do not build a custom Settings page, tabs, search, or scope inheritance.

After saving, update the in-memory configuration immediately and synchronize only toolkit-owned tools. Without an interactive UI, print the configuration path and do not wait for input.

### `/pct status`

Show the current model/provider/API, configuration path, and for every implemented capability:

```text
configured: on | off
effective: active | deferred | unavailable | off
reason: short reason or empty
```

`active` means the model can call the capability now. `deferred` means the
capability is configured and would otherwise be active, but Tool Discovery is
holding back its deferred names until `find_tools` loads them. A non-deferred
sibling of the same capability may still be in the active set. When `effective`
is `deferred`, `backend` / `transport` stay as they would be when active, and
`reason` is empty.

Status `deferred` corresponds to a `find_tools` query `eligible` for the same
name (configured, not yet loaded, loader available), except Computer Use:
`/pct status` additionally probes `node_repl` and can report `unavailable`
while query, which uses only static inspection, still reports `eligible`.

When the last read of the configuration file failed, status shows the error
before the capabilities, with its detail in parentheses when there is one (see
Read/write semantics):

```text
Config error: invalid-config (applyPatch.enabled must be true or false)
```

Web Search additionally shows:

```text
requested backend: auto | native | sidecar
effective backend: native | sidecar | unavailable | off
web search executor: provider/model | —
web search executor effort: auto | off | minimal | low | medium | high | xhigh | max | —
```

Image Generation additionally shows:

```text
backend: codex-oauth | api-key | —
```

Computer Use additionally shows:

```text
transport: node-repl | —
```

Shell Sessions additionally notes that it uses local pipes only, has no TTY,
and never replays a command.

Code Mode additionally notes that nested calls are dispatched by the cell and
are not visible to per-call tool hooks or third-party permission interceptors.

Tool Discovery additionally shows the number of managed deferred names and how
many of them are loaded in this session. Both counts are 0 unless the
`find_tools` loader is available (discovery enabled and this extension owns
`find_tools`). It notes that only explicitly managed Toolkit-owned tools can be
loaded.

`effective backend: native` means only that the current route passes structural eligibility and will receive hosted-tool injection; it does not guarantee that the service supports the current model/reasoning/input combination. Sidecar status must state that it is a separate OpenAI request with additional cost and latency.

Typical reasons include:

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

The last six appear only while `execution` rules are in force. They name the
admitted tool a requested route was missing: `patch-unavailable` for the owned
`apply_patch`, `shell-pair-unavailable` for the owned `exec_command` /
`write_stdin` pair, `code-pair-unavailable` for the owned `exec` / `wait` pair,
and `code-shell-pair-unavailable` when that pair is admitted but its nested
Shell pair is not. `code-unavailable-did-not-promote-patch` and
`patch-unavailable-kept-native-editing` mean a Patch route requested together
with Code stayed inactive: Pi's native editing tools are kept, and an
unavailable Code route never becomes direct Patch. These rows tell the two
ways an owned name can be missing apart: a name another extension **visibly
owns** is `conflicting-tool-name`, while a name this host filtered out of the
projection (a `--tools` allowlist, a child role) was never admitted, so the row
carries that route's admission note instead. The legacy enabled-flag rows keep
reporting both cases as `conflicting-tool-name`. A capability the rules did not
request is plain `off` with no reason.

With `execution` rules in force, status also appends an `Execution rules:`
block reporting the matched rule, the requested and effective routes, whether
`bash` and `edit` / `write` are hidden, and the same note names. When a
configuration was saved but applying it failed, an `Apply error:` line appears
after the config error line; the previously committed tool projection stays
active until a later apply succeeds. The same line reports a Code Mode cleanup
that did not confirm, even when a newer model change has since committed: that
manager admits no new cell until the cleanup succeeds, its retained cells keep
`wait` and terminate, and the next `/pct reload` or model change retries the
cleanup and rebinds a fresh manager on success.

Three of these describe the route rather than a missing piece of configuration:
`current-model-missing` means the session has no current model to inspect;
`unsupported-api` means the provider is `openai` or `openai-codex` but the model
does not use that provider's Responses API (`openai-responses` and
`openai-codex-responses`); `credential-mismatch` means the credential kind does
not match the route, such as ChatGPT OAuth on the `api.openai.com` route, an API
key on the `chatgpt.com` route, or a refreshed credential that moves the request
to the other route.

### `/pct reload`

Reload only `pi-codex-toolkit.json`, update memory, and synchronize toolkit tools. Do not call Pi's global `ctx.reload()`.

Run this command after manually editing the file. There is no watcher.

When the read fails, the file is left untouched and the command reports the
error, for example
`Pi Codex Toolkit config error: invalid-config (applyPatch.enabled must be true or false); using all-off defaults.`
The message ends `using last known good settings.` instead once a valid
configuration has been read or saved since Pi loaded the extension.

## Read/write semantics

- Write a temporary file in the same directory and rename it, avoiding partially written JSON.
- Never overwrite an invalid source file.
- A missing file is not an error; it means the all-off defaults.
- A failed read is one of three errors. `invalid-json`: the file is not valid JSON; there is no detail, because the parser's message would quote the file. `invalid-config`: the JSON is not an object, or a known field has the wrong type or value; the detail names the first such field and what it must be, such as `applyPatch.enabled must be true or false`. `config-read-failed`: the file could not be read; the detail is the system error code, such as `EACCES`, when there is one. A detail never repeats the invalid value.
- After a failed read, keep the last valid configuration read or saved since Pi loaded the extension (the last-known-good value), or the all-off defaults if there is none, and report the error in status.
- When a session starts after a failed read and an interactive UI exists (TUI or RPC), the `/pct reload` message appears once as a warning. Print and JSON modes show nothing extra; use `/pct status` there.
- Ignore unknown keys at runtime but preserve them verbatim across `/pct config` saves, including unknown keys nested inside known objects.
- Toolkit saves take a cooperative directory lock beside the JSON file (`<config>.lock/`), re-read the file, and reject `stale-revision` or `lock-held` rather than last-writer-wins among cooperating Toolkit writers. This does not serialize arbitrary editors outside that protocol. A `lock-held` message names the lock directory and, when an owner record was read, that owner's pid and whether it is still running. If every save reports `lock-held` and no other Toolkit process is running, a previous save may have left `<config>.lock/reclaim`; remove that directory (or the whole `.lock` directory) only after confirming there is no live writer. An empty leftover `reclaim/` directory is recovered automatically; one that still contains an `owner` file is not.
- `/pct config` is persistent authority; Pi `/tools` changes are temporary for the current model phase.

## Eligibility

When the configuration file has an `execution` section, the Apply Patch, Shell
Sessions, and Code Mode subsections below still describe the same executors and
conflict rules, but the switch is the matching model rule instead of
`applyPatch.enabled`, `shellSessions.enabled`, or `codeMode.enabled`, and an
active route hides the native tool it replaces: Shell or Code hides `bash`,
Patch hides `edit` and `write`. `read` is always retained.

## Child sessions

Every Pi process resolves the same rules file for itself. A child agent matches
its own model against the rules and then against the tools its host actually
admitted, so a launcher that starts a child with a native-only `--tools`
allowlist (for example a role restricted to Pi's built-in tools) leaves that child on
its native tools: no owned execution name is admitted, no native tool is
hidden, and the missing route is reported rather than repaired. The parent's
own rules are unaffected, and a rule requesting Code or Shell does not make the
child's excluded names usable.

After every committed synchronization the extension publishes one record on the
shared extension event bus, channel `pi-codex-toolkit.execution-diagnostics`,
schema `version: 1`. It carries the resolved `model`, `source`, `ruleId`,
`requested` and `effective` capabilities, the `admittedNames`, `visibleNames`,
`nestedNames` and `hiddenNatives` name lists, the admission `notes`,
`approvalTransport`, `cleanupPending`, the `configRevision` and the packed
`toolkit` name and version — names, flags and a revision only, never an
environment, a command, a patch or program text. A record is also published
when an apply is rejected, with `cleanupPending: true` and the retained
committed routes; a superseded synchronization publishes nothing. `/pct status`
reports the rule, requested and effective routes and the notes in text.

Nested Apply Patch approval needs a dialog-capable context. An interactive or
RPC session shows the confirmation; a headless child (`--mode json -p`) reports
`approvalTransport: "unavailable"` and fails that one nested call with
`approval-unavailable` before any mutation, while pure computation and Shell
calls in the same cell still run. The saved approval mode is never changed
automatically, and no other route retries the refused mutation.

### Web Search

`sidecarModel` is either `null` or:

```json
{
  "provider": "openai-codex",
  "model": "<Pi model id>",
  "thinkingLevel": "auto"
}
```

`provider` may be `openai-codex` OAuth or the retained `openai` API-key route. `/pct config` lists candidates from Pi's model registry whose provider/API/official endpoint and credential kind pass structural validation, and the user explicitly chooses one. When Pi has a non-empty scoped-model list, that scope filters these candidates. After model selection, a second menu offers `auto` plus only the thinking levels Pi reports for that Codex model. `auto` leaves the provider default unchanged; the executor setting never inherits the main model's thinking level. An older object without `thinkingLevel` is read as `auto`. The API-key route supports only `auto` in current source.

The toolkit does not guess the “latest” or “cheapest” executor, store its credentials, or maintain a model-ID allowlist.

`sidecarModel: null` means no Sidecar executor is configured. It does not
follow the main model. Backend `auto` can still choose Native for a supported
main model; otherwise Sidecar needs an explicit executor. The default Codex
catalog no longer includes `gpt-5.4` or `gpt-5.4-mini`. An explicit executor
missing from the current registry stays unavailable (`missing-sidecar-model`);
re-select through `/pct config`. Custom registries may still expose those IDs.

Backend resolution is fixed:

- `auto`: choose native when the current main model has an official compatible Responses route; otherwise choose sidecar when `sidecarModel` can be authenticated; otherwise unavailable.
- `native`: inject only into the current payload; unavailable when the current route is incompatible.
- `sidecar`: activate only `openai_web_search`; unavailable when the executor is missing, unauthenticated, or has an incompatible route.

A turn has at most one toolkit search path. Model selection recomputes and synchronizes the active state of `openai_web_search` without changing third-party tools. Failure never switches native/sidecar, falls back to another provider, or retries automatically.

`mode` applies to both paths: `cached` maps to `external_web_access: false`, while `live` permits external access. `contextSize` maps to `search_context_size`.

Sidecar does not automatically attach Pi's full main conversation history. It sends the main-model-generated query verbatim to the selected executor, and that query may quote or summarize conversation content. It uses a standalone OpenAI Responses request and returns an answer plus at most 20 stable-deduplicated clickable sources; 20 is a fixed Toolkit output budget, not a hosted-search result-count control. The main model must be able to call ordinary Pi tools.

Pi currently exposes no reliable general flag for ordinary tool-call support. The toolkit therefore does not add a provider/model heuristic or user override for this check: if the Sidecar executor is usable, the ordinary tool is active, and a model that cannot use Pi tools simply cannot invoke it.

Codex OAuth Sidecar uses Pi's public provider with one streamed Responses
request, aggregates completed output items for answer and sources, and never
falls back to a private Search endpoint. Historical OAuth probes and the
unqualified API-key live route are described in
[verification scope](architecture.md#9-protocol-probe-status).

If an ordinary `web_search` tool is active, report a conflict warning without disabling the third-party tool.

### Remote Compaction

`remoteCompaction.enabled` defaults to `false`. Creating a checkpoint requires the official `openai-codex` Responses route, refreshed OAuth, and a usable account claim. Replaying one requires the exact provider, API, model ID, normalized endpoint, account fingerprint, and authentication kind stored with the checkpoint.

When disabled or switched to an incompatible model, use the compaction entry's readable fallback and do not send the opaque checkpoint.

`/pct status` reports only network-free structural state. `active` means the model/provider/API/endpoint/OAuth shape is eligible; refreshed token and account compatibility are checked only when compaction or replay actually runs.

### Image Generation

This does not depend on the main-model provider. It is available when the main model can call ordinary tools and Pi's model registry can resolve a supported official OpenAI/Codex image route and authentication.

Route/auth selection has a fixed order: the current main model's compatible official OpenAI/Codex route → `openai-codex` OAuth → an `openai` API key. `/pct status` shows the selected backend/account kind; there is no additional provider selector.

This selection is independent of `webSearch.sidecarModel`: the Search selector
chooses the Responses text model, while Image Generation always sends the
actual image request to fixed `gpt-image-2` and uses the selected route only as
an authentication carrier.

The selected backend is reported as `codex-oauth`, `api-key`, or `—`. Every invocation refreshes only that selected model through Pi and revalidates its official route before sending the prompt. Credentials are mapped to constants, never a configured URL:

```text
api-key     -> https://api.openai.com/v1/images/generations
codex-oauth -> https://chatgpt.com/backend-api/codex/images/generations
```

The tool sends one `gpt-image-2` JSON request: `quality` and `size` take the supplied value or `auto`, and `background` is always `auto`, since the tool takes no `background` argument. Redirects are not followed, and no failure retries or switches accounts after dispatch.

The decoded original PNG is created exclusively at `<getAgentDir()>/artifacts/pi-codex-toolkit/<uuid>.png`. The result contains the absolute path as text, one raw-base64 Pi `ImageContent`, and path/MIME details only. Pi preserves the image for vision models and uses its normal omission marker for text-only models while retaining the path text.

The API-key endpoint is public OpenAI API behavior. The Codex OAuth endpoint is
pinned to the official Codex `rust-v0.150.1` client and remains source-coupled.
Historical OAuth probes and deterministic-only API-key coverage are summarized
in [verification scope](architecture.md#9-protocol-probe-status); they do not
qualify a new publication.

### Apply Patch

`applyPatch.enabled` defaults to `false`. When enabled, the Toolkit-owned
`apply_patch` name is active for every main model unless another extension owns
that name. Model switches and `/pct reload` only resynchronize the flag and
name ownership; the Toolkit does not maintain a provider or model allowlist.

The tool has exactly one JSON argument, `{ "patch": string }`. Pi sends its
Codex-compatible Lark grammar to models that advertise grammar-tool support and
uses the same definition as an ordinary JSON function for other tool-calling
models. Both transports run the same local executor. The tool description
carries one literal minimal envelope for the JSON transport, which has no
grammar to constrain it:

```text
*** Begin Patch
*** Add File: notes/todo.md
+first line
*** End Patch
```

Showing the example does not relax parsing: the first and last lines are exactly
`*** Begin Patch` and `*** End Patch` with no trailing marker, and a carriage
return anywhere in the envelope is still rejected. Under the legacy enabled flag
Pi's built-in `edit` and `write` remain available and unchanged; an `execution`
rule that routes Patch hides them while that route holds.

The executor supports Add, Update, Delete, Move, multiple files and hunks,
locators, and End of File. It preflights the whole patch, rejects absolute or
traversing paths and every visible symlink component, then stages replacement
content before per-path rename/unlink commits. A predictable preflight failure
changes no target file. Individual replacement renames are atomic, but a Move
or multi-file patch is not a transaction; a later filesystem failure can leave
earlier operations committed and is reported as partial/unknown without retry.

Existing source files, including `Delete File` targets, must be valid UTF-8 text
with consistent LF or CRLF; non-UTF-8, bare CR and mixed line endings are rejected
before mutation. Binary deletion is unsupported.

This is static containment, not a race-proof sandbox. A hostile process that
replaces a validated path component concurrently is outside the current threat
model. This tool is also distinct from the Responses first-class
`type: "apply_patch"` / `apply_patch_call` protocol, which is not implemented.

## Computer Use

Computer Use has an enable switch and one approval mode:

```json
{
  "computerUse": {
    "enabled": false,
    "approvalMode": "confirm"
  }
}
```

`/pct config` labels the two approval choices exactly `Confirm` and `Always`:

- `Confirm` is the default. The first valid request for an app opens Pi's
  `Computer Use access` confirmation. Yes remembers that canonical app in the
  current client's memory; No declines only the current call, so the same app
  asks again next time.
- `Always` automatically accepts every valid Computer Use elicitation without
  opening the Toolkit confirmation. The saved setting applies in later Pi
  sessions too.

Both modes retain the existing strict active-thread, `node_repl`, form-mode,
`computer-use` connector, and canonical app checks. Foreign, malformed, or
missing/blank-app elicitations are still declined. `Always` bypasses only the
Toolkit confirmation; it does not grant or bypass macOS Screen Recording,
Accessibility, or other operating-system permissions.

The Toolkit keeps only a client-local in-memory Set of accepted canonical app
identifiers; it has no file/database/global allowlist and never caches denials.
In `Confirm`, approval survives ordinary turns, compaction, an unchanged
`/pct reload`, and eligible model switches while the current client is reused.
It resets on `/new`, `/resume`, `/fork`, Pi's global `/reload`, restart or quit,
disabling Computer Use, changing approval mode, losing eligibility, or a
tool-name conflict. Switching back from `Always` to `Confirm` therefore asks
again.

The historical read-only Computer Use and `Confirm` / `Always` probes are
summarized in [verification scope](architecture.md#9-protocol-probe-status).
They did not perform desktop actions or change macOS permissions.

There is no backend, executable, timeout, installer, or fallback setting.

Normal session startup performs only cheap local checks and does not start
app-server. When the user explicitly invokes `/pct status`, Computer Use may
start a dedicated probe client, verify only `sky.target === "mac"`, and close
the client. It never lists apps, reads app state, or performs an action during
status.

The Computer Use MVP requires:

```text
configured
&& macOS
&& interactive UI
&& current model supports image input
&& paired ChatGPT.app bundled components exist
&& the installed Computer Use helper exists
&& injected node_repl starts with js
&& @oai/sky reports target mac
```

The paired components are fixed under
`/Applications/ChatGPT.app/Contents/Resources`: `codex`,
`cua_node/bin/node_repl`, `cua_node/bin/node`, and
`cua_node/lib/node_modules`. The helper is fixed at
`<real CODEX_HOME>/computer-use/Codex Computer Use.app`. The toolkit does not
search PATH, scan plugin caches, install or repair components, or alter global
Codex configuration.

Every call goes through the ChatGPT-bundled app-server, one isolated ephemeral
thread, `node_repl/js`, predefined JavaScript, and trusted
`@oai/sky/service`. There is no fallback to the legacy direct
`mcp_servers.computer-use` path. `cua_repl` is only a possible future
replacement for this narrow runtime and is not implemented or configurable.

The six tool names are `computer_use_list_apps`,
`computer_use_get_app_state`, `computer_use_click`,
`computer_use_type_text`, `computer_use_press_key`, and
`computer_use_scroll`. They activate as one group. A conflict on any name
disables the Toolkit-owned group without changing the conflicting third-party
tool or unrelated active tools.

Tools that target an app accept its display name, full `.app` bundle path, or
unambiguous bundle identifier. Prefer an identifier returned by
`computer_use_list_apps`, especially when a target is unknown or cannot be
resolved. A PID, window ID, or bare Mach-O executable path is not a supported
target. Explicit coordinates select a location only after the app is resolved;
they do not bypass app resolution.

If the target is absent from `computer_use_list_apps`, its owning project must
provide a real `.app` for the window-owning executable, with a stable bundle
identifier. The Toolkit does not create app wrappers or fall back to PID,
window, foreground, or HID control.

## Shell Sessions

Shell Sessions has one enable switch and is default-off:

```json
{
  "shellSessions": {
    "enabled": false
  }
}
```

It does not depend on Code Mode, a provider route, or the current model. Any
ordinary tool-calling model can use it. When enabled and unconflicted, exactly
two Toolkit-owned tools activate as one atomic group:

- `exec_command` starts one command and returns its output so far plus a
  session handle when it is still running. `running` with stdout or stderr is
  not completion: poll or stop with `write_stdin`, never Code Mode `wait`.
- `write_stdin` polls the same process, writes stdin, closes stdin, or
  requests termination.

Both tools accept the Codex spellings beside the existing field names, and one
pair is always one field: `cmd`/`command`, `workdir`/`cwd`,
`session_id`/`sessionId`, `chars`/`input`, `yield_time_ms`/`yieldTimeMs`. Send
one spelling, or the same value in both; different values are rejected before
anything runs. Results add `session_id` and `exit_code` beside the existing
`sessionId`/`exitCode`. The nested Code Mode forms `tools.exec_command(...)`
and `tools.write_stdin(...)` take exactly the same fields. Unsupported Codex
request fields (`tty`, `shell`, `login`, `sandbox_permissions`,
`justification`, `with_escalated_permissions`, `prefix_rule`, `timeout_ms`) are
rejected by name rather than silently ignored, and a numeric handle is rejected
rather than coerced.

A conflict on either owned name disables both Toolkit names and preserves the
winning third-party registration, following the Computer Use group rule.
Unrelated tool names are never changed. Under legacy enabled flags the native
`bash` tool is not changed either; under `execution` rules an active direct
Shell or Code route hides the admitted builtin `bash` while it is committed and
restores it when the route ends. Disabling the
feature requests cleanup; incomplete cleanup retains actual ownership, not a
promise all work vanished. Model switches and unchanged `/pct reload` preserve
sessions. See [execution lifetime](#execution-output-recovery-and-session-lifetime)
for switch/fork veto, file retention and non-cancellable teardown limits.

Execution details:

- The command runs exactly once through Pi's public `getShellConfig()` resolved
  shell. `write_stdin` never relaunches it, and no saved command is replayed
  after a restart or resume. When the resolved shell uses stdin command
  transport, the command consumes and closes stdin, so interactive input is not
  available on that session.
- stdin, stdout, and stderr are pipes, not a TTY. Line-oriented interactive
  programs work; full-screen or TTY-only programs are unsupported and no TTY
  semantics are claimed.
- `yieldTimeMs` (`0..60000`, default `10000`) bounds how long a call waits for
  new output or settlement, not execution duration or an end-to-end deadline.
  Spawn establishment and capture I/O can add time even at zero yield. `maxOutputBytes`
  (`1024..262144`, default `51200`) bounds newly returned output as one combined
  stdout+stderr budget, drained stdout first; it is clipped at a UTF-8 code-point
  boundary, so partial lines are possible.
- `max_output_tokens` (`256..65536`) is the token spelling of that budget. It is
  a documented conservative proxy of **four bytes per token**, bounded by the
  existing byte cap, not provider tokenization. It is a different unit from
  `maxOutputBytes`, so supplying both keeps both limits and the smaller payload
  ceiling wins. Omitting both keeps the `51200`-byte default.
- `write_stdin.input` is forwarded verbatim: no newline is appended and stdin
  is never closed implicitly. `closeStdin` ends the pipe after writing so
  EOF-driven programs can finish. Omitted or empty input only polls. On a
  stdin-transport session, non-empty input is rejected with a `stdin-transport`
  error.
- Stdin admission is **262,144 UTF-8 bytes / 16 outstanding input calls per
  session** until transport and request settlement. Overload, input after EOF/
  broken pipe, and nonempty input plus stop reject before sending. Repeated EOF
  is harmless. EPIPE/write/end errors explicitly report unknown delivery.
  `inputDelivery: written | unknown` is a transport result, not application
  acknowledgement. Pre-abort sends nothing; after submission never auto-resend.
- At most 16 jobs are unsettled. Unread terminal handles are pruned lazily at
  five minutes or above 32; one terminal observer releases the handle and other
  queued observers get `stale-session`. This is separate from file retention.
  Ordinary same-group descendants and inherited streams remain owned after the
  leader exits, including redirected-output children; escaped groups are excluded.
- Stop bypasses quiet observation queues, sends POSIX group `SIGTERM`, escalates
  after 5 seconds to `SIGKILL`, and has a 5-second confirmation window rather
  than inheriting a long poll. `terminated` with `unknownOutcome` keeps its
  handle for polling/stop retry; `cleanup-incomplete` can reject close.
  Windows `taskkill /PID <pid> /T /F` has a finite timeout, but Windows behavior
  is not runtime-qualified. No PTY or restart reattachment is provided.
- Cancelling a direct `exec_command` or `write_stdin` call stops the job. A
  Code Mode cell's failure, stop or close ends its nested `write_stdin` calls
  but not the shell they poll: it keeps running, and its unread output and final
  result stay for the next reader.
- Shell commands run with the user's existing local process authority; this is
  not a new sandbox.

Status reasons are `conflicting-tool-name` and `shell-unavailable`. The
`shell-unavailable` reason means no usable local shell could be resolved; only
Shell Sessions is affected.

Finite commands can complete in one call; enabled availability does not require
polling or restrict Shell to Code/Fusion roles. Environment is inherited from
the Pi process. An embedder can additionally supply a trusted per-call overlay
through the [invocation hooks](#invocation-hooks); it is merged over the
inherited environment for that one spawn, is never a model argument, and never
mutates `process.env` or another session. No new quota, timeout, environment or
profile configuration was added.

See [verification scope](architecture.md#9-protocol-probe-status) for the
September 13, 2026 offline host checks and the separate September 10 live
reports, including Grok's newline failures and untested OpenAI route.

## Code Mode

Code Mode is a separate default-off switch. It does not depend on the current
model or provider:

```json
{
  "codeMode": {
    "enabled": false,
    "approvalMode": "confirm"
  }
}
```

When enabled and unconflicted, exactly two Toolkit-owned tools activate as one
atomic group:

- `exec` runs one short trusted JavaScript program with top-level await and the
  current user's authority in a separate worker with fresh per-call state, not
  a security sandbox. Run only trusted code. It returns selected output plus a
  bounded result; the program runs once and is never replayed.
- `wait` continues a yielded cell by `cell_id` (also spelled `cellId`), returns
  only new output, and can terminate the cell.

Call dialect:

- `exec` carries the pinned upstream Codex freeform grammar as its
  `constrainedSampling` variant, so a provider with grammar tools sends **raw
  JavaScript source** and Pi decodes it into the tool's `code` property. A
  provider without grammar support sends the same program as ordinary JSON;
  both paths reach the same executor and the same validation.
- The program may begin with one first-line pragma, for example
  `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`. Only those
  two options are accepted; an unknown key, malformed JSON, or a value that
  disagrees with the matching call argument is rejected before the worker
  starts. The pragma line is replaced by an empty line, so reported source line
  numbers do not shift.
- `wait` accepts `cell_id`/`cellId`, `yield_time_ms`/`yieldTimeMs`,
  `terminate`, and the output budget as `max_tokens` (the Codex name),
  `max_output_tokens`, or the byte-unit `maxOutputBytes`. Handles are opaque
  strings: a number, an OS PID, or a `pct-shell-` session id is rejected, never
  coerced.
- Rendered results lead with `cell_id`, a running cell keeps the upstream
  `Script running with cell ID <id>.` phrase, and shell results carry
  `session_id` and `exit_code` beside the existing fields.
- Nested calls take both spellings of every field, and
  `tools.apply_patch("*** Begin Patch … *** End Patch")` accepts the envelope
  string as well as `{patch: "…"}`.

Composition contract:

- `exec.uses` lists the exact adapted tools the program may call through
  `tools.<name>(args)`. **Omitting `uses` declares every adapter admitted when
  the cell starts**; only an explicit `[]` declares none. Either way that
  snapshot is also the cell's ceiling: a later configuration or model change
  never enlarges a running cell, while a contraction still applies when the
  nested call dispatches. Calling an undeclared adapter fails inside the cell.
  This is supported adapter dispatch and validation, not containment of hostile
  JavaScript or a restriction on ambient host authority.
- Adapted tools are `exec_command`, `write_stdin`, and the Toolkit
  `apply_patch`. Only explicitly adapted tools are callable through this API;
  every other Pi or MCP tool remains an ordinary call.
- `exec_command` / `write_stdin` reuse the single Shell Sessions executor, so
  nested shell calls obey the same session, ordering, output, and termination
  contracts. They require Shell Sessions to be enabled and unconflicted; there
  is no second process backend.
- `apply_patch` reuses the Toolkit Apply Patch definition, including TypeBox
  argument validation, path containment, Pi's file mutation queues, and
  truthful partial-commit reporting. It requires Apply Patch to be enabled and
  the Toolkit to still own the winning `apply_patch` name when the call is
  dispatched.
- Validate actual schemas before approval, then recheck live config, abort and
  visible foreign ownership (including either shell sibling) after queue/approval
  waits. A hidden or deferred direct name does not remove nested authority; a
  name this host filtered out of the projection is not admitted at all, so its
  route — and its nested adapter — is unavailable. `exec` has complete inline
  callable help even without discovery. Pi fixes a tool description at
  registration and offers no supported way to update a registered one, so that
  help lists the adapters this build **can** expose, marks nested
  `apply_patch` as admitted only while the rule routes Patch through Code, and
  points at `/pct status` for the admitted set of the current model; a
  non-admitted adapter fails that one call at dispatch.
- Four concurrent adapter slots plus sequential Patch ordering are separate
  from **16 outstanding requests / 256 KiB aggregate arguments per cell**.
  Single serialized argument/reply/error and queued normal reply bytes are each
  bounded by 256 KiB; bounded control errors have a separate allowance. Count
  limits tiny requests, bytes limit payloads; ACK releases transport reservation,
  not effect responsibility. These are safety defaults, not tunable settings.
- Completion waits for tracked transitive calls/reactions, including calls
  introduced while serializing the selected value once. Caught errors preserve
  JS semantics. On failure, terminate or close, fence unsent work, cancel queue/
  approval waiters and cooperatively abort unsettled dispatches. Report effects
  and unknown outcomes without rollback/replay; worker exit does not settle host
  effects.
- Independent `shells` continuation metadata survives omitted/clipped/error JS
  returns. A yielded shell stays Shell-owned: use `write_stdin`, directly if
  exposed or through a new `exec` declaring it; `wait` controls a cell, not a shell.
  A cell's failure, stop or close ends its nested polls without stopping these
  shells.

Runtime and lifecycle:

- Each cell is one `worker_threads` worker with a fresh `vm` context. The
  supported cell API exposes `tools.<declared>`, `print(...)`,
  `console.log/warn/error`, and `text(value)`, which appends a string literally
  (no added newline) and stringifies a non-string with `JSON.stringify` when
  that is possible. There is no `store`, `load`, `notify`, `yield_control`,
  `ALL_TOOLS`, `image`, `audio`, `exit`, timer, import, or persistent state; it
  does not supply ambient `process`, `require`, `fetch`, or dynamic `import()`. Variables, imports and functions are not
  retained between cells; host-side effects are not isolated. Neither the
  worker nor `vm` is a security boundary. Worker termination supports CPU-bound
  cancellation, not forced termination of all host effects. The 64/8-MiB V8
  generation limits do not bound total heap/RSS or external allocations.
  Whole-value formatting/serialization and arbitrary worker allocations are
  not covered by transport/heap guarantees.
- `yieldTimeMs` (`0..60000`, default `10000`) bounds how long `exec` / `wait`
  waits. A program that has not settled returns an opaque `cell_id` for `wait`.
  `maxOutputBytes` (`1024..262144`, default `51200`) bounds output delivered by
  one read; `max_output_tokens` / `max_tokens` (`256..65536`) is the same
  ceiling expressed as a conservative four-bytes-per-token proxy, bounded by
  that byte cap and never provider tokenization. Supplying both keeps both
  limits, and the smaller one wins. Buffered output is capped at 256 KiB per cell, results at 32 KiB,
  errors at 4 KiB. A cell interrupted while reporting its own error shows the
  head of that error, then why the cell stopped (the worker error or stop
  reason, at most 1 KiB); the error recovery file keeps the reported text once,
  followed by that reason. Four cells may run; 16 unread terminal results have
  lazy five-minute pruning. Observations are serialized: one terminal winner
  releases its handle; queued losers are stale. Unconfirmed stop wakes long polls
  and retains the handle for another stop attempt; unsettled effects remain owned.
  A stop, abort or close that arrives after the program has finished returns the
  program's result instead, and a program that finishes after an unconfirmed
  stop reports its result without that stop's uncertainty. A worker that does
  not exit after its program has finished, for example because a callback the
  program scheduled keeps it busy, is terminated after a short grace.
- Emitted text is literal; selected structured values remain structured in
  details. Compact final rendering is independently capped at **331,776 bytes**,
  with status, uncertainty, shell controls and recovery ahead of payload.
  `truncated`/`dropped` and `clipping.{output,result,error}` are preview facts,
  not proof recovery is incomplete. Producer credit is returned only after
  capture append; see [bounds and recovery](architecture.md#59-execution-output-recovery).

Permission boundary:

- Pi's native `tool_call` / `tool_result` hooks see only the outer `exec` /
  `wait` call. That outer call's `input` contains the full program `code` and
  the `uses` declaration, so a hook or permission extension can inspect or
  block at cell granularity.
- Nested calls do not emit `tool_call` / `tool_result`, and third-party
  permission interceptors that gate per-tool-call behavior do not see them.
  Treat `code` and `uses` as the reviewable surface.
- The outer call does forward bounded **progress records** through Pi's
  ordinary partial-result callback: a nested call's start, a wait for
  approval, and its end with `ok` or an error code. Each record carries the
  adapter name, the `cell_id`, and a `session_id` when one is known — never
  command, patch, program, or argument text — and the count per call is
  capped. They are updates on the outer call, not fabricated nested events.
- `approvalMode` is `confirm` (default) or `always`. Under `confirm`, the
  Toolkit asks through Pi UI **only for nested `apply_patch`**, and it asks
  when that call actually dispatches. A headless `confirm` cell that merely
  declares Patch still runs and completes; only an actual nested `apply_patch`
  fails, with `approval-unavailable`, before any mutation. A computed
  `tools[name]` call takes the same path. Invalid nested arguments never
  trigger confirmation; denial/cancellation sends nothing. Shell commands also
  mutate files but keep direct-shell authority and the outer gate. `always`
  skips only the extra Patch confirmation, not validation or live authority,
  and the saved mode is never switched automatically. This is not a general
  nested mutation-permission system.

Disabling Code Mode requests cell cleanup without killing already-yielded
independent Shell sessions. Files outlive handles and disablement; incomplete
cleanup retains ownership. See the shared lifetime section below.

See [verification scope](architecture.md#9-protocol-probe-status) for dated
worker/adapter tests, offline host qualification and historical live comparisons.
The live runs were not rerun on repaired code and showed mixed benefit; Code
Mode stays optional and default-off, with no universal or per-provider saving
promised.

## Invocation hooks

No setting enables this. It is a code-level integration seam for an embedder
that loads the Toolkit itself, and the Toolkit ships **no built-in caller**:
the default extension export Pi loads installs no hooks at all.

The package has **no root export**: Pi loads it through the `pi.extensions`
manifest entry (`./src/index.ts`), so an embedder imports that subpath
explicitly. `import … from "pi-codex-toolkit"` does not resolve.

```ts
import { fileURLToPath } from "node:url";

import { createPiCodexToolkit } from "pi-codex-toolkit/src/index.ts";

export default createPiCodexToolkit({
  invocationHooks: {
    // Trusted per-call environment for this one invocation.
    context: (call) => ({ env: { MY_CONTEXT_ID: idFor(call) } }),
    // Applicable policy for this one invocation.
    policy: (call) =>
      call.tool === "apply_patch" && call.path === "nested"
        ? { allow: false, reason: "patches are reviewed elsewhere" }
        : { allow: true },
  },
  // Optional. Pi attributes every tool this factory registers to the
  // extension file it loaded — this one — and the Toolkit resolves that
  // identity from the host's own projection. Pin it when you would rather
  // state it than have it detected, or when none of this factory's
  // registrations reaches the host's projection.
  sourcePath: fileURLToPath(import.meta.url),
});
```

- `sourcePath` is the extension identity used for every ownership comparison:
  which `apply_patch` / `exec_command` / `exec` winner is this extension's, so
  which routes may activate and which builtin it may hide. Omitted, the
  factory reads it from the registrations Pi reports back — only registrations
  it can prove are its own decide it, so neither a third-party winner nor a
  second Toolkit factory in the same process can. When it can prove none of
  them — every owned name filtered out by a `--tools` allowlist, or another
  extension winning them all — the identity stays **unresolved and this
  factory owns nothing**: its execution routes report themselves unavailable,
  it hides no builtin, and it claims no registration. Nothing is cached in
  that state, so the identity resolves as soon as one of its own registrations
  is visible again; pin `sourcePath` when you want the identity fixed even
  then. It is an identity, never a permission: it cannot make a foreign tool
  callable. It is also how the record of hidden builtins is kept apart: that
  record is per identity and per session lineage, an unresolved factory writes
  none, and two factories pinning one `sourcePath` deliberately share one —
  the later one recaptures that shared record when its own session starts, so
  do not pin one identity onto two factories that run at the same time.
- `call` is `{ tool: "exec_command" | "write_stdin" | "apply_patch", path:
  "direct" | "nested", cwd, cellId?, sessionId? }`: control identity only, never
  the command, patch, or program text.
- Both hooks apply **identically** to the direct tools and the nested Code Mode
  adapters, after normalization and admission, and before any Code Mode
  approval and the executor. A denial rejects with the hook's reason and starts
  nothing — a denied nested `apply_patch` never opens the confirmation dialog —
  and a hook may be synchronous or asynchronous.
- An asynchronous hook can outlive the admission that let the call in, so both
  paths recheck it when the hook returns, before any effect: a capability
  disabled meanwhile refuses the call, and a direct Shell call whose session
  was replaced refuses rather than dispatching onto the replacement session's
  manager.
- `context().env` is merged over the manager's captured environment for that
  one spawn. It never mutates the manager's environment or `process.env`, never
  leaks into the next call, and never reaches another session. A malformed
  overlay is rejected before the spawn.
- The seam is deliberately generic. It derives nothing from any particular
  orchestrator, reads no environment variable of its own, and creates no Pi
  `tool_call` / `tool_result` event for a nested call. A supplied environment
  still reaches child processes exactly as an inherited one does; the Toolkit
  does not generate an orchestrator's task markers.
- A future Toolkit permission engine integrates through this same seam rather
  than gating only the direct tools.

## Execution-output recovery and session lifetime

No setting enables a second executor or archive. Shell/Code share a session
output owner: private OS-temp UUID files are created exclusively/lazily, only
when a yield, spill or terminal preview loss requires them. Separate cumulative
stdout/stderr or emitted-text/serialized-selected-result/error capture precedes
destructive preview limits; early prefixes survive prior polls. Small fully
returned terminal results need no file. This is decoded/selected text recovery,
not binary fidelity, all intermediate JS values, or extra source/argument/env/
prompt capture. Nothing is uploaded; output may itself contain secrets.

Recovery includes `state: capturing | complete | partial | unavailable`, optional
`path`, `bytes`, `capturedBytes` and optional `reason: io-error | io-timeout |
overload | source-error | missing | owner-closed`. Offered bytes differ from
confirmed writes. Snapshots report capture, not execution success or a final
outcome receipt. An old `capturing` result cannot certify later completeness.
Capture errors preserve the bounded preview and true execution outcome.

Read returned absolute paths with an available native `read` in line ranges or
an authorized shell in explicit ranges. No handle lookup/recall tool is added.
Files remain after terminal-once delivery, handle pruning and feature disable/
conflict. Partial/unavailable/missing paths mean incomplete evidence; never rerun
side effects or resend unknown stdin to reconstruct it. There is **no aggregate
(or per-job) disk quota, file TTL or restart guarantee**; long sessions can grow
disk use. Five-minute pruning applies to handles, not files. See
[architecture §5.9](architecture.md#59-execution-output-recovery) for exact
capture/credit bounds and late I/O/identity-safe cleanup.

- Model changes and unchanged Toolkit `/pct reload` preserve execution/files.
- Attempting new/resume switch or fork/clone through public cancellable preflight
  first requests Shell and Code cleanup. Incomplete cleanup vetoes replacement
  and retains actual ownership/files for control/cleanup retry. Other extensions
  can cancel later; work may already be stopped even when the action is
  cancelled. There is no rollback. Successful preflight alone never deletes files.
- Actual `session_shutdown` is file expiry; close the owner after producer cleanup
  and remove only owned files. This also applies to Pi resource `/reload` even
  if conversation identity is preserved. `/pct reload` is not resource `/reload`.
- Quit/resource reload/emergency teardown are not cancellable here. Failure may
  leave work/files, and a thrown shutdown error does not guarantee old handles
  after factory replacement. Escaped descendants, hung I/O and abrupt death
  preclude an unconditional cleanup promise. No replay or restart attachment.

## Tool Discovery

Tool Discovery is an independent default-off switch. It does not depend on the
current model, provider, or Code Mode:

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

`deferred` is the explicit managed set. It may contain only Toolkit-owned tool
names (`openai_web_search`, `openai_generate_image`, `apply_patch`, the two
Shell Sessions names, the two Code Mode names, and the six Computer Use names);
unknown, foreign, and `find_tools` names fail validation and leave the
last-known-good configuration in effect. Editing the list is a file-level step;
`/pct config` only toggles discovery itself. The Computer Use group is atomic:
the list must contain all six names or none.

When discovery is enabled and unconflicted, the Toolkit registers and activates
one ordinary tool, `find_tools`:

- `query` searches the managed set's names and descriptions and returns at most
  eight matches with a one-line summary and each match's state (`active`,
  `eligible`, or `unavailable: <reason>`).
- `load` takes exact managed names and adds eligible ones for the next model
  turn. Loading is additive and idempotent: it never removes unrelated active
  tools and never replays a call. Requesting one member of an atomic group
  validates and loads the whole group; if any member is ineligible the group is
  rejected as a whole. The Shell Sessions and Code Mode pairs are jointly
  checked rather than expanded: loading either member requires the sibling to
  be eligible too, and a conflicted or absent sibling rejects the request, but
  only the requested name is activated.
- At least one of `query` or `load` is required. Ineligible or unmanaged names
  are returned in `rejected` with a reason instead of failing the whole call;
  malformed arguments and a disabled `find_tools` throw before dispatch.
- Loading does not execute a tool and does not grant permission. Pi's normal
  next-turn dispatch still validates arguments and applies each tool's own
  enablement, ownership, approval, and error contract.

Eligibility is rechecked on every call and during synchronization. A name is
eligible only when:

- the visible `getAllTools()` winner for the name is this extension's
  registration (a foreign winner, or an absent name such as one removed by a Pi
  `--tools` allowlist, is unavailable),
- its feature configuration is enabled, and
- for decision-gated tools, the same runtime decision used by synchronization
  reports the feature active for the current model/session.

Stable discovery reasons include `disabled` (feature off), `not-registered`
(absent from the visible projection), `not-managed` (the requested name is not
in the managed deferred set), `conflicting-tool-name` (foreign winner),
`native-backend` (Web Search uses the native path, so the Sidecar tool is not
part of the projection), and the existing feature reasons such as
`unsupported-platform`, `no-interactive-ui`, `current-model-missing`,
`missing-openai-auth`, or `missing-sidecar-model`. Every member of a rejected
atomic group carries the group's own reason: `group incomplete: <name> is not
managed` when a member is outside the managed set, and
`group blocked by <member>: <reason>` when one member is ineligible.

Lifecycle:

- Deferred names are hidden from the ordinary projection until `find_tools`
  loads them in the current session. Loaded names stay exposed across an
  unchanged `/pct reload` and ordinary model changes.
- A new, resumed, or forked session starts with deferred names hidden again.
  Nothing about a load is persisted or replayed.
- Disabling discovery, or a `find_tools` conflict, removes `find_tools` and
  restores the ordinary owned projection. Disabling discovery also forgets the
  session's loads, so re-enabling starts hidden again.
- A feature conflict or feature disablement removes only the affected name and
  preserves unrelated tools.
- Discovery manages only Toolkit-owned tools. A third-party tool becomes
  discoverable only through explicit participation with an identifiable
  source/activation contract. The Toolkit never guesses, rewrites, or
  deactivates another extension's tool, and never treats a user-disabled or
  allowlist-filtered name as loadable.

Enable discovery only where the managed set removes schemas that would
otherwise be active and the task tolerates an extra discovery round. Dated
fixtures and the September 10, 2026 live comparison are summarized in
[verification scope](architecture.md#9-protocol-probe-status); those measurements
are not current schema sizes or a universal token, latency or selection saving.

## Debug

`debug: true` writes metadata only to stderr:

- Feature, provider/API/model.
- Endpoint host.
- Duration, status, and request ID.
- Content-block types and counts.
- Error category without payload.

It never writes headers, tokens, prompts, tool arguments/results, screenshots, base64, opaque checkpoints, or compaction fallbacks. There is no log file, levels, rotation, or generic redactor.

## Conflicts

- Do not enable another Remote Compaction extension at the same time; multiple `session_before_compact` handlers can issue duplicate remote requests.
- Do not enable this project's Computer Use alongside `pi-codex-computer-use`; tool-name resolution may depend on load order.
- A winning third-party `apply_patch` registration is reported as
  `conflicting-tool-name`; the Toolkit does not replace or deactivate it.
- `pi-web-access` can coexist but is no longer a dependency. When its ordinary `web_search` and either toolkit Web Search backend are both enabled, `/pct status` reports duplicate search paths; the toolkit does not disable it.
- The Toolkit does not proactively discover, disable, or rewrite other extensions.
- Another extension that owns `find_tools`, or a Pi `--tools` allowlist that omits it, is reported as `conflicting-tool-name`; Tool Discovery stays inactive and the ordinary owned projection of deferred Toolkit names is restored. The Toolkit does not rewrite or deactivate a foreign winner.
- A winning third-party `exec_command` or `write_stdin` registration disables
  both Toolkit shell names; the Toolkit never replaces the third-party tool.
- A winning third-party `exec` or `wait` registration disables both Toolkit
  Code Mode names; the Toolkit never replaces the third-party tool.
- Under execution rules, a Patch/Shell/Code row reports `conflicting-tool-name`
  only for a **visible foreign winner**. A name the host filtered out of the
  projection (a `--tools` allowlist or a restricted agent role) is absent, not a
  conflict: that route was never admitted, so the row reports its admission note
  (`patch-unavailable`, `shell-pair-unavailable`, `code-pair-unavailable`,
  `code-shell-pair-unavailable`, `code-unavailable-did-not-promote-patch`,
  `patch-unavailable-kept-native-editing`) and the appended `Execution rules:`
  block agrees with it. Legacy flag-managed rows keep reporting either case as
  `conflicting-tool-name`.
