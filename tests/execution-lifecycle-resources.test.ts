import { access, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ExecutionOutputOwner } from "../src/execution-output.ts";
import { ShellSessionManager } from "../src/shell/manager.ts";
import {
  withExecutionLifecycleResources,
  type ExecutionLifecycleResources,
} from "./fixtures/execution-lifecycle-resources.ts";

const missing = (path: string) =>
  expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });

describe("opt-in execution fixture ownership", () => {
  it("restores environment and wrappers when setup fails before the body", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const original = ShellSessionManager.prototype.start;
    let owned!: ExecutionLifecycleResources;
    const failure = new Error("partial setup");
    await expect(
      withExecutionLifecycleResources(
        "pct-owned-setup-",
        async () => {
          throw new Error("body must not run");
        },
        (point, resources) => {
          owned = resources;
          if (point === "setup") throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
    expect(ShellSessionManager.prototype.start).toBe(original);
    await missing(owned.root);
  });

  it
    .skipIf(process.platform === "win32")
    .each(["body", "assertion", "shutdown", "restoration"])(
    "settles a real producer/output on %s failure, retaining every error",
    async (failure) => {
      const previous = process.env.PI_CODING_AGENT_DIR;
      const original = ShellSessionManager.prototype.start;
      let owned!: ExecutionLifecycleResources;
      const bodyError = new Error("primary body failure");
      const shutdownError = new Error("shutdown refusal");
      const restoreError = new Error(
        "restoration failed after restoring refusal",
      );
      const result = await withExecutionLifecycleResources(
        "pct-owned-errors-",
        async (resources) => {
          owned = resources;
          const owner = new ExecutionOutputOwner({
            temporaryRoot: resources.root,
          });
          const manager = new ShellSessionManager({
            outputOwner: owner,
            shellConfig: { shell: "/bin/bash", args: ["-c"] },
            terminationGraceMs: 20,
            terminationConfirmMs: 500,
          });
          let refuse = failure === "shutdown" || failure === "restoration";
          resources.shutdown = async () => {
            if (refuse) throw shutdownError;
            await manager.close();
            await owner.close();
          };
          resources.restoreBeforeCleanup.push(() => {
            refuse = false;
            if (failure === "restoration") throw restoreError;
          });
          const started = await manager.start({
            command: "printf owned; read done",
            cwd: resources.root,
            yieldTimeMs: 100,
          });
          expect(started.status).toBe("running");
          expect(await readFile(started.recovery!.stdout.path!, "utf8")).toBe(
            "owned",
          );
          if (failure === "assertion") expect(started.status).toBe("completed");
          throw bodyError;
        },
      ).catch((error: unknown) => error);
      if (failure === "body") expect(result).toBe(bodyError);
      else if (failure === "assertion") expect(result).toBeInstanceOf(Error);
      else {
        expect(result).toBeInstanceOf(AggregateError);
        const errors = (result as AggregateError).errors;
        expect(errors[0]).toBe(bodyError);
        expect(errors[1].errors).toContain(shutdownError);
        if (failure === "restoration")
          expect(errors[1].errors).toContain(restoreError);
      }
      expect([...owned.producers].every((p) => p.runningCount === 0)).toBe(
        true,
      );
      expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
      expect(ShellSessionManager.prototype.start).toBe(original);
      for (const path of [owned.root, ...owned.outputPaths])
        await missing(path);
    },
  );

  it("retains raw shutdown responsibility across a bounded failure and explicit retry", async () => {
    let owned!: ExecutionLifecycleResources;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const raw = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completion: Promise<unknown> | undefined;
    try {
      completion = withExecutionLifecycleResources(
        "pct-owned-pending-",
        async (resources) => {
          owned = resources;
          vi.useFakeTimers();
          resources.shutdown = vi
            .fn()
            .mockImplementationOnce(() => {
              entered();
              return raw;
            })
            .mockResolvedValue(undefined);
        },
      ).catch((error: unknown) => error);
      await ready;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await completion).toBeInstanceOf(AggregateError);
      await access(owned.root);
    } finally {
      release?.();
      await raw;
      vi.useRealTimers();
      await completion;
      await owned?.finalize();
    }
    await missing(owned.root);
  });

  it("does not mistake bounded owner.close for late raw output settlement", async () => {
    let owned!: ExecutionLifecycleResources;
    let release!: () => void;
    const raw = new Promise<void>((resolve) => {
      release = resolve;
    });
    let owner!: ExecutionOutputOwner;
    try {
      const result = await withExecutionLifecycleResources(
        "pct-owned-late-output-",
        async (resources) => {
          owned = resources;
          owner = new ExecutionOutputOwner({
            temporaryRoot: resources.root,
            ioTimeoutMs: 10,
          });
          owner.createCapture({ memoryBytes: 16 });
          // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: track() returns raw, whose executor only stores resolve; awaiting would block until release() in finally
          void owner.track(raw);
          resources.shutdown = () => owner.close();
        },
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect(owner.isClosed).toBe(true);
      await access(owned.root);
    } finally {
      release?.();
      await raw;
      await owned?.finalize();
    }
    await missing(owned.root);
  });
});
