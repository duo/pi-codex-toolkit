import { describe, expect, it, vi } from "vitest";
import { CodeModeAdapters } from "../src/code-mode/adapters.ts";
import { APPLY_PATCH_TOOL_DEFINITION } from "../src/apply-patch.ts";
const cell = { cellId: "pct-cell-test", hostContext: { cwd: process.cwd() } };
const signal = () => new AbortController().signal;
const pause = () => new Promise((r) => setTimeout(r, 20));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const done = {
  sessionId: "pct-shell-fake",
  status: "completed" as const,
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  truncated: false,
  dropped: false,
};

describe("Code Mode dispatch authority", () => {
  it("CM8 validates before requesting Apply Patch confirmation", async () => {
    const approval = vi.fn(async () => true);
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const adapters = new CodeModeAdapters({
      requestApproval: approval,
      applyPatch: { definition: { ...APPLY_PATCH_TOOL_DEFINITION, execute } },
    });
    await expect(
      adapters.call("apply_patch", { typo: "x" }, signal(), cell),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    expect(approval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it("CM8 enforces the actual shell schema including unknown keys and ranges", async () => {
    const start = vi.fn(async () => done);
    const adapters = new CodeModeAdapters({
      shell: { start, write: async () => done },
    });
    for (const args of [
      { command: "x", timeuot: 3 },
      { command: "x", cwd: "" },
      { command: "x", yieldTimeMs: 60001 },
    ]) {
      await expect(
        adapters.call("exec_command", args, signal(), cell),
      ).rejects.toMatchObject({ code: "invalid-arguments" });
    }
    expect(start).not.toHaveBeenCalled();
  });
  it("CM3 rechecks enablement after awaited approval", async () => {
    const approved = gate();
    let enabled = true;
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const adapters = new CodeModeAdapters({
      requestApproval: async () => {
        await approved.promise;
        return true;
      },
      applyPatch: {
        definition: { ...APPLY_PATCH_TOOL_DEFINITION, execute },
        isEnabled: () => enabled,
      },
    });
    const pending = adapters.call(
      "apply_patch",
      { patch: "x" },
      signal(),
      cell,
    );
    await pause();
    enabled = false;
    approved.resolve();
    await expect(pending).rejects.toMatchObject({ code: "adapter-disabled" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("CM3 rechecks enablement inside the granted concurrent slot", async () => {
    const held = gate();
    let enabled = true;
    const start = vi.fn(async () => {
      await held.promise;
      return done;
    });
    const adapters = new CodeModeAdapters({
      maxConcurrentCalls: 1,
      shellEnabled: () => enabled,
      shell: { start, write: async () => done },
    });
    const first = adapters.call(
      "exec_command",
      { command: "first" },
      signal(),
      cell,
    );
    const second = adapters.call(
      "exec_command",
      { command: "second" },
      signal(),
      cell,
    );
    await pause();
    enabled = false;
    held.resolve();
    await first;
    await expect(second).rejects.toMatchObject({ code: "adapter-disabled" });
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("cancels an unsent approval independently of a dialog ignoring abort", async () => {
    const held = gate();
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const adapters = new CodeModeAdapters({
      requestApproval: async () => {
        await held.promise;
        return true;
      },
      applyPatch: { definition: { ...APPLY_PATCH_TOOL_DEFINITION, execute } },
    });
    const controller = new AbortController();
    const pending = adapters
      .call("apply_patch", { patch: "x" }, controller.signal, cell)
      .then(
        () => "ran",
        () => "cancelled",
      );
    try {
      await pause();
      controller.abort();
      expect(await Promise.race([pending, pause().then(() => "blocked")])).toBe(
        "cancelled",
      );
    } finally {
      held.resolve();
      await pending;
    }
    await pause();
    expect(execute).not.toHaveBeenCalled();
  });
  it("rechecks an approval-mode transition while sequential work is queued", async () => {
    const held = gate();
    let mode: "confirm" | "always" = "always";
    const execute = vi.fn(async () => {
      await held.promise;
      return { content: [], details: {} };
    });
    const approval = vi.fn(async () => false);
    const adapters = new CodeModeAdapters({
      approvalMode: () => mode,
      requestApproval: approval,
      applyPatch: { definition: { ...APPLY_PATCH_TOOL_DEFINITION, execute } },
    });
    const first = adapters.call(
      "apply_patch",
      { patch: "one" },
      signal(),
      cell,
    );
    await pause();
    const second = adapters.call(
      "apply_patch",
      { patch: "two" },
      signal(),
      cell,
    );
    mode = "confirm";
    held.resolve();
    await first;
    await expect(second).rejects.toMatchObject({ code: "approval-denied" });
    expect(approval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("bounds direct adapter admission and releases a cancelled queue reservation", async () => {
    const held = gate();
    const start = vi.fn(async () => {
      await held.promise;
      return done;
    });
    const adapters = new CodeModeAdapters({
      maxPendingCalls: 2,
      pendingCallBytes: 100,
      maxConcurrentCalls: 1,
      shell: { start, write: async () => done },
    });
    const first = adapters.call(
      "exec_command",
      { command: "one" },
      signal(),
      cell,
    );
    const controller = new AbortController();
    const second = adapters.call(
      "exec_command",
      { command: "two" },
      controller.signal,
      cell,
    );
    const cancelled = expect(second).rejects.toMatchObject({ code: "aborted" });
    try {
      await expect(
        adapters.call("exec_command", { command: "three" }, signal(), cell),
      ).rejects.toMatchObject({ code: "bridge-overload" });
      controller.abort();
      await cancelled;
      const replacement = adapters.call(
        "exec_command",
        { command: "replacement" },
        signal(),
        cell,
      );
      held.resolve();
      await first;
      await replacement;
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      held.resolve();
      await first;
      await cancelled;
    }
  });
  it("CM1 cancels unsent sequential work independently of an abort-ignoring predecessor", async () => {
    const held = gate();
    const execute = vi.fn(async () => {
      await held.promise;
      return { content: [], details: {} };
    });
    const adapters = new CodeModeAdapters({
      approvalMode: "always",
      applyPatch: { definition: { ...APPLY_PATCH_TOOL_DEFINITION, execute } },
    });
    const first = adapters.call(
      "apply_patch",
      { patch: "first" },
      signal(),
      cell,
    );
    const controller = new AbortController();
    const second = adapters
      .call("apply_patch", { patch: "second" }, controller.signal, cell)
      .then(
        () => "ran",
        () => "cancelled",
      );
    try {
      await pause();
      controller.abort();
      expect(
        await Promise.race([second, pause().then(() => "still queued")]),
      ).toBe("cancelled");
    } finally {
      held.resolve();
      await first;
      await second;
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
