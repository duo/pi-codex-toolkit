import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

import { APPLY_PATCH_TOOL } from "../apply-patch.ts";
import { takeLeadingCodePoints } from "../bounded-text.ts";
import {
  ExecutionDialectError,
  normalizeNestedPatchArgs,
  normalizeShellContinuationArgs,
  normalizeShellStartArgs,
  withShellDialectFields,
  type NormalizedShellContinuation,
  type NormalizedShellStart,
} from "../execution-dialect.ts";
import {
  ExecutionPolicyError,
  resolveInvocation,
  type ExecutionInvocationContext,
  type ExecutionInvocationHooks,
  type ExecutionInvocationTool,
} from "../execution-invocation.ts";
import type { ShellExecutor } from "../shell/manager.ts";
import {
  EXEC_COMMAND_TOOL,
  WRITE_STDIN_TOOL,
  EXEC_COMMAND_SCHEMA,
  WRITE_STDIN_SCHEMA,
} from "../shell/tools.ts";
import {
  CodeModeError,
  type CellDispatcher,
  type CodeModeCellContext,
  type CodeModeShellContinuation,
  CODE_MODE_PENDING_CALLS,
  CODE_MODE_PENDING_CALL_BYTES,
} from "./manager.ts";

export type CodeModeApprovalMode = "confirm" | "always";

export interface MutationApprovalRequest {
  name: string;
  args: unknown;
  cellId: string;
  /** Opaque host context captured from the outer exec call. */
  context: unknown;
  signal: AbortSignal | undefined;
}

export type MutationApprovalHandler = (
  request: MutationApprovalRequest,
) => Promise<boolean>;

export interface CodeModeApplyPatchAdapter {
  /**
   * The Toolkit-owned Apply Patch definition. Arguments are validated against
   * its TypeBox parameters, then dispatched through its own `execute`, which
   * keeps the path, mutation-queue, and partial-commit contract.
   */
  definition: ToolDefinition<any, any, any>;
  isEnabled?: () => boolean;
}

export interface CodeModeAdaptersOptions {
  /** The one shared shell executor; Code Mode never spawns its own backend. */
  shell?: Pick<ShellExecutor, "start" | "write"> & {
    continuation?(sessionId: string): CodeModeShellContinuation | undefined;
  };
  /**
   * Fallback gate for both shell adapters when the split options are absent.
   */
  shellEnabled?: () => boolean;
  /**
   * Gate for nested `exec_command`: each call starts a fresh shell effect,
   * so it follows the pending contraction fence. Falls back to
   * `shellEnabled`.
   */
  shellStartEnabled?: () => boolean;
  /**
   * Gate for nested `write_stdin`: continuation control on sessions the
   * committed projection owns. Falls back to `shellEnabled`.
   */
  shellContinueEnabled?: () => boolean;
  applyPatch?: CodeModeApplyPatchAdapter;
  approvalMode?: CodeModeApprovalMode | (() => CodeModeApprovalMode);
  requestApproval?: MutationApprovalHandler;
  /**
   * Generic invocation seam, applied exactly as the direct tools apply it:
   * trusted per-call environment, then the applicable policy decision, then
   * the adapted executor.
   */
  invocationHooks?: ExecutionInvocationHooks;
  maxConcurrentCalls?: number;
  maxPendingCalls?: number;
  pendingCallBytes?: number;
}

export interface CodeModeAdapterEntry {
  name: ExecutionInvocationTool;
  mode: "sequential" | "concurrent";
  mutating: boolean;
  /**
   * Resolve the supported call dialect before validation, admission or
   * approval. It receives the model's raw argument and returns this tool's
   * canonical JSON object; the schema then rechecks types and ranges.
   */
  normalize(args: unknown): unknown;
  invoke(
    args: unknown,
    context: ExtensionContext,
    signal: AbortSignal,
    onSession?: (sessionId: string) => void,
    /** Trusted per-call environment overlay from the invocation seam. */
    env?: Record<string, string>,
  ): Promise<unknown>;
}

export const CODE_MODE_MAX_CONCURRENT_CALLS = 4;

/**
 * Adapter registry over existing executors. It implements the manager's
 * dispatch seam; every entry validates arguments and rechecks its enabled
 * state before invoking the adapted feature's own execution path.
 */
export class CodeModeAdapters implements CellDispatcher {
  private readonly entries = new Map<
    string,
    { entry: CodeModeAdapterEntry; isEnabled: () => boolean; schema: TSchema }
  >();
  readonly tracksDispatch = true;
  private readonly sequentialGates = new WeakMap<object, BoundedGate>();
  private readonly reservations = new WeakMap<
    object,
    { calls: number; bytes: number }
  >();
  private readonly shellIds = new WeakMap<object, Set<string>>();
  private readonly shellStates = new Map<string, CodeModeShellContinuation>();
  private readonly shell: CodeModeAdaptersOptions["shell"];
  private readonly maxPendingCalls: number;
  private readonly pendingCallBytes: number;
  private readonly concurrencyGates = new WeakMap<object, BoundedGate>();
  private readonly approvalModeOption:
    | CodeModeApprovalMode
    | (() => CodeModeApprovalMode);
  private readonly approval: MutationApprovalHandler;
  private readonly invocationHooks: ExecutionInvocationHooks | undefined;
  private readonly maxConcurrentCalls: number;

  constructor(options: CodeModeAdaptersOptions) {
    this.shell = options.shell;
    this.maxPendingCalls = options.maxPendingCalls ?? CODE_MODE_PENDING_CALLS;
    this.pendingCallBytes =
      options.pendingCallBytes ?? CODE_MODE_PENDING_CALL_BYTES;
    this.approvalModeOption = options.approvalMode ?? "confirm";
    this.approval = options.requestApproval ?? defaultMutationApproval;
    this.invocationHooks = options.invocationHooks;
    this.maxConcurrentCalls =
      options.maxConcurrentCalls ?? CODE_MODE_MAX_CONCURRENT_CALLS;
    for (const limit of [
      this.maxConcurrentCalls,
      this.maxPendingCalls,
      this.pendingCallBytes,
    ]) {
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new CodeModeError(
          "invalid-limit",
          "Adapter admission limits must be positive integers.",
        );
    }

    if (options.shell) {
      const shell = options.shell;
      const shellEnabled = options.shellEnabled ?? ((): boolean => true);
      const isStartEnabled = options.shellStartEnabled ?? shellEnabled;
      const isContinueEnabled = options.shellContinueEnabled ?? shellEnabled;
      this.entries.set(EXEC_COMMAND_TOOL, {
        isEnabled: isStartEnabled,
        schema: EXEC_COMMAND_SCHEMA,
        entry: {
          name: EXEC_COMMAND_TOOL,
          mode: "concurrent",
          mutating: false,
          normalize: normalizeShellStartArgs,
          invoke: async (args, context, signal, onSession, env) => {
            const input = args as NormalizedShellStart;
            const result = await shell.start(
              {
                command: input.command,
                cwd: invocationCwd(EXEC_COMMAND_TOOL, input, context),
                yieldTimeMs: input.yieldTimeMs,
                maxOutputBytes: input.maxOutputBytes,
                ...(env === undefined ? {} : { env }),
              },
              signal,
              onSession,
            );
            return withShellDialectFields(result);
          },
        },
      });
      this.entries.set(WRITE_STDIN_TOOL, {
        isEnabled: isContinueEnabled,
        schema: WRITE_STDIN_SCHEMA,
        entry: {
          name: WRITE_STDIN_TOOL,
          mode: "concurrent",
          mutating: false,
          normalize: normalizeShellContinuationArgs,
          invoke: async (args, _context, signal, onSession) => {
            const input = args as NormalizedShellContinuation;
            onSession?.(input.sessionId);
            const result = await shell.write(
              {
                sessionId: input.sessionId,
                input: input.input,
                closeStdin: input.closeStdin,
                terminate: input.terminate,
                yieldTimeMs: input.yieldTimeMs,
                maxOutputBytes: input.maxOutputBytes,
              },
              signal,
              // The cell's fence ends this call, not the shell: a polled shell
              // is independent. A nested exec_command's first observation stays
              // the cell's own work and is stopped on the executor default.
              { cancellation: "detach" },
            );
            return withShellDialectFields(result);
          },
        },
      });
    }

    if (options.applyPatch) {
      const definition = options.applyPatch.definition;
      this.entries.set(APPLY_PATCH_TOOL, {
        isEnabled: options.applyPatch.isEnabled ?? ((): boolean => true),
        schema: definition.parameters,
        entry: {
          name: APPLY_PATCH_TOOL,
          mode: "sequential",
          mutating: true,
          normalize: normalizeNestedPatchArgs,
          invoke: async (args, context, signal) => {
            const result = await definition.execute(
              `pct-nested-${randomUUID()}`,
              args,
              signal,
              undefined,
              context,
            );
            return result.details;
          },
        },
      });
    }
  }

  get allowedNames(): string[] {
    return [...this.entries.keys()];
  }

  /** Adapter names whose enabled predicate currently passes. */
  admittedNames(): string[] {
    return [...this.entries.values()]
      .filter((runtime) => runtime.isEnabled())
      .map((runtime) => runtime.entry.name);
  }

  get mutatingNames(): string[] {
    return [...this.entries.values()]
      .filter((runtime) => runtime.entry.mutating)
      .map((runtime) => runtime.entry.name);
  }

  async call(
    name: string,
    args: unknown,
    signal: AbortSignal,
    cell: CodeModeCellContext,
    onDispatch?: () => void,
  ): Promise<unknown> {
    const runtime = this.entries.get(name);
    if (!runtime) {
      throw new CodeModeError(
        "unknown-adapter",
        `Nested tool "${name}" is not adapted for Code Mode. Adapted tools: ${this.allowedNames.join(", ") || "(none)"}.`,
      );
    }
    const eligible = () => {
      assertNotAborted(name, signal);
      if (!runtime.isEnabled())
        throw new CodeModeError(
          "adapter-disabled",
          `Nested ${name} is currently disabled.`,
        );
    };
    eligible();
    // One dialect for direct and nested calls: spellings, alias conflicts,
    // unsupported Codex fields and the nested Patch string are resolved into
    // this tool's canonical object before validation or any effect.
    let input: unknown;
    try {
      input = runtime.entry.normalize(args);
    } catch (error) {
      if (error instanceof ExecutionDialectError)
        throw new CodeModeError("invalid-arguments", error.message);
      throw error;
    }
    // Same schema as the direct tool, including additionalProperties/ranges.
    // Validation and context checks precede any dialog or queue admission.
    if (!Value.Check(runtime.schema, input)) {
      const errors = Array.from(Value.Errors(runtime.schema, input))
        .slice(0, 5)
        .map((error) => `${error.instancePath || "/"}: ${error.message}`)
        .join("; ");
      throw new CodeModeError(
        "invalid-arguments",
        `${name} arguments are invalid: ${errors}`,
      );
    }
    const context = asExtensionContext(cell.hostContext);
    let json: string;
    try {
      json = JSON.stringify(input);
    } catch {
      throw new CodeModeError(
        "invalid-arguments",
        "Arguments must be JSON-serializable.",
      );
    }
    const bytes = Buffer.byteLength(json);
    const reservation = this.reservations.get(cell) ?? { calls: 0, bytes: 0 };
    if (
      reservation.calls >= this.maxPendingCalls ||
      reservation.bytes + bytes > this.pendingCallBytes
    )
      throw new CodeModeError(
        "bridge-overload",
        "Nested adapter queue count/byte limit exceeded; no dispatch.",
      );
    reservation.calls++;
    reservation.bytes += bytes;
    this.reservations.set(cell, reservation);
    // The handle this call names, for the invocation seam and progress: a
    // continuation call carries one, a fresh start does not have one yet.
    const named = (input as { sessionId?: unknown }).sessionId;
    const handle = typeof named === "string" ? named : undefined;
    const task = async (): Promise<unknown> => {
      eligible();
      // Same seam as the direct tools, applied after admission and before the
      // effect-specific confirmation: trusted per-call environment, then
      // policy. A denied call never opens the approval dialog, and nothing has
      // run when it rejects.
      const invocation = await this.applyInvocationSeam(runtime.entry.name, {
        cwd: invocationCwd(runtime.entry.name, input, context),
        cellId: cell.cellId,
        ...(handle === undefined ? {} : { sessionId: handle }),
      });
      eligible();
      if (runtime.entry.mutating && this.approvalMode() === "confirm") {
        // The only extra Code Mode approval, asked for this actual mutation
        // rather than for merely listing the adapter in `uses`. Without a
        // dialog-capable context the approval path reports
        // `approval-unavailable` for this nested call alone.
        cell.reportProgress?.({
          phase: "waiting-approval",
          name,
          ...(handle === undefined ? {} : { sessionId: handle }),
        });
        const approved = await awaitApproval(
          this.approval({
            name,
            args: input,
            cellId: cell.cellId,
            context,
            signal,
          }),
          signal,
        );
        if (!approved) {
          throw new CodeModeError(
            "approval-denied",
            `Nested ${name} was not approved; nothing was changed.`,
          );
        }
      }
      eligible();
      onDispatch?.();
      const result = await runtime.entry.invoke(
        input,
        context,
        signal,
        (sessionId) => this.recordShell(cell, { sessionId, status: "running" }),
        invocation.env,
      );
      if (name === EXEC_COMMAND_TOOL || name === WRITE_STDIN_TOOL)
        this.recordShell(cell, result);
      return result;
    };

    try {
      return await (runtime.entry.mode === "sequential"
        ? this.runSequential(
            cell,
            () => this.runConcurrent(cell, task, signal),
            signal,
          )
        : this.runConcurrent(cell, task, signal));
    } finally {
      reservation.calls--;
      reservation.bytes -= bytes;
    }
  }

  /**
   * Apply the shared invocation seam to one nested call, mapping a policy
   * denial onto the nested error union. Nothing has run when it throws.
   */
  private async applyInvocationSeam(
    tool: ExecutionInvocationTool,
    call: { cwd: string; cellId: string; sessionId?: string },
  ): Promise<ExecutionInvocationContext> {
    try {
      return await resolveInvocation(this.invocationHooks, {
        tool,
        path: "nested",
        ...call,
      });
    } catch (error) {
      if (error instanceof ExecutionPolicyError)
        throw new CodeModeError("policy-denied", error.message);
      throw error;
    }
  }

  private approvalMode(): CodeModeApprovalMode {
    const value =
      typeof this.approvalModeOption === "function"
        ? this.approvalModeOption()
        : this.approvalModeOption;
    return value === "always" ? "always" : "confirm";
  }

  private async runSequential(
    cell: CodeModeCellContext,
    task: () => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    let gate = this.sequentialGates.get(cell);
    if (!gate) {
      gate = new BoundedGate(1);
      this.sequentialGates.set(cell, gate);
    }
    // Abort removes and settles the waiter, even if the current executor ignores
    // abort. Unlike chained closures, it retains no cancelled argument payload.
    await gate.acquire(signal);
    try {
      return await task();
    } finally {
      gate.release();
    }
  }

  private recordShell(cell: CodeModeCellContext, value: unknown): void {
    if (!value || typeof value !== "object") return;
    const result = value as {
      sessionId?: string;
      status?: string;
      unknownOutcome?: boolean;
    };
    if (typeof result.sessionId !== "string") return;
    if (result.status !== "running" && !result.unknownOutcome) {
      this.shellStates.delete(result.sessionId);
      return;
    }
    let ids = this.shellIds.get(cell);
    if (!ids) {
      ids = new Set();
      this.shellIds.set(cell, ids);
    }
    ids.add(result.sessionId);
    this.shellStates.set(result.sessionId, {
      sessionId: result.sessionId,
      status: result.status === "running" ? "running" : "terminated",
      ...(result.unknownOutcome ? { unknownOutcome: true } : {}),
    });
    this.continuations(cell);
    // Keep only currently owned live/uncertain routing, not a shell history.
    if (this.shell?.continuation)
      for (const id of this.shellStates.keys()) {
        if (!this.shell.continuation(id)) this.shellStates.delete(id);
      }
  }

  continuations(cell: CodeModeCellContext): CodeModeShellContinuation[] {
    const result: CodeModeShellContinuation[] = [];
    const ids = this.shellIds.get(cell);
    if (!ids) return result;
    for (const id of ids) {
      const state = this.shell?.continuation
        ? this.shell.continuation(id)
        : this.shellStates.get(id);
      if (state) result.push(state);
      else {
        ids.delete(id);
        this.shellStates.delete(id);
      }
    }
    return result;
  }

  private async runConcurrent(
    cell: CodeModeCellContext,
    task: () => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    let gate = this.concurrencyGates.get(cell);
    if (!gate) {
      gate = new BoundedGate(this.maxConcurrentCalls);
      this.concurrencyGates.set(cell, gate);
    }
    await gate.acquire(signal);
    try {
      return await task();
    } finally {
      gate.release();
    }
  }
}

interface GateWaiter {
  grant: () => void;
  fail: (error: unknown) => void;
}

class BoundedGate {
  private active = 0;
  private readonly waiting: GateWaiter[] = [];

  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortedError();
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: GateWaiter = {
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          this.active += 1;
          resolve();
        },
        fail: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        waiter.fail(abortedError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next.grant();
  }
}

/**
 * The directory one nested call runs in. Only a fresh `exec_command` may name
 * its own workdir; it resolves against the invoking session directory exactly
 * as the direct tool resolves it, so both paths report the same cwd.
 */
function invocationCwd(
  name: ExecutionInvocationTool,
  input: unknown,
  context: ExtensionContext,
): string {
  if (name !== EXEC_COMMAND_TOOL) return context.cwd;
  const cwd = (input as NormalizedShellStart).cwd;
  return cwd === undefined || cwd.length === 0
    ? context.cwd
    : resolve(context.cwd, cwd);
}

/**
 * True when the captured context can show a confirmation dialog. The default
 * adapter approval consults it at the actual nested dispatch; there is no
 * pre-dispatch gate on the tools layer, so declaring a mutating adapter never
 * refuses the cell itself.
 */
export function hasMutationApprovalUI(context: unknown): boolean {
  if (typeof context !== "object" || context === null) return false;
  const candidate = context as {
    hasUI?: unknown;
    ui?: { confirm?: unknown };
  };
  return (
    candidate.hasUI === true && typeof candidate.ui?.confirm === "function"
  );
}

/**
 * Default approval path: ask through the captured context's UI. Without a
 * dialog-capable UI the nested mutation is blocked with a clear error instead
 * of dispatching silently.
 */
export function defaultMutationApproval(
  request: MutationApprovalRequest,
): Promise<boolean> {
  if (!hasMutationApprovalUI(request.context)) {
    return Promise.reject(
      new CodeModeError(
        "approval-unavailable",
        `Code Mode needs UI confirmation before running nested ${request.name}, but no dialog-capable UI is available. Set Code Mode nested Apply Patch confirmation to Always or run in an interactive session.`,
      ),
    );
  }
  const context = request.context as ExtensionContext;
  const message = `Code Mode cell ${request.cellId} will run ${request.name}.\n\n${summarizeArguments(request.args)}`;
  return context.ui.confirm(
    "Code Mode nested tool",
    message,
    request.signal ? { signal: request.signal } : undefined,
  );
}

/** The approval dialog's argument preview, truncation marker included. */
const ARGUMENT_PREVIEW_MAX_BYTES = 800;
const ARGUMENT_PREVIEW_MARKER = "\n... (argument preview truncated)";
const ARGUMENT_PREVIEW_MARKER_BYTES = Buffer.byteLength(
  ARGUMENT_PREVIEW_MARKER,
  "utf8",
);

function summarizeArguments(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? String(args);
  } catch {
    text = String(args);
  }
  if (Buffer.byteLength(text, "utf8") <= ARGUMENT_PREVIEW_MAX_BYTES)
    return text;
  const head = takeLeadingCodePoints(
    text,
    ARGUMENT_PREVIEW_MAX_BYTES - ARGUMENT_PREVIEW_MARKER_BYTES,
  ).text;
  return `${head}${ARGUMENT_PREVIEW_MARKER}`;
}

function asExtensionContext(context: unknown): ExtensionContext {
  const cwd = (context as { cwd?: unknown } | undefined)?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new CodeModeError(
      "invalid-arguments",
      "Code Mode nested tools need the invoking session context.",
    );
  }
  return context as ExtensionContext;
}

function awaitApproval(
  approval: Promise<boolean>,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortedError());
    };
    signal.addEventListener("abort", abort, { once: true });
    // Always observe a late rejection, but never resume dispatch after abort.
    void approval
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function assertNotAborted(name: string, signal: AbortSignal): void {
  if (signal.aborted) throw abortedError(name);
}

function abortedError(name?: string): CodeModeError {
  return new CodeModeError(
    "aborted",
    name === undefined
      ? "The Code Mode cell was terminated before this nested call ran."
      : `Nested ${name} was aborted before it ran because the Code Mode cell was terminated.`,
  );
}
