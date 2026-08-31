# Pi Codex Toolkit Configuration

> Status: first-release configuration contract paired with `architecture.md`

## Configuration file

The first release has one global file:

```text
<getAgentDir()>/extensions/pi-codex-toolkit.json
```

Under Pi's default agent directory, this is usually:

```text
~/.pi/agent/extensions/pi-codex-toolkit.json
```

When `PI_CODING_AGENT_DIR` is set, use Pi's resolved agent directory rather than a hard-coded home path.

There are no project overrides, environment overrides, CLI flags, file watchers, or layered inheritance. Secrets never enter this file.

## First-release schema

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

Every implemented capability is off by default. This is not because the
features are inherently unsafe; they create additional network requests, cost,
session-format changes, local file mutations, or desktop actions and should be
enabled explicitly.

Do not reserve fields for endpoints, model allowlists, timeouts, retries, headers, provider routers, or fallback order in the first schema. `sidecarModel` selects the single model that actually executes standalone search requests; it is not a main-model allowlist.

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
- Apply Patch on/off.
- Computer Use on/off.
- Computer Use approval: `Confirm` or `Always`.
- Debug metadata on/off.

Do not build a custom Settings page, tabs, search, or scope inheritance.

After saving, update the in-memory configuration immediately and synchronize only toolkit-owned tools. Without an interactive UI, print the configuration path and do not wait for input.

### `/pct status`

Show the current model/provider/API, configuration path, and for every implemented capability:

```text
configured: on | off
effective: active | unavailable | off
reason: short reason or empty
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

`effective backend: native` means only that the current route passes structural eligibility and will receive hosted-tool injection; it does not guarantee that the service supports the current model/reasoning/input combination. Sidecar status must state that it is a separate OpenAI request with additional cost and latency.

Typical reasons include:

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

Reload only `pi-codex-toolkit.json`, update memory, and synchronize toolkit tools. Do not call Pi's global `ctx.reload()`.

Run this command after manually editing the file. The first release has no watcher.

## Read/write semantics

- Write a temporary file in the same directory and rename it, avoiding partially written JSON.
- Never overwrite an invalid source file.
- If a running process has a last-known-good value, keep it and report the error in status.
- On a cold-start read failure, use the all-off defaults.
- Ignore unknown keys at runtime but preserve them verbatim across `/pct config` saves, including unknown keys nested inside known objects.
- Do not add a cross-process lock; the last writer wins when multiple Pi processes save concurrently.
- `/pct config` is persistent authority; Pi `/tools` changes are temporary for the current model phase.

## Eligibility

### Web Search

`sidecarModel` is either `null` or:

```json
{
  "provider": "openai-codex",
  "model": "<Pi model id>",
  "thinkingLevel": "auto"
}
```

`provider` may be `openai-codex` OAuth or the retained `openai` API-key route. `/pct config` lists candidates from Pi's model registry whose provider/API/official endpoint and credential kind pass structural validation, and the user explicitly chooses one. When Pi has a non-empty scoped-model list, that scope filters these candidates. After model selection, a second menu offers `auto` plus only the thinking levels Pi reports for that Codex model. `auto` leaves the provider default unchanged; the executor setting never inherits the main model's thinking level. An older object without `thinkingLevel` is read as `auto`. The API-key route supports only `auto` in this release.

The toolkit does not guess the “latest” or “cheapest” executor, store its credentials, or maintain a model-ID allowlist.

Backend resolution is fixed:

- `auto`: choose native when the current main model has an official compatible Responses route; otherwise choose sidecar when `sidecarModel` can be authenticated; otherwise unavailable.
- `native`: inject only into the current payload; unavailable when the current route is incompatible.
- `sidecar`: activate only `openai_web_search`; unavailable when the executor is missing, unauthenticated, or has an incompatible route.

A turn has at most one toolkit search path. Model selection recomputes and synchronizes the active state of `openai_web_search` without changing third-party tools. Failure never switches native/sidecar, falls back to another provider, or retries automatically.

`mode` applies to both paths: `cached` maps to `external_web_access: false`, while `live` permits external access. `contextSize` maps to `search_context_size`.

Sidecar does not automatically attach Pi's full main conversation history. It sends the main-model-generated query verbatim to the selected executor, and that query may quote or summarize conversation content. It uses a standalone OpenAI Responses request and returns an answer plus at most 20 stable-deduplicated clickable sources; 20 is a fixed Toolkit output budget, not a hosted-search result-count control. The main model must be able to call ordinary Pi tools.

Pi currently exposes no reliable general flag for ordinary tool-call support. The toolkit therefore does not add a provider/model heuristic or user override for this check: if the Sidecar executor is usable, the ordinary tool is active, and a model that cannot use Pi tools simply cannot invoke it.

Codex OAuth is the live-verified Sidecar protocol baseline. It uses Pi's public
provider with one streamed Responses request, aggregates completed output
items for answer and sources, and never falls back to a private Search
endpoint. A real Pi 0.84.4 Grok-main RPC gate passed with an explicitly selected
Codex executor and `low` effort, one Search dispatch, and no native hosted
Search tool on the Grok request. The retained API-key route has deterministic
coverage, while its live call remains pending because no eligible local
`openai` provider/model is configured.

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

The tool sends one `gpt-image-2` JSON request with `background`, `quality`, and `size` set to the supplied value or `auto`. Redirects are not followed, and no failure retries or switches accounts after dispatch.

The decoded original PNG is created exclusively at `<getAgentDir()>/artifacts/pi-codex-toolkit/<uuid>.png`. The result contains the absolute path as text, one raw-base64 Pi `ImageContent`, and path/MIME details only. Pi preserves the image for vision models and uses its normal omission marker for text-only models while retaining the path text.

The API-key endpoint is public OpenAI API behavior. The Codex OAuth endpoint is pinned to the official Codex `rust-v0.150.1` client and remains source-coupled; its real Pi 0.84.4 OAuth publication gate has passed with both Codex-main and Grok-main callers. A live API-key probe remains pending because no local API-key provider is configured, while its wire contract is covered deterministically.

### Apply Patch

`applyPatch.enabled` defaults to `false`. When enabled, the Toolkit-owned
`apply_patch` name is active for every main model unless another extension owns
that name. Model switches and `/pct reload` only resynchronize the flag and
name ownership; the Toolkit does not maintain a provider or model allowlist.

The tool has exactly one JSON argument, `{ "patch": string }`. Pi sends its
Codex-compatible Lark grammar to models that advertise grammar-tool support and
uses the same definition as an ordinary JSON function for other tool-calling
models. Both transports run the same local executor. Pi's built-in `edit` and
`write` remain available and unchanged.

The executor supports Add, Update, Delete, Move, multiple files and hunks,
locators, and End of File. It preflights the whole patch, rejects absolute or
traversing paths and every visible symlink component, then stages replacement
content before per-path rename/unlink commits. A predictable preflight failure
changes no target file. Individual replacement renames are atomic, but a Move
or multi-file patch is not a transaction; a later filesystem failure can leave
earlier operations committed and is reported as partial/unknown without retry.

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

The isolated read-only Computer Use gate and the corrected client-Set build's
complete real-Pi `Confirm` / `Always` matrix have passed. The matrix verified
same-app Yes-once, independent app confirmation, No-then-reprompt, unchanged
`/pct reload`, `/new` reset, `Always` across `/new`, and a normal no-tool turn,
using state reads only and without changing macOS permissions.

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

## Debug

`debug: true` writes metadata only to stderr:

- Feature, provider/API/model.
- Endpoint host.
- Duration, status, and request ID.
- Content-block types and counts.
- Error category without payload.

It never writes headers, tokens, prompts, tool arguments/results, screenshots, base64, opaque checkpoints, or compaction fallbacks. The first release has no log file, levels, rotation, or generic redactor.

## Conflicts

- Do not enable another Remote Compaction extension at the same time; multiple `session_before_compact` handlers can issue duplicate remote requests.
- Do not enable this project's Computer Use alongside `pi-codex-computer-use`; tool-name resolution may depend on load order.
- A winning third-party `apply_patch` registration is reported as
  `conflicting-tool-name`; the Toolkit does not replace or deactivate it.
- `pi-web-access` can coexist but is no longer a dependency. When its ordinary `web_search` and either toolkit Web Search backend are both enabled, `/pct status` reports duplicate search paths; the toolkit does not disable it.
- The first release does not proactively discover, disable, or rewrite other extensions.
