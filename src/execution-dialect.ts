/**
 * Supported Codex call dialect.
 *
 * One normalizer per model-facing entry, shared by the direct tools and the
 * nested Code Mode adapters so both accept the same spellings, reject the same
 * conflicts, and refuse the same unsupported Codex fields before any effect.
 *
 * Pure: no Pi host, no filesystem, no executor, no process state. Ranges,
 * enablement, ownership and handle lookup stay with the managers that own
 * them; this module only resolves the dialect and the documented byte proxy.
 */

import {
  CODE_MODE_MAX_BYTES_MAX,
  CODE_MODE_MAX_BYTES_MIN,
} from "./code-mode/manager.ts";
import {
  SHELL_MAX_BYTES_MAX,
  SHELL_MAX_BYTES_MIN,
  type ShellSessionResult,
} from "./shell/manager.ts";

/**
 * A dialect rejection: the call is refused before validation ranges, queue
 * admission, confirmation or any effect. Nested dispatch maps it onto
 * `CodeModeError("invalid-arguments", …)` so one nested error union remains.
 */
export class ExecutionDialectError extends Error {
  readonly code = "invalid-arguments";

  constructor(message: string) {
    super(message);
    this.name = "ExecutionDialectError";
  }
}

/**
 * Documented conservative proxy: `max_output_tokens` is converted to a byte
 * ceiling of four bytes per token and then bounded by the existing per-read
 * caps. It is not provider tokenization and never widens an existing cap.
 */
export const DIALECT_BYTES_PER_TOKEN = 4;
export const DIALECT_TOKENS_MIN = 256;
export const DIALECT_TOKENS_MAX = 65_536;

const EXEC_TOOL = "exec";
const WAIT_TOOL = "wait";
const EXEC_COMMAND = "exec_command";
const WRITE_STDIN = "write_stdin";
const APPLY_PATCH = "apply_patch";

/** First-line `// @exec:` pragma, matching the upstream freeform grammar. */
const EXEC_PRAGMA_PATTERN = /^[ \t]*\/\/ @exec:([^\r\n]*)/;
const PRAGMA_KEYS = ["yield_time_ms", "max_output_tokens"] as const;

/**
 * Codex request fields this runtime does not implement. They are rejected by
 * name before dispatch rather than accepted as silent no-ops.
 */
const UNSUPPORTED_FIELDS = new Map<string, string>([
  ["tty", "PTY allocation is unsupported; stdin/stdout/stderr are pipes"],
  ["shell", "shell selection is unsupported; the resolved local shell is used"],
  ["login", "login shells are unsupported"],
  ["sandbox_permissions", "Codex sandbox permissions are not implemented here"],
  ["justification", "Codex approval justification is not implemented here"],
  [
    "with_escalated_permissions",
    "Codex permission escalation is not implemented here",
  ],
  ["prefix_rule", "Codex prefix rules are not implemented here"],
  [
    "timeout_ms",
    "a command timeout is unsupported; yield_time_ms bounds this observation, not execution",
  ],
]);

export interface NormalizedShellStart {
  command: string;
  /** Raw workdir; callers resolve it against their own invocation cwd. */
  cwd?: string;
  yieldTimeMs?: number;
  maxOutputBytes?: number;
}

export interface NormalizedShellContinuation {
  sessionId: string;
  input?: string;
  closeStdin?: boolean;
  terminate?: boolean;
  yieldTimeMs?: number;
  maxOutputBytes?: number;
}

export interface NormalizedExec {
  code: string;
  /** Entries are validated by the cell manager, which owns the name sets. */
  uses?: string[];
  yieldTimeMs?: number;
  maxOutputBytes?: number;
}

export interface NormalizedWait {
  cellId: string;
  terminate?: boolean;
  yieldTimeMs?: number;
  maxOutputBytes?: number;
}

export interface NormalizedPatch {
  patch: string;
}

/** Parsed first-line pragma plus the source with its line numbers preserved. */
export interface ExecPragma {
  present: boolean;
  source: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

interface AliasValue {
  key: string;
  value: unknown;
}

interface ByteBounds {
  min: number;
  max: number;
}

const SHELL_BYTE_BOUNDS: ByteBounds = {
  min: SHELL_MAX_BYTES_MIN,
  max: SHELL_MAX_BYTES_MAX,
};
const CODE_BYTE_BOUNDS: ByteBounds = {
  min: CODE_MODE_MAX_BYTES_MIN,
  max: CODE_MODE_MAX_BYTES_MAX,
};

const EXEC_COMMAND_FIELDS = [
  "cmd",
  "command",
  "workdir",
  "cwd",
  "yield_time_ms",
  "yieldTimeMs",
  "max_output_tokens",
  "maxOutputBytes",
] as const;
const WRITE_STDIN_FIELDS = [
  "session_id",
  "sessionId",
  "chars",
  "input",
  "closeStdin",
  "terminate",
  "yield_time_ms",
  "yieldTimeMs",
  "max_output_tokens",
  "maxOutputBytes",
] as const;
const EXEC_FIELDS = [
  "code",
  "uses",
  "yield_time_ms",
  "yieldTimeMs",
  "max_output_tokens",
  "maxOutputBytes",
] as const;
const WAIT_FIELDS = [
  "cell_id",
  "cellId",
  "terminate",
  "yield_time_ms",
  "yieldTimeMs",
  "max_tokens",
  "max_output_tokens",
  "maxOutputBytes",
] as const;

/** Byte ceiling for a token budget, bounded by the existing per-read caps. */
export function tokensToByteBudget(tokens: number, bounds: ByteBounds): number {
  return Math.min(
    bounds.max,
    Math.max(bounds.min, tokens * DIALECT_BYTES_PER_TOKEN),
  );
}

export function normalizeShellStartArgs(raw: unknown): NormalizedShellStart {
  const args = requireObject(raw, EXEC_COMMAND);
  assertSupportedFields(args, EXEC_COMMAND, EXEC_COMMAND_FIELDS);
  const command = resolveAlias(args, EXEC_COMMAND, ["cmd", "command"]);
  if (command === undefined) {
    throw new ExecutionDialectError(
      `${EXEC_COMMAND} requires the command to run: send "cmd" (Codex spelling) or "command" as a non-empty string.`,
    );
  }
  const cwd = resolveAlias(args, EXEC_COMMAND, ["workdir", "cwd"]);
  const normalized: NormalizedShellStart = {
    command: asNonEmptyString(command, EXEC_COMMAND),
  };
  if (cwd !== undefined) normalized.cwd = asString(cwd, EXEC_COMMAND);
  const yieldTimeMs = resolveYield(args, EXEC_COMMAND);
  if (yieldTimeMs !== undefined) normalized.yieldTimeMs = yieldTimeMs;
  const maxOutputBytes = resolveOutputBudget(
    args,
    EXEC_COMMAND,
    ["max_output_tokens"],
    SHELL_BYTE_BOUNDS,
  );
  if (maxOutputBytes !== undefined) normalized.maxOutputBytes = maxOutputBytes;
  return normalized;
}

export function normalizeShellContinuationArgs(
  raw: unknown,
): NormalizedShellContinuation {
  const args = requireObject(raw, WRITE_STDIN);
  assertSupportedFields(args, WRITE_STDIN, WRITE_STDIN_FIELDS);
  const session = resolveAlias(args, WRITE_STDIN, ["session_id", "sessionId"]);
  if (session === undefined) {
    throw new ExecutionDialectError(
      `${WRITE_STDIN} requires "session_id" (or "sessionId"): the opaque handle string returned by ${EXEC_COMMAND}.`,
    );
  }
  if (typeof session.value === "number") {
    throw new ExecutionDialectError(
      `${WRITE_STDIN}.${session.key} must be the opaque session handle string returned by ${EXEC_COMMAND} (for example "pct-shell-…"), not a number or an OS PID. Handles are never coerced or guessed.`,
    );
  }
  const normalized: NormalizedShellContinuation = {
    sessionId: asNonEmptyString(session, WRITE_STDIN),
  };
  const input = resolveAlias(args, WRITE_STDIN, ["chars", "input"]);
  if (input !== undefined) normalized.input = asString(input, WRITE_STDIN);
  const closeStdin = resolveAlias(args, WRITE_STDIN, ["closeStdin"]);
  if (closeStdin !== undefined)
    normalized.closeStdin = asBoolean(closeStdin, WRITE_STDIN);
  const terminate = resolveAlias(args, WRITE_STDIN, ["terminate"]);
  if (terminate !== undefined)
    normalized.terminate = asBoolean(terminate, WRITE_STDIN);
  const yieldTimeMs = resolveYield(args, WRITE_STDIN);
  if (yieldTimeMs !== undefined) normalized.yieldTimeMs = yieldTimeMs;
  const maxOutputBytes = resolveOutputBudget(
    args,
    WRITE_STDIN,
    ["max_output_tokens"],
    SHELL_BYTE_BOUNDS,
  );
  if (maxOutputBytes !== undefined) normalized.maxOutputBytes = maxOutputBytes;
  return normalized;
}

/**
 * Read the optional first-line pragma. The matched text is replaced by an
 * empty line so reported source line numbers never shift.
 */
export function parseExecPragma(code: string): ExecPragma {
  const match = EXEC_PRAGMA_PATTERN.exec(code);
  if (!match) return { present: false, source: code };
  const body = match[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ExecutionDialectError(
      `The first-line "// @exec:" pragma must be a JSON object with only ${PRAGMA_KEYS.join(" and ")}; it is not valid JSON. Fix or remove the pragma; nothing ran.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ExecutionDialectError(
      `The first-line "// @exec:" pragma must be a JSON object with only ${PRAGMA_KEYS.join(" and ")}. Fix or remove the pragma; nothing ran.`,
    );
  }
  const options = parsed as Record<string, unknown>;
  const pragma: ExecPragma = {
    present: true,
    source: code.slice(match[0].length),
  };
  for (const key of Object.keys(options)) {
    if (!(PRAGMA_KEYS as readonly string[]).includes(key)) {
      throw new ExecutionDialectError(
        `The "// @exec:" pragma does not accept "${key}". Accepted pragma options: ${PRAGMA_KEYS.join(", ")}.`,
      );
    }
    const value = options[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new ExecutionDialectError(
        `The "// @exec:" pragma option "${key}" must be a non-negative integer.`,
      );
    }
  }
  if (options.yield_time_ms !== undefined)
    pragma.yieldTimeMs = options.yield_time_ms as number;
  if (options.max_output_tokens !== undefined)
    pragma.maxOutputTokens = options.max_output_tokens as number;
  return pragma;
}

export function normalizeExecArgs(raw: unknown): NormalizedExec {
  const args = requireObject(raw, EXEC_TOOL);
  assertSupportedFields(args, EXEC_TOOL, EXEC_FIELDS);
  const code = resolveAlias(args, EXEC_TOOL, ["code"]);
  if (code === undefined) {
    throw new ExecutionDialectError(
      `${EXEC_TOOL} requires "code": the JavaScript program to run.`,
    );
  }
  const pragma = parseExecPragma(asString(code, EXEC_TOOL));
  const normalized: NormalizedExec = { code: pragma.source };
  const uses = args.uses;
  if (uses !== undefined) {
    if (!Array.isArray(uses)) {
      throw new ExecutionDialectError(
        `${EXEC_TOOL}.uses must be an array of adapted tool names.`,
      );
    }
    normalized.uses = uses as string[];
  }
  const yieldTimeMs = mergePragmaOption(
    EXEC_TOOL,
    "yield_time_ms",
    resolveYield(args, EXEC_TOOL),
    pragma.yieldTimeMs,
  );
  if (yieldTimeMs !== undefined) normalized.yieldTimeMs = yieldTimeMs;
  const argumentTokens = resolveAlias(args, EXEC_TOOL, ["max_output_tokens"]);
  const tokens = mergePragmaOption(
    EXEC_TOOL,
    "max_output_tokens",
    argumentTokens === undefined
      ? undefined
      : asInteger(argumentTokens, EXEC_TOOL),
    pragma.maxOutputTokens,
  );
  const maxOutputBytes = combineBudgets(
    EXEC_TOOL,
    "max_output_tokens",
    tokens,
    resolveBytes(args, EXEC_TOOL),
    CODE_BYTE_BOUNDS,
  );
  if (maxOutputBytes !== undefined) normalized.maxOutputBytes = maxOutputBytes;
  return normalized;
}

export function normalizeWaitArgs(raw: unknown): NormalizedWait {
  const args = requireObject(raw, WAIT_TOOL);
  assertSupportedFields(args, WAIT_TOOL, WAIT_FIELDS);
  const cell = resolveAlias(args, WAIT_TOOL, ["cell_id", "cellId"]);
  if (cell === undefined) {
    throw new ExecutionDialectError(
      `${WAIT_TOOL} requires "cell_id" (or "cellId"): the opaque cell handle string returned by ${EXEC_TOOL}.`,
    );
  }
  if (typeof cell.value === "number") {
    throw new ExecutionDialectError(
      `${WAIT_TOOL}.${cell.key} must be the opaque cell handle string returned by ${EXEC_TOOL} (for example "pct-cell-…"), not a number. Cell and shell handles are never interchanged or guessed.`,
    );
  }
  const normalized: NormalizedWait = {
    cellId: asNonEmptyString(cell, WAIT_TOOL),
  };
  const terminate = resolveAlias(args, WAIT_TOOL, ["terminate"]);
  if (terminate !== undefined)
    normalized.terminate = asBoolean(terminate, WAIT_TOOL);
  const yieldTimeMs = resolveYield(args, WAIT_TOOL);
  if (yieldTimeMs !== undefined) normalized.yieldTimeMs = yieldTimeMs;
  // Codex names the wait budget `max_tokens`; `max_output_tokens` is the same
  // field and `maxOutputBytes` remains the independent legacy byte budget.
  const maxOutputBytes = resolveOutputBudget(
    args,
    WAIT_TOOL,
    ["max_tokens", "max_output_tokens"],
    CODE_BYTE_BOUNDS,
  );
  if (maxOutputBytes !== undefined) normalized.maxOutputBytes = maxOutputBytes;
  return normalized;
}

/**
 * Nested Apply Patch accepts the freeform envelope string or the existing
 * `{patch}` object. Both become the validated executor's own input; paths,
 * queues and partial-commit behavior are unchanged.
 */
export function normalizeNestedPatchArgs(raw: unknown): NormalizedPatch {
  if (typeof raw === "string") return { patch: raw };
  const args = requireObject(raw, APPLY_PATCH);
  assertSupportedFields(args, APPLY_PATCH, ["patch"]);
  const patch = resolveAlias(args, APPLY_PATCH, ["patch"]);
  if (patch === undefined) {
    throw new ExecutionDialectError(
      `${APPLY_PATCH} requires the "*** Begin Patch" envelope, either as the single string argument or as {"patch": "…"}.`,
    );
  }
  return { patch: asString(patch, APPLY_PATCH) };
}

/** Codex spellings beside the existing camelCase fields; identical values. */
export interface ShellDialectResult extends ShellSessionResult {
  session_id: string;
  exit_code: number | null;
}

export function withShellDialectFields(
  result: ShellSessionResult,
): ShellDialectResult {
  return {
    ...result,
    session_id: result.sessionId,
    exit_code: result.exitCode,
  };
}

function requireObject(value: unknown, tool: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExecutionDialectError(
      `${tool} requires a single JSON object argument.`,
    );
  }
  return value as Record<string, unknown>;
}

function assertSupportedFields(
  args: Record<string, unknown>,
  tool: string,
  accepted: readonly string[],
): void {
  for (const key of Object.keys(args)) {
    if (accepted.includes(key)) continue;
    const unsupported = UNSUPPORTED_FIELDS.get(key);
    if (unsupported !== undefined) {
      throw new ExecutionDialectError(
        `${tool} does not support "${key}": ${unsupported}. Remove the field; it is never applied silently.`,
      );
    }
    throw new ExecutionDialectError(
      `${tool} does not accept "${key}". Accepted fields: ${accepted.join(", ")}.`,
    );
  }
}

/**
 * Resolve one field from its accepted spellings. Identical duplicates pass;
 * different values are rejected before any effect.
 */
function resolveAlias(
  args: Record<string, unknown>,
  tool: string,
  keys: readonly string[],
): AliasValue | undefined {
  let found: AliasValue | undefined;
  for (const key of keys) {
    const value = args[key];
    if (value === undefined) continue;
    if (found === undefined) {
      found = { key, value };
      continue;
    }
    if (!Object.is(found.value, value)) {
      throw new ExecutionDialectError(
        `${tool} received conflicting values for "${found.key}" and "${key}", which are the same field. Send one spelling, or the same value; nothing ran.`,
      );
    }
  }
  return found;
}

function resolveYield(
  args: Record<string, unknown>,
  tool: string,
): number | undefined {
  const found = resolveAlias(args, tool, ["yield_time_ms", "yieldTimeMs"]);
  return found === undefined ? undefined : asInteger(found, tool);
}

function resolveBytes(
  args: Record<string, unknown>,
  tool: string,
): number | undefined {
  const found = resolveAlias(args, tool, ["maxOutputBytes"]);
  return found === undefined ? undefined : asInteger(found, tool);
}

function resolveOutputBudget(
  args: Record<string, unknown>,
  tool: string,
  tokenKeys: readonly string[],
  bounds: ByteBounds,
): number | undefined {
  const found = resolveAlias(args, tool, tokenKeys);
  return combineBudgets(
    tool,
    found?.key ?? tokenKeys[0],
    found === undefined ? undefined : asInteger(found, tool),
    resolveBytes(args, tool),
    bounds,
  );
}

/**
 * A token budget and a legacy byte budget are different units, not aliases:
 * both constraints apply and the smaller payload ceiling wins.
 *
 * Each budget is validated against its own bounds first. Combining an
 * out-of-range byte budget with a token budget would otherwise reduce it to a
 * value the direct schema rejects, so the nested path would accept a call the
 * direct path refuses.
 */
function combineBudgets(
  tool: string,
  tokenKey: string,
  tokens: number | undefined,
  bytes: number | undefined,
  bounds: ByteBounds,
): number | undefined {
  if (bytes !== undefined && (bytes < bounds.min || bytes > bounds.max)) {
    throw new ExecutionDialectError(
      `${tool}.maxOutputBytes must be an integer between ${bounds.min} and ${bounds.max} bytes.`,
    );
  }
  if (tokens === undefined) return bytes;
  if (tokens < DIALECT_TOKENS_MIN || tokens > DIALECT_TOKENS_MAX) {
    throw new ExecutionDialectError(
      `${tool}.${tokenKey} must be an integer between ${DIALECT_TOKENS_MIN} and ${DIALECT_TOKENS_MAX} output tokens. It is a conservative ${DIALECT_BYTES_PER_TOKEN}-bytes-per-token proxy, not provider tokenization.`,
    );
  }
  const proxy = tokensToByteBudget(tokens, bounds);
  return bytes === undefined ? proxy : Math.min(bytes, proxy);
}

/** Pragma options and explicit arguments must agree; neither silently wins. */
function mergePragmaOption(
  tool: string,
  key: string,
  argument: number | undefined,
  pragma: number | undefined,
): number | undefined {
  if (pragma === undefined) return argument;
  if (argument === undefined) return pragma;
  if (argument !== pragma) {
    throw new ExecutionDialectError(
      `The "// @exec:" pragma sets ${key} to ${pragma} but the ${tool} call argument sets ${argument}; they conflict. Send one value; nothing ran.`,
    );
  }
  return argument;
}

function asString(found: AliasValue, tool: string): string {
  if (typeof found.value !== "string") {
    throw new ExecutionDialectError(`${tool}.${found.key} must be a string.`);
  }
  return found.value;
}

function asNonEmptyString(found: AliasValue, tool: string): string {
  const text = asString(found, tool);
  if (text.length === 0) {
    throw new ExecutionDialectError(
      `${tool}.${found.key} must be a non-empty string.`,
    );
  }
  return text;
}

function asInteger(found: AliasValue, tool: string): number {
  if (typeof found.value !== "number" || !Number.isInteger(found.value)) {
    throw new ExecutionDialectError(`${tool}.${found.key} must be an integer.`);
  }
  return found.value;
}

function asBoolean(found: AliasValue, tool: string): boolean {
  if (typeof found.value !== "boolean") {
    throw new ExecutionDialectError(`${tool}.${found.key} must be a boolean.`);
  }
  return found.value;
}
