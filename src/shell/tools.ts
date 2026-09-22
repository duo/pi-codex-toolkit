import { resolve } from "node:path";

import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  DIALECT_TOKENS_MAX,
  DIALECT_TOKENS_MIN,
  normalizeShellContinuationArgs,
  normalizeShellStartArgs,
} from "../execution-dialect.ts";
import {
  resolveInvocation,
  type ExecutionInvocationHooks,
} from "../execution-invocation.ts";

import {
  SHELL_MAX_BYTES_MAX,
  SHELL_MAX_BYTES_MIN,
  SHELL_PENDING_INPUT_BYTES,
  SHELL_PENDING_INPUT_CALLS,
  SHELL_YIELD_MAX_MS,
  SHELL_YIELD_MIN_MS,
  ShellSessionError,
  type ShellExecutor,
  type ShellSessionResult,
} from "./manager.ts";

export const EXEC_COMMAND_TOOL = "exec_command";
export const WRITE_STDIN_TOOL = "write_stdin";
export const SHELL_TOOLS: readonly string[] = [
  EXEC_COMMAND_TOOL,
  WRITE_STDIN_TOOL,
];

const YIELD_DESCRIPTION =
  "Maximum milliseconds this call waits for input transport, new output or managed-job completion. Defaults to 10000. 0 polls immediately after spawn is established. This bounds the call, not the command's runtime; scheduling, a brief output settle and bounded capture I/O may add time.";

const LIMIT_SCHEMA = {
  yield_time_ms: Type.Optional(
    Type.Integer({
      minimum: SHELL_YIELD_MIN_MS,
      maximum: SHELL_YIELD_MAX_MS,
      description: YIELD_DESCRIPTION,
    }),
  ),
  yieldTimeMs: Type.Optional(
    Type.Integer({
      minimum: SHELL_YIELD_MIN_MS,
      maximum: SHELL_YIELD_MAX_MS,
      description: `Same field as yield_time_ms; send one spelling, or the same value. ${YIELD_DESCRIPTION}`,
    }),
  ),
  max_output_tokens: Type.Optional(
    Type.Integer({
      minimum: DIALECT_TOKENS_MIN,
      maximum: DIALECT_TOKENS_MAX,
      description: `Output budget for this call in tokens (${DIALECT_TOKENS_MIN}..${DIALECT_TOKENS_MAX}). It is converted to a conservative ceiling of four bytes per token, bounded by the ${SHELL_MAX_BYTES_MAX}-byte cap; it is not provider tokenization. Supplying maxOutputBytes as well keeps both limits, and the smaller one wins.`,
    }),
  ),
  maxOutputBytes: Type.Optional(
    Type.Integer({
      minimum: SHELL_MAX_BYTES_MIN,
      maximum: SHELL_MAX_BYTES_MAX,
      description:
        "Maximum bytes of new stdout+stderr returned by this call. Defaults to 51200. Output is clipped at a UTF-8 code-point boundary, so a partial line may be returned. Poll a live handle for new output; use returned recovery paths for full history or after terminal handle release. Never rerun for output recovery.",
    }),
  ),
} as const;

const COMMAND_DESCRIPTION =
  "Shell command executed once through the resolved local shell.";
const CWD_DESCRIPTION =
  "Directory to run in. Relative paths resolve against the current session working directory; the directory must already exist.";
const INPUT_DESCRIPTION = `Exact text forwarded verbatim to the process stdin. No newline is appended and stdin is not closed implicitly. To send a line, end the string with a real newline character (U+000A, an actual line-break byte), never the two characters backslash and n; produce the newline through JSON escaping. Omit or leave empty to only poll. Pending stdin is limited to ${SHELL_PENDING_INPUT_BYTES} UTF-8 bytes and ${SHELL_PENDING_INPUT_CALLS} calls per session; overload/closed-pipe input is rejected. A written acknowledgement is transport-only; unknown delivery must not be resent automatically.`;
const SESSION_ID_DESCRIPTION =
  "Opaque session handle string returned by exec_command. OS PIDs and cell IDs are not accepted.";

// One schema source for direct definitions and the Code Mode validation seam.
// Each field keeps its range and additionalProperties rule; the Codex spelling
// and the existing name are the same field, resolved by the shared dialect.
export const EXEC_COMMAND_SCHEMA = Type.Object(
  {
    cmd: Type.Optional(
      Type.String({
        minLength: 1,
        description: `${COMMAND_DESCRIPTION} Send exactly one of cmd or command.`,
      }),
    ),
    command: Type.Optional(
      Type.String({
        minLength: 1,
        description: `Same field as cmd; send one spelling, or the same value. ${COMMAND_DESCRIPTION}`,
      }),
    ),
    workdir: Type.Optional(
      Type.String({
        minLength: 1,
        description: CWD_DESCRIPTION,
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        description: `Same field as workdir; send one spelling, or the same value. ${CWD_DESCRIPTION}`,
      }),
    ),
    ...LIMIT_SCHEMA,
  },
  { additionalProperties: false },
);

export const WRITE_STDIN_SCHEMA = Type.Object(
  {
    session_id: Type.Optional(
      Type.String({
        minLength: 1,
        description: `${SESSION_ID_DESCRIPTION} Send exactly one of session_id or sessionId.`,
      }),
    ),
    sessionId: Type.Optional(
      Type.String({
        minLength: 1,
        description: `Same field as session_id; send one spelling, or the same value. ${SESSION_ID_DESCRIPTION}`,
      }),
    ),
    chars: Type.Optional(Type.String({ description: INPUT_DESCRIPTION })),
    input: Type.Optional(
      Type.String({
        description: `Same field as chars; send one spelling, or the same value. ${INPUT_DESCRIPTION}`,
      }),
    ),
    closeStdin: Type.Optional(
      Type.Boolean({
        description:
          "After previously accepted input and this call's input, close the stdin pipe so programs waiting for EOF can finish. Repeated EOF is harmless; later nonempty input is rejected. Defaults to false.",
      }),
    ),
    terminate: Type.Optional(
      Type.Boolean({
        description:
          "Request bounded termination of the process and its process group, independent of queued polls. Do not combine with nonempty input. An unknown outcome retains the handle: poll or terminate again with write_stdin. Defaults to false.",
      }),
    ),
    ...LIMIT_SCHEMA,
  },
  { additionalProperties: false },
);

/** Bounded literal previews; control/recovery metadata precedes printable data. */
export function formatShellResult(result: ShellSessionResult): string {
  let text = `session_id ${result.sessionId}: ${result.status}`;
  if (result.status !== "running") {
    text += `\nexit_code: ${result.exitCode !== null ? result.exitCode : (result.signal ?? "unknown")}`;
  }
  if (result.status === "running" && !result.unknownOutcome) {
    text += "\njob still running; continue with write_stdin, not wait";
  }
  if (result.unknownOutcome) {
    text +=
      "\ntermination dispatched; exit not confirmed for the whole managed job; continue with write_stdin (not cell wait)";
  }
  if (result.inputDelivery) {
    text +=
      result.inputDelivery === "written"
        ? "\nstdin: transport write acknowledged; application effects are not confirmed"
        : "\nstdin: delivery unknown; do not resend automatically";
  }
  if (
    result.stdin &&
    (result.stdin.pendingCalls || result.stdin.state === "broken")
  ) {
    text += `\nstdin: ${result.stdin.state}; ${result.stdin.pendingBytes} bytes in ${result.stdin.pendingCalls} pending calls`;
    if (result.stdin.state === "broken")
      text +=
        "; earlier pending delivery may be partial; do not resend automatically";
  }
  if (result.recovery) {
    for (const name of ["stdout", "stderr"] as const) {
      const recovery = result.recovery[name];
      text += `\n${name} recovery: ${recovery.state}`;
      if (recovery.reason) text += ` (${recovery.reason})`;
      if (recovery.path) text += ` — ${recovery.path}`;
      text += ` [${recovery.capturedBytes}/${recovery.bytes} UTF-8 bytes captured]`;
    }
    text +=
      "\nRead recovery files with an available file-read or shell tool; paths are not process handles. Files may contain secrets; retention ends at output-owner shutdown (standalone manager close, or Pi session shutdown with a shared owner). Capturing is a snapshot, not a completeness claim; expiry without a final read leaves completion unconfirmed. Partial/unavailable capture is not full output. Never rerun for recovery.";
  }
  if (result.stdout.length > 0) text += `\n[stdout]\n${result.stdout}`;
  if (result.stderr.length > 0) text += `\n[stderr]\n${result.stderr}`;
  if (result.stdout.length === 0 && result.stderr.length === 0) {
    text += result.status === "running" ? "\n(no new output)" : "\n(no output)";
  }
  if (result.dropped) {
    text +=
      "\n(truncated: preview buffered bytes were dropped before this read; see separate recovery state)";
  } else if (result.truncated) {
    text +=
      "\n(truncated: output clipped to the per-read byte budget; see separate recovery state)";
  }
  return text;
}

export interface ShellToolsOptions {
  /**
   * Gate for `exec_command`: every call starts a fresh shell effect, so it
   * follows the pending contraction fence as well as the committed routes.
   */
  isStartEnabled: () => boolean;
  /**
   * Gate for `write_stdin`: observation, stdin, and stop control on sessions
   * the committed projection owns. Retained work keeps this control even
   * while new starts are fenced.
   */
  isContinueEnabled: () => boolean;
  /**
   * Generic invocation seam, identical to the nested Code Mode adapters':
   * trusted per-call environment, then the applicable policy decision, then
   * this feature's own executor.
   */
  invocationHooks?: ExecutionInvocationHooks;
}

/**
 * The executor these definitions dispatch to. A factory that replaces its
 * manager when Pi replaces the session supplies a resolver, so each call can
 * bind the manager it was admitted on before any awaited step.
 */
export type ShellExecutorSource = ShellExecutor | (() => ShellExecutor);

export function createShellTools(
  executor: ShellExecutorSource,
  options: ShellToolsOptions,
): ToolDefinition[] {
  const resolveExecutor = (): ShellExecutor =>
    typeof executor === "function" ? executor() : executor;
  /**
   * Recheck admission after an awaited step and before the effect, exactly
   * where the nested Code Mode adapter rechecks `eligible()`. A capability
   * disabled, a contraction fenced or a session replaced while the invocation
   * hook was pending must not be overtaken by a call that passed the entry
   * check; nothing has run when this throws.
   */
  const recheckAdmission = (
    bound: ShellExecutor,
    enabled: () => boolean,
    outcome: "no command was dispatched" | "no input was sent",
  ): void => {
    if (!enabled()) throw new Error("Shell Sessions are not enabled.");
    if (resolveExecutor() !== bound) {
      throw new ShellSessionError(
        "manager-closed",
        `The shell session owner was replaced while this call was pending; ${outcome}.`,
        outcome === "no input was sent" ? "not-sent" : undefined,
      );
    }
  };
  const execCommand = defineTool({
    name: EXEC_COMMAND_TOOL,
    label: "Exec Command",
    description:
      "Run one shell command and return bounded new stdout/stderr plus managed-job status. Send the command as cmd or command, and the directory as workdir or cwd: each pair is one field, so send one spelling or the same value. The nested Code Mode form tools.exec_command({cmd|command, workdir|cwd, yield_time_ms, max_output_tokens}) takes the same fields and spellings. Ordinary same-process-group descendants and inherited output pipes remain owned after the shell leader exits. A live or uncertain job returns an opaque session_id to continue with write_stdin. The command is launched exactly once and is never relaunched or replayed. stdin/stdout/stderr are pipes, not a TTY: interactive line programs work, but full-screen or TTY-only programs are unsupported. tty, shell, login, sandbox_permissions, justification, with_escalated_permissions, prefix_rule and timeout_ms are rejected rather than ignored. Only new output is returned per call. Terminal handles are released once; clipped output has independent recovery metadata or an explicit capture failure. Small fully delivered commands need no recovery file.",
    parameters: EXEC_COMMAND_SCHEMA,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (!options.isStartEnabled()) {
        throw new Error("Shell Sessions are not enabled.");
      }
      // Bind the manager this call was admitted on before any awaited step:
      // the factory swaps its binding when Pi replaces the session.
      const bound = resolveExecutor();
      // Same dialect normalizer as the nested adapter: spellings, conflicts
      // and unsupported Codex fields are resolved before any effect.
      const input = normalizeShellStartArgs(params);
      const cwd =
        input.cwd === undefined ? ctx.cwd : resolve(ctx.cwd, input.cwd);
      // Same invocation seam as the nested adapter, after validation and
      // before the spawn: a denial starts nothing.
      const invocation = await resolveInvocation(options.invocationHooks, {
        tool: EXEC_COMMAND_TOOL,
        path: "direct",
        cwd,
      });
      recheckAdmission(
        bound,
        options.isStartEnabled,
        "no command was dispatched",
      );
      const result = await bound.start(
        {
          command: input.command,
          cwd,
          yieldTimeMs: input.yieldTimeMs,
          maxOutputBytes: input.maxOutputBytes,
          ...(invocation.env === undefined ? {} : { env: invocation.env }),
        },
        signal,
      );
      return {
        content: [{ type: "text", text: formatShellResult(result) }],
        details: result,
      };
    },
  });
  const writeStdin = defineTool({
    name: WRITE_STDIN_TOOL,
    label: "Write Stdin",
    description:
      "Continue a session returned by exec_command: poll for new output, forward text to stdin, or terminate it. Send the handle as session_id or sessionId and the text as chars or input: each pair is one field, so send one spelling or the same value. The nested Code Mode form tools.write_stdin({session_id|sessionId, chars|input, ...}) takes the same fields and spellings. The handle is always the opaque string returned by exec_command, never a number or OS PID. Polling never restarts or replays the command, and only new stdout/stderr is returned. On a shell whose command transport is stdin, the command already consumed stdin, so non-empty input is rejected. Handles expire once their final result has been read; concurrent terminal readers receive the result once, then stale-session. Unknown termination is not final and remains controllable. Use recovery files after handle release, not another execution.",
    parameters: WRITE_STDIN_SCHEMA,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (!options.isContinueEnabled()) {
        throw new Error("Shell Sessions are not enabled.");
      }
      // The handle only exists on the manager that created it, so bind that
      // manager before the awaited seam.
      const bound = resolveExecutor();
      const input = normalizeShellContinuationArgs(params);
      await resolveInvocation(options.invocationHooks, {
        tool: WRITE_STDIN_TOOL,
        path: "direct",
        cwd: ctx.cwd,
        sessionId: input.sessionId,
      });
      recheckAdmission(bound, options.isContinueEnabled, "no input was sent");
      const result = await bound.write(
        {
          sessionId: input.sessionId,
          input: input.input,
          closeStdin: input.closeStdin,
          terminate: input.terminate,
          yieldTimeMs: input.yieldTimeMs,
          maxOutputBytes: input.maxOutputBytes,
        },
        signal,
      );
      return {
        content: [{ type: "text", text: formatShellResult(result) }],
        details: result,
      };
    },
  });
  return [execCommand, writeStdin];
}
