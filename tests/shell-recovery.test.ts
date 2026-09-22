import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReadTool } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExecutionOutputOwner,
  type ExecutionOutputOwnerOptions,
} from "../src/execution-output.ts";
import {
  ShellSessionError,
  ShellSessionManager,
  type ShellSessionResult,
} from "../src/shell/manager.ts";
import {
  INNER_BUDGET_MS,
  TERMINAL_SETTLE_GRACE_MS,
} from "./fixtures/budgets.ts";

const managers: ShellSessionManager[] = [];
const owners: ExecutionOutputOwner[] = [];
const roots: string[] = [];
async function setup(
  options: ConstructorParameters<typeof ShellSessionManager>[0] = {},
  outputOptions: ExecutionOutputOwnerOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pct-shell-recovery-"));
  roots.push(root);
  const outputOwner = new ExecutionOutputOwner({
    temporaryRoot: root,
    ...outputOptions,
  });
  owners.push(outputOwner);
  const manager = new ShellSessionManager({
    shellConfig: { shell: "/bin/bash", args: ["-c"] },
    terminationGraceMs: 50,
    terminationConfirmMs: 500,
    outputOwner,
    ...options,
  });
  managers.push(manager);
  return { root, owner: outputOwner, manager };
}
async function settled(manager: ShellSessionManager) {
  await vi.waitFor(() => expect(manager.runningCount).toBe(0), {
    timeout: INNER_BUDGET_MS,
    interval: 10,
  });
}
async function finish(manager: ShellSessionManager, first: ShellSessionResult) {
  let result = first;
  for (
    let i = 0;
    i < 50 && (result.status === "running" || result.unknownOutcome);
    i++
  ) {
    result = await manager.write({
      sessionId: result.sessionId,
      yieldTimeMs: 100,
      maxOutputBytes: 1024,
    });
  }
  return result;
}

/**
 * Runs `read` on a job that printed "out" and exits once its gate opens, holding
 * the read's recovery publish after stdout's snapshot while the job settles. A
 * snapshot follows its path's availability check, which runs outside the
 * capture's I/O queue, so holding stderr's check holds neither capture's finish.
 * `onLaterCheck` runs at every check after the release.
 */
async function settleDuringPublish<T>(
  read: (manager: ShellSessionManager, sessionId: string) => Promise<T>,
  onLaterCheck: () => void = () => undefined,
) {
  // The job settles while a check is held; the I/O bound must not end it first.
  const { manager, root, owner } = await setup(
    {},
    { ioTimeoutMs: INNER_BUDGET_MS },
  );
  const exit = join(root, "exit");
  const first = await manager.start({
    command: `printf out; while [ ! -e '${exit}' ]; do sleep 0.01; done`,
    cwd: root,
    yieldTimeMs: INNER_BUDGET_MS,
  });
  expect(first).toEqual({
    sessionId: first.sessionId,
    status: "running",
    exitCode: null,
    signal: null,
    stdout: "out",
    stderr: "",
    truncated: false,
    dropped: false,
    stdin: { state: "open", pendingBytes: 0, pendingCalls: 0 },
    recovery: {
      stdout: {
        state: "capturing",
        path: expect.any(String),
        bytes: 3,
        capturedBytes: 3,
      },
      stderr: {
        state: "capturing",
        path: expect.any(String),
        bytes: 0,
        capturedBytes: 0,
      },
    },
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let released = false;
  let holding = false;
  const checked: string[] = [];
  const available = owner.isAvailable.bind(owner);
  const availability = vi
    .spyOn(owner, "isAvailable")
    .mockImplementation(async (path) => {
      if (released) onLaterCheck();
      else if (path === first.recovery?.stderr.path) {
        holding = true;
        await held;
      }
      const result = await available(path);
      checked.push(path);
      return result;
    });
  let reading!: Promise<T>;
  try {
    reading = read(manager, first.sessionId);
    void reading.catch(() => undefined);
    await vi.waitFor(
      () =>
        expect({ checked, holding }).toEqual({
          checked: [first.recovery?.stdout.path],
          holding: true,
        }),
      { timeout: INNER_BUDGET_MS, interval: 5 },
    );
    // stdout's snapshot was taken while the job ran; now let the job settle.
    await writeFile(exit, "");
    await settled(manager);
    released = true;
    release();
    await reading.catch(() => undefined);
  } finally {
    release();
    availability.mockRestore();
  }
  return { manager, first, reading };
}

/** settleDuringPublish's job, ended, with final capture states. */
function finalResult(first: ShellSessionResult) {
  return {
    sessionId: first.sessionId,
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    dropped: false,
    stdin: { state: "closed", pendingBytes: 0, pendingCalls: 0 },
    recovery: {
      stdout: {
        state: "complete",
        path: first.recovery?.stdout.path,
        bytes: 3,
        capturedBytes: 3,
      },
      stderr: {
        state: "complete",
        path: first.recovery?.stderr.path,
        bytes: 0,
        capturedBytes: 0,
      },
    },
  };
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "Shell same-owner recovery",
  () => {
    it("does not create files for genuinely small fully delivered results", async () => {
      const { manager, root } = await setup({
        settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
      });
      expect(await readdir(root)).toEqual([]);
      const result = await manager.start({
        command: "printf small",
        cwd: process.cwd(),
        yieldTimeMs: 2000,
      });
      expect(result.status).toBe("completed");
      expect(result.recovery).toBeUndefined();
      expect(await readdir(root)).toEqual([]);
    });

    it("retains early/middle/late UTF-8 stdout and stderr across polls, failure, release and manager close", async () => {
      const { manager, root, owner } = await setup({ bufferCapBytes: 128 });
      const first = await manager.start({
        command:
          "echo once > runs; printf 'early🙂\\n'; read one; head -c 2048 /dev/zero | tr '\\0' m; printf 'middle中\\n' >&2; read two; printf '\\xe4\\xb8'; sleep 0.05; printf '\\xad-late\\n'; printf 'stderr-late\\n' >&2; exit 7",
        cwd: root,
        yieldTimeMs: 1000,
        maxOutputBytes: 1024,
      });
      expect(first.status).toBe("running");
      expect(first.stdout).toBe("early🙂\n");
      const second = await manager.write({
        sessionId: first.sessionId,
        input: "one\n",
        yieldTimeMs: 1000,
        maxOutputBytes: 1024,
      });
      expect(second.dropped).toBe(true);
      const last = await finish(
        manager,
        await manager.write({
          sessionId: first.sessionId,
          input: "two\n",
          yieldTimeMs: 1000,
          maxOutputBytes: 1024,
        }),
      );
      expect(last.status).toBe("completed");
      expect(last.exitCode).toBe(7);
      expect(manager.hasSession(last.sessionId)).toBe(false);
      expect(last.recovery?.stdout.state).toBe("complete");
      expect(last.recovery?.stderr.state).toBe("complete");
      expect(last.recovery?.stdout.path).toBe(first.recovery?.stdout.path);
      expect(second.recovery?.stdout.path).toBe(first.recovery?.stdout.path);
      const path = first.recovery!.stdout.path!;
      expect(await readFile(path, "utf8")).toBe(
        `early🙂\n${"m".repeat(2048)}中-late\n`,
      );
      expect(await readFile(first.recovery!.stderr.path!, "utf8")).toBe(
        "middle中\nstderr-late\n",
      );
      expect(await readFile(join(root, "runs"), "utf8")).toBe("once\n");
      await manager.close(); // Equivalent executor lifetime boundary, not a host event fixture.
      const nativeRead = createReadTool(process.cwd());
      const read = await nativeRead.execute("recover-after-close", { path });
      expect(JSON.stringify(read.content)).toContain("early🙂");
      expect(JSON.stringify(read.content)).toContain("中-late");
      expect(owner.isClosed).toBe(false);
      expect(
        (await manager.start({ command: "true", cwd: root, yieldTimeMs: 1000 }))
          .status,
      ).toBe("completed");
      expect(await readFile(path, "utf8")).toContain("中-late");
      await owner.close();
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        manager.start({ command: "true", cwd: root }),
      ).rejects.toMatchObject({ code: "manager-closed" });
    });

    it.each(["retention", "count"] as const)(
      "keeps files and initial recovery references after %s pruning",
      async (mode) => {
        let now = 0;
        const { manager, root } = await setup({
          now: () => now,
          completedRetentionMs: 100,
          maxCompleted: 1,
        });
        const a = await manager.start({
          command: "sleep 0.05; printf final-A",
          cwd: root,
          yieldTimeMs: 0,
        });
        expect(a.recovery?.stdout.path).toBeTruthy();
        await settled(manager);
        if (mode === "retention") now = 1000;
        else {
          await manager.start({
            command: "sleep 0.05; printf final-B",
            cwd: root,
            yieldTimeMs: 0,
          });
          await settled(manager);
        }
        await manager.start({ command: "true", cwd: root, yieldTimeMs: 1000 });
        expect(manager.hasSession(a.sessionId)).toBe(false);
        expect(await readFile(a.recovery!.stdout.path!, "utf8")).toBe(
          "final-A",
        );
        await expect(manager.write({ sessionId: a.sessionId })).rejects.toThrow(
          "never rerun",
        );
      },
    );

    it.each([false, true])(
      "captures output before termination and retains unknown terminations for later polling (controlled delays: %s)",
      async (controlledDelays) => {
        const { manager, root, owner } = await setup({
          terminationGraceMs: 200,
        });
        const first = await manager.start({
          command:
            (controlledDelays ? "read ready; " : "") +
            "trap '' TERM; printf before-stop; while :; do sleep 1; done",
          cwd: root,
          yieldTimeMs: 100,
        });
        expect(first.status).toBe("running");
        let preview = first.stdout;
        if (controlledDelays) {
          // A deterministic startup barrier, not a longer startup sleep.
          expect(preview).toBe("");
          const released = await manager.write({
            sessionId: first.sessionId,
            input: "ready\n",
            yieldTimeMs: 100,
          });
          preview += released.stdout;
        }
        const readyDeadline = Date.now() + 2000;
        while (preview !== "before-stop" && Date.now() < readyDeadline) {
          const observed = await manager.write({
            sessionId: first.sessionId,
            yieldTimeMs: 100,
          });
          expect(observed.status).toBe("running");
          preview += observed.stdout;
        }
        // The marker follows trap installation; an observation budget is not readiness.
        expect(preview).toBe("before-stop");

        const realKill = process.kill.bind(process);
        let ownedGroup: number | undefined;
        let withheldKills = 0;
        let releaseAvailability!: () => void;
        const availabilityGate = new Promise<void>((resolve) => {
          releaseAvailability = resolve;
        });
        const realAvailable = owner.isAvailable.bind(owner);
        const availability = controlledDelays
          ? vi.spyOn(owner, "isAvailable").mockImplementation(async (path) => {
              await availabilityGate;
              return realAvailable(path);
            })
          : undefined;
        const kill = vi
          .spyOn(process, "kill")
          .mockImplementation((pid, signal) => {
            // This serial fixture owns the sole manager; record its actual TERM target.
            if (signal === "SIGTERM" && ownedGroup === undefined)
              ownedGroup = pid;
            if (pid === ownedGroup && signal === "SIGKILL") {
              withheldKills++;
              releaseAvailability();
              return true;
            }
            return realKill(pid, signal);
          });
        // Bound the injected gate independently; failure still releases cleanup below.
        const rescueTimer = setTimeout(releaseAvailability, 2000);
        try {
          // Zero yield alone does not force uncertainty: capture I/O can outlast KILL.
          const stopping = await manager.write({
            sessionId: first.sessionId,
            terminate: true,
            yieldTimeMs: 0,
          });
          expect(ownedGroup).toBeLessThan(0);
          if (controlledDelays) expect(withheldKills).toBeGreaterThan(0);
          expect(stopping).toMatchObject({
            status: "terminated",
            unknownOutcome: true,
          });
          expect(manager.hasSession(first.sessionId)).toBe(true);
        } finally {
          clearTimeout(rescueTimer);
          releaseAvailability();
          availability?.mockRestore();
          kill.mockRestore();
        }
        // Restore real delivery and exercise retained-handle stop/poll, never replay.
        const last = await finish(
          manager,
          await manager.write({
            sessionId: first.sessionId,
            terminate: true,
            yieldTimeMs: 0,
          }),
        );
        expect(last.status).toBe("terminated");
        expect(last.signal).toBe("SIGKILL");
        expect(last.unknownOutcome).toBeUndefined();
        expect(manager.hasSession(first.sessionId)).toBe(false);
        expect(last.recovery?.stdout.state).toBe("complete");
        expect(await readFile(first.recovery!.stdout.path!, "utf8")).toBe(
          "before-stop",
        );
      },
    );

    it("reports final capture states when the job settles during a read's recovery publish", async () => {
      const { manager, first, reading } = await settleDuringPublish(
        (shell, sessionId) => shell.write({ sessionId, yieldTimeMs: 0 }),
      );
      expect(await reading).toEqual(finalResult(first));
      expect(manager.hasSession(first.sessionId)).toBe(false);
      expect(await readFile(first.recovery!.stdout.path!, "utf8")).toBe("out");
    });

    it("leaves the terminal result to the next reader when a detached read is cancelled while publishing final states", async () => {
      const controller = new AbortController();
      const { manager, first, reading } = await settleDuringPublish(
        (shell, sessionId) =>
          shell.write({ sessionId, yieldTimeMs: 0 }, controller.signal, {
            cancellation: "detach",
          }),
        // Checks after the release belong to the final-state publish.
        () => controller.abort(),
      );
      const { sessionId } = first;
      await expect(reading).rejects.toStrictEqual(
        new ShellSessionError(
          "aborted",
          `Shell call cancelled; no output was read. This cancellation did not stop shell ${sessionId}; poll or terminate it with write_stdin.`,
        ),
      );
      expect(await manager.write({ sessionId, yieldTimeMs: 0 })).toEqual(
        finalResult(first),
      );
      await expect(manager.write({ sessionId })).rejects.toStrictEqual(
        new ShellSessionError(
          "stale-session",
          `Shell session ${sessionId} is unknown or expired. Use any previously returned output recovery paths; never rerun a command merely to recover output.`,
        ),
      );
    });

    it("keeps execution outcome truthful when capture creation is unavailable", async () => {
      const { manager, root } = await setup(
        {},
        {
          openFile: async () => {
            throw new Error("disk unavailable");
          },
        },
      );
      const result = await finish(
        manager,
        await manager.start({
          command: "head -c 2048 /dev/zero | tr '\\0' x; exit 9",
          cwd: root,
          yieldTimeMs: 1000,
          maxOutputBytes: 1024,
        }),
      );
      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(9);
      expect(result.truncated).toBe(true);
      expect(result.recovery?.stdout).toMatchObject({
        state: "unavailable",
        reason: "io-error",
      });
      await manager.close();
      expect(manager.runningCount).toBe(0);
    });

    it("continues bounded previews after a mid-run disk write failure without replay", async () => {
      let writes = 0;
      const { manager, root } = await setup(
        {},
        {
          openFile: async (path) => {
            const file = await open(path, "wx", 0o600);
            return {
              write: (buffer) => {
                if (++writes > 1) return Promise.reject(new Error("ENOSPC"));
                return file.write(buffer);
              },
              close: () => file.close(),
            };
          },
        },
      );
      const first = await manager.start({
        command: "echo once > runs; echo prefix; read line; echo later; exit 3",
        cwd: root,
        yieldTimeMs: 1000,
      });
      const last = await finish(
        manager,
        await manager.write({
          sessionId: first.sessionId,
          input: "go\n",
          yieldTimeMs: 1000,
        }),
      );
      expect(last.status).toBe("completed");
      expect(last.exitCode).toBe(3);
      expect(last.stdout).toBe("later\n");
      expect(last.recovery?.stdout).toMatchObject({
        state: "partial",
        reason: "io-error",
      });
      expect(await readFile(first.recovery!.stdout.path!, "utf8")).toBe(
        "prefix\n",
      );
      expect(await readFile(join(root, "runs"), "utf8")).toBe("once\n");
    });

    it("reports an externally missing recovery file without resurrecting it", async () => {
      const { manager, root } = await setup();
      const first = await manager.start({
        command: "echo before; read line; echo after",
        cwd: root,
        yieldTimeMs: 1000,
      });
      await unlink(first.recovery!.stdout.path!);
      const last = await finish(
        manager,
        await manager.write({
          sessionId: first.sessionId,
          input: "go\n",
          yieldTimeMs: 1000,
        }),
      );
      expect(last.recovery?.stdout).toMatchObject({
        state: "unavailable",
        reason: "missing",
      });
      expect(last.status).toBe("completed");
      await expect(
        readFile(first.recovery!.stdout.path!),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
