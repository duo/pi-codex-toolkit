import type { ConstrainedSamplingConfig } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolUpdateCallback,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DIALECT_TOKENS_MAX,
  DIALECT_TOKENS_MIN,
  normalizeExecArgs,
  normalizeWaitArgs,
} from "../execution-dialect.ts";
import {
  SHELL_PENDING_INPUT_BYTES,
  SHELL_PENDING_INPUT_CALLS,
  SHELL_YIELD_MIN_MS,
  SHELL_YIELD_MAX_MS,
  SHELL_YIELD_DEFAULT_MS,
  SHELL_MAX_BYTES_MIN,
  SHELL_MAX_BYTES_MAX,
  SHELL_MAX_BYTES_DEFAULT,
} from "../shell/manager.ts";

import {
  CODE_MODE_MAX_BYTES_DEFAULT,
  CODE_MODE_MAX_BYTES_MAX,
  CODE_MODE_MAX_BYTES_MIN,
  CODE_MODE_YIELD_DEFAULT_MS,
  CODE_MODE_YIELD_MAX_MS,
  CODE_MODE_YIELD_MIN_MS,
  CodeModeError,
  CODE_MODE_RESULT_MAX_BYTES,
  CODE_MODE_PENDING_CALLS,
  CODE_MODE_PENDING_CALL_BYTES,
  CODE_MODE_ERROR_MAX_BYTES,
  boundMessage,
  type CodeModeCellManager,
  type CodeModeCellResult,
  type NestedProgressRecord,
  type NestedProgressSink,
} from "./manager.ts";

export const CODE_MODE_RENDER_MAX_BYTES =
  CODE_MODE_MAX_BYTES_MAX +
  CODE_MODE_RESULT_MAX_BYTES +
  CODE_MODE_ERROR_MAX_BYTES +
  32 * 1024;

// Complete compact callable contract, including when direct schemas/discovery
// are filtered out. Validators remain the direct TypeBox schema sources.
//
// Pi fixes a tool's description at registration, before the first rule/model
// resolution, and its 0.87 ExtensionAPI has no supported way to update a
// registered description later. So this text lists every adapter this build
// can expose and says plainly that the admitted subset is decided per session
// and enforced at dispatch, instead of advertising a callable set that a
// Code-only or Patch-excluded route would contradict.
export const CODE_MODE_ADAPTER_HELP = `Adapters this build can expose (each takes one JSON object, except apply_patch which also takes the patch envelope string; unknown fields are rejected). Which of them the current model's rule admits is decided per session, not by this list: /pct status reports the admitted set for the current model, omitting uses declares exactly that set, and calling an adapter this session did not admit fails that one call at dispatch without running anything. Paired spellings below are one field: send one spelling, or the same value.
- tools.exec_command({cmd|command: nonempty string, workdir|cwd?: nonempty string, yield_time_ms|yieldTimeMs?: integer, max_output_tokens?: integer, maxOutputBytes?: integer}). workdir defaults to the invoking directory; relative cwd resolves there and must exist. Runs once with inherited environment and pipes, not a TTY; tty, shell, login, sandbox_permissions, justification, with_escalated_permissions, prefix_rule and timeout_ms are rejected, never ignored. Returns structured session_id (also sessionId)/status/exit_code (also exitCode)/signal/stdout/stderr/truncated/dropped and optional unknownOutcome/recovery/stdin.
- tools.write_stdin({session_id|sessionId: nonempty string, chars|input?: string, closeStdin?: boolean=false, terminate?: boolean=false, yield_time_ms|yieldTimeMs?: integer, max_output_tokens?: integer, maxOutputBytes?: integer}). Use the opaque shell ID string, never an OS PID or cell ID. Omitted/empty chars polls. Input is verbatim: no newline or EOF is added; use a real newline for a line. closeStdin ends after accepted input; repeated EOF is harmless, later text rejects. Command-transport stdin has no interactive input. Do not combine nonempty input with terminate. Pending stdin admits at most ${SHELL_PENDING_INPUT_BYTES} UTF-8 bytes/${SHELL_PENDING_INPUT_CALLS} calls; overload or closed/broken input rejects. Written means transport only; unknown delivery must not be resent. Stop is independent of polls; unknown termination retains write_stdin control. Ordinary same-group descendants remain owned after leader exit.
Both shell adapters: yieldTimeMs ${SHELL_YIELD_MIN_MS}..${SHELL_YIELD_MAX_MS} (default ${SHELL_YIELD_DEFAULT_MS}) bounds observation, not execution; spawn establishment/capture I/O may add time. maxOutputBytes ${SHELL_MAX_BYTES_MIN}..${SHELL_MAX_BYTES_MAX} (default ${SHELL_MAX_BYTES_DEFAULT}) bounds new stdout+stderr, stdout first, UTF-8 safe; max_output_tokens ${DIALECT_TOKENS_MIN}..${DIALECT_TOKENS_MAX} is a conservative four-bytes-per-token proxy for the same ceiling, not provider tokenization, and the smaller of the two wins. Terminal handles release once; recovery paths are separate, not handles.
- tools.apply_patch("*** Begin Patch…") or tools.apply_patch({patch: nonempty string}), admitted only while the current rule routes Patch through Code. Use the Codex *** Begin Patch / *** End Patch envelope with *** Add File: path (+ lines), *** Delete File: path, or *** Update File: path (optional *** Move to: path; @@ context locators and space/-/+ hunk lines; optional *** End of File). Paths must remain under invocation cwd without symlink/alias conflicts. Existing source files, including Delete File targets, must be valid UTF-8 text with consistent LF or CRLF; non-UTF-8, bare CR and mixed line endings are rejected before mutation. Binary deletion is unsupported. Preflight/staging failure makes no changes; multi-file commit failure can leave committed paths and unknown paths: reread, never replay automatically. Returns structured operations. Sequential per cell and existing file mutation queues; only this adapter requires extra Code Mode confirmation. Shell retains direct-shell authority and can mutate files.
Helpers: print(...values) and console.log/warn/error format and append a line; text(value) appends a string literally, stringifying a non-string with JSON.stringify when possible. There is no store, load, notify, yield_control, ALL_TOOLS, image, audio, exit, timer, import or persistent state.
Admission and approval are rechecked when the nested call actually dispatches, not when the program is submitted: an adapter this cell did not declare, or one that is disabled or owned by another extension at that moment, fails that call alone and the program can catch it. Under confirm, nested apply_patch also needs a dialog-capable UI at that moment; without one the call fails as approval-unavailable and nothing is changed.
Live/unknown shell IDs are also published independently of your return value; continue with tools.write_stdin in a new exec declaring it if the direct tool is hidden. wait only accepts cell IDs. Recovery files contain emitted text or serialized selected result/error, may contain secrets, survive feature disablement until Pi session shutdown, and require an available native read or authorized shell adapter. Read files, never rerun effects for recovery.`;

export const CODE_MODE_EXEC_TOOL = "exec";
export const CODE_MODE_WAIT_TOOL = "wait";

// Verbatim CODE_MODE_FREEFORM_GRAMMAR from codex-rs/core/src/tools/spec/
// execute_spec.rs at the pinned revision (rust-v0.155.1): raw JavaScript with
// one optional first-line `// @exec:` pragma. Providers that support grammar
// tools send the source directly; Pi decodes it into this tool's `code`
// property, and providers without grammar support keep the JSON form.
export const EXEC_LARK_GRAMMAR = String.raw`
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

/**
 * Grammar transport for the owned `exec` name. `src/index.ts` also restores it
 * in the remote-compaction projection, which Pi 0.87's public `getAllTools()`
 * omits; a foreign `exec` winner never receives it.
 */
export const EXEC_CONSTRAINED_SAMPLING: ConstrainedSamplingConfig = {
  type: "grammar",
  variants: { openai_lark: EXEC_LARK_GRAMMAR },
};

export const CODE_MODE_TOOLS: readonly string[] = [
  CODE_MODE_EXEC_TOOL,
  CODE_MODE_WAIT_TOOL,
];

/**
 * Why a call needs the manager. `exec` asks to `admit` a new cell, which a
 * manager whose admission a failed close already fenced can never run; `wait`
 * only asks to `observe`, which must keep reaching that retained manager so
 * its cells stay stoppable.
 */
export type CodeModeManagerPurpose = "admit" | "observe";

export interface CodeModeToolsOptions {
  /** Current session manager; returns undefined when Code Mode is unavailable. */
  getManager: (
    purpose: CodeModeManagerPurpose,
  ) => CodeModeCellManager | undefined;
  /**
   * Gate for `exec`: a new cell is a fresh admission, so it follows the
   * pending contraction fence as well as the committed routes.
   */
  isExecEnabled: () => boolean;
  /**
   * Gate for `wait`: observation and terminate control on cells the
   * committed projection owns. Retained cells keep this control even while
   * new admissions are fenced.
   */
  isWaitEnabled: () => boolean;
}

const YIELD_DESCRIPTION =
  "Maximum milliseconds this call waits for output or completion before returning. Defaults to 10000. 0 returns immediately with whatever arrived. This bounds the call, not the program's runtime.";
const TOKEN_BUDGET_DESCRIPTION = `Output budget for this call in tokens (${DIALECT_TOKENS_MIN}..${DIALECT_TOKENS_MAX}). It is converted to a conservative ceiling of four bytes per token, bounded by the ${CODE_MODE_MAX_BYTES_MAX}-byte cap; it is not provider tokenization. Supplying maxOutputBytes as well keeps both limits, and the smaller one wins.`;

const LIMIT_SCHEMA = {
  yield_time_ms: Type.Optional(
    Type.Integer({
      minimum: CODE_MODE_YIELD_MIN_MS,
      maximum: CODE_MODE_YIELD_MAX_MS,
      description: YIELD_DESCRIPTION,
    }),
  ),
  yieldTimeMs: Type.Optional(
    Type.Integer({
      minimum: CODE_MODE_YIELD_MIN_MS,
      maximum: CODE_MODE_YIELD_MAX_MS,
      description: `Same field as yield_time_ms; send one spelling, or the same value. ${YIELD_DESCRIPTION}`,
    }),
  ),
  max_output_tokens: Type.Optional(
    Type.Integer({
      minimum: DIALECT_TOKENS_MIN,
      maximum: DIALECT_TOKENS_MAX,
      description: TOKEN_BUDGET_DESCRIPTION,
    }),
  ),
  maxOutputBytes: Type.Optional(
    Type.Integer({
      minimum: CODE_MODE_MAX_BYTES_MIN,
      maximum: CODE_MODE_MAX_BYTES_MAX,
      description:
        "Maximum UTF-8 bytes of new emitted cell output per read (default 51200). Poll running cells for new output; use recovery paths for full history or after terminal release, never rerun. Result and error previews are separately bounded at 32768 and 4096 bytes; capture I/O may add time.",
    }),
  ),
} as const;

// Codex names the wait budget `max_tokens`; it is the same field as
// `max_output_tokens`, and `maxOutputBytes` stays the separate byte budget.
const WAIT_LIMIT_SCHEMA = {
  max_tokens: Type.Optional(
    Type.Integer({
      minimum: DIALECT_TOKENS_MIN,
      maximum: DIALECT_TOKENS_MAX,
      description: TOKEN_BUDGET_DESCRIPTION,
    }),
  ),
  ...LIMIT_SCHEMA,
} as const;

/**
 * Render one bounded Code Mode cell result as a status line plus labeled
 * blocks containing only output delivered by this read.
 */
export function formatCodeModeResult(result: CodeModeCellResult): string {
  // A yielded cell keeps the upstream continuation phrase, then the same
  // bounded control/recovery evidence that precedes printable data.
  let text =
    result.status === "running"
      ? `Script running with cell ID ${result.cellId}. Continue with wait cell_id.\n`
      : "";
  text += `cell_id ${result.cellId}: ${result.status}`;
  if (result.unknownOutcome)
    text +=
      "\nunsettled or undeliverable nested work: outcome is unknown; committed effects are not undone; never replay automatically";
  if (result.effects)
    text += `\nnested calls: ${result.effects.completed} completed, ${result.effects.failed} failed, ${result.effects.cancelled} cancelled before dispatch, ${result.effects.unsettled} unsettled`;
  for (const shell of result.shells ?? [])
    text += `\nshell ${shell.sessionId}: ${shell.status}${shell.unknownOutcome ? " (unknown outcome)" : ""}; continue with write_stdin, not wait (or tools.write_stdin in a new exec)`;
  for (const [kind, recovery] of Object.entries(result.recovery ?? {})) {
    text += `\n${kind} recovery: ${recovery.state}${recovery.reason ? ` (${recovery.reason})` : ""}${recovery.path ? ` — ${recovery.path}` : ""} [${recovery.capturedBytes}/${recovery.bytes} UTF-8 bytes]`;
  }
  if (result.recovery)
    text +=
      "\nRecovery is a snapshot, not a final-status registry. Capturing does not certify eventual completeness; partial/unavailable is not full evidence. Read paths with an available read/shell tool; never rerun. Files may contain secrets; lifetime ends at output-owner/Pi session shutdown, not feature disablement.";
  let payload = "";
  if (result.output.length > 0) payload += `\n[output]\n${result.output}`;
  if (result.result !== undefined)
    payload += `\n[result]\n${renderResult(result.result)}`;
  if (result.error !== undefined) payload += `\n[error]\n${result.error}`;
  const available = Math.max(
    0,
    CODE_MODE_RENDER_MAX_BYTES - Buffer.byteLength(text) - 256,
  );
  const bounded = boundMessage(payload, available);
  text += bounded;
  if (bounded !== payload)
    text +=
      "\n(truncated: rendered payload clipped; inspect structured details/recovery)";
  if (
    result.output.length === 0 &&
    result.result === undefined &&
    result.error === undefined
  ) {
    text += result.status === "running" ? "\n(no new output)" : "\n(no output)";
  }
  if (result.dropped) {
    text += "\n(truncated: buffered output was dropped before this read)";
  } else if (result.truncated) {
    text +=
      "\n(truncated: output or result was clipped to the configured budget)";
  }
  return text;
}

function renderResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

/**
 * Forward bounded nested progress through Pi's partial-result callback for
 * this outer `exec` / `wait` call. Each record carries control identity only:
 * the adapter name, the cell, a shell handle when one is known, and the
 * outcome code. No command, patch, program or argument text is included, and
 * the manager bounds how many records one call receives. These are updates on
 * the outer call; Pi's `tool_call` / `tool_result` events still describe only
 * that outer call, and none is fabricated for a nested one.
 */
function nestedProgressSink(
  onUpdate: AgentToolUpdateCallback<any> | undefined,
): NestedProgressSink | undefined {
  if (!onUpdate) return undefined;
  return (record) => {
    onUpdate({
      content: [{ type: "text", text: formatNestedProgress(record) }],
      details: record,
    });
  };
}

function formatNestedProgress(record: NestedProgressRecord): string {
  const where = record.session_id ? ` (session ${record.session_id})` : "";
  const phase =
    record.phase === "start"
      ? "started"
      : record.phase === "waiting-approval"
        ? "is waiting for approval"
        : record.ok === true
          ? "completed"
          : `failed: ${record.error ?? "error"}`;
  return `nested ${record.name} ${phase} in cell ${record.cell_id}${where}`;
}

export function createCodeModeTools(
  options: CodeModeToolsOptions,
): ToolDefinition[] {
  const manager = (purpose: CodeModeManagerPurpose): CodeModeCellManager => {
    const current = options.getManager(purpose);
    if (!current) {
      throw new CodeModeError(
        "unavailable",
        "Code Mode is not available in this session.",
      );
    }
    return current;
  };

  const exec = defineTool({
    name: CODE_MODE_EXEC_TOOL,
    label: "Exec Code",
    description:
      `Run one short trusted JavaScript program (top-level await supported) with the current user's authority in a fresh per-call worker, not a security sandbox; return selected output instead of intermediate tool round trips. Send raw JavaScript source text, not JSON, a quoted string or a markdown code fence: a grammar-capable provider transports that source directly, and any other provider sends the same program as this tool's code argument. The program may start with one first-line pragma, for example // @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}; only those two options are accepted, they must agree with any argument of the same meaning, and the pragma line is blanked so source line numbers do not shift. Compose awaited or dependent tool calls, run eligible calls concurrently, and return only the evidence needed. The program runs once and is never replayed. uses validates adapter dispatch, not hostile-code containment: an adapter that is not admitted when the nested call dispatches fails that call alone, and under confirm a nested apply_patch call needs a dialog-capable UI at that moment. Declared calls dispatch through each adapted tool's existing executor, keeping its validation, disabled state, ordering, and file mutation queues. Pi's per-call tool_call/tool_result hooks and third-party permission interceptors see this outer exec call (with the full code and any uses list), not the nested calls; only nested Apply Patch calls are additionally gated by Code Mode approval. Shell retains direct-shell authority. Successful completion waits for tracked transitive tool calls, not arbitrary future JavaScript activity. Failure fences unsent calls and cooperatively aborts unsettled dispatched work, without rollback. Outstanding RPCs are limited to ${CODE_MODE_PENDING_CALLS} calls and ${CODE_MODE_PENDING_CALL_BYTES} serialized argument bytes; individual payloads and queued replies are bounded too. Await modest batches instead of unbounded fan-out. If the program has not settled within yield_time_ms, the call answers Script running with cell ID <cell_id>: continue that cell with wait cell_id.\n` +
      CODE_MODE_ADAPTER_HELP,
    parameters: Type.Object(
      {
        code: Type.String({
          minLength: 1,
          description:
            "JavaScript program with top-level await. A returned JSON-serializable value becomes the cell result; print/console/text output becomes cell output.",
        }),
        uses: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), {
            uniqueItems: true,
            description:
              "Exact adapted-tool names this program may call through tools.<name>(args); must be a unique subset of exec_command, write_stdin, and apply_patch that is currently available. Nested arguments mirror those direct tools' JSON arguments. Omit to declare every currently available adapter, or send [] to declare none. Calling an undeclared tool fails inside the cell.",
          }),
        ),
        ...LIMIT_SCHEMA,
      },
      { additionalProperties: false },
    ),
    // Raw-source transport for providers that support grammar tools; Pi
    // decodes the source into `code`, and the JSON form stays available.
    constrainedSampling: EXEC_CONSTRAINED_SAMPLING,
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      if (!options.isExecEnabled()) {
        throw new Error("Code Mode is not enabled.");
      }
      // Dialect first, so a malformed call is refused before any policy check.
      // Nested Apply Patch approval is asked for at the actual nested call,
      // where the effect and the current authority are both known.
      const input = normalizeExecArgs(params);
      const result = await manager("admit").exec(
        {
          code: input.code,
          uses: input.uses,
          yieldTimeMs: input.yieldTimeMs,
          maxOutputBytes: input.maxOutputBytes,
          context: ctx,
          onProgress: nestedProgressSink(onUpdate),
        },
        signal,
      );
      return {
        content: [{ type: "text", text: formatCodeModeResult(result) }],
        details: result,
      };
    },
  });

  const wait = defineTool({
    name: CODE_MODE_WAIT_TOOL,
    label: "Wait For Cell",
    description:
      "Continue a Code Mode cell returned by exec: return new output, deliver a completed or failed result, or terminate the cell. Use it after exec reports Script running with cell ID. Send the handle as cell_id or cellId: one field, one spelling or the same value, and always the opaque string, never a number or a shell session ID. yield_time_ms bounds this observation, max_tokens (the same field as max_output_tokens) bounds the new output this call returns, and terminate: true stops the cell. Polling never re-runs the program, and only output produced since the previous read is returned; reading a terminal state returns it and releases the handle. An unconfirmed worker stop is not terminal settlement: keep the handle and continue waiting/terminating; never replay.",
    parameters: Type.Object(
      {
        cell_id: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Opaque cell handle returned by exec. Handles are scoped to this session's Code Mode manager. Send exactly one of cell_id or cellId.",
          }),
        ),
        cellId: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Same field as cell_id; send one spelling, or the same value.",
          }),
        ),
        terminate: Type.Optional(
          Type.Boolean({
            description:
              "Request worker termination; a terminal read releases the handle, and only a stop left unconfirmed before the program finishes retains it. In-flight nested calls are aborted; completed actions are not undone or retried, and an in-flight nested call's outcome is reported as unknown. Defaults to false.",
          }),
        ),
        ...WAIT_LIMIT_SCHEMA,
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params, signal, onUpdate, _ctx) => {
      if (!options.isWaitEnabled()) {
        throw new Error("Code Mode is not enabled.");
      }
      const input = normalizeWaitArgs(params);
      const result = await manager("observe").wait(
        {
          cellId: input.cellId,
          yieldTimeMs: input.yieldTimeMs,
          maxOutputBytes: input.maxOutputBytes,
          terminate: input.terminate,
          onProgress: nestedProgressSink(onUpdate),
        },
        signal,
      );
      return {
        content: [{ type: "text", text: formatCodeModeResult(result) }],
        details: result,
      };
    },
  });

  return [exec, wait];
}
