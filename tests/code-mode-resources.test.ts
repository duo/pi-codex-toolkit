import { afterEach, describe, expect, it } from "vitest";
import {
  CodeModeCellManager,
  type CodeModeCellResult,
} from "../src/code-mode/manager.ts";
import { exitRecorded } from "./fixtures/code-mode-stops.ts";
const managers: CodeModeCellManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});
function make(options: ConstructorParameters<typeof CodeModeCellManager>[0]) {
  const m = new CodeModeCellManager(options);
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
  for (let n = 0; r.status === "running" && n < 40; n++)
    r = await m.wait({ cellId: r.cellId, yieldTimeMs: 1000 });
  expect(r.status).not.toBe("running");
  return r;
}

describe("bounded nested bridge and cleanup", () => {
  it("CM5 bounds outstanding worker RPC count before host queue admission", async () => {
    const held = gate();
    let calls = 0;
    const m = make({
      maxPendingCalls: 4,
      pendingCallBytes: 1024,
      dispatcher: {
        allowedNames: ["hold"],
        call: () => {
          calls++;
          return held.promise;
        },
      },
    });
    try {
      const first = await m.exec({
        code: 'const r=await Promise.allSettled(Array.from({length:100},()=>tools.hold({x:"small"}))); return r.filter(v=>v.status==="rejected").length;',
        uses: ["hold"],
        yieldTimeMs: 0,
      });
      for (let n = 0; calls < 4 && n < 100; n++) await pause(5);
      expect(calls).toBe(4);
      await pause(20);
      expect(calls).toBe(4);
      held.resolve();
      expect((await terminal(m, first)).result).toBe(96);
    } finally {
      held.resolve();
    }
  });
  it("bounds serialized aggregate arguments independently of count and keeps caught overload semantics", async () => {
    const held = gate();
    let calls = 0;
    const m = make({
      maxPendingCalls: 16,
      pendingCallBytes: 64,
      callPayloadBytes: 64,
      dispatcher: {
        allowedNames: ["hold"],
        call: () => {
          calls++;
          return held.promise;
        },
      },
    });
    try {
      const first = await m.exec({
        code: 'const r=await Promise.allSettled(Array.from({length:8},()=>tools.hold({x:"y".repeat(30)}))); return r.filter(v=>v.status==="rejected").length;',
        uses: ["hold"],
        yieldTimeMs: 0,
      });
      for (let n = 0; calls < 1 && n < 100; n++) await pause(5);
      expect(calls).toBe(1);
      held.resolve();
      expect((await terminal(m, first)).result).toBe(7);
    } finally {
      held.resolve();
    }
  });
  it("rejects oversized payloads before effects and releases credits for normal sequential use", async () => {
    let calls = 0;
    const m = make({
      callPayloadBytes: 64,
      dispatcher: {
        allowedNames: ["echo"],
        call: async () => {
          calls++;
          return 7;
        },
      },
    });
    const r = await m.exec({
      code: 'try { await tools.echo({x:"y".repeat(100)}); } catch {} let v; for(let n=0;n<40;n++) v=await tools.echo({n}); return v;',
      uses: ["echo"],
    });
    expect(r.status).toBe("completed");
    expect(r.result).toBe(7);
    expect(calls).toBe(40);
  });
  it("keeps ordinary batches of six legitimate calls", async () => {
    const m = make({
      dispatcher: { allowedNames: ["echo"], call: async (_name, args) => args },
    });
    const r = await m.exec({
      code: "return await Promise.all(Array.from({length:6},(_,n)=>tools.echo({n})));",
      uses: ["echo"],
    });
    expect(r.status).toBe("completed");
    expect(r.result).toEqual(Array.from({ length: 6 }, (_, n) => ({ n })));
  });
  it("rejects oversized nested results with explicit unknown effects, not silent clipping", async () => {
    const m = make({
      callPayloadBytes: 64,
      dispatcher: {
        allowedNames: ["large"],
        call: async () => "x".repeat(100),
      },
    });
    const r = await m.exec({ code: "await tools.large({});", uses: ["large"] });
    expect(r.status).toBe("failed");
    expect(r.unknownOutcome).toBe(true);
    expect(r.error).toContain("payload limit");
  });
  it("bounds aggregate queued replies independently of argument admission", async () => {
    const held = gate();
    const entered = gate();
    let calls = 0;
    const m = make({
      pendingCallBytes: 128,
      callPayloadBytes: 128,
      dispatcher: {
        allowedNames: ["reply"],
        call: async () => {
          if (++calls === 8) entered.resolve();
          await held.promise;
          return "x".repeat(80);
        },
      },
    });
    try {
      const first = await m.exec({
        code: 'const r=await Promise.allSettled(Array.from({length:8},()=>tools.reply({}))); return r.filter(x=>x.status==="rejected").map(x=>x.reason.message);',
        uses: ["reply"],
        yieldTimeMs: 0,
      });
      await entered.promise;
      held.resolve();
      const r = await terminal(m, first);
      expect(r.status).toBe("completed");
      expect(r.unknownOutcome).toBe(true);
      expect(calls).toBe(8);
      expect((r.result as string[]).length).toBeGreaterThan(0);
      expect(
        (r.result as string[]).every(
          (x) =>
            x.includes("reply byte limit") && x.includes("not be replayed"),
        ),
      ).toBe(true);
    } finally {
      held.resolve();
    }
  });
  it("reports unavailable oversized intermediate errors without poisoning selected-error capture", async () => {
    const m = make({
      callPayloadBytes: 64,
      dispatcher: {
        allowedNames: ["fail"],
        call: async () => {
          throw new Error("x".repeat(1000));
        },
      },
    });
    const r = await m.exec({ code: "await tools.fail({});", uses: ["fail"] });
    expect(r.status).toBe("failed");
    expect(r.unknownOutcome).toBe(true);
    expect(r.error).toContain("original error capture is unavailable");
    // Only the selected diagnostic is the cell error, not the original
    // intermediate payload. It is small and completely delivered here.
    expect(r.recovery?.error).toBeUndefined();
    expect(r.truncated).toBe(false);
  });
  it("retains responsibility after terminal delivery when an executor ignores abort", async () => {
    const held = gate();
    const entered = gate();
    let signal: AbortSignal | undefined;
    const m = make({
      terminationWaitMs: 30,
      maxRunning: 1,
      dispatcher: {
        allowedNames: ["hold"],
        call: (_n, _a, s) => {
          signal = s;
          entered.resolve();
          return held.promise;
        },
      },
    });
    try {
      const start = await m.exec({
        code: 'tools.hold({}); throw new Error("stop");',
        uses: ["hold"],
      });
      await entered.promise;
      expect(start.status).toBe("failed");
      expect(start.unknownOutcome).toBe(true);
      expect(signal?.aborted).toBe(true);
      await expect(m.exec({ code: "return 1;" })).rejects.toMatchObject({
        code: "cell-limit",
      });
      await expect(m.close()).rejects.toMatchObject({
        code: "cleanup-incomplete",
      });
      held.resolve();
      await pause(10);
      await expect(m.close()).resolves.toBeUndefined();
    } finally {
      held.resolve();
    }
  });
  it.each([false, true])(
    "R04 retained %s stop control does not surrender an abort-ignoring effect after real failed close",
    async (terminate) => {
      const held = gate();
      const entered = gate();
      let calls = 0;
      let signal: AbortSignal | undefined;
      let reentrantWait: Promise<unknown> | undefined;
      let reentrantClose: Promise<void> | undefined;
      let closeOutcome: Promise<unknown> | undefined;
      const m = make({
        terminationWaitMs: 30,
        dispatcher: {
          allowedNames: ["hold"],
          call: (_name, _args, abort, cell) => {
            calls++;
            signal = abort;
            abort.addEventListener(
              "abort",
              () => {
                reentrantWait = m
                  .wait({ cellId: cell.cellId, yieldTimeMs: 0 })
                  .then(
                    (result) => result,
                    (error: unknown) => error,
                  );
                reentrantClose = m.close();
                // Observe rejection immediately, including assertion-failure paths.
                void reentrantClose.catch(() => undefined);
              },
              { once: true },
            );
            entered.resolve();
            return held.promise;
          },
        },
      });
      try {
        const first = await m.exec({
          code: "await tools.hold({}); return 7;",
          uses: ["hold"],
          yieldTimeMs: 0,
        });
        await entered.promise;
        const close = m.close();
        closeOutcome = close.then(
          () => undefined,
          (error: unknown) => error,
        );
        await expect(m.wait({ cellId: first.cellId })).rejects.toMatchObject({
          code: "closed",
        });
        await expect(m.exec({ code: "return 1;" })).rejects.toMatchObject({
          code: "closed",
        });
        expect(await closeOutcome).toMatchObject({
          code: "cleanup-incomplete",
        });
        expect(await reentrantWait).toMatchObject({ code: "closed" });
        expect(reentrantClose).toBe(close);
        expect(signal?.aborted).toBe(true);
        expect(m.hasCell(first.cellId)).toBe(true);
        // The failed close issued a real stop under a 30 ms window; its exit can
        // be recorded only after that close returned. The release claim below
        // needs the recorded exit, so wait for it rather than race it.
        await exitRecorded(m, first.cellId);
        const result = await m.wait({
          cellId: first.cellId,
          yieldTimeMs: 0,
          terminate,
        });
        expect(result).toMatchObject({
          status: "terminated",
          unknownOutcome: true,
          effects: { unsettled: 1 },
        });
        expect(m.hasCell(first.cellId)).toBe(false);
        expect(m.runningCount).toBe(1);
        await expect(m.wait({ cellId: first.cellId })).rejects.toMatchObject({
          code: "stale-cell",
        });
        await expect(m.close()).rejects.toMatchObject({
          code: "cleanup-incomplete",
        });
        await expect(m.exec({ code: "return 2;" })).rejects.toMatchObject({
          code: "closed",
        });
        expect(calls).toBe(1);
        held.resolve();
        await m.close();
        expect(m.runningCount).toBe(0);
        await expect(m.wait({ cellId: first.cellId })).rejects.toMatchObject({
          code: "closed",
        });
        await expect(m.exec({ code: "return 3;" })).rejects.toMatchObject({
          code: "closed",
        });
      } finally {
        held.resolve();
        await closeOutcome;
        await reentrantWait;
      }
    },
  );
  it("pre-aborted starts dispatch nothing", async () => {
    let calls = 0;
    const m = make({
      dispatcher: {
        allowedNames: ["echo"],
        call: async () => {
          calls++;
        },
      },
    });
    const c = new AbortController();
    c.abort();
    await expect(
      m.exec({ code: "await tools.echo({});", uses: ["echo"] }, c.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toBe(0);
    expect(m.cellCount).toBe(0);
  });
  it("stop preempts a quiet output poll and leaves a single terminal observer", async () => {
    const m = make({
      dispatcher: { allowedNames: [], call: async () => undefined },
    });
    const start = await m.exec({
      code: "await new Promise(()=>{});",
      yieldTimeMs: 0,
    });
    const poll = m.wait({ cellId: start.cellId, yieldTimeMs: 60000 });
    await pause(20);
    const at = Date.now();
    const both = await Promise.allSettled([
      poll,
      m.wait({ cellId: start.cellId, terminate: true }),
    ]);
    expect(Date.now() - at).toBeLessThan(1000);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(both.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "stale-cell" },
    });
  });
});
