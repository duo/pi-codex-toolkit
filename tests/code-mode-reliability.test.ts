import { open, readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodeModeCellManager,
  CodeModeError,
  type CellDispatcher,
  type CodeModeCellResult,
} from "../src/code-mode/manager.ts";
import { CodeModeAdapters } from "../src/code-mode/adapters.ts";
import { APPLY_PATCH_TOOL_DEFINITION } from "../src/apply-patch.ts";
import { formatCodeModeResult } from "../src/code-mode/tools.ts";
import {
  ExecutionOutputCapture,
  ExecutionOutputOwner,
} from "../src/execution-output.ts";
import {
  INNER_BUDGET_MS,
  TEST_BUDGET_MS,
  outerBudget,
} from "./fixtures/budgets.ts";
import { restoreStopConfirmationWindow } from "./fixtures/code-mode-stops.ts";

const managers: CodeModeCellManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});
function manager(dispatcher: CellDispatcher, options = {}) {
  const m = new CodeModeCellManager({ dispatcher, ...options });
  managers.push(m);
  return m;
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function terminal(
  m: CodeModeCellManager,
  result: CodeModeCellResult,
): Promise<CodeModeCellResult> {
  for (let n = 0; result.status === "running" && n < 40; n++)
    result = await m.wait({
      cellId: result.cellId,
      yieldTimeMs: 1000,
      maxOutputBytes: 1024,
    });
  expect(result.status).not.toBe("running");
  return result;
}

// What an unconfirmed stop tells the model while the program has not finished.
const STOP_UNCONFIRMED =
  "Worker termination is unconfirmed; keep the cell handle and wait/terminate again. No replay.";

/**
 * Holds every capture file close until released. After done, the manager
 * finishes each capture, and closing its file is the last step of that
 * publication. An exec read with a zero yield publishes, so every capture
 * already has a file by then.
 */
function holdPublication() {
  const entered = gate<void>();
  const released = gate<void>();
  const owner = new ExecutionOutputOwner({
    ioTimeoutMs: INNER_BUDGET_MS,
    openFile: async (path) => {
      const file = await open(path, "wx", 0o600);
      return {
        write: (buffer) => file.write(buffer),
        close: async () => {
          entered.resolve();
          await released.promise;
          await file.close();
        },
      };
    },
  });
  return {
    owner,
    entered: entered.promise,
    release: () => released.resolve(),
  };
}

/**
 * Swallows the host's shutdown packet, so a finished worker stays live, and
 * records the worker from the first packet the host sends it. `shutdown`
 * resolves when the host posts that packet.
 */
function keepWorkerLive() {
  let worker: Worker | undefined;
  const shutdown = gate<void>();
  const post = Worker.prototype.postMessage;
  const packets = vi
    .spyOn(Worker.prototype, "postMessage")
    .mockImplementation(function (this: Worker, message, ...args) {
      worker ??= this;
      if (message?.type === "shutdown") {
        shutdown.resolve();
        return;
      }
      return post.call(this, message, ...args);
    });
  return {
    worker: () => worker,
    shutdown: shutdown.promise,
    restore: () => packets.mockRestore(),
  };
}

// Apart from the tests of the grace itself, a test that holds a finished worker
// live on purpose, or counts terminate() calls on one, keeps the reclaim grace
// beyond its budget: however slow a contended run is, the grace cannot add a
// terminate() call.
const HELD_LIVE_GRACE_MS = outerBudget(TEST_BUDGET_MS);

/**
 * Withholds the worker's done packet from the manager until the test delivers
 * it. The worker has finished; only the manager's view of it waits.
 */
function holdDone() {
  let held: { worker: Worker; message: unknown } | undefined;
  const finished = gate<Worker>();
  const emit = Worker.prototype.emit;
  let restored = false;
  const packets = vi
    .spyOn(Worker.prototype, "emit")
    .mockImplementation(function (this: Worker, event, ...args) {
      if (event === "message" && args[0]?.type === "done") {
        held = { worker: this, message: args[0] };
        finished.resolve(this);
        return true;
      }
      return emit.call(this, event, ...args);
    });
  const restore = () => {
    if (restored) return;
    restored = true;
    packets.mockRestore();
  };
  return {
    finished: finished.promise,
    deliver: () => {
      restore();
      emit.call(held!.worker, "message", held!.message);
    },
    restore,
  };
}

type ManagerStep = "waitForExit" | "waitForWake";
/** A call-through watch of a private manager step: its first entry and return. */
function watchStep(m: CodeModeCellManager, step: ManagerStep) {
  const steps = m as unknown as Record<
    ManagerStep,
    (...args: unknown[]) => Promise<void>
  >;
  const original = steps[step].bind(m);
  const entered = gate<void>();
  const returned = gate<void>();
  const spy = vi.spyOn(steps, step).mockImplementation(async (...args) => {
    entered.resolve();
    try {
      await original(...args);
    } finally {
      returned.resolve();
    }
  });
  return {
    entered: entered.promise,
    returned: returned.promise,
    restore: () => spy.mockRestore(),
  };
}

/** Resolves when a read starts publishing its captures; calls through. */
function watchPublish() {
  const publish = ExecutionOutputCapture.prototype.publish;
  const entered = gate<void>();
  const spy = vi
    .spyOn(ExecutionOutputCapture.prototype, "publish")
    .mockImplementation(function (this: ExecutionOutputCapture) {
      entered.resolve();
      return publish.call(this);
    });
  return { entered: entered.promise, restore: () => spy.mockRestore() };
}

interface CellFlags {
  doneReceived: boolean;
  terminateRequested: boolean;
  terminal: boolean;
}
/**
 * Records the cell's flags as each read starts building its result. An
 * optional action runs once, at the first entry, before the flags are read and
 * the original is called.
 */
function watchResults(m: CodeModeCellManager, atFirstEntry?: () => void) {
  const target = m as unknown as {
    buildResult(cell: CellFlags, maxBytes: number): Promise<unknown>;
  };
  const buildResult = target.buildResult.bind(m);
  const flags: CellFlags[] = [];
  const spy = vi
    .spyOn(target, "buildResult")
    .mockImplementation((cell, maxBytes) => {
      if (flags.length === 0) atFirstEntry?.();
      const { doneReceived, terminateRequested, terminal } = cell;
      flags.push({ doneReceived, terminateRequested, terminal });
      return buildResult(cell, maxBytes);
    });
  return { flags, restore: () => spy.mockRestore() };
}

function doneReceived(
  m: CodeModeCellManager,
  cellId: string,
): boolean | undefined {
  return (
    m as unknown as { cells: Map<string, { doneReceived: boolean }> }
  ).cells.get(cellId)?.doneReceived;
}

const staleCell = (cellId: string) =>
  new CodeModeError(
    "stale-cell",
    `Code Mode cell ${cellId} is unknown, released or expired. Use previously returned recovery paths; never rerun a program to recover output.`,
  );

/** The worker of the manager's only owned cell. */
function onlyWorker(m: CodeModeCellManager): Worker {
  const cells = [...(m as unknown as { owned: Set<{ worker: Worker }> }).owned];
  expect(cells).toHaveLength(1);
  return cells[0].worker;
}

/** Records terminate() calls on every worker; calls through. */
function watchStops() {
  const spy = vi.spyOn(Worker.prototype, "terminate");
  const on = (worker: Worker) =>
    spy.mock.contexts.flatMap((context, call) =>
      context === worker
        ? [spy.mock.results[call].value as Promise<number | undefined>]
        : [],
    );
  return {
    /** How many calls this worker has received so far. */
    count: (worker: Worker) => on(worker).length,
    /** What each call on this worker resolved to: 1 when it stopped the worker. */
    results: (worker: Worker) => Promise.all(on(worker)),
    restore: () => spy.mockRestore(),
  };
}

/** Whether the worker exits within the inner budget; resolves at its exit. */
function exits(worker: Worker): Promise<boolean> {
  return vi
    .waitFor(() => expect(worker.threadId).toBe(-1), {
      timeout: INNER_BUDGET_MS,
      interval: 5,
    })
    .then(
      () => true,
      () => false,
    );
}

describe("Code Mode reliability regressions", () => {
  it("CM1 settles transitive calls scheduled by a floating then chain", async () => {
    const first = gate<void>();
    const second = gate<void>();
    const invoked = gate<void>();
    let calls = 0;
    const m = manager({
      allowedNames: ["hold"],
      call: () => {
        calls++;
        if (calls === 1) return first.promise;
        invoked.resolve();
        return second.promise;
      },
    });
    try {
      const start = await m.exec({
        code: 'tools.hold({}).then(() => tools.hold({})); return "done";',
        uses: ["hold"],
        yieldTimeMs: 0,
      });
      first.resolve();
      await invoked.promise;
      const pending = await m.wait({ cellId: start.cellId, yieldTimeMs: 100 });
      expect(pending.status).toBe("running");
      second.resolve();
      expect((await terminal(m, pending)).result).toBe("done");
    } finally {
      first.resolve();
      second.resolve();
    }
  });

  it("CM1 does not suppress a floating nested rejection", async () => {
    const m = manager({
      allowedNames: ["bad"],
      call: async () => {
        throw new Error("floating nested failure");
      },
    });
    const result = await m.exec({
      code: 'tools.bad({}); return "false success";',
      uses: ["bad"],
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("floating nested failure");
  });

  it.each([
    'try { await tools.bad({}); } catch {} return "caught";',
    'await tools.bad({}).catch(() => 1); return "caught";',
    'await Promise.allSettled([tools.bad({}), tools.good({})]); return "caught";',
    'await Promise.race([tools.good({}), tools.bad({})]).catch(() => 1); return "caught";',
  ])(
    "CM1 preserves caught rejection and Promise composition: %s",
    async (code) => {
      const m = manager({
        allowedNames: ["bad", "good"],
        call: async (name) => {
          if (name === "bad") throw new Error("expected");
          return 1;
        },
      });
      const result = await m.exec({ code, uses: ["bad", "good"] });
      expect(result.status).toBe("completed");
      expect(result.result).toBe("caught");
    },
  );

  it("CM1 cancels unsent effects on failure behind an abort-ignoring dispatch", async () => {
    const held = gate<void>();
    const invoked = gate<void>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const adapters = new CodeModeAdapters({
      approvalMode: "always",
      applyPatch: {
        definition: {
          ...APPLY_PATCH_TOOL_DEFINITION,
          execute: async (_id, _args, abort) => {
            calls++;
            signal = abort;
            invoked.resolve();
            await held.promise;
            return { content: [], details: { committed: true } };
          },
        },
      },
    });
    const m = manager(adapters, { terminationWaitMs: 100 });
    try {
      const start = await m.exec({
        code: 'tools.apply_patch({patch:"one"}); tools.apply_patch({patch:"two"}); throw new Error("failed program");',
        uses: ["apply_patch"],
        context: { cwd: process.cwd() },
      });
      await invoked.promise;
      expect(start.status).toBe("failed");
      expect(start.unknownOutcome).toBe(true);
      expect(signal?.aborted).toBe(true);
      held.resolve();
      await pause(30);
      expect(calls).toBe(1);
    } finally {
      held.resolve();
    }
  });

  it("CM2 recovers unread terminal UTF-8 output after releasing the handle", async () => {
    const m = manager({ allowedNames: [], call: async () => undefined });
    const expected = "初🙂末".repeat(1500) + "\n";
    const result = await terminal(
      m,
      await m.exec({
        code: `print(${JSON.stringify(expected.slice(0, -1))});`,
        maxOutputBytes: 1024,
      }),
    );
    expect(result.truncated).toBe(true);
    const recovery = result.recovery!.output!;
    expect(recovery?.state).toBe("complete");
    expect(await readFile(recovery.path!, "utf8")).toBe(expected);
    await expect(m.wait({ cellId: result.cellId })).rejects.toMatchObject({
      code: "stale-cell",
    });
  });

  it("CM6 serializes terminal observations without duplicating the result", async () => {
    const held = gate<void>();
    const m = manager({ allowedNames: ["hold"], call: () => held.promise });
    try {
      const start = await m.exec({
        code: "await tools.hold({}); return 42;",
        uses: ["hold"],
        yieldTimeMs: 0,
      });
      const reads = [
        m.wait({ cellId: start.cellId }),
        m.wait({ cellId: start.cellId }),
      ];
      const all = Promise.allSettled(reads);
      held.resolve();
      const results = await all;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { code: "stale-cell" },
      });
    } finally {
      held.resolve();
    }
  });

  it.each(
    ["completed", "failed", "failed-effect"].flatMap((outcome) =>
      ["wait", "terminate", "pre-abort", "mid-abort", "failed-close"].map(
        (control) => ({ outcome, control }),
      ),
    ),
  )(
    "R12 $outcome preserves its known result during $control before worker exit",
    async ({ outcome, control }) => {
      const ready = gate<void>();
      const effect = gate<void>();
      const shutdown = gate<void>();
      const publishing = gate<void>();
      const releasePublication = gate<void>();
      const owner = new ExecutionOutputOwner();
      let worker: Worker | undefined;
      const post = Worker.prototype.postMessage;
      const shutdownGate = vi
        .spyOn(Worker.prototype, "postMessage")
        .mockImplementation(function (this: Worker, message, ...args) {
          if (message?.type === "shutdown") {
            worker = this;
            shutdown.resolve();
            return;
          }
          return post.call(this, message, ...args);
        });
      let calls = 0;
      const m = manager(
        {
          allowedNames: ["ready", "effect"],
          call: (name) => {
            if (name === "ready") return ready.promise;
            calls++;
            return effect.promise;
          },
        },
        {
          outputOwner: owner,
          terminationWaitMs: 20,
          shutdownGraceMs: HELD_LIVE_GRACE_MS,
        },
      );
      let refused: ReturnType<typeof vi.spyOn> | undefined;
      let available: ReturnType<typeof vi.spyOn> | undefined;
      let observations:
        | Promise<PromiseSettledResult<CodeModeCellResult>[]>
        | undefined;
      try {
        const first = await m.exec({
          code:
            "await tools.ready({}); " +
            (outcome === "completed"
              ? "return 7;"
              : (outcome === "failed-effect" ? "tools.effect({}); " : "") +
                'throw new Error("known failure");'),
          uses: ["ready", "effect"],
          yieldTimeMs: 0,
        });
        ready.resolve();
        // handleDone has set terminal/result and finished capture before this
        // real host shutdown packet. Worker liveness remains independently held.
        await shutdown.promise;
        expect(worker).toBeDefined();
        refused = vi
          .spyOn(worker!, "terminate")
          .mockRejectedValue(new Error("cleanup refused fixture"));
        if (control === "failed-close") {
          await expect(m.close()).rejects.toMatchObject({
            code: "cleanup-incomplete",
          });
          expect(refused).toHaveBeenCalledTimes(1);
          refused.mockClear();
        }
        const controller = new AbortController();
        if (control === "pre-abort") controller.abort();
        if (control === "mid-abort") {
          const isAvailable = owner.isAvailable.bind(owner);
          available = vi
            .spyOn(owner, "isAvailable")
            .mockImplementationOnce(async (path) => {
              publishing.resolve();
              await releasePublication.promise;
              return isAvailable(path);
            });
        }
        const read = m.wait(
          { cellId: first.cellId, terminate: control === "terminate" },
          controller.signal,
        );
        // Queue a second destructive observation before the first can release.
        observations = Promise.allSettled([
          read,
          m.wait({ cellId: first.cellId }),
        ]);
        if (control === "mid-abort") {
          await publishing.promise;
          controller.abort();
          releasePublication.resolve();
        }
        const results = await observations;
        expect(results[0].status).toBe("fulfilled");
        expect(results[1]).toMatchObject({
          status: "rejected",
          reason: { code: "stale-cell" },
        });
        const result = (
          results[0] as PromiseFulfilledResult<CodeModeCellResult>
        ).value;
        expect(result.status).toBe(
          outcome === "completed" ? "completed" : "failed",
        );
        expect(result.result).toBe(outcome === "completed" ? 7 : undefined);
        expect(result.error).toBe(
          outcome === "completed" ? undefined : "known failure",
        );
        expect(result.unknownOutcome).toBe(
          outcome === "failed-effect" ? true : undefined,
        );
        expect(result.effects?.unsettled).toBe(
          outcome === "failed-effect" ? 1 : 0,
        );
        expect(calls).toBe(outcome === "failed-effect" ? 1 : 0);
        expect(refused).not.toHaveBeenCalled();
        expect(m.hasCell(first.cellId)).toBe(false);
        // Delivery retires control, not ownership. Low-level close must still
        // try this worker, without replacing its logical success/failure.
        await expect(m.close()).rejects.toMatchObject({
          code: "cleanup-incomplete",
        });
        expect(refused).toHaveBeenCalledTimes(1);
        refused.mockRestore();
        refused = undefined;
        effect.resolve();
        restoreStopConfirmationWindow(m);
        await m.close();
        expect(worker!.threadId).toBe(-1);
      } finally {
        ready.resolve();
        effect.resolve();
        releasePublication.resolve();
        refused?.mockRestore();
        available?.mockRestore();
        shutdownGate.mockRestore();
        // Rescue only the worker owned by this case, even on a failed assertion.
        if (worker) await worker.terminate();
        await observations;
        await m.close();
        await owner.close();
      }
    },
  );

  // R12 controls land after the terminal publication. These land after done
  // but before publication ends, while the worker neither exits nor stops.
  it.each(
    ["completed", "failed", "failed-effect"].flatMap((outcome) =>
      ["terminate", "pre-abort", "mid-abort", "failed-close"].map(
        (control) => ({ outcome, control }),
      ),
    ),
  )(
    "PD-1 R1 $outcome keeps its known result when $control lands after done, before publication ends",
    async ({ outcome, control }) => {
      const ready = gate<void>();
      const effect = gate<void>();
      const { owner, entered, release } = holdPublication();
      const live = keepWorkerLive();
      let calls = 0;
      const m = manager(
        {
          allowedNames: ["ready", "effect"],
          call: (name) => {
            if (name === "ready") return ready.promise;
            calls++;
            return effect.promise;
          },
        },
        {
          outputOwner: owner,
          terminationWaitMs: 20,
          shutdownGraceMs: HELD_LIVE_GRACE_MS,
        },
      );
      const watches: { restore(): void }[] = [];
      let refused: ReturnType<typeof vi.spyOn> | undefined;
      let reads:
        | Promise<PromiseSettledResult<CodeModeCellResult>[]>
        | undefined;
      try {
        const first = await m.exec({
          code:
            "await tools.ready({}); " +
            (outcome === "completed"
              ? "return 7;"
              : (outcome === "failed-effect" ? "tools.effect({}); " : "") +
                'throw new Error("known failure");'),
          uses: ["ready", "effect"],
          yieldTimeMs: 0,
        });
        ready.resolve();
        // done arrived: the captures are finishing, and their file closes are
        // held. The worker ignores shutdown and refuses to stop.
        await entered;
        refused = vi
          .spyOn(live.worker()!, "terminate")
          .mockRejectedValue(new Error("stop refused fixture"));
        const exitWait = watchStep(m, "waitForExit");
        watches.push(exitWait);
        const controller = new AbortController();
        if (control === "pre-abort") controller.abort();
        const readTwice = () =>
          Promise.allSettled([
            m.wait(
              {
                cellId: first.cellId,
                terminate: control === "terminate",
                yieldTimeMs: INNER_BUDGET_MS,
              },
              controller.signal,
            ),
            // A second destructive observation, queued behind the first.
            m.wait({ cellId: first.cellId }),
          ]);
        let closeError: unknown;
        if (control === "failed-close") {
          const closing = m.close().then(
            () => undefined,
            (error: unknown) => error,
          );
          // Release only once the stop's exit wait has ended unconfirmed.
          await exitWait.returned;
          release();
          closeError = await closing;
          reads = readTwice();
        } else {
          const polling =
            control === "mid-abort" ? watchStep(m, "waitForWake") : undefined;
          if (polling) watches.push(polling);
          reads = readTwice();
          if (polling) {
            await polling.entered;
            controller.abort();
          }
          await exitWait.returned;
          release();
        }
        const [read, second] = await reads;
        expect(read.status).toBe("fulfilled");
        const result = (read as PromiseFulfilledResult<CodeModeCellResult>)
          .value;
        expect({
          closeError,
          status: result.status,
          result: result.result,
          error: result.error,
          unknownOutcome: result.unknownOutcome,
          unsettled: result.effects?.unsettled,
          dispatched: calls,
          stops: refused.mock.calls.length,
          retained: m.hasCell(first.cellId),
          second,
        }).toEqual({
          closeError:
            control === "failed-close"
              ? new CodeModeError(
                  "cleanup-incomplete",
                  `Code Mode cleanup is unconfirmed for ${first.cellId}; owned work is retained. Completed effects are not rolled back.`,
                )
              : undefined,
          status: outcome === "completed" ? "completed" : "failed",
          result: outcome === "completed" ? 7 : undefined,
          error: outcome === "completed" ? undefined : "known failure",
          unknownOutcome: outcome === "failed-effect" ? true : undefined,
          unsettled: outcome === "failed-effect" ? 1 : 0,
          dispatched: outcome === "failed-effect" ? 1 : 0,
          stops: 1,
          retained: false,
          second: { status: "rejected", reason: staleCell(first.cellId) },
        });
      } finally {
        release();
        ready.resolve();
        effect.resolve();
        for (const watch of watches) watch.restore();
        refused?.mockRestore();
        live.restore();
        // Rescue only this case's worker, even after a failed assertion.
        await live.worker()?.terminate();
        await reads;
        await m.close();
        await owner.close();
      }
    },
  );

  it("PD-1 R1 a stop whose exit wait ends after done arrived returns the known result", async () => {
    const done = holdDone();
    const { owner, entered, release } = holdPublication();
    const m = manager(
      { allowedNames: [], call: async () => undefined },
      {
        outputOwner: owner,
        terminationWaitMs: 20,
        shutdownGraceMs: HELD_LIVE_GRACE_MS,
      },
    );
    const watches: { restore(): void }[] = [];
    let worker: Worker | undefined;
    let refused: ReturnType<typeof vi.spyOn> | undefined;
    let stop: Promise<CodeModeCellResult> | undefined;
    try {
      const first = await m.exec({ code: "return 7;", yieldTimeMs: 0 });
      worker = await done.finished;
      refused = vi
        .spyOn(worker, "terminate")
        .mockRejectedValue(new Error("stop refused fixture"));
      const exitWait = watchStep(m, "waitForExit");
      watches.push(exitWait);
      stop = m.wait({
        cellId: first.cellId,
        terminate: true,
        yieldTimeMs: INNER_BUDGET_MS,
      });
      // The stop lands first; done arrives while it waits for the exit.
      await exitWait.entered;
      done.deliver();
      await entered;
      await exitWait.returned;
      const doneAtWindowEnd = doneReceived(m, first.cellId);
      release();
      const result = await stop;
      expect({
        doneAtWindowEnd,
        status: result.status,
        result: result.result,
        error: result.error,
        unknownOutcome: result.unknownOutcome,
        stops: refused.mock.calls.length,
        retained: m.hasCell(first.cellId),
      }).toEqual({
        doneAtWindowEnd: true,
        status: "completed",
        result: 7,
        error: undefined,
        unknownOutcome: undefined,
        stops: 1,
        retained: false,
      });
    } finally {
      release();
      done.restore();
      for (const watch of watches) watch.restore();
      refused?.mockRestore();
      await worker?.terminate();
      await Promise.allSettled([stop]);
      await m.close();
      await owner.close();
    }
  });

  it("PD-1 R1 a read that snapshots just after a stop lands on a finished program reports no worker-only uncertainty", async () => {
    const ready = gate<void>();
    const { owner, entered, release } = holdPublication();
    const live = keepWorkerLive();
    const m = manager(
      { allowedNames: ["ready"], call: () => ready.promise },
      {
        outputOwner: owner,
        terminationWaitMs: 20,
        shutdownGraceMs: HELD_LIVE_GRACE_MS,
      },
    );
    const watches: { restore(): void }[] = [];
    let refused: ReturnType<typeof vi.spyOn> | undefined;
    let read: Promise<CodeModeCellResult> | undefined;
    let stop: Promise<CodeModeCellResult> | undefined;
    try {
      const first = await m.exec({
        code: "await tools.ready({}); return 7;",
        uses: ["ready"],
        yieldTimeMs: 0,
      });
      ready.resolve();
      await entered;
      refused = vi
        .spyOn(live.worker()!, "terminate")
        .mockRejectedValue(new Error("stop refused fixture"));
      const exitWait = watchStep(m, "waitForExit");
      const publishing = watchPublish();
      // The stop lands at the read's buildResult entry, before the original
      // takes its snapshot; the stop sets terminateRequested synchronously.
      // The read has already passed its `await cell.termination`, so the
      // stop's attempt cannot hold it back. In production this is a stop that
      // lands in the microtask after that await. flags[0] records what the
      // snapshot saw.
      const results = watchResults(m, () => {
        stop = m.wait({
          cellId: first.cellId,
          terminate: true,
          yieldTimeMs: INNER_BUDGET_MS,
        });
      });
      watches.push(exitWait, publishing, results);
      read = m.wait({ cellId: first.cellId, yieldTimeMs: 0 });
      await publishing.entered;
      await exitWait.returned;
      release();
      const during = await read;
      const stopped = await stop!;
      expect({
        atReadSnapshot: results.flags[0],
        read: {
          status: during.status,
          error: during.error,
          unknownOutcome: during.unknownOutcome,
        },
        stop: {
          status: stopped.status,
          result: stopped.result,
          error: stopped.error,
          unknownOutcome: stopped.unknownOutcome,
        },
        stops: refused.mock.calls.length,
        retained: m.hasCell(first.cellId),
      }).toEqual({
        atReadSnapshot: {
          doneReceived: true,
          terminateRequested: true,
          terminal: false,
        },
        read: {
          status: "running",
          error: undefined,
          unknownOutcome: undefined,
        },
        stop: {
          status: "completed",
          result: 7,
          error: undefined,
          unknownOutcome: undefined,
        },
        stops: 1,
        retained: false,
      });
    } finally {
      release();
      ready.resolve();
      for (const watch of watches) watch.restore();
      refused?.mockRestore();
      live.restore();
      await live.worker()?.terminate();
      await Promise.allSettled([read, stop]);
      await m.close();
      await owner.close();
    }
  });

  const R2_READS = {
    // Matrix: bounded uncertainty and a retained handle before done.
    window: {
      status: "terminated",
      result: undefined,
      error: STOP_UNCONFIRMED,
      unknownOutcome: true,
      retained: true,
    },
    // Taken after done while publication is held: the stop has ended.
    publication: {
      status: "running",
      result: undefined,
      error: undefined,
      unknownOutcome: undefined,
      retained: true,
    },
    terminal: {
      status: "completed",
      result: 7,
      error: undefined,
      unknownOutcome: undefined,
      retained: false,
    },
  };
  it.each(["window", "publication", "terminal"] as const)(
    "PD-1 R2 done overtakes an unconfirmed stop: the %s read",
    async (read) => {
      const done = holdDone();
      const { owner, entered, release } = holdPublication();
      const m = manager(
        { allowedNames: [], call: async () => undefined },
        { outputOwner: owner, terminationWaitMs: 20 },
      );
      let worker: Worker | undefined;
      let refused: ReturnType<typeof vi.spyOn> | undefined;
      let publishing: { restore(): void } | undefined;
      let during: Promise<CodeModeCellResult> | undefined;
      try {
        const first = await m.exec({ code: "return 7;", yieldTimeMs: 0 });
        worker = await done.finished;
        refused = vi
          .spyOn(worker, "terminate")
          .mockRejectedValue(new Error("stop refused fixture"));
        const view = (result: CodeModeCellResult) => ({
          status: result.status,
          result: result.result,
          error: result.error,
          unknownOutcome: result.unknownOutcome,
          retained: m.hasCell(first.cellId),
        });
        const seen: Partial<Record<typeof read, unknown>> = {};
        // The stop's exit wait ends before the manager sees done.
        seen.window = view(
          await m.wait({
            cellId: first.cellId,
            terminate: true,
            yieldTimeMs: INNER_BUDGET_MS,
          }),
        );
        done.deliver();
        await entered;
        const watch = watchPublish();
        publishing = watch;
        // The read snapshots before it publishes, and publishing waits behind
        // the held closes: it returns only after the release.
        during = m.wait({ cellId: first.cellId, yieldTimeMs: 50 });
        await watch.entered;
        release();
        seen.publication = view(await during);
        seen.terminal = view(
          await m.wait({ cellId: first.cellId, yieldTimeMs: INNER_BUDGET_MS }),
        );
        expect(seen[read]).toEqual(R2_READS[read]);
      } finally {
        release();
        done.restore();
        publishing?.restore();
        refused?.mockRestore();
        await worker?.terminate();
        await Promise.allSettled([during]);
        await m.close();
        await owner.close();
      }
    },
  );

  it("PD-1 R2 done overtakes an unconfirmed stop: a read waiting through held publication returns the result", async () => {
    const done = holdDone();
    const { owner, entered, release } = holdPublication();
    const m = manager(
      { allowedNames: [], call: async () => undefined },
      { outputOwner: owner, terminationWaitMs: 20 },
    );
    const watches: { restore(): void }[] = [];
    let worker: Worker | undefined;
    let refused: ReturnType<typeof vi.spyOn> | undefined;
    let read: Promise<CodeModeCellResult> | undefined;
    try {
      const first = await m.exec({ code: "return 7;", yieldTimeMs: 0 });
      worker = await done.finished;
      refused = vi
        .spyOn(worker, "terminate")
        .mockRejectedValue(new Error("stop refused fixture"));
      const window = await m.wait({
        cellId: first.cellId,
        terminate: true,
        yieldTimeMs: INNER_BUDGET_MS,
      });
      done.deliver();
      await entered;
      const polling = watchStep(m, "waitForWake");
      const publishing = watchPublish();
      watches.push(polling, publishing);
      read = m.wait({ cellId: first.cellId, yieldTimeMs: INNER_BUDGET_MS });
      // Release once the read has chosen: to wait for the program, or to
      // publish a snapshot at once as a sticky stop would make it do.
      await Promise.race([polling.entered, publishing.entered]);
      release();
      const result = await read;
      expect({
        window: window.status,
        status: result.status,
        result: result.result,
        error: result.error,
        unknownOutcome: result.unknownOutcome,
        retained: m.hasCell(first.cellId),
      }).toEqual({
        window: "terminated",
        status: "completed",
        result: 7,
        error: undefined,
        unknownOutcome: undefined,
        retained: false,
      });
    } finally {
      release();
      done.restore();
      for (const watch of watches) watch.restore();
      refused?.mockRestore();
      await worker?.terminate();
      await Promise.allSettled([read]);
      await m.close();
      await owner.close();
    }
  });

  // PD-2: a finished worker still live shutdownGraceMs after the host's
  // shutdown is terminated once; one that exits on its own is left alone.
  const RECLAIM_GRACE_MS = 100;
  // A contended worker exit can outlast 100 ms. Tests that time the grace run
  // the reclaim timer on a fake clock, which moves only when the test moves it
  // after an observed event.
  const useReclaimClock = () =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  it("PD-2 R4 terminates a finished worker that ignores shutdown once, when the grace ends", async () => {
    const live = keepWorkerLive();
    const stops = watchStops();
    const m = manager(
      { allowedNames: [], call: async () => undefined },
      { shutdownGraceMs: RECLAIM_GRACE_MS },
    );
    try {
      useReclaimClock();
      // The terminal read retires the handle; the worker swallowed shutdown.
      const read = await m.exec({
        code: "return 7;",
        yieldTimeMs: INNER_BUDGET_MS,
      });
      const worker = live.worker()!;
      // Look one tick before the grace ends, then as it ends.
      vi.advanceTimersByTime(RECLAIM_GRACE_MS - 1);
      const beforeGraceEnds = stops.count(worker);
      vi.advanceTimersByTime(1);
      vi.useRealTimers();
      const exited = await exits(worker);
      expect({
        status: read.status,
        result: read.result,
        retained: m.hasCell(read.cellId),
        beforeGraceEnds,
        exited,
        stops: await stops.results(worker),
      }).toEqual({
        status: "completed",
        result: 7,
        retained: false,
        beforeGraceEnds: 0,
        exited: true,
        stops: [1],
      });
    } finally {
      vi.useRealTimers();
      stops.restore();
      live.restore();
      // Rescue only this case's worker, even after a failed assertion.
      await live.worker()?.terminate();
      await m.close();
    }
  });

  it("PD-2 R4 terminates a finished worker that a post-done callback holds past shutdown", async () => {
    const { owner, entered, release } = holdPublication();
    const stops = watchStops();
    const replyReady = gate<string>();
    const replyTag = "pd2-callback-control";
    const control = new Int32Array(new SharedArrayBuffer(8));
    const m = manager(
      { allowedNames: ["callback_gate"], call: () => replyReady.promise },
      { outputOwner: owner, shutdownGraceMs: RECLAIM_GRACE_MS },
    );
    let worker: Worker | undefined;
    let reply: ReturnType<typeof vi.spyOn> | undefined;
    let injected = 0;
    try {
      const first = await m.exec({
        code: `
          const control = new Int32Array(await tools.callback_gate({}));
          Atomics.waitAsync(control, 0, 0).value.then(() => {
            Atomics.store(control, 1, 1);
            for (;;) {}
          });
          return 7;
        `,
        uses: ["callback_gate"],
        yieldTimeMs: 0,
      });
      worker = onlyWorker(m);
      const post = worker.postMessage.bind(worker);
      // Inject a test-only shared gate into this owned worker's one tagged
      // reply, after the production JSON boundary. No production protocol or
      // other worker is changed. Hold the reply until this intercept exists.
      reply = vi
        .spyOn(worker, "postMessage")
        .mockImplementation((message, ...args) => {
          if (
            message?.type === "call-settled" &&
            message.callId === 1 &&
            message.ok === true &&
            message.value === replyTag &&
            injected === 0
          ) {
            injected++;
            return post({ ...message, value: control.buffer }, ...args);
          }
          return post(message, ...args);
        });
      replyReady.resolve(replyTag);
      // done arrived: the captures are finishing and their file closes are held.
      await entered;
      expect(doneReceived(m, first.cellId)).toBe(true);
      expect(injected).toBe(1);
      expect(Atomics.load(control, 1)).toBe(0);
      // A timer created during serialization can fire before done under load.
      // Only the observed done/publication event may release this callback.
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
      await vi.waitFor(() => expect(Atomics.load(control, 1)).toBe(1), {
        timeout: INNER_BUDGET_MS,
        interval: 5,
      });
      // End publication, after which the host posts shutdown, only once the
      // callback holds the worker's event loop.
      release();
      const read = await m.wait({
        cellId: first.cellId,
        yieldTimeMs: INNER_BUDGET_MS,
      });
      const exited = await exits(worker);
      expect({
        status: read.status,
        result: read.result,
        retained: m.hasCell(first.cellId),
        exited,
        stops: await stops.results(worker),
      }).toEqual({
        status: "completed",
        result: 7,
        retained: false,
        exited: true,
        stops: [1],
      });
    } finally {
      replyReady.resolve(replyTag);
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
      release();
      reply?.mockRestore();
      stops.restore();
      await worker?.terminate();
      await m.close();
      await owner.close();
    }
  });

  it("PD-2 R4 never terminates a finished worker that exits on shutdown", async () => {
    const ready = gate<void>();
    const stops = watchStops();
    const m = manager(
      { allowedNames: ["ready"], call: () => ready.promise },
      { shutdownGraceMs: RECLAIM_GRACE_MS },
    );
    let worker: Worker | undefined;
    try {
      const first = await m.exec({
        code: "await tools.ready({}); return 7;",
        uses: ["ready"],
        yieldTimeMs: 0,
      });
      worker = onlyWorker(m);
      const exit = new Promise<number>((resolve) =>
        worker!.once("exit", resolve),
      );
      useReclaimClock();
      ready.resolve();
      const read = await m.wait({
        cellId: first.cellId,
        yieldTimeMs: INNER_BUDGET_MS,
      });
      const exitCode = await exit;
      // A terminate() call that never comes is no event to wait for, so this
      // check needs a window. The worker has exited; now let three graces pass
      // on the clock read by the reclaim timer that shutdown armed.
      vi.advanceTimersByTime(3 * RECLAIM_GRACE_MS);
      vi.useRealTimers();
      expect({
        status: read.status,
        result: read.result,
        retained: m.hasCell(first.cellId),
        exitCode,
        stops: await stops.results(worker),
      }).toEqual({
        status: "completed",
        result: 7,
        retained: false,
        exitCode: 0,
        stops: [],
      });
    } finally {
      vi.useRealTimers();
      ready.resolve();
      stops.restore();
      await worker?.terminate();
      await m.close();
    }
  });

  it("PD-2 R4 counts the grace from shutdown, reclaims an unread cell's worker once and never retries", async () => {
    const ready = gate<void>();
    const { owner, entered, release } = holdPublication();
    const live = keepWorkerLive();
    const m = manager(
      { allowedNames: ["ready"], call: () => ready.promise },
      { outputOwner: owner, shutdownGraceMs: RECLAIM_GRACE_MS },
    );
    let worker: Worker | undefined;
    let refused: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const first = await m.exec({
        code: "await tools.ready({}); return 7;",
        uses: ["ready"],
        yieldTimeMs: 0,
      });
      worker = onlyWorker(m);
      // The reclaim's one attempt is refused, so a retry would have to call
      // again; the worker ignores shutdown throughout.
      refused = vi
        .spyOn(worker, "terminate")
        .mockRejectedValue(new Error("stop refused fixture"));
      const calls = () => refused!.mock.calls.length;
      useReclaimClock();
      ready.resolve();
      // done arrived and publication is held, so shutdown is not posted and the
      // grace has not started: three graces pass without a terminate() call.
      await entered;
      vi.advanceTimersByTime(3 * RECLAIM_GRACE_MS);
      const whilePublishing = calls();
      release();
      // Shutdown arms the timer. Nothing reads the cell, so its handle stays.
      await live.shutdown;
      const unread = m.hasCell(first.cellId);
      vi.advanceTimersByTime(RECLAIM_GRACE_MS - 1);
      const beforeGraceEnds = calls();
      vi.advanceTimersByTime(1);
      const atGraceEnd = calls();
      // Let the refused attempt settle, then give a retry many graces to run.
      await Promise.allSettled(
        refused.mock.results.map(
          (call: { value: unknown }) => call.value as Promise<unknown>,
        ),
      );
      vi.advanceTimersByTime(10 * RECLAIM_GRACE_MS);
      const afterGraces = calls();
      vi.useRealTimers();
      const read = await m.wait({
        cellId: first.cellId,
        yieldTimeMs: INNER_BUDGET_MS,
      });
      expect({
        whilePublishing,
        unread,
        beforeGraceEnds,
        atGraceEnd,
        afterGraces,
        status: read.status,
        result: read.result,
        retained: m.hasCell(first.cellId),
      }).toEqual({
        whilePublishing: 0,
        unread: true,
        beforeGraceEnds: 0,
        atGraceEnd: 1,
        afterGraces: 1,
        status: "completed",
        result: 7,
        retained: false,
      });
    } finally {
      vi.useRealTimers();
      release();
      ready.resolve();
      refused?.mockRestore();
      live.restore();
      // Rescue only this case's worker, even after a failed assertion.
      await worker?.terminate();
      await m.close();
      await owner.close();
    }
  });

  it("CM7 keeps deep structured JSON without pretty-print expansion", async () => {
    const m = manager({ allowedNames: [], call: async () => undefined });
    const result = await m.exec({
      code: "let v = 1; for(let i=0;i<500;i++) v={x:v}; return v;",
    });
    expect(result.status).toBe("completed");
    expect(typeof result.result).toBe("object");
    expect(Buffer.byteLength(formatCodeModeResult(result))).toBeLessThan(12000);
  });

  it("CM7 exposes clipped error recovery including the final reread guidance", async () => {
    const text = "committed path; ".repeat(1000) + "REREAD_UNKNOWN_PATHS";
    const m = manager({
      allowedNames: ["bad"],
      call: async () => {
        throw new Error(text);
      },
    });
    const result = await m.exec({
      code: "await tools.bad({});",
      uses: ["bad"],
    });
    expect(result.status).toBe("failed");
    expect(result.truncated).toBe(true);
    const recovery = result.recovery!.error!;
    expect(recovery?.state).toBe("complete");
    expect(await readFile(recovery.path!, "utf8")).toContain(text);
  });
});
