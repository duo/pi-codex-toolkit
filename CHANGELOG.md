# Changelog

All notable changes to Pi Codex Toolkit are documented in this file.

## [0.2.0] - 2026-09-22

### Added

- Default-off Shell Sessions with resumable local commands.
- Default-off Code Mode over trusted per-call JavaScript workers and existing
  Shell/Apply Patch executors; not a security sandbox.
- Default-off Tool Discovery for explicitly deferred Toolkit-owned tools.
- Shell/Code output recovery across preview loss and handle release.
- Ordered model-matching execution rules with independent Patch, direct Shell
  and Code routes; an interactive editor supports migration previews,
  add/edit/delete/reorder and current-model previews.
- A shared supported Codex argument dialect for direct and nested execution
  tools, including `// @exec:` options. Unsupported PTY, sandbox and permission
  escalation fields are rejected before effects; this is not a Codex sandbox.
- Child-session admission follows each child's own model and host tool
  allowlist. Bounded execution diagnostics report requested/effective routes;
  headless children refuse nested Patch confirmation instead of bypassing it.

### Compatibility and upgrade

- Requires Node.js 22.19.0 or newer and Pi 0.87 series (`^0.87.0`), replacing
  the Pi 0.84.4 baseline of 0.1.0. Older hosts and 0.88 or later are not claimed.
- Existing valid configuration retains its settings; new capabilities are
  default-off. Legacy execution flags remain additive until the user saves
  model rules. Active rule-based Shell/Code hides native `bash`, and Patch
  hides `edit`/`write`. Review the migration preview and back up the config
  before opting in; 0.1.0 does not understand the rule schema.
- A rule's missing owned tools do not gain admission automatically. Native
  tools are retained when a replacement route is unavailable.

### Changed

- Sidecar and Remote Compaction normalize public transcript context before
  raw `Provider.stream()`, and
  Remote capture ignores saved native `systemMessage` state.
  Owned-tool projection also re-runs after `session_tree` so tree navigation
  cannot restore a user-disabled Toolkit tool into the next provider schema.
- `/pct status` can report `deferred` when Tool Discovery is holding back a
  capability's tools; `active` means the model can call it now.
- A missing `find_tools` loader (foreign winner or Pi `--tools` allowlist)
  restores ordinary owned tools instead of leaving deferred names hidden.
- Status reports `managed deferred tools` / `loaded this session` as 0 unless
  the `find_tools` loader is available.
- A configuration read error names the field that failed and what was
  expected: `/pct status` prints `Config error: invalid-config (<path> …)`,
  `/pct reload` ends with "using last known good settings." or "using all-off
  defaults.", and an interactive session warns once at start. The invalid
  value is never echoed.
- A bare empty line inside an Apply Patch `Update File` hunk is read as an
  empty context line, and a match is retried without a trailing empty line,
  as Codex does; `Add File` still rejects one.
- Every Computer Use startup stall (readiness deadline, poll budget, an
  unanswered `initialize` or `thread/start`) reports `node-repl-unavailable`;
  `timeout` is reserved for dispatched actions whose desktop outcome is
  unknown.

### Fixed and clarified

- Rule editor input dialogs show their current value. Configuration saves
  reject stale revisions and concurrent Toolkit writers without discarding
  another writer's changes; an empty abandoned reclaim directory is recovered.
- `apply_patch` rechecks live execution enablement when it is called and refuses
  with "Apply Patch is not enabled." before parsing or touching the
  filesystem, so a dispatch that reaches the registered tool before
  synchronization removes it can no longer mutate the workspace.
- Apply Patch staging writes a replacement with the source file's mode, so a
  `0600` source never sits readable to other principals before the final
  `chmod`.
- Text truncation cuts on code-point boundaries through one helper:
  discovery summaries, the Code Mode nested-approval argument preview (within
  800 bytes, marker included) and bounded messages no longer split a
  surrogate pair.
- Documentation: the status reason list gains `current-model-missing`,
  `unsupported-api` and `credential-mismatch`; the debug allowlist no longer
  claims a timestamp; Image Generation always sends `background: auto`; Shell
  Sessions uses pipes only, no PTY; the Computer Use lifecycle owner
  (`computer-use/lifecycle.ts`) is described and its cleanup contracts are
  tested.
- Development checks include ESLint with `no-floating-promises` and
  `no-misused-promises`, type-checked test scripts and a default-off status
  validator that identifies its failure class.

- Shell/Code settlement, bounded admission, cancellation, recovery retention
  and session-replacement cleanup contracts reviewed in September 2026.
- Computer Use cleanup participation and approval waiting that preserves the
  remaining execution budget without adding a human approval deadline.
- Eight-capability default-off validation of Pi's combined status streams.
- Trusted-code authority and Delete File UTF-8/line-ending documentation.
- Current-source versus historical-release documentation, self-contained public
  verification summaries, and private research exclusion from Git export and
  npm while retaining license attributions.
- Apply Patch final newline after an empty or BOM-only source; interrupted Code
  Mode error recovery without a duplicated prefix and with the stop reason;
  nested Code Mode shell polls that end without stopping independent shells;
  terminal Shell results with final capture states.
- Code Mode stops, aborts and closes that meet a finished program keep its
  result, also after an unconfirmed stop; finished workers that ignore shutdown
  are terminated after a short grace; the `terminate` description matches which
  stops retain the handle.

Dated checks and limitations are summarized in
[architecture verification](docs/en/architecture.md#9-protocol-probe-status).
Local source checks do not establish installation or GitHub Actions success.

## [0.1.0] - 2026-08-31

### Added

- Default-off Native and Sidecar Web Search through supported OpenAI Responses
  routes.
- Default-off Remote Compaction v2 with readable fallback data and bounded
  Codex checkpoint replay.
- Default-off Image Generation with persisted PNG artifacts.
- Default-off, provider-neutral Apply Patch support for Codex-compatible patch
  syntax.
- Default-off experimental Computer Use tools for compatible macOS and
  ChatGPT/Codex installations.
- `/pct status`, `/pct config`, and `/pct reload` commands, bilingual
  documentation, and isolated configuration under Pi's agent directory.

### Compatibility

- Requires Node.js 22.19.0 or newer.
- Verified with Pi 0.84.4; other Pi versions are not claimed by this release.

[0.1.0]: https://github.com/duo/pi-codex-toolkit/releases/tag/v0.1.0
[0.2.0]: https://github.com/duo/pi-codex-toolkit/releases/tag/v0.2.0
