import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat as statPath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

import {
  ExecutionOutputOwner,
  type ExecutionOutputCapture,
  type ExecutionOutputRecovery,
} from "../execution-output.ts";
import { BoundedTextBuffer } from "../bounded-text.ts";

import {
  DEFAULT_MAX_BYTES,
  getShellConfig,
} from "@earendil-works/pi-coding-agent";

export type ShellSessionStatus = "running" | "completed" | "terminated";

export interface ShellSessionResult {
  sessionId: string;
  status: ShellSessionStatus;
  exitCode: number | null;
  signal: string | null;
  /** New stdout data delivered by this call only. */
  stdout: string;
  /** New stderr data delivered by this call only. */
  stderr: string;
  /** This read hit the per-read byte budget or the stream buffer cap dropped bytes. */
  truncated: boolean;
  /** Preview bytes were dropped before this read; inspect recovery separately. */
  dropped: boolean;
  /** Termination dispatched, but the whole owned job has not settled yet. */
  unknownOutcome?: boolean;
  /** Output recovery is independent of this execution handle and preview. */
  recovery?: {
    stdout: ExecutionOutputRecovery;
    stderr: ExecutionOutputRecovery;
  };
  /** Transport acknowledgement is not acknowledgement of application effects. */
  inputDelivery?: "written" | "unknown";
  stdin?: {
    state: "open" | "closing" | "closed" | "broken";
    pendingBytes: number;
    pendingCalls: number;
  };
}

export interface ShellStartInput {
  command: string;
  /** Absolute working directory. Relative paths are resolved by the caller. */
  cwd: string;
  yieldTimeMs?: number;
  maxOutputBytes?: number;
  /**
   * Trusted per-call environment overlay from the invocation seam, merged
   * over this manager's captured environment for this spawn only. It is never
   * a model argument, never mutates the manager's environment or
   * `process.env`, and never reaches another session's spawn.
   */
  env?: Record<string, string>;
}

export interface ShellWriteInput {
  sessionId: string;
  input?: string;
  closeStdin?: boolean;
  terminate?: boolean;
  yieldTimeMs?: number;
  maxOutputBytes?: number;
}

/** Internal call options; never tool arguments. */
export interface ShellWriteOptions {
  /**
   * What cancelling this call does to the session. `terminate` (default, direct
   * calls) stops the job. `detach` (a nested Code Mode poll, whose cell's fence
   * cancels it) ends this call only, consuming no output or terminal result.
   */
  cancellation?: "terminate" | "detach";
}

/**
 * Narrow executor contract shared by the ordinary shell tools and, later, the
 * optional Code Mode adapter. It owns process management; callers own rendering.
 */
export interface ShellExecutor {
  start(
    input: ShellStartInput,
    signal?: AbortSignal,
    /** Internal ownership notification, before waiting for output; not a tool argument. */
    onSession?: (sessionId: string) => void,
  ): Promise<ShellSessionResult>;
  write(
    input: ShellWriteInput,
    signal?: AbortSignal,
    options?: ShellWriteOptions,
  ): Promise<ShellSessionResult>;
  close(): Promise<void>;
}

export type ShellSessionErrorCode =
  | "invalid-command"
  | "invalid-cwd"
  | "invalid-limit"
  | "invalid-session"
  | "stale-session"
  | "session-limit"
  | "shell-unavailable"
  | "stdin-transport"
  | "stdin-closed"
  | "stdin-overload"
  | "stdin-failed"
  | "aborted"
  | "manager-closed"
  | "cleanup-incomplete"
  | "spawn-failed";

export class ShellSessionError extends Error {
  constructor(
    readonly code: ShellSessionErrorCode,
    message: string,
    readonly inputDelivery?: "not-sent" | "unknown",
  ) {
    super(message);
    this.name = "ShellSessionError";
  }
}

export const SHELL_SESSION_PREFIX = "pct-shell-";
export const SHELL_YIELD_MIN_MS = 0;
export const SHELL_YIELD_MAX_MS = 60_000;
export const SHELL_YIELD_DEFAULT_MS = 10_000;
export const SHELL_MAX_BYTES_MIN = 1_024;
export const SHELL_MAX_BYTES_MAX = 262_144;
export const SHELL_MAX_BYTES_DEFAULT = DEFAULT_MAX_BYTES;
export const SHELL_MAX_RUNNING = 16;
export const SHELL_MAX_COMPLETED = 32;
export const SHELL_COMPLETED_RETENTION_MS = 5 * 60_000;
export const SHELL_STREAM_BUFFER_BYTES = 256 * 1024;
export const SHELL_TERMINATION_GRACE_MS = 5_000;
export const SHELL_TERMINATION_CONFIRM_MS = 5_000;
// Compatibility name: now a group-liveness probe interval, not an output-loss deadline.
export const SHELL_FLUSH_GRACE_MS = 50;
export const SHELL_SETTLE_GRACE_MS = 50;
// One existing stream budget of outstanding stdin per session, not the stream
// high-water mark. The existing 16-job envelope also bounds tiny input requests.
export const SHELL_PENDING_INPUT_BYTES = SHELL_STREAM_BUFFER_BYTES;
export const SHELL_PENDING_INPUT_CALLS = SHELL_MAX_RUNNING;

interface ShellConfigShape {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin";
}

export interface ShellSessionManagerOptions {
  shellConfig?: ShellConfigShape;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  maxRunning?: number;
  maxCompleted?: number;
  completedRetentionMs?: number;
  bufferCapBytes?: number;
  terminationGraceMs?: number;
  terminationConfirmMs?: number;
  flushGraceMs?: number;
  settleGraceMs?: number;
  now?: () => number;
  pendingInputBytes?: number;
  pendingInputCalls?: number;
  /** Shared Pi-session owner. Manager close never closes an injected owner. */
  outputOwner?: ExecutionOutputOwner;
}

interface InputRequest {
  delivery: Promise<"written" | "unknown">;
  release(): void;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface ManagedSession {
  id: string;
  child: ChildProcess;
  stdout: BoundedTextBuffer;
  stderr: BoundedTextBuffer;
  /** Whole managed job settled, not merely the leader's exit event. */
  exited: boolean;
  leaderExited: boolean;
  groupGone: boolean;
  stdoutDone: boolean;
  stderrDone: boolean;
  stdoutCapture: ExecutionOutputCapture;
  stderrCapture: ExecutionOutputCapture;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  exitedAt: number | null;
  terminateDispatched: boolean;
  windowsTreeStopped: boolean;
  /** The resolved shell reads the command from stdin, so stdin is not interactive. */
  stdinCommandTransport: boolean;
  stdinEnded: boolean;
  stdinFailed: boolean;
  pendingInputBytes: number;
  pendingInputCalls: number;
  inputWaiters: Set<(error: Error) => void>;
  starting: boolean;
  observations: number;
  chain: Promise<unknown>;
  waiters: Set<() => void>;
  exitPromise: Promise<void>;
  settle: () => void;
  groupTimer?: NodeJS.Timeout;
  escalationTimer?: NodeJS.Timeout;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function notStopped(sessionId: string): string {
  return `This cancellation did not stop shell ${sessionId}; poll or terminate it with write_stdin.`;
}

/** A detached call cancelled while queued or observing; it read nothing. */
function detachedCancellation(sessionId: string): ShellSessionError {
  return new ShellSessionError(
    "aborted",
    `Shell call cancelled; no output was read. ${notStopped(sessionId)}`,
  );
}

/** Settles when `signal` aborts; release the listener once the wait ends. */
function abortion(signal: AbortSignal): {
  promise: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    release = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) resolve();
  });
  return { promise, release };
}

export function inspectShellRuntime(): { ok: true } | { ok: false } {
  try {
    getShellConfig();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Session-scoped, resumable process manager. Processes are opaque Toolkit
 * handles bound to this manager instance; OS PIDs are never exposed or accepted.
 */
export class ShellSessionManager implements ShellExecutor {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly shellConfig?: ShellConfigShape;
  private resolvedShell?: ShellConfigShape | Error;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly maxRunning: number;
  private readonly maxCompleted: number;
  private readonly completedRetentionMs: number;
  private readonly bufferCapBytes: number;
  private readonly terminationGraceMs: number;
  private readonly terminationConfirmMs: number;
  private readonly flushGraceMs: number;
  private readonly settleGraceMs: number;
  private readonly now: () => number;
  private readonly pendingInputBytes: number;
  private readonly pendingInputCalls: number;
  private outputOwner: ExecutionOutputOwner;
  private readonly ownsOutput: boolean;
  private generation = 0;
  private closing?: Promise<void>;

  constructor(options: ShellSessionManagerOptions = {}) {
    this.shellConfig = options.shellConfig;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.maxRunning = options.maxRunning ?? SHELL_MAX_RUNNING;
    this.maxCompleted = options.maxCompleted ?? SHELL_MAX_COMPLETED;
    this.completedRetentionMs =
      options.completedRetentionMs ?? SHELL_COMPLETED_RETENTION_MS;
    this.bufferCapBytes = options.bufferCapBytes ?? SHELL_STREAM_BUFFER_BYTES;
    this.terminationGraceMs =
      options.terminationGraceMs ?? SHELL_TERMINATION_GRACE_MS;
    this.terminationConfirmMs =
      options.terminationConfirmMs ?? SHELL_TERMINATION_CONFIRM_MS;
    this.flushGraceMs = options.flushGraceMs ?? SHELL_FLUSH_GRACE_MS;
    this.settleGraceMs = options.settleGraceMs ?? SHELL_SETTLE_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.pendingInputBytes =
      options.pendingInputBytes ?? SHELL_PENDING_INPUT_BYTES;
    this.pendingInputCalls =
      options.pendingInputCalls ?? SHELL_PENDING_INPUT_CALLS;
    for (const value of [
      this.pendingInputBytes,
      this.pendingInputCalls,
      this.bufferCapBytes,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Stdin limits must be positive integers.");
    }
    this.ownsOutput = options.outputOwner === undefined;
    this.outputOwner = options.outputOwner ?? new ExecutionOutputOwner();
  }

  get runningCount(): number {
    return this.countRunning();
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Non-destructive control projection for nested cells; no output polling. */
  continuation(sessionId: string):
    | {
        sessionId: string;
        status: "running" | "terminated";
        unknownOutcome?: boolean;
      }
    | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return undefined;
    return session.terminateDispatched
      ? { sessionId, status: "terminated", unknownOutcome: true }
      : { sessionId, status: "running" };
  }

  async start(
    input: ShellStartInput,
    signal?: AbortSignal,
    onSession?: (sessionId: string) => void,
  ): Promise<ShellSessionResult> {
    if (typeof input.command !== "string" || input.command.length === 0) {
      throw new ShellSessionError(
        "invalid-command",
        "exec_command requires a non-empty command string.",
      );
    }
    const yieldMs = this.validateYield(input.yieldTimeMs);
    const maxBytes = this.validateMaxBytes(input.maxOutputBytes);
    this.checkAbort(signal);
    const generation = this.generation;
    this.checkAdmission(generation);
    const cwd = await this.validateCwd(input.cwd);
    this.pruneCompleted();
    this.checkAbort(signal);
    this.checkAdmission(generation);
    if (this.countRunning() >= this.maxRunning) {
      throw new ShellSessionError(
        "session-limit",
        `At most ${this.maxRunning} shell sessions can run at once. Wait for or terminate an existing session.`,
      );
    }

    const shell = this.resolveShell();
    const fromStdin = shell.commandTransport === "stdin";
    let child: ChildProcess;
    try {
      child = spawn(
        shell.shell,
        fromStdin ? shell.args : [...shell.args, input.command],
        {
          cwd,
          detached: this.platform !== "win32",
          env:
            input.env === undefined ? this.env : { ...this.env, ...input.env },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch {
      throw new ShellSessionError(
        "spawn-failed",
        "Failed to start the command; no managed job was created.",
      );
    }

    const exit = deferred();
    const session: ManagedSession = {
      id: `${SHELL_SESSION_PREFIX}${randomUUID()}`,
      child,
      stdout: new BoundedTextBuffer(this.bufferCapBytes),
      stderr: new BoundedTextBuffer(this.bufferCapBytes),
      exited: false,
      leaderExited: false,
      groupGone: false,
      stdoutDone: false,
      stderrDone: false,
      stdoutCapture: this.outputOwner.createCapture({
        memoryBytes: this.bufferCapBytes,
      }),
      stderrCapture: this.outputOwner.createCapture({
        memoryBytes: this.bufferCapBytes,
      }),
      exitCode: null,
      exitSignal: null,
      exitedAt: null,
      terminateDispatched: false,
      windowsTreeStopped: false,
      stdinCommandTransport: fromStdin,
      stdinEnded: false,
      stdinFailed: false,
      pendingInputBytes: 0,
      pendingInputCalls: 0,
      inputWaiters: new Set(),
      starting: true,
      observations: 0,
      chain: Promise.resolve(),
      waiters: new Set(),
      exitPromise: exit.promise,
      settle: exit.resolve,
    };
    this.sessions.set(session.id, session);

    this.consume(session, child.stdout, "stdout");
    this.consume(session, child.stderr, "stderr");
    const brokenInput = () => {
      session.stdinFailed = true;
      for (const waiter of [...session.inputWaiters])
        waiter(new Error("Stdin closed"));
    };
    child.stdin?.on("error", brokenInput);
    child.stdin?.on("close", () => {
      if (session.inputWaiters.size) brokenInput();
    });
    child.once("exit", (code, exitSignal) => {
      session.leaderExited = true;
      session.exitCode = code;
      session.exitSignal = exitSignal;
      this.checkSettled(session);
      this.wake(session);
    });
    // Establish spawn success even at yield=0. Never race an unobserved error
    // promise against an immediately fulfilled running preview.
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => {
        session.leaderExited = true;
        session.groupGone = child.pid === undefined;
        this.checkSettled(session);
        reject(
          new ShellSessionError("spawn-failed", "Failed to start the command."),
        );
      });
    });
    const abort = () => this.dispatchTermination(session);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await spawned;
      onSession?.(session.id);
      // close/abort may have arrived while Node was establishing the process.
      if (generation !== this.generation || signal?.aborted) {
        this.dispatchTermination(session);
        this.signalGroup(session, "SIGKILL");
        await this.waitForExit(session, this.terminationConfirmMs);
        throw new ShellSessionError(
          signal?.aborted ? "aborted" : "manager-closed",
          `Shell ${session.id} was stopped after spawn; ${session.exited ? "cleanup confirmed" : "cleanup unconfirmed, handle retained"}. Effects are not rolled back or replayed.`,
        );
      }
      if (fromStdin) {
        session.stdinEnded = true;
        // Keep command transport out of the interactive-input queue. This is
        // one already-owned command, never resent after an uncertain failure.
        child.stdin?.end(
          input.command.endsWith("\n") ? input.command : `${input.command}\n`,
        );
      }
      return await this.enqueue(session, () =>
        this.observe(session, yieldMs, maxBytes),
      );
    } catch (error) {
      if (child.pid === undefined || session.exited) {
        this.sessions.delete(session.id);
        await this.releaseOutput(session);
      }
      throw error;
    } finally {
      session.starting = false;
      signal?.removeEventListener("abort", abort);
    }
  }

  async write(
    input: ShellWriteInput,
    signal?: AbortSignal,
    options: ShellWriteOptions = {},
  ): Promise<ShellSessionResult> {
    const maxBytes = this.validateMaxBytes(input.maxOutputBytes);
    const yieldMs = this.validateYield(input.yieldTimeMs);
    const session = this.requireSession(input.sessionId);
    const deadline = Date.now() + yieldMs;
    if (
      session.stdinCommandTransport &&
      typeof input.input === "string" &&
      input.input.length > 0
    ) {
      throw new ShellSessionError(
        "stdin-transport",
        "This session was started by a shell that reads the command from stdin, so its stdin is already closed and cannot accept interactive input. Poll without input, or use a shell whose command transport is argv.",
      );
    }
    this.checkAbort(signal);
    const hasInput = typeof input.input === "string" && input.input.length > 0;
    if (input.terminate && hasInput) {
      throw new ShellSessionError(
        "stdin-closed",
        "Send input and terminate in separate calls; termination sends no input.",
        "not-sent",
      );
    }
    // A detached call's cancellation ends this call only: the session is not
    // its work to stop. Explicit terminate still stops it below.
    const detach =
      options.cancellation === "detach" && signal ? signal : undefined;
    // Stop and cancellation never queue behind observation or blocked stdin.
    const abort = () => this.dispatchTermination(session);
    if (!detach) signal?.addEventListener("abort", abort, { once: true });
    if (input.terminate) this.dispatchTermination(session);
    let inputDelivery: "written" | "unknown" | undefined;
    let inputRequest: InputRequest | undefined;
    try {
      // Lazy retention is still swept on shell calls. Never delay input/stop
      // behind disk work for another job; completed captures already have paths.
      this.pruneCompleted();
      inputRequest = this.sendInput(
        session,
        input,
        signal,
        detach !== undefined,
      );
      inputDelivery = await inputRequest?.delivery;
      return await this.enqueue(
        session,
        async () => {
          this.requireSession(session.id);
          const result = await this.observe(
            session,
            Math.max(0, deadline - Date.now()),
            maxBytes,
            detach,
          );
          if (inputDelivery) result.inputDelivery = inputDelivery;
          return result;
        },
        detach,
      );
    } catch (error) {
      if (inputDelivery && error instanceof ShellSessionError) {
        throw new ShellSessionError(
          error.code,
          `${error.message} Input was already submitted to ${session.id}; application effects are unknown. Do not resend automatically.`,
          "unknown",
        );
      }
      throw error;
    } finally {
      inputRequest?.release();
      signal?.removeEventListener("abort", abort);
    }
  }

  close(): Promise<void> {
    // Synchronously invalidate pending starts, including overlapping closes.
    this.generation++;
    if (this.closing) return this.closing;
    const sessions = [...this.sessions.values()];
    for (const session of sessions) this.dispatchTermination(session);
    const close = async () => {
      await Promise.all(
        sessions.map(async (session) => {
          await this.waitForExit(
            session,
            this.terminationGraceMs + this.terminationConfirmMs,
          );
          if (!session.exited) {
            this.signalGroup(session, "SIGKILL");
            await this.waitForExit(session, this.terminationConfirmMs);
          }
          if (session.exited) {
            // An earlier yielded result already published paths. Preserve any
            // later unread suffix before invalidating the execution handle.
            await this.recoverOutput(session);
            this.sessions.delete(session.id);
            await this.releaseOutput(session);
          }
        }),
      );
      const unknown = sessions.filter((session) => !session.exited);
      if (unknown.length) {
        throw new ShellSessionError(
          "cleanup-incomplete",
          `Cleanup unconfirmed; retained controllable shell handles: ${unknown.map((session) => session.id).join(", ")}. No command was replayed.`,
        );
      }
      if (this.ownsOutput) {
        await this.outputOwner.close();
        this.outputOwner = new ExecutionOutputOwner();
      }
    };
    this.closing = close().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }

  private async observe(
    session: ManagedSession,
    yieldMs: number,
    maxBytes: number,
    /** A detached caller's signal: every wait ends on it; nothing is consumed. */
    detach?: AbortSignal,
  ): Promise<ShellSessionResult> {
    this.requireSession(session.id);
    const deadline = Date.now() + yieldMs;
    if (!session.exited) {
      if (session.terminateDispatched) {
        await this.waitForExit(
          session,
          Math.min(
            yieldMs,
            this.terminationGraceMs + this.terminationConfirmMs,
          ),
          detach,
        );
      } else {
        await this.waitForActivity(session, yieldMs, detach);
        if (session.terminateDispatched) {
          await this.waitForExit(
            session,
            Math.min(
              Math.max(0, deadline - Date.now()),
              this.terminationGraceMs + this.terminationConfirmMs,
            ),
            detach,
          );
        } else if (
          !session.exited &&
          (session.leaderExited ||
            session.stdout.hasBytes ||
            session.stderr.hasBytes)
        ) {
          await this.waitForExit(session, this.settleGraceMs, detach);
        }
      }
    }
    this.requireSession(session.id);
    // A yielded handle needs stable paths even if no output has arrived yet:
    // later completion/TTL pruning cannot add a path to an old observation.
    let recovery: ShellSessionResult["recovery"];
    if (
      !session.exited ||
      session.stdout.byteLength + session.stderr.byteLength > maxBytes ||
      session.stdoutCapture.needsRecovery ||
      session.stderrCapture.needsRecovery
    ) {
      const settledBefore = session.exited;
      recovery = await this.recoverOutput(session);
      // Settlement ends both captures. If it landed during that publish, a
      // snapshot may predate it, and a terminal result releases the handle, so
      // no later read could replace it: publish the final states now.
      if (!settledBefore && session.exited)
        recovery = await this.recoverOutput(session);
    }
    this.requireSession(session.id);
    // After the last await and synchronously before buildResult, which drains
    // previews, and so before a terminal read releases its handle: a cancelled
    // detached caller leaves both for the next reader. Published recovery paths
    // are not a delivery.
    if (detach?.aborted) throw detachedCancellation(session.id);
    const result = this.buildResult(session, maxBytes);
    if (recovery) result.recovery = recovery;
    if (session.exited) {
      this.sessions.delete(session.id);
      await this.releaseOutput(session);
    }
    return result;
  }

  private buildResult(
    session: ManagedSession,
    maxBytes: number,
  ): ShellSessionResult {
    const stdout = session.stdout.drain(maxBytes);
    // maxOutputBytes is one combined budget per read: stdout drains first and
    // stderr receives whatever remains.
    const remaining = Math.max(
      0,
      maxBytes - Buffer.byteLength(stdout.text, "utf8"),
    );
    const stderr = session.stderr.drain(remaining);
    const dropped = stdout.dropped || stderr.dropped;
    const truncated = stdout.clipped || stderr.clipped || dropped;
    const terminated =
      session.terminateDispatched ||
      (session.exited && session.exitSignal !== null);
    const status: ShellSessionStatus = session.exited
      ? terminated
        ? "terminated"
        : "completed"
      : session.terminateDispatched
        ? "terminated"
        : "running";

    const result: ShellSessionResult = {
      sessionId: session.id,
      status,
      exitCode: session.exitCode,
      signal: session.exitSignal,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated,
      dropped,
      stdin: {
        state: session.stdinFailed
          ? "broken"
          : session.stdinEnded
            ? session.child.stdin?.writableFinished
              ? "closed"
              : "closing"
            : session.leaderExited || session.child.stdin?.destroyed
              ? "closed"
              : "open",
        pendingBytes: session.pendingInputBytes,
        pendingCalls: session.pendingInputCalls,
      },
    };
    if (session.terminateDispatched && !session.exited) {
      result.unknownOutcome = true;
    }
    return result;
  }

  private enqueue<T>(
    session: ManagedSession,
    task: () => Promise<T>,
    /** A detached caller's signal; see observe. */
    detach?: AbortSignal,
  ): Promise<T> {
    session.observations++;
    let started = false;
    const turn = (): Promise<T> => {
      // A detached caller cancelled while queued has already settled. Its turn
      // observes nothing, so it cannot drain output or take a terminal result.
      if (detach?.aborted) throw detachedCancellation(session.id);
      started = true;
      return task();
    };
    const run = session.chain.then(turn, turn).finally(() => {
      session.observations--;
    });
    session.chain = run.then(
      () => undefined,
      () => undefined,
    );
    if (!detach) return run;
    return new Promise<T>((resolve, reject) => {
      // Leave the queue at once, waking nobody: the active observation may be
      // another caller's. Once started, the observation settles this call.
      const leave = () => {
        if (!started) reject(detachedCancellation(session.id));
      };
      detach.addEventListener("abort", leave, { once: true });
      if (detach.aborted) leave();
      void run
        .then(resolve, reject)
        .finally(() => detach.removeEventListener("abort", leave));
    });
  }

  private requireSession(sessionId: unknown): ManagedSession {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new ShellSessionError(
        "invalid-session",
        "write_stdin requires session_id (or sessionId): the opaque session handle string returned by exec_command.",
      );
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new ShellSessionError(
        "stale-session",
        `Shell session ${sessionId} is unknown or expired. Use any previously returned output recovery paths; never rerun a command merely to recover output.`,
      );
    }
    return session;
  }

  private validateYield(value: unknown): number {
    if (value === undefined) return SHELL_YIELD_DEFAULT_MS;
    if (
      !isInteger(value) ||
      value < SHELL_YIELD_MIN_MS ||
      value > SHELL_YIELD_MAX_MS
    ) {
      throw new ShellSessionError(
        "invalid-limit",
        `yieldTimeMs must be an integer between ${SHELL_YIELD_MIN_MS} and ${SHELL_YIELD_MAX_MS}.`,
      );
    }
    return value;
  }

  private validateMaxBytes(value: unknown): number {
    if (value === undefined) return SHELL_MAX_BYTES_DEFAULT;
    if (
      !isInteger(value) ||
      value < SHELL_MAX_BYTES_MIN ||
      value > SHELL_MAX_BYTES_MAX
    ) {
      throw new ShellSessionError(
        "invalid-limit",
        `maxOutputBytes must be an integer between ${SHELL_MAX_BYTES_MIN} and ${SHELL_MAX_BYTES_MAX}.`,
      );
    }
    return value;
  }

  private async validateCwd(cwd: unknown): Promise<string> {
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new ShellSessionError(
        "invalid-cwd",
        "A working directory is required.",
      );
    }
    const absolute = resolve(cwd);
    let stats;
    try {
      stats = await statPath(absolute);
    } catch {
      throw new ShellSessionError(
        "invalid-cwd",
        `Working directory does not exist: ${absolute}`,
      );
    }
    if (!stats.isDirectory()) {
      throw new ShellSessionError(
        "invalid-cwd",
        `Working directory is not a directory: ${absolute}`,
      );
    }
    return absolute;
  }

  private resolveShell(): ShellConfigShape {
    if (this.shellConfig) return this.shellConfig;
    if (!this.resolvedShell) {
      try {
        this.resolvedShell = getShellConfig();
      } catch (error) {
        this.resolvedShell =
          error instanceof Error ? error : new Error(String(error));
      }
    }
    if (this.resolvedShell instanceof Error) {
      throw new ShellSessionError(
        "shell-unavailable",
        `No usable local shell is available: ${this.resolvedShell.message}`,
      );
    }
    return this.resolvedShell;
  }

  private checkAbort(signal: AbortSignal | undefined): void {
    if (signal?.aborted)
      throw new ShellSessionError(
        "aborted",
        "Shell call cancelled before dispatch; no input was sent.",
        "not-sent",
      );
  }

  private checkAdmission(generation: number): void {
    if (
      this.closing ||
      generation !== this.generation ||
      this.outputOwner.isClosed
    ) {
      throw new ShellSessionError(
        "manager-closed",
        "Shell owner closed while this start was pending; no command was dispatched.",
      );
    }
  }

  private async recoverOutput(
    session: ManagedSession,
  ): Promise<NonNullable<ShellSessionResult["recovery"]>> {
    const [stdout, stderr] = await Promise.all([
      session.stdoutCapture.publish(),
      session.stderrCapture.publish(),
    ]);
    return { stdout, stderr };
  }

  private async releaseOutput(session: ManagedSession): Promise<void> {
    await Promise.all([
      session.stdoutCapture.dispose(),
      session.stderrCapture.dispose(),
    ]);
  }

  private consume(
    session: ManagedSession,
    stream: Readable | null,
    name: "stdout" | "stderr",
  ): void {
    const capture =
      name === "stdout" ? session.stdoutCapture : session.stderrCapture;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: finish() only awaits enqueue(); checkSettled() catches process.kill and wake() only resolves waiters
      void capture.finish().then(() => {
        if (name === "stdout") session.stdoutDone = true;
        else session.stderrDone = true;
        this.checkSettled(session);
      });
    };
    if (!stream) {
      finish();
      return;
    }
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      stream.pause();
      // Admission happens before the destructive preview append. Pausing limits
      // this producer to one pending decoded chunk plus Node's pipe buffer.
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: append() settles through enqueue(); the preview append of a utf8 string, wake() and resume() do not throw
      void capture.append(chunk).then(() => {
        session[name].append(chunk);
        this.wake(session);
        stream.resume();
      });
    });
    stream.on("error", () => {
      capture.fail("source-error");
    });
    stream.once("end", finish);
    stream.once("close", () => {
      if (!stream.readableEnded) capture.fail("source-error");
      finish();
    });
  }

  private checkSettled(session: ManagedSession): void {
    if (session.exited || !session.leaderExited) return;
    if (!session.groupGone) {
      if (session.child.pid === undefined) {
        session.groupGone = true;
      } else if (this.platform === "win32") {
        // Natural Windows descendant tracking is not qualified; on explicit
        // stop, do not turn a failed/timed-out taskkill into confirmed cleanup.
        session.groupGone =
          !session.terminateDispatched || session.windowsTreeStopped;
      } else {
        try {
          process.kill(-session.child.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH")
            session.groupGone = true;
        }
      }
    }
    if (session.groupGone && session.stdoutDone && session.stderrDone) {
      session.exited = true;
      session.exitedAt = this.now();
      if (session.escalationTimer) clearTimeout(session.escalationTimer);
      if (session.groupTimer) clearTimeout(session.groupTimer);
      session.escalationTimer = undefined;
      session.groupTimer = undefined;
      session.settle();
      this.wake(session);
    } else if (!session.groupTimer) {
      // Former flush grace is now a group-liveness sampling interval, never a
      // deadline that discards inherited pipes or descendant output.
      session.groupTimer = setTimeout(
        () => {
          session.groupTimer = undefined;
          this.checkSettled(session);
        },
        Math.max(1, this.flushGraceMs),
      );
      session.groupTimer.unref?.();
    }
  }

  private sendInput(
    session: ManagedSession,
    input: ShellWriteInput,
    signal?: AbortSignal,
    detached = false,
  ): InputRequest | undefined {
    const text = input.input ?? "";
    if (!text && (!input.closeStdin || session.stdinEnded || input.terminate))
      return undefined;
    this.checkAbort(signal);
    const stdin = session.child.stdin;
    if (
      session.exited ||
      session.leaderExited ||
      session.terminateDispatched ||
      session.stdinEnded ||
      session.stdinFailed ||
      !stdin ||
      stdin.destroyed ||
      stdin.writableEnded
    ) {
      throw new ShellSessionError(
        "stdin-closed",
        "This session's stdin is closed or broken; input was not sent. Poll without input.",
        "not-sent",
      );
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (
      session.pendingInputBytes + bytes > this.pendingInputBytes ||
      session.pendingInputCalls >= this.pendingInputCalls
    ) {
      throw new ShellSessionError(
        "stdin-overload",
        `Pending stdin is limited to ${this.pendingInputBytes} bytes and ${this.pendingInputCalls} calls per session; this input was not sent. Wait for pending input to settle before sending more.`,
        "not-sent",
      );
    }
    session.pendingInputBytes += bytes;
    session.pendingInputCalls++;
    let transportSettled = false;
    let requestSettled = false;
    let released = false;
    const release = () => {
      // A fast reader must not let unlimited input invocations accumulate
      // behind a quiet observer. Conversely, a returned unknown delivery must
      // keep its bytes reserved until Node releases the writable buffer.
      if (!released && transportSettled && requestSettled) {
        released = true;
        session.pendingInputBytes -= bytes;
        session.pendingInputCalls--;
      }
    };
    const delivered = new Promise<"written">((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        session.inputWaiters.delete(finish);
        transportSettled = true;
        release();
        if (error) {
          session.stdinFailed = true;
          reject(
            new ShellSessionError(
              "stdin-failed",
              `Stdin transport failed for ${session.id}; some bytes may have been sent. Do not resend automatically.`,
              "unknown",
            ),
          );
        } else resolve("written");
      };
      session.inputWaiters.add(finish);
      try {
        // Node preserves write/end order. The reservation includes bytes in its
        // writable queue until the callback (not just until write() returns).
        if (input.closeStdin) {
          session.stdinEnded = true;
          // end(), like write(), calls back with an error before the error
          // event. Preserve it rather than acknowledging a failed EOF write.
          stdin.end(text, finish);
        } else stdin.write(text, finish);
      } catch {
        finish(new Error("Stdin write failed"));
      }
    });
    const delivery = new Promise<"written" | "unknown">((resolve, reject) => {
      const timer = setTimeout(
        () => finish("unknown"),
        this.validateYield(input.yieldTimeMs),
      );
      timer.unref?.();
      const abort = () =>
        finish(
          undefined,
          new ShellSessionError(
            "aborted",
            `Input delivery to ${session.id} is unknown after cancellation; do not resend automatically.${detached ? ` ${notStopped(session.id)}` : ""}`,
            "unknown",
          ),
        );
      const finish = (value?: "written" | "unknown", error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value ?? "unknown");
      };
      signal?.addEventListener("abort", abort, { once: true });
      delivered.then(
        (value) => finish(value),
        (error: Error) => finish(undefined, error),
      );
      if (signal?.aborted) abort();
    });
    return {
      delivery,
      release: () => {
        requestSettled = true;
        release();
      },
    };
  }

  private dispatchTermination(session: ManagedSession): void {
    if (session.exited) return;
    if (session.terminateDispatched) {
      // An uncertain job remains controllable; an explicit later stop can retry
      // a signal, never stdin or the command itself.
      this.signalGroup(session, "SIGKILL");
      this.wake(session);
      return;
    }
    session.terminateDispatched = true;
    this.signalGroup(session, "SIGTERM");
    this.wake(session);
    if (this.platform !== "win32") {
      session.escalationTimer = setTimeout(() => {
        if (!session.exited) this.signalGroup(session, "SIGKILL");
      }, this.terminationGraceMs);
      session.escalationTimer.unref?.();
    }
  }

  private signalGroup(session: ManagedSession, signal: NodeJS.Signals): void {
    const pid = session.child.pid;
    if (pid === undefined || session.groupGone) return;
    if (this.platform === "win32") {
      // taskkill returns synchronously before Node can emit the leader exit.
      // A concurrent stop must not overwrite a confirmed tree stop with ESRCH.
      if (session.windowsTreeStopped) return;
      try {
        const result = spawnSync(
          "taskkill",
          ["/PID", String(pid), "/T", "/F"],
          {
            windowsHide: true,
            timeout: Math.max(1, this.terminationConfirmMs),
            killSignal: "SIGKILL",
          },
        );
        session.windowsTreeStopped = result.status === 0 && !result.error;
      } catch {
        // The process may already be gone.
      }
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      // The process group may already be gone.
    }
  }

  private async waitForExit(
    session: ManagedSession,
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (session.exited || budgetMs <= 0 || signal?.aborted) return;
    // Waking the session cannot end this wait, so a detached caller races its
    // own signal instead.
    const aborted = signal ? abortion(signal) : undefined;
    try {
      await Promise.race([
        session.exitPromise,
        delay(budgetMs),
        ...(aborted ? [aborted.promise] : []),
      ]);
    } finally {
      aborted?.release();
    }
  }

  private async waitForActivity(
    session: ManagedSession,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      session.exited ||
      session.terminateDispatched ||
      session.stdout.hasBytes ||
      session.stderr.hasBytes
    ) {
      return;
    }
    if (timeoutMs <= 0 || signal?.aborted) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        session.waiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      session.waiters.add(finish);
      // This call's own abort also ends this wait, without waking the session.
      signal?.addEventListener("abort", finish, { once: true });
      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    });
  }

  private wake(session: ManagedSession): void {
    for (const waiter of [...session.waiters]) waiter();
  }

  private countRunning(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!session.exited) count += 1;
    }
    return count;
  }

  private pruneCompleted(): void {
    const now = this.now();
    const completed: ManagedSession[] = [];
    for (const session of this.sessions.values()) {
      if (!session.exited || session.starting || session.observations) continue;
      if (
        session.exitedAt !== null &&
        now - session.exitedAt > this.completedRetentionMs
      ) {
        // Every previously yielded job published both recovery paths, and
        // settlement finished their capture before marking this record terminal.
        this.sessions.delete(session.id);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: releaseOutput() only awaits capture.dispose(), which only awaits enqueue()
        void this.releaseOutput(session);
        continue;
      }
      completed.push(session);
    }
    completed.sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0));
    while (completed.length > this.maxCompleted) {
      const evicted = completed.shift();
      if (evicted) {
        this.sessions.delete(evicted.id);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: releaseOutput() only awaits capture.dispose(), which only awaits enqueue()
        void this.releaseOutput(evicted);
      }
    }
  }
}
