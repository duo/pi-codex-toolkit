import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createPiCodexToolkit } from "../src/index.ts";
import { defaultConfig } from "../src/config.ts";
import type { ExecutionInvocationHooks } from "../src/execution-invocation.ts";
import { otherModel } from "./fixtures.ts";
import {
  CodeModeCellManager,
  type CodeModeCellResult,
} from "../src/code-mode/manager.ts";
import {
  ShellSessionManager,
  type ShellSessionResult,
} from "../src/shell/manager.ts";
import { APPLY_PATCH_TOOL_DEFINITION } from "../src/apply-patch.ts";
import { withExecutionLifecycleResources } from "./fixtures/execution-lifecycle-resources.ts";
import { restoreStopConfirmationWindow } from "./fixtures/code-mode-stops.ts";
import { withEventBus } from "./fixtures/extension-events.ts";

// Factory registry/lifecycle is mocked; executions and private recovery files are real.
async function harness(
  run: (h: {
    root: string;
    config: ReturnType<typeof defaultConfig>;
    reload(): Promise<void>;
    event(name: string): Promise<unknown>;
    foreign(name?: string): void;
    approve(callback: () => Promise<boolean>): void;
    failNotice(): void;
    call(
      name: string,
      args: unknown,
      onUpdate?: (partial: { details: unknown }) => void,
    ): Promise<any>;
  }) => Promise<void>,
  options: { invocationHooks?: ExecutionInvocationHooks } = {},
) {
  return withExecutionLifecycleResources(
    "pct-code-session-",
    async (resources) => {
      const root = resources.root;
      const config = defaultConfig();
      config.shellSessions.enabled = true;
      config.codeMode.enabled = true;
      const path = join(root, "extensions", "pi-codex-toolkit.json");
      await mkdir(join(root, "extensions"));
      await writeFile(path, JSON.stringify(config));
      const handlers = new Map<string, Function>();
      const tools = new Map<string, ToolDefinition<any, any, any>>();
      let command!: Function;
      let foreign: string | undefined;
      let active = ["read"];
      const ui = { notify: vi.fn(), confirm: async () => false };
      const ctx = {
        cwd: root,
        hasUI: false,
        ui,
        model: otherModel(),
        modelRegistry: { getAvailable: () => [], isUsingOAuth: () => false },
      } as unknown as ExtensionContext;
      createPiCodexToolkit(options)(
        withEventBus({
          registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
          registerCommand: (_name: string, options: { handler: Function }) => {
            command = options.handler;
          },
          on: (name: string, handler: Function) => handlers.set(name, handler),
          getActiveTools: () => active,
          setActiveTools: (names: string[]) => {
            active = names;
          },
          getAllTools: () =>
            [...tools.values()].map((tool) => ({
              ...tool,
              sourceInfo: {
                path:
                  tool.name === foreign
                    ? "/foreign.ts"
                    : fileURLToPath(
                        new URL("../src/index.ts", import.meta.url),
                      ),
              },
            })),
        }) as unknown as ExtensionAPI,
      );
      const event = async (name: string) => {
        return await handlers.get(name)?.(
          {
            type: name,
            reason: name === "session_shutdown" ? "new" : "startup",
          },
          ctx,
        );
      };
      resources.shutdown = () => event("session_shutdown");
      await event("session_start");
      await run({
        root,
        config,
        event,
        foreign: (name) => {
          foreign = name;
        },
        failNotice: () => {
          ui.notify.mockImplementation(() => {
            throw new Error("notification unavailable");
          });
        },
        approve: (callback) => {
          ctx.hasUI = true;
          ui.confirm = callback;
        },
        reload: async () => {
          await writeFile(path, JSON.stringify(config));
          await command("reload", ctx);
        },
        call: async (name, args, onUpdate) =>
          (
            await tools
              .get(name)!
              .execute("fixture", args, undefined, onUpdate, ctx)
          ).details,
      });
    },
  );
}

describe("Code/Shell Pi-session factory wiring", () => {
  it.each(["session_before_switch", "session_before_fork"])(
    "%s cancels failed cleanup without expiring current-session files",
    async (event) =>
      harness(async (h) => {
        const r: CodeModeCellResult = await h.call("exec", {
          code: 'print("kept".repeat(1500));',
          maxOutputBytes: 1024,
        });
        const path = r.recovery!.output!.path!;
        const close = vi
          .spyOn(ShellSessionManager.prototype, "close")
          .mockRejectedValueOnce(new Error("stop unconfirmed"));
        try {
          h.failNotice();
          expect(await h.event(event)).toEqual({ cancel: true });
          expect(await readFile(path, "utf8")).toBe("kept".repeat(1500) + "\n");
          expect(await h.event(event)).toBeUndefined();
          // A different extension may now cancel the action: no actual shutdown
          // occurred, so old files and new execution must still work.
          expect(await readFile(path, "utf8")).toBe("kept".repeat(1500) + "\n");
          expect((await h.call("exec", { code: "return 42;" })).result).toBe(
            42,
          );
        } finally {
          close.mockRestore();
        }
      }),
  );
  it.each(["session_before_switch", "session_before_fork"])(
    "R04 %s retains control after real Code close fails and rebinds only after cleanup",
    async (event) =>
      harness(async (h) => {
        const instances: CodeModeCellManager[] = [];
        const originalExec = CodeModeCellManager.prototype.exec;
        let refusingStops = true;
        const exec = vi
          .spyOn(CodeModeCellManager.prototype, "exec")
          .mockImplementation(function (this: CodeModeCellManager, ...args) {
            instances.push(this);
            // Shorten only the injected confirmation budget, and only while
            // stops are refused; close runs intact.
            if (refusingStops)
              (
                this as unknown as { terminationWaitMs: number }
              ).terminationWaitMs = 30;
            return originalExec.apply(this, args);
          });
        const shell = vi.spyOn(ShellSessionManager.prototype, "close");
        let entered!: () => void;
        const stopping = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const stop = vi
          .spyOn(Worker.prototype, "terminate")
          .mockImplementation(() => {
            entered();
            return Promise.reject(new Error("worker stop unconfirmed"));
          });
        let preflight: Promise<unknown> | undefined;
        try {
          const r: CodeModeCellResult = await h.call("exec", {
            code: 'print("kept"); await new Promise(()=>{});',
          });
          const path = r.recovery!.output!.path!;
          const retained = instances[0];
          h.failNotice();
          preflight = h.event(event);
          await stopping;
          await expect(
            h.call("exec", { code: "return 0;" }),
          ).rejects.toMatchObject({ code: "closed" });
          await expect(
            h.call("wait", { cellId: r.cellId, yieldTimeMs: 0 }),
          ).rejects.toMatchObject({ code: "closed" });
          expect(await preflight).toEqual({ cancel: true });
          expect(shell).toHaveBeenCalled();
          expect(retained.hasCell(r.cellId)).toBe(true);
          expect(await readFile(path, "utf8")).toBe("kept\n");
          const waiting = await h.call("wait", {
            cellId: r.cellId,
            yieldTimeMs: 0,
          });
          expect(waiting).toMatchObject({
            status: "terminated",
            unknownOutcome: true,
          });
          await expect(
            h.call("exec", { code: "return 1;" }),
          ).rejects.toMatchObject({ code: "closed" });
          expect(instances.every((m) => m === retained)).toBe(true);
          stop.mockRestore();
          refusingStops = false;
          restoreStopConfirmationWindow(retained);
          const ended = await h.call("wait", {
            cellId: r.cellId,
            terminate: true,
          });
          expect(ended.status).toBe("terminated");
          expect(ended.unknownOutcome).toBeUndefined();
          expect(retained.hasCell(r.cellId)).toBe(false);
          // Stopping the old cell alone does not reopen admission.
          await expect(
            h.call("exec", { code: "return 2;" }),
          ).rejects.toMatchObject({ code: "closed" });
          expect(await h.event(event)).toBeUndefined();
          // Another extension can cancel successful preflight: same-session
          // files survive and only now may the factory bind a fresh manager.
          expect((await h.call("exec", { code: "return 42;" })).result).toBe(
            42,
          );
          expect(instances.at(-1)).not.toBe(retained);
          expect(await readFile(path, "utf8")).toBe("kept\n");
          await expect(
            h.call("wait", { cellId: r.cellId }),
          ).rejects.toMatchObject({ code: "stale-cell" });
          await h.event("session_shutdown");
          await expect(readFile(path)).rejects.toMatchObject({
            code: "ENOENT",
          });
        } finally {
          stop.mockRestore();
          try {
            await preflight;
          } finally {
            exec.mockRestore();
            shell.mockRestore();
          }
        }
      }),
  );
  it("S8 reads visible shell ownership live without waiting for sync", async () =>
    harness(async (h) => {
      h.foreign("write_stdin");
      // The foreign sibling already won before this cell started, so the
      // adapter is not in the admission snapshot and cannot be declared.
      await expect(
        h.call("exec", {
          code: 'return await tools.exec_command({command:"printf should-not-run"});',
          uses: ["exec_command"],
        }),
      ).rejects.toMatchObject({
        code: "invalid-uses",
        message: expect.stringContaining("not currently available"),
      });
      // Omitting `uses` declares that same snapshot, so the nested call still
      // fails inside the cell instead of reaching the shared executor.
      const implicit: CodeModeCellResult = await h.call("exec", {
        code: 'try { await tools.exec_command({command:"printf should-not-run"}); return "dispatched"; } catch (error) { return error.message; }',
      });
      expect(implicit.status).toBe("completed");
      expect(String(implicit.result)).toContain(
        'was not declared in "uses" for this cell',
      );
    }));
  it("S8 rejects a queued shell after a visible foreign sibling wins", async () =>
    harness(async (h) => {
      const original = ShellSessionManager.prototype.start;
      let started = 0;
      const spy = vi
        .spyOn(ShellSessionManager.prototype, "start")
        .mockImplementation(function (this: ShellSessionManager, ...args) {
          started++;
          if (started === 4) h.foreign("write_stdin");
          return original.apply(this, args);
        });
      try {
        const r: CodeModeCellResult = await h.call("exec", {
          code: 'return await Promise.allSettled(Array.from({length:5},()=>tools.exec_command({command:"sleep 0.05",yieldTimeMs:1000})));',
          uses: ["exec_command"],
        });
        expect(r.status).toBe("completed");
        expect(started).toBe(4);
        expect(
          (r.result as Array<{ status: string }>).filter(
            (x) => x.status === "rejected",
          ),
        ).toHaveLength(1);
      } finally {
        spy.mockRestore();
        h.foreign();
      }
    }));
  it("CM3 rejects a newly foreign Apply Patch winner after approval", async () =>
    harness(async (h) => {
      h.config.applyPatch.enabled = true;
      await h.reload();
      const approval = vi.fn(async () => {
        h.foreign("apply_patch");
        return true;
      });
      h.approve(approval);
      const execute = vi.spyOn(APPLY_PATCH_TOOL_DEFINITION, "execute");
      try {
        const r: CodeModeCellResult = await h.call("exec", {
          code: 'await tools.apply_patch({patch:"fake"});',
          uses: ["apply_patch"],
        });
        expect(r.status).toBe("failed");
        expect(r.error).toContain("disabled");
        expect(execute).not.toHaveBeenCalled();
        expect(approval).toHaveBeenCalledTimes(1);
      } finally {
        execute.mockRestore();
        h.foreign();
      }
    }));
  it("runs the supported Codex dialect end to end", async () =>
    harness(async (h) => {
      h.config.applyPatch.enabled = true;
      await h.reload();
      h.approve(async () => true);
      let result: CodeModeCellResult = await h.call("exec", {
        // No `uses`: the cell declares the current admission snapshot. The
        // nested calls use the Codex spellings and the patch envelope string.
        code: [
          'text("marker:");',
          'const shell = await tools.exec_command({cmd: "printf ok", yield_time_ms: 2000});',
          'const patch = await tools.apply_patch("*** Begin Patch\\n*** Add File: dialect.txt\\n+new\\n*** End Patch");',
          "return {",
          "  stdout: shell.stdout,",
          "  sessionId: typeof shell.session_id,",
          "  matchesLegacy: shell.session_id === shell.sessionId,",
          "  exit_code: shell.exit_code,",
          "  paths: patch.operations.map((operation) => operation.path),",
          '  patched: (await tools.exec_command({cmd: "cat dialect.txt", yield_time_ms: 2000})).stdout,',
          "};",
        ].join("\n"),
      });
      // text() wakes the first observation, so whether this cell also settles
      // inside the 50 ms terminal grace is a race with two real spawns and a
      // patch. Continue through wait's Codex spelling until it is terminal and
      // accumulate the new output each read delivers.
      let output = result.output;
      while (result.status === "running") {
        result = await h.call("wait", { cell_id: result.cellId });
        output += result.output;
      }
      expect(result.status).toBe("completed");
      // text() appends literally: no trailing newline of its own.
      expect(output).toBe("marker:");
      const value = result.result as {
        stdout: string;
        sessionId: string;
        matchesLegacy: boolean;
        exit_code: number;
        paths: string[];
        patched: string;
      };
      expect(value.stdout).toBe("ok");
      expect(value.sessionId).toBe("string");
      expect(value.matchesLegacy).toBe(true);
      expect(value.exit_code).toBe(0);
      expect(value.paths).toEqual(["dialect.txt"]);
      expect(value.patched).toBe("new\n");
    }));

  it("asks for nested Apply Patch approval at the actual call, not at cell creation", async () =>
    harness(async (h) => {
      h.config.applyPatch.enabled = true;
      await h.reload();
      const patch = (path: string) =>
        `"*** Begin Patch\\n*** Add File: ${path}\\n+no\\n*** End Patch"`;

      // Headless: this context has no dialog-capable UI. Declaring the
      // mutating adapter no longer refuses the program.
      const pure: CodeModeCellResult = await h.call("exec", {
        code: 'return "computed";',
        uses: ["apply_patch"],
      });
      expect(pure.status).toBe("completed");
      expect(pure.result).toBe("computed");

      // A computed tool name takes the same dispatch path.
      const attempted: CodeModeCellResult = await h.call("exec", {
        code: `const name = "apply_patch";\nawait tools[name](${patch("headless.txt")});`,
        uses: ["apply_patch"],
      });
      expect(attempted.status).toBe("failed");
      expect(attempted.error).toContain("no dialog-capable UI is available");
      await expect(
        readFile(join(h.root, "headless.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      // Denial is a different outcome from an unavailable approval path.
      h.approve(async () => false);
      const denied: CodeModeCellResult = await h.call("exec", {
        code: `await tools.apply_patch(${patch("denied.txt")});`,
        uses: ["apply_patch"],
      });
      expect(denied.status).toBe("failed");
      expect(denied.error).toContain("was not approved");
      await expect(readFile(join(h.root, "denied.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      // The saved approval mode is what decides; nothing switched it.
      expect(h.config.codeMode.approvalMode).toBe("confirm");
      h.config.codeMode.approvalMode = "always";
      await h.reload();
      const applied: CodeModeCellResult = await h.call("exec", {
        code: `return await tools.apply_patch(${patch("always.txt")});`,
        uses: ["apply_patch"],
      });
      expect(applied.status).toBe("completed");
      expect(await readFile(join(h.root, "always.txt"), "utf8")).toBe("no\n");
    }));

  it("reports nested progress to the outer call that is observing", async () =>
    harness(async (h) => {
      const execUpdates: Array<Record<string, unknown>> = [];
      const waitUpdates: Array<Record<string, unknown>> = [];
      const started: CodeModeCellResult = await h.call(
        "exec",
        {
          code: 'const s = await tools.exec_command({cmd: "sleep 0.3; printf done", yield_time_ms: 5000}); return s.stdout;',
          uses: ["exec_command"],
          yield_time_ms: 0,
        },
        (partial) =>
          execUpdates.push(partial.details as Record<string, unknown>),
      );
      expect(started.status).toBe("running");

      let result: CodeModeCellResult = started;
      while (result.status === "running") {
        result = await h.call(
          "wait",
          { cell_id: started.cellId, yield_time_ms: 5000 },
          (partial) =>
            waitUpdates.push(partial.details as Record<string, unknown>),
        );
      }
      expect(result.status).toBe("completed");
      expect(result.result).toBe("done");

      // Records belong to the call that was observing when they happened.
      expect(execUpdates.every((record) => record.phase === "start")).toBe(
        true,
      );
      expect(waitUpdates.at(-1)).toMatchObject({
        nested: true,
        phase: "end",
        name: "exec_command",
        cell_id: started.cellId,
        ok: true,
      });
      expect(waitUpdates.at(-1)?.session_id).toMatch(/^pct-shell-/);
      expect(JSON.stringify([...execUpdates, ...waitUpdates])).not.toContain(
        "sleep",
      );
    }));

  it("applies supplied invocation context to the direct and nested shell paths", async () => {
    const seen: Array<{ tool: string; path: string }> = [];
    await harness(
      async (h) => {
        const command = 'printf "%s" "$PCT_SESSION_OVERLAY"';
        const direct: ShellSessionResult = await h.call("exec_command", {
          cmd: command,
          yield_time_ms: 5000,
        });
        const nested: CodeModeCellResult = await h.call("exec", {
          code: `return (await tools.exec_command({cmd: ${JSON.stringify(command)}, yield_time_ms: 5000})).stdout;`,
          uses: ["exec_command"],
        });
        expect(direct.stdout).toBe("supplied");
        expect(nested.result).toBe("supplied");
        expect(seen).toEqual([
          { tool: "exec_command", path: "direct" },
          { tool: "exec_command", path: "nested" },
        ]);
        expect(process.env.PCT_SESSION_OVERLAY).toBeUndefined();
      },
      {
        invocationHooks: {
          context: (call) => {
            seen.push({ tool: call.tool, path: call.path });
            return { env: { PCT_SESSION_OVERLAY: "supplied" } };
          },
        },
      },
    );
  });

  it("surfaces rejected shutdown cleanup and retries the same owned manager before rebinding", async () =>
    harness(async (h) => {
      const captured: CodeModeCellResult = await h.call("exec", {
        code: 'print("x".repeat(6000));',
        maxOutputBytes: 1024,
      });
      const path = captured.recovery!.output!.path!;
      const original = ShellSessionManager.prototype.close;
      let failedOwner: ShellSessionManager | undefined;
      let retried = false;
      const spy = vi
        .spyOn(ShellSessionManager.prototype, "close")
        .mockImplementation(async function (this: ShellSessionManager) {
          if (!failedOwner) {
            failedOwner = this;
            await original.call(this);
            throw new Error("cleanup-incomplete fixture");
          }
          if (this === failedOwner) retried = true;
          await original.call(this);
        });
      try {
        await expect(h.event("session_shutdown")).rejects.toThrow(
          "cleanup-incomplete",
        );
        await expect(h.call("exec", { code: "return 1;" })).rejects.toThrow(
          "not enabled",
        );
        expect(await readFile(path, "utf8")).toBe("x".repeat(6000) + "\n");
        await h.event("session_start");
        expect(retried).toBe(true);
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await h.call("exec", { code: "return 2;" })).result).toBe(2);
      } finally {
        spy.mockRestore();
      }
    }));
  it("shares output lifetime across disable/re-enable but replaces it after shutdown", async () =>
    harness(async (h) => {
      const shell: ShellSessionResult = await h.call("exec_command", {
        command: "printf '%06000d' 0",
        maxOutputBytes: 1024,
      });
      const cell: CodeModeCellResult = await h.call("exec", {
        code: 'print("始".repeat(2000)); return "tail";',
        maxOutputBytes: 1024,
      });
      const shellPath = shell.recovery!.stdout.path!;
      const cellPath = cell.recovery!.output!.path!;
      expect(cellPath).toBeDefined();
      h.config.shellSessions.enabled = false;
      h.config.codeMode.enabled = false;
      await h.reload();
      expect((await readFile(shellPath, "utf8")).length).toBe(6000);
      expect(await readFile(cellPath, "utf8")).toBe("始".repeat(2000) + "\n");
      h.config.shellSessions.enabled = true;
      h.config.codeMode.enabled = true;
      await h.reload();
      expect((await h.call("exec", { code: "return 7;" })).result).toBe(7);
      await h.event("session_shutdown");
      await expect(readFile(shellPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(cellPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await h.event("session_start");
      expect(
        (await h.call("exec_command", { command: "printf fresh" })).stdout,
      ).toBe("fresh");
      expect(
        (
          await h.call("exec", {
            code: 'return (await tools.exec_command({command:"printf nested-fresh"})).stdout;',
            uses: ["exec_command"],
          })
        ).result,
      ).toBe("nested-fresh");
    }));
});
