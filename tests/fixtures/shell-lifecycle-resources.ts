import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import { ShellSessionManager } from "../../src/shell/manager.ts";

export type ShellLifecycleCheckpoint =
  | "setup"
  | "before-spawn"
  | "after-spawn"
  | "finalized";
export type ShellLifecycleProbe = (
  point: ShellLifecycleCheckpoint,
  resources: ShellLifecycleResources,
) => void;

export interface ShellLifecycleResources {
  root: string;
  managers: Set<ShellSessionManager>;
  pids: Set<number>;
  outputPaths: Set<string>;
  shutdown?: () => unknown;
  restoreBeforeRescue: Array<() => void>;
  checkpoint(point: ShellLifecycleCheckpoint): void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

// Local to the two Shell lifecycle fixtures, not a replacement host harness.
// A timeout is a failure, never evidence that an outstanding producer/I/O stopped.
async function bounded(
  operation: () => unknown,
  pendingCleanups: Set<Promise<unknown>>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const pending = Promise.resolve().then(operation);
  pendingCleanups.add(pending);
  try {
    await Promise.race([
      pending.finally(() => pendingCleanups.delete(pending)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Shell fixture cleanup exceeded 20 seconds")),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function withShellLifecycleResources(
  prefix: "pct-shell-lifecycle-" | "pct-shell-conflict-",
  body: (resources: ShellLifecycleResources) => Promise<void>,
  probe?: ShellLifecycleProbe,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const errors: unknown[] = [];
  const starts: Promise<unknown>[] = [];
  const pendingCleanups = new Set<Promise<unknown>>();
  const originalStart = ShellSessionManager.prototype.start;
  const originalClose = ShellSessionManager.prototype.close;
  let restoreStart: (() => void) | undefined;
  const resources: ShellLifecycleResources = {
    root,
    managers: new Set(),
    pids: new Set(),
    outputPaths: new Set(),
    restoreBeforeRescue: [],
    checkpoint: (point) => probe?.(point, resources),
  };
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const start = vi
      .spyOn(ShellSessionManager.prototype, "start")
      .mockImplementation(function (this: ShellSessionManager, ...args) {
        // Capture responsibility before start can spawn, reject, or yield.
        resources.managers.add(this);
        const pending = originalStart.apply(this, args).then((result) => {
          // These two fixtures print their leader PID; never use it for rescue
          // targeting. The actual captured manager owns every started process.
          const pid = Number(result.stdout.trim());
          if (Number.isSafeInteger(pid) && pid > 0) resources.pids.add(pid);
          for (const recovery of Object.values(result.recovery ?? {})) {
            if (recovery.path) resources.outputPaths.add(recovery.path);
          }
          return result;
        });
        starts.push(pending);
        return pending;
      });
    restoreStart = () => start.mockRestore();
    resources.checkpoint("setup");
    await body(resources);
  } catch (error) {
    errors.push(error);
  } finally {
    const attempt = async (operation: () => unknown): Promise<boolean> => {
      try {
        await bounded(operation, pendingCleanups);
        return true;
      } catch (error) {
        errors.push(error);
        return false;
      }
    };
    try {
      const shutdown = () => {
        if (resources.managers.size && !resources.shutdown) {
          throw new Error(
            "Owned Shell fixture has no registered shutdown handler",
          );
        }
        return resources.shutdown?.();
      };
      let shutdownSettled = await attempt(shutdown);
      // Fault probes restore only their own refusal before exact-owner rescue.
      // Do not restore all mocks: that could erase a concurrent fixture's state.
      for (const restore of resources.restoreBeforeRescue) {
        await attempt(restore);
      }
      const managersSettled = await attempt(async () => {
        const results = await Promise.allSettled(
          [...resources.managers].map((manager) =>
            Promise.resolve().then(() => originalClose.call(manager)),
          ),
        );
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, "Owned manager rescue failed");
      });
      const startsSettled = await attempt(() => Promise.allSettled(starts));
      // The handler also owns shared output files. Rescue does not substitute
      // fake success for it: retry after removing the injected refusal.
      if (!shutdownSettled && managersSettled && startsSettled) {
        shutdownSettled = await attempt(shutdown);
      }
      const producersSettled = await attempt(() => {
        if (
          [...resources.managers].some(
            (manager) => manager.runningCount !== 0,
          ) ||
          [...resources.pids].some(
            (pid) =>
              alive(pid) || (process.platform !== "win32" && alive(-pid)),
          )
        ) {
          throw new Error("Owned Shell fixture process is still live");
        }
      });
      const outputSettled =
        shutdownSettled &&
        (await attempt(async () => {
          // Output owners allocate outside the agent root. Check their exact
          // published files AND directories; never sweep a pct-output prefix.
          const paths = new Set(
            [...resources.outputPaths].flatMap((path) => [path, dirname(path)]),
          );
          for (const path of paths) {
            try {
              await access(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
              throw error;
            }
            throw new Error(`Owned Shell fixture output remains: ${path}`);
          }
        }));
      if (
        shutdownSettled &&
        managersSettled &&
        startsSettled &&
        producersSettled &&
        outputSettled &&
        pendingCleanups.size === 0
      ) {
        await attempt(() => rm(root, { recursive: true, force: true }));
      } else {
        errors.push(
          new Error(
            `Shell fixture cleanup unconfirmed; retained owned root: ${root}`,
          ),
        );
      }
    } finally {
      // Restoration must also survive shutdown, rescue, and removal failures.
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      try {
        restoreStart?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        resources.checkpoint("finalized");
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Shell fixture body/cleanup failed: ${root}`,
    );
  }
}
