import { mkdir, writeFile } from "node:fs/promises";
import {
  withExecutionLifecycleResources,
  type ExecutionLifecycleResources,
} from "./fixtures/execution-lifecycle-resources.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionHandler,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeClientState = vi.hoisted(() => ({
  instances: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
    probeTarget: ReturnType<typeof vi.fn>;
    isClosed: boolean;
    confirmation: AbortController;
  }>,
  // Thrown by every probeTarget call while set; cleared before each test.
  probeError: undefined as unknown,
}));

vi.mock("../src/computer-use/app-server-client.ts", () => {
  class FakeComputerUseClientError extends Error {
    constructor(readonly category: string) {
      super(category);
    }
  }

  class FakeComputerUseClient {
    isClosed = false;
    readonly confirmation = new AbortController();
    readonly invoke = vi.fn(
      async (
        method: string,
        _args: unknown,
        _signal: unknown,
        approvalHandler?: (
          message: string,
          signal: AbortSignal,
        ) => boolean | Promise<boolean>,
      ) => {
        await approvalHandler?.("fake approval", this.confirmation.signal);
        return {
          content: [{ type: "text", text: "fake-result" }],
          details: { method, blockCount: 1, blockTypes: ["text"] },
        };
      },
    );
    readonly probeTarget = vi.fn(async () => {
      if (fakeClientState.probeError) throw fakeClientState.probeError;
    });
    readonly close = vi.fn(async () => {
      this.isClosed = true;
    });

    constructor() {
      fakeClientState.instances.push(this);
    }
  }

  return {
    ComputerUseClient: FakeComputerUseClient,
    ComputerUseClientError: FakeComputerUseClientError,
    inspectComputerUseRuntime: () => ({
      ok: true,
      runtime: {
        codexPath: "/chatgpt/codex",
        nodeReplPath: "/chatgpt/node_repl",
        nodePath: "/chatgpt/node",
        nodeModulesPath: "/chatgpt/node_modules",
        helperPath: "/codex-home/computer-use/Codex Computer Use.app",
      },
    }),
  };
});

import piCodexToolkit, {
  COMPUTER_USE_TOOLS,
  EXEC_COMMAND_TOOL,
} from "../src/index.ts";
// The mocked class, the same one src/index.ts narrows probe failures with.
import { ComputerUseClientError } from "../src/computer-use/app-server-client.ts";
import { ComputerUseLifecycle } from "../src/computer-use/lifecycle.ts";
import { defaultConfig } from "../src/config.ts";
import { model } from "./fixtures.ts";
import { withEventBus } from "./fixtures/extension-events.ts";

beforeEach(() => {
  fakeClientState.instances.length = 0;
  fakeClientState.probeError = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

// The caller owns the host's active tool list and any foreign winner, because
// it reads and changes them between lifecycle events.
interface HostToolState {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  /** The one tool name a foreign extension wins, if any. */
  foreignToolName(): string | undefined;
}

/**
 * Enables Computer Use in the owned agent directory, registers the Toolkit on a
 * fake Pi host with an interactive UI and an image model, and hands session
 * shutdown to the resources.
 */
async function registerToolkit(
  resources: ExecutionLifecycleResources,
  host: HostToolState,
) {
  const agentDirectory = resources.root;
  const configPath = join(
    agentDirectory,
    "extensions",
    "pi-codex-toolkit.json",
  );
  await mkdir(join(agentDirectory, "extensions"), { recursive: true });
  const config = defaultConfig();
  config.computerUse.enabled = true;
  await writeFile(configPath, JSON.stringify(config), "utf8");
  const handlers = new Map<string, ExtensionHandler<never, unknown>>();
  const tools = new Map<string, ToolDefinition>();
  let command: RegisteredCommand["handler"] | undefined;
  const sourcePath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (
      _name: string,
      options: { handler: RegisteredCommand["handler"] },
    ) => {
      command = options.handler;
    },
    on: (event: string, handler: ExtensionHandler<never, unknown>) => {
      handlers.set(event, handler);
    },
    getActiveTools: () => host.getActiveTools(),
    getAllTools: () =>
      [...tools.values()].map((tool) => ({
        ...tool,
        sourceInfo: {
          path:
            tool.name === host.foreignToolName()
              ? "/other/computer-use.ts"
              : sourcePath,
          source: "test",
          scope: "user" as const,
          origin: "package" as const,
        },
      })),
    setActiveTools: (names: string[]) => {
      host.setActiveTools(names);
    },
  } as unknown as ExtensionAPI;
  const currentModel = model({ input: ["text", "image"] });
  const notify = vi.fn();
  const confirm = vi.fn(async () => true);
  const ctx = {
    hasUI: true,
    model: currentModel,
    modelRegistry: {
      getAvailable: () => [currentModel],
      isUsingOAuth: () => false,
    },
    scopedModels: [],
    ui: {
      notify,
      confirm,
    },
  } as unknown as ExtensionContext & ExtensionCommandContext;

  resources.shutdown = () =>
    handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" } as never,
      ctx,
    );
  piCodexToolkit(withEventBus(pi));
  return { config, configPath, handlers, tools, command, ctx, notify, confirm };
}

describe("Computer Use extension lifecycle", () => {
  it("selects the approval handler and replaces clients only at lifecycle boundaries", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    await withExecutionLifecycleResources(
      "pct-cua-lifecycle-",
      async (resources) => {
        let active = ["read"];
        let conflictingComputerUseTool: string | undefined;
        const { config, configPath, handlers, tools, command, ctx, confirm } =
          await registerToolkit(resources, {
            getActiveTools: () => active,
            setActiveTools: (names) => {
              active = names;
            },
            foreignToolName: () => conflictingComputerUseTool,
          });
        expect(fakeClientState.instances).toHaveLength(0);
        await handlers.get("session_start")?.(
          { type: "session_start", reason: "startup" } as never,
          ctx,
        );
        expect(active).toEqual(["read", ...COMPUTER_USE_TOOLS]);
        expect(fakeClientState.instances).toHaveLength(0);

        if (!command) throw new Error("pct command was not registered");
        await command("status", ctx);
        expect(fakeClientState.instances).toHaveLength(1);
        expect(
          fakeClientState.instances[0]?.probeTarget,
        ).toHaveBeenCalledOnce();
        expect(fakeClientState.instances[0]?.close).toHaveBeenCalledOnce();

        const listApps = tools.get("computer_use_list_apps");
        if (!listApps) throw new Error("Computer Use tool was not registered");
        const caller = new AbortController();
        await listApps.execute("call-1", {}, caller.signal, undefined, ctx);
        expect(fakeClientState.instances).toHaveLength(2);
        expect(fakeClientState.instances[1]?.invoke).toHaveBeenCalledOnce();
        expect(confirm).toHaveBeenCalledExactlyOnceWith(
          "Computer Use access",
          "fake approval",
          { signal: fakeClientState.instances[1]?.confirmation.signal },
        );
        expect(fakeClientState.instances[1]?.confirmation.signal).not.toBe(
          caller.signal,
        );

        await command("reload", ctx);
        expect(fakeClientState.instances[1]?.close).not.toHaveBeenCalled();
        await listApps.execute("call-2", {}, undefined, undefined, ctx);
        expect(fakeClientState.instances).toHaveLength(2);

        await handlers.get("session_before_compact")?.(
          { type: "session_before_compact" } as never,
          ctx,
        );
        await handlers.get("model_select")?.(
          { type: "model_select" } as never,
          ctx,
        );
        expect(fakeClientState.instances[1]?.close).not.toHaveBeenCalled();

        config.computerUse.approvalMode = "always";
        await writeFile(configPath, JSON.stringify(config), "utf8");
        await command("reload", ctx);
        expect(fakeClientState.instances[1]?.close).toHaveBeenCalledOnce();
        const confirmationCount = confirm.mock.calls.length;
        await listApps.execute("call-3", {}, undefined, undefined, ctx);
        const alwaysClient = fakeClientState.instances.at(-1);
        expect(alwaysClient).toBeDefined();
        const alwaysApproval = alwaysClient?.invoke.mock.calls.at(-1)?.[3] as
          | ((
              message: string,
              signal: AbortSignal,
            ) => boolean | Promise<boolean>)
          | undefined;
        expect(alwaysApproval).toBeTypeOf("function");
        expect(
          alwaysApproval?.("fake approval", new AbortController().signal),
        ).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(confirmationCount);

        await command("reload", ctx);
        expect(alwaysClient?.close).not.toHaveBeenCalled();

        await handlers.get("session_shutdown")?.(
          { type: "session_shutdown", reason: "new" } as never,
          ctx,
        );
        expect(alwaysClient?.close).toHaveBeenCalledOnce();
        await handlers.get("session_start")?.(
          { type: "session_start", reason: "new" } as never,
          ctx,
        );
        await listApps.execute("call-4", {}, undefined, undefined, ctx);
        const freshAlwaysClient = fakeClientState.instances.at(-1);
        expect(freshAlwaysClient).not.toBe(alwaysClient);
        const freshAlwaysApproval = freshAlwaysClient?.invoke.mock.calls.at(
          -1,
        )?.[3] as
          | ((
              message: string,
              signal: AbortSignal,
            ) => boolean | Promise<boolean>)
          | undefined;
        expect(freshAlwaysApproval).toBeTypeOf("function");
        expect(
          freshAlwaysApproval?.("fake approval", new AbortController().signal),
        ).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(confirmationCount);

        config.computerUse.approvalMode = "confirm";
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const preConfirmClient = fakeClientState.instances.at(-1);
        await command("reload", ctx);
        expect(preConfirmClient?.close).toHaveBeenCalledOnce();
        await listApps.execute("call-5", {}, undefined, undefined, ctx);
        expect(confirm).toHaveBeenCalledTimes(confirmationCount + 1);

        config.computerUse.enabled = false;
        await writeFile(configPath, JSON.stringify(config), "utf8");
        await command("reload", ctx);
        expect(active).toEqual(["read"]);
        expect(fakeClientState.instances.at(-1)?.close).toHaveBeenCalledOnce();
        await command("status", ctx);
        const instancesAfterDisabledStatus = fakeClientState.instances.length;

        config.computerUse.enabled = true;
        await writeFile(configPath, JSON.stringify(config), "utf8");
        await command("reload", ctx);
        expect(active).toEqual(["read", ...COMPUTER_USE_TOOLS]);
        expect(fakeClientState.instances).toHaveLength(
          instancesAfterDisabledStatus,
        );
        await listApps.execute("call-6", {}, undefined, undefined, ctx);

        const imageModel = ctx.model;
        ctx.model = model({ input: ["text"] });
        const eligibleClient = fakeClientState.instances.at(-1);
        await handlers.get("model_select")?.(
          { type: "model_select" } as never,
          ctx,
        );
        expect(eligibleClient?.close).toHaveBeenCalledOnce();
        expect(active).toEqual(["read"]);

        ctx.model = imageModel;
        await handlers.get("model_select")?.(
          { type: "model_select" } as never,
          ctx,
        );
        expect(active).toEqual(["read", ...COMPUTER_USE_TOOLS]);

        await listApps.execute(
          "before-conflict",
          {},
          undefined,
          undefined,
          ctx,
        );
        const preConflictClient = fakeClientState.instances.at(-1);
        conflictingComputerUseTool = COMPUTER_USE_TOOLS[2];
        await handlers.get("model_select")?.(
          { type: "model_select" } as never,
          ctx,
        );
        expect(preConflictClient?.close).toHaveBeenCalledOnce();
        expect(active).toEqual(["read", conflictingComputerUseTool]);

        conflictingComputerUseTool = undefined;
        await handlers.get("model_select")?.(
          { type: "model_select" } as never,
          ctx,
        );
        expect(new Set(active)).toEqual(
          new Set(["read", ...COMPUTER_USE_TOOLS]),
        );

        for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
          await listApps.execute(
            `shutdown-${reason}`,
            {},
            undefined,
            undefined,
            ctx,
          );
          const client = fakeClientState.instances.at(-1);
          await handlers.get("session_shutdown")?.(
            { type: "session_shutdown", reason } as never,
            ctx,
          );
          expect(client?.close).toHaveBeenCalledOnce();
          await expect(
            listApps.execute("stale", {}, undefined, undefined, ctx),
          ).rejects.toThrow();
          if (reason !== "quit") {
            await handlers.get("session_start")?.(
              { type: "session_start", reason } as never,
              ctx,
            );
          }
        }
      },
    );
  });

  it.each([
    {
      failure: "an incompatible Sky target",
      error: () => new ComputerUseClientError("incompatible-sky-target"),
      reason: "incompatible-sky-target",
    },
    {
      failure: "another client error category",
      error: () => new ComputerUseClientError("closed"),
      reason: "node-repl-unavailable",
    },
    {
      failure: "an error that is not a client error",
      error: () => new Error("probe failed"),
      reason: "node-repl-unavailable",
    },
  ])(
    "reports $reason in status when the probe fails with $failure",
    async ({ error, reason }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      await withExecutionLifecycleResources(
        "pct-cua-status-probe-",
        async (resources) => {
          let active = ["read"];
          const { handlers, command, ctx, notify } = await registerToolkit(
            resources,
            {
              getActiveTools: () => active,
              setActiveTools: (names) => {
                active = names;
              },
              foreignToolName: () => undefined,
            },
          );
          await handlers.get("session_start")?.(
            { type: "session_start", reason: "startup" } as never,
            ctx,
          );
          if (!command) throw new Error("pct command was not registered");
          fakeClientState.probeError = error();

          await command("status", ctx);

          // The dedicated probe client is disposed after its failure too.
          expect(fakeClientState.instances).toHaveLength(1);
          expect(fakeClientState.instances[0]?.close).toHaveBeenCalledOnce();
          const [message] = notify.mock.lastCall as [string];
          const lines = message.split("\n");
          expect(
            lines.slice(
              lines.indexOf("Computer Use:"),
              lines.indexOf("Shell Sessions:"),
            ),
          ).toEqual([
            "Computer Use:",
            "  configured: on",
            "  effective: unavailable",
            "  transport: —",
            `  reason: ${reason}`,
            "  experimental local bridge through ChatGPT.app node_repl and @oai/sky.",
          ]);
        },
      );
    },
  );

  it("releases shell resources even when the Computer Use close rejects", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    await withExecutionLifecycleResources(
      "pct-cua-teardown-",
      async (resources) => {
        const agentDirectory = resources.root;
        const configPath = join(
          agentDirectory,
          "extensions",
          "pi-codex-toolkit.json",
        );
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        const config = defaultConfig();
        config.computerUse.enabled = true;
        config.shellSessions.enabled = true;
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const handlers = new Map<string, ExtensionHandler<never, unknown>>();
        const tools = new Map<string, ToolDefinition>();
        let command: RegisteredCommand["handler"] | undefined;
        let active: string[] = ["read"];
        const sourcePath = fileURLToPath(
          new URL("../src/index.ts", import.meta.url),
        );
        const pi = {
          registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
          registerCommand: (
            _name: string,
            options: { handler: RegisteredCommand["handler"] },
          ) => {
            command = options.handler;
          },
          on: (event: string, handler: ExtensionHandler<never, unknown>) => {
            handlers.set(event, handler);
          },
          getActiveTools: () => active,
          getAllTools: () =>
            [...tools.values()].map((tool) => ({
              ...tool,
              sourceInfo: {
                path: sourcePath,
                source: "test",
                scope: "user" as const,
                origin: "package" as const,
              },
            })),
          setActiveTools: (names: string[]) => {
            active = names;
          },
        } as unknown as ExtensionAPI;
        const currentModel = model({ input: ["text", "image"] });
        const ctx = {
          cwd: process.cwd(),
          hasUI: true,
          model: currentModel,
          modelRegistry: {
            getAvailable: () => [currentModel],
            isUsingOAuth: () => false,
          },
          scopedModels: [],
          ui: { notify: vi.fn(), confirm: vi.fn(async () => true) },
        } as unknown as ExtensionContext & ExtensionCommandContext;

        resources.shutdown = () =>
          handlers.get("session_shutdown")?.(
            { type: "session_shutdown", reason: "quit" } as never,
            ctx,
          );
        piCodexToolkit(withEventBus(pi));
        await handlers.get("session_start")!(
          { type: "session_start", reason: "startup" } as never,
          ctx,
        );
        if (!command) throw new Error("pct command was not registered");

        const listApps = tools.get("computer_use_list_apps");
        const exec = tools.get(EXEC_COMMAND_TOOL);
        if (!listApps || !exec) {
          throw new Error("Computer Use and shell tools were not registered");
        }
        await listApps.execute("cua-1", {}, undefined, undefined, ctx);
        const client = fakeClientState.instances.at(-1);
        if (!client) throw new Error("Computer Use client was not created");

        const started = await exec.execute(
          "shell-1",
          { command: "echo $$; sleep 30", yieldTimeMs: 2000 },
          undefined,
          undefined,
          ctx,
        );
        const pid = Number(
          (started.details as { stdout: string }).stdout.trim(),
        );
        expect(isAlive(pid)).toBe(true);

        client.close.mockRejectedValueOnce(new Error("teardown failure"));
        config.computerUse.enabled = false;
        config.shellSessions.enabled = false;
        await writeFile(configPath, JSON.stringify(config), "utf8");

        await expect(command("reload", ctx)).rejects.toThrow(
          "teardown failure",
        );
        expect(await waitUntil(() => !isAlive(pid))).toBe(true);
      },
    );
  });

  it("runs the full cleanup a re-planned Computer Use contraction requires", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    await withExecutionLifecycleResources(
      "pct-cua-replan-",
      async (resources) => {
        let active = ["read"];
        let conflictingComputerUseTool: string | undefined;
        const { handlers, tools, ctx } = await registerToolkit(resources, {
          getActiveTools: () => active,
          setActiveTools: (names) => {
            active = names;
          },
          foreignToolName: () => conflictingComputerUseTool,
        });
        await handlers.get("session_start")?.(
          { type: "session_start", reason: "startup" } as never,
          ctx,
        );
        const listApps = tools.get("computer_use_list_apps");
        if (!listApps) throw new Error("Computer Use tool was not registered");
        await listApps.execute("replan-1", {}, undefined, undefined, ctx);
        const client = fakeClientState.instances.at(-1);
        if (!client) throw new Error("Computer Use client was not created");
        expect(client.close).not.toHaveBeenCalled();

        // An unchanged sync owes only the pending sweep. Another extension
        // wins a Computer Use name while that sweep is awaited, so the fresh
        // plan contracts the group — and must run the full disposal the first
        // plan never scheduled before it publishes that contraction.
        const lifecycleProto = ComputerUseLifecycle.prototype as unknown as {
          cleanup(pendingOnly?: boolean): Promise<void>;
        };
        const realCleanup = lifecycleProto.cleanup;
        let armed = true;
        const cleanupCalls: boolean[] = [];
        lifecycleProto.cleanup = function (this: never, ...args: unknown[]) {
          cleanupCalls.push(args[0] === true);
          if (armed && args[0] === true) {
            armed = false;
            conflictingComputerUseTool = COMPUTER_USE_TOOLS[2];
          }
          return realCleanup.apply(this, args as []);
        } as typeof lifecycleProto.cleanup;
        resources.restoreBeforeCleanup.push(() => {
          lifecycleProto.cleanup = realCleanup;
        });
        try {
          await handlers.get("model_select")?.(
            { type: "model_select" } as never,
            ctx,
          );

          // Owner released before the commit: one close, and the committed
          // projection keeps only the foreign winner's name.
          expect(client.close).toHaveBeenCalledOnce();
          expect(client.isClosed).toBe(true);
          expect(cleanupCalls).toEqual([true, false]);
          expect(active).toEqual(["read", conflictingComputerUseTool]);

          // Nothing is still owned: the next teardown closes it again only if
          // the disposal above never completed.
          await handlers.get("session_shutdown")?.(
            { type: "session_shutdown", reason: "quit" } as never,
            ctx,
          );
          expect(client.close).toHaveBeenCalledOnce();
        } finally {
          lifecycleProto.cleanup = realCleanup;
        }
      },
    );
  });
});
