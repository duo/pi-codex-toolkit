import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ShellSessionError,
  ShellSessionManager,
  type ShellSessionResult,
} from "../src/shell/manager.ts";
import { INNER_BUDGET_MS } from "./fixtures/budgets.ts";

const managers: ShellSessionManager[] = [];
const directories: string[] = [];
const descendants = new Set<number>();
const groups = new Set<number>();
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(check: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(10);
  return check();
}
function manager(
  options: ConstructorParameters<typeof ShellSessionManager>[0] = {},
) {
  const value = new ShellSessionManager({
    shellConfig: { shell: "/bin/bash", args: ["-c"] },
    terminationGraceMs: 80,
    terminationConfirmMs: 500,
    ...options,
  });
  managers.push(value);
  return value;
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pct-shell-regression-"));
  directories.push(path);
  return path;
}
async function terminal(m: ShellSessionManager, result: ShellSessionResult) {
  let current = result;
  for (
    let i = 0;
    i < 50 && (current.status === "running" || current.unknownOutcome);
    i++
  ) {
    current = await m.write({
      sessionId: current.sessionId,
      yieldTimeMs: 100,
      maxOutputBytes: 1024,
    });
  }
  return current;
}
// This structural projection also lets the tests run against the unmodified
// baseline: missing recovery is an assertion failure, not an import failure.
function recovery(result: ShellSessionResult) {
  return (
    result as ShellSessionResult & {
      recovery?: {
        stdout?: { path?: string; state: string };
        stderr?: { path?: string; state: string };
      };
    }
  ).recovery;
}
afterEach(async () => {
  vi.restoreAllMocks();
  const closed = await Promise.allSettled(
    managers.splice(0).map((m) => m.close()),
  );
  for (const group of groups) {
    if (alive(-group)) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
    }
    expect(await until(() => !alive(-group))).toBe(true);
  }
  groups.clear();
  for (const pid of descendants) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    expect(await until(() => !alive(pid))).toBe(true);
  }
  descendants.clear();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  expect(closed.every((result) => result.status === "fulfilled")).toBe(true);
});

describe.skipIf(process.platform === "win32")(
  "Shell reliability regressions S1–S7",
  () => {
    it("S1 retains terminal stdout AND stderr beyond a tiny preview after handle release", async () => {
      const m = manager();
      const result = await terminal(
        m,
        await m.start({
          command:
            "printf 'early-'; head -c 4096 /dev/zero | tr '\\0' 'x'; printf -- '-late'; printf 'diagnostic' >&2",
          cwd: process.cwd(),
          yieldTimeMs: 2000,
          maxOutputBytes: 1024,
        }),
      );
      expect(result.status).toBe("completed");
      expect(m.hasSession(result.sessionId)).toBe(false);
      expect(recovery(result)?.stdout?.state).toBe("complete");
      expect(await readFile(recovery(result)!.stdout!.path!, "utf8")).toBe(
        `early-${"x".repeat(4096)}-late`,
      );
      expect(await readFile(recovery(result)!.stderr!.path!, "utf8")).toBe(
        "diagnostic",
      );
      await expect(
        m.write({ sessionId: result.sessionId }),
      ).rejects.toMatchObject({ code: "stale-session" });
    });

    it("S2 owns a late inherited-pipe writer after the shell leader exits", async () => {
      const m = manager();
      // The writer waits for this release rather than a sleep, so a contended
      // first read cannot miss the phase where only the writer holds the pipe.
      const release = join(await directory(), "release");
      const result = await m.start({
        command: `echo group:$$; (while [ ! -e '${release}' ]; do sleep 0.01; done; printf 'late-evidence') & echo child:$!; exit 0`,
        cwd: process.cwd(),
        yieldTimeMs: 2000,
      });
      const pid = Number(/child:(\d+)/.exec(result.stdout)?.[1]);
      const group = Number(/group:(\d+)/.exec(result.stdout)?.[1]);
      if (group) groups.add(group);
      if (pid) descendants.add(pid);
      expect(result.status).toBe("running");
      await writeFile(release, "");
      let output = result.stdout;
      let current = result;
      for (let i = 0; i < 20 && current.status === "running"; i++) {
        current = await m.write({
          sessionId: result.sessionId,
          yieldTimeMs: 1000,
        });
        output += current.stdout;
      }
      expect(current.status).toBe("completed");
      expect(output).toContain("late-evidence");
      expect(await until(() => !alive(pid))).toBe(true);
    });

    it("S2 keeps escalation after a TERM-sensitive leader exits", async () => {
      const m = manager();
      // One deadline bounds the start and every poll below.
      const deadline = Date.now() + INNER_BUDGET_MS;
      const result = await m.start({
        command:
          "echo group:$$; bash -c 'trap \"\" TERM; echo resistant:$$; while :; do sleep 1; done' & wait",
        cwd: process.cwd(),
        yieldTimeMs: 2000,
      });
      // The group line wakes that observation, and its settle grace can end it
      // before the background child prints its PID: read until that line arrives.
      let output = result.stdout;
      while (!/resistant:\d+/.test(output) && Date.now() < deadline) {
        const polled = await m.write({
          sessionId: result.sessionId,
          yieldTimeMs: Math.max(0, Math.min(1000, deadline - Date.now())),
        });
        expect(polled.status).toBe("running");
        output += polled.stdout;
      }
      const pid = Number(/resistant:(\d+)/.exec(output)?.[1]);
      expect(pid).toBeGreaterThan(0);
      descendants.add(pid);
      const group = Number(/group:(\d+)/.exec(output)?.[1]);
      groups.add(group);
      const stopped = await m.write({
        sessionId: result.sessionId,
        terminate: true,
        yieldTimeMs: 1000,
      });
      expect(stopped.status).toBe("terminated");
      expect(stopped.unknownOutcome).toBeUndefined();
      expect(await until(() => !alive(pid), INNER_BUDGET_MS)).toBe(true);
      expect(await until(() => !alive(-group), INNER_BUDGET_MS)).toBe(true);
    });

    it("S2 keeps same-group ownership even after inherited output pipes close", async () => {
      const m = manager();
      const result = await m.start({
        command:
          "echo group:$$; (trap '' TERM; sleep 3) >/dev/null 2>&1 & echo child:$!; exit 0",
        cwd: process.cwd(),
        yieldTimeMs: 1000,
      });
      const group = Number(/group:(\d+)/.exec(result.stdout)?.[1]);
      const child = Number(/child:(\d+)/.exec(result.stdout)?.[1]);
      groups.add(group);
      descendants.add(child);
      expect(result.status).toBe("running");
      expect(m.runningCount).toBe(1);
      expect(alive(-group)).toBe(true);
      await m.close();
      expect(await until(() => !alive(-group))).toBe(true);
      expect(m.sessionCount).toBe(0);
    });

    it("S3 fences a pending cwd admission across overlapping close and allows later reuse", async () => {
      const m = manager();
      const pending = m.start({
        command: "sleep 2",
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const outcome = pending.then(
        () => "started",
        (error: { code: string }) => error.code,
      );
      await Promise.all([m.close(), m.close()]);
      expect(await outcome).toBe("manager-closed");
      expect(m.runningCount).toBe(0);
      expect(
        (
          await m.start({
            command: "true",
            cwd: process.cwd(),
            yieldTimeMs: 2000,
          })
        ).status,
      ).toBe("completed");
    });

    it.each([0, 100])(
      "S4 rejects asynchronous spawn failure at yield %i without occupying a slot",
      async (yieldTimeMs) => {
        const m = manager({
          shellConfig: { shell: "/pct-no-such-shell", args: ["-c"] },
        });
        await expect(
          m.start({ command: "true", cwd: process.cwd(), yieldTimeMs }),
        ).rejects.toMatchObject({ code: "spawn-failed" });
        expect(m.runningCount).toBe(0);
      },
    );

    it("S5 rejects oversized pending stdin instead of ignoring writable pressure", async () => {
      const m = manager();
      const result = await m.start({
        command: "sleep 2",
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      await expect(
        m.write({
          sessionId: result.sessionId,
          input: "x".repeat(1024 * 1024),
          yieldTimeMs: 0,
        }),
      ).rejects.toMatchObject({ code: "stdin-overload" });
    });

    it("S6 does not spawn an already cancelled command", async () => {
      const m = manager();
      const controller = new AbortController();
      controller.abort();
      const cwd = await directory();
      await expect(
        m.start(
          { command: "echo effect > effect", cwd, yieldTimeMs: 100 },
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "aborted" });
      await expect(readFile(join(cwd, "effect"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("S6 rejects already cancelled input before sending any bytes", async () => {
      const m = manager();
      const cwd = await directory();
      const result = await m.start({
        command:
          "trap '' TERM; echo ready; read line; echo \"$line\" > effect; sleep 2",
        cwd,
        yieldTimeMs: 1000,
      });
      const controller = new AbortController();
      controller.abort();
      await expect(
        m.write(
          { sessionId: result.sessionId, input: "payload\n", yieldTimeMs: 100 },
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "aborted" });
      await sleep(100);
      await expect(readFile(join(cwd, "effect"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("S6 dispatches stop outside a quiet observation queue", async () => {
      const m = manager();
      const result = await m.start({
        command: "sleep 3",
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const poll = m.write({ sessionId: result.sessionId, yieldTimeMs: 1000 });
      await sleep(30);
      const started = Date.now();
      const stop = m.write({
        sessionId: result.sessionId,
        terminate: true,
        yieldTimeMs: 1000,
      });
      // Exactly one destructive terminal observer wins; the other may be stale.
      const results = await Promise.allSettled([poll, stop]);
      expect(Date.now() - started).toBeLessThan(600);
      expect(
        results.filter(
          (r) => r.status === "fulfilled" && r.value.status === "terminated",
        ),
      ).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    });

    it.each([0, 100])("S4 rejects EACCES at yield %i", async (yieldTimeMs) => {
      const cwd = await directory();
      const shell = join(cwd, "not-executable");
      await writeFile(shell, "#!/bin/sh\ntrue\n");
      await chmod(shell, 0o600);
      const m = manager({ shellConfig: { shell, args: ["-c"] } });
      await expect(
        m.start({ command: "true", cwd, yieldTimeMs }),
      ).rejects.toMatchObject({ code: "spawn-failed" });
      expect(m.runningCount).toBe(0);
    });

    it("S4 categorizes a synchronous spawn argument failure without a slot", async () => {
      const m = manager({ shellConfig: { shell: "bad\u0000shell", args: [] } });
      await expect(
        m.start({ command: "true", cwd: process.cwd(), yieldTimeMs: 0 }),
      ).rejects.toMatchObject({ code: "spawn-failed" });
      expect(m.sessionCount).toBe(0);
    });

    it("S5 bounds blocked input bytes/count and releases reservations on stop", async () => {
      const m = manager({
        pendingInputBytes: 512 * 1024 + 1,
        pendingInputCalls: 2,
      });
      const first = await m.start({
        command: "sleep 3",
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const state = (
        m as unknown as {
          sessions: Map<
            string,
            {
              child: ChildProcess;
              pendingInputBytes: number;
              pendingInputCalls: number;
              inputWaiters: Set<unknown>;
            }
          >;
        }
      ).sessions.get(first.sessionId)!;
      const a = await m.write({
        sessionId: first.sessionId,
        input: "a".repeat(512 * 1024),
        yieldTimeMs: 0,
      });
      expect(a.inputDelivery).toBe("unknown");
      const b = await m.write({
        sessionId: first.sessionId,
        input: "b",
        yieldTimeMs: 0,
      });
      expect(b.inputDelivery).toBe("unknown");
      expect(state.pendingInputCalls).toBe(2);
      expect(state.pendingInputBytes).toBe(512 * 1024 + 1);
      expect(state.child.stdin!.writableLength).toBeLessThanOrEqual(
        512 * 1024 + 1,
      );
      await expect(
        m.write({ sessionId: first.sessionId, input: "c", yieldTimeMs: 0 }),
      ).rejects.toMatchObject({
        code: "stdin-overload",
        inputDelivery: "not-sent",
      });
      await m.write({
        sessionId: first.sessionId,
        terminate: true,
        yieldTimeMs: 1000,
      });
      expect(await until(() => state.pendingInputBytes === 0)).toBe(true);
      expect(state.pendingInputCalls).toBe(0);
      expect(state.inputWaiters.size).toBe(0);
    });

    it("S5 bounds retained input invocations even after a fast reader accepts their bytes", async () => {
      const m = manager({ pendingInputBytes: 1024, pendingInputCalls: 2 });
      const first = await m.start({
        command: "cat >/dev/null",
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const quiet = m
        .write({ sessionId: first.sessionId, yieldTimeMs: 1000 })
        .catch((error: unknown) => error);
      const a = m
        .write({ sessionId: first.sessionId, input: "a", yieldTimeMs: 0 })
        .catch((error: unknown) => error);
      const b = m
        .write({ sessionId: first.sessionId, input: "b", yieldTimeMs: 0 })
        .catch((error: unknown) => error);
      await sleep(30);
      await expect(
        m.write({ sessionId: first.sessionId, input: "c", yieldTimeMs: 0 }),
      ).rejects.toMatchObject({ code: "stdin-overload" });
      const stop = m
        .write({
          sessionId: first.sessionId,
          terminate: true,
          yieldTimeMs: 1000,
        })
        .catch((error: unknown) => error);
      await Promise.all([quiet, a, b, stop]);
      expect(m.runningCount).toBe(0);
    });

    it("S5 keeps EOF after admitted pending bytes and acknowledges transport without claiming effects", async () => {
      const m = manager({ pendingInputBytes: 512 * 1024 });
      const first = await m.start({
        command: "echo ready; sleep 0.25; wc -c",
        cwd: process.cwd(),
        yieldTimeMs: 1000,
      });
      const input = await m.write({
        sessionId: first.sessionId,
        input: "a".repeat(512 * 1024),
        yieldTimeMs: 0,
      });
      expect(input.inputDelivery).toBe("unknown");
      const result = await m.write({
        sessionId: first.sessionId,
        closeStdin: true,
        yieldTimeMs: 2000,
      });
      expect(result.inputDelivery).toBe("written");
      expect(result.stdout.trim()).toBe(String(512 * 1024));
      // The count wakes this read, and the exit can trail it past the settle grace.
      const ended =
        result.status === "completed"
          ? result
          : await m.write({
              sessionId: first.sessionId,
              yieldTimeMs: INNER_BUDGET_MS,
            });
      expect(ended.status).toBe("completed");
    });

    it("S6 interrupts blocked input and distinguishes uncertain transport", async () => {
      const m = manager({ pendingInputBytes: 512 * 1024 });
      const first = await m.start({
        command: "sleep 3",
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      const controller = new AbortController();
      const input = m.write(
        {
          sessionId: first.sessionId,
          input: "a".repeat(512 * 1024),
          yieldTimeMs: 1000,
        },
        controller.signal,
      );
      const outcome = input.then(
        () => undefined,
        (error: unknown) => error,
      );
      await sleep(20);
      controller.abort();
      expect(await outcome).toMatchObject({
        code: "aborted",
        inputDelivery: "unknown",
      });
      const result = await terminal(m, first);
      expect(result.status).toBe("terminated");
    });

    it.each([false, true])(
      "S7 exposes EPIPE with closeStdin=%s instead of acknowledging lost text",
      async (closeStdin) => {
        const m = manager();
        const first = await m.start({
          command: "exec 0<&-; echo ready; sleep 3",
          cwd: process.cwd(),
          yieldTimeMs: 1000,
        });
        await expect(
          m.write({
            sessionId: first.sessionId,
            input: "payload",
            closeStdin,
            yieldTimeMs: 1000,
          }),
        ).rejects.toMatchObject({
          code: "stdin-failed",
          inputDelivery: "unknown",
        });
        await expect(
          m.write({
            sessionId: first.sessionId,
            input: "retry",
            yieldTimeMs: 0,
          }),
        ).rejects.toMatchObject({
          code: "stdin-closed",
          inputDelivery: "not-sent",
        });
        const polled = await m.write({
          sessionId: first.sessionId,
          yieldTimeMs: 0,
        });
        expect(polled.status).toBe("running");
        expect(polled.stdin).toEqual({
          state: "broken",
          pendingBytes: 0,
          pendingCalls: 0,
        });
      },
    );

    it("S7 marks stdin broken after a synchronous write failure and refuses later input", async () => {
      const marker = "synchronous-write-failure\n";
      const m = manager();
      const first = await m.start({
        command: "cat >/dev/null",
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      // A write that throws, unlike EPIPE, leaves the stream open. Only the
      // marker text throws; every other socket write goes through unchanged.
      const write = Socket.prototype.write;
      const failing = vi
        .spyOn(Socket.prototype, "write")
        .mockImplementation(function (
          this: Socket,
          ...args: Parameters<Socket["write"]>
        ) {
          if (args[0] === marker) {
            throw new Error("simulated synchronous write failure");
          }
          return write.apply(this, args);
        });
      try {
        await expect(
          m.write({
            sessionId: first.sessionId,
            input: marker,
            yieldTimeMs: 0,
          }),
        ).rejects.toEqual(
          new ShellSessionError(
            "stdin-failed",
            `Stdin transport failed for ${first.sessionId}; some bytes may have been sent. Do not resend automatically.`,
            "unknown",
          ),
        );
      } finally {
        failing.mockRestore();
      }
      await expect(
        m.write({
          sessionId: first.sessionId,
          input: "after\n",
          yieldTimeMs: 0,
        }),
      ).rejects.toEqual(
        new ShellSessionError(
          "stdin-closed",
          "This session's stdin is closed or broken; input was not sent. Poll without input.",
          "not-sent",
        ),
      );
      const polled = await m.write({
        sessionId: first.sessionId,
        yieldTimeMs: 0,
      });
      expect(polled.status).toBe("running");
      expect(polled.stdin).toEqual({
        state: "broken",
        pendingBytes: 0,
        pendingCalls: 0,
      });
    });

    it("S7 keeps stdin broken when the command transport write fails with no input waiter", async () => {
      // About 2 MB of comment lines, so end(command) cannot fit in the pipe
      // before the shell closes its reader. A shorter command would be written
      // in full and never fail with EPIPE.
      const padding = "# padding\n".repeat(200_000);
      const m = manager({
        shellConfig: { shell: "/bin/sh", args: [], commandTransport: "stdin" },
      });
      const root = await directory();
      const release = join(root, "release");
      // The release file is never created: the loop keeps the shell running
      // until the manager closes and stops its group.
      const first = await m.start({
        command: `exec 0<&-; printf 'closed\\n'; while [ ! -e '${release}' ]; do sleep 0.01; done\n${padding}`,
        cwd: root,
        yieldTimeMs: 0,
      });
      // Command transport sends the command with one end() call and registers
      // no input waiter, so only the stream's error handler can mark stdin
      // broken when that write fails.
      const session = (
        m as unknown as {
          sessions: Map<
            string,
            { child: ChildProcess; inputWaiters: Set<unknown> }
          >;
        }
      ).sessions.get(first.sessionId)!;
      const stdin = session.child.stdin!;
      await vi.waitFor(
        () => {
          expect(stdin.closed).toBe(true);
          expect((stdin.errored as NodeJS.ErrnoException | null)?.code).toBe(
            "EPIPE",
          );
        },
        { timeout: INNER_BUDGET_MS, interval: 10 },
      );
      expect(session.inputWaiters.size).toBe(0);
      const polled = await m.write({
        sessionId: first.sessionId,
        yieldTimeMs: 0,
      });
      expect(polled.status).toBe("running");
      expect(polled.stdin).toEqual({
        state: "broken",
        pendingBytes: 0,
        pendingCalls: 0,
      });
    });

    it("S6 rejects terminate-plus-input without either effect", async () => {
      const m = manager();
      const first = await m.start({
        command: "cat",
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      await expect(
        m.write({ sessionId: first.sessionId, input: "x", terminate: true }),
      ).rejects.toMatchObject({
        code: "stdin-closed",
        inputDelivery: "not-sent",
      });
      expect(
        (await m.write({ sessionId: first.sessionId, yieldTimeMs: 0 })).status,
      ).toBe("running");
    });

    it("S2 keeps uncertain cleanup bounded and retains the handle for another stop", async () => {
      const m = manager({ terminationGraceMs: 20, terminationConfirmMs: 20 });
      const first = await m.start({
        command: "echo group:$$; sleep 3",
        cwd: process.cwd(),
        yieldTimeMs: 1000,
      });
      const group = Number(/group:(\d+)/.exec(first.stdout)?.[1]);
      groups.add(group);
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -group && signal !== 0)
          throw Object.assign(new Error("unconfirmed"), { code: "EPERM" });
        return kill(pid, signal);
      });
      try {
        const start = Date.now();
        await expect(m.close()).rejects.toMatchObject({
          code: "cleanup-incomplete",
        });
        expect(Date.now() - start).toBeLessThan(500);
        expect(m.hasSession(first.sessionId)).toBe(true);
        expect(
          (await m.write({ sessionId: first.sessionId, yieldTimeMs: 0 }))
            .unknownOutcome,
        ).toBe(true);
      } finally {
        vi.restoreAllMocks();
      }
      // One stop observation waits at most grace + confirm (40 ms here), so a
      // loaded host can deliver the real exit later. Confirm the stop through
      // the file's bounded polling instead of one observation.
      const stopped = await terminal(
        m,
        await m.write({
          sessionId: first.sessionId,
          terminate: true,
          yieldTimeMs: 1000,
        }),
      );
      expect(stopped.unknownOutcome).toBeUndefined();
      expect(await until(() => !alive(-group))).toBe(true);
    });

    it("S7 rejects text after EOF while keeping empty polls valid", async () => {
      const m = manager();
      const result = await m.start({
        command: "cat >/dev/null; sleep 2",
        cwd: process.cwd(),
        yieldTimeMs: 0,
      });
      await m.write({
        sessionId: result.sessionId,
        closeStdin: true,
        yieldTimeMs: 0,
      });
      await expect(
        m.write({ sessionId: result.sessionId, input: "lost", yieldTimeMs: 0 }),
      ).rejects.toMatchObject({ code: "stdin-closed" });
      expect(
        (
          await m.write({
            sessionId: result.sessionId,
            closeStdin: true,
            yieldTimeMs: 0,
          })
        ).status,
      ).toBe("running");
    });
  },
);
