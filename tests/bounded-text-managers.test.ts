import { afterEach, describe, expect, it } from "vitest";

import {
  CodeModeCellManager,
  type CellDispatcher,
} from "../src/code-mode/manager.ts";
import {
  SHELL_MAX_BYTES_MIN,
  ShellSessionManager,
} from "../src/shell/manager.ts";
import { TERMINAL_SETTLE_GRACE_MS } from "./fixtures/budgets.ts";

// Preview-buffer semantics observed only through the two managers' public
// results: multibyte tail drop, drop-flag reset, and Shell's zero stderr budget.

const closers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((manager) => manager.close()));
});

function shell(
  options: ConstructorParameters<typeof ShellSessionManager>[0] = {},
): ShellSessionManager {
  const manager = new ShellSessionManager(options);
  closers.push(manager);
  return manager;
}

const noTools: CellDispatcher = {
  allowedNames: [],
  call: () => Promise.reject(new Error("no nested tools in this fixture")),
};

function code(
  options: Omit<
    ConstructorParameters<typeof CodeModeCellManager>[0],
    "dispatcher"
  > = {},
): CodeModeCellManager {
  const manager = new CodeModeCellManager({ dispatcher: noTools, ...options });
  closers.push(manager);
  return manager;
}

/** Three UTF-8 bytes per character; 64 bytes hold 21 whole characters. */
const CJK = "中";
const CAP = 64;

describe("Shell preview buffer through ShellSessionManager", () => {
  it("drops the oldest whole code points at the stream cap without replacement characters", async () => {
    const manager = shell({ bufferCapBytes: CAP, settleGraceMs: 2_000 });
    const result = await manager.start({
      command: `printf '%s' '${CJK.repeat(100)}'; sleep 0.3`,
      cwd: process.cwd(),
      yieldTimeMs: 5_000,
      maxOutputBytes: SHELL_MAX_BYTES_MIN,
    });
    expect(result.status).toBe("completed");
    expect(result.dropped).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(CAP);
    expect(result.stdout).not.toContain("�");
    expect(result.stdout).toBe(CJK.repeat(21));
    expect(result.stderr).toBe("");
  });

  it("resets the dropped flag on the next read when no further loss occurred", async () => {
    const manager = shell({ bufferCapBytes: CAP });
    const first = await manager.start({
      command: "head -c 300 /dev/zero | tr '\\0' 'a'; sleep 30",
      cwd: process.cwd(),
      yieldTimeMs: 1_000,
      maxOutputBytes: SHELL_MAX_BYTES_MIN,
    });
    expect(first.status).toBe("running");
    expect(first.dropped).toBe(true);
    expect(first.truncated).toBe(true);
    expect(Buffer.byteLength(first.stdout, "utf8")).toBeLessThanOrEqual(CAP);
    expect(first.stdout).toMatch(/^a+$/);

    const second = await manager.write({
      sessionId: first.sessionId,
      yieldTimeMs: 200,
      maxOutputBytes: SHELL_MAX_BYTES_MIN,
    });
    expect(second.status).toBe("running");
    expect(second.stdout).toBe("");
    expect(second.dropped).toBe(false);
    expect(second.truncated).toBe(false);
  });

  it("retains stderr for the next read when stdout consumes the whole budget", async () => {
    const budget = SHELL_MAX_BYTES_MIN;
    const manager = shell({ settleGraceMs: 300 });
    const first = await manager.start({
      command: `head -c ${budget} /dev/zero | tr '\\0' 'a'; printf 'err\\n' >&2; sleep 30`,
      cwd: process.cwd(),
      yieldTimeMs: 5_000,
      maxOutputBytes: budget,
    });
    expect(first.status).toBe("running");
    expect(first.stdout).toHaveLength(budget);
    // stdout drained the complete budget: stderr's zero-byte drain clips and
    // keeps its text, so the read is truncated but nothing was dropped.
    expect(first.stderr).toBe("");
    expect(first.truncated).toBe(true);
    expect(first.dropped).toBe(false);

    const second = await manager.write({
      sessionId: first.sessionId,
      yieldTimeMs: 200,
      maxOutputBytes: budget,
    });
    expect(second.status).toBe("running");
    expect(second.stdout).toBe("");
    expect(second.stderr).toBe("err\n");
    expect(second.truncated).toBe(false);
    expect(second.dropped).toBe(false);
  });
});

describe("Code Mode preview buffer through CodeModeCellManager", () => {
  it("drops the oldest whole code points at the output cap without replacement characters", async () => {
    const manager = code({
      outputBufferBytes: CAP,
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });
    const result = await manager.exec({
      code: `print(${JSON.stringify(CJK.repeat(100))}); return 1;`,
      yieldTimeMs: 5_000,
    });
    expect(result.status).toBe("completed");
    expect(result.result).toBe(1);
    expect(result.dropped).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.clipping).toEqual({
      output: true,
      result: false,
      error: false,
    });
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(CAP);
    expect(result.output).not.toContain("�");
    expect(result.output).toBe(`${CJK.repeat(21)}\n`);
  });

  it("resets the dropped flag across two wait reads when no further loss occurred", async () => {
    const manager = code({ outputBufferBytes: CAP });
    const first = await manager.exec({
      code: 'print("a".repeat(300)); await new Promise(() => {});',
      yieldTimeMs: 1_000,
    });
    expect(first.status).toBe("running");
    expect(first.dropped).toBe(true);
    expect(first.truncated).toBe(true);
    expect(Buffer.byteLength(first.output, "utf8")).toBeLessThanOrEqual(CAP);
    expect(first.output).toMatch(/^a+\n$/);

    const second = await manager.wait({
      cellId: first.cellId,
      yieldTimeMs: 200,
    });
    expect(second.status).toBe("running");
    expect(second.output).toBe("");
    expect(second.dropped).toBe(false);
    expect(second.truncated).toBe(false);

    const ended = await manager.wait({ cellId: first.cellId, terminate: true });
    expect(ended.status).toBe("terminated");
    expect(ended.dropped).toBe(false);
  });
});
