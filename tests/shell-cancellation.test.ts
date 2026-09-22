import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeModeAdapters } from "../src/code-mode/adapters.ts";
import {
  CodeModeCellManager,
  type CodeModeCellResult,
} from "../src/code-mode/manager.ts";
import {
  SHELL_PENDING_INPUT_BYTES,
  SHELL_YIELD_MAX_MS,
  ShellSessionError,
  ShellSessionManager,
} from "../src/shell/manager.ts";
import { INNER_BUDGET_MS } from "./fixtures/budgets.ts";

// Who stops a shell job when a call observing it is cancelled. A direct
// exec_command or write_stdin cancellation stops the job (Shell Sessions AC4/R3).
// A Code Mode cell's failure, stop or close fences its nested write_stdin, which
// ends that call only: the shell stays independent (P3-B, P3-E).

const shells: ShellSessionManager[] = [];
const cells: CodeModeCellManager[] = [];
const directories: string[] = [];

afterEach(async () => {
  // Shells first: stopping every job also ends any poll a cell still waits on.
  const stopped = await Promise.allSettled(
    shells.splice(0).map((shell) => shell.close()),
  );
  const closed = await Promise.allSettled(
    cells.splice(0).map((cell) => cell.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  expect(
    [...stopped, ...closed].filter((result) => result.status === "rejected"),
  ).toEqual([]);
});

const WAIT = { timeout: INNER_BUDGET_MS, interval: 5 };
const QUIET = "sleep 60";
const MISSING = "pct-shell-missing";
const context = { cwd: process.cwd() };

function shellManager(
  options: ConstructorParameters<typeof ShellSessionManager>[0] = {},
): ShellSessionManager {
  const shell = new ShellSessionManager({
    shellConfig: { shell: "/bin/sh", args: ["-c"], commandTransport: "argv" },
    ...options,
  });
  shells.push(shell);
  return shell;
}

/** The real nested adapters and cell manager over one shared shell manager. */
function harness(
  options: ConstructorParameters<typeof ShellSessionManager>[0] = {},
) {
  const shell = shellManager(options);
  const cell = new CodeModeCellManager({
    dispatcher: new CodeModeAdapters({ shell }),
  });
  cells.push(cell);
  return { shell, cell };
}

/** A phase boundary the test opens, instead of a sleep the child could outrun. */
async function gates() {
  const directory = await mkdtemp(join(tmpdir(), "pct-shell-cancel-"));
  directories.push(directory);
  return (name: string) => {
    const path = join(directory, name);
    return {
      wait: `while [ ! -e '${path}' ]; do sleep 0.01; done`,
      open: () => writeFile(path, ""),
    };
  };
}

interface SessionState {
  observations: number;
  waiters: Set<unknown>;
  exited: boolean;
  stdout: { hasBytes: boolean };
}

// Instance seam on private state: observations counts queued and active
// observers; the active observation is the only activity waiter.
function state(shell: ShellSessionManager, sessionId: string): SessionState {
  const session = (
    shell as unknown as { sessions: Map<string, SessionState> }
  ).sessions.get(sessionId);
  if (!session) throw new Error(`no managed session ${sessionId}`);
  return session;
}

async function observing(
  shell: ShellSessionManager,
  sessionId: string,
  observations: number,
): Promise<void> {
  await vi.waitFor(() => {
    const session = state(shell, sessionId);
    expect({
      observations: session.observations,
      waiting: session.waiters.size,
    }).toEqual({ observations, waiting: 1 });
  }, WAIT);
}

async function queued(
  shell: ShellSessionManager,
  sessionId: string,
  observations: number,
): Promise<void> {
  await vi.waitFor(
    () => expect(state(shell, sessionId).observations).toBe(observations),
    WAIT,
  );
}

async function terminal(
  cell: CodeModeCellManager,
  result: CodeModeCellResult,
): Promise<CodeModeCellResult> {
  const ended = await cell.wait({
    cellId: result.cellId,
    yieldTimeMs: INNER_BUDGET_MS,
  });
  expect(ended.status).not.toBe("running");
  return ended;
}

/**
 * A cell that polls `sessionId` and, once the test opens `gate`, fails through
 * a nested call that rejects at once.
 */
function failWhilePolling(sessionId: string, gate: string): string {
  return [
    `const poll = tools.write_stdin({sessionId: ${JSON.stringify(sessionId)}, yieldTimeMs: ${SHELL_YIELD_MAX_MS}});`,
    `await tools.exec_command({command: ${JSON.stringify(gate)}, yieldTimeMs: ${INNER_BUDGET_MS}});`,
    `await Promise.all([poll, tools.write_stdin({sessionId: ${JSON.stringify(MISSING)}})]);`,
  ].join("\n");
}

function staleMessage(sessionId: string): string {
  return `Shell session ${sessionId} is unknown or expired. Use any previously returned output recovery paths; never rerun a command merely to recover output.`;
}

function notStopped(sessionId: string): string {
  return `This cancellation did not stop shell ${sessionId}; poll or terminate it with write_stdin.`;
}

function detachedError(sessionId: string): ShellSessionError {
  return new ShellSessionError(
    "aborted",
    `Shell call cancelled; no output was read. ${notStopped(sessionId)}`,
  );
}

function capturing(bytes: number) {
  return {
    state: "capturing",
    path: expect.any(String),
    bytes,
    capturedBytes: bytes,
  };
}

function complete(bytes: number) {
  return {
    state: "complete",
    path: expect.any(String),
    bytes,
    capturedBytes: bytes,
  };
}

/** A running read: `stdout` is new output; capture counts are cumulative. */
function runningResult(
  sessionId: string,
  stdout: string,
  capturedStdout = Buffer.byteLength(stdout),
) {
  return {
    sessionId,
    status: "running",
    exitCode: null,
    signal: null,
    stdout,
    stderr: "",
    truncated: false,
    dropped: false,
    stdin: { state: "open", pendingBytes: 0, pendingCalls: 0 },
    recovery: {
      stdout: capturing(capturedStdout),
      stderr: capturing(0),
    },
  };
}

describe.skipIf(process.platform === "win32")(
  "direct cancellation stops the job (AC4/R3)",
  () => {
    it("stops the job when a direct exec_command is cancelled during its first observation", async () => {
      const shell = shellManager();
      const controller = new AbortController();
      let sessionId = "";
      const started = shell.start(
        { command: QUIET, cwd: process.cwd(), yieldTimeMs: INNER_BUDGET_MS },
        controller.signal,
        (id) => {
          sessionId = id;
        },
      );
      await vi.waitFor(() => expect(sessionId).not.toBe(""), WAIT);
      await observing(shell, sessionId, 1);
      controller.abort();
      expect(await started).toEqual({
        sessionId,
        status: "terminated",
        exitCode: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        truncated: false,
        dropped: false,
        stdin: { state: "closed", pendingBytes: 0, pendingCalls: 0 },
      });
      expect(shell.hasSession(sessionId)).toBe(false);
    });

    it("stops the job when a direct write_stdin poll is cancelled", async () => {
      const shell = shellManager();
      const { sessionId } = await shell.start({
        command: QUIET,
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const controller = new AbortController();
      const poll = shell.write(
        { sessionId, yieldTimeMs: INNER_BUDGET_MS },
        controller.signal,
      );
      await observing(shell, sessionId, 1);
      controller.abort();
      expect(await poll).toEqual({
        sessionId,
        status: "terminated",
        exitCode: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        truncated: false,
        dropped: false,
        stdin: { state: "closed", pendingBytes: 0, pendingCalls: 0 },
        recovery: { stdout: complete(0), stderr: complete(0) },
      });
      expect(shell.hasSession(sessionId)).toBe(false);
    });

    it("P3-C stops a job whose direct poll is cancelled while a yielded cell also polls it, and delivers its end once", async () => {
      const { shell, cell } = harness();
      const { sessionId } = await shell.start({
        command: QUIET,
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const background = await cell.exec({
        code: `const r = await tools.write_stdin({sessionId: ${JSON.stringify(sessionId)}, yieldTimeMs: ${SHELL_YIELD_MAX_MS}}); return {status: r.status, exitCode: r.exitCode, signal: r.signal, unknownOutcome: r.unknownOutcome ?? null};`,
        uses: ["write_stdin"],
        context,
        yieldTimeMs: 0,
      });
      await observing(shell, sessionId, 1);
      const controller = new AbortController();
      const direct = shell.write(
        { sessionId, yieldTimeMs: INNER_BUDGET_MS },
        controller.signal,
      );
      void direct.catch(() => undefined);
      await queued(shell, sessionId, 2);
      controller.abort();
      // The cell's poll held the slot, so it reads the end; the direct call is stale.
      await expect(direct).rejects.toStrictEqual(
        new ShellSessionError("stale-session", staleMessage(sessionId)),
      );
      const ended = await terminal(cell, background);
      expect({ status: ended.status, result: ended.result }).toEqual({
        status: "completed",
        result: {
          status: "terminated",
          exitCode: null,
          signal: "SIGTERM",
          unknownOutcome: null,
        },
      });
      expect(shell.hasSession(sessionId)).toBe(false);
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "a cell's fence ends its nested write_stdin without stopping the shell",
  () => {
    it("P3-E leaves a directly started session running when a cell fails while only polling it", async () => {
      const { shell, cell } = harness();
      const gate = await gates();
      const fail = gate("fail");
      const { sessionId } = await shell.start({
        command: QUIET,
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const failing = await cell.exec({
        code: failWhilePolling(sessionId, fail.wait),
        uses: ["write_stdin", "exec_command"],
        context,
        yieldTimeMs: 0,
      });
      await observing(shell, sessionId, 1);
      await fail.open();
      const failed = await terminal(cell, failing);
      await vi.waitFor(() => expect(cell.runningCount).toBe(0), WAIT);
      expect(shell.continuation(sessionId)).toEqual({
        sessionId,
        status: "running",
      });
      expect({
        status: failed.status,
        error: failed.error,
        shells: failed.shells,
      }).toEqual({
        status: "failed",
        error: staleMessage(MISSING),
        shells: [{ sessionId, status: "running" }],
      });
      expect(await shell.write({ sessionId, yieldTimeMs: 0 })).toEqual(
        runningResult(sessionId, ""),
      );
    });

    it("P3-B leaves a session running and its direct observer's result intact when a cell fails while polling it", async () => {
      const { shell, cell } = harness();
      const gate = await gates();
      const fail = gate("fail");
      const tick = gate("tick");
      const { sessionId } = await shell.start({
        command: `${tick.wait}; echo tick; ${QUIET}`,
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const failing = await cell.exec({
        code: failWhilePolling(sessionId, fail.wait),
        uses: ["write_stdin", "exec_command"],
        context,
        yieldTimeMs: 0,
      });
      await observing(shell, sessionId, 1);
      // A direct observer with no cancellation of its own queues behind the cell's poll.
      const direct = shell.write({ sessionId, yieldTimeMs: INNER_BUDGET_MS });
      void direct.catch(() => undefined);
      await queued(shell, sessionId, 2);
      await fail.open();
      const failed = await terminal(cell, failing);
      await vi.waitFor(() => expect(cell.runningCount).toBe(0), WAIT);
      expect(failed.status).toBe("failed");
      expect(shell.continuation(sessionId)).toEqual({
        sessionId,
        status: "running",
      });
      // The direct call now holds the slot; its own output ends it.
      await observing(shell, sessionId, 1);
      await tick.open();
      expect(await direct).toEqual(runningResult(sessionId, "tick\n"));
      expect(await shell.write({ sessionId, yieldTimeMs: 0 })).toEqual(
        runningResult(sessionId, "", Buffer.byteLength("tick\n")),
      );
    });

    it("settles a fenced nested poll queued behind a direct poll at once, without waking that poll", async () => {
      const { shell, cell } = harness();
      const gate = await gates();
      const fail = gate("fail");
      const tick = gate("tick");
      const { sessionId } = await shell.start({
        command: `${tick.wait}; echo tick; ${QUIET}`,
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      let directSettled = false;
      const direct = shell.write({
        sessionId,
        yieldTimeMs: SHELL_YIELD_MAX_MS,
      });
      void direct
        .finally(() => {
          directSettled = true;
        })
        .catch(() => undefined);
      await observing(shell, sessionId, 1);
      const failing = await cell.exec({
        code: failWhilePolling(sessionId, fail.wait),
        uses: ["write_stdin", "exec_command"],
        context,
        yieldTimeMs: 0,
      });
      await queued(shell, sessionId, 2);
      await fail.open();
      const failed = await terminal(cell, failing);
      expect(failed.status).toBe("failed");
      // The queued nested call left at once: nothing of the cell is pending,
      // well before the direct poll's 60-second yield.
      await vi.waitFor(() => expect(cell.runningCount).toBe(0), WAIT);
      // Its abort stopped and woke nobody: the direct poll still waits on its
      // own terms.
      expect({
        directSettled,
        continuation: shell.continuation(sessionId),
        waiting: shell.hasSession(sessionId)
          ? state(shell, sessionId).waiters.size
          : "no session",
      }).toEqual({
        directSettled: false,
        continuation: { sessionId, status: "running" },
        waiting: 1,
      });
      await tick.open();
      expect(await direct).toEqual(runningResult(sessionId, "tick\n"));
      // The cancelled turn observes nothing when it reaches the head, then leaves.
      await vi.waitFor(
        () => expect(state(shell, sessionId).observations).toBe(0),
        WAIT,
      );
      expect(await shell.write({ sessionId, yieldTimeMs: 0 })).toEqual(
        runningResult(sessionId, "", Buffer.byteLength("tick\n")),
      );
    });

    it("never drains output pending for a detached call cancelled while it observes", async () => {
      const gate = await gates();
      const say = gate("say");
      const end = gate("end");
      // A settle grace longer than any bound here holds the observation after
      // the output arrives: only the cancellation can end it.
      const shell = shellManager({ settleGraceMs: SHELL_YIELD_MAX_MS });
      const { sessionId } = await shell.start({
        command: `${say.wait}; printf pending; ${end.wait}`,
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const controller = new AbortController();
      let settled = false;
      const detached = shell.write(
        { sessionId, yieldTimeMs: SHELL_YIELD_MAX_MS },
        controller.signal,
        { cancellation: "detach" },
      );
      void detached
        .finally(() => {
          settled = true;
        })
        .catch(() => undefined);
      await observing(shell, sessionId, 1);
      await say.open();
      await vi.waitFor(() => {
        const session = state(shell, sessionId);
        expect({
          output: session.stdout.hasBytes,
          waiting: session.waiters.size,
        }).toEqual({ output: true, waiting: 0 });
      }, WAIT);
      controller.abort();
      await vi.waitFor(() => expect(settled).toBe(true), WAIT);
      await expect(detached).rejects.toStrictEqual(detachedError(sessionId));
      expect(shell.continuation(sessionId)).toEqual({
        sessionId,
        status: "running",
      });
      await end.open();
      expect(
        await shell.write({ sessionId, yieldTimeMs: INNER_BUDGET_MS }),
      ).toEqual({
        sessionId,
        status: "completed",
        exitCode: 0,
        signal: null,
        stdout: "pending",
        stderr: "",
        truncated: false,
        dropped: false,
        stdin: { state: "closed", pendingBytes: 0, pendingCalls: 0 },
        recovery: { stdout: complete(7), stderr: complete(0) },
      });
    });

    it("never consumes the terminal result when a detached call is cancelled as the job exits", async () => {
      const gate = await gates();
      const exit = gate("exit");
      const controller = new AbortController();
      let race: string | undefined;
      const shell: ShellSessionManager = shellManager({
        // The manager reads its clock as a job settles, before any observer
        // resumes: cancel at exactly that point.
        now: () => {
          if (race !== undefined && state(shell, race).exited) {
            race = undefined;
            controller.abort();
          }
          return Date.now();
        },
      });
      const { sessionId } = await shell.start({
        command: exit.wait,
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const detached = shell.write(
        { sessionId, yieldTimeMs: SHELL_YIELD_MAX_MS },
        controller.signal,
        { cancellation: "detach" },
      );
      void detached.catch(() => undefined);
      await observing(shell, sessionId, 1);
      race = sessionId;
      await exit.open();
      await vi.waitFor(
        () => expect(controller.signal.aborted).toBe(true),
        WAIT,
      );
      await expect(detached).rejects.toStrictEqual(detachedError(sessionId));
      expect(await shell.write({ sessionId, yieldTimeMs: 0 })).toEqual({
        sessionId,
        status: "completed",
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        truncated: false,
        dropped: false,
        stdin: { state: "closed", pendingBytes: 0, pendingCalls: 0 },
        recovery: { stdout: complete(0), stderr: complete(0) },
      });
      await expect(
        shell.write({ sessionId, yieldTimeMs: 0 }),
      ).rejects.toStrictEqual(
        new ShellSessionError("stale-session", staleMessage(sessionId)),
      );
    });

    it("keeps input submitted before a detached cancellation reserved until its transport settles", async () => {
      const gate = await gates();
      const read = gate("read");
      const shell = shellManager();
      // More input than a pipe buffer holds, to a process not yet reading stdin.
      const { sessionId } = await shell.start({
        command: `${read.wait}; cat >/dev/null`,
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const controller = new AbortController();
      const detached = shell.write(
        {
          sessionId,
          input: "a".repeat(SHELL_PENDING_INPUT_BYTES),
          yieldTimeMs: SHELL_YIELD_MAX_MS,
        },
        controller.signal,
        { cancellation: "detach" },
      );
      const outcome = detached.then(
        () => undefined,
        (error: unknown) => error,
      );
      controller.abort();
      const error = await outcome;
      expect(shell.continuation(sessionId)).toEqual({
        sessionId,
        status: "running",
      });
      expect(error).toStrictEqual(
        new ShellSessionError(
          "aborted",
          `Input delivery to ${sessionId} is unknown after cancellation; do not resend automatically. ${notStopped(sessionId)}`,
          "unknown",
        ),
      );
      // The request settled, but the transport still holds the bytes.
      expect((await shell.write({ sessionId, yieldTimeMs: 0 })).stdin).toEqual({
        state: "open",
        pendingBytes: SHELL_PENDING_INPUT_BYTES,
        pendingCalls: 1,
      });
      await read.open();
      await vi.waitFor(async () => {
        expect(
          (await shell.write({ sessionId, yieldTimeMs: 0 })).stdin,
        ).toEqual({ state: "open", pendingBytes: 0, pendingCalls: 0 });
      }, WAIT);
    });
  },
);
