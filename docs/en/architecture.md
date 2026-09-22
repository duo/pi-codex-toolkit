# Pi Codex Toolkit Architecture

> Scope: version 0.2.0 on Pi 0.87 series, not the historical 0.1.0 artifact. This guide is the canonical public summary of dated validation and its limits; see [§9](#9-protocol-probe-status). Historical runs retain their original revision and platform scope.

## 1. Decision

Pi Codex Toolkit is not another Codex frontend and does not take over Pi's agent loop. It adds a small set of bounded OpenAI/Codex capabilities to Pi's existing lifecycle:

1. Inject native Web Search into official OpenAI/Codex Responses requests.
2. Expose OpenAI sidecar search to other main models as a regular Pi tool.
3. Attempt Codex Remote Compaction v2 when Pi decides compaction is needed.
4. Expose OpenAI/Codex image generation as a regular Pi tool.
5. Expose a provider-neutral `apply_patch` tool with Codex-compatible patch syntax.
6. Bridge local Computer Use through ChatGPT.app's bundled Codex app-server,
   `node_repl`, and the trusted `@oai/sky/service` runtime.
7. Expose default-off resumable shell sessions (`exec_command` / `write_stdin`)
   that can continue a running process without a second process manager.
8. Offer optional default-off Code Mode (`exec` / `wait`) that runs one short
   JavaScript program in a bounded cell and dispatches only explicitly declared
   adapted tools through their existing executors.

Pi continues to own the conversation, tool loop, session tree, compaction timing, and ordinary coding tools. The project adds the bounded Apply Patch editing primitive, a feature-local resumable shell-session manager, and an optional bounded Code Mode cell manager; it does not reproduce Codex shell orchestration, PTY terminal emulation, `view_image`, goal, plan, review, or multi-agent semantics.

The governing principle is: **enhance Pi; do not run a second Codex agent inside Pi.**

Capabilities are provider-neutral by default. If the main model can call ordinary Pi tools, Sidecar Search, Image Generation, Apply Patch, and Computer Use do not switch off merely because of its provider. Native Search and Remote Compaction restrict providers only because their protocols are bound to the current OpenAI/Codex Responses session; Computer Use image/UI requirements are modality and runtime constraints, not provider restrictions.

## 2. Scope

### Current-source capabilities

| Capability | Shape | Main-model restriction | Actual executor | Verification |
| --- | --- | --- | --- | --- |
| Native Web Search | Transform the current Responses payload | Official compatible OpenAI/Codex Responses route | Responses hosted tool | Two-turn live search passed; above-128k probe pending |
| Sidecar Web Search | Regular Pi tool `openai_web_search` | Any ordinary tool-calling main model; a separate OpenAI/Codex executor must be selected | Standalone Responses request plus hosted `web_search` | Codex OAuth protocol and Grok-main RPC acceptance passed; API-key deterministic only, live pending |
| Remote Compaction v2 | `session_before_compact` hook plus checkpoint replay | Official `openai-codex` provider/API/endpoint | Codex Responses | Consecutive compaction, restore, fork, and fallback live gate passed |
| Image Generation | Regular Pi tool `openai_generate_image` | Any tool-calling main model; separate OpenAI/Codex auth is required | Standalone Images API request | Codex-main and Grok-main OAuth live gates passed; API-key route deterministic only, live pending |
| Apply Patch | Regular, sequential Pi tool `apply_patch` | Any ordinary tool-calling main model | Local filesystem under Pi's current working directory | Deterministic parser, safety, commit, lifecycle, and transport tests |
| Shell Sessions | Two regular Pi tools `exec_command` / `write_stdin` over one local executor | Any ordinary tool-calling main model | Local `node:child_process` process group | Repaired process/recovery fixtures and public-host offline qualification; pre-repair model reports only (§9) |
| Code Mode | Two regular Pi tools `exec` / `wait` over one bounded worker-per-cell manager | Any ordinary tool-calling main model; nested adapters follow their own feature enablement | Separate `worker_threads` worker plus a fresh `vm` context; explicit adapters over the existing shell/Apply Patch executors | Repaired settlement/authority/recovery fixtures and public-host offline qualification; no fresh model-efficiency claim (§9) |
| Tool Discovery | One regular Pi tool `find_tools` over an explicit deferred-name directory | Any ordinary tool-calling main model; independent of Code Mode and default-off | Local additive active-set updates through public `setActiveTools`; execution stays Pi's normal next-turn dispatch | Deterministic query, load, and fail-safe lifecycle tests; description slimming and full-inventory deferral measured; historical 18/18 tasks on DeepSeek/Grok/Kimi (9 ON discovery, 9 OFF baselines), ON added rounds; not repaired-code measurements |
| Computer Use | Six static, sequential regular Pi tools | MVP requires image input, macOS, and interactive UI | ChatGPT.app bundled `codex app-server` → `node_repl/js` → `@oai/sky/service` | Fake app-server tests, read-only live gate, and approval-mode matrix passed |
| Configuration and status | `/pct` and one JSON file | None | Pi extension | Unit tests |

### Experimental Computer Use boundary

| Capability | Shape | Main-model restriction | Actual executor |
| --- | --- | --- | --- |
| Computer Use | Static, sequential regular Pi tools | MVP requires image input, macOS, and interactive UI | ChatGPT.app bundled `codex app-server` → `node_repl/js` → trusted Sky service |

Computer Use is implemented behind a default-off experimental flag. Its local
dependencies and protocol-drift risk are materially higher than the Responses
features, so publication has a separate read-only acceptance gate; that gate
passed with the components paired for the August 29, 2026 probe.

The config schema and menu expose `computerUse.enabled` plus the two approval
modes `Confirm` and `Always`; no backend, installer, timeout, or compatibility
settings are exposed.

### Why Web Search has two paths

Native Search lets the current official OpenAI/Codex main model use the hosted tool directly. Sidecar Search lets Claude, Gemini, or another main model that supports regular Pi tools obtain an answer and sources through a separate OpenAI Responses request. The latter adds an OpenAI request, latency, and cost. The toolkit does not automatically attach the full main conversation history, but it sends the main-model-generated query verbatim to the executor; that query may quote or summarize conversation content.

The user does not need to install `pi-web-access`. This project implements only an OpenAI-only, query-only sidecar; it does not reproduce that extension's multi-provider router, fetchers, or fallback system. Both paths belong to one Web Search capability and are mutually exclusive within a turn.

### Explicit non-goals

- Codex backend mode, `dynamicTools`, or the full Codex agent loop.
- Reimplementing the full Codex shell orchestration/PTY terminal/`view_image`/goal/plan/review/multi-agent surface, or the Responses API's first-class `apply_patch_call` protocol. A bounded local resumable shell session is in scope; a terminal emulator, job-control product, or remote process host is not.
- Browser, Playwright/CDP, in-app browser, or Chrome-extension control.
- Generic `web_fetch`, deterministic arbitrary-URL retrieval, `open/click/find`, or Codex's private `alpha/search` protocol.
- Generic MCP, apps, or plugin marketplace support.
- Automatic Computer Use installation, GUI launch, or macOS permission grants.
- Exact model-ID allowlists, `assumeNativeSearch`, or network capability probes.
- A generic capability bus, provider registry, dependency-injection container, or dynamic MCP-schema mirror.
- `/doctor`, a configuration database, file watcher, migration framework, or generic secret redactor.

## 3. Minimal module boundaries

One package is sufficient:

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

Responsibilities:

- `index.ts`: register hooks, commands, and tools; no protocol logic.
- `config.ts`: own the single configuration type, defaults, validation, and persistence.
- `commands.ts`: thin UI for `/pct config|status|reload`.
- `status.ts`: project configuration, the current model, and external dependencies into user-readable status (`active`, `deferred`, `unavailable`, or `off`).
- `apply-patch.ts`: parse, validate, stage, and commit one bounded local patch; it does not own provider routing.
- `openai/route.ts`: resolve official routes and Pi authentication; this is the only boundary allowed to attach credentials to network requests.
- `openai/request-pipeline.ts`: one deterministic, idempotent Responses payload pipeline.
- The four OpenAI feature files own their protocols and result conversion; there is no generic feature interface.
- `computer-use/app-server-client.ts`: one app-server client: process start, JSONL-RPC handshake, readiness, request correlation and budgets, transport reset and close.
- `computer-use/lifecycle.ts`: the extension's owner of Computer Use clients: the reusable runtime client and its approval mode, dedicated status probes, clients whose disposal failed, the lifetime fence (epoch, preflight count, session stop) that rejects stale callers, and the one `dispose`/`cleanup` path that retries or disposes.
- `computer-use/tools.ts`: fixed Pi tool schemas and MCP-content conversion.
- `shell/manager.ts`: session-owned process manager over `node:child_process`; IDs, bounded incremental output, stdin, termination, retention, and the narrow `start`/`write`/`close` executor contract.
- `execution-mode.ts`: pure model-rule matching and route admission — the glob, the first-match rule, requested versus effective routes, the admission notes and the native names a route replaces; no filesystem and no Pi host.
- `execution-dialect.ts`: the one supported Codex call dialect, shared by the direct tools and the nested adapters — accepted spellings, rejected conflicts, unsupported fields and the documented token-to-byte proxy, all refused before any effect; pure, and enablement, ownership and handle lookup stay with the managers.
- `execution-invocation.ts`: the generic invocation seam an embedder installs through `createPiCodexToolkit` — one trusted per-call environment and policy decision applied identically on the direct and nested paths; it derives nothing from a particular orchestrator.
- `execution-editor.ts`: the `/pct config` rule page built from Pi `select`/`input` dialogs — draft add/edit/delete/reorder, match preview and legacy-migration preview; it performs no save of its own.
- `execution-diagnostics.ts`: the bounded `version: 1` record published on `pi.events` after each committed synchronization — names, flags and a config revision only, plus the packed manifest identity; `index.ts` owns the host reads that fill it.
- `execution-output.ts`: independent cumulative text capture, lazy private files and an explicit session file owner; not an executor, archive registry, quota service or model reducer.
- `bounded-text.ts`: the shared code-point-safe, tail-capped preview buffer used by Shell and Code Mode (`append`, `markDropped`, `drain`); preview only, never capture.
- `tool-ownership.ts`: exact source-path ownership inspection of a visible Pi tool (`owned` / `foreign` / `absent`) with the two distinct predicates the sync and live-dispatch paths rely on.
- `openai/usage.ts`: the one Responses `usage` parser with model cost applied, shared by Sidecar Search and Remote Compaction.
- `shell/tools.ts`: the two ordinary JSON tool definitions, shared adapter schemas and literal result rendering; no process management.
- `code-mode/manager.ts`: worker-per-cell lifecycle, fresh-cell state, bounded output, yield/wait cursors, cancellation, and retention; no tool or provider protocol.
- `code-mode/adapters.ts`: explicit nested-tool registry with schema validation, live authority, cancellable bounded gates, independent shell controls and extra Apply Patch-only confirmation.
- `code-mode/tools.ts`: the two ordinary `exec` / `wait` JSON schemas and result rendering; no protocol logic.
- `tool-discovery/directory.ts`: pure managed-set logic — the fixed deferrable name list, bounded search ranking, atomic-group expansion, and load validation; it touches no Pi API or configuration storage.
- `tool-discovery/tools.ts`: the single `find_tools` definition and result rendering over injected eligibility/activation callbacks; it never executes another tool.

Do not pre-split a feature into service/controller/adapter layers. Split a file only after it becomes difficult to test.

## 4. Data flows

### 4.1 Current main-model Responses request

```text
Pi builds provider payload
  → replay a compatible Remote Compaction checkpoint
  → deduplicate and inject Native Web Search
  → official Responses endpoint
```

One `before_provider_request` handler runs this pipeline. Every transform must:

- Return the original payload when it does not apply.
- Preserve unknown fields and additions made by other extensions.
- Be idempotent.
- Avoid depending on registration order inside this package.

Pi still chains hooks from separate extensions in load order. The toolkit does not try to control later extensions; documentation declares overlapping payload and compaction extensions incompatible.

### 4.2 Sidecar Web Search

```text
Any main model that can call ordinary tools
  → openai_web_search({ query })
  → user-selected official OpenAI/Codex Responses executor + effort
  → hosted web_search (required)
  → answer + deduplicated sources
  → ordinary Pi tool result
```

The sidecar request does not automatically attach Pi's main conversation history. It sends only the tool's `query` and does not pass through the main model's Responses payload pipeline. The main model generates that query, which may contain conversation information, and the toolkit sends it verbatim to the executor. Sidecar shares only official-route/auth resolution with Native Search, not request transforms or response parsing.

### 4.3 Image Generation

```text
Any main model
  → openai_generate_image
  → official route + existing Pi OpenAI/Codex auth
  → Images generation endpoint
  → unique artifact file + Pi ImageContent
```

The image request does not include the main conversation history. Current Codex source also uses a standalone Images client instead of running another Codex agent turn. See the [Codex image backend](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/backend.rs) and [image tool](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs).

### 4.4 Apply Patch

```text
Any main model that can call ordinary tools
  → apply_patch(raw Codex-compatible patch or JSON { patch })
  → parse and preflight every operation under ctx.cwd
  → compute changes in memory and stage every replacement
  → one final cancellation check
  → commit mkdir/rename/unlink operations in patch order
```

Pi chooses the constrained-grammar or JSON transport. Both reach the same
provider-neutral executor. The executor uses Pi's public file-mutation queue,
rejects visible symlinks and paths outside the canonical working directory,
and completes preflight before staging or commit. This is a static containment
boundary, not a race-proof sandbox.

### 4.5 Computer Use

```text
Pi computer_use_* tool
  → lazily start ChatGPT.app's bundled codex app-server
  → initialize → initialized
  → ephemeral thread/start with exactly one injected node_repl MCP
  → mcpServer/tool/call(server = "node_repl", tool = "js")
  → fixed JavaScript imports @oai/sky
  → trusted @oai/sky/service operates a local app
  → convert text/image MCP content to a Pi tool result
```

`mcpServer/tool/call` is a documented non-experimental app-server method;
`dynamicTools` and a model turn are unnecessary. Every Pi call sends one fixed
source template to `node_repl/js`; arguments are JSON data and are never
executable source. The official protocol requires every connection to complete
`initialize` and `initialized`, and tool calls must use a valid thread. See the
[Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
A startup that never becomes ready reports `node-repl-unavailable`, whether it
stalls in the handshake, in a readiness poll, or at the readiness deadline;
`timeout` belongs to dispatched calls.

The bridge requires the paired components under
`/Applications/ChatGPT.app/Contents/Resources` and the installed helper at
`<real CODEX_HOME>/computer-use/Codex Computer Use.app`. It does not search
PATH, mix Codex.app or plugin-cache components, launch a GUI, install anything,
or change macOS permissions. Whether the ChatGPT GUI must already be running is
not part of this experimental contract.

State screenshots are read from the helper's local URL. The fixed template
accepts only PNG or JPEG magic and emits the matching native Pi image MIME;
unknown bytes fail closed. This matters because the current helper returns JPEG
for the live-tested Calculator state.

Valid Computer Use elicitations have two policies. `Confirm` forwards the first
request for an app to Pi and returns Sky's session-persistent
`{ action: "accept", content: {}, _meta: { persist: "session" } }` only after
Yes; No is one-shot and is never cached. `Always` returns that same accept
without Pi confirmation. Sky supplies the canonical bundle identifier, and the
Toolkit keeps accepted identifiers only in the current client's in-memory Set;
a hit returns node_repl's `computer-use-persisted-state` conversation response.
Reusing the client preserves `Confirm` approvals; session shutdown, disable,
eligibility loss, tool conflict, or an approval-mode change closes it and
clears the Set. `Always` remains effective after a fresh Pi session because the
configuration selects automatic acceptance again, not because approval is
stored globally. Neither mode bypasses macOS permissions.

Only a current, validated, uncached asynchronous confirmation pauses that
invocation's outer request budget. There is no added human deadline: an
unanswered local UI or RPC frontend can leave the current tool/turn waiting and
retaining resources until a decision, host cancellation/closure, or runtime
failure. An unavailable confirmation handler does not grant a new app; the
existing headless eligibility gate is unchanged. In the default local TUI,
Esc/No dismisses and declines the current confirmation, not necessarily the
whole agent turn. Host abort separately cancels the invocation. RPC controls
and visible dialog dismissal depend on the frontend: the owned cancellation
signal cancels Pi's pending confirmation promise and invalidates late answers,
but does not guarantee that a remote frontend hides its dialog.

After confirmation, the outer timer resumes only its remaining non-human
budget, without progress-based renewal. The inner 120-second argument and
outer 130-second default/cap remain unchanged, alongside finite startup/probe
budgets and the upstream MCP active-time budget (300 seconds by default in the
qualified bundle). Sky can suspend the inner timer during an operation, so the
shorter outer budget remains necessary; 120 seconds is not a universal desktop
action wall-time guarantee. Neither timeout nor cancellation proves desktop
effects stopped. An interrupted dispatched action remains unknown and requires
an explicit successful `get_app_state` before another action; nothing is
observed or replayed automatically.

### 4.6 Shell Sessions

```text
ordinary Pi tool call (exec_command | write_stdin)
  → shared dialect normalizer (Codex spellings, alias conflicts, unsupported fields)
  → validated arguments
  → invocation seam (trusted per-call environment, then applicable policy)
  → session-owned process manager (node:child_process)
  → separate decoded stdout/stderr capture before destructive preview limits
  → bounded incremental result + independent control/recovery metadata
  → Pi rendering/transcript
```

The manager is feature-local. It exposes a narrow `start`/`write`/`close`
executor so the optional Code Mode adapters reuse the same instance; it never
adds a second process backend. The nested adapters run the same normalizer and
the same invocation seam, so both entries accept one dialect and apply one
policy.

### 4.7 Code Mode

```text
ordinary Pi tool call (exec: raw grammar source or JSON code | wait)
  → first-line pragma + dialect normalization
  → bounded JavaScript cell (worker_threads worker + fresh vm context)
  → explicit adapter for a tool declared in uses (or the admitted snapshot)
  → dispatch-time admission, invocation seam, Patch approval
  → the adapted feature's existing executor
  → credited capture of emitted text and serialized selected result/error
  → bounded preview + independent shell controls/recovery
  → Pi rendering/transcript (plus bounded nested progress on the outer call)
```

The outer call remains the only `tool_call` / `tool_result` event. Nested
dispatch is reviewable by hooks only through the outer call's `code` and `uses`
arguments; no public extension API can emit per-nested-call events. Bounded
nested start/waiting-approval/end records travel on the outer call's ordinary
update callback: control identity and an outcome code only, never a fabricated
nested event.

### 4.8 Tool Discovery

```text
deferred Toolkit name (explicit toolDiscovery.deferred entry)
  → hidden from the ordinary active-tool projection
  → model calls find_tools with query and/or load
  → per-name ownership + feature + runtime-decision recheck
  → additive setActiveTools([...active, ...eligible])
  → next model turn exposes the loaded tool
  → the tool's own executor validates and runs the actual call
```

Discovery changes only which already-registered Toolkit names Pi exposes. It
does not call another executor, does not grant permission, and does not bypass
any nested-adapter check. If neither argument is supplied, the list is
malformed, discovery is disabled, or `find_tools` is conflicted, the call
throws before any state change.

## 5. Capability contracts

### 5.1 Web Search

Web Search is one capability with two mutually exclusive execution paths. The configured `backend` selects the path:

| backend | Behavior |
| --- | --- |
| `auto` | Use native when the current main model has an official compatible Responses route; otherwise use the configured and authenticated sidecar executor |
| `native` | Force current-main-model payload injection only; unavailable when the route is incompatible |
| `sidecar` | Expose only `openai_web_search`; unavailable when the executor cannot be used |

`auto` selects before dispatch; it is not failure fallback. A turn has at most one toolkit-owned search path. A failed native request is never resent through sidecar, and sidecar failure never changes provider or retries.

#### Native path

Eligibility uses structural checks rather than a model list:

```text
configured
&& provider/API is an official compatible Responses implementation
&& endpoint passes official-route validation
```

These conditions mean only that the current request is **eligible for injection**. They do not guarantee that the service accepts the model, reasoning setting, or input length. Official model restrictions still apply, and Responses Web Search currently limits input to a 128k context. The toolkit does not add an allowlist or local tokenizer for this. The above-128k live probe has not been run, so callers should stay within the documented service limit.

The native path uses:

- `tool_choice: "auto"`, allowing the current main model to decide when to search.
- Configured `mode: "live" | "cached"` and `contextSize: "low" | "medium" | "high"`.
- Preserving, deduplicating merges for hosted tools and `include` fields.

`cached` maps to `external_web_access: false`; `contextSize` maps to `search_context_size`. See the [OpenAI Web Search guide](https://developers.openai.com/api/docs/guides/tools-web-search).

Pi's current Responses parser does not fully retain `web_search_call`, sources, or `output_text.annotations`. The native path therefore promises “native grounded search, citations best effort,” not a complete structured-search UI. The 2026-08-29 two-turn live probe completed normally and observed two source URL occurrences in each turn without replay validation errors.

#### Sidecar path

The sidecar executor is one official OpenAI/Codex Responses `provider + model` that the user explicitly selects from Pi's model registry in `/pct config`. A second menu selects `auto` or one thinking level that Pi reports as supported for that Codex model. The setting is independent of the main model's thinking level. This is not a main-model allowlist: Pi's main model may still use any provider; the selected model only executes the standalone search request. Authentication is not stored in toolkit config. Every call obtains refreshed key/headers from Pi's registry and validates the official route again.

`openai_web_search` accepts only `query`. Its standalone request:

- Does not automatically attach main conversation history; it sends the main-model-generated `query` verbatim to the executor, and that query may quote or summarize conversation content.
- Uses `{type: "web_search"}`, `tool_choice: "required"`, and `store: false`.
- Requests `web_search_call.action.sources` and applies the same `mode` and `contextSize` as the native path.
- Waits for `response.completed` and requires at least one `web_search_call`.
- Returns a concise answer, at most 20 stably deduplicated clickable sources, and token usage when available. Twenty is the Toolkit's fixed output budget, not a hosted-search result-count guarantee.
- Propagates abort, uses a fixed internal timeout, and never retries or changes route after dispatch.

The retained API-key route uses one feature-local non-streaming Responses request. Codex OAuth uses Pi's public Codex provider with SSE and zero retries; a small feature-local decoder aggregates `response.output_item.done` records because the live terminal response omitted the complete output, then requires one completed terminal event. Pi's normalized final message is not used for sources because it drops the raw search-call and annotation data. Neither path becomes a generic OpenAI client.

Pi's current model metadata has no general ordinary-tool-call capability flag. The toolkit therefore does not guess Sidecar eligibility from provider/model IDs: when the executor route is usable, it exposes the ordinary Pi tool. A main model that cannot use Pi's ordinary tools cannot invoke it, just as it cannot reliably use Pi's built-in coding tools. The non-OpenAI-main-model API-key live smoke remains pending because no eligible local executor is configured.

The sidecar parses raw Responses output itself, so it can preserve sources reliably. A user may force sidecar even with an OpenAI/Codex main model when explicit sources matter more than native integration. It adds OpenAI model and hosted-search cost and latency; `/pct status` must show the executor and this separate-billing behavior.

Codex OAuth is the live-verified Sidecar protocol baseline for this package. It remains an observed, Pi-pinned ChatGPT backend rather than a stable third-party public API contract. A failure never switches to the retained API-key route or private `alpha/search`.

Sidecar Search is not deterministic webpage retrieval either. Hosted `web_search` may read pages during search and return sources, but callers cannot treat it as `fetch(url) → raw content`. The ChatGPT desktop built-in Browser can open and operate websites, but official documentation says it is not a Codex CLI/IDE capability, and app-server has no public generic fetch RPC. The first release therefore does not provide `openai_fetch_url`; even if future Computer Use can operate a visible Browser, that remains UI automation. See the [ChatGPT Browser documentation](https://learn.chatgpt.com/docs/browser) and [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

If an ordinary active tool is already named `web_search`, `/pct status` only reports a conflict warning. The toolkit does not disable, replace, or restore another extension's tool.

### 5.2 Remote Compaction v2

Pi continues to decide when compaction occurs. The extension only subscribes to the public `session_before_compact` hook; it does not own thresholds or patch a private agent loop. Current Pi already runs automatic compaction before the next assistant response, so older inline-compaction adapters are unnecessary.

Every remote checkpoint uses a dual representation:

```text
CompactionEntry.summary
  = unique marker + bounded readable fallback

CompactionEntry.details
  = raw opaque compaction item
  + bounded provider-visible real-user replay window
  + model / endpoint / account fingerprint / auth kind

CompactionResult.usage
  = optional provider usage (not duplicated in details)
```

When model, official endpoint, account, and authentication kind all match, the ordinary request replaces the marker summary with:

```text
retained real-user messages → one opaque compaction item → Pi kept tail
```

When incompatible, disabled, or unable to resolve compatible authentication, the request retains the readable fallback and does not replay opaque data. This lets users switch model/provider or disable the feature safely. Context quality falls back to text, but the session is not locked.

An implementation that stores only `encrypted_content` is insufficient. The toolkit keeps the Pi-representable subset of current Codex behavior: provider-visible real-user messages under one bounded window, followed by exactly one latest compaction item. It deliberately does not recreate Codex-private agent-message, hook-prompt, image-budget, or world-state machinery. The implementation must pass two consecutive compactions before release. See the pinned Codex [`compact_remote_v2.rs`](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/core/src/compact_remote_v2.rs).

Requests must also:

- Send each credential type only to its normalized official endpoint.
- Send `x-codex-beta-features: remote_compaction_v2`.
- End input with exactly one `compaction_trigger`.
- Wait for `response.completed`.
- Accept exactly one compaction output item while allowing other output items.
- Preserve the opaque item without decoding or logging it.
- Return custom compaction instructions to Pi's native compaction path.
- Return control to Pi native compaction on remote failure; the dual representation keeps readable context on existing branches.

The feature is off by default. A successful remote entry stores a unique marker plus a deterministic transcript excerpt capped at 12,000 characters. Replay refreshes OAuth and requires the exact provider, API, model, normalized endpoint, authentication kind, and hashed account identity. `/pct status` reports structural eligibility only; it does not refresh credentials or claim live account proof.

[pi-codex-compaction's dual representation](https://github.com/jvm/pi-mono/blob/0434813418e502b4b5b78559a0efb51058e28255/packages/pi-codex-compaction/src/remote-compaction.ts) is a useful reference, but its replay must be extended to match current Codex retained-window semantics before release.

### 5.3 Image Generation

The first release exposes `openai_generate_image` for one-image generation:

- Parameters: `prompt`, with optional `size` and `quality`.
- Use `gpt-image-2` through the current official Images API route.
- The main model may use any provider if it can call ordinary tools and Pi separately has usable OpenAI/Codex authentication.
- Route/auth selection is fixed: reuse the current main model's compatible official OpenAI/Codex route first; otherwise prefer `openai-codex` OAuth, then an `openai` API key. `/pct status` shows the selected backend/account kind; there is no provider selector.
- Image Generation does not consume the Web Search executor model or effort. Its chat model is only an authentication carrier for the fixed `gpt-image-2` request.
- Text-only main models can generate an image but cannot visually inspect it.
- API-key auth is sent only to `https://api.openai.com/v1/images/generations`; Codex OAuth is sent only to `https://chatgpt.com/backend-api/codex/images/generations`. A refreshed route is revalidated immediately before dispatch.
- Send one JSON request with `redirect: "manual"`; 3xx and every other terminal failure issue no retry or backend fallback.
- Save the original PNG to `<getAgentDir()>/artifacts/pi-codex-toolkit/<uuid>.png` with exclusive creation; do not accept an arbitrary `outputPath` or overwrite a file.
- Return short text with the absolute path, one raw-base64 Pi `ImageContent`, and payload-free path/MIME details for native TUI, session, and vision-model handling.
- Do not automatically retry after dispatch; an unknown result must not cause duplicate billing or generation.
- Propagate Pi's abort signal. Once server-side generation may have started, report an unknown result instead of claiming cancellation.
- Never log the prompt, base64, or image.

The public API-key contract follows the OpenAI Images API. The ChatGPT/Codex OAuth endpoint and `chatgpt-account-id` header are pinned to Codex `rust-v0.150.1` source rather than presented as a public third-party OAuth API. Its real Pi 0.84.4 OAuth publication gate has passed; the API-key live probe stays explicitly pending while no such local credential exists.

Image editing, reference uploads, and recent-conversation image selection are deferred. They require upload confirmation and explicit headless behavior and should not inflate the first generation tool.

Pi's built-in `read` already supports jpg/png/gif/webp/bmp and returns images as attachments, so this project does not add `view_image`. See the [Pi read tool](https://github.com/earendil-works/pi/blob/6c87d9a026677b601e8278030dcf1ad97fe0bd86/packages/coding-agent/src/core/tools/read.ts#L213-L270).

### 5.4 Apply Patch

`apply_patch` is default-off and accepts only one `patch` string. Grammar-aware
models receive the bounded Codex-compatible grammar; other ordinary tool callers
receive the equivalent JSON schema. Add, Delete, Update, Move, multiple files,
multiple hunks, `@@` locators, and `*** End of File` are handled by one parser
and executor. The first matching tier among exact, trailing-whitespace-insensitive,
and fully trimmed comparison must identify exactly one location. Like Codex, a
bare empty line inside an `Update File` hunk is read as an empty context line,
and a hunk whose old lines end with an empty one also matches without it, keeping
a non-empty added last line; unlike Codex, that retry never reaches an empty
pattern, so a hunk whose only old line is empty stays a context mismatch.
`Add File` hunks stay strict, so a bare empty line there is still rejected.

All predictable failures are found before mutation: syntax and context errors,
path conflicts, containment, visible symlinks, UTF-8 validity, newline style, and
file type. Existing source files, including `Delete File` targets, must be valid
UTF-8 text with consistent LF or CRLF; non-UTF-8, bare CR and mixed line endings
are rejected before mutation. Binary deletion is unsupported.
Replacements are staged before a final abort check. Each committed
path is atomic, but a move or multi-file patch is not a transaction; commit
failure truthfully reports completed paths plus the failed or unknown operation.
There is no automatic retry or rollback. UTF-8 BOM, LF/CRLF style, final-newline
state, and ordinary POSIX executable bits are preserved.
A source with no lines (0 bytes, or only a BOM) has no line-ending style or
final-newline state, so an Update writes added content as Add File does: LF
endings and a final newline, after the BOM if there is one. Keeping a non-empty
source's missing final newline is deliberate and differs from Codex at
`b8c8637`, which ends every non-empty Update output with a newline. Applied
separately to the source `"a\nb"`, the hunks ` a`/`-b`,
` b`/`+c`/`*** End of File` and `-a`/`+z`/` b` give `"a"`, `"a\nb\nc"` and
`"z\nb"` here, and Codex adds a final `\n` to each.

This is an ordinary Pi tool, so `edit` and `write` remain available and no
provider/model routing table is added. Pi 0.84.4 has no transport seam for the
Responses API's typed `apply_patch_call`, so that first-class protocol is not
implemented. The parser and first three matching tiers are a necessary modified
subset of Codex at commit
[`b8c8637`](https://github.com/openai/codex/tree/b8c86376a258e55efc8e5ecfbabc21c16c07d814);
the bundled notices record its Apache-2.0 provenance.

### 5.5 Computer Use

The MVP exposes six high-coverage tools:

- `computer_use_list_apps`
- `computer_use_get_app_state`
- `computer_use_click`
- `computer_use_type_text`
- `computer_use_press_key`
- `computer_use_scroll`

Add `drag`, `set_value`, `select_text`, and secondary actions only after real usage requires them.

All Computer Use tools use `executionMode: "sequential"`, relying on Pi's own scheduling rather than a custom Promise queue. Each action remains a visible Pi tool call; one hidden invocation never runs a desktop-agent loop.

The Computer Use MVP requires current model metadata to include image input. The accessibility tree could theoretically support a text-only model, but doing so adds screenshot filtering, coordinate-tool filtering, and a second prompt contract. An accessibility-only mode is deferred to keep the MVP simple.

The app-server client must:

- Use only the paired ChatGPT.app `codex`, `cua_node/bin/node_repl`, bundled
  Node, bundled modules, and installed Computer Use helper.
- Spawn app-server with one private temporary directory as its working
  directory, `CODEX_HOME`, and thread `cwd`; inject exactly one `node_repl`
  server with only its `js` tool enabled.
- Start lazily and terminate on Pi session shutdown or when the feature is disabled.
- Complete `initialize → initialized`.
- Use one ephemeral thread.
- Correlate response IDs and apply a timeout to every RPC.
- Dispatch exactly one predefined JavaScript template per Pi tool call. Never
  expose arbitrary JavaScript, start a model turn, or invoke a hidden state read.
- Never automatically retry click/type/key/scroll. After timeout or disconnect, report an unknown result and require `get_app_state` before another action.
- Honor abort before dispatch; after dispatch, do not promise that a desktop action was undone.
- Handle elicitation only for the active thread, `serverName === "node_repl"`,
  form mode, connector metadata `connector_id === "computer-use"`, and a
  non-empty canonical `_meta.tool_params.app`; otherwise decline. Trim that app
  identifier without changing case. In `Confirm`, Yes returns object content
  with `_meta.persist === "session"` and adds the app to the current client Set;
  No returns null content, adds nothing, and prompts again later. In `Always`,
  accept the same narrow request without opening Pi confirmation. A Set hit
  mirrors node_repl's persisted-state conversation response.
- Reuse the current client across ordinary turns, compaction, unchanged
  `/pct reload`, and eligible model switches. Close it on disable, eligibility
  loss, tool conflict, session shutdown, or either approval-mode transition;
  the Set has exactly that client lifetime and is never persisted.

The toolkit never configures or falls back to the legacy direct
`mcp_servers.computer-use` / `SkyComputerUseClient mcp` route. A future
`cua_repl` migration would replace this narrow runtime boundary only after a
separate protocol probe; no multi-backend adapter exists now. `/pct status`
performs only an import/`sky.target === "mac"` probe after cheap eligibility
checks and closes its dedicated probe client in `finally`.

### 5.6 Shell Sessions

Shell Sessions is default-off and provider-neutral. It adds exactly two owned
names, `exec_command` and `write_stdin`, activated as one atomic group. A
conflict on either name disables both Toolkit names while preserving the
winning third-party registration and all unrelated active tools.

The manager resolves the shell once per instance through Pi's public
`getShellConfig()`. It spawns `node:child_process` with `detached` on POSIX,
`windowsHide: true`, inherited process environment, and piped stdin/stdout/
stderr; the `stdin` command transport writes the command to stdin and ends that
pipe, so the session's stdin is not interactive and non-empty `write_stdin`
input is rejected. Shell Sessions uses pipes only: there is no PTY and no TTY
claim; a future TTY path needs a real PTY fixture first.

Contracts:

- One shared dialect normalizer serves the direct tools and the nested
  adapters: `cmd`/`command`, `workdir`/`cwd`, `session_id`/`sessionId`,
  `chars`/`input`, `yield_time_ms`/`yieldTimeMs` and the `max_output_tokens`
  budget are the Codex spellings of existing fields. Same-value duplicates
  pass; conflicting values, unsupported Codex fields and numeric handles reject
  before any effect. Results add `session_id` and `exit_code`.
- A command launches exactly once and is never relaunched or replayed.
- Admission is fenced across close, including starts awaiting cwd validation.
  Pre-aborted starts send nothing; asynchronous ENOENT/EACCES and synchronous
  spawn failures settle as `spawn-failed`, even at zero yield, without a phantom
  running slot. Later deliberate re-enablement can start new work.
- Destructive observations are serialized and revalidate the handle. Input and
  stop do not wait behind a quiet poll. Stdin uses at most **262,144 UTF-8 bytes
  and 16 outstanding input calls per session**, including reservations until
  both transport and the invoking request settle. These reuse the existing
  stream/job envelopes, not Node's high-water mark or a disk quota.
- Input is verbatim; no newline or EOF is inserted. `closeStdin` follows accepted
  bytes, repeated EOF is harmless, and nonempty input after EOF/broken pipe or
  combined with `terminate` rejects before sending. `stdin-overload` rejects
  before sending. EPIPE/write/end failure is `stdin-failed` with unknown
  delivery. A wait expiring after submission can return `inputDelivery: unknown`;
  `written` means the transport callback, **not application consumption/effects**.
  Cancellation before input sends nothing; after submission it may leave
  unknown delivery. Never automatically resend.
- Each stream's rolling preview is 256 KiB; overflow drops oldest complete code
  points and sets `dropped`. Reads use one combined `maxOutputBytes` budget,
  stdout first. `truncated`/`dropped` describe preview loss, not capture loss.
  Independent cumulative prefix capture precedes these limits (§5.9).
- POSIX completion requires leader exit, ordinary process-group disappearance,
  and both captured streams finishing. Normal same-group children remain owned
  even with redirected output. The 50-ms group probe is not a deadline for
  discarding inherited pipes; a 50-ms settle can combine short output and exit.
- At most 16 jobs are unsettled. Completed-but-unread handles are swept lazily
  after five minutes or above 32, oldest first (not an instantaneous cap).
  One terminal observer wins, then `stale-session`; files have a different
  lifetime. A returned `sessionId` alone is not proof the job is live.
- Stop sends group `SIGTERM`, escalates after 5 seconds to `SIGKILL`, and uses a
  5-second confirmation window. Unconfirmed stop observations do not inherit a
  long poll deadline: `terminated` plus `unknownOutcome` retains the handle for
  `write_stdin` polling/stop retry, not command replay. Close can reject
  `cleanup-incomplete` and retain responsibility. Windows `taskkill /PID <pid>
  /T /F` has a finite timeout; its tree/natural-descendant behavior is not
  runtime-qualified. Escaped groups, PTY and restart reattachment are excluded.
- Cancelling a direct `exec_command` or `write_stdin` stops the job. When a
  Code Mode cell fails, is stopped or closes, its nested `write_stdin` calls
  end without stopping the shell: a call still queued returns at once, a call
  already waiting returns before reading output, and the output and final
  result stay for the next reader. Submitted input stays counted until the pipe
  accepts or rejects it. Pi gives every tool call in one assistant message the
  same cancellation signal, so top-level observers are cancelled together; the
  shell and Code Mode tools therefore leave `executionMode` unset.
- Bad command/cwd/limits, cap and stale handles produce categorized errors.
  Shell availability is checked lazily at execution; status can report
  `shell-unavailable` without preventing schema exposure. Other features continue.

Native `bash` is retained under legacy enabled-flag configuration, which stays
additive. With `execution` rules in force, a committed direct Shell or Code
route hides the admitted builtin `bash` for as long as that route holds and
restores it when the route ends; a foreign same-name winner and a `bash` the
user disabled are never touched (§7). A finite command can complete in one
call; managed availability does not force polling. Environment is inherited from the Pi
process; an embedder can add a trusted per-call overlay through the invocation
seam (§5.10), merged for one spawn only, never mutating the manager environment
or `process.env`. The Toolkit still does not derive Pi session/model metadata of
its own. Execution cleanup and file lifetime follow §7.

### 5.7 Code Mode

Code Mode is default-off and provider-neutral. It adds exactly two owned names,
`exec` and `wait`, activated as one atomic group. A conflict on either name
disables both Toolkit names while preserving the winning third-party
registration and all unrelated active tools. It does not gate on the current
model, provider, or reasoning setting, and it never launches a hidden model
turn or a replacement agent loop.

Each `exec` starts one `worker_threads` worker with an inline bootstrap and a
fresh `vm` context. Run only trusted JavaScript with the current user's
authority: fresh per-call state is not a security sandbox, and neither the
worker nor `vm` is a security boundary. The supported cell API exposes
`tools.<declared>`, `print(...)`, `console.log/warn/error`, and `text(value)`;
it does not supply ambient `process`, `require`, `fetch`, or dynamic
`import()`, and it never provides `store`, `load`, `notify`, `yield_control`,
`ALL_TOOLS`, image/audio helpers, `exit`, or timers.
Variables, imports and functions are not retained between cells; host-side
effects are not isolated. `worker.terminate()` supports CPU-bound cancellation,
not forced termination of all host effects. V8 generation limits are 64/8 MiB,
not a total heap/RSS or external-allocation guarantee. Formatting/serialization
can allocate whole strings before transport admission. Feature-off startup
creates no worker.

Contracts:

- `exec.uses` declares supported `tools.<name>` adapter dispatch, not containment
  of hostile JavaScript or a restriction on ambient host authority. The manager
  rejects a `uses` value that is not an adapted name before any cell starts,
  and a nested call to an undeclared adapter fails inside the cell. Omitted
  `uses` declares the adapters admitted at cell creation and `[]` declares
  none; that snapshot is also the cell's ceiling, so a later expansion never
  enlarges a running cell while a contraction still applies at dispatch.
- `exec` carries the pinned upstream Codex freeform grammar as its
  `constrainedSampling` variant, so grammar-capable providers send raw
  JavaScript that Pi decodes into `code`, with the ordinary JSON form as the
  fallback. An optional first-line `// @exec:` pragma supplies `yield_time_ms`
  and `max_output_tokens`; unknown keys, malformed JSON, or disagreement with
  an explicit argument reject before worker creation, and the pragma line is
  blanked so source line numbers do not shift. `max_output_tokens` /
  `max_tokens` is a documented four-bytes-per-token proxy bounded by the
  existing byte caps, not provider tokenization.
- Adaptations reuse the existing executors: `exec_command` / `write_stdin` use
  the one Shell Sessions manager, and `apply_patch` uses the Toolkit definition
  with its TypeBox validation, containment, mutation queues, and truthful
  partial-commit reporting. No private host import or second backend is added.
- Validate against the actual direct TypeBox schemas, including unknown fields
  and ranges, **before confirmation**. Recheck config, abort and visible foreign
  ownership of either shell sibling / Patch at the granted queue slot and after
  approval. A hidden or deferred direct name is not a foreign winner: exposure
  is not authority. An allowlist-absent name is not a foreign winner either,
  but it is not an admitted owned registration, so its route is never admitted
  and its nested adapter is outside the cell's admitted set. `exec` supplies
  complete inline callable help for all three adapters even if direct schemas
  and discovery are hidden.
- Four adapter slots remain; Patch also uses one sequential gate and existing
  filesystem queues. Per cell, worker/host/adapter admission bounds outstanding
  requests at **16** and aggregate serialized arguments at **256 KiB**; a single
  argument/result/error payload is limited to **256 KiB**. Normal queued replies
  have a separate **256-KiB** budget until `reply-received`. Overflow returns a
  bounded control error (a separate allowance of up to 16 bounded diagnostics
  plus protocol text); a call that already ran must not be replayed. Count
  covers tiny-request overhead; 16 permits four active plus three four-call
  batches, while bytes reuse the cell-output envelope. These are injectable
  safety limits, not measured optimal batching or total-allocation bounds.
- Successful completion waits for the program and tracked transitive tool calls,
  including Promise reactions and calls introduced by getters/`toJSON` while
  serializing the selected value **once**. Recheck admission after argument
  serialization too: serialization is user code. Caught rejections retain JS
  semantics; floating/unhandled failure cannot silently become success. This
  is not arbitrary future-JS quiescence or an implicit detached-call API.
- **Revised failed-cell policy:** failure/termination/close fences new calls,
  cancels unsent queue/approval waiters independently of an abort-ignoring
  predecessor, and cooperatively aborts dispatched unsettled work. Effects
  counts distinguish completed/failed/cancelled/unsettled calls; they are not
  per-file rollback receipts. Undeliverable replies or unsettled effects are
  explicitly unknown. Worker exit or terminal delivery does not release owned
  host effects; these still occupy admission, and close can fail for retry.
- Four cells may run; up to 16 unread terminal records are retained with lazy
  five-minute pruning. Per-cell observations are serialized, with one terminal
  winner and stale losers. Unconfirmed worker stop retains `cellId`, wakes long
  polls and allows another bounded stop attempt. A stop, abort or close that
  arrives after the program has finished keeps its known result, and a program
  that finishes after an unconfirmed stop drops that stop's provisional
  uncertainty. A worker that does not exit after its program has finished, for
  example because a callback the program scheduled keeps it busy, is terminated
  after a short grace. Code is never replayed.
- Independent `shells` metadata is obtained from actual shell liveness, not
  selected/printed JS values or mere handle existence. It survives omitted,
  clipped and failed returns. An intentionally yielded shell stays Shell-owned;
  use direct `write_stdin` or a new `exec` declaring `write_stdin`, not cell
  `wait`. Code Mode cleanup does not kill these independent shells.
  A cell's failure, stop or close ends its nested polls of such a shell without
  stopping it; cancelling a direct `exec_command` or `write_stdin` still stops
  the job.
- `yieldTimeMs` and `maxOutputBytes` match Shell ranges/defaults. Emitted-output
  preview is 256 KiB buffered, selected result 32 KiB, error 4 KiB. Final text
  uses literal strings/compact JSON under **331,776 bytes** (262,144 + 32,768 +
  4,096 + 32,768 control room). Status, uncertainty, live shells and recovery
  precede clipped payload; structured in-budget values remain in details.
  `clipping.{output,result,error}` distinguishes preview limits. See §5.9.

Permission boundary: Pi emits `tool_call` / `tool_result` only for the outer
`exec` / `wait` call, whose `input` contains the full `code` and the `uses`
declaration. Nested dispatch through public extension APIs cannot emit those
events, so native per-nested-call hooks and third-party permission interceptors
do not observe nested calls. Bounded nested start/waiting-approval/end records
are forwarded on the outer call's ordinary update callback; they carry the
adapter name, `cell_id`, an optional `session_id` and an outcome code, are
capped per call, and are not native nested events. The Toolkit retains the
outer gate, validates `uses` for supported adapter dispatch, and adds a
Toolkit-level confirmation before the mutating `apply_patch` adapter; this is
not native nested permission equivalence or hostile-code containment.
`codeMode.approvalMode` is `"confirm"` (default; requires a dialog-capable
context and uses `ctx.ui.confirm`) or `"always"` (skip this extra
confirmation). Only Apply Patch is classified for this gate; shell can mutate
files too and keeps direct-shell authority. The confirmation is asked for at
the actual nested dispatch: a headless `confirm` cell that only declares Patch
runs and completes, and only an actual nested `apply_patch` fails
`approval-unavailable` before any mutation. A computed `tools[name]` call takes
the same path, and the saved mode is never switched automatically. Docs,
`/pct status`, and this section disclose the boundary; cooperative opt-in hooks
for other extensions are possible later additive work.

Config default-off keeps `exec` / `wait` inactive. Unchanged `/pct reload` and
ordinary model changes preserve cells. Disable/conflict requests cleanup;
incomplete cleanup retains actual ownership, not guaranteed usable tool wrappers.
Session replacement and recovery-file expiry follow §7; transcripts never
recreate executions.

### 5.8 Tool Discovery

Tool Discovery is an independent default-off switch and provider-neutral. It
adds one owned ordinary name, `find_tools`, and hides only the names explicitly
listed in `toolDiscovery.deferred`. It does not depend on Code Mode, does not
change any feature's executor, and makes no network request of its own.

Contracts:

- `find_tools.query` searches the managed set's names and descriptions and
  returns at most eight matches with a one-line summary and each match's state
  (`active`, `eligible`, or `unavailable: <reason>`).
- `find_tools.load` takes exact managed names, revalidates each one, and adds
  eligible names with `[...active, ...eligible]` so unrelated active tools are
  never removed and repeated loads are no-ops. Ineligible and unmanaged names
  are reported in `rejected`; only malformed input, a disabled tool, or a
  missing argument throws.
- A name is eligible only when this extension owns the visible `getAllTools()`
  winner, the feature is enabled, and any decision-gated runtime decision used
  by synchronization reports the feature active. A foreign winner or an absent
  name (for example removed by a Pi `--tools` allowlist) is unavailable.
- The Computer Use group is atomic for discovery: the configured list must
  contain all six names or none, and a group load validates every member and
  rejects the whole group when any member is ineligible. Shell Sessions and
  Code Mode are joint pairs: a load of either member requires both members to
  be eligible (a conflicted or absent sibling rejects the request), but only
  the requested name is activated.
- Deferred names stay hidden until loaded in this session. Loaded names persist
  across an unchanged `/pct reload` and ordinary model changes; a new, resumed,
  or forked session starts hidden again, and no load is persisted or replayed.
  While discovery is off, the Toolkit forgets the session's loads, so
  re-enabling starts hidden again.
- Disabling discovery or a `find_tools` conflict (including an absent name)
  removes only `find_tools` and restores the ordinary owned projection. A
  feature disablement or conflict removes only the affected name. `/pct status`
  reports `deferred` when a capability would otherwise be `active` but Tool
  Discovery is still holding back every deferred member; `active` means the
  model can call it now.
- Discovery manages only Toolkit-owned tools. Third-party tools require
  explicit participation with an identifiable source/activation contract; the
  Toolkit never guesses a third-party executor, rewrites another extension's
  tool, or treats a user-disabled name as loadable.

Enable discovery only where the managed set removes schemas that would
otherwise be active and the task tolerates an extra discovery round. The
[dated verification summary](#9-protocol-probe-status) records deterministic
coverage, historical measurements and live-run limitations; those results do
not promise universal token, latency or selection-quality savings.

### 5.9 Execution-output recovery

`ExecutionOutputOwner` is shared by Shell and Code for one actual Pi execution
session. It is not universal tool archival. Each shell command has separate
decoded stdout/stderr captures; each cell has emitted text plus serialized
**selected** result/error captures. Console object formatting remains emitted
text (bounded-depth inspection), not recovery of all object internals. No binary
fidelity, every intermediate value/error, source-code, argument, environment,
prompt or reasoning archive is promised; nothing is uploaded or sent to a
reducer model by this mechanism. Output itself may contain any of those secrets.

A separate cumulative prefix survives preview reads. Crossing its memory budget
spills prefix plus later text, not just the unread tail. Yielding publishes stable
paths even for empty live streams; terminal clipping also publishes before
handle release. A small fully delivered terminal command/cell needs no file.
One logical capture spans every poll; polling does not create duplicate logs.

- Lazy `mkdtemp` private directories under OS temp and exclusive `wx`/0600 UUID
  files accept no tool-chosen paths. Identity-checked, nonrecursive cleanup
  removes only owned files, never foreign entries or image artifacts.
- Each capture admits at most **16 pending chunks** and
  **max(2 × prefix budget, 64 KiB)** pending bytes. Prefix budgets match previews:
  256 KiB per shell stream/cell output, 32 KiB result, 4 KiB error. Two budgets
  accommodate prefix plus producer chunks; the count bounds tiny-chunk overhead.
  Shell pauses each pipe until append settles. Code uses one shared producer
  credit for at most 8,192 UTF-16 units / 32 KiB per chunk; only the worker blocks
  on `Atomics.wait`, and the host returns credit **after capture append**.
  A transport ACK/credit is not application-effect acknowledgement.
- Recovery snapshots are `{state, path?, bytes, capturedBytes, reason?}`.
  `bytes` counts producer-offered UTF-8 bytes; `capturedBytes` counts confirmed
  writes (a timed-out write may later write more). `capturing` is a snapshot,
  `complete` means the selected capture ended without known loss, and neither
  certifies execution success. `partial` is incomplete file capture;
  `unavailable` includes missing/replaced paths. Reasons include `io-error`,
  `io-timeout`, `overload`, `source-error`, `missing`, `owner-closed`.
- Capture faults preserve bounded previews and actual execution outcome, never
  replay/rollback. Interrupted worker capture is conservatively partial or
  unavailable. Oversized intermediate RPC errors do not poison an independently
  selected final error's capture. I/O waits default to 5 seconds; timed-out raw
  operations retain late-cleanup responsibility, not a proof all I/O stopped.
- Read returned absolute paths using an available native `read` (bounded line
  ranges) or authorized shell (explicit ranges). Paths are not execution handles
  or a new recall API. Files survive terminal-once delivery, pruning and feature
  disable/conflict until actual `session_shutdown` (§7). An old `capturing`
  snapshot cannot certify late completeness/outcome after its handle expires.
  Missing or partial evidence must be reported, never recovered by rerunning.
- There is **no per-job/aggregate disk quota or file TTL** and no cross-restart
  retention/scavenger. Five-minute pruning concerns handles only. Disk exhaustion
  is a capture-failure path, not unlimited-storage safety; long sessions can grow
  disk use. Abrupt death, uncooperative work or hung storage can leave files.

### 5.10 Invocation seam

One generic seam serves the direct tools and the nested Code Mode adapters:

```text
normalized call → admission/ownership → invocationHooks.context(call)
  → invocationHooks.policy(call) → Code Mode Patch approval (nested only)
  → executor
```

`call` is `{ tool: "exec_command" | "write_stdin" | "apply_patch", path:
"direct" | "nested", cwd, cellId?, sessionId? }` — control identity only. An
embedder installs the hooks through the named `createPiCodexToolkit(options)`
factory; the default extension export Pi loads installs none, and there is no
built-in caller.

- `context().env` is a trusted per-call overlay merged over the manager's
  captured environment for one spawn. It never mutates that environment or
  `process.env`, never persists into a later call, and never crosses sessions.
  A malformed overlay rejects before the spawn.
- `policy()` denies before any effect and names the hook's reason. Denial is not
  a retry path and never reroutes the call through another entry.
- The seam is orchestrator-neutral: it reads no environment variable of its own,
  derives no task markers, imports nothing private, and emits no Pi
  `tool_call` / `tool_result` event for a nested call. A supplied environment
  reaches child processes exactly as an inherited one does.
- A separately planned Toolkit permission engine integrates here rather than
  gating only the direct tools.

## 6. Authentication and official-route boundary

Authentication comes from Pi's model registry/auth API. The toolkit does not parse private credential files or extract tokens from ChatGPT.app.

The route resolver distinguishes at least:

- ChatGPT/Codex OAuth: only normalized `https://chatgpt.com/backend-api/codex/...` routes.
- OpenAI API keys: only normalized `https://api.openai.com/v1/...` routes.

Reject HTTP, userinfo, lookalike hosts, and arbitrary third-party gateways. A future gateway feature must use separate explicit credentials and configuration; it may not reuse ChatGPT OAuth.

This is not a generic SSRF framework. It is the smallest necessary boundary that prevents high-value credentials from being sent to the wrong host.

## 7. Tool activation and lifecycle

The toolkit changes only tool names it owns. Synchronization occurs after:

- `session_start`
- `model_select`
- saving `/pct config`
- `/pct reload`

Pi's `setActiveTools` replaces the full active-name list. Synchronization therefore reads the current list, adds or removes only Toolkit-owned names, and writes only when the list changes. If `getAllTools()` shows that another extension owns the winning registration for the same name, the Toolkit reports a conflict and does not mutate that name.

Under execution rules, `/pct status` separates the two ways an owned execution
name can be unavailable: a **visible foreign winner** is `conflicting-tool-name`,
while a name the host filtered out of the projection is absent and the row
reports the committed route's admission note instead. The rows and the appended
`Execution rules:` block therefore never contradict each other. Legacy
flag-managed rows keep reporting absent-or-foreign as `conflicting-tool-name`.

Do not synchronize before every request or in `before_agent_start`. Doing so would overwrite temporary Pi `/tools` choices and can make the current prompt disagree with the tool schema.

`/pct config` is persistent authority; Pi `/tools` is a temporary override for the current model phase. A model switch or `/pct reload` reapplies persistent configuration.

When two Pi tools share a name, extension load order determines which implementation wins. The toolkit uses Pi's public tool metadata only for the ownership check above; it does not disable or rewrite the other extension. These overlapping implementations remain incompatible:

- Another Remote Compaction extension.
- `pi-codex-computer-use` and this project's Computer Use.
- Another `openai_generate_image` or `openai_web_search` implementation.
- Another `apply_patch` implementation.
- Another `exec_command` or `write_stdin` implementation. Shell Sessions is an
  atomic two-name group: any conflict disables both Toolkit names and preserves
  the third-party winner.
- Another `exec` or `wait` implementation. Code Mode is an atomic two-name
  group with the same rule; conflict requests cleanup and retains its manager
  if cleanup is incomplete.

Execution managers and output files have separate lifetimes:

| Event | Execution / client cleanup | Published recovery files |
| --- | --- | --- |
| Ordinary model change, unchanged Toolkit `/pct reload` | Preserve Shell/Code live work; reuse Computer Use client only while still eligible and using the same approval mode; no replay | Preserve |
| Feature disable or visible owned-name conflict | Fence/request affected-manager cleanup; retain actual responsibility if incomplete; Code-only cleanup leaves independently yielded shells | Preserve shared session owner |
| Attempted new/resume switch or fork/clone through public `session_before_switch` / `session_before_fork` | Independently attempt Shell, Code and all owned Computer Use client cleanups; any failure returns `{cancel:true}` to veto replacement, retaining incomplete cleanup ownership for retry | Preserve: another extension can still cancel after successful cleanup |
| Actual `session_shutdown` | Fence execution; independently attempt Shell, Code and Computer Use cleanup; rebind only after confirmed execution cleanup on reuse | Expiry boundary: close owner only after producers settle; remove only owned files |

A cancelled switch/fork is **not rollback**: some jobs may already have stopped,
and successful Computer Use client disposal may already have discarded its
client-scoped app grants, including when another extension cancels later. New
work can start if preflight succeeded but shutdown never happened; old files
remain. Failed Code cleanup retains its manager for existing-cell control and
cleanup retry, not permission to start new cells. Incomplete Computer Use cleanup retains reachable
client ownership in this factory; retry through a tool/status/Toolkit reload or
the session change, without replaying actions.
A genuine new-session guard was tested on both public hosts; fork preflight has
factory coverage, not a fresh interactive/actual-fork qualification.

Toolkit `/pct reload` only rereads its configuration. Pi resource `/reload`,
quit and emergency teardown have **no cancellable execution preflight here**;
a shutdown-hook exception cannot prevent host replacement. Work/files can remain,
and old handles are not usable after factory replacement; Computer Use cleanup
references do not survive host replacement either. Actual shutdown is the
file-expiry boundary even when resource reload preserves conversation identity.
Neither normal cleanup nor process death implies restart attachment, replay or
unconditional cleanup of escaped processes/hung I/O.

Pi 0.84.4's public active-tool projection omits constrained-sampling metadata.
The toolkit restores its local grammar only when both the winning name and
`sourceInfo.path` identify this extension's own registration. A third-party
winner keeps its own JSON-visible schema and never receives Toolkit grammar.

That identity is the extension file Pi loaded, which is not always
`src/index.ts`: an embedder that default-exports `createPiCodexToolkit(...)`
from its own extension file makes Pi attribute every Toolkit registration to
that file. Each factory therefore resolves its own identity once — from the
`sourceInfo.path` the host reports for registrations whose parameter schema is
the object this factory handed to `registerTool`, so a third-party winner on
an owned name cannot decide it — or from the embedder's explicit `sourcePath`
option. Those schema objects are cloned per factory (identical JSON, identical
validation), so two factories built from one imported module never vote with
each other's registrations. When a factory can prove none of its own
registrations, the identity stays unresolved and it owns nothing: every
ownership answer is `absent`, no route activates and no builtin is hidden.
Nothing is memoized in that state, and an embedder that needs a fixed identity
regardless pins `sourcePath`. Resolution is identity only: it never makes a
third-party registration callable.

That identity also keys the record of which builtins this extension hid.
Pi's `session.reload()` rebuilds the factory against the already-filtered
active list, so the admitted-native baseline and the suppression it owns are
kept for the process, under the resolved identity and then the session lineage
(session file, else session id). A factory that resolves no identity owns
nothing and therefore records nothing: loading the package beside a wrapper —
or two SDK factories from one module — leaves the winner's history intact, so
turning the rules off and reloading still brings `bash`, `edit` and `write`
back. Identity is resolved before that hydration; a factory still unresolved
at `session_start` defers it to its first synchronization that resolves one.
Only a reload inherits a lineage's record; resume and fork recapture from the
host's own defaults.

When Tool Discovery is enabled and the `find_tools` loader is available, the
same synchronization pass also omits every configured deferred name that
`find_tools` has not loaded in this session, and adds `find_tools` only when
its own visible winner is Toolkit-owned. Loaded deferred names then follow the
ordinary rule for their feature. Disabling discovery or losing the `find_tools`
name restores the ordinary owned projection; it never rewrites or deactivates a
third-party registration and never revives a user-disabled tool. A `find_tools`
conflict does not forget the session's loads; only disabling discovery does.

## 8. Errors, cancellation, and logging

### Error principles

- An unavailable capability disables or errors only that capability; extension startup continues.
- Native Search and Remote Compaction leave requests unchanged when inapplicable.
- Sidecar Search errors the current tool call directly; it does not retry, change executor, or fall back to Native Search.
- Remote Compaction failure returns to Pi native compaction.
- Apply Patch finishes preflight and staging before commit; it never retries or rolls back a partial commit and reports completed plus failed/unknown operations.
- Image Generation and side-effecting Computer Use calls do not auto-retry after dispatch.
- App-server exit rejects pending requests and drops the ephemeral thread; the next call may start a new process.

### Debug logging

One `debug` boolean writes metadata to stderr. Allowed fields:

- Feature and provider/API/model ID; the Remote Compaction record adds
  `outcome`, `reason`, and its item counts, which belong to this list as
  categories and counts.
- Endpoint host, without path query or authentication.
- Duration, HTTP/RPC status, and request ID.
- Content-block types and counts.
- Error category without payload.

Never log headers, tokens, prompts, tool arguments/results, screenshots, base64, opaque checkpoints, or readable compaction fallback. A generic redactor is unnecessary when these values are never collected.

## 9. Protocol probe status

This self-contained summary distinguishes source tests, deterministic native
host checks, live model probes and release artifacts. Raw development logs are
not public evidence dependencies; counts below describe bounded runs, not
independent reproduction of every result or proof of universal compatibility.

### Release baseline and source-only qualification

A read-only inspection on **September 13, 2026** observed npm 0.1.0 (published
August 31, 2026) and the public annotated `v0.1.0` tag. The inspected npm
artifact had the original five capabilities, without Shell Sessions, Code Mode
or Tool Discovery. This is a dated observation, not a fresh registry/default-
branch lookup, full Git/npm byte-parity proof or package-manager install test.
The development source at that time also used 0.1.0 metadata, which did not
identify those published bytes. Version 0.2.0 is a separate release target;
the historical checks below are not validation of its final artifact.

The **September 15, 2026** documentation/distribution check is limited to
source policy and focused regressions, actual dirty-checkout npm inventory,
and a small explicitly selected source-only archive. Its two offline Pi
0.84.4 loads use existing linked peers, combined stdout/stderr and an independent
eight-capability configured/effective-off validator, with network intercepts
and no Toolkit configuration/artifact creation. This is pack/unpack/loader
qualification, not a fresh npm installation, GitHub Actions run, live model
probe or publication. Public docs include only `docs/en/`, `docs/zh/` and
`docs/third-party/`; private research is excluded from Git export and npm, while
root and third-party license/notice files remain included.

### Scoped test-engineering checks

On **September 15, 2026**, local macOS arm64 / Node26.8.2 checks added
opt-in fixture ownership through actual shutdown, including partial setup,
failed bodies and retained late cleanup. Controlled Shell probes demonstrated
startup-readiness and delayed-observation test races; the repaired test uses
explicit ordering without changing runtime budgets or weakening uncertainty
and exact-output assertions. The original external failed assertion remains
unavailable; no Linux failure frequency is inferred.

The initial September 15 native Web Search-only check measured **38.90% lines /
11.11% functions / 100% branches** of `src/status.ts`, leaving eight functions
unexecuted. That historical branch figure did not qualify the complete module.

The same day's maintenance check on macOS arm64 / Node26.8.2 expanded
`npm run test:coverage` to **92 shared literal contracts plus one matrix
inventory assertion (93/93)**. It retains the 33 Web Search cases, adds 43
cases for the other six selectors, 13 complete projections and three complete
eight-section formatter outputs. Projections preserve the independent Native Search
search-path warning without a foreign tool conflict, as well as the combined case.
All nine functions are exercised; the named
file measured **100% lines / functions / branches**, with no uncovered ranges.
Enforced floors are **98% lines / 100% functions / 100% branches**. The bounded
two-percentage-point line margin tolerates small source-layout/counter changes,
not omission of required behavior or any function/branch guard reduction. A
real Web Search-only subset passed 34 assertions but exited 1 under these valid
floors, with actual coverage diagnostics. No dependency/remapper is added.
These are Node-native case metrics, not Istanbul statements, whole Vitest,
project/inline-worker coverage or exhaustive semantic assurance. Full tests,
typecheck and formatting remain separate gates.
The existing Linux Node22.19/24.20 CI lanes declare this public-source command;
local Node26 results and documented type stripping do not qualify those lanes.
Existing offline host probes and Windows limitations remain unchanged.

### Historical repair and synthetic-host checks

**Source-repair evidence, September 13, 2026:** the independent stage-3
review recorded **516/516 maintained tests in 35 files** (the focused 241/241
checks are included), typecheck and formatting passes on macOS arm64 / Node
26.8.2. Public root exports, real resource loading/binding and ordinary
AgentSessionRuntime turns passed on repository **Pi 0.84.4** and installed host
**0.85.1**. The source reviewed that day was temporarily staged with peers
resolved to each selected host; the old installed Toolkit pin was not updated or qualified.

The provider was a deterministic local event stream, not a live model or direct
ToolDefinition mock: real outer `tool_call` blocks prevented effects and
`tool_result` transformations reached subsequent provider context. Native `read`
recovered Shell/Code files, hidden shell adapters worked, headless Patch
confirmation blocked, feature disable preserved files, and actual `newSession`
removed them. Injected signal refusal vetoed replacement; control and replacement
retry then succeeded. Zero fetch attempts. Nested calls did not emit native
hooks. No fresh live/paid model efficiency, Linux/Windows/minimum-Node,
interactive UI, actual fork/resource-reload or third-party combination claim.

The **September 14, 2026** Computer Use follow-up used a synthetic native
client probe, not a desktop or live model: approval waiting exceeded 135 seconds
without consuming the configured execution budget; a separate 500-ms active
control preserved unknown-outcome/inspection gating. Maintained tests also
covered stale timer callbacks and all-owned-client lifecycle cleanup. These
client-level checks do not qualify native factory/UI rendering, arbitrary RPC
frontend dismissal, real desktop actions or forced effect termination.

### Historical feature gates and limits

The following are **historical feature gates**, not reruns on repaired code.
Shell/Code/Discovery live reports are dated September 10, 2026; their small-
fixture results do not certify the repaired prompts, recovery or failure policy.
Other feature results below retain the scope recorded before the September 13
review; missing exact run dates are not replaced with that review date. API-key
Search/Image live routes were not tested because the probe environment lacked
an eligible provider/model. Account failures below describe those historical
attempts, not current account availability:

1. **Remote v2:** passed two consecutive official Codex compactions plus restart, resume, fork, disable, model-mismatch, and normal-turn checks.
2. **Web Search:** deterministic `off/native/sidecar/auto` coverage and two consecutive Native turns plus the OpenAI → non-OpenAI → OpenAI status cycle passed. The Codex OAuth protocol probe completed one hosted request with answer and sources. A real Grok 4.6 RPC session then selected `openai-codex/gpt-5.4` with `low` executor effort and completed one Sidecar Search with non-empty answer and sources, one Search dispatch, and no native hosted Search tool on the Grok request. The above-128k input and non-OpenAI-main-model API-key live probes remain pending.
3. **Image Generation:** the ChatGPT/Codex OAuth Pi result and follow-up live gate passed with a Codex main model. The same Grok 4.6 RPC session completed one Images dispatch, returned a valid persisted PNG, and then completed a no-tool follow-up without another Search or Images dispatch. The OpenAI API-key live probe remains pending.
4. **Apply Patch:** deterministic tests cover grammar and JSON transport,
   parsing and matching, containment and file fidelity, staging cancellation,
   partial commit reporting, queue coordination, activation, and conflicts.
   The MVP has no credentialed provider live gate because execution is a local
   ordinary Pi tool.
5. **Computer Use:** in isolated real Pi probes, invoke only `list_apps`
   and one benign `get_app_state`, verify native text/image blocks and cleanup,
   then complete a normal follow-up turn. No action method is part of this live
   gate. The 2026-08-29 isolated probes passed the bundled-runtime preflight,
   `list_apps`, the final one-call `get_app_state` text/JPEG result, a no-tool
   follow-up, and cleanup. They dispatched no action, made no permission change,
   and retained no app inventory, accessibility text, or screenshot payload.
   The corrected client-Set build then passed the complete real-Pi
   `Confirm` / `Always` matrix: same-app Yes-once, independent app confirmation,
   No-then-reprompt, unchanged `/pct reload`, `/new` reset, `Always` across
   `/new`, and a normal no-tool turn. This matrix also used state reads only and
   made no permission change.
6. **Shell Sessions:** deterministic process fixtures pass continuation,
   stdin, quiet/bursty output, UTF-8 chunk boundaries, nonzero exit,
   truncation and buffer drops, termination with children, bounded escalation,
   stale handles, competing reads, the session cap, and close. Bounded live
   workflows passed on DeepSeek (`deepseek/deepseek-flash`, thinking `max`) and
   Kimi (`kimi-coding/k3`, `max`); Grok (`cliproxy-grok/grok-4.6`, `xhigh`)
   passed continuation, termination, and stale-handle scenarios but
   mis-escaped the interactive newline in all four observed runs (byte-exact
   forwarding confirmed; 1/4 reached a clean `got:hello`). A strengthened
   `write_stdin` description then removed the observed failure in 6/6 A1+A2
   follow-up runs on the same route, though this is a bounded mitigation
   rather than a universal guarantee and other routes or models may still
   mis-escape. OpenAI
   (`openai-codex`) is **not run**: the account
   rejects `gpt-5.4` and returns a usage limit for `gpt-5.6-luna`/`gpt-5.5`.
   No live support is claimed for OpenAI. These are bounded workflow and
   newline-mitigation observations, not a cross-provider support guarantee.
7. **Code Mode:** deterministic worker, adapter, tool, and lifecycle fixtures
   pass fresh-state, wait-cursor, CPU/output bounds, partial effects after
   errors, rejected or unapproved dispatch, sequential ordering inside
   concurrent code, default-off projection, atomic conflict deactivation, cell
   release on disablement, preservation across an unchanged `/pct reload` and
   ordinary model changes, and independent shell survival. Bounded paired live
   runs on Pi 0.85.1 with DeepSeek (`deepseek/deepseek-flash`, `max`), Grok
   (`cliproxy-grok/grok-4.6`, `xhigh`), and Kimi (`kimi-coding/k3`, `max`) were
   correct in all 33 executed runs: 3/3 `pair` repetitions per model plus the
   `single`, `filter`, and `fault` controls; each `fault` run wrote its marker
   exactly once, reported the completed action, and did not retry. Benefit is
   mixed in this small fixture: composition sometimes cut top-level rounds (Grok 3 calls
   vs 6, DeepSeek 7 vs 6) but did not consistently reduce tokens or latency
   (DeepSeek paid roughly 8x output tokens and 3.5x wall time; Grok was roughly
   neutral; Kimi matched ordinary mode apart from one 14-turn outlier that
   retried an unavailable `setTimeout` helper). Live validation also found and
   fixed an adapter-gating defect: direct tool names filtered out of
   `getAllTools()` by the user's `--tools` allowlist were misread as ownership
   conflicts and disabled every nested shell adapter; one early probe model
   then fabricated output. Adapters now disable only for a visible foreign
   winner. Code Mode remains optional and default-off, with no universal token
   or latency claim. OpenAI (`openai-codex`) is **not run** because
   `gpt-5.6-luna`/`gpt-5.5`/`gpt-5.4` return a usage limit; no live Code Mode
   support is claimed for OpenAI. These comparisons measure the specified
   small scenarios, not general performance or hostile-code containment.

8. **Tool Discovery:** deterministic tests cover the managed-set contract,
   exact/descriptive/no-match queries, bounded results, additive and idempotent
   loads, atomic Computer Use group validation, disabled and conflicting-name
   rejection, discovery off/on lifecycle, reload and model-change preservation,
   new/resume/fork re-hiding, config-disabled rejection, and unrelated-tool
   preservation through the real extension factory. Historical September 10
   description slimming removed 1,029 characters from `write_stdin`, `exec`,
   `exec_command` and `wait` without changing schemas or validators. The all-on
   DeepSeek fixture's emitted `tools` JSON fell from 12,701 to 11,672 bytes.
   Deferring all 13 names then cut it to 3,907 bytes (11 → 5 tools, −66.5%).
   The default deferred set (Image Generation and six Computer Use tools) was
   net-negative in headless print mode: those tools were inactive while
   `find_tools` itself cost about 1 KB. These are not current schema sizes.
   Bounded live runs on DeepSeek
   (`deepseek/deepseek-flash`, `max`), Grok (`cliproxy-grok/grok-4.6`,
   `xhigh`), and Kimi (`kimi-coding/k3`, `max`) completed the
   tasks correctly in 18/18 runs (9 ON discovery, 9 OFF baselines). The 9 ON
   discover → load → call runs needed 2–5 extra turns and more tokens; Grok
   was most efficient and DeepSeek least. Discovery stays default-off with a
   conditional recommendation and no universal saving claim. OpenAI
   (`openai-codex`) is **not run** because its Codex models returned a usage limit.

If a probe fails, narrow or defer that capability. Do not build a generic
compatibility layer merely to pass a probe.

**Pi 0.86.0 offline qualification, 2026-09-20:** development peers and
`^0.86.0` Pi peer ranges; Sidecar/Remote transcript normalization; Remote
capture of current tools without saved native `systemMessage`; `session_tree`
owned-tool re-sync; SessionManager persist/open/fork of native compaction
state; and host tree-navigation plus modeled cache-warming transform replay.
The bounded live follow-up on the same date passed nine Codex OAuth requests
with `openai-codex/gpt-5.6-luna`: Sidecar and Native Search, two Remote
compactions, open/fork replay with disabled Apply Patch absent, and one manual
warming-equivalent replay of the saved SDK context/callback. The current model
has no cache TTL; the host reported `cache lifetime unavailable` and dispatched
zero automatic warming requests. Ordinary caching still worked. The manual
replay used 4,874 input tokens (3,328 cached) and six output tokens: Pi's
`maxTokens: 1` did not become a Codex wire output cap. Its standard API-equivalent
cost was $0.00038296, not an observed OAuth subscription charge or proof of
long-term savings. Linux CI, API-key routes and other model/feature live gates
are outside this follow-up. Older dated records in this section are unchanged.

**Pi 0.87 series offline qualification, 2026-09-22:** peers are `^0.87.0`
(`>=0.87.0 <0.88.0`) and development dependencies pin `0.87.0`. 0.86.x is no
longer declared. On installed Pi 0.87.0, both TypeScript projects passed, and
the offline suite passed once the release check expected that pin. The real
`/pct status` print run exited 0 with empty stdout, every capability off, and
no Toolkit config or artifact. The Codex Responses adapter and Codex model
catalog are byte-identical to 0.86.0, and this host move changes no product
logic. It does not repeat the 2026-09-20 Codex OAuth live follow-up, does not
add a `context_edit` fixture, and does not claim Linux CI or 0.88
compatibility. The 2026-09-20 record above stays historical.

## 10. Delivery order

Historical implementation sequence, not a claim that every item shipped in
0.1.0. Dated measurements and source qualification are in [§9](#9-protocol-probe-status).

1. Foundation: configuration, `/pct`, status, official-route/auth, and debug metadata.
2. Core Search/Responses: unified Web Search configuration, Native/Sidecar paths, and the Remote Compaction probe/implementation.
3. Image Generation: one-image generation, artifact persistence, and Pi image result.
4. Apply Patch: one default-off provider-neutral tool, bounded parser, static containment, and staged per-path commit.
5. Computer Use: six default-off tools through the narrow node_repl/Sky runtime,
   with a separate read-only live gate.
6. Shell Sessions: one default-off session-owned process manager and two
   ordinary tools, independent of Code Mode, with a later bounded four-family
   live validation.
7. Code Mode: one default-off bounded cell manager and two ordinary tools over
   explicit adapters that reuse the Shell Sessions and Apply Patch executors
   rather than adding another backend.
8. Tool definition efficiency: on-demand discovery for explicitly managed
   default-off Toolkit tools, then definition slimming, measured against the
   full task and startup cost rather than tool-name counts. The historical
   comparison in §9 supports only conditional use, not universal benefit.
9. Evaluate webpage fetching, image editing, or more Computer Use actions only after real demand.

## 11. Key acceptance criteria

- With every switch off, provider requests and Pi native compaction remain unchanged.
- An incompatible provider/endpoint receives neither OpenAI/Codex credentials nor payload changes.
- Payload merging preserves existing tools, includes, and unknown fields.
- `auto/native/sidecar` selects exactly one toolkit search path across model switches; a non-OpenAI main model can obtain an answer and clickable sources through its selected executor.
- Sidecar does not automatically attach the full main conversation history; it sends the main-model-generated query verbatim, and failure does not dispatch a second search request.
- Remote Compaction preserves context across two compactions and session restore; incompatible switches use readable fallback.
- Generated images are saved as unique artifacts and displayed in Pi without implicit retry.
- Apply Patch uses the same executor for grammar and JSON calls, preserves file fidelity, finds predictable failures before mutation, and reports non-transactional commit failure truthfully.
- Missing or drifting Computer Use dependencies do not affect other features; desktop actions are sequential and never auto-replayed.
- Shell Sessions launches once, preserves decoded UTF-8 and separates job/stream/group settlement from observation. Independent same-session recovery survives preview/handle loss; input and cleanup uncertainty never justify replay.
- Code Mode settles tracked transitive work including selected-value serialization, fences failed cells, retains unresolved effects and independent shell controls, and bounds transport/presentation without claiming a sandbox.
- Execution disable/replacement cleanup and recovery expiry follow §7, including failed preflight veto, no rollback and non-cancellable teardown limits.
- Tool Discovery loads only explicitly managed, Toolkit-owned, currently eligible names; it cannot revive a disabled or user-filtered capability, replace a conflicting registration, split the atomic Computer Use group, or remove unrelated active tools, and no discovery state survives a new/resume/fork session.
- `/pct status` explains each implemented capability's effective state (`active`, `deferred`, `unavailable`, or `off`) and reason.
- Debug output contains no authentication, prompt, image, or checkpoint content.

## 12. References

- [Codex source](https://github.com/openai/codex)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
- [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [OpenAI Image Generation](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI Apply Patch](https://developers.openai.com/api/docs/guides/tools-apply-patch)
- [Pinned Codex Apply Patch source](https://github.com/openai/codex/tree/b8c86376a258e55efc8e5ecfbabc21c16c07d814/codex-rs/apply-patch)
- [Pi source](https://github.com/earendil-works/pi)
- [pi-openai-toolkit](https://github.com/awoaCrim/pi-openai-toolkit)
- [pi-mono](https://github.com/jvm/pi-mono)
- [pi-web-access](https://github.com/nicobailon/pi-web-access)
- [pi-codex-computer-use](https://github.com/danecando/pi-codex-computer-use)
