import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExecutionOutputOwner,
  type ExecutionOutputOwnerOptions,
} from "../src/execution-output.ts";
import { INNER_BUDGET_MS } from "./fixtures/budgets.ts";

const owners: ExecutionOutputOwner[] = [];
const roots: string[] = [];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// One bound covers a real open and first write as well as the held write that is
// meant to exhaust it. Under CPU contention the real operations can take tens to
// hundreds of milliseconds, so they need a bound only the held write can reach.
const REAL_OPEN_IO_TIMEOUT_MS = 1_000;
// A timed-out write releases its file only after its late settlement.
async function lateCleanup(root: string): Promise<void> {
  await vi.waitFor(async () => expect(await readdir(root)).toEqual([]), {
    timeout: INNER_BUDGET_MS,
    interval: 10,
  });
}
async function owner(options: ExecutionOutputOwnerOptions = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pct-capture-test-"));
  roots.push(temporaryRoot);
  const value = new ExecutionOutputOwner({ temporaryRoot, ...options });
  owners.push(value);
  return { owner: value, root: temporaryRoot };
}
afterEach(async () => {
  await Promise.all(owners.splice(0).map((value) => value.close()));
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("execution output capture", () => {
  it("is lazy for startup and small fully delivered text", async () => {
    const { owner: value, root } = await owner();
    expect(await readdir(root)).toEqual([]);
    const capture = value.createCapture({ memoryBytes: 32 });
    await capture.append("small");
    await capture.finish();
    expect(capture.needsRecovery).toBe(false);
    await capture.dispose();
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps the cumulative prefix before spill and privately stores complete UTF-8 text", async () => {
    const { owner: value, root } = await owner();
    const capture = value.createCapture({ memoryBytes: 8 });
    await capture.append("early");
    expect(await readdir(root)).toEqual([]);
    await capture.append("中🙂middle");
    const first = await capture.publish();
    expect(first.state).toBe("capturing");
    await capture.append("late\n");
    await capture.finish();
    const last = await capture.publish();
    expect(last.path).toBe(first.path);
    expect(last.state).toBe("complete");
    expect(last.capturedBytes).toBe(Buffer.byteLength("early中🙂middlelate\n"));
    expect(await readFile(last.path!, "utf8")).toBe("early中🙂middlelate\n");
    if (process.platform !== "win32") {
      expect((await lstat(dirname(last.path!))).mode & 0o777).toBe(0o700);
      expect((await lstat(last.path!)).mode & 0o777).toBe(0o600);
    }
    await capture.dispose();
    expect(await readFile(last.path!, "utf8")).toContain("late");
    await value.close();
    expect(await readdir(root)).toEqual([]);
  });

  it("can publish a tiny terminal remainder after finish without losing earlier text", async () => {
    const { owner: value } = await owner();
    const capture = value.createCapture({ memoryBytes: 256 });
    await capture.append("previously-previewed-");
    await capture.append("unread-terminal-suffix");
    await capture.finish();
    const result = await capture.publish();
    expect(result.state).toBe("complete");
    expect(await readFile(result.path!, "utf8")).toBe(
      "previously-previewed-unread-terminal-suffix",
    );
  });

  it("does not close a pending published file ahead of accepted append/finish work", async () => {
    const held = gate();
    const entered = gate();
    const { owner: value } = await owner({
      openFile: async (path) => {
        entered.resolve();
        await held.promise;
        return open(path, "wx", 0o600);
      },
    });
    const capture = value.createCapture({ memoryBytes: 4 });
    const publishing = capture.publish();
    await entered.promise;
    const appended = capture.append("all-accepted-text");
    const finished = capture.finish();
    held.resolve();
    await Promise.all([publishing, appended, finished]);
    const result = await capture.publish();
    expect(result.state).toBe("complete");
    expect(result.capturedBytes).toBe(result.bytes);
    expect(await readFile(result.path!, "utf8")).toBe("all-accepted-text");
  });

  it("reports unavailable creation without recording payload in error metadata", async () => {
    const { owner: value } = await owner({
      openFile: async () => {
        throw new Error("SECRET_FAULT");
      },
    });
    const capture = value.createCapture({ memoryBytes: 4 });
    await capture.append("SECRET_TEXT");
    await capture.finish();
    expect(await capture.publish()).toMatchObject({
      state: "unavailable",
      reason: "io-error",
      capturedBytes: 0,
    });
    expect(JSON.stringify(await capture.publish())).not.toContain("SECRET");
  });

  it("handles partial writes, then disk failure without claiming completeness", async () => {
    let writes = 0;
    const { owner: value } = await owner({
      openFile: async (path) => {
        const file = await open(path, "wx", 0o600);
        return {
          async write(buffer) {
            if (++writes === 3)
              throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
            return file.write(buffer.subarray(0, 2));
          },
          close: () => file.close(),
        };
      },
    });
    const capture = value.createCapture({ memoryBytes: 4 });
    await capture.append("abcdefghij");
    await capture.append("not-replayed");
    await capture.finish();
    const result = await capture.publish();
    expect(result).toMatchObject({
      state: "partial",
      reason: "io-error",
      capturedBytes: 4,
      bytes: 22,
    });
    expect(await readFile(result.path!, "utf8")).toBe("abcd");
    expect(writes).toBe(3);
  });

  it("bounds admitted count/bytes even when a producer ignores backpressure", async () => {
    const held = gate();
    const entered = gate();
    const { owner: value } = await owner({
      openFile: async (path) => {
        entered.resolve();
        await held.promise;
        return open(path, "wx", 0o600);
      },
    });
    const capture = value.createCapture({
      memoryBytes: 4,
      pendingBytes: 12,
      pendingChunks: 2,
    });
    await capture.append("abcd");
    const a = capture.append("efgh");
    await entered.promise;
    const b = capture.append("ijkl");
    const rejected = capture.append("mnop");
    // Test-only finite counter inspection, not a process-memory/OOM claim.
    const internal = capture as unknown as {
      pendingBytes: number;
      pendingChunks: number;
    };
    expect(internal.pendingBytes).toBe(8);
    expect(internal.pendingChunks).toBe(2);
    held.resolve();
    await Promise.all([a, b, rejected]);
    expect(internal.pendingBytes).toBe(0);
    expect(internal.pendingChunks).toBe(0);
    expect(await capture.publish()).toMatchObject({
      state: "partial",
      reason: "overload",
      bytes: 16,
    });
  });

  it("bounds a hung write, resumes producers with explicit loss, and cleans only after late settlement", async () => {
    const held = gate();
    const { owner: value, root } = await owner({
      ioTimeoutMs: REAL_OPEN_IO_TIMEOUT_MS,
      openFile: async (path) => {
        const file = await open(path, "wx", 0o600);
        return {
          write: async (buffer) => {
            await held.promise;
            return file.write(buffer);
          },
          close: () => file.close(),
        };
      },
    });
    const capture = value.createCapture({ memoryBytes: 4 });
    try {
      await capture.append("123456");
      const result = await capture.publish();
      expect(result).toMatchObject({ state: "partial", reason: "io-timeout" });
      await capture.append("later");
      await capture.finish();
      await value.close();
      // No unlink while the write still owns its descriptor.
      expect(await readdir(root)).toHaveLength(1);
    } finally {
      held.resolve();
    }
    await lateCleanup(root);
  });

  it("cleans an exclusive file whose open completes after owner shutdown", async () => {
    const held = gate();
    const { owner: value, root } = await owner({
      ioTimeoutMs: 20,
      openFile: async (path) => {
        await held.promise;
        return open(path, "wx", 0o600);
      },
    });
    const capture = value.createCapture({ memoryBytes: 4 });
    try {
      await capture.append("123456");
      expect(await capture.publish()).toMatchObject({
        state: "unavailable",
        reason: "io-timeout",
      });
      await value.close();
    } finally {
      held.resolve();
    }
    await lateCleanup(root);
  });

  it("reports a missing published source and never recreates or replays it", async () => {
    const { owner: value } = await owner();
    const capture = value.createCapture({ memoryBytes: 4 });
    await capture.append("abcdef");
    const first = await capture.publish();
    await unlink(first.path!);
    expect(await capture.publish()).toMatchObject({
      state: "unavailable",
      reason: "missing",
      path: first.path,
    });
    await capture.append("lost-too");
    await capture.finish();
    await expect(readFile(first.path!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["io-error", "io-timeout"] as const)(
    "reports a missing source after %s rather than a readable partial file",
    async (reason) => {
      let writes = 0;
      const held = gate();
      const { owner: value } = await owner({
        ioTimeoutMs: REAL_OPEN_IO_TIMEOUT_MS,
        openFile: async (path) => {
          const file = await open(path, "wx", 0o600);
          return {
            async write(buffer) {
              if (++writes > 1) {
                if (reason === "io-error") throw new Error("disk full");
                await held.promise;
              }
              return file.write(buffer);
            },
            close: () => file.close(),
          };
        },
      });
      const capture = value.createCapture({ memoryBytes: 4 });
      try {
        await capture.append("prefix");
        await capture.append("lost suffix");
        await capture.finish();
        const partial = await capture.publish();
        expect(partial).toMatchObject({ state: "partial", reason });
        await unlink(partial.path!);
        expect(await capture.publish()).toMatchObject({
          state: "unavailable",
          reason: "missing",
          capturedBytes: 6,
          bytes: 17,
        });
        await expect(readFile(partial.path!)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        held.resolve();
      }
    },
  );

  it("does not write to or remove a foreign replacement of a published path", async () => {
    const { owner: value } = await owner();
    const capture = value.createCapture({ memoryBytes: 4 });
    await capture.append("owned-original");
    const original = (await capture.publish()).path!;
    const moved = `${original}.moved`;
    await rename(original, moved);
    await writeFile(original, "foreign-replacement");
    expect(await capture.publish()).toMatchObject({
      state: "unavailable",
      reason: "missing",
    });
    await capture.append("must-not-append");
    await capture.finish();
    await value.close();
    expect(await readFile(original, "utf8")).toBe("foreign-replacement");
    expect(await readFile(moved, "utf8")).toBe("owned-original");
  });

  it("does not remove another owner's or an unrelated file", async () => {
    const { owner: a } = await owner();
    const { owner: b } = await owner();
    const ca = a.createCapture({ memoryBytes: 4 });
    const cb = b.createCapture({ memoryBytes: 4 });
    await ca.append("owner-a");
    await cb.append("owner-b");
    const pa = (await ca.publish()).path!;
    const pb = (await cb.publish()).path!;
    const foreign = join(dirname(pa), "foreign.txt");
    await writeFile(foreign, "not-owned");
    await a.close();
    expect(await readFile(foreign, "utf8")).toBe("not-owned");
    expect(await readFile(pb, "utf8")).toBe("owner-b");
    await cb.finish();
    expect((await cb.publish()).state).toBe("complete");
  });
});
