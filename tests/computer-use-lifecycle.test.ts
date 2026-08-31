import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  }>,
}));

vi.mock("../src/computer-use/app-server-client.ts", () => {
  class FakeComputerUseClientError extends Error {
    constructor(readonly category: string) {
      super(category);
    }
  }

  class FakeComputerUseClient {
    isClosed = false;
    readonly invoke = vi.fn(
      async (
        method: string,
        _args: unknown,
        _signal: unknown,
        approvalHandler?: (message: string) => Promise<boolean>,
      ) => {
        await approvalHandler?.("fake approval");
        return {
          content: [{ type: "text", text: "fake-result" }],
          details: { method, blockCount: 1, blockTypes: ["text"] },
        };
      },
    );
    readonly probeTarget = vi.fn(async () => undefined);
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

import piCodexToolkit, { COMPUTER_USE_TOOLS } from "../src/index.ts";
import { defaultConfig } from "../src/config.ts";
import { model } from "./fixtures.ts";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  fakeClientState.instances.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Computer Use extension lifecycle", () => {
  it("selects the approval handler and replaces clients only at lifecycle boundaries", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const agentDirectory = await mkdtemp(join(tmpdir(), "pct-cua-lifecycle-"));
    temporaryDirectories.push(agentDirectory);
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    const configPath = join(
      agentDirectory,
      "extensions",
      "pi-codex-toolkit.json",
    );
    await mkdir(join(agentDirectory, "extensions"), { recursive: true });
    const config = defaultConfig();
    config.computerUse.enabled = true;
    await writeFile(configPath, JSON.stringify(config), "utf8");

    try {
      const handlers = new Map<string, ExtensionHandler<never, unknown>>();
      const tools = new Map<string, ToolDefinition>();
      let command: RegisteredCommand["handler"] | undefined;
      let active = ["read"];
      let conflictingComputerUseTool: string | undefined;
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
              path:
                tool.name === conflictingComputerUseTool
                  ? "/other/computer-use.ts"
                  : sourcePath,
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

      piCodexToolkit(pi);
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
      expect(fakeClientState.instances[0]?.probeTarget).toHaveBeenCalledOnce();
      expect(fakeClientState.instances[0]?.close).toHaveBeenCalledOnce();

      const listApps = tools.get("computer_use_list_apps");
      if (!listApps) throw new Error("Computer Use tool was not registered");
      await listApps.execute("call-1", {}, undefined, undefined, ctx);
      expect(fakeClientState.instances).toHaveLength(2);
      expect(fakeClientState.instances[1]?.invoke).toHaveBeenCalledOnce();
      expect(confirm).toHaveBeenCalledOnce();

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
        | ((message: string) => Promise<boolean>)
        | undefined;
      expect(alwaysApproval).toBeTypeOf("function");
      await expect(alwaysApproval?.("fake approval")).resolves.toBe(true);
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
      )?.[3] as ((message: string) => Promise<boolean>) | undefined;
      expect(freshAlwaysApproval).toBeTypeOf("function");
      await expect(freshAlwaysApproval?.("fake approval")).resolves.toBe(true);
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

      await listApps.execute("before-conflict", {}, undefined, undefined, ctx);
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
      expect(new Set(active)).toEqual(new Set(["read", ...COMPUTER_USE_TOOLS]));

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
      }
    } finally {
      if (previousAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
      }
    }
  });
});
