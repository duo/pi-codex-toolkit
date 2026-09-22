import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync,
}));

import { ShellSessionManager } from "../src/shell/manager.ts";

const managers: ShellSessionManager[] = [];
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 43210,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  childProcess.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  });
  const manager = new ShellSessionManager({
    platform: "win32",
    shellConfig: { shell: "fake-shell", args: [] },
    terminationGraceMs: 10,
    terminationConfirmMs: 25,
    flushGraceMs: 5,
  });
  managers.push(manager);
  return {
    manager,
    exit() {
      child.stdin.end();
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
    },
  };
}
afterEach(async () => {
  childProcess.spawnSync.mockReturnValue({ status: 0 });
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.clearAllMocks();
});

describe("Windows taskkill contract (mocked, not Windows qualification)", () => {
  it("supplies a finite timeout and confirms a successful mocked tree stop", async () => {
    const { manager, exit } = fixture();
    const first = await manager.start({
      command: "never executed",
      cwd: process.cwd(),
      yieldTimeMs: 0,
    });
    childProcess.spawnSync.mockImplementation(() => {
      queueMicrotask(exit);
      return { status: 0 };
    });
    const result = await manager.write({
      sessionId: first.sessionId,
      terminate: true,
      yieldTimeMs: 1000,
    });
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "43210", "/T", "/F"],
      {
        windowsHide: true,
        timeout: 25,
        killSignal: "SIGKILL",
      },
    );
    expect(result.status).toBe("terminated");
    expect(result.unknownOutcome).toBeUndefined();
  });

  it("preserves a confirmed tree stop across concurrent stop calls before the leader exit event", async () => {
    const { manager, exit } = fixture();
    const first = await manager.start({
      command: "never executed",
      cwd: process.cwd(),
      yieldTimeMs: 0,
    });
    childProcess.spawnSync
      .mockImplementationOnce(() => {
        queueMicrotask(exit);
        return { status: 0 };
      })
      .mockReturnValue({ status: 128 });
    const stops = await Promise.allSettled([
      manager.write({
        sessionId: first.sessionId,
        terminate: true,
        yieldTimeMs: 100,
      }),
      manager.write({
        sessionId: first.sessionId,
        terminate: true,
        yieldTimeMs: 100,
      }),
    ]);
    expect(
      stops.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(stops.find((result) => result.status === "fulfilled")).toMatchObject(
      {
        value: { status: "terminated" },
      },
    );
    expect(manager.hasSession(first.sessionId)).toBe(false);
    expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
  });

  it("does not turn a taskkill timeout plus leader exit into confirmed tree cleanup", async () => {
    const { manager, exit } = fixture();
    const first = await manager.start({
      command: "never executed",
      cwd: process.cwd(),
      yieldTimeMs: 0,
    });
    childProcess.spawnSync.mockImplementation(() => {
      queueMicrotask(exit);
      return {
        status: null,
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      };
    });
    const result = await manager.write({
      sessionId: first.sessionId,
      terminate: true,
      yieldTimeMs: 20,
    });
    expect(result).toMatchObject({
      status: "terminated",
      unknownOutcome: true,
    });
    expect(manager.hasSession(first.sessionId)).toBe(true);
    childProcess.spawnSync.mockReturnValue({ status: 0 });
    const confirmed = await manager.write({
      sessionId: first.sessionId,
      terminate: true,
      yieldTimeMs: 1000,
    });
    expect(confirmed.unknownOutcome).toBeUndefined();
  });
});
