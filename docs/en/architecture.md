# Pi Codex Toolkit Architecture

> Status: implemented through the Apply Patch MVP; the Computer Use read-only Pi 0.84.4 live gate passed on 2026-08-29
> Last reviewed: 2026-08-30

## 1. Decision

Pi Codex Toolkit is not another Codex frontend and does not take over Pi's agent loop. It adds a small set of bounded OpenAI/Codex capabilities to Pi's existing lifecycle:

1. Inject native Web Search into official OpenAI/Codex Responses requests.
2. Expose OpenAI sidecar search to other main models as a regular Pi tool.
3. Attempt Codex Remote Compaction v2 when Pi decides compaction is needed.
4. Expose OpenAI/Codex image generation as a regular Pi tool.
5. Expose a provider-neutral `apply_patch` tool with Codex-compatible patch syntax.
6. Bridge local Computer Use through ChatGPT.app's bundled Codex app-server,
   `node_repl`, and the trusted `@oai/sky/service` runtime.

Pi continues to own the conversation, tool loop, session tree, compaction timing, and ordinary coding tools. The project adds only the bounded Apply Patch editing primitive; it does not reproduce Codex shell, PTY, `view_image`, goal, plan, review, or multi-agent semantics.

The governing principle is: **enhance Pi; do not run a second Codex agent inside Pi.**

Capabilities are provider-neutral by default. If the main model can call ordinary Pi tools, Sidecar Search, Image Generation, Apply Patch, and Computer Use do not switch off merely because of its provider. Native Search and Remote Compaction restrict providers only because their protocols are bound to the current OpenAI/Codex Responses session; Computer Use image/UI requirements are modality and runtime constraints, not provider restrictions.

## 2. Scope

### Core release

| Capability | Shape | Main-model restriction | Actual executor | Verification |
| --- | --- | --- | --- | --- |
| Native Web Search | Transform the current Responses payload | Official compatible OpenAI/Codex Responses route | Responses hosted tool | Two-turn live search passed; above-128k probe pending |
| Sidecar Web Search | Regular Pi tool `openai_web_search` | Any ordinary tool-calling main model; a separate OpenAI/Codex executor must be selected | Standalone Responses request plus hosted `web_search` | Codex OAuth protocol and Grok-main RPC acceptance passed; API-key deterministic only, live pending |
| Remote Compaction v2 | `session_before_compact` hook plus checkpoint replay | Official `openai-codex` provider/API/endpoint | Codex Responses | Consecutive compaction, restore, fork, and fallback live gate passed |
| Image Generation | Regular Pi tool `openai_generate_image` | Any tool-calling main model; separate OpenAI/Codex auth is required | Standalone Images API request | Codex-main and Grok-main OAuth live gates passed; API-key route deterministic only, live pending |
| Apply Patch | Regular, sequential Pi tool `apply_patch` | Any ordinary tool-calling main model | Local filesystem under Pi's current working directory | Deterministic parser, safety, commit, lifecycle, and transport tests |
| Computer Use | Six static, sequential regular Pi tools | MVP requires image input, macOS, and interactive UI | ChatGPT.app bundled `codex app-server` → `node_repl/js` → `@oai/sky/service` | Fake app-server tests, read-only live gate, and approval-mode matrix passed |
| Configuration and status | `/pct` and one JSON file | None | Pi extension | Unit tests |

### Experimental Computer Use boundary

| Capability | Shape | Main-model restriction | Actual executor |
| --- | --- | --- | --- |
| Computer Use | Static, sequential regular Pi tools | MVP requires image input, macOS, and interactive UI | ChatGPT.app bundled `codex app-server` → `node_repl/js` → trusted Sky service |

Computer Use is implemented behind a default-off experimental flag. Its local
dependencies and protocol-drift risk are materially higher than the Responses
features, so publication has a separate read-only acceptance gate; that gate
passed with the current paired desktop components on 2026-08-29.

The config schema and menu expose `computerUse.enabled` plus the two approval
modes `Confirm` and `Always`; no backend, installer, timeout, or compatibility
settings are exposed.

### Why Web Search has two paths

Native Search lets the current official OpenAI/Codex main model use the hosted tool directly. Sidecar Search lets Claude, Gemini, or another main model that supports regular Pi tools obtain an answer and sources through a separate OpenAI Responses request. The latter adds an OpenAI request, latency, and cost. The toolkit does not automatically attach the full main conversation history, but it sends the main-model-generated query verbatim to the executor; that query may quote or summarize conversation content.

The user does not need to install `pi-web-access`. This project implements only an OpenAI-only, query-only sidecar; it does not reproduce that extension's multi-provider router, fetchers, or fallback system. Both paths belong to one Web Search capability and are mutually exclusive within a turn.

### Explicit non-goals

- Codex backend mode, `dynamicTools`, or the full Codex agent loop.
- Reimplementing the full Codex shell/PTY/`view_image`/goal/plan/review/multi-agent surface, or the Responses API's first-class `apply_patch_call` protocol.
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
  openai/
    route.ts
    request-pipeline.ts
    native-search.ts
    sidecar-search.ts
    remote-compaction.ts
    image-generation.ts
  computer-use/
    app-server-client.ts
    tools.ts
```

Responsibilities:

- `index.ts`: register hooks, commands, and tools; no protocol logic.
- `config.ts`: own the single configuration type, defaults, validation, and persistence.
- `commands.ts`: thin UI for `/pct config|status|reload`.
- `status.ts`: project configuration, the current model, and external dependencies into user-readable status.
- `apply-patch.ts`: parse, validate, stage, and commit one bounded local patch; it does not own provider routing.
- `openai/route.ts`: resolve official routes and Pi authentication; this is the only boundary allowed to attach credentials to network requests.
- `openai/request-pipeline.ts`: one deterministic, idempotent Responses payload pipeline.
- The four OpenAI feature files own their protocols and result conversion; there is no generic feature interface.
- `computer-use/app-server-client.ts`: JSONL-RPC process lifecycle, handshake, request correlation, timeout, and shutdown.
- `computer-use/tools.ts`: fixed Pi tool schemas and MCP-content conversion.

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
and fully trimmed comparison must identify exactly one location.

All predictable failures are found before mutation: syntax and context errors,
path conflicts, containment, visible symlinks, UTF-8 validity, newline style, and
file type. Replacements are staged before a final abort check. Each committed
path is atomic, but a move or multi-file patch is not a transaction; commit
failure truthfully reports completed paths plus the failed or unknown operation.
There is no automatic retry or rollback. UTF-8 BOM, LF/CRLF style, final-newline
state, and ordinary POSIX executable bits are preserved.

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

Do not synchronize before every request or in `before_agent_start`. Doing so would overwrite temporary Pi `/tools` choices and can make the current prompt disagree with the tool schema.

`/pct config` is persistent authority; Pi `/tools` is a temporary override for the current model phase. A model switch or `/pct reload` reapplies persistent configuration.

When two Pi tools share a name, extension load order determines which implementation wins. The toolkit uses Pi's public tool metadata only for the ownership check above; it does not disable or rewrite the other extension. These overlapping implementations remain incompatible:

- Another Remote Compaction extension.
- `pi-codex-computer-use` and this project's Computer Use.
- Another `openai_generate_image` or `openai_web_search` implementation.
- Another `apply_patch` implementation.

Pi 0.84.4's public active-tool projection omits constrained-sampling metadata.
The toolkit restores its local grammar only when both the winning name and
`sourceInfo.path` identify this extension's own registration. A third-party
winner keeps its own JSON-visible schema and never receives Toolkit grammar.

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

- Timestamp, feature, provider/API/model ID.
- Endpoint host, without path query or authentication.
- Duration, HTTP/RPC status, and request ID.
- Content-block types and counts.
- Error category without payload.

Never log headers, tokens, prompts, tool arguments/results, screenshots, base64, opaque checkpoints, or readable compaction fallback. A generic redactor is unnecessary when these values are never collected.

## 9. Protocol probe status

These are release gates, not permanent frameworks:

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

If a probe fails, narrow or defer that capability. Do not build a generic compatibility layer merely to pass a probe.

## 10. Delivery order

1. Foundation: configuration, `/pct`, status, official-route/auth, and debug metadata.
2. Core Search/Responses: unified Web Search configuration, Native/Sidecar paths, and the Remote Compaction probe/implementation.
3. Image Generation: one-image generation, artifact persistence, and Pi image result.
4. Apply Patch: one default-off provider-neutral tool, bounded parser, static containment, and staged per-path commit.
5. Computer Use: six default-off tools through the narrow node_repl/Sky runtime,
   with a separate read-only live gate.
6. Evaluate webpage fetching, image editing, or more Computer Use actions only after real demand.

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
- `/pct status` explains each implemented capability's effective state and reason.
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
