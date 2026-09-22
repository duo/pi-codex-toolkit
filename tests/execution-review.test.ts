import { Worker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CodeModeCellManager,
  type CodeModeCellResult,
} from "../src/code-mode/manager.ts";
import { ShellSessionManager } from "../src/shell/manager.ts";
import {
  CODE_MODE_RENDER_MAX_BYTES,
  formatCodeModeResult,
} from "../src/code-mode/tools.ts";
import { restoreStopConfirmationWindow } from "./fixtures/code-mode-stops.ts";

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function terminal(
  manager: CodeModeCellManager,
  result: CodeModeCellResult,
) {
  for (let n = 0; result.status === "running" && n < 40; n++)
    result = await manager.wait({ cellId: result.cellId, yieldTimeMs: 100 });
  expect(result.status).not.toBe("running");
  return result;
}

describe("independent whole-scope boundary regressions", () => {
  it.each([
    [
      "finally",
      'tools.work({n:1}).finally(async()=>{await tools.work({n:2});}); return "ok";',
      [1, 2],
    ],
    [
      "async reactions",
      'tools.work({n:1}).then(async()=>{await Promise.resolve(); return tools.work({n:2});}).then(()=>tools.work({n:3})); return "ok";',
      [1, 2, 3],
    ],
    [
      "Promise.any caught loser",
      'Promise.any([tools.work({n:1,fail:true}),tools.work({n:2})]).then(()=>tools.work({n:3})); return "ok";',
      [1, 2, 3],
    ],
  ] as const)(
    "settles native %s composition before success",
    async (_name, code, expected) => {
      const calls: number[] = [];
      const manager = new CodeModeCellManager({
        dispatcher: {
          allowedNames: ["work"],
          call: async (_name, args) => {
            const a = args as { n: number; fail?: boolean };
            calls.push(a.n);
            await pause(5);
            if (a.fail) throw new Error("caught loser");
            return a.n;
          },
        },
      });
      try {
        const result = await terminal(
          manager,
          await manager.exec({ code, uses: ["work"], yieldTimeMs: 0 }),
        );
        expect(result.status).toBe("completed");
        expect(result.result).toBe("ok");
        expect(calls).toEqual(expected);
      } finally {
        await manager.close();
      }
    },
  );

  it("does not hide an unhandled rejection created during result serialization", async () => {
    const manager = new CodeModeCellManager({
      dispatcher: {
        allowedNames: ["bad"],
        call: async () => {
          throw new Error("serialization-floating-failure");
        },
      },
    });
    try {
      const r = await terminal(
        manager,
        await manager.exec({
          code: "return {toJSON(){tools.bad({});return 1;}};",
          uses: ["bad"],
        }),
      );
      expect(r.status).toBe("failed");
      expect(r.error).toContain("serialization-floating-failure");
    } finally {
      await manager.close();
    }
  });

  it("keeps the production maximum of 16 shell controls and all recovery paths inside the final text bound", () => {
    const shells = Array.from({ length: 16 }, (_, n) => ({
      sessionId: `pct-shell-${String(n).padStart(36, "0")}`,
      status: "running" as const,
    }));
    const recovery = Object.fromEntries(
      ["output", "result", "error"].map((name) => [
        name,
        {
          state: "complete",
          path: `/tmp/${name}-${"p".repeat(900)}`,
          bytes: 400000,
          capturedBytes: 400000,
        },
      ]),
    );
    const text = formatCodeModeResult({
      cellId: "pct-cell-control",
      status: "terminated",
      unknownOutcome: true,
      shells,
      recovery,
      output: "🙂".repeat(100000),
      result: Array(60000).fill(1),
      error: "error".repeat(30000),
      truncated: true,
      dropped: false,
    } as CodeModeCellResult);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      CODE_MODE_RENDER_MAX_BYTES,
    );
    for (const s of shells) {
      expect(text).toContain(s.sessionId);
      expect(text.indexOf(s.sessionId)).toBeLessThan(text.indexOf("[output]"));
    }
    for (const c of Object.values(recovery)) expect(text).toContain(c.path);
    expect(text).toContain("outcome is unknown");
    expect(text).not.toContain("�");
  });

  it("settles calls introduced by selected-value serialization without serializing twice", async () => {
    const held = gate();
    const entered = gate();
    let calls = 0;
    const manager = new CodeModeCellManager({
      dispatcher: {
        allowedNames: ["hold"],
        call: async () => {
          calls++;
          entered.resolve();
          await held.promise;
          return 1;
        },
      },
    });
    try {
      const first = await manager.exec({
        code: 'return {toJSON(){ print("serialize-once"); tools.hold({}).then(() => tools.hold({})); return {selected:"yes"}; }};',
        uses: ["hold"],
        yieldTimeMs: 0,
      });
      await Promise.race([entered.promise, pause(1000)]);
      const waiting = await manager.wait({
        cellId: first.cellId,
        yieldTimeMs: 50,
      });
      expect(waiting.status).toBe("running");
      held.resolve();
      const last = await terminal(manager, waiting);
      expect(last.status).toBe("completed");
      expect(last.result).toEqual({ selected: "yes" });
      expect(calls).toBe(2);
      expect(await readFile(last.recovery!.output!.path!, "utf8")).toBe(
        "serialize-once\n",
      );
    } finally {
      held.resolve();
      await manager.close();
    }
  });

  it("rechecks worker RPC count after reentrant argument serialization", async () => {
    const held = gate(),
      serialized = gate();
    let messages = 0;
    const emit = Worker.prototype.emit;
    const spy = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event,
      ...args
    ) {
      if (event === "message") {
        const message = args[0] as { type?: string; text?: string };
        if (message.type === "call") messages++;
        if (
          message.type === "capture" &&
          message.text?.includes("admission-done")
        )
          serialized.resolve();
      }
      return emit.call(this, event, ...args);
    });
    const manager = new CodeModeCellManager({
      maxPendingCalls: 2,
      dispatcher: {
        allowedNames: ["hold"],
        call: async () => {
          await held.promise;
          return 1;
        },
      },
    });
    try {
      const first = await manager.exec({
        code: 'const errors=[]; const p=tools.hold({toJSON(){tools.hold({n:1});tools.hold({n:2});return {n:3};}}).catch(e=>errors.push(e.message)); print("admission-done"); await p; return errors;',
        uses: ["hold"],
        yieldTimeMs: 0,
      });
      await Promise.race([serialized.promise, pause(1000)]);
      expect(messages).toBe(2);
      held.resolve();
      const result = await terminal(manager, first);
      expect(result.status).toBe("completed");
      expect(result.result).toEqual([
        expect.stringContaining("too many outstanding"),
      ]);
    } finally {
      held.resolve();
      try {
        await manager.close();
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("preserves the selected error after a caught oversized intermediate error", async () => {
    const manager = new CodeModeCellManager({
      callPayloadBytes: 64,
      dispatcher: {
        allowedNames: ["bad"],
        call: async () => {
          throw new Error("intermediate".repeat(100));
        },
      },
    });
    try {
      const result = await terminal(
        manager,
        await manager.exec({
          code: 'try { await tools.bad({}); } catch {} throw new Error("selected-".repeat(1000)+"FINAL_GUIDANCE");',
          uses: ["bad"],
        }),
      );
      expect(result.status).toBe("failed");
      expect(result.recovery?.error?.state).toBe("complete");
      expect(await readFile(result.recovery!.error!.path!, "utf8")).toBe(
        "selected-".repeat(1000) + "FINAL_GUIDANCE",
      );
    } finally {
      await manager.close();
    }
  });

  it("an unconfirmed worker stop preempts a long observer and remains retryable", async () => {
    const manager = new CodeModeCellManager({
      dispatcher: { allowedNames: [], call: async () => undefined },
      terminationWaitMs: 20,
    });
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    const observers: Promise<unknown>[] = [];
    try {
      const first = await manager.exec({
        code: "await new Promise(()=>{});",
        yieldTimeMs: 0,
      });
      const poll = manager.wait({ cellId: first.cellId, yieldTimeMs: 60_000 });
      observers.push(poll);
      await pause(20);
      spy = vi
        .spyOn(Worker.prototype, "terminate")
        .mockRejectedValue(new Error("unconfirmed stop fixture"));
      const stop = manager.wait({
        cellId: first.cellId,
        terminate: true,
        yieldTimeMs: 60_000,
      });
      observers.push(stop);
      const results = await Promise.race([
        Promise.all([poll, stop]),
        pause(500).then(() => "blocked"),
      ]);
      expect(results).not.toBe("blocked");
      expect(results).toEqual([
        expect.objectContaining({ status: "terminated", unknownOutcome: true }),
        expect.objectContaining({ status: "terminated", unknownOutcome: true }),
      ]);
      expect(manager.hasCell(first.cellId)).toBe(true);
      spy.mockRestore();
      spy = undefined;
      restoreStopConfirmationWindow(manager);
      const retry = await manager.wait({
        cellId: first.cellId,
        terminate: true,
        yieldTimeMs: 100,
      });
      expect(manager.hasCell(first.cellId)).toBe(false);
      expect(retry.status).toBe("terminated");
      expect(retry.unknownOutcome).toBeUndefined();
      expect(retry.error).not.toContain("unconfirmed");
    } finally {
      spy?.mockRestore();
      // Explicit fixture rescue: the candidate does not retry a rejected terminate().
      const owned = (manager as unknown as { owned: Set<{ worker: Worker }> })
        .owned;
      await Promise.all([...owned].map((c) => c.worker.terminate()));
      await Promise.allSettled(observers);
      await manager.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "unconfirmed same-group stop does not wait behind a 60-second shell poll",
    async () => {
      const manager = new ShellSessionManager({
        shellConfig: { shell: "/bin/sh", args: ["-c"] },
        terminationGraceMs: 20,
        terminationConfirmMs: 20,
      });
      const kill = process.kill.bind(process);
      let group = 0;
      let spy: ReturnType<typeof vi.spyOn> | undefined;
      const observers: Promise<unknown>[] = [];
      try {
        const first = await manager.start({
          command: "echo $$; read line",
          cwd: process.cwd(),
          yieldTimeMs: 1000,
        });
        group = Number(first.stdout.trim());
        expect(group).toBeGreaterThan(0);
        const poll = manager.write({
          sessionId: first.sessionId,
          yieldTimeMs: 60_000,
        });
        observers.push(poll);
        await pause(20);
        spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid === -group && signal !== 0)
            throw Object.assign(new Error("unconfirmed stop"), {
              code: "EPERM",
            });
          return kill(pid, signal);
        });
        const stop = manager.write({
          sessionId: first.sessionId,
          terminate: true,
          yieldTimeMs: 60_000,
        });
        observers.push(stop);
        const results = await Promise.race([
          Promise.all([poll, stop]),
          pause(500).then(() => "blocked"),
        ]);
        expect(results).not.toBe("blocked");
        expect(results).toEqual([
          expect.objectContaining({
            status: "terminated",
            unknownOutcome: true,
          }),
          expect.objectContaining({
            status: "terminated",
            unknownOutcome: true,
          }),
        ]);
        expect(manager.hasSession(first.sessionId)).toBe(true);
      } finally {
        spy?.mockRestore();
        if (group) {
          try {
            kill(-group, "SIGKILL");
          } catch {}
        }
        await Promise.allSettled(observers);
        await manager.close();
        if (group) expect(() => kill(-group, 0)).toThrow();
      }
    },
  );
});
