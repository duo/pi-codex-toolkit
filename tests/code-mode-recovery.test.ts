import { mkdtemp, open, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_MODE_ERROR_MAX_BYTES,
  CodeModeCellManager,
  type CellDispatcher,
  type CodeModeCellResult,
} from "../src/code-mode/manager.ts";
import {
  ExecutionOutputOwner,
  type ExecutionOutputCapture,
} from "../src/execution-output.ts";
import {
  CODE_MODE_RENDER_MAX_BYTES,
  formatCodeModeResult,
} from "../src/code-mode/tools.ts";
import {
  INNER_BUDGET_MS,
  TERMINAL_SETTLE_GRACE_MS,
} from "./fixtures/budgets.ts";
import { restoreStopConfirmationWindow } from "./fixtures/code-mode-stops.ts";
const managers: CodeModeCellManager[] = [];
const owners: ExecutionOutputOwner[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
  await Promise.all(owners.splice(0).map((o) => o.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function make(
  options: Partial<ConstructorParameters<typeof CodeModeCellManager>[0]> = {},
) {
  const m = new CodeModeCellManager({
    dispatcher: { allowedNames: [], call: async () => undefined },
    ...options,
  });
  managers.push(m);
  return m;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function terminal(m: CodeModeCellManager, r: CodeModeCellResult) {
  for (let n = 0; r.status === "running" && n < 100; n++)
    r = await m.wait({
      cellId: r.cellId,
      maxOutputBytes: 1024,
      yieldTimeMs: 1000,
    });
  expect(r.status).not.toBe("running");
  return r;
}

const REASON_ABORTED =
  "Cell terminated because the calling tool call was aborted.";
const REASON_REQUESTED = "Cell terminated by request.";
const STOP_UNCONFIRMED =
  "Worker termination is unconfirmed; keep the cell handle and wait/terminate again. No replay.";
const WORKER_ERROR = "worker failure 故障🙂";
// A worker sends its error in chunks of 8,192 UTF-16 units and waits for each
// append. This error spans four chunks of numbered 63-character lines.
const CHUNK_UNITS = 8192;
const STREAMED_ERROR = Array.from({ length: 500 }, (_, n) =>
  `error line ${String(n).padStart(4, "0")} `.padEnd(63, "-"),
).join("\n");
const THROW_STREAMED_ERROR = `throw new Error(${JSON.stringify(STREAMED_ERROR)});`;

/** Holds this owner's nth file write until the test releases it. */
function holdWrite(nth: number) {
  const entered = gate();
  const released = gate();
  let writes = 0;
  const owner = new ExecutionOutputOwner({
    ioTimeoutMs: INNER_BUDGET_MS,
    openFile: async (path) => {
      const file = await open(path, "wx", 0o600);
      return {
        write: async (buffer) => {
          if (++writes === nth) {
            entered.resolve();
            await released.promise;
          }
          return file.write(buffer);
        },
        close: () => file.close(),
      };
    },
  });
  owners.push(owner);
  return { owner, entered: entered.promise, release: released.resolve };
}
/**
 * Withholds the worker's terminal packet. The worker sends it only after every
 * error chunk was captured, and stays live afterwards.
 */
function withholdDone() {
  const done = gate();
  const emit = Worker.prototype.emit;
  const packets = vi
    .spyOn(Worker.prototype, "emit")
    .mockImplementation(function (this: Worker, event, ...args) {
      if (event === "message" && args[0]?.type === "done") {
        done.resolve();
        return true;
      }
      return emit.call(this, event, ...args);
    });
  return { done: done.promise, restore: () => packets.mockRestore() };
}
function onlyWorker(m: CodeModeCellManager): Worker {
  const cells = [...(m as unknown as { owned: Set<{ worker: Worker }> }).owned];
  expect(cells).toHaveLength(1);
  return cells[0].worker;
}
const exitOf = (worker: Worker) =>
  new Promise<void>((resolve) => worker.once("exit", () => resolve()));
// result.error beside a host note: the head of an ASCII streamed error, one
// "\n" and the note, within the 4 KiB error bound.
const beside = (streamed: string, note: string) =>
  `${streamed.slice(0, CODE_MODE_ERROR_MAX_BYTES - Buffer.byteLength(note) - 1)}\n${note}`;
// The text after the last line break: the host note, when one is shown.
const noteOf = (error: string | undefined) =>
  error?.slice(error.lastIndexOf("\n") + 1);

describe("Code Mode execution-output recovery", () => {
  it("CM2 captures synchronous print bursts before worker loss, across UTF-8 boundaries", async () => {
    const m = make({ outputBufferBytes: 2048 });
    const r = await terminal(
      m,
      await m.exec({
        code: 'for(let i=0;i<800;i++) print(i+":"+"🙂中".repeat(100)); return "late";',
        maxOutputBytes: 1024,
      }),
    );
    const expected = Array.from(
      { length: 800 },
      (_, i) => `${i}:` + "🙂中".repeat(100) + "\n",
    ).join("");
    expect(r.recovery?.output?.state).toBe("complete");
    expect(await readFile(r.recovery!.output!.path!, "utf8")).toBe(expected);
    expect(r.recovery?.output?.bytes).toBe(Buffer.byteLength(expected));
    expect(formatCodeModeResult(r)).not.toContain("�");
  });
  it("recovers complete serialized selected results, not only their host prefix", async () => {
    const m = make();
    const r = await terminal(
      m,
      await m.exec({
        code: 'return {first:"初", body:"🙂".repeat(20000), last:"末"};',
      }),
    );
    expect(r.clipping?.result).toBe(true);
    expect(r.recovery?.result?.state).toBe("complete");
    const json = await readFile(r.recovery!.result!.path!, "utf8");
    expect(JSON.parse(json)).toEqual({
      first: "初",
      body: "🙂".repeat(20000),
      last: "末",
    });
    expect(await readFile(r.recovery!.result!.path!, "utf8")).toBe(json);
    expect(Buffer.byteLength(formatCodeModeResult(r))).toBeLessThanOrEqual(
      CODE_MODE_RENDER_MAX_BYTES,
    );
  });
  it("does not create files for small fully delivered output/result/error", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-small-code-"));
    roots.push(root);
    const owner = new ExecutionOutputOwner({ temporaryRoot: root });
    owners.push(owner);
    const m = make({
      outputOwner: owner,
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });
    const r = await m.exec({ code: 'print("hello"); return {ok: true};' });
    expect(r.status).toBe("completed");
    expect(r.recovery).toBeUndefined();
    const failed = await m.exec({ code: 'throw new Error("expected");' });
    expect(failed.status).toBe("failed");
    expect(failed.recovery).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });
  it("withholds producer credits until actual capture writes settle", async () => {
    const entered = gate();
    const release = gate();
    let afterPrint = 0;
    let writes = 0;
    const owner = new ExecutionOutputOwner({
      ioTimeoutMs: 2000,
      openFile: async (path) => {
        const file = await open(path, "wx", 0o600);
        return {
          write: async (buffer) => {
            writes++;
            entered.resolve();
            await release.promise;
            return file.write(buffer);
          },
          close: () => file.close(),
        };
      },
    });
    owners.push(owner);
    const dispatcher: CellDispatcher = {
      allowedNames: ["after"],
      call: async () => {
        afterPrint++;
        return 1;
      },
    };
    const m = make({ outputOwner: owner, outputBufferBytes: 1024, dispatcher });
    const pending = m.exec({
      code: 'print("x".repeat(100000)); await tools.after({}); return 2;',
      uses: ["after"],
    });
    try {
      await entered.promise;
      await pause(30);
      expect(afterPrint).toBe(0);
      expect(writes).toBe(1);
      release.resolve();
      const r = await terminal(m, await pending);
      expect(afterPrint).toBe(1);
      expect(await readFile(r.recovery!.output!.path!, "utf8")).toBe(
        "x".repeat(100000) + "\n",
      );
    } finally {
      release.resolve();
      await pending;
    }
  });
  it("exposes I/O capture failure without blocking execution or claiming full recovery", async () => {
    const owner = new ExecutionOutputOwner({
      openFile: async () => {
        throw new Error("ENOSPC fixture");
      },
    });
    owners.push(owner);
    const m = make({ outputOwner: owner, outputBufferBytes: 1024 });
    const r = await terminal(
      m,
      await m.exec({
        code: 'print("x".repeat(10000)); return 42;',
        maxOutputBytes: 1024,
      }),
    );
    expect(r.result).toBe(42);
    expect(r.recovery?.output).toMatchObject({
      state: "unavailable",
      reason: "io-error",
      bytes: 10001,
    });
    expect(formatCodeModeResult(r)).toContain("unavailable");
  });
  it("keeps output paths across handle pruning and manager close with an injected owner", async () => {
    const owner = new ExecutionOutputOwner();
    owners.push(owner);
    const m = make({ outputOwner: owner, completedRetentionMs: 0 });
    const first = await m.exec({
      code: 'print("early"); return "late";',
      yieldTimeMs: 0,
    });
    const path = first.recovery!.output!.path!;
    // Pruning removes only a completed cell; wait for completion, not a sleep.
    await vi.waitFor(() => expect(m.runningCount).toBe(0), {
      timeout: INNER_BUDGET_MS,
      interval: 5,
    });
    await m.exec({ code: "return 2;" });
    await expect(m.wait({ cellId: first.cellId })).rejects.toMatchObject({
      code: "stale-cell",
    });
    await m.close();
    expect(await readFile(path, "utf8")).toBe("early\n");
    await owner.close();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not consume a terminal handle when the worker finishes during a running snapshot's publication", async () => {
    const entered = gate();
    const release = gate();
    const owner = new ExecutionOutputOwner({
      ioTimeoutMs: 2000,
      openFile: async (path) => {
        entered.resolve();
        await release.promise;
        return open(path, "wx", 0o600);
      },
    });
    owners.push(owner);
    const m = make({ outputOwner: owner });
    const pending = m.exec({
      code: 'return "terminal value";',
      yieldTimeMs: 0,
    });
    try {
      await entered.promise;
      await pause(50);
      release.resolve();
      const running = await pending;
      expect(running.status).toBe("running");
      const completed = await terminal(
        m,
        await m.wait({ cellId: running.cellId }),
      );
      expect(completed.result).toBe("terminal value");
    } finally {
      release.resolve();
      await pending;
    }
  });
  it("reports a removed recovery source rather than recreating or replaying it", async () => {
    const held = gate();
    const m = make({
      dispatcher: { allowedNames: ["hold"], call: () => held.promise },
    });
    try {
      const first = await m.exec({
        code: 'print("prefix"); await tools.hold({}); print("suffix");',
        uses: ["hold"],
        yieldTimeMs: 100,
      });
      await unlink(first.recovery!.output!.path!);
      held.resolve();
      const r = await terminal(m, await m.wait({ cellId: first.cellId }));
      expect(r.recovery?.output).toMatchObject({
        state: "unavailable",
        reason: "missing",
      });
    } finally {
      held.resolve();
    }
  });
  it("marks interrupted worker capture as partial, keeping prior evidence and no replay", async () => {
    const m = make();
    const first = await m.exec({
      code: 'print("before stop"); await new Promise(() => {});',
    });
    const r = await m.wait({ cellId: first.cellId, terminate: true });
    expect(r.status).toBe("terminated");
    expect(r.recovery?.output).toMatchObject({
      state: "partial",
      reason: "source-error",
    });
    expect(await readFile(r.recovery!.output!.path!, "utf8")).toBe(
      "before stop\n",
    );
    expect(r.error).toBe("Cell terminated by request.");
    expect(r.recovery?.error).toMatchObject({
      path: first.recovery!.error!.path,
      state: "partial",
      reason: "source-error",
      bytes: Buffer.byteLength(r.error!),
      capturedBytes: Buffer.byteLength(r.error!),
    });
    expect(await readFile(r.recovery!.error!.path!, "utf8")).toBe(r.error);
  });

  it.each(["aborted", "closed", "worker-error"] as const)(
    "R05 persists %s diagnostics in a previously published empty error file",
    async (reason) => {
      const owner = new ExecutionOutputOwner();
      owners.push(owner);
      const m = make({ outputOwner: owner });
      const first = await m.exec({
        code: "await new Promise(()=>{});",
        yieldTimeMs: 0,
      });
      const path = first.recovery!.error!.path!;
      expect(await readFile(path, "utf8")).toBe("");
      const controller = new AbortController();
      const observed = m.wait(
        { cellId: first.cellId, yieldTimeMs: 60000 },
        controller.signal,
      );
      let cleanup: Promise<unknown> | undefined;
      try {
        // Start the exclusive observer before close can retire the cell.
        await Promise.resolve();
        if (reason === "aborted") controller.abort();
        else if (reason === "closed") cleanup = m.close();
        else {
          const cell = [
            ...(m as unknown as { owned: Set<{ worker: Worker }> }).owned,
          ][0];
          cell.worker.emit("error", new Error("worker failure 故障🙂"));
          cleanup = cell.worker.terminate();
        }
        const result = await observed;
        await cleanup;
        const expected =
          reason === "aborted"
            ? "Cell terminated because the calling tool call was aborted."
            : reason === "closed"
              ? "Cell terminated because Code Mode was disabled or the session ended."
              : "worker failure 故障🙂";
        expect(result.error).toBe(expected);
        expect(result.recovery?.error).toMatchObject({
          path,
          state: "partial",
          reason: "source-error",
          bytes: Buffer.byteLength(expected),
          capturedBytes: Buffer.byteLength(expected),
        });
        expect(await readFile(path, "utf8")).toBe(expected);
        expect(result.recovery?.output?.state).toBe("partial");
        expect(result.recovery?.result?.state).toBe("partial");
      } finally {
        controller.abort();
        await observed;
        await cleanup;
      }
    },
  );

  it.each(["", "retained 前🙂 prefix"])(
    "R05 spills an unpublished interrupted error prefix %j before marking source failure",
    async (prefix) => {
      const done = gate();
      const emit = Worker.prototype.emit;
      const packets = vi
        .spyOn(Worker.prototype, "emit")
        .mockImplementation(function (this: Worker, event, ...args) {
          if (event === "message" && args[0]?.type === "done") {
            // Real worker capture has finished; withhold only its terminal
            // packet so abort interrupts an unpublished selected-error source.
            done.resolve();
            return true;
          }
          return emit.call(this, event, ...args);
        });
      const owner = new ExecutionOutputOwner();
      owners.push(owner);
      const captures: ExecutionOutputCapture[] = [];
      const create = owner.createCapture.bind(owner);
      const created = vi
        .spyOn(owner, "createCapture")
        .mockImplementation((options) => {
          const capture = create(options);
          captures.push(capture);
          return capture;
        });
      const m = make({ outputOwner: owner });
      const controller = new AbortController();
      const pending = m.exec(
        {
          code: prefix
            ? `throw new Error(${JSON.stringify(prefix)});`
            : "return undefined;",
          yieldTimeMs: 60000,
        },
        controller.signal,
      );
      try {
        await done.promise;
        expect(captures[2].needsRecovery).toBe(false);
        controller.abort();
        const result = await pending;
        expect(result.status).toBe("terminated");
        // A streamed error is kept once, then one "\n" and the stop reason.
        const expected = prefix
          ? `${prefix}\n${REASON_ABORTED}`
          : REASON_ABORTED;
        expect(result.error).toBe(expected);
        expect(result.recovery?.error).toMatchObject({
          state: "partial",
          reason: "source-error",
          bytes: Buffer.byteLength(expected),
          capturedBytes: Buffer.byteLength(expected),
        });
        expect(await readFile(result.recovery!.error!.path!, "utf8")).toBe(
          expected,
        );
        expect(result.recovery?.output).toMatchObject({
          state: "unavailable",
          reason: "source-error",
        });
        expect(result.recovery?.result).toMatchObject({
          state: "unavailable",
          reason: "source-error",
        });
        expect(m.hasCell(result.cellId)).toBe(false);
      } finally {
        controller.abort();
        packets.mockRestore();
        created.mockRestore();
        await pending;
      }
    },
  );

  it.each(["open", "write"] as const)(
    "R05 keeps %s failure sticky while offering the terminal diagnostic",
    async (fault) => {
      let writes = 0;
      const owner = new ExecutionOutputOwner({
        openFile: async (path) => {
          if (fault === "open") throw new Error("ENOSPC fixture");
          const file = await open(path, "wx", 0o600);
          return {
            write: async () => {
              writes++;
              throw new Error("write failure fixture");
            },
            close: () => file.close(),
          };
        },
      });
      owners.push(owner);
      const m = make({ outputOwner: owner });
      const first = await m.exec({
        code: "await new Promise(()=>{});",
        yieldTimeMs: 0,
      });
      const result = await m.wait({ cellId: first.cellId, terminate: true });
      expect(result.status).toBe("terminated");
      expect(result.error).toBe("Cell terminated by request.");
      expect(result.recovery?.error).toMatchObject({
        state: fault === "open" ? "unavailable" : "partial",
        reason: "io-error",
        bytes: Buffer.byteLength(result.error!),
        capturedBytes: 0,
      });
      if (fault === "write") {
        expect(writes).toBe(1);
        expect(await readFile(result.recovery!.error!.path!, "utf8")).toBe("");
      } else expect(result.recovery?.error?.path).toBeUndefined();
      expect(m.hasCell(first.cellId)).toBe(false);
      expect(m.runningCount).toBe(0);
    },
  );

  it("persists a streamed error once, then the abort reason, when a stop interrupts the stream", async () => {
    // Hold the first chunk's write and stop the cell. The write finishes only
    // after the worker exited, so no later chunk can arrive.
    const { owner, entered, release } = holdWrite(1);
    const m = make({ outputOwner: owner });
    const controller = new AbortController();
    const pending = m.exec(
      { code: THROW_STREAMED_ERROR, yieldTimeMs: INNER_BUDGET_MS },
      controller.signal,
    );
    try {
      await entered;
      const exited = exitOf(onlyWorker(m));
      controller.abort();
      await exited;
      release();
      const result = await pending;
      expect(result.status).toBe("terminated");
      const streamed = STREAMED_ERROR.slice(0, CHUNK_UNITS);
      const file = `${streamed}\n${REASON_ABORTED}`;
      expect({
        error: result.error,
        truncated: result.truncated,
        clipping: result.clipping,
        recovery: result.recovery?.error,
        file: await readFile(result.recovery!.error!.path!, "utf8"),
      }).toEqual({
        error: beside(streamed, REASON_ABORTED),
        truncated: true,
        clipping: { output: false, result: false, error: true },
        recovery: {
          state: "partial",
          path: expect.any(String),
          bytes: Buffer.byteLength(file),
          capturedBytes: Buffer.byteLength(file),
          reason: "source-error",
        },
        file,
      });
    } finally {
      release();
      controller.abort();
      await pending;
    }
  });

  it("persists and shows a worker error raised while the error streams", async () => {
    const { owner, entered, release } = holdWrite(1);
    const m = make({ outputOwner: owner });
    const pending = m.exec({
      code: THROW_STREAMED_ERROR,
      yieldTimeMs: INNER_BUDGET_MS,
    });
    try {
      await entered;
      const worker = onlyWorker(m);
      worker.emit("error", new Error(WORKER_ERROR));
      await worker.terminate();
      release();
      const result = await pending;
      expect(result.status).toBe("terminated");
      const streamed = STREAMED_ERROR.slice(0, CHUNK_UNITS);
      const file = `${streamed}\n${WORKER_ERROR}`;
      expect({
        error: result.error,
        truncated: result.truncated,
        clipping: result.clipping,
        recovery: result.recovery?.error,
        file: await readFile(result.recovery!.error!.path!, "utf8"),
      }).toEqual({
        error: beside(streamed, WORKER_ERROR),
        truncated: true,
        clipping: { output: false, result: false, error: true },
        recovery: {
          state: "partial",
          path: expect.any(String),
          bytes: Buffer.byteLength(file),
          capturedBytes: Buffer.byteLength(file),
          reason: "source-error",
        },
        file,
      });
    } finally {
      release();
      await pending;
    }
  });

  it("keeps a streamed error head beside the unconfirmed-stop guidance, then beside the stop reason", async () => {
    // A held write would also hold the window's read, which publishes the
    // error capture. Withhold only the terminal packet instead.
    const { done, restore } = withholdDone();
    const m = make({ terminationWaitMs: 20 });
    let refused: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const first = await m.exec({
        code: THROW_STREAMED_ERROR,
        yieldTimeMs: 0,
      });
      await done;
      refused = vi
        .spyOn(Worker.prototype, "terminate")
        .mockRejectedValue(new Error("unconfirmed stop fixture"));
      const window = await m.wait({
        cellId: first.cellId,
        terminate: true,
        yieldTimeMs: INNER_BUDGET_MS,
      });
      const retained = m.hasCell(first.cellId);
      refused.mockRestore();
      refused = undefined;
      restoreStopConfirmationWindow(m);
      const final = await m.wait({
        cellId: first.cellId,
        terminate: true,
        yieldTimeMs: INNER_BUDGET_MS,
      });
      // The host note is the guidance while the stop is unconfirmed, then the
      // reason the cell stopped.
      expect({
        window: {
          status: window.status,
          unknownOutcome: window.unknownOutcome,
          retained,
          note: noteOf(window.error),
        },
        final: {
          status: final.status,
          unknownOutcome: final.unknownOutcome,
          retained: m.hasCell(first.cellId),
          note: noteOf(final.error),
        },
      }).toEqual({
        window: {
          status: "terminated",
          unknownOutcome: true,
          retained: true,
          note: STOP_UNCONFIRMED,
        },
        final: {
          status: "terminated",
          unknownOutcome: undefined,
          retained: false,
          note: REASON_REQUESTED,
        },
      });
      // The program's own error head stays in front of both notes, and the
      // file holds the streamed error once.
      const file = `${STREAMED_ERROR}\n${REASON_REQUESTED}`;
      expect({
        windowError: window.error,
        finalError: final.error,
        recovery: final.recovery?.error,
        file: await readFile(final.recovery!.error!.path!, "utf8"),
      }).toEqual({
        windowError: beside(STREAMED_ERROR, STOP_UNCONFIRMED),
        finalError: beside(STREAMED_ERROR, REASON_REQUESTED),
        recovery: {
          state: "partial",
          path: expect.any(String),
          bytes: Buffer.byteLength(file),
          capturedBytes: Buffer.byteLength(file),
          reason: "source-error",
        },
        file,
      });
    } finally {
      refused?.mockRestore();
      restore();
    }
  });

  it("bounds an interrupted error to 4 KiB, keeping at most 1 KiB of a long worker error", async () => {
    // The 4 KiB error fills the preview without clipping it, so only the
    // composition can clip. Withhold the terminal packet so a worker error
    // interrupts the cell after the capture.
    const { done, restore } = withholdDone();
    const m = make();
    const streamed = "🙂".repeat(1024);
    const workerError = `worker failure ${"故障🙂".repeat(300)}`;
    const pending = m.exec({
      code: `throw new Error(${JSON.stringify(streamed)});`,
      yieldTimeMs: INNER_BUDGET_MS,
    });
    try {
      await done;
      const worker = onlyWorker(m);
      worker.emit("error", new Error(workerError));
      await worker.terminate();
      const result = await pending;
      expect(result.status).toBe("terminated");
      // The 3,015-byte worker error keeps 1,021 bytes: the next code point
      // would pass 1 KiB. The head gets the remaining 3,074 bytes, which hold
      // 768 whole emoji.
      const file = `${streamed}\n${workerError}`;
      expect({
        error: result.error,
        errorBytes: Buffer.byteLength(result.error ?? ""),
        truncated: result.truncated,
        clipping: result.clipping,
        recovery: result.recovery?.error,
        file: await readFile(result.recovery!.error!.path!, "utf8"),
      }).toEqual({
        error: `${"🙂".repeat(768)}\nworker failure ${"故障🙂".repeat(100)}故障`,
        errorBytes: 4094,
        truncated: true,
        clipping: { output: false, result: false, error: true },
        recovery: {
          state: "partial",
          path: expect.any(String),
          bytes: Buffer.byteLength(file),
          capturedBytes: Buffer.byteLength(file),
          reason: "source-error",
        },
        file,
      });
      expect(Buffer.byteLength(result.error!)).toBeLessThanOrEqual(
        CODE_MODE_ERROR_MAX_BYTES,
      );
    } finally {
      restore();
      await pending;
    }
  });

  it("shows a worker error longer than 1 KiB whole when the interrupted cell streamed no error text", async () => {
    // The 1 KiB note share applies only beside a streamed preview. Modelled on
    // the R05 worker-error row, with a 3,015-byte worker error.
    const owner = new ExecutionOutputOwner();
    owners.push(owner);
    const m = make({ outputOwner: owner });
    const first = await m.exec({
      code: "await new Promise(()=>{});",
      yieldTimeMs: 0,
    });
    const path = first.recovery!.error!.path!;
    const workerError = `worker failure ${"故障🙂".repeat(300)}`;
    const observed = m.wait({
      cellId: first.cellId,
      yieldTimeMs: INNER_BUDGET_MS,
    });
    const worker = onlyWorker(m);
    worker.emit("error", new Error(workerError));
    await worker.terminate();
    const result = await observed;
    expect(result.status).toBe("terminated");
    expect({
      error: result.error,
      errorBytes: Buffer.byteLength(result.error ?? ""),
      truncated: result.truncated,
      clipping: result.clipping,
      recovery: result.recovery?.error,
      file: await readFile(path, "utf8"),
    }).toEqual({
      error: workerError,
      errorBytes: 3015,
      truncated: false,
      clipping: { output: false, result: false, error: false },
      recovery: {
        state: "partial",
        path,
        bytes: 3015,
        capturedBytes: 3015,
        reason: "source-error",
      },
      file: workerError,
    });
  });
});
