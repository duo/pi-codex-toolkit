import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// A module mock applies to the whole file, so this Worker that cannot start
// lives apart from the Code Mode tests that need a real Worker.
vi.mock(import("node:worker_threads"), async (importOriginal) => {
  const actual = await importOriginal();
  class UnstartableWorker {
    constructor() {
      throw new Error("simulated Worker start failure");
    }
  }
  return {
    ...actual,
    Worker: UnstartableWorker as unknown as typeof actual.Worker,
  };
});

import {
  CodeModeCellManager,
  CodeModeError,
} from "../src/code-mode/manager.ts";
import {
  ExecutionOutputOwner,
  type ExecutionOutputCapture,
} from "../src/execution-output.ts";

describe("Code Mode cell start failure", () => {
  it("rejects as cell-start-failed and releases the cell's three output captures", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-code-start-failure-"));
    const owner = new ExecutionOutputOwner({ temporaryRoot: root });
    // Call-through plumbing that exposes the captures the failed cell created.
    const createCapture = vi.spyOn(owner, "createCapture");
    const manager = new CodeModeCellManager({
      dispatcher: { allowedNames: [], call: async () => undefined },
      outputOwner: owner,
    });
    try {
      await expect(manager.exec({ code: "return 1;" })).rejects.toEqual(
        new CodeModeError(
          "cell-start-failed",
          "Failed to start the Code Mode cell: simulated Worker start failure",
        ),
      );

      // A released capture reports itself unavailable. One still registered
      // with the owner would spill on publish and create a file under the root.
      const captures = createCapture.mock.results.map(
        (result) => result.value as ExecutionOutputCapture,
      );
      const released = {
        state: "unavailable",
        bytes: 0,
        capturedBytes: 0,
        reason: "owner-closed",
      };
      expect(
        await Promise.all(captures.map((capture) => capture.publish())),
      ).toEqual([released, released, released]);
      expect(await readdir(root)).toEqual([]);
    } finally {
      createCapture.mockRestore();
      await manager.close();
      await owner.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
