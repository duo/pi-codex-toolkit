import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodeModeCellManager } from "../../src/code-mode/manager.ts";
import { ExecutionOutputOwner } from "../../src/execution-output.ts";
import { ShellSessionManager } from "../../src/shell/manager.ts";

type Producer = CodeModeCellManager | ShellSessionManager;
export interface ExecutionLifecycleResources {
  root: string;
  producers: Set<Producer>;
  outputPaths: Set<string>;
  shutdown?: () => unknown;
  restoreBeforeCleanup: Array<() => unknown>;
  checkpoint(point: string): void;
  /** Retained responsibility after a bounded failure; retry only after releasing the fault. */
  finalize(): Promise<void>;
}
export type ExecutionLifecycleProbe = (
  point: string,
  resources: ExecutionLifecycleResources,
) => void;

async function absent(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Owned execution fixture path remains: ${path}`);
}

// Opt-in to serial Code/Shell factory fixtures, not a host/registry replacement.
export async function withExecutionLifecycleResources(
  prefix: string,
  body: (resources: ExecutionLifecycleResources) => Promise<void>,
  probe?: ExecutionLifecycleProbe,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const errors: unknown[] = [];
  const owners = new Set<ExecutionOutputOwner>();
  const starts = new Set<Promise<unknown>>();
  const pendingCleanup = new Set<Promise<unknown>>();
  const restores: Array<() => void> = [];
  const shellStart = ShellSessionManager.prototype.start;
  const codeExec = CodeModeCellManager.prototype.exec;
  const shellClose = ShellSessionManager.prototype.close;
  const codeClose = CodeModeCellManager.prototype.close;
  const createCapture = ExecutionOutputOwner.prototype.createCapture;
  const createFile = ExecutionOutputOwner.prototype.createFile;
  let finalizing: Promise<void> | undefined;
  let removed = false;
  const trackStart = <T>(pending: Promise<T>): Promise<T> => {
    starts.add(pending);
    void pending.finally(() => starts.delete(pending)).catch(() => undefined);
    return pending;
  };
  const bounded = async (operation: () => unknown): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const raw = Promise.resolve().then(operation);
    pendingCleanup.add(raw);
    void raw.finally(() => pendingCleanup.delete(raw)).catch(() => undefined);
    try {
      await Promise.race([
        raw,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("Execution fixture cleanup exceeded 20 seconds"),
              ),
            20_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const resources: ExecutionLifecycleResources = {
    root,
    producers: new Set(),
    outputPaths: new Set(),
    restoreBeforeCleanup: [],
    checkpoint: (point) => probe?.(point, resources),
    finalize: () => {
      if (removed) return Promise.resolve();
      if (finalizing) return finalizing;
      const run = async () => {
        const failures: unknown[] = [];
        const attempt = async (operation: () => unknown) => {
          try {
            await bounded(operation);
            return true;
          } catch (error) {
            failures.push(error);
            return false;
          }
        };
        const shutdown = () => {
          if ((owners.size || resources.producers.size) && !resources.shutdown)
            throw new Error("Owned execution fixture has no shutdown handler");
          return resources.shutdown?.();
        };
        let shutdownSettled = await attempt(shutdown);
        for (const restore of resources.restoreBeforeCleanup.splice(0))
          await attempt(restore);
        const producersSettled = await attempt(async () => {
          const results = await Promise.allSettled(
            [...resources.producers].map((producer) =>
              producer instanceof ShellSessionManager
                ? shellClose.call(producer)
                : codeClose.call(producer),
            ),
          );
          const rejected = results.flatMap((r) =>
            r.status === "rejected" ? [r.reason] : [],
          );
          if (rejected.length)
            throw new AggregateError(rejected, "Owned producer rescue failed");
        });
        const startsSettled = await attempt(() =>
          Promise.allSettled([...starts]),
        );
        if (
          !shutdownSettled &&
          producersSettled &&
          startsSettled &&
          !pendingCleanup.size
        )
          shutdownSettled = await attempt(shutdown);
        const outputSettled =
          shutdownSettled &&
          (await attempt(async () => {
            if (
              [...resources.producers].some((producer) => producer.runningCount)
            )
              throw new Error("Owned execution producer is still live");
            for (const owner of owners) {
              // White-box settlement check: close() is bounded and does not expose its
              // raw cleanup. Never infer OS settlement solely from that returned promise.
              const state = owner as unknown as {
                operations: Set<Promise<unknown>>;
                directory?: Promise<string>;
              };
              if (!owner.isClosed || state.operations.size)
                throw new Error(
                  "Owned output has pending raw operations or is not closed",
                );
              const directory = await state.directory;
              if (directory) await absent(directory);
            }
            for (const path of resources.outputPaths) await absent(path);
          }));
        if (
          shutdownSettled &&
          producersSettled &&
          startsSettled &&
          outputSettled &&
          !pendingCleanup.size
        ) {
          if (await attempt(() => rm(root, { recursive: true, force: true })))
            removed = true;
        }
        if (!removed)
          failures.push(
            new Error(
              `Execution fixture cleanup unconfirmed; retained owned root: ${root}`,
            ),
          );
        if (failures.length)
          throw new AggregateError(
            failures,
            `Execution fixture finalization failed: ${root}`,
          );
      };
      finalizing = run().finally(() => {
        finalizing = undefined;
      });
      return finalizing;
    },
  };
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    // Plain wrappers compose with each body's vi.spyOn; spying on an existing
    // Vitest spy would reuse it and make captured original methods recursive.
    ShellSessionManager.prototype.start = function (...args) {
      resources.producers.add(this);
      return trackStart(shellStart.apply(this, args));
    };
    restores.push(() => {
      ShellSessionManager.prototype.start = shellStart;
    });
    CodeModeCellManager.prototype.exec = function (...args) {
      resources.producers.add(this);
      return trackStart(codeExec.apply(this, args));
    };
    restores.push(() => {
      CodeModeCellManager.prototype.exec = codeExec;
    });
    ExecutionOutputOwner.prototype.createCapture = function (...args) {
      owners.add(this);
      return createCapture.apply(this, args);
    };
    restores.push(() => {
      ExecutionOutputOwner.prototype.createCapture = createCapture;
    });
    ExecutionOutputOwner.prototype.createFile = function () {
      owners.add(this);
      return createFile.call(this).then((created) => {
        resources.outputPaths.add(created.path);
        resources.outputPaths.add(dirname(created.path));
        return created;
      });
    };
    restores.push(() => {
      ExecutionOutputOwner.prototype.createFile = createFile;
    });
    resources.checkpoint("setup");
    await body(resources);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await resources.finalize();
    } catch (error) {
      errors.push(error);
    }
    // Independent restores: one failure cannot skip the environment or another mock.
    for (const restore of restores.reverse()) {
      try {
        restore();
      } catch (error) {
        errors.push(error);
      }
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    try {
      resources.checkpoint("finalized");
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      `Execution fixture body/cleanup failed: ${root}`,
    );
}
