import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODE_MODE_CELL_PREFIX,
  CODE_MODE_PROGRESS_FIELD_BYTES,
  CODE_MODE_TERMINATION_WAIT_MS,
  CODE_MODE_MAX_BYTES_MAX,
  CODE_MODE_RESULT_MAX_BYTES,
  boundMessage,
  CodeModeCellManager,
  CodeModeError,
  type CellDispatcher,
  type CodeModeCellContext,
  type CodeModeCellResult,
  type NestedProgressRecord,
} from "../src/code-mode/manager.ts";
import { SHELL_SESSION_PREFIX } from "../src/shell/manager.ts";
import {
  INNER_BUDGET_MS,
  TERMINAL_SETTLE_GRACE_MS,
} from "./fixtures/budgets.ts";

const managers: CodeModeCellManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

// A completed but undelivered cell is visible only as no longer running. Pruning
// acts on completed cells, so wait for completion instead of sleeping on it.
async function noCellRunning(manager: CodeModeCellManager): Promise<void> {
  await vi.waitFor(() => expect(manager.runningCount).toBe(0), {
    timeout: INNER_BUDGET_MS,
    interval: 5,
  });
}

type Handler = (
  args: unknown,
  signal: AbortSignal,
  cell: CodeModeCellContext,
) => Promise<unknown> | unknown;

class FakeDispatcher implements CellDispatcher {
  readonly allowedNames: string[];
  readonly mutatingNames: string[] = [];
  readonly calls: Array<{
    name: string;
    args: unknown;
    cellId: string;
    signal: AbortSignal;
  }> = [];

  constructor(private readonly handlers: Record<string, Handler> = {}) {
    this.allowedNames = Object.keys(handlers);
  }

  call(
    name: string,
    args: unknown,
    signal: AbortSignal,
    cell: CodeModeCellContext,
  ): Promise<unknown> {
    this.calls.push({ name, args, cellId: cell.cellId, signal });
    const handler = this.handlers[name];
    if (!handler) {
      return Promise.reject(new Error(`No fake handler for ${name}`));
    }
    return Promise.resolve(handler(args, signal, cell));
  }
}

function createManager(
  dispatcher: CellDispatcher,
  options: Partial<ConstructorParameters<typeof CodeModeCellManager>[0]> = {},
): CodeModeCellManager {
  const manager = new CodeModeCellManager({ dispatcher, ...options });
  managers.push(manager);
  return manager;
}

async function drainToTerminal(
  manager: CodeModeCellManager,
  cellId: string,
  maxRounds = 50,
): Promise<CodeModeCellResult & { output: string }> {
  let output = "";
  let dropped = false;
  let truncated = false;
  for (let round = 0; round < maxRounds; round += 1) {
    const result = await manager.wait({
      cellId,
      yieldTimeMs: 5_000,
      maxOutputBytes: CODE_MODE_MAX_BYTES_MAX,
    });
    output += result.output;
    dropped = dropped || result.dropped;
    truncated = truncated || result.truncated;
    if (result.status !== "running") {
      return { ...result, output, dropped, truncated };
    }
  }
  throw new Error("Code Mode cell did not reach a terminal state");
}

describe("CodeModeCellManager execution", () => {
  it("runs a short program once and returns output and result", async () => {
    const dispatcher = new FakeDispatcher();
    const manager = createManager(dispatcher, {
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });

    const result = await manager.exec({
      code: 'print("hello"); return 42;',
    });

    expect(result.cellId.startsWith(CODE_MODE_CELL_PREFIX)).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.output).toBe("hello\n");
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
    expect(result.truncated).toBe(false);
    expect(result.dropped).toBe(false);
    expect(manager.hasCell(result.cellId)).toBe(false);
  });

  it("supports top-level await through a nested tool call", async () => {
    const dispatcher = new FakeDispatcher({ echo: (args) => args });
    const manager = createManager(dispatcher, {
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });

    const result = await manager.exec({
      code: 'const value = await tools.echo({ n: 2 }); print("got", value); return value.n * 2;',
      uses: ["echo"],
    });

    expect(result.status).toBe("completed");
    expect(result.result).toBe(4);
    expect(result.output).toContain("got");
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0].name).toBe("echo");
    expect(dispatcher.calls[0].args).toEqual({ n: 2 });
    expect(dispatcher.calls[0].cellId).toBe(result.cellId);
  });

  it("yields a running cell and wait returns only new output", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<string>((resolve) => {
      release = () => resolve("released");
    });
    const dispatcher = new FakeDispatcher({ hold: () => gate });
    const manager = createManager(dispatcher);

    const first = await manager.exec({
      code: 'print("first"); const value = await tools.hold({}); print("second"); return value;',
      uses: ["hold"],
      yieldTimeMs: 2_000,
    });
    expect(first.status).toBe("running");
    expect(manager.hasCell(first.cellId)).toBe(true);

    // Delivery across reads is the claim here, so drain to the terminal state;
    // one wait can return the new output before the done message arrives.
    const pending = drainToTerminal(manager, first.cellId);
    release();
    const second = await pending;

    expect(`${first.output}${second.output}`).toBe("first\nsecond\n");
    expect(second.status).toBe("completed");
    expect(second.result).toBe("released");
    await expect(manager.wait({ cellId: first.cellId })).rejects.toMatchObject({
      code: "stale-cell",
    });
  });

  it("reports a failed program with prior output and completed calls", async () => {
    const dispatcher = new FakeDispatcher({ echo: (args) => ({ echo: args }) });
    const manager = createManager(dispatcher, {
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });

    const result = await manager.exec({
      code: 'print("before"); const value = await tools.echo({ n: 1 }); printCellContents(value); return 1;',
      uses: ["echo"],
    });

    expect(result.status).toBe("failed");
    expect(result.output).toContain("before");
    expect(result.error).toContain("printCellContents");
    expect(dispatcher.calls).toHaveLength(1);
    await expect(manager.wait({ cellId: result.cellId })).rejects.toMatchObject(
      { code: "stale-cell" },
    );
  });

  it("fails an undeclared nested call inside the cell without dispatching", async () => {
    const dispatcher = new FakeDispatcher({ echo: (args) => args });
    const manager = createManager(dispatcher, {
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });

    // An explicit empty list declares no adapters; omitting `uses` instead
    // declares the whole current admission snapshot.
    const result = await manager.exec({
      code: 'try { await tools.echo({ n: 1 }); } catch (error) { print("caught:" + error.message); } return "ok";',
      uses: [],
    });

    expect(result.status).toBe("completed");
    expect(result.result).toBe("ok");
    expect(result.output).toContain("was not declared in");
    expect(result.output).toContain("Declared tools: (none)");
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("bounds the nested progress one outer call receives", async () => {
    // A name far longer than the per-field ceiling; the record must carry the
    // truncated identity, never an unbounded string.
    const longName = `echo_${"n".repeat(400)}`;
    const dispatcher = new FakeDispatcher({ [longName]: () => "ok" });
    const manager = createManager(dispatcher, {
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
      progressMaxRecords: 3,
    });
    const records: NestedProgressRecord[] = [];

    // Four nested calls produce eight start/end records; only three arrive.
    const result = await manager.exec({
      code: `for (let n = 0; n < 4; n++) await tools["${longName}"]({}); return "done";`,
      uses: [longName],
      yieldTimeMs: 5_000,
      onProgress: (record) => records.push(record),
    });

    expect(result.status).toBe("completed");
    expect(dispatcher.calls).toHaveLength(4);
    expect(records).toHaveLength(3);
    const bounded = boundMessage(longName, CODE_MODE_PROGRESS_FIELD_BYTES);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(
      CODE_MODE_PROGRESS_FIELD_BYTES,
    );
    expect(records).toEqual([
      { nested: true, phase: "start", name: bounded, cell_id: result.cellId },
      {
        nested: true,
        phase: "end",
        name: bounded,
        cell_id: result.cellId,
        ok: true,
      },
      { nested: true, phase: "start", name: bounded, cell_id: result.cellId },
    ]);
    // A sink that throws is dropped instead of failing the nested call.
    const thrown = createManager(new FakeDispatcher({ echo: () => "ok" }), {
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });
    let seen = 0;
    const second = await thrown.exec({
      code: 'await tools.echo({}); await tools.echo({}); return "done";',
      uses: ["echo"],
      yieldTimeMs: 5_000,
      onProgress: () => {
        seen += 1;
        throw new Error("sink failure");
      },
    });
    expect(second.status).toBe("completed");
    expect(seen).toBe(1);
  });

  it("rejects a nested call with non-cloneable arguments without hanging", async () => {
    const dispatcher = new FakeDispatcher({ echo: (args) => args });
    const manager = createManager(dispatcher, {
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });

    const result = await manager.exec({
      code: 'try { await tools.echo({ fn: function () {} }); return "dispatched"; } catch (error) { print("caught"); return error.message; }',
      uses: ["echo"],
      yieldTimeMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toContain("caught");
    expect(String(result.result)).toMatch(
      /could not be cloned|JSON-serializable/,
    );
    expect(dispatcher.calls).toHaveLength(0);
    expect(manager.runningCount).toBe(0);
  });

  it("fails a cell with a floating rejected promise instead of crashing the worker", async () => {
    const manager = createManager(new FakeDispatcher());

    const result = await manager.exec({
      code: 'Promise.reject(new Error("floating boom")); await new Promise(() => {});',
      yieldTimeMs: 5_000,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("floating boom");
    expect(manager.hasCell(result.cellId)).toBe(false);
  });

  it("starts every cell from fresh state without ambient capabilities", async () => {
    const manager = createManager(new FakeDispatcher());

    const first = await manager.exec({
      code: "globalThis.leak = 42; return typeof globalThis.leak;",
    });
    expect(first.result).toBe("number");

    const second = await manager.exec({
      code: "return typeof globalThis.leak;",
    });
    expect(second.result).toBe("undefined");

    const ambient = await manager.exec({
      code: "return [typeof process, typeof require, typeof fetch].join(',');",
    });
    expect(ambient.result).toBe("undefined,undefined,undefined");

    const dynamicImport = await manager.exec({
      code: 'try { await import("node:fs"); return "imported"; } catch { return "blocked"; }',
    });
    expect(dynamicImport.result).toBe("blocked");
  });

  it("composes independent and dependent calls and filters evidence", async () => {
    const dispatcher = new FakeDispatcher({
      list: () =>
        Array.from({ length: 200 }, (_value, index) => ({
          id: index,
          keep: index % 10 === 0,
        })),
      echo: (args) => args,
    });
    const manager = createManager(dispatcher, {
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });

    const result = await manager.exec({
      code: `
        const [items, tag] = await Promise.all([
          tools.list({}),
          tools.echo({ tag: "run" }),
        ]);
        const kept = items.filter((item) => item.keep).map((item) => item.id);
        print(JSON.stringify(kept));
        return { count: kept.length, tag: tag.tag };
      `,
      uses: ["list", "echo"],
    });

    expect(result.status).toBe("completed");
    expect(result.result).toEqual({ count: 20, tag: "run" });
    expect(result.output).toContain("0,10,20");
    expect(dispatcher.calls).toHaveLength(2);
  });

  it("waits for outstanding nested calls before reporting completion", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatcher = new FakeDispatcher({ slow: () => gate });
    const manager = createManager(dispatcher);

    const first = await manager.exec({
      code: 'tools.slow({}); return "done";',
      uses: ["slow"],
      yieldTimeMs: 0,
    });
    expect(first.status).toBe("running");

    const pending = manager.wait({
      cellId: first.cellId,
      yieldTimeMs: 5_000,
    });
    release();
    const result = await pending;

    expect(result.status).toBe("completed");
    expect(result.result).toBe("done");
    expect(dispatcher.calls).toHaveLength(1);
  });
});

describe("CodeModeCellManager bounds", () => {
  it("caps buffered output and reports dropped bytes", async () => {
    let emitted!: () => void;
    const allOutput = new Promise<void>((resolve) => {
      emitted = resolve;
    });
    const manager = createManager(
      new FakeDispatcher({
        after: () => {
          emitted();
          return "done";
        },
      }),
    );

    const first = await manager.exec({
      code: 'const chunk = "x".repeat(1024); for (let index = 0; index < 600; index += 1) print(chunk); return await tools.after({});',
      uses: ["after"],
      maxOutputBytes: CODE_MODE_MAX_BYTES_MAX,
      yieldTimeMs: 0,
    });
    // Real capture credits can spread a burst across several observation
    // windows. Hold destructive reads until it exceeds the preview buffer,
    // rather than assuming 600 prints finish within the settle grace.
    await allOutput;
    const result = await drainToTerminal(manager, first.cellId);

    expect(result.status).toBe("completed");
    expect(result.result).toBe("done");
    expect(result.dropped).toBe(true);
    expect(result.truncated).toBe(true);
    const bytes = Buffer.byteLength(result.output, "utf8");
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(CODE_MODE_MAX_BYTES_MAX);
  });

  it("caps a large result and notes truncation", async () => {
    const manager = createManager(new FakeDispatcher());

    const result = await manager.exec({
      code: 'return "y".repeat(65536);',
    });

    expect(result.status).toBe("completed");
    expect(typeof result.result).toBe("string");
    expect(
      Buffer.byteLength(result.result as string, "utf8"),
    ).toBeLessThanOrEqual(CODE_MODE_RESULT_MAX_BYTES);
    expect(result.truncated).toBe(true);
  });

  it("delivers a JSON return value unchanged", async () => {
    const manager = createManager(new FakeDispatcher());

    const result = await manager.exec({
      code: "return { ok: true, items: [1, 2, 3] };",
    });

    expect(result.result).toEqual({ ok: true, items: [1, 2, 3] });
    expect(result.truncated).toBe(false);
  });

  it("rejects invalid arguments and unknown cells before dispatch", async () => {
    const manager = createManager(new FakeDispatcher());

    await expect(manager.exec({ code: "" })).rejects.toMatchObject({
      code: "invalid-code",
    });
    await expect(
      manager.exec({ code: "return 1;", uses: ["nope"] }),
    ).rejects.toMatchObject({ code: "invalid-uses" });
    await expect(
      manager.exec({ code: "return 1;", uses: ["echo", "echo"] }),
    ).rejects.toMatchObject({ code: "invalid-uses" });
    await expect(
      manager.exec({ code: "return 1;", uses: [1] as never }),
    ).rejects.toMatchObject({ code: "invalid-uses" });
    await expect(
      manager.exec({ code: "return 1;", yieldTimeMs: -1 }),
    ).rejects.toMatchObject({ code: "invalid-limit" });
    await expect(
      manager.exec({ code: "return 1;", maxOutputBytes: 10 }),
    ).rejects.toMatchObject({ code: "invalid-limit" });
    await expect(manager.wait({ cellId: "pct-cell-missing" })).rejects.toEqual(
      new CodeModeError(
        "stale-cell",
        "Code Mode cell pct-cell-missing is unknown, released or expired. Use previously returned recovery paths; never rerun a program to recover output.",
      ),
    );
    expect(manager.cellCount).toBe(0);
  });

  // An empty or non-string cellId is a caller error, not a cell that was
  // released or expired, so it must not be reported as a stale cell.
  it.each([
    ["an empty", ""],
    ["a non-string", undefined],
  ])("rejects wait with %s cellId as invalid input", async (_name, cellId) => {
    const manager = createManager(new FakeDispatcher());

    await expect(manager.wait({ cellId: cellId as string })).rejects.toEqual(
      new CodeModeError(
        "invalid-input",
        "wait requires cell_id (or cellId): the opaque cell handle string returned by exec.",
      ),
    );
  });

  it.each([false, true])(
    "rejects wait on a Shell Sessions sessionId before lookup (terminate=%s)",
    async (terminate) => {
      const dispatcher = new FakeDispatcher();
      const manager = createManager(dispatcher);
      const cellId = `${SHELL_SESSION_PREFIX}not-a-cell`;
      const error = new CodeModeError(
        "invalid-input",
        `wait expects a Code Mode cell_id (also spelled cellId) from exec (prefix ${CODE_MODE_CELL_PREFIX}). ${cellId} is a Shell Sessions session_id. Continue that job with write_stdin; do not wait, rerun, or terminate it through wait.`,
      );

      await expect(manager.wait({ cellId, terminate })).rejects.toEqual(error);
      expect(dispatcher.calls).toEqual([]);
      expect(manager.cellCount).toBe(0);
    },
  );

  it("enforces the running-cell limit", async () => {
    const manager = createManager(new FakeDispatcher(), { maxRunning: 1 });

    const first = await manager.exec({
      code: "await new Promise(() => {});",
      yieldTimeMs: 0,
    });
    expect(first.status).toBe("running");

    await expect(manager.exec({ code: "return 1;" })).rejects.toMatchObject({
      code: "cell-limit",
    });
    await manager.wait({ cellId: first.cellId, terminate: true });
  });

  it("terminates a CPU-bound cell without waiting for it", async () => {
    const manager = createManager(new FakeDispatcher());

    const first = await manager.exec({
      code: "while (true) {}",
      yieldTimeMs: 0,
    });
    expect(first.status).toBe("running");

    // A busy loop never yields, so only a forced stop ends it. The exact error,
    // known outcome and released handle show that stop was confirmed; the bound
    // shows it was not deferred behind the confirmation window it must not wait out.
    const started = Date.now();
    const result = await manager.wait({
      cellId: first.cellId,
      terminate: true,
    });
    expect(result.status).toBe("terminated");
    expect(result.error).toBe("Cell terminated by request.");
    expect(result.unknownOutcome).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(CODE_MODE_TERMINATION_WAIT_MS);
    await expect(manager.wait({ cellId: first.cellId })).rejects.toMatchObject({
      code: "stale-cell",
    });
  });

  it("maps a memory-limit worker death to terminated with prior output", async () => {
    const manager = createManager(new FakeDispatcher(), {
      memoryOldGenerationMb: 32,
      memoryYoungGenerationMb: 8,
    });

    const first = await manager.exec({
      code: 'print("before"); const chunks = []; for (;;) { chunks.push(new Array(200000).fill("x")); }',
      yieldTimeMs: 10_000,
    });
    let output = first.output;
    let terminal = first;
    if (first.status === "running") {
      terminal = await drainToTerminal(manager, first.cellId);
      output += terminal.output;
    }

    expect(terminal.status).toBe("terminated");
    expect(output).toContain("before");
    expect(terminal.error).toBeDefined();
    expect(manager.hasCell(first.cellId)).toBe(false);
  });

  it("rejects pending nested calls and reports an unknown outcome", async () => {
    const dispatcher = new FakeDispatcher({
      hang: (_args, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const manager = createManager(dispatcher);

    const first = await manager.exec({
      code: 'print("started"); await tools.hang({}); return "never";',
      uses: ["hang"],
      yieldTimeMs: 2_000,
    });
    expect(first.status).toBe("running");
    expect(first.output).toBe("started\n");
    // The worker sends the call only after its print is captured, so that
    // output can end exec before the host has the call: wait for the dispatch.
    await vi.waitFor(() => expect(dispatcher.calls).toHaveLength(1), {
      timeout: INNER_BUDGET_MS,
      interval: 5,
    });

    const result = await manager.wait({
      cellId: first.cellId,
      terminate: true,
    });
    expect(result.status).toBe("terminated");
    expect(result.unknownOutcome).toBe(true);
    expect(dispatcher.calls[0].signal.aborted).toBe(true);
  });

  it("reports termination without in-flight calls as a known outcome", async () => {
    const manager = createManager(new FakeDispatcher());

    const first = await manager.exec({
      code: 'print("quiet"); await new Promise(() => {});',
      yieldTimeMs: 2_000,
    });
    expect(first.status).toBe("running");

    const result = await manager.wait({
      cellId: first.cellId,
      terminate: true,
    });
    expect(result.status).toBe("terminated");
    expect(result.unknownOutcome).toBeUndefined();
  });
});

describe("CodeModeCellManager lifecycle", () => {
  it.each([false, true])(
    "evicts the oldest completed-undelivered cell (third completed: %s)",
    async (thirdCompleted) => {
      const names = ["first", "second", "third"] as const;
      const gates = names.map(() => {
        let release: () => void = () => undefined;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { pending, release };
      });
      const dispatcher = new FakeDispatcher(
        Object.fromEntries(
          names.map((name, index) => [name, () => gates[index].pending]),
        ),
      );
      const manager = createManager(dispatcher, { maxCompleted: 1 });
      const cells: CodeModeCellResult[] = [];
      try {
        for (const [index, name] of names.entries()) {
          const cell = await manager.exec({
            code: `await tools.${name}({}); return ${index + 1};`,
            uses: [name],
            yieldTimeMs: 0,
          });
          // A zero yield alone cannot keep a fast cell undelivered. Hold its
          // result until exec has returned, then explicitly choose completion.
          expect(cell.status).toBe("running");
          cells.push(cell);
          if (index < 2 || thirdCompleted) {
            gates[index].release();
            await noCellRunning(manager);
          }
        }
        const keptIndex = thirdCompleted ? 2 : 1;
        for (const cell of cells.slice(0, keptIndex)) {
          await expect(
            manager.wait({ cellId: cell.cellId }),
          ).rejects.toStrictEqual(
            new CodeModeError(
              "stale-cell",
              `Code Mode cell ${cell.cellId} is unknown, released or expired. Use previously returned recovery paths; never rerun a program to recover output.`,
            ),
          );
        }
        const kept = await manager.wait({ cellId: cells[keptIndex].cellId });
        expect(kept.status).toBe("completed");
        expect(kept.result).toBe(keptIndex + 1);
        if (!thirdCompleted) {
          gates[2].release();
          const third = await drainToTerminal(manager, cells[2].cellId);
          expect(third.status).toBe("completed");
          expect(third.result).toBe(3);
        }
      } finally {
        for (const gate of gates) gate.release();
      }
    },
  );

  it("sweeps completed handles after the retention window", async () => {
    let now = 1_000_000;
    const manager = createManager(new FakeDispatcher(), {
      now: () => now,
      completedRetentionMs: 1_000,
    });

    const stale = await manager.exec({ code: "return 1;", yieldTimeMs: 0 });
    await noCellRunning(manager);
    now += 5_000;
    await manager.exec({ code: "return 2;", yieldTimeMs: 0 });

    await expect(manager.wait({ cellId: stale.cellId })).rejects.toMatchObject({
      code: "stale-cell",
    });
  });

  it("scopes cell handles to one manager instance", async () => {
    const managerA = createManager(new FakeDispatcher());
    const managerB = createManager(new FakeDispatcher());

    const cell = await managerA.exec({
      code: "await new Promise(() => {});",
      yieldTimeMs: 0,
    });

    await expect(managerB.wait({ cellId: cell.cellId })).rejects.toMatchObject({
      code: "stale-cell",
    });
    await managerA.wait({ cellId: cell.cellId, terminate: true });
  });

  it("close terminates live cells and rejects later use", async () => {
    const manager = createManager(new FakeDispatcher());

    const first = await manager.exec({
      code: "await new Promise(() => {});",
      yieldTimeMs: 0,
    });
    expect(manager.runningCount).toBe(1);

    await manager.close();

    expect(manager.runningCount).toBe(0);
    await expect(manager.exec({ code: "return 1;" })).rejects.toMatchObject({
      code: "closed",
    });
    await expect(manager.wait({ cellId: first.cellId })).rejects.toMatchObject({
      code: "closed",
    });
  });

  it("terminates a cell when the outer call is aborted", async () => {
    const manager = createManager(new FakeDispatcher());
    const controller = new AbortController();

    const pending = manager.exec(
      {
        code: "while (true) {}",
        yieldTimeMs: 30_000,
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 200);
    const result = await pending;

    expect(result.status).toBe("terminated");
    expect(result.error).toContain("aborted");
  });

  it("terminates a cell when the outer call aborts during the settle grace", async () => {
    const manager = createManager(new FakeDispatcher(), {
      settleGraceMs: 5_000,
    });
    const controller = new AbortController();

    const pending = manager.exec(
      {
        code: 'print("hi"); await new Promise(() => {});',
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);
    const result = await pending;

    expect(result.status).toBe("terminated");
    expect(result.error).toContain("aborted");
    expect(manager.hasCell(result.cellId)).toBe(false);
    expect(manager.runningCount).toBe(0);
  });
});
