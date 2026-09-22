import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SHELL_MAX_BYTES_MAX,
  SHELL_MAX_BYTES_MIN,
  SHELL_SESSION_PREFIX,
  SHELL_YIELD_MAX_MS,
  ShellSessionError,
  ShellSessionManager,
  type ShellSessionResult,
} from "../src/shell/manager.ts";
import { TERMINAL_SETTLE_GRACE_MS } from "./fixtures/budgets.ts";

const managers: ShellSessionManager[] = [];
const temporaryDirectories: string[] = [];

function createManager(
  options: ConstructorParameters<typeof ShellSessionManager>[0] = {},
): ShellSessionManager {
  const manager = new ShellSessionManager(options);
  managers.push(manager);
  return manager;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pct-shell-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// A phase boundary the test releases, instead of a sleep the child can finish
// before a contended parent observes the phase before it.
function awaitFile(path: string): string {
  return `while [ ! -e '${path}' ]; do sleep 0.01; done`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

async function drainToTerminal(
  manager: ShellSessionManager,
  sessionId: string,
  yieldTimeMs = 2000,
  maxRounds = 50,
): Promise<ShellSessionResult & { stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  for (let round = 0; round < maxRounds; round += 1) {
    const result = await manager.write({
      sessionId,
      yieldTimeMs,
      maxOutputBytes: SHELL_MAX_BYTES_MAX,
    });
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.status !== "running") {
      return { ...result, stdout, stderr };
    }
  }
  throw new Error("shell session did not reach a terminal state");
}

describe("ShellSessionManager lifecycle", () => {
  it("reports a short command's output and exit status", async () => {
    const manager = createManager({ settleGraceMs: TERMINAL_SETTLE_GRACE_MS });
    const result = await manager.start({
      command: "printf 'out\\n'; printf 'err\\n' >&2; exit 3",
      cwd: process.cwd(),
      yieldTimeMs: 2000,
    });

    expect(result.sessionId.startsWith(SHELL_SESSION_PREFIX)).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(result.truncated).toBe(false);
    expect(result.dropped).toBe(false);
    expect(manager.hasSession(result.sessionId)).toBe(false);
  });

  it("continues a long command once without relaunching it", async () => {
    const directory = await temporaryDirectory();
    const counter = join(directory, "runs.txt");
    const release = join(directory, "release");
    const manager = createManager();
    const first = await manager.start({
      command: `echo run >> ${counter}; printf 'started\\n'; ${awaitFile(release)}; printf 'finished\\n'; exit 0`,
      cwd: directory,
      yieldTimeMs: 2000,
    });

    expect(first.status).toBe("running");
    expect(first.stdout).toBe("started\n");
    expect(await readFile(counter, "utf8")).toBe("run\n");
    await writeFile(release, "");

    const finished = await drainToTerminal(manager, first.sessionId);
    expect(finished.status).toBe("completed");
    expect(finished.exitCode).toBe(0);
    expect(finished.stdout).toBe("finished\n");
    expect(await readFile(counter, "utf8")).toBe("run\n");
  });

  it("distinguishes an empty poll from completion", async () => {
    const manager = createManager();
    const first = await manager.start({
      command: "printf 'ready\\n'; read line; printf 'done\\n'",
      cwd: process.cwd(),
      yieldTimeMs: 2000,
    });
    expect(first.stdout).toBe("ready\n");

    const poll = await manager.write({
      sessionId: first.sessionId,
      yieldTimeMs: 150,
    });
    expect(poll.status).toBe("running");
    expect(poll.stdout).toBe("");
    expect(poll.stderr).toBe("");
    expect(poll.exitCode).toBeNull();
    expect(poll.signal).toBeNull();

    const second = await manager.write({
      sessionId: first.sessionId,
      input: "hello\n",
      yieldTimeMs: 2000,
    });
    expect(second.stdout).toBe("done\n");
    const terminal =
      second.status === "completed"
        ? second
        : await manager.write({
            sessionId: first.sessionId,
            yieldTimeMs: 2000,
          });
    expect(terminal.status).toBe("completed");
    expect(terminal.exitCode).toBe(0);
  });

  it("forwards stdin verbatim and only closes it when asked", async () => {
    const manager = createManager();
    const first = await manager.start({
      command: "cat",
      cwd: process.cwd(),
      yieldTimeMs: 200,
    });
    expect(first.status).toBe("running");

    const echoed = await manager.write({
      sessionId: first.sessionId,
      input: "no-newline",
      yieldTimeMs: 500,
    });
    expect(echoed.stdout).toBe("no-newline");
    expect(echoed.status).toBe("running");

    const closed = await manager.write({
      sessionId: first.sessionId,
      closeStdin: true,
      yieldTimeMs: 2000,
    });
    const terminal =
      closed.status === "completed"
        ? closed
        : await manager.write({
            sessionId: first.sessionId,
            yieldTimeMs: 2000,
          });
    expect(terminal.status).toBe("completed");
    expect(terminal.exitCode).toBe(0);
  });

  it("preserves UTF-8 across chunk boundaries", async () => {
    const manager = createManager();
    const release = join(await temporaryDirectory(), "release");
    const first = await manager.start({
      // The sleep splits the code point across chunks; the release keeps the
      // session running for the first read.
      command: `printf '\\xe4\\xb8'; sleep 0.15; ${awaitFile(release)}; printf '\\xad\\n'`,
      cwd: process.cwd(),
      yieldTimeMs: 100,
    });
    await writeFile(release, "");
    const finished = await drainToTerminal(manager, first.sessionId);
    expect(finished.stdout).toBe("中\n");
    expect(finished.stdout).not.toContain("\uFFFD");
    expect(finished.status).toBe("completed");
  });

  it("returns quiet and bursty output under one bounded contract", async () => {
    const quiet = createManager();
    const quietSession = await quiet.start({
      command: "sleep 30",
      cwd: process.cwd(),
      yieldTimeMs: 150,
    });
    expect(quietSession.status).toBe("running");
    expect(quietSession.stdout).toBe("");
    const terminated = await quiet.write({
      sessionId: quietSession.sessionId,
      terminate: true,
      yieldTimeMs: 5000,
    });
    expect(terminated.status).toBe("terminated");

    const bursty = createManager();
    const burst = await bursty.start({
      command:
        "for i in 1 2 3 4 5; do printf 'line%s\\n' \"$i\"; sleep 0.03; done",
      cwd: process.cwd(),
      yieldTimeMs: 150,
    });
    let burstStdout = burst.stdout;
    let state = burst;
    while (state.status === "running") {
      state = await bursty.write({
        sessionId: burst.sessionId,
        yieldTimeMs: 2000,
      });
      burstStdout += state.stdout;
    }
    expect(burstStdout).toBe("line1\nline2\nline3\nline4\nline5\n");
    expect(state.status).toBe("completed");
  });

  it("clips reads at the byte budget and reports the loss", async () => {
    const manager = createManager();
    const result = await manager.start({
      command: "head -c 5000 /dev/zero | tr '\\0' 'a'; sleep 0.3",
      cwd: process.cwd(),
      yieldTimeMs: 500,
      maxOutputBytes: SHELL_MAX_BYTES_MIN,
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(
      SHELL_MAX_BYTES_MIN,
    );
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("applies maxOutputBytes as one combined stdout+stderr budget", async () => {
    // The default 50 ms settle window after first activity can close before
    // the other pipe is read; cover the command's tail so the first
    // observation waits for exit and drains both buffered streams together.
    const manager = createManager({ settleGraceMs: 2_000 });
    const budget = SHELL_MAX_BYTES_MIN;
    const result = await manager.start({
      command:
        "head -c 800 /dev/zero | tr '\\0' 'a'; head -c 800 /dev/zero | tr '\\0' 'b' >&2; sleep 0.3",
      cwd: process.cwd(),
      yieldTimeMs: 500,
      maxOutputBytes: budget,
    });
    const combined =
      Buffer.byteLength(result.stdout, "utf8") +
      Buffer.byteLength(result.stderr, "utf8");
    expect(combined).toBeLessThanOrEqual(budget);
    expect(combined).toBeGreaterThan(0);
    // stdout drains first and the remainder is clipped from stderr.
    expect(result.stdout).toHaveLength(800);
    expect(result.stderr).toHaveLength(budget - 800);
    expect(result.truncated).toBe(true);
  });

  it("completes on the stdin command transport and rejects interactive input", async () => {
    const manager = createManager({
      shellConfig: {
        shell: "/bin/bash",
        args: ["-s"],
        commandTransport: "stdin",
      },
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });
    const short = await manager.start({
      command: "printf 'out\\n'; printf 'err\\n' >&2; exit 4",
      cwd: process.cwd(),
      yieldTimeMs: 2000,
    });
    expect(short.status).toBe("completed");
    expect(short.exitCode).toBe(4);
    expect(short.stdout).toBe("out\n");
    expect(short.stderr).toBe("err\n");

    const running = await manager.start({
      command: "sleep 30",
      cwd: process.cwd(),
      yieldTimeMs: 200,
    });
    expect(running.status).toBe("running");
    await expect(
      manager.write({ sessionId: running.sessionId, input: "hello\n" }),
    ).rejects.toMatchObject({ code: "stdin-transport" });

    const polled = await manager.write({
      sessionId: running.sessionId,
      yieldTimeMs: 100,
    });
    expect(polled.status).toBe("running");
  });

  it("drops buffered bytes beyond the stream cap", async () => {
    const manager = createManager({ bufferCapBytes: 64 });
    const result = await manager.start({
      command: "head -c 200 /dev/zero | tr '\\0' 'a'; sleep 0.3",
      cwd: process.cwd(),
      yieldTimeMs: 500,
      maxOutputBytes: SHELL_MAX_BYTES_MAX,
    });
    expect(result.dropped).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(64);
  });

  it("rejects invalid limits and arguments before dispatch", async () => {
    const manager = createManager();
    const cwd = process.cwd();

    for (const input of [
      { command: "", cwd },
      {
        command: "true",
        cwd,
        yieldTimeMs: -1,
      },
      {
        command: "true",
        cwd,
        yieldTimeMs: SHELL_YIELD_MAX_MS + 1,
      },
      { command: "true", cwd, yieldTimeMs: 1.5 },
      { command: "true", cwd, maxOutputBytes: SHELL_MAX_BYTES_MIN - 1 },
      { command: "true", cwd, maxOutputBytes: SHELL_MAX_BYTES_MAX + 1 },
    ]) {
      await expect(manager.start(input)).rejects.toBeInstanceOf(
        ShellSessionError,
      );
    }
    expect(manager.sessionCount).toBe(0);
  });

  it("rejects a missing working directory before dispatch", async () => {
    const manager = createManager();
    await expect(
      manager.start({
        command: "true",
        cwd: join(tmpdir(), "pct-shell-missing-directory"),
      }),
    ).rejects.toMatchObject({ code: "invalid-cwd" });
  });

  it("reports stale and malformed handles", async () => {
    const manager = createManager({ settleGraceMs: TERMINAL_SETTLE_GRACE_MS });
    const short = await manager.start({
      command: "printf 'done\\n'",
      cwd: process.cwd(),
      yieldTimeMs: 2000,
    });
    expect(short.status).toBe("completed");

    await expect(
      manager.write({ sessionId: short.sessionId }),
    ).rejects.toMatchObject({ code: "stale-session" });
    await expect(
      manager.write({ sessionId: `${SHELL_SESSION_PREFIX}missing` }),
    ).rejects.toMatchObject({ code: "stale-session" });
    await expect(manager.write({ sessionId: "" })).rejects.toMatchObject({
      code: "invalid-session",
    });
  });

  it("serializes competing reads without duplicating output", async () => {
    const manager = createManager();
    const directory = await temporaryDirectory();
    const second = join(directory, "second");
    const done = join(directory, "done");
    const first = await manager.start({
      command: `printf 'one\\n'; ${awaitFile(second)}; printf 'two\\n'; ${awaitFile(done)}`,
      cwd: process.cwd(),
      yieldTimeMs: 2000,
    });
    expect(first.stdout).toBe("one\n");

    await writeFile(second, "");
    const reads = [
      manager.write({ sessionId: first.sessionId, yieldTimeMs: 2000 }),
      manager.write({ sessionId: first.sessionId, yieldTimeMs: 2000 }),
    ];
    // Keep the session alive until the first read settles, so the queued read
    // still observes a live handle rather than a delivered one.
    await Promise.race(reads);
    await writeFile(done, "");
    const [readA, readB] = await Promise.all(reads);
    const combined = first.stdout + readA.stdout + readB.stdout;
    expect(combined).toBe("one\ntwo\n");
    expect(combined.match(/two/g)).toHaveLength(1);
  });

  it("enforces the running-session cap", async () => {
    const manager = createManager({ maxRunning: 2 });
    const a = await manager.start({
      command: "sleep 30",
      cwd: process.cwd(),
      yieldTimeMs: 100,
    });
    const b = await manager.start({
      command: "sleep 30",
      cwd: process.cwd(),
      yieldTimeMs: 100,
    });
    expect(a.status).toBe("running");
    expect(b.status).toBe("running");

    await expect(
      manager.start({
        command: "sleep 30",
        cwd: process.cwd(),
        yieldTimeMs: 100,
      }),
    ).rejects.toMatchObject({ code: "session-limit" });

    await manager.write({
      sessionId: a.sessionId,
      terminate: true,
      yieldTimeMs: 5000,
    });
    const afterSlot = await manager.start({
      command: "sleep 30",
      cwd: process.cwd(),
      yieldTimeMs: 100,
    });
    expect(afterSlot.status).toBe("running");
  });

  it("terminates tracked children with bounded escalation", async () => {
    const manager = createManager();
    const session = await manager.start({
      command: 'sleep 30 & child=$!; echo "child:$child"; wait',
      cwd: process.cwd(),
      yieldTimeMs: 2000,
    });
    expect(session.status).toBe("running");
    const match = /child:(\d+)/.exec(session.stdout);
    expect(match).not.toBeNull();
    const childPid = Number(match?.[1]);
    expect(isAlive(childPid)).toBe(true);

    const result = await manager.write({
      sessionId: session.sessionId,
      terminate: true,
      yieldTimeMs: 5000,
    });
    expect(result.status).toBe("terminated");
    expect(result.unknownOutcome).toBeUndefined();
    expect(await waitUntil(() => !isAlive(childPid))).toBe(true);
  });

  it("escalates and reports an unknown outcome when exit is not confirmed", async () => {
    const manager = createManager({
      terminationGraceMs: 150,
      terminationConfirmMs: 2000,
    });
    const session = await manager.start({
      command: "trap '' TERM; while true; do sleep 1; done",
      cwd: process.cwd(),
      yieldTimeMs: 300,
    });
    expect(session.status).toBe("running");

    const unconfirmed = await manager.write({
      sessionId: session.sessionId,
      terminate: true,
      yieldTimeMs: 50,
    });
    expect(unconfirmed.status).toBe("terminated");
    expect(unconfirmed.unknownOutcome).toBe(true);

    expect(await waitUntil(() => manager.hasSession(session.sessionId))).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const confirmed = await manager.write({
      sessionId: session.sessionId,
      yieldTimeMs: 2000,
    });
    expect(confirmed.status).toBe("terminated");
    expect(confirmed.signal).toBe("SIGKILL");
    expect(confirmed.unknownOutcome).toBeUndefined();
  });

  it("closes resources and invalidates handles", async () => {
    const manager = createManager();
    const first = await manager.start({
      command: "echo $$; sleep 30",
      cwd: process.cwd(),
      yieldTimeMs: 2000,
    });
    const second = await manager.start({
      command: "echo $$; sleep 30",
      cwd: process.cwd(),
      yieldTimeMs: 2000,
    });
    const firstPid = Number(first.stdout.trim());
    const secondPid = Number(second.stdout.trim());
    expect(isAlive(firstPid)).toBe(true);
    expect(isAlive(secondPid)).toBe(true);

    await manager.close();
    expect(manager.sessionCount).toBe(0);
    expect(await waitUntil(() => !isAlive(firstPid))).toBe(true);
    expect(await waitUntil(() => !isAlive(secondPid))).toBe(true);
    await expect(
      manager.write({ sessionId: first.sessionId }),
    ).rejects.toMatchObject({ code: "stale-session" });
  });
});
