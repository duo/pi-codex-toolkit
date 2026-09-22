import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  ExecutionOutputOwner,
  type ExecutionOutputCapture,
  type ExecutionOutputRecovery,
} from "../execution-output.ts";
import { BoundedTextBuffer, takeLeadingCodePoints } from "../bounded-text.ts";
import { SHELL_SESSION_PREFIX } from "../shell/manager.ts";

export type CodeModeCellStatus =
  | "running"
  | "completed"
  | "failed"
  | "terminated";

/** One bounded result for an exec/wait read of a Code Mode cell. */
export interface CodeModeCellResult {
  cellId: string;
  status: CodeModeCellStatus;
  /** New print/console output since the previous read of this cell. */
  output: string;
  /** Completed only: bounded, JSON-serializable return value. */
  result?: unknown;
  /** Bounded failure/termination message when available. */
  error?: string;
  /** This read or a buffer/result/error preview cap clipped bytes. */
  truncated: boolean;
  /** Buffered bytes were lost to the output cap before this read. */
  dropped: boolean;
  /** Nested effects are unsettled or their result could not be delivered. */
  unknownOutcome?: boolean;
  /** Independent routing, never inferred from the optional JS value. */
  shells?: CodeModeShellContinuation[];
  recovery?: Partial<
    Record<"output" | "result" | "error", ExecutionOutputRecovery>
  >;
  clipping?: { output: boolean; result: boolean; error: boolean };
  effects?: {
    completed: number;
    failed: number;
    cancelled: number;
    unsettled: number;
  };
}

export interface CodeModeShellContinuation {
  sessionId: string;
  status: "running" | "terminated";
  unknownOutcome?: boolean;
}

/**
 * One bounded nested-progress record, forwarded through the outer `exec` /
 * `wait` call's own update callback. It carries control identity only: no
 * command, patch or program text, and no adapter arguments or results.
 */
export interface NestedProgressRecord {
  readonly nested: true;
  readonly phase: "start" | "waiting-approval" | "end";
  readonly name: string;
  readonly cell_id: string;
  readonly session_id?: string;
  /** End only: whether the nested call settled successfully. */
  readonly ok?: boolean;
  /** End only: the failure's error code, never its message. */
  readonly error?: string;
}

/** Sink installed by one outer call; the manager bounds what it receives. */
export type NestedProgressSink = (record: NestedProgressRecord) => void;

/** Records one outer `exec`/`wait` call forwards before it stops reporting. */
export const CODE_MODE_PROGRESS_MAX_RECORDS = 32;
/** Per-field ceiling for a progress record; identities are already short. */
export const CODE_MODE_PROGRESS_FIELD_BYTES = 128;

/**
 * Per-cell bridge object. The manager creates exactly one per cell and passes
 * the same object to every nested dispatch so adapters can key per-cell state
 * (sequential chains, concurrency gates) without a second registry.
 */
export interface CodeModeCellContext {
  readonly cellId: string;
  /** Opaque value captured from the outer exec call; adapters interpret it. */
  readonly hostContext: unknown;
  /**
   * Report a nested phase the dispatcher owns, currently the wait for Code
   * Mode approval. The manager adds the cell identity, bounds the record and
   * fans it out to the outer calls observing this cell; it never emits a Pi
   * `tool_call` / `tool_result` event.
   */
  readonly reportProgress?: (event: {
    phase: "waiting-approval";
    name: string;
    sessionId?: string;
  }) => void;
}

/**
 * Narrow nested-tool dispatch seam. Tests can fake it; production wires the
 * adapter registry. The manager never reaches into Pi internals.
 */
export interface CellDispatcher {
  /** Exact adapter names a cell's `uses` list may declare. */
  readonly allowedNames: readonly string[];
  /**
   * Adapter names dispatchable right now. A cell snapshots this set at
   * creation as its capability ceiling: later route expansions never enlarge
   * an existing cell, while contractions still apply through the adapter's
   * own dispatch-time recheck.
   */
  admittedNames?(): readonly string[];
  /** Adapter names whose dispatch requires Code Mode approval. */
  readonly mutatingNames?: readonly string[];
  /** Production adapters distinguish queued admission from actual effects. */
  readonly tracksDispatch?: boolean;
  continuations?(cell: CodeModeCellContext): CodeModeShellContinuation[];
  call(
    name: string,
    args: unknown,
    signal: AbortSignal,
    cell: CodeModeCellContext,
    onDispatch?: () => void,
  ): Promise<unknown>;
}

export interface CodeModeExecInput {
  code: string;
  /**
   * Adapter names this cell may call. Omitted declares every adapter the
   * dispatcher currently admits; `[]` declares none. Either way the declared
   * set is snapshotted at creation and is also the cell's ceiling.
   */
  uses?: string[];
  yieldTimeMs?: number;
  maxOutputBytes?: number;
  /** Opaque host context (the Pi ExtensionContext in production). */
  context?: unknown;
  /** Bounded nested progress for this call only; never a cell subscription. */
  onProgress?: NestedProgressSink;
}

export interface CodeModeWaitInput {
  cellId: string;
  yieldTimeMs?: number;
  maxOutputBytes?: number;
  terminate?: boolean;
  /** Bounded nested progress for this call only; never a cell subscription. */
  onProgress?: NestedProgressSink;
}

export interface CodeModeCellManagerOptions {
  dispatcher: CellDispatcher;
  maxRunning?: number;
  maxCompleted?: number;
  completedRetentionMs?: number;
  outputBufferBytes?: number;
  resultMaxBytes?: number;
  memoryOldGenerationMb?: number;
  memoryYoungGenerationMb?: number;
  terminationWaitMs?: number;
  /** Brief window after new output to let a nearly-finished cell report completion. */
  settleGraceMs?: number;
  /**
   * How long a finished worker may stay live after the host's shutdown packet
   * before it is terminated once, for example while user code scheduled past
   * done keeps it busy. Independent of the stop window, terminationWaitMs.
   */
  shutdownGraceMs?: number;
  /** Retention clock; tests may inject a fake. Defaults to Date.now. */
  now?: () => number;
  outputOwner?: ExecutionOutputOwner;
  /** Outstanding requests, not just active executors. */
  maxPendingCalls?: number;
  pendingCallBytes?: number;
  callPayloadBytes?: number;
  /** Bounded nested-progress records one outer call may forward. */
  progressMaxRecords?: number;
}

export type CodeModeErrorCode =
  | "invalid-code"
  | "invalid-uses"
  | "invalid-limit"
  | "invalid-input"
  | "cell-limit"
  | "stale-cell"
  | "closed"
  | "unavailable"
  | "cell-start-failed"
  | "unknown-adapter"
  | "adapter-disabled"
  | "invalid-arguments"
  | "approval-unavailable"
  | "approval-denied"
  | "policy-denied"
  | "aborted"
  | "bridge-overload"
  | "cleanup-incomplete";

export class CodeModeError extends Error {
  constructor(
    readonly code: CodeModeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodeModeError";
  }
}

export const CODE_MODE_CELL_PREFIX = "pct-cell-";
export const CODE_MODE_YIELD_MIN_MS = 0;
export const CODE_MODE_YIELD_MAX_MS = 60_000;
export const CODE_MODE_YIELD_DEFAULT_MS = 10_000;
export const CODE_MODE_MAX_BYTES_MIN = 1_024;
export const CODE_MODE_MAX_BYTES_MAX = 262_144;
export const CODE_MODE_MAX_BYTES_DEFAULT = 51_200;
export const CODE_MODE_MAX_RUNNING = 4;
export const CODE_MODE_MAX_COMPLETED = 16;
export const CODE_MODE_COMPLETED_RETENTION_MS = 5 * 60_000;
export const CODE_MODE_OUTPUT_BUFFER_BYTES = 256 * 1024;
export const CODE_MODE_RESULT_MAX_BYTES = 32 * 1024;
export const CODE_MODE_MEMORY_OLD_GENERATION_MB = 64;
export const CODE_MODE_MEMORY_YOUNG_GENERATION_MB = 8;
export const CODE_MODE_TERMINATION_WAIT_MS = 5_000;
export const CODE_MODE_SETTLE_GRACE_MS = 50;
export const CODE_MODE_SHUTDOWN_GRACE_MS = 5_000;
export const CODE_MODE_ERROR_MAX_BYTES = 4 * 1024;
// One existing cell-output envelope for queued arguments/replies. Sixteen
// outstanding calls allows four active plus three batches, independently of
// payload size; the existing completed-cell envelope also bounds tiny RPCs.
export const CODE_MODE_PENDING_CALLS = CODE_MODE_MAX_COMPLETED;
export const CODE_MODE_PENDING_CALL_BYTES = CODE_MODE_OUTPUT_BUFFER_BYTES;
export const CODE_MODE_CALL_PAYLOAD_BYTES = CODE_MODE_OUTPUT_BUFFER_BYTES;

/**
 * Inline worker bootstrap. One worker per cell; the user program runs inside a
 * fresh `vm` context whose only capabilities are `tools.<declared>`, `print`,
 * and `console.log/warn/error`. This is the probe-finalized runtime from
 * research/runtime-probe.md: no worker asset file, no new dependency.
 *
 * The worker posts output as it is produced and waits for the parent to
 * acknowledge those bytes, bounding the host output queue even for synchronous
 * bursts. This is not an overall RSS/heap or sandbox guarantee.
 */
const CELL_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const util = require("node:util");

const config = workerData || {};
const credit = new Int32Array(config.outputCredit);
const maxCalls = config.maxPendingCalls;
const maxCallBytes = config.pendingCallBytes;
const maxPayloadBytes = config.callPayloadBytes;
const declared = Array.isArray(config.declared) ? config.declared.slice() : [];
const known = Array.isArray(config.known) ? config.known.slice() : [];
const declaredSet = new Set(declared);
const knownSet = new Set(known);

const state = {
  done: false,
  calls: new Map(),
  callSeq: 0,
  callBytes: 0,
  programSettled: false,
  value: undefined,
  serialized: false,
  resultJson: undefined,
  completionScheduled: false,
};

// Synchronous print cannot await an async ACK. Block ONLY this worker on one
// shared credit, released by the host AFTER append settles. At most one <=32KiB
// chunk is in transport, including synchronous print bursts and final values.
// worker.terminate interrupts Atomics.wait; the host event loop never blocks.
function sendText(kind, text) {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 8192);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    const chunk = text.slice(offset, end);
    Atomics.store(credit, 0, 1);
    parentPort.postMessage({ type: "capture", kind: kind, text: chunk });
    while (Atomics.load(credit, 0) === 1) Atomics.wait(credit, 0, 1);
    offset = end;
  }
}
function appendOutput(text) {
  if (!state.done && typeof text === "string") sendText("output", text);
}

function formatArguments(args) {
  const parts = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (typeof value === "string") {
      parts.push(value);
      continue;
    }
    try {
      parts.push(
        util.inspect(value, {
          depth: 6,
          breakLength: Infinity,
          maxArrayLength: 100,
        }),
      );
    } catch (error) {
      parts.push(String(value));
    }
  }
  return parts.join(" ") + "\n";
}

function printValues() {
  appendOutput(formatArguments(Array.prototype.slice.call(arguments)));
}

// Codex's text(): a string is appended exactly as given, with no added
// newline. Other values are stringified with JSON.stringify when that yields
// a string, and otherwise fall back to the same formatter print uses.
function appendTextItem(value) {
  if (typeof value === "string") {
    appendOutput(value);
    return;
  }
  var json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    json = undefined;
  }
  if (typeof json === "string") appendOutput(json);
  else appendOutput(formatArguments([value]));
}

function nestedToolCall(name, args) {
  if (state.done) {
    return Promise.reject(
      new Error("The Code Mode cell has already finished; no further nested calls are accepted."),
    );
  }
  if (state.calls.size >= maxCalls) return Promise.reject(new Error("Nested bridge overload: too many outstanding calls; await a batch before submitting more."));
  let json;
  try {
    json = JSON.stringify(args, function (_key, value) {
      if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("Arguments must be JSON-serializable.");
      return value;
    });
    if (json === undefined) throw new Error("Arguments must be JSON-serializable.");
  } catch (error) { return Promise.reject(error); }
  // Getters/toJSON can submit calls recursively while serializing arguments.
  // Recheck count at the actual reservation boundary, just like byte admission.
  if (state.calls.size >= maxCalls) return Promise.reject(new Error("Nested bridge overload: too many outstanding calls; await a batch before submitting more."));
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxPayloadBytes || state.callBytes + bytes > maxCallBytes) return Promise.reject(new Error("Nested bridge overload: serialized argument byte limit exceeded; use smaller batches/payloads."));
  let resolveCall;
  let rejectCall;
  const promise = new Promise(function (resolve, reject) {
    resolveCall = resolve;
    rejectCall = reject;
  });
  const callId = ++state.callSeq;
  state.calls.set(callId, {
    promise: promise,
    resolve: resolveCall,
    reject: rejectCall,
    bytes: bytes,
  });
  state.callBytes += bytes;
  try {
    parentPort.postMessage({
      type: "call",
      callId: callId,
      name: name,
      argsJson: json,
    });
  } catch (error) {
    state.calls.delete(callId);
    state.callBytes -= bytes;
    rejectCall(
      new Error(
        'Nested tool "' +
          name +
          '" arguments could not be delivered to the host: ' +
          (error && error.message ? error.message : String(error)) +
          ". Arguments must be JSON-serializable.",
      ),
    );
  }
  return promise;
}

function settleCall(message) {
  const pending = state.calls.get(message.callId);
  if (!pending) return;
  state.calls.delete(message.callId);
  state.callBytes -= pending.bytes;
  parentPort.postMessage({ type: "reply-received", callId: message.callId });
  if (message.ok === true) pending.resolve(message.value);
  else pending.reject(new Error(message.error || "Nested tool call failed."));
  scheduleCompletion();
}

const sandbox = Object.create(null);
sandbox.print = printValues;
sandbox.text = appendTextItem;
sandbox.console = Object.freeze({
  log: printValues,
  warn: printValues,
  error: printValues,
});
sandbox.tools = new Proxy(Object.create(null), {
  get: function (_target, property) {
    if (typeof property !== "string") return undefined;
    if (declaredSet.has(property)) {
      return function (args) {
        return nestedToolCall(property, args === undefined ? {} : args);
      };
    }
    return function () {
      if (knownSet.has(property)) {
        throw new Error(
          'Tool "' +
            property +
            '" was not declared in "uses" for this cell. Declared tools: ' +
            (declared.length > 0 ? declared.join(", ") : "(none)") +
            ".",
        );
      }
      throw new Error(
        'Unknown nested tool "' +
          property +
          '". Adapted tools: ' +
          (known.length > 0 ? known.join(", ") : "(none)") +
          ".",
      );
    };
  },
});

function finish(outcome) {
  if (state.done) return;
  state.done = true;
  // Fence the host before potentially slow capture of a failure message.
  parentPort.postMessage({ type: "ending", ok: outcome.error === undefined });
  if (outcome.error !== undefined) sendText("error", String(outcome.error));
  else if (state.resultJson !== undefined) sendText("result", state.resultJson);
  parentPort.postMessage({ type: "done", ok: outcome.error === undefined });
}

process.on("unhandledRejection", function (reason) {
  const detail =
    reason && typeof reason === "object" && reason.message !== undefined
      ? String(reason.message)
      : String(reason);
  finish({
    error: "Unhandled promise rejection in the Code Mode cell: " + detail,
  });
});

function scheduleCompletion() {
  if (state.done || !state.programSettled || state.completionScheduled) return;
  state.completionScheduled = true;
  // A full turn lets normal Promise reactions enqueue transitive tools and
  // Node report unhandled rejections. Never attach a swallowing handler to
  // the user's promises just to count settlement. Not arbitrary JS quiescence.
  setImmediate(function () {
    state.completionScheduled = false;
    if (state.done || state.calls.size !== 0) return;
    if (!state.serialized) {
      // JSON getters/toJSON are user code too: serialize exactly once, then
      // allow their Promise reactions and tracked calls to settle before fencing.
      try { state.resultJson = JSON.stringify(state.value); }
      catch (error) {
        finish({ error: "The cell completed but its result could not be serialized: " + String(error) });
        return;
      }
      state.serialized = true;
      state.value = undefined;
      scheduleCompletion();
      return;
    }
    finish({});
  });
}

function run(code) {
  const context = vm.createContext(sandbox, { name: "pct-code-mode-cell" });
  let program;
  try {
    const script = new vm.Script("(async () => {\n" + code + "\n})()", {
      filename: "pct-code-mode-cell.js",
    });
    program = script.runInContext(context);
  } catch (error) {
    finish({ error: error && error.message ? String(error.message) : String(error) });
    return;
  }
  Promise.resolve(program).then(
    function (value) {
      state.programSettled = true;
      state.value = value;
      scheduleCompletion();
    },
    function (error) {
      finish({ error: error && error.message ? String(error.message) : String(error) });
    },
  );
}

parentPort.on("message", function (message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "call-settled") {
    settleCall(message);
    return;
  }
  if (message.type === "shutdown") {
    process.exit(0);
  }
});

run(String(config.code === undefined || config.code === null ? "" : config.code));
`;

type TerminationReason = "requested" | "aborted" | "closed";

interface Cell {
  id: string;
  worker: Worker;
  controller: AbortController;
  uses: Set<string>;
  /** Adapter dispatch ceiling captured at cell creation. */
  admitted: ReadonlySet<string>;
  callContext: CodeModeCellContext;
  output: BoundedTextBuffer;
  status: CodeModeCellStatus;
  result?: unknown;
  resultTruncated: boolean;
  /** Bounded fold of the streamed error chunks; only capture writes it. */
  errorPreview?: string;
  /** Latest host message: stop guidance, unsettled work or final diagnostic. */
  errorNote?: string;
  workerError?: string;
  terminal: boolean;
  terminalAt: number | null;
  exited: boolean;
  terminateRequested: boolean;
  terminationReason?: TerminationReason;
  termination?: Promise<void>;
  pendingCalls: Map<number, { bytes: number; dispatched: boolean }>;
  pendingBytes: number;
  replyBytes: number;
  replies: Map<number, number>;
  effects: { completed: number; failed: number; cancelled: number };
  accepting: boolean;
  doneReceived: boolean;
  delivered: boolean;
  observation: Promise<void>;
  observers: number;
  captureChain: Promise<void>;
  captures: Record<"output" | "result" | "error", ExecutionOutputCapture>;
  credit: Int32Array;
  resultJson: string;
  errorTruncated: boolean;
  unknownOutcome: boolean;
  waiters: Set<() => void>;
  /** Outer calls currently observing this cell, each with its own budget. */
  progress: Set<{ emit: NestedProgressSink; remaining: number }>;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** The opaque shell handle a settled nested result published, when it has one. */
function sessionIdentity(value: unknown): { session_id?: string } {
  const sessionId = (value as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0
    ? { session_id: sessionId }
    : {};
}

export function boundMessage(
  value: unknown,
  cap = CODE_MODE_ERROR_MAX_BYTES,
): string {
  const text =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : String(value);
  if (Buffer.byteLength(text, "utf8") <= cap) return text;
  return takeLeadingCodePoints(text, cap).text;
}

// A host note's share of the error beside a streamed preview, so the head of
// the program's own error stays visible in front of it.
const ERROR_NOTE_MAX_BYTES = 1024;

// Guidance while a stop is unconfirmed and the program has not finished. Logical
// done ends that provisional state, so handleDone recognises and removes it.
const STOP_UNCONFIRMED_NOTE =
  "Worker termination is unconfirmed; keep the cell handle and wait/terminate again. No replay.";

/**
 * The only producer of `result.error`: the streamed preview or the host note
 * alone, or the preview's head, "\n" and the note, within the 4 KiB bound.
 */
function composeError(
  preview: string | undefined,
  note: string | undefined,
): { text: string | undefined; clipped: boolean } {
  if (note === undefined) return { text: preview, clipped: false };
  if (!preview) {
    const text = boundMessage(note);
    return { text, clipped: text !== note };
  }
  const diagnostic = boundMessage(note, ERROR_NOTE_MAX_BYTES);
  const room =
    CODE_MODE_ERROR_MAX_BYTES - Buffer.byteLength(diagnostic, "utf8") - 1;
  const head = boundMessage(preview, room);
  return {
    text: `${head}\n${diagnostic}`,
    clipped: head !== preview || diagnostic !== note,
  };
}

/**
 * Session-scoped Code Mode cell manager. Cells are opaque Toolkit handles bound
 * to this manager instance; cell IDs are never shell session IDs and never
 * cross manager boundaries.
 */
export class CodeModeCellManager {
  private readonly cells = new Map<string, Cell>();
  /** Terminal delivery does not surrender unresolved executor/worker ownership. */
  private readonly owned = new Set<Cell>();
  private readonly outputOwner: ExecutionOutputOwner;
  private readonly ownsOutput: boolean;
  private readonly maxPendingCalls: number;
  private readonly pendingCallBytes: number;
  private readonly callPayloadBytes: number;
  private readonly progressMaxRecords: number;
  private closing?: Promise<void>;
  private readonly dispatcher: CellDispatcher;
  private readonly maxRunning: number;
  private readonly maxCompleted: number;
  private readonly completedRetentionMs: number;
  private readonly outputBufferBytes: number;
  private readonly resultMaxBytes: number;
  private readonly memoryOldGenerationMb: number;
  private readonly memoryYoungGenerationMb: number;
  private readonly terminationWaitMs: number;
  private readonly settleGraceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly now: () => number;
  private admissionClosed_ = false;
  private closed = false;

  constructor(options: CodeModeCellManagerOptions) {
    this.dispatcher = options.dispatcher;
    this.maxRunning = options.maxRunning ?? CODE_MODE_MAX_RUNNING;
    this.maxCompleted = options.maxCompleted ?? CODE_MODE_MAX_COMPLETED;
    this.completedRetentionMs =
      options.completedRetentionMs ?? CODE_MODE_COMPLETED_RETENTION_MS;
    this.outputBufferBytes =
      options.outputBufferBytes ?? CODE_MODE_OUTPUT_BUFFER_BYTES;
    this.resultMaxBytes = options.resultMaxBytes ?? CODE_MODE_RESULT_MAX_BYTES;
    this.memoryOldGenerationMb =
      options.memoryOldGenerationMb ?? CODE_MODE_MEMORY_OLD_GENERATION_MB;
    this.memoryYoungGenerationMb =
      options.memoryYoungGenerationMb ?? CODE_MODE_MEMORY_YOUNG_GENERATION_MB;
    this.terminationWaitMs =
      options.terminationWaitMs ?? CODE_MODE_TERMINATION_WAIT_MS;
    this.settleGraceMs = options.settleGraceMs ?? CODE_MODE_SETTLE_GRACE_MS;
    this.shutdownGraceMs =
      options.shutdownGraceMs ?? CODE_MODE_SHUTDOWN_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.outputOwner = options.outputOwner ?? new ExecutionOutputOwner();
    this.ownsOutput = options.outputOwner === undefined;
    this.maxPendingCalls = options.maxPendingCalls ?? CODE_MODE_PENDING_CALLS;
    this.pendingCallBytes =
      options.pendingCallBytes ?? CODE_MODE_PENDING_CALL_BYTES;
    this.callPayloadBytes =
      options.callPayloadBytes ?? CODE_MODE_CALL_PAYLOAD_BYTES;
    this.progressMaxRecords =
      options.progressMaxRecords ?? CODE_MODE_PROGRESS_MAX_RECORDS;
    for (const limit of [
      this.maxPendingCalls,
      this.pendingCallBytes,
      this.callPayloadBytes,
      this.progressMaxRecords,
    ]) {
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new CodeModeError(
          "invalid-limit",
          "Bridge limits must be positive integers.",
        );
    }
  }

  get runningCount(): number {
    let count = 0;
    for (const cell of this.owned) {
      if (!cell.terminal || cell.pendingCalls.size > 0) count += 1;
    }
    return count;
  }

  get cellCount(): number {
    return this.cells.size;
  }

  /**
   * True once `close()` has fenced new admission, whether or not that attempt
   * settled. A failed close keeps it true (accepted N3): the owner must retry
   * the cleanup and rebind a fresh manager rather than hand this one a cell it
   * would reject as `closed`. Retained `wait`/terminate controls are
   * unaffected.
   */
  get admissionClosed(): boolean {
    return this.admissionClosed_;
  }

  hasCell(cellId: string): boolean {
    return this.cells.has(cellId);
  }

  async exec(
    input: CodeModeExecInput,
    signal?: AbortSignal,
  ): Promise<CodeModeCellResult> {
    if (this.admissionClosed_ || this.outputOwner.isClosed) {
      throw new CodeModeError("closed", "Code Mode is not active.");
    }
    if (signal?.aborted)
      throw new CodeModeError(
        "aborted",
        "Cell cancelled before execution; nothing ran.",
      );
    const code = this.validateCode(input.code);
    // One admission snapshot for this cell: the declared set defaults to it,
    // an explicit list must be a subset of it, and it stays the dispatch
    // ceiling after later route expansions.
    const admitted = new Set(
      this.dispatcher.admittedNames?.() ?? this.dispatcher.allowedNames,
    );
    const uses = this.validateUses(input.uses, admitted);
    const yieldMs = this.validateYield(input.yieldTimeMs);
    const maxBytes = this.validateMaxBytes(input.maxOutputBytes);

    this.prune();
    if (this.runningCount >= this.maxRunning) {
      throw new CodeModeError(
        "cell-limit",
        `At most ${this.maxRunning} Code Mode cells can run at once. Wait for or terminate an existing cell.`,
      );
    }

    const cell = this.createCell(code, uses, admitted, input.context);
    return this.observe(
      cell,
      yieldMs,
      maxBytes,
      signal,
      false,
      input.onProgress,
    );
  }

  async wait(
    input: CodeModeWaitInput,
    signal?: AbortSignal,
  ): Promise<CodeModeCellResult> {
    if (this.closed || this.closing) {
      throw new CodeModeError("closed", "Code Mode is not active.");
    }
    if (typeof input.cellId !== "string" || input.cellId.length === 0) {
      throw new CodeModeError(
        "invalid-input",
        "wait requires cell_id (or cellId): the opaque cell handle string returned by exec.",
      );
    }
    if (input.cellId.startsWith(SHELL_SESSION_PREFIX)) {
      throw new CodeModeError(
        "invalid-input",
        `wait expects a Code Mode cell_id (also spelled cellId) from exec (prefix ${CODE_MODE_CELL_PREFIX}). ${input.cellId} is a Shell Sessions session_id. Continue that job with write_stdin; do not wait, rerun, or terminate it through wait.`,
      );
    }
    const yieldMs = this.validateYield(input.yieldTimeMs);
    const maxBytes = this.validateMaxBytes(input.maxOutputBytes);
    this.prune();
    const cell = this.requireCell(input.cellId);
    return this.observe(
      cell,
      yieldMs,
      maxBytes,
      signal,
      input.terminate === true,
      input.onProgress,
    );
  }

  close(): Promise<void> {
    // Failed cleanup retains control of existing cells, never new admission.
    this.admissionClosed_ = true;
    if (this.closing) return this.closing;
    const run = async () => {
      const cells = [...this.owned];
      await Promise.all(
        cells.map((cell) => this.terminateCell(cell, "closed")),
      );
      const deadline = Date.now() + this.terminationWaitMs;
      while (
        cells.some((cell) => !cell.exited || cell.pendingCalls.size) &&
        Date.now() < deadline
      )
        await delay(10);
      const unsettled = cells.filter(
        (cell) => !cell.exited || cell.pendingCalls.size,
      );
      if (unsettled.length)
        throw new CodeModeError(
          "cleanup-incomplete",
          `Code Mode cleanup is unconfirmed for ${unsettled.map((cell) => cell.id).join(", ")}; owned work is retained. Completed effects are not rolled back.`,
        );
      await Promise.all(
        cells.map(async (cell) => {
          await cell.captureChain;
          this.cells.delete(cell.id);
          cell.delivered = true;
          await this.releaseOwned(cell);
        }),
      );
      if (this.ownsOutput) await this.outputOwner.close();
      this.closed = true;
    };
    // Install the fence before aborting adapters, whose listeners can reenter
    // wait/close synchronously. All callers join the same cleanup attempt.
    this.closing = Promise.resolve()
      .then(run)
      .finally(() => {
        this.closing = undefined;
      });
    return this.closing;
  }

  private createCell(
    code: string,
    uses: string[],
    admitted: ReadonlySet<string>,
    context: unknown,
  ): Cell {
    const id = `${CODE_MODE_CELL_PREFIX}${randomUUID()}`;
    const controller = new AbortController();
    const credit = new Int32Array(new SharedArrayBuffer(4));
    const captures = {
      output: this.outputOwner.createCapture({
        memoryBytes: this.outputBufferBytes,
      }),
      result: this.outputOwner.createCapture({
        memoryBytes: this.resultMaxBytes,
      }),
      error: this.outputOwner.createCapture({
        memoryBytes: CODE_MODE_ERROR_MAX_BYTES,
      }),
    };
    let worker: Worker;
    try {
      worker = new Worker(CELL_WORKER_SOURCE, {
        eval: true,
        workerData: {
          code,
          declared: uses,
          known: [...this.dispatcher.allowedNames],
          outputCredit: credit.buffer,
          maxPendingCalls: this.maxPendingCalls,
          pendingCallBytes: this.pendingCallBytes,
          callPayloadBytes: this.callPayloadBytes,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: this.memoryOldGenerationMb,
          maxYoungGenerationSizeMb: this.memoryYoungGenerationMb,
        },
      });
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: dispose() only awaits the capture's enqueue(), whose run catches every operation failure
      void Promise.all(
        Object.values(captures).map((capture) => capture.dispose()),
      );
      throw new CodeModeError(
        "cell-start-failed",
        `Failed to start the Code Mode cell: ${boundMessage(error)}`,
      );
    }

    const cell: Cell = {
      id,
      worker,
      controller,
      uses: new Set(uses),
      admitted,
      callContext: {
        cellId: id,
        hostContext: context,
        reportProgress: (event) =>
          this.emitProgress(cell, {
            nested: true,
            phase: event.phase,
            name: event.name,
            cell_id: id,
            ...(event.sessionId === undefined
              ? {}
              : { session_id: event.sessionId }),
          }),
      },
      output: new BoundedTextBuffer(this.outputBufferBytes),
      status: "running",
      resultTruncated: false,
      terminal: false,
      terminalAt: null,
      exited: false,
      terminateRequested: false,
      pendingCalls: new Map(),
      pendingBytes: 0,
      replyBytes: 0,
      replies: new Map(),
      effects: { completed: 0, failed: 0, cancelled: 0 },
      accepting: true,
      doneReceived: false,
      delivered: false,
      observation: Promise.resolve(),
      observers: 0,
      captureChain: Promise.resolve(),
      captures,
      credit,
      resultJson: "",
      errorTruncated: false,
      unknownOutcome: false,
      waiters: new Set(),
      progress: new Set(),
    };
    this.cells.set(id, cell);
    this.owned.add(cell);

    worker.on("message", (message: unknown) => {
      this.handleWorkerMessage(cell, message);
    });
    worker.on("error", (error: unknown) => {
      if (cell.workerError === undefined) {
        cell.workerError = boundMessage(error);
      }
    });
    worker.on("exit", () => {
      this.finalizeExit(cell);
      this.wake(cell);
    });
    return cell;
  }

  private handleWorkerMessage(cell: Cell, message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    if (record.type === "capture") {
      const kind = record.kind;
      if (kind !== "output" && kind !== "result" && kind !== "error") return;
      const text = typeof record.text === "string" ? record.text : "";
      cell.captureChain = cell.captureChain.then(async () => {
        try {
          await cell.captures[kind].append(text);
          if (kind === "output") cell.output.append(text);
          else if (kind === "result") {
            const value = cell.resultJson + text;
            cell.resultJson = boundMessage(value, this.resultMaxBytes);
            cell.resultTruncated ||= value !== cell.resultJson;
          } else {
            const value = (cell.errorPreview ?? "") + text;
            cell.errorPreview = boundMessage(value);
            cell.errorTruncated ||= value !== cell.errorPreview;
          }
        } finally {
          Atomics.store(cell.credit, 0, 0);
          Atomics.notify(cell.credit, 0);
          this.wake(cell);
        }
      });
      return;
    }
    if (record.type === "reply-received" && typeof record.callId === "number") {
      cell.replyBytes -= cell.replies.get(record.callId) ?? 0;
      cell.replies.delete(record.callId);
      return;
    }
    if (record.type === "ending") {
      cell.accepting = false;
      if (record.ok !== true) this.fenceCalls(cell);
      return;
    }
    if (record.type === "call") {
      this.handleNestedCall(cell, record);
      return;
    }
    if (record.type === "done") {
      this.handleDone(cell, record);
    }
  }

  private handleNestedCall(cell: Cell, message: Record<string, unknown>): void {
    const callId =
      typeof message.callId === "number" && Number.isFinite(message.callId)
        ? message.callId
        : -1;
    const name = typeof message.name === "string" ? message.name : "";
    const reply = (payload: Record<string, unknown>): void => {
      this.post(cell, { type: "call-settled", callId, ...payload });
    };
    if (!cell.uses.has(name)) {
      reply({
        ok: false,
        error: `Tool "${name}" was not declared in "uses" for this cell.`,
      });
      return;
    }
    // Defence in depth for the creation-time ceiling. The declared set is
    // either that snapshot or a validated subset of it, so a declared name is
    // always admitted and this guard normally cannot fire; it exists so a
    // future change to the declared set can never hand a running cell a
    // capability a later route expansion added. Contractions are a different
    // question and still apply through the adapter's dispatch-time recheck.
    if (!cell.admitted.has(name)) {
      reply({
        ok: false,
        error: `Tool "${name}" was not admitted when this cell started; its capability ceiling is fixed at creation.`,
      });
      return;
    }
    if (!cell.accepting || cell.controller.signal.aborted) {
      reply({
        ok: false,
        error: "Cell ended before this nested call could dispatch.",
      });
      return;
    }
    const json = typeof message.argsJson === "string" ? message.argsJson : "";
    const bytes = Buffer.byteLength(json);
    if (
      !json ||
      bytes > this.callPayloadBytes ||
      cell.pendingBytes + bytes > this.pendingCallBytes ||
      cell.pendingCalls.size >= this.maxPendingCalls
    ) {
      reply({
        ok: false,
        error:
          "Nested bridge overload: outstanding call/payload limit exceeded; no dispatch.",
      });
      return;
    }
    let args: unknown;
    try {
      args = JSON.parse(json);
    } catch {
      reply({
        ok: false,
        error: "Nested arguments must be JSON-serializable.",
      });
      return;
    }
    const pending = {
      bytes,
      dispatched: this.dispatcher.tracksDispatch !== true,
    };
    cell.pendingCalls.set(callId, pending);
    cell.pendingBytes += bytes;
    const send = (ok: boolean, value: unknown) => {
      let payload: Record<string, unknown>;
      let encoded: string;
      try {
        const portable = ok
          ? toPortableValue(value, this.callPayloadBytes)
          : value instanceof Error
            ? value.message
            : String(value);
        if (
          !ok &&
          Buffer.byteLength(portable as string) > this.callPayloadBytes
        ) {
          // This intermediate error is unavailable to the worker. Do not
          // poison capture of the independently selected final cell error.
          throw new CodeModeError(
            "bridge-overload",
            "Nested error exceeds the transport limit; original error capture is unavailable",
          );
        }
        payload = ok ? { ok, value: portable } : { ok, error: portable };
        encoded = JSON.stringify(payload);
        if (
          Buffer.byteLength(encoded) + cell.replyBytes >
          this.pendingCallBytes
        )
          throw new CodeModeError(
            "bridge-overload",
            "Nested reply byte limit exceeded; the call ran and must not be replayed.",
          );
      } catch (error) {
        payload = {
          ok: false,
          error: `Nested ${name} result unavailable: ${boundMessage(error)}. Execution may have effects; do not replay.`,
        };
        encoded = JSON.stringify(payload);
        if (pending.dispatched) cell.unknownOutcome = true;
      }
      const replyBytes = Buffer.byteLength(encoded);
      cell.replies.set(callId, replyBytes);
      cell.replyBytes += replyBytes;
      reply(payload);
    };
    void Promise.resolve()
      .then(() => {
        if (!cell.accepting || cell.controller.signal.aborted)
          throw new CodeModeError(
            "aborted",
            "Cell ended before nested dispatch.",
          );
        this.emitProgress(cell, {
          nested: true,
          phase: "start",
          name,
          cell_id: cell.id,
        });
        return this.dispatcher.call(
          name,
          args,
          cell.controller.signal,
          cell.callContext,
          () => {
            pending.dispatched = true;
          },
        );
      })
      .then(
        (value) => {
          cell.effects.completed++;
          this.emitProgress(cell, {
            nested: true,
            phase: "end",
            name,
            cell_id: cell.id,
            ...sessionIdentity(value),
            ok: true,
          });
          if (!cell.exited) send(true, value);
        },
        (error: unknown) => {
          if (pending.dispatched) cell.effects.failed++;
          else cell.effects.cancelled++;
          this.emitProgress(cell, {
            nested: true,
            phase: "end",
            name,
            cell_id: cell.id,
            ok: false,
            error: error instanceof CodeModeError ? error.code : "error",
          });
          if (!cell.exited) send(false, error);
        },
      )
      .finally(() => {
        cell.pendingCalls.delete(callId);
        cell.pendingBytes -= bytes;
        this.wake(cell);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: releaseOwned() is a Set.delete plus capture.dispose(), which only awaits enqueue()
        void this.releaseOwned(cell);
      });
  }

  private handleDone(cell: Cell, message: Record<string, unknown>): void {
    if (cell.doneReceived || cell.terminal) return;
    cell.doneReceived = true;
    // Logical done ends a provisional stop: the known result is on its way, so
    // worker-only uncertainty, its status and its retry guidance must not
    // outlive it. Genuinely unknown effects stay recorded in unknownOutcome.
    if (!cell.exited) {
      cell.terminateRequested = false;
      if (cell.status === "terminated") cell.status = "running";
      if (cell.errorNote === STOP_UNCONFIRMED_NOTE) cell.errorNote = undefined;
    }
    cell.accepting = false;
    if (message.ok !== true) this.fenceCalls(cell);
    cell.captureChain = cell.captureChain.then(async () => {
      await Promise.all(
        Object.values(cell.captures).map((capture) => capture.finish()),
      );
      cell.terminal = true;
      cell.terminalAt = this.now();
      cell.status = message.ok === true ? "completed" : "failed";
      if (cell.status === "completed" && cell.pendingCalls.size) {
        this.fenceCalls(cell);
        cell.status = "failed";
        cell.errorNote =
          "Worker completion arrived with unsettled nested work; effects are unconfirmed.";
      }
      if (cell.resultJson) {
        if (cell.resultTruncated) cell.result = cell.resultJson;
        else {
          try {
            cell.result = JSON.parse(cell.resultJson);
          } catch {
            cell.result = cell.resultJson;
          }
        }
      }
      this.post(cell, { type: "shutdown" });
      // A worker busy in user code scheduled past done never reads shutdown.
      // After done it drops output and nested calls are refused, so stopping
      // it loses nothing observable: terminate it once after the grace. Close
      // still owns cleanup that stays unconfirmed.
      if (!cell.exited) {
        const reclaim = setTimeout(() => {
          if (!cell.exited) void cell.worker.terminate().catch(() => undefined);
        }, this.shutdownGraceMs);
        reclaim.unref?.();
      }
      this.wake(cell);
    });
  }

  private finalizeExit(cell: Cell): void {
    if (cell.exited) return;
    cell.exited = true;
    cell.accepting = false;
    if (!cell.doneReceived) {
      this.fenceCalls(cell);
      cell.captureChain = cell.captureChain.then(async () => {
        // The worker may have been interrupted mid-print/serialization. A
        // captured prefix is evidence, not proof of complete emitted text.
        cell.captures.output.fail("source-error");
        cell.captures.result.fail("source-error");
        // The file keeps a streamed error once, then "\n" and why the cell
        // stopped; never the preview again. The diagnostic replaces any
        // earlier note, such as unconfirmed-stop guidance.
        const diagnostic =
          cell.workerError ?? terminationMessage(cell.terminationReason);
        await cell.captures.error.append(
          cell.errorPreview ? `\n${diagnostic}` : diagnostic,
        );
        cell.errorNote = diagnostic;
        // Persist the known host diagnostic before failing the interrupted
        // source: append alone may only retain an unpublished memory prefix.
        // Existing I/O failure remains sticky through both operations.
        await cell.captures.error.publish();
        cell.captures.error.fail("source-error");
        await Promise.all(
          Object.values(cell.captures).map((capture) => capture.finish()),
        );
        cell.terminal = true;
        cell.status = "terminated";
        cell.terminalAt = this.now();
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: no captureChain link throws (capture, handleDone, finalizeExit), wake() only resolves waiters, releaseOwned() cannot reject
    void cell.captureChain.then(async () => {
      this.wake(cell);
      await this.releaseOwned(cell);
    });
  }

  private fenceCalls(cell: Cell): void {
    cell.accepting = false;
    if ([...cell.pendingCalls.values()].some((call) => call.dispatched))
      cell.unknownOutcome = true;
    this.abortCell(cell);
  }

  private async releaseOwned(cell: Cell): Promise<void> {
    if (!cell.delivered || !cell.exited || cell.pendingCalls.size) return;
    this.owned.delete(cell);
    await Promise.all(
      Object.values(cell.captures).map((capture) => capture.dispose()),
    );
  }

  private abortCell(cell: Cell): void {
    try {
      cell.controller.abort();
    } catch {
      // Aborting an already-aborted controller is a no-op.
    }
  }

  private observe(
    cell: Cell,
    yieldMs: number,
    maxBytes: number,
    signal: AbortSignal | undefined,
    terminateRequested: boolean,
    onProgress?: NestedProgressSink,
  ): Promise<CodeModeCellResult> {
    // Control is out of band; only destructive observations wait in the queue.
    cell.observers++;
    // The sink belongs to this outer call, including its queue wait, and is
    // removed when the call settles; it is never a durable subscription.
    const sink = onProgress
      ? { emit: onProgress, remaining: this.progressMaxRecords }
      : undefined;
    if (sink) cell.progress.add(sink);
    const stop = () => {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: terminateCell() catches worker.terminate(), waitForExit() only delays, captureChain never rejects
      if (!cell.terminal) void this.terminateCell(cell, "aborted");
    };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    if (terminateRequested && !cell.terminal)
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: terminateCell() catches worker.terminate(), waitForExit() only delays, captureChain never rejects
      void this.terminateCell(cell, "requested");
    const run = cell.observation.then(() => {
      this.requireCell(cell.id);
      return this.observeExclusive(
        cell,
        yieldMs,
        maxBytes,
        signal,
        terminateRequested,
      );
    });
    cell.observation = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      cell.observers--;
      if (sink) cell.progress.delete(sink);
      signal?.removeEventListener("abort", stop);
    });
  }

  /**
   * Fan one bounded record out to the outer calls observing this cell. A
   * budget-exhausted or failing sink stops receiving records; nested execution
   * never depends on the host's update callback.
   */
  private emitProgress(cell: Cell, unbounded: NestedProgressRecord): void {
    if (cell.progress.size === 0) return;
    const record: NestedProgressRecord = {
      nested: true,
      phase: unbounded.phase,
      name: boundMessage(unbounded.name, CODE_MODE_PROGRESS_FIELD_BYTES),
      cell_id: unbounded.cell_id,
      ...(unbounded.session_id === undefined
        ? {}
        : {
            session_id: boundMessage(
              unbounded.session_id,
              CODE_MODE_PROGRESS_FIELD_BYTES,
            ),
          }),
      ...(unbounded.ok === undefined ? {} : { ok: unbounded.ok }),
      ...(unbounded.error === undefined
        ? {}
        : {
            error: boundMessage(
              unbounded.error,
              CODE_MODE_PROGRESS_FIELD_BYTES,
            ),
          }),
    };
    for (const sink of cell.progress) {
      if (sink.remaining <= 0) continue;
      sink.remaining -= 1;
      try {
        sink.emit(record);
      } catch {
        cell.progress.delete(sink);
      }
    }
  }

  private async observeExclusive(
    cell: Cell,
    yieldMs: number,
    maxBytes: number,
    signal: AbortSignal | undefined,
    terminateRequested: boolean,
  ): Promise<CodeModeCellResult> {
    if (terminateRequested && !cell.terminal) {
      await this.terminateCell(cell, "requested");
    }
    if (signal?.aborted && !cell.terminal) {
      await this.terminateCell(cell, "aborted");
    }

    if (!cell.terminal) {
      const deadline = Date.now() + yieldMs;
      while (
        !cell.terminal &&
        !cell.terminateRequested &&
        !cell.output.hasBytes
      ) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await this.waitForWake(cell, remaining, signal, true);
        if (signal?.aborted && !cell.terminal) {
          await this.terminateCell(cell, "aborted");
          break;
        }
      }
      if (!cell.terminal && !cell.terminateRequested && cell.output.hasBytes) {
        // Most short programs emit output microseconds before their done
        // message; a brief terminal-only settle lets one exec call report
        // completion without delaying genuinely long-running cells.
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          await this.waitForWake(
            cell,
            Math.min(remaining, this.settleGraceMs),
            signal,
            false,
          );
        }
      }
    }

    // The settle-grace wait resolves on abort without terminating; re-check so
    // an abort landing in that window cannot leave a running cell behind.
    if (signal?.aborted && !cell.terminal) {
      await this.terminateCell(cell, "aborted");
    }

    // A stop wakes quiet/settle observers and bounds their wait by the control
    // attempt, not the original (possibly 60-second) output-poll deadline.
    await cell.termination;
    const terminalAtRead = cell.terminal;
    const result = await this.buildResult(cell, maxBytes);
    if (terminalAtRead) this.removeCell(cell);
    return result;
  }

  private terminateCell(cell: Cell, reason: TerminationReason): Promise<void> {
    this.fenceCalls(cell);
    if (cell.termination) return cell.termination;
    const run = async () => {
      if (!cell.exited) {
        cell.terminateRequested = true;
        cell.terminationReason ??= reason;
        // A previous failed/unconfirmed stop must not fence a later explicit
        // retry. Coalesce only the current bounded attempt, never replay code.
        void cell.worker.terminate().catch(() => undefined);
      }
      await this.waitForExit(cell, this.terminationWaitMs);
      // After logical done the result is known and only its publication
      // remains, so an unconfirmed exit is cleanup, not uncertainty. The stop
      // bound covers exit confirmation; each queued capture operation is then
      // bounded by the output owner's I/O timeout.
      if (cell.exited || cell.doneReceived) await cell.captureChain;
      else if (!cell.terminal) {
        // Close still reclaims terminal-but-live workers, but cleanup failure
        // cannot replace a known execution result or promise a retired handle.
        cell.status = "terminated";
        cell.errorNote = STOP_UNCONFIRMED_NOTE;
      }
    };
    cell.termination = run().finally(() => {
      cell.termination = undefined;
      this.wake(cell);
    });
    this.wake(cell);
    return cell.termination;
  }

  private async buildResult(
    cell: Cell,
    maxBytes: number,
  ): Promise<CodeModeCellResult> {
    const terminalAtRead = cell.terminal;
    const drained = cell.output.drain(maxBytes);
    const error = composeError(cell.errorPreview, cell.errorNote);
    const result: CodeModeCellResult = {
      cellId: cell.id,
      status: cell.status,
      output: drained.text,
      truncated:
        drained.clipped ||
        drained.dropped ||
        cell.resultTruncated ||
        cell.errorTruncated ||
        error.clipped,
      dropped: drained.dropped,
      clipping: {
        output: drained.clipped || drained.dropped,
        result: cell.resultTruncated,
        error: cell.errorTruncated || error.clipped,
      },
      effects: { ...cell.effects, unsettled: cell.pendingCalls.size },
    };
    if (cell.result !== undefined) result.result = cell.result;
    if (error.text !== undefined) result.error = error.text;
    // Worker-only uncertainty is provisional until logical done. A stop that
    // lands after done awaits the known result, but a read that passed its
    // wait for stop attempts one microtask earlier snapshots it mid-attempt.
    if (
      cell.unknownOutcome ||
      (cell.terminateRequested &&
        !cell.exited &&
        !cell.terminal &&
        !cell.doneReceived)
    )
      result.unknownOutcome = true;
    const recovery: NonNullable<CodeModeCellResult["recovery"]> = {};
    for (const kind of ["output", "result", "error"] as const) {
      if (
        !terminalAtRead ||
        cell.captures[kind].needsRecovery ||
        result.clipping?.[kind]
      )
        recovery[kind] = await cell.captures[kind].publish();
    }
    if (Object.keys(recovery).length) result.recovery = recovery;
    const shells = this.dispatcher.continuations?.(cell.callContext);
    if (shells?.length) result.shells = shells;
    return result;
  }

  private removeCell(cell: Cell): void {
    this.cells.delete(cell.id);
    cell.delivered = true;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: releaseOwned() is a Set.delete plus capture.dispose(), which only awaits enqueue()
    void this.releaseOwned(cell);
  }

  private requireCell(cellId: string): Cell {
    const cell = this.cells.get(cellId);
    if (!cell) {
      throw new CodeModeError(
        "stale-cell",
        `Code Mode cell ${cellId} is unknown, released or expired. Use previously returned recovery paths; never rerun a program to recover output.`,
      );
    }
    return cell;
  }

  private validateCode(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new CodeModeError(
        "invalid-code",
        "exec requires a non-empty JavaScript code string.",
      );
    }
    return value;
  }

  private validateUses(
    value: unknown,
    admitted: ReadonlySet<string>,
  ): string[] {
    // Omitted declares the current admission snapshot; `[]` declares none.
    // Neither infers authorization from the program text.
    if (value === undefined) return [...admitted];
    if (!Array.isArray(value)) {
      throw new CodeModeError(
        "invalid-uses",
        "uses must be an array of tool names.",
      );
    }
    const names: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new CodeModeError(
          "invalid-uses",
          "uses must contain non-empty tool names.",
        );
      }
      if (!this.dispatcher.allowedNames.includes(entry)) {
        throw new CodeModeError(
          "invalid-uses",
          `uses contains "${entry}", which is not an adapted Code Mode tool. Adapted tools: ${this.dispatcher.allowedNames.join(", ") || "(none)"}.`,
        );
      }
      // An adapted name the host does not currently admit is refused before
      // the worker starts instead of failing at dispatch inside the cell.
      if (!admitted.has(entry)) {
        throw new CodeModeError(
          "invalid-uses",
          `uses contains "${entry}", which is not currently available: this session's routes or tool ownership do not admit it. Currently available: ${[...admitted].join(", ") || "(none)"}.`,
        );
      }
      if (seen.has(entry)) {
        throw new CodeModeError(
          "invalid-uses",
          `uses must not contain duplicate names ("${entry}").`,
        );
      }
      seen.add(entry);
      names.push(entry);
    }
    return names;
  }

  private validateYield(value: unknown): number {
    if (value === undefined) return CODE_MODE_YIELD_DEFAULT_MS;
    if (
      !isInteger(value) ||
      value < CODE_MODE_YIELD_MIN_MS ||
      value > CODE_MODE_YIELD_MAX_MS
    ) {
      throw new CodeModeError(
        "invalid-limit",
        `yieldTimeMs must be an integer between ${CODE_MODE_YIELD_MIN_MS} and ${CODE_MODE_YIELD_MAX_MS}.`,
      );
    }
    return value;
  }

  private validateMaxBytes(value: unknown): number {
    if (value === undefined) return CODE_MODE_MAX_BYTES_DEFAULT;
    if (
      !isInteger(value) ||
      value < CODE_MODE_MAX_BYTES_MIN ||
      value > CODE_MODE_MAX_BYTES_MAX
    ) {
      throw new CodeModeError(
        "invalid-limit",
        `maxOutputBytes must be an integer between ${CODE_MODE_MAX_BYTES_MIN} and ${CODE_MODE_MAX_BYTES_MAX}.`,
      );
    }
    return value;
  }

  private post(cell: Cell, message: Record<string, unknown>): void {
    if (cell.exited) return;
    try {
      cell.worker.postMessage(message);
    } catch {
      // The worker exited between the check and the post.
    }
  }

  private waitForWake(
    cell: Cell,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    wakeOnOutput: boolean,
  ): Promise<void> {
    if (cell.terminal || cell.terminateRequested) return Promise.resolve();
    if (wakeOnOutput && cell.output.hasBytes) return Promise.resolve();
    if (timeoutMs <= 0) return Promise.resolve();
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cell.waiters.delete(wakeListener);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const wakeListener = (): void => {
        if (
          cell.terminal ||
          cell.terminateRequested ||
          (wakeOnOutput && cell.output.hasBytes)
        )
          finish();
      };
      cell.waiters.add(wakeListener);
      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  private async waitForExit(cell: Cell, budgetMs: number): Promise<void> {
    if (cell.exited || budgetMs <= 0) return;
    const deadline = Date.now() + budgetMs;
    while (!cell.exited && Date.now() < deadline) {
      await delay(Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }

  private wake(cell: Cell): void {
    for (const waiter of [...cell.waiters]) waiter();
  }

  private prune(): void {
    const now = this.now();
    const terminal: Cell[] = [];
    for (const cell of this.cells.values()) {
      if (!cell.terminal || cell.observers) continue;
      if (
        cell.terminalAt !== null &&
        now - cell.terminalAt > this.completedRetentionMs
      ) {
        this.removeCell(cell);
        continue;
      }
      terminal.push(cell);
    }
    terminal.sort(
      (left, right) => (left.terminalAt ?? 0) - (right.terminalAt ?? 0),
    );
    while (terminal.length > this.maxCompleted) {
      const evicted = terminal.shift();
      if (evicted) this.removeCell(evicted);
    }
  }
}

function terminationMessage(reason: TerminationReason | undefined): string {
  if (reason === "requested") return "Cell terminated by request.";
  if (reason === "aborted") {
    return "Cell terminated because the calling tool call was aborted.";
  }
  if (reason === "closed") {
    return "Cell terminated because Code Mode was disabled or the session ended.";
  }
  return "Cell worker stopped before the program completed.";
}

function toPortableValue(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  if (Buffer.byteLength(json) > maxBytes)
    throw new CodeModeError(
      "bridge-overload",
      "Serialized nested result exceeds the payload limit",
    );
  return JSON.parse(json);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
