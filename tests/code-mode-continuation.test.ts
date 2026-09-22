import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_MODE_CELL_PREFIX,
  CodeModeCellManager,
  CodeModeError,
  type CodeModeCellResult,
} from "../src/code-mode/manager.ts";
import { CodeModeAdapters } from "../src/code-mode/adapters.ts";
import { formatCodeModeResult } from "../src/code-mode/tools.ts";
import { ShellSessionManager } from "../src/shell/manager.ts";
import { INNER_BUDGET_MS } from "./fixtures/budgets.ts";
const shells: ShellSessionManager[] = [];
const cells: CodeModeCellManager[] = [];
afterEach(async () => {
  await Promise.all(shells.map((s) => s.close()));
  await Promise.all(cells.splice(0).map((c) => c.close()));
  for (const shell of shells.splice(0)) expect(shell.runningCount).toBe(0);
});
function harness() {
  const shell = new ShellSessionManager({
    shellConfig: { shell: "/bin/sh", args: ["-c"], commandTransport: "argv" },
    terminationGraceMs: 100,
    terminationConfirmMs: 1000,
  });
  shells.push(shell);
  const adapters = new CodeModeAdapters({ shell });
  const cell = new CodeModeCellManager({
    dispatcher: adapters,
    terminationWaitMs: 1500,
  });
  cells.push(cell);
  return { shell, cell, adapters };
}
async function terminal(cell: CodeModeCellManager, result: CodeModeCellResult) {
  for (let n = 0; result.status === "running" && n < 20; n++)
    result = await cell.wait({ cellId: result.cellId, yieldTimeMs: 1000 });
  expect(result.status).not.toBe("running");
  return result;
}
const context = { cwd: process.cwd() };

describe("independent nested shell continuation", () => {
  it.each([
    "return undefined;",
    'return {filler:"x".repeat(40000)};',
    'throw new Error("after shell");',
  ])("CM4 keeps discarded shell routing through %s", async (ending) => {
    const { shell, cell } = harness();
    const r = await terminal(
      cell,
      await cell.exec({
        code: `await tools.exec_command({command:"sleep 3",yieldTimeMs:0}); ${ending}`,
        uses: ["exec_command"],
        context,
      }),
    );
    expect(r.shells).toHaveLength(1);
    const id = r.shells![0].sessionId;
    expect(shell.continuation(id)).toMatchObject({ status: "running" });
    expect(formatCodeModeResult(r)).toContain(id);
    expect(formatCodeModeResult(r)).toContain("write_stdin, not wait");
    await expect(cell.wait({ cellId: id })).rejects.toEqual(
      new CodeModeError(
        "invalid-input",
        `wait expects a Code Mode cell_id (also spelled cellId) from exec (prefix ${CODE_MODE_CELL_PREFIX}). ${id} is a Shell Sessions session_id. Continue that job with write_stdin; do not wait, rerun, or terminate it through wait.`,
      ),
    );
    await cell.close();
    expect(shell.continuation(id)).toBeDefined();
    await shell.write({ sessionId: id, terminate: true });
    expect(shell.continuation(id)).toBeUndefined();
  });
  it("keeps multiple live IDs but excludes a completed shell and another cell's retired ID", async () => {
    const { shell, cell } = harness();
    const r = await terminal(
      cell,
      await cell.exec({
        code: 'await Promise.all([tools.exec_command({command:"sleep 3",yieldTimeMs:0}), tools.exec_command({command:"sleep 3",yieldTimeMs:0}), tools.exec_command({command:"printf done"})]); return 1;',
        uses: ["exec_command"],
        context,
      }),
    );
    expect(r.shells).toHaveLength(2);
    const id = r.shells![0].sessionId;
    const stopped = await terminal(
      cell,
      await cell.exec({
        code: `await tools.write_stdin({sessionId:${JSON.stringify(id)},terminate:true}); return 1;`,
        uses: ["write_stdin"],
        context,
      }),
    );
    expect(stopped.shells ?? []).toEqual([]);
    expect(shell.continuation(id)).toBeUndefined();
  });
  it("publishes pending shell ownership before the nested start yields, including cell termination", async () => {
    const { shell, cell } = harness();
    let r = await cell.exec({
      code: "await tools.exec_command({command:\"trap '' TERM; sleep 3\",yieldTimeMs:60000});",
      uses: ["exec_command"],
      context,
      yieldTimeMs: 0,
    });
    for (let n = 0; !r.shells?.length && n < 30; n++)
      r = await cell.wait({ cellId: r.cellId, yieldTimeMs: 10 });
    expect(r.status).toBe("running");
    expect(r.shells).toHaveLength(1);
    const stopped = await cell.wait({ cellId: r.cellId, terminate: true });
    expect(stopped.status).toBe("terminated");
    expect(stopped.unknownOutcome).toBe(true);
    // Either already settled (no live route) or still managed and independently controllable.
    const live = shell.continuation(r.shells![0].sessionId);
    if (live) expect(stopped.shells).toContainEqual(live);
    await shell.close();
  });
  it("Shell's non-destructive continuation excludes natural terminal-but-unread handles", async () => {
    const { shell } = harness();
    let notified: string | undefined;
    const start = await shell.start(
      { command: "sleep 0.05; printf end", cwd: process.cwd(), yieldTimeMs: 0 },
      undefined,
      (id) => {
        notified = id;
      },
    );
    expect(notified).toBe(start.sessionId);
    expect(shell.continuation(start.sessionId)).toBeDefined();
    await vi.waitFor(
      () => expect(shell.continuation(start.sessionId)).toBeUndefined(),
      { timeout: INNER_BUDGET_MS, interval: 10 },
    );
    expect(shell.hasSession(start.sessionId)).toBe(true);
    expect((await shell.write({ sessionId: start.sessionId })).stdout).toBe(
      "end",
    );
  });
});
