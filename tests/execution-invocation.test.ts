import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createApplyPatchTool } from "../src/apply-patch.ts";
import { CodeModeAdapters } from "../src/code-mode/adapters.ts";
import { APPLY_PATCH_TOOL_DEFINITION } from "../src/apply-patch.ts";
import type { CodeModeCellContext } from "../src/code-mode/manager.ts";
import {
  resolveInvocation,
  ExecutionPolicyError,
  type ExecutionInvocationCall,
  type ExecutionInvocationHooks,
} from "../src/execution-invocation.ts";
import { ShellSessionManager } from "../src/shell/manager.ts";
import {
  createShellTools,
  EXEC_COMMAND_TOOL,
  WRITE_STDIN_TOOL,
} from "../src/shell/tools.ts";

const managers: ShellSessionManager[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

function manager(): ShellSessionManager {
  const created = new ShellSessionManager({
    env: { ...process.env, PCT_BASE: "base" },
  });
  managers.push(created);
  return created;
}

function context(cwd = process.cwd()): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

function cell(cellId = "pct-cell-hooks"): CodeModeCellContext {
  return { cellId, hostContext: context() };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** One command that prints both the inherited base and the overlay value. */
const PRINT_ENV = 'printf "%s/%s" "$PCT_BASE" "$PCT_OVERLAY"';

/** A deterministic checkpoint: no timers, no polling. */
function gate(): { reached: Promise<void>; open: () => void } {
  let open!: () => void;
  const reached = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { reached, open };
}

/**
 * Hooks that hold one call inside the policy step until the test releases
 * them, reproducing an asynchronous embedder policy (an approval round trip,
 * a parent query) that outlives the entry admission check.
 */
function holdingHooks(): {
  hooks: ExecutionInvocationHooks;
  entered: Promise<void>;
  release: () => void;
} {
  const entered = gate();
  const released = gate();
  return {
    entered: entered.reached,
    release: released.open,
    hooks: {
      policy: async () => {
        entered.open();
        await released.reached;
        return { allow: true };
      },
    },
  };
}

function recordingHooks(
  env: Record<string, string> | undefined,
  decide: (call: ExecutionInvocationCall) => boolean = () => true,
): {
  hooks: ExecutionInvocationHooks;
  calls: ExecutionInvocationCall[];
} {
  const calls: ExecutionInvocationCall[] = [];
  return {
    calls,
    hooks: {
      context: (call) => {
        calls.push(call);
        return env === undefined ? undefined : { env };
      },
      policy: (call) =>
        decide(call)
          ? { allow: true }
          : { allow: false, reason: "fixture policy" },
    },
  };
}

describe("execution invocation seam", () => {
  it("resolves nothing and asks nothing without hooks", async () => {
    await expect(
      resolveInvocation(undefined, {
        tool: EXEC_COMMAND_TOOL,
        path: "direct",
        cwd: process.cwd(),
      }),
    ).resolves.toEqual({});
    await expect(
      resolveInvocation(
        {},
        { tool: EXEC_COMMAND_TOOL, path: "nested", cwd: process.cwd() },
      ),
    ).resolves.toEqual({});
  });

  it("rejects a malformed environment overlay before any effect", async () => {
    for (const env of [
      "PCT=1" as unknown as Record<string, string>,
      { PCT_OVERLAY: 1 } as unknown as Record<string, string>,
    ]) {
      await expect(
        resolveInvocation(
          { context: () => ({ env }) },
          { tool: EXEC_COMMAND_TOOL, path: "direct", cwd: process.cwd() },
        ),
      ).rejects.toBeInstanceOf(ExecutionPolicyError);
    }
  });

  it("supplies the same environment to the direct and nested shell paths", async () => {
    const shell = manager();
    const direct = recordingHooks({ PCT_OVERLAY: "supplied" });
    const nested = recordingHooks({ PCT_OVERLAY: "supplied" });
    const tools = new Map(
      createShellTools(shell, {
        isStartEnabled: () => true,
        isContinueEnabled: () => true,
        invocationHooks: direct.hooks,
      }).map((tool) => [tool.name, tool as ToolDefinition]),
    );
    const adapters = new CodeModeAdapters({
      shell,
      invocationHooks: nested.hooks,
    });

    const directResult = (
      await tools
        .get(EXEC_COMMAND_TOOL)!
        .execute(
          "call-1",
          { cmd: PRINT_ENV, yield_time_ms: 5000 },
          undefined,
          undefined,
          context(),
        )
    ).details as { stdout: string };
    const nestedResult = (await adapters.call(
      EXEC_COMMAND_TOOL,
      { cmd: PRINT_ENV, yield_time_ms: 5000 },
      signal(),
      cell(),
    )) as { stdout: string };

    expect(directResult.stdout).toBe("base/supplied");
    expect(nestedResult.stdout).toBe(directResult.stdout);
    // A named workdir resolves identically on both paths.
    await tools
      .get(EXEC_COMMAND_TOOL)!
      .execute(
        "call-2",
        { cmd: PRINT_ENV, workdir: ".", yield_time_ms: 5000 },
        undefined,
        undefined,
        context(),
      );
    await adapters.call(
      EXEC_COMMAND_TOOL,
      { cmd: PRINT_ENV, workdir: ".", yield_time_ms: 5000 },
      signal(),
      cell(),
    );
    expect(direct.calls.at(-1)?.cwd).toBe(process.cwd());
    expect(nested.calls.at(-1)?.cwd).toBe(process.cwd());
    expect(direct.calls[0]).toEqual({
      tool: EXEC_COMMAND_TOOL,
      path: "direct",
      cwd: process.cwd(),
    });
    expect(nested.calls[0]).toEqual({
      tool: EXEC_COMMAND_TOOL,
      path: "nested",
      cwd: process.cwd(),
      cellId: "pct-cell-hooks",
    });
  });

  it("keeps an overlay out of later calls, other sessions and the manager", async () => {
    const shell = manager();
    let overlay: Record<string, string> | undefined = {
      PCT_OVERLAY: "first-call",
    };
    const tools = new Map(
      createShellTools(shell, {
        isStartEnabled: () => true,
        isContinueEnabled: () => true,
        invocationHooks: { context: () => (overlay ? { env: overlay } : {}) },
      }).map((tool) => [tool.name, tool as ToolDefinition]),
    );
    const run = async (): Promise<string> =>
      (
        (
          await tools
            .get(EXEC_COMMAND_TOOL)!
            .execute(
              "call",
              { cmd: PRINT_ENV, yield_time_ms: 5000 },
              undefined,
              undefined,
              context(),
            )
        ).details as { stdout: string }
      ).stdout;

    expect(await run()).toBe("base/first-call");
    overlay = undefined;
    expect(await run()).toBe("base/");
    // A second manager never sees another session's supplied value.
    const other = manager();
    const otherResult = await other.start({
      command: PRINT_ENV,
      cwd: process.cwd(),
      yieldTimeMs: 5000,
    });
    expect(otherResult.stdout).toBe("base/");
    expect(process.env.PCT_OVERLAY).toBeUndefined();
  });

  it("denies direct and nested calls before any effect", async () => {
    const shell = manager();
    const start = vi.spyOn(shell, "start");
    const write = vi.spyOn(shell, "write");
    const denied = recordingHooks(undefined, () => false);
    const tools = new Map(
      createShellTools(shell, {
        isStartEnabled: () => true,
        isContinueEnabled: () => true,
        invocationHooks: denied.hooks,
      }).map((tool) => [tool.name, tool as ToolDefinition]),
    );
    const adapters = new CodeModeAdapters({
      shell,
      invocationHooks: denied.hooks,
    });

    await expect(
      tools
        .get(EXEC_COMMAND_TOOL)!
        .execute(
          "call-1",
          { cmd: "printf denied" },
          undefined,
          undefined,
          context(),
        ),
    ).rejects.toThrow(
      "exec_command was denied by the Toolkit invocation policy: fixture policy. Nothing ran.",
    );
    await expect(
      tools
        .get(WRITE_STDIN_TOOL)!
        .execute(
          "call-2",
          { session_id: "pct-shell-missing" },
          undefined,
          undefined,
          context(),
        ),
    ).rejects.toThrow("write_stdin was denied by the Toolkit invocation");
    await expect(
      adapters.call(
        EXEC_COMMAND_TOOL,
        { cmd: "printf denied" },
        signal(),
        cell(),
      ),
    ).rejects.toMatchObject({ code: "policy-denied" });
    expect(start).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(denied.calls.map((call) => [call.tool, call.path])).toEqual([
      [EXEC_COMMAND_TOOL, "direct"],
      [WRITE_STDIN_TOOL, "direct"],
      [EXEC_COMMAND_TOOL, "nested"],
    ]);
  });

  it("denies direct and nested Apply Patch before the filesystem is touched", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-invocation-"));
    directories.push(root);
    const denied = recordingHooks(undefined, () => false);
    const direct = createApplyPatchTool(() => true, denied.hooks);
    const adapters = new CodeModeAdapters({
      applyPatch: { definition: APPLY_PATCH_TOOL_DEFINITION },
      approvalMode: "always",
      invocationHooks: denied.hooks,
    });
    const patch =
      "*** Begin Patch\n*** Add File: denied.txt\n+no\n*** End Patch";

    await expect(
      direct.execute("call-1", { patch }, undefined, undefined, context(root)),
    ).rejects.toThrow(
      "apply_patch was denied by the Toolkit invocation policy: fixture policy. Nothing ran.",
    );
    await expect(
      adapters.call(APPLY_PATCH_TOOL_DEFINITION.name, patch, signal(), {
        cellId: "pct-cell-patch",
        hostContext: context(root),
      }),
    ).rejects.toMatchObject({ code: "policy-denied" });
    await expect(
      rm(join(root, "denied.txt"), { force: false }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(denied.calls.map((call) => call.path)).toEqual(["direct", "nested"]);
  });

  it("applies the seam before the nested Patch confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-invocation-order-"));
    directories.push(root);
    const order: string[] = [];
    const approval = vi.fn(async () => {
      order.push("approval");
      return true;
    });
    const hooks = (allow: boolean): ExecutionInvocationHooks => ({
      context: () => {
        order.push("context");
        return undefined;
      },
      policy: () => {
        order.push("policy");
        return allow
          ? { allow: true }
          : { allow: false, reason: "fixture policy" };
      },
    });
    const build = (allow: boolean): CodeModeAdapters =>
      new CodeModeAdapters({
        applyPatch: { definition: APPLY_PATCH_TOOL_DEFINITION },
        approvalMode: "confirm",
        requestApproval: approval,
        invocationHooks: hooks(allow),
      });
    const patch = (path: string): string =>
      `*** Begin Patch\n*** Add File: ${path}\n+no\n*** End Patch`;

    // Denied: the dialog is never opened and nothing is written.
    await expect(
      build(false).call(
        APPLY_PATCH_TOOL_DEFINITION.name,
        patch("denied.txt"),
        signal(),
        { cellId: "pct-cell-order", hostContext: context(root) },
      ),
    ).rejects.toMatchObject({ code: "policy-denied" });
    expect(approval).not.toHaveBeenCalled();
    expect(order).toEqual(["context", "policy"]);
    await expect(
      rm(join(root, "denied.txt"), { force: false }),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Allowed: the same seam still runs first, then the approval, then the
    // executor.
    order.length = 0;
    await build(true).call(
      APPLY_PATCH_TOOL_DEFINITION.name,
      patch("approved.txt"),
      signal(),
      { cellId: "pct-cell-order", hostContext: context(root) },
    );
    expect(order).toEqual(["context", "policy", "approval"]);
    expect(approval).toHaveBeenCalledTimes(1);
    await rm(join(root, "approved.txt"));
  });

  it("refuses a direct Apply Patch disabled while its hook was pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-invocation-late-"));
    directories.push(root);
    let enabled = true;
    const held = holdingHooks();
    const direct = createApplyPatchTool(() => enabled, held.hooks);
    const call = direct.execute(
      "call-1",
      {
        patch: "*** Begin Patch\n*** Add File: late.txt\n+no\n*** End Patch",
      },
      undefined,
      undefined,
      context(root),
    );

    // The contraction lands while the policy hook still holds the call.
    await held.entered;
    enabled = false;
    held.release();

    await expect(call).rejects.toThrow("Apply Patch is not enabled.");
    await expect(
      rm(join(root, "late.txt"), { force: false }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses direct shell calls disabled while their hook was pending", async () => {
    const shell = manager();
    const start = vi.spyOn(shell, "start");
    const write = vi.spyOn(shell, "write");
    let enabled = true;
    const startHold = holdingHooks();
    const writeHold = holdingHooks();
    const build = (hooks: ExecutionInvocationHooks) =>
      new Map(
        createShellTools(shell, {
          isStartEnabled: () => enabled,
          isContinueEnabled: () => enabled,
          invocationHooks: hooks,
        }).map((tool) => [tool.name, tool as ToolDefinition]),
      );

    const started = build(startHold.hooks)
      .get(EXEC_COMMAND_TOOL)!
      .execute(
        "call-1",
        { cmd: "printf late", yield_time_ms: 0 },
        undefined,
        undefined,
        context(),
      );
    await startHold.entered;
    enabled = false;
    startHold.release();
    await expect(started).rejects.toThrow("Shell Sessions are not enabled.");
    expect(start).not.toHaveBeenCalled();

    enabled = true;
    const continued = build(writeHold.hooks)
      .get(WRITE_STDIN_TOOL)!
      .execute(
        "call-2",
        { session_id: "pct-shell-late", chars: "late" },
        undefined,
        undefined,
        context(),
      );
    await writeHold.entered;
    enabled = false;
    writeHold.release();
    // Without the recheck this reaches the manager and fails as an invalid
    // handle, which is a dispatch the disabled capability must not make.
    await expect(continued).rejects.toThrow("Shell Sessions are not enabled.");
    expect(write).not.toHaveBeenCalled();
  });

  it("never runs a direct shell call on a replacement session's manager", async () => {
    const original = manager();
    const replacement = manager();
    let current = original;
    const originalStart = vi.spyOn(original, "start");
    const replacementStart = vi.spyOn(replacement, "start");
    const held = holdingHooks();
    const tools = new Map(
      createShellTools(() => current, {
        isStartEnabled: () => true,
        isContinueEnabled: () => true,
        invocationHooks: held.hooks,
      }).map((tool) => [tool.name, tool as ToolDefinition]),
    );

    const call = tools
      .get(EXEC_COMMAND_TOOL)!
      .execute(
        "call-1",
        { cmd: "printf replaced", yield_time_ms: 0 },
        undefined,
        undefined,
        context(),
      );
    // Pi replaces the session while the hook holds the call.
    await held.entered;
    current = replacement;
    held.release();

    await expect(call).rejects.toThrow(
      "The shell session owner was replaced while this call was pending; no command was dispatched.",
    );
    expect(originalStart).not.toHaveBeenCalled();
    expect(replacementStart).not.toHaveBeenCalled();

    // The continuation path binds the same way: a handle only exists on the
    // manager that issued it, so a replaced binding refuses before any
    // submission and reports that nothing was sent.
    current = original;
    const originalWrite = vi.spyOn(original, "write");
    const replacementWrite = vi.spyOn(replacement, "write");
    const continueHold = holdingHooks();
    const continued = new Map(
      createShellTools(() => current, {
        isStartEnabled: () => true,
        isContinueEnabled: () => true,
        invocationHooks: continueHold.hooks,
      }).map((tool) => [tool.name, tool as ToolDefinition]),
    )
      .get(WRITE_STDIN_TOOL)!
      .execute(
        "call-2",
        { session_id: "pct-shell-replaced", chars: "late" },
        undefined,
        undefined,
        context(),
      );
    await continueHold.entered;
    current = replacement;
    continueHold.release();

    await expect(continued).rejects.toMatchObject({
      code: "manager-closed",
      inputDelivery: "not-sent",
    });
    expect(originalWrite).not.toHaveBeenCalled();
    expect(replacementWrite).not.toHaveBeenCalled();
  });

  it("names the shell handle a continuation call carries", async () => {
    const shell = manager();
    const seen = recordingHooks(undefined);
    const adapters = new CodeModeAdapters({
      shell,
      invocationHooks: seen.hooks,
    });
    const started = (await adapters.call(
      EXEC_COMMAND_TOOL,
      { cmd: "cat", yield_time_ms: 0 },
      signal(),
      cell(),
    )) as { sessionId: string };

    await adapters.call(
      WRITE_STDIN_TOOL,
      { session_id: started.sessionId, terminate: true },
      signal(),
      cell(),
    );

    expect(seen.calls).toEqual([
      {
        tool: EXEC_COMMAND_TOOL,
        path: "nested",
        cwd: process.cwd(),
        cellId: "pct-cell-hooks",
      },
      {
        tool: WRITE_STDIN_TOOL,
        path: "nested",
        cwd: process.cwd(),
        cellId: "pct-cell-hooks",
        sessionId: started.sessionId,
      },
    ]);
  });
});
