import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  withExecutionLifecycleResources,
  type ExecutionLifecycleProbe,
  type ExecutionLifecycleResources,
} from "./fixtures/execution-lifecycle-resources.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionHandler,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import piCodexToolkit, {
  APPLY_PATCH_TOOL,
  CODE_MODE_EXEC_TOOL,
  CODE_MODE_WAIT_TOOL,
  COMPUTER_USE_TOOLS,
  EXEC_COMMAND_TOOL,
  IMAGE_GENERATION_TOOL,
  syncOwnedTool,
  TOOL_DISCOVERY_TOOL,
  WEB_SEARCH_TOOL,
  WRITE_STDIN_TOOL,
} from "../src/index.ts";
import { CodeModeCellManager } from "../src/code-mode/manager.ts";
import { ComputerUseLifecycle } from "../src/computer-use/lifecycle.ts";
import { defaultConfig } from "../src/config.ts";
import {
  EXECUTION_DIAGNOSTICS_EVENT,
  type ExecutionDiagnosticsRecord,
} from "../src/execution-diagnostics.ts";
import { inspectRemoteCompactionRoute } from "../src/openai/route.ts";
import { ShellSessionManager } from "../src/shell/manager.ts";
import { codexModel, otherModel, model } from "./fixtures.ts";
import {
  recordingEventBus,
  withEventBus,
} from "./fixtures/extension-events.ts";
import {
  withShellLifecycleResources,
  type ShellLifecycleProbe,
  type ShellLifecycleResources,
} from "./fixtures/shell-lifecycle-resources.ts";

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

function registry(sidecar = model()) {
  return {
    find: (provider: string, id: string) =>
      provider === sidecar.provider && id === sidecar.id ? sidecar : undefined,
    getAvailable: () => [sidecar],
    isUsingOAuth: () => false,
  };
}

function sidecarConfig() {
  const config = defaultConfig();
  config.webSearch.enabled = true;
  config.webSearch.backend = "auto";
  config.webSearch.sidecarModel = {
    provider: "openai",
    model: "gpt-5",
    thinkingLevel: "auto",
  };
  return config;
}

describe("owned-tool lifecycle", () => {
  it("activates only the owned Apply Patch name and preserves a conflict", () => {
    let active = ["read", "third_party_tool"];
    let sourcePath = "/extension/src/index.ts";
    const setActiveTools = vi.fn((names: string[]) => {
      active = names;
    });
    const pi = {
      getActiveTools: () => active,
      setActiveTools,
      getAllTools: () => [
        {
          name: APPLY_PATCH_TOOL,
          sourceInfo: {
            path: sourcePath,
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
      ],
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const config = defaultConfig();
    config.applyPatch.enabled = true;
    const ctx = {
      model: otherModel(),
      modelRegistry: registry(),
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;

    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts"),
    ).toMatchObject({ applyPatchConflict: false });
    expect(active).toEqual(["read", "third_party_tool", APPLY_PATCH_TOOL]);

    sourcePath = "/other/apply-patch.ts";
    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts"),
    ).toMatchObject({ applyPatchConflict: true });
    expect(active).toEqual(["read", "third_party_tool", APPLY_PATCH_TOOL]);
    expect(setActiveTools).toHaveBeenCalledTimes(1);
  });

  it("activates Computer Use as one group and preserves a conflicting name", () => {
    let active = ["read", "third_party_tool"];
    let conflictingName: string | undefined;
    const setActiveTools = vi.fn((names: string[]) => {
      active = names;
    });
    const pi = {
      getActiveTools: () => active,
      setActiveTools,
      getAllTools: () =>
        COMPUTER_USE_TOOLS.map((name) => ({
          name,
          sourceInfo: {
            path:
              name === conflictingName
                ? "/other/computer-use.ts"
                : "/extension/src/index.ts",
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        })),
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const config = defaultConfig();
    config.computerUse.enabled = true;
    const ctx = {
      model: model({ input: ["text", "image"] }),
      modelRegistry: registry(),
      hasUI: true,
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry"> & {
      hasUI: boolean;
    };
    const inspection = {
      ok: true as const,
      runtime: {
        codexPath: "/chatgpt/codex",
        nodeReplPath: "/chatgpt/node_repl",
        nodePath: "/chatgpt/node",
        nodeModulesPath: "/chatgpt/node_modules",
        helperPath: "/codex-home/computer-use/Codex Computer Use.app",
      },
    };

    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts", {
        inspection,
        platform: "darwin",
      }),
    ).toMatchObject({
      computerUseDecision: { effective: "active", transport: "node-repl" },
      computerUseConflict: false,
    });
    expect(active).toEqual(["read", "third_party_tool", ...COMPUTER_USE_TOOLS]);

    conflictingName = COMPUTER_USE_TOOLS[2];
    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts", {
        inspection,
        platform: "darwin",
      }),
    ).toMatchObject({ computerUseConflict: true });
    expect(active).toEqual(["read", "third_party_tool", conflictingName]);
    expect(setActiveTools).toHaveBeenCalledTimes(2);
  });

  it("activates Code Mode as one atomic group and preserves a conflicting name", () => {
    let active = ["read", "third_party_tool"];
    let conflictingName: string | undefined;
    const setActiveTools = vi.fn((names: string[]) => {
      active = names;
    });
    const pi = {
      getActiveTools: () => active,
      setActiveTools,
      getAllTools: () =>
        [CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL].map((name) => ({
          name,
          sourceInfo: {
            path:
              name === conflictingName
                ? "/other/code-mode.ts"
                : "/extension/src/index.ts",
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        })),
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const config = defaultConfig();
    const ctx = {
      model: otherModel(),
      modelRegistry: registry(),
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;

    // Default-off keeps both names out of the active list.
    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts"),
    ).toMatchObject({ codeModeConflict: false });
    expect(active).toEqual(["read", "third_party_tool"]);

    config.codeMode.enabled = true;
    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts"),
    ).toMatchObject({ codeModeConflict: false });
    expect(active).toEqual([
      "read",
      "third_party_tool",
      CODE_MODE_EXEC_TOOL,
      CODE_MODE_WAIT_TOOL,
    ]);

    conflictingName = CODE_MODE_EXEC_TOOL;
    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts"),
    ).toMatchObject({ codeModeConflict: true });
    expect(active).toEqual(["read", "third_party_tool", CODE_MODE_EXEC_TOOL]);
    expect(setActiveTools).toHaveBeenCalledTimes(2);
  });

  it("activates and removes Image Generation across model availability changes", () => {
    let active = ["read", "third_party_tool"];
    let available = [model()];
    const setActiveTools = vi.fn((names: string[]) => {
      active = names;
    });
    const pi = {
      getActiveTools: () => active,
      setActiveTools,
      getAllTools: () => [
        {
          name: IMAGE_GENERATION_TOOL,
          sourceInfo: {
            path: "/extension/src/index.ts",
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
      ],
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const config = defaultConfig();
    config.imageGeneration.enabled = true;
    const ctx = {
      model: otherModel(),
      modelRegistry: {
        getAvailable: () => available,
        isUsingOAuth: () => false,
      },
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;

    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts"),
    ).toMatchObject({
      imageDecision: { effective: "active", backend: "api-key" },
      imageConflict: false,
    });
    expect(active).toEqual(["read", "third_party_tool", IMAGE_GENERATION_TOOL]);

    available = [];
    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts"),
    ).toMatchObject({
      imageDecision: {
        effective: "unavailable",
        reason: "missing-openai-auth",
      },
    });
    expect(active).toEqual(["read", "third_party_tool"]);
    expect(setActiveTools).toHaveBeenCalledTimes(2);
  });

  it("synchronizes Search and Image Generation once with independent conflicts", () => {
    let active: string[] = ["read"];
    const setActiveTools = vi.fn((names: string[]) => {
      active = names;
    });
    const config = sidecarConfig();
    config.webSearch.backend = "sidecar";
    config.imageGeneration.enabled = true;
    const pi = {
      getActiveTools: () => active,
      setActiveTools,
      getAllTools: vi.fn(() => [
        {
          name: WEB_SEARCH_TOOL,
          sourceInfo: {
            path: "/extension/src/index.ts",
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
        {
          name: IMAGE_GENERATION_TOOL,
          sourceInfo: {
            path: "/other/image-extension.ts",
            source: "other",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
      ]),
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const state = syncOwnedTool(
      pi,
      config,
      { model: model(), modelRegistry: registry() } as unknown as Pick<
        ExtensionContext,
        "model" | "modelRegistry"
      >,
      "/extension/src/index.ts",
    );

    expect(state).toMatchObject({
      decision: { effective: "sidecar" },
      conflict: false,
      imageDecision: { effective: "active", backend: "api-key" },
      imageConflict: true,
    });
    expect(active).toEqual(["read", WEB_SEARCH_TOOL]);
    expect(setActiveTools).toHaveBeenCalledTimes(1);
  });

  it("keeps the Grok auxiliary capability boundaries independent", () => {
    let active = ["read"];
    const sourcePath = "/extension/src/index.ts";
    const setActiveTools = vi.fn((names: string[]) => {
      active = names;
    });
    const pi = {
      getActiveTools: () => active,
      setActiveTools,
      getAllTools: () =>
        [WEB_SEARCH_TOOL, IMAGE_GENERATION_TOOL, ...COMPUTER_USE_TOOLS].map(
          (name) => ({
            name,
            sourceInfo: {
              path: sourcePath,
              source: "test",
              scope: "user" as const,
              origin: "package" as const,
            },
          }),
        ),
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const grok = otherModel({
      provider: "xai",
      id: "grok-4.6",
      name: "Grok 4.6",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      input: ["text", "image"],
    });
    const oauth = codexModel({ id: "gpt-5.4" });
    const modelRegistry = {
      find: (provider: string, id: string) =>
        provider === oauth.provider && id === oauth.id ? oauth : undefined,
      getAvailable: () => [oauth],
      isUsingOAuth: (candidate: typeof oauth) =>
        candidate.provider === "openai-codex",
    };
    const config = defaultConfig();
    config.webSearch.enabled = true;
    config.webSearch.sidecarModel = {
      provider: "openai-codex",
      model: oauth.id,
      thinkingLevel: "low",
    };
    config.imageGeneration.enabled = true;
    config.computerUse.enabled = true;
    const ctx = {
      model: grok,
      modelRegistry,
      hasUI: true,
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry"> & {
      hasUI: boolean;
    };
    const state = syncOwnedTool(pi, config, ctx, sourcePath, {
      platform: "darwin",
      inspection: {
        ok: true,
        runtime: {
          codexPath: "/chatgpt/codex",
          nodeReplPath: "/chatgpt/node_repl",
          nodePath: "/chatgpt/node",
          nodeModulesPath: "/chatgpt/node_modules",
          helperPath: "/codex-home/computer-use/Codex Computer Use.app",
        },
      },
    });

    expect(state).toMatchObject({
      decision: { effective: "sidecar" },
      imageDecision: { effective: "active", backend: "codex-oauth" },
      computerUseDecision: { effective: "active", transport: "node-repl" },
    });
    expect(active).toEqual([
      "read",
      WEB_SEARCH_TOOL,
      IMAGE_GENERATION_TOOL,
      ...COMPUTER_USE_TOOLS,
    ]);
    expect(inspectRemoteCompactionRoute(grok, modelRegistry)).toEqual({
      ok: false,
      reason: "unsupported-provider",
    });
  });

  it("adds and removes only the Toolkit tool across model switches", () => {
    let active = ["read", "third_party_tool"];
    const setActiveTools = vi.fn((names: string[]) => {
      active = names;
    });
    const pi = {
      getActiveTools: () => active,
      setActiveTools,
      getAllTools: () => [
        {
          name: WEB_SEARCH_TOOL,
          sourceInfo: {
            path: "/extension/src/index.ts",
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
      ],
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const ctx = {
      model: model(),
      modelRegistry: registry(),
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;

    expect(
      syncOwnedTool(pi, sidecarConfig(), ctx, "/extension/src/index.ts"),
    ).toMatchObject({ decision: { effective: "native" }, conflict: false });
    expect(active).toEqual(["read", "third_party_tool"]);

    ctx.model = otherModel();
    expect(
      syncOwnedTool(pi, sidecarConfig(), ctx, "/extension/src/index.ts"),
    ).toMatchObject({ decision: { effective: "sidecar" }, conflict: false });
    expect(active).toEqual(["read", "third_party_tool", WEB_SEARCH_TOOL]);

    ctx.model = model();
    expect(
      syncOwnedTool(pi, sidecarConfig(), ctx, "/extension/src/index.ts"),
    ).toMatchObject({ decision: { effective: "native" } });
    expect(active).toEqual(["read", "third_party_tool"]);
    expect(setActiveTools).toHaveBeenCalledTimes(2);
  });

  it("forced Sidecar remains the sole Toolkit path on an OpenAI main model", () => {
    let active = ["read"];
    const config = sidecarConfig();
    config.webSearch.backend = "sidecar";
    const pi = {
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = names;
      },
      getAllTools: () => [
        {
          name: WEB_SEARCH_TOOL,
          sourceInfo: {
            path: "/extension/src/index.ts",
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
      ],
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const state = syncOwnedTool(
      pi,
      config,
      { model: model(), modelRegistry: registry() } as unknown as Pick<
        ExtensionContext,
        "model" | "modelRegistry"
      >,
      "/extension/src/index.ts",
    );
    expect(state.decision).toEqual({ effective: "sidecar" });
    expect(active).toContain(WEB_SEARCH_TOOL);
  });

  it("does not mutate a conflicting third-party registration", () => {
    const setActiveTools = vi.fn();
    const pi = {
      getActiveTools: () => ["read", WEB_SEARCH_TOOL],
      setActiveTools,
      getAllTools: () => [
        {
          name: WEB_SEARCH_TOOL,
          sourceInfo: {
            path: "/other/extension.ts",
            source: "other",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
      ],
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const state = syncOwnedTool(
      pi,
      sidecarConfig(),
      { model: otherModel(), modelRegistry: registry() } as unknown as Pick<
        ExtensionContext,
        "model" | "modelRegistry"
      >,
      "/extension/src/index.ts",
    );
    expect(state.conflict).toBe(true);
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  it("removes its own tool when disabled without touching other tools", () => {
    let active = ["read", WEB_SEARCH_TOOL, "other"];
    const pi = {
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = names;
      },
      getAllTools: () => [
        {
          name: WEB_SEARCH_TOOL,
          sourceInfo: {
            path: "/extension/src/index.ts",
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
      ],
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    syncOwnedTool(
      pi,
      defaultConfig(),
      { model: otherModel(), modelRegistry: registry() } as unknown as Pick<
        ExtensionContext,
        "model" | "modelRegistry"
      >,
      "/extension/src/index.ts",
    );
    expect(active).toEqual(["read", "other"]);
  });

  it("activates find_tools only when discovery is enabled and the winner is owned", () => {
    let active = ["read", "other"];
    let sourcePath = "/extension/src/index.ts";
    const pi = {
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = names;
      },
      getAllTools: () => [
        {
          name: TOOL_DISCOVERY_TOOL,
          sourceInfo: {
            path: sourcePath,
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
      ],
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const ctx = {
      model: otherModel(),
      modelRegistry: registry(),
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;

    // Registered but inactive while the feature is off.
    syncOwnedTool(pi, defaultConfig(), ctx, "/extension/src/index.ts");
    expect(active).toEqual(["read", "other"]);

    const config = defaultConfig();
    config.toolDiscovery.enabled = true;
    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts"),
    ).toMatchObject({ findToolsConflict: false });
    expect(active).toEqual(["read", "other", TOOL_DISCOVERY_TOOL]);

    // A visible foreign winner keeps its activation state and is reported.
    sourcePath = "/other/find_tools.ts";
    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts"),
    ).toMatchObject({ findToolsConflict: true });
    expect(active).toEqual(["read", "other", TOOL_DISCOVERY_TOOL]);

    // Disabling discovery removes only the Toolkit-owned name.
    sourcePath = "/extension/src/index.ts";
    syncOwnedTool(pi, defaultConfig(), ctx, "/extension/src/index.ts");
    expect(active).toEqual(["read", "other"]);
  });

  it("hides deferred image until loaded, and restores it when find_tools is foreign", () => {
    let active = ["read"];
    let findToolsPath = "/extension/src/index.ts";
    const pi = {
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = names;
      },
      getAllTools: () => [
        {
          name: IMAGE_GENERATION_TOOL,
          sourceInfo: {
            path: "/extension/src/index.ts",
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
        {
          name: TOOL_DISCOVERY_TOOL,
          sourceInfo: {
            path: findToolsPath,
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
      ],
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const config = defaultConfig();
    config.toolDiscovery.enabled = true;
    config.imageGeneration.enabled = true;
    const ctx = {
      model: otherModel(),
      modelRegistry: registry(),
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;

    syncOwnedTool(pi, config, ctx, "/extension/src/index.ts");
    expect(active).toEqual(["read", TOOL_DISCOVERY_TOOL]);

    syncOwnedTool(pi, config, ctx, "/extension/src/index.ts", {
      discovered: [IMAGE_GENERATION_TOOL],
    });
    expect(active).toEqual([
      "read",
      TOOL_DISCOVERY_TOOL,
      IMAGE_GENERATION_TOOL,
    ]);

    findToolsPath = "/other/find_tools.ts";
    expect(
      syncOwnedTool(pi, config, ctx, "/extension/src/index.ts"),
    ).toMatchObject({ findToolsConflict: true });
    expect(active).toContain(IMAGE_GENERATION_TOOL);
    expect(active).toContain(TOOL_DISCOVERY_TOOL);

    config.toolDiscovery.enabled = false;
    findToolsPath = "/extension/src/index.ts";
    syncOwnedTool(pi, config, ctx, "/extension/src/index.ts");
    expect(active).toContain(IMAGE_GENERATION_TOOL);
    expect(active).not.toContain(TOOL_DISCOVERY_TOOL);
  });
});

describe("extension registration", () => {
  it("executes the native Pi image result without a duplicate session entry", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "pct-image-tool-"));
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;

    try {
      const config = defaultConfig();
      config.imageGeneration.enabled = true;
      await mkdir(join(agentDirectory, "extensions"), { recursive: true });
      await writeFile(
        join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
        JSON.stringify(config),
        "utf8",
      );

      const handlers = new Map<string, ExtensionHandler<never, unknown>>();
      const tools = new Map<string, ToolDefinition>();
      const sourcePath = fileURLToPath(
        new URL("../src/index.ts", import.meta.url),
      );
      let active: string[] = ["read"];
      const pi = {
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
        registerCommand: () => undefined,
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
      const current = model({ input: ["text"] });
      const fallback = model({ id: "image-fallback", name: "Image fallback" });
      let availableModels = [current, fallback];
      const appendCustomEntry = vi.fn();
      let authFailure = false;
      let refreshedBaseUrl: string | undefined;
      const getApiKeyAndHeaders = vi.fn<
        ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]
      >(async () => {
        if (authFailure) throw new Error("SECRET_AUTH_FAILURE");
        return {
          ok: true as const,
          apiKey: "test-key",
          baseUrl: refreshedBaseUrl,
        };
      });
      const ctx = {
        model: current,
        modelRegistry: {
          getAvailable: () => availableModels,
          isUsingOAuth: () => false,
          getApiKeyAndHeaders,
        },
        sessionManager: { appendCustomEntry },
      } as unknown as ExtensionContext;
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
      ]);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }),
          ),
        );

      piCodexToolkit(withEventBus(pi));
      await handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" } as never,
        ctx,
      );
      expect(active).toEqual(["read", IMAGE_GENERATION_TOOL]);

      const imageTool = tools.get(IMAGE_GENERATION_TOOL);
      if (!imageTool) throw new Error("image tool was not registered");
      const result = await imageTool.execute(
        "image-call-1",
        { prompt: "a small blue square" },
        undefined,
        undefined,
        ctx,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining(
          "The current model cannot visually inspect this image.",
        ),
      });
      expect(result.content[1]).toEqual({
        type: "image",
        data: png.toString("base64"),
        mimeType: "image/png",
      });
      expect(result.details).toEqual({
        path: expect.stringMatching(/\.png$/),
        mimeType: "image/png",
      });
      const details = result.details as { path: string; mimeType: string };
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining(details.path),
      });
      await expect(readFile(details.path)).resolves.toEqual(png);
      expect(JSON.stringify(result.details)).not.toContain(
        "a small blue square",
      );
      expect(JSON.stringify(result.details)).not.toContain(
        png.toString("base64"),
      );
      expect(appendCustomEntry).not.toHaveBeenCalled();

      authFailure = true;
      await expect(
        imageTool.execute(
          "image-call-2",
          { prompt: "another image" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(
        "OpenAI Image Generation is unavailable: route-resolution-failed.",
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      authFailure = false;
      refreshedBaseUrl = "https://gateway.example/v1";
      await expect(
        imageTool.execute(
          "image-call-3",
          { prompt: "third image" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(
        "OpenAI Image Generation is unavailable: unofficial-endpoint.",
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      refreshedBaseUrl = undefined;
      getApiKeyAndHeaders.mockResolvedValueOnce({ ok: true });
      await expect(
        imageTool.execute(
          "image-no-key",
          { prompt: "private" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(
        "OpenAI Image Generation is unavailable: missing-openai-auth.",
      );
      getApiKeyAndHeaders.mockResolvedValueOnce({
        ok: false,
        error: "SECRET_RETURNED_AUTH_ERROR",
      });
      await expect(
        imageTool.execute(
          "image-missing",
          { prompt: "private" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(
        "OpenAI Image Generation is unavailable: missing-openai-auth.",
      );
      // Structural selection succeeds; only the refreshed credential-kind check throws.
      vi.spyOn(ctx.modelRegistry, "isUsingOAuth")
        .mockReturnValueOnce(false)
        .mockImplementationOnce(() => {
          throw new Error("SECRET_IDENTITY_ERROR");
        });
      await expect(
        imageTool.execute(
          "image-identity",
          { prompt: "private" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(
        "OpenAI Image Generation is unavailable: route-resolution-failed.",
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(getApiKeyAndHeaders).toHaveBeenCalledTimes(6);
      expect(
        getApiKeyAndHeaders.mock.calls.map(([candidate]) => candidate.id),
      ).toEqual(Array(6).fill(current.id));

      availableModels = [];
      await handlers.get("model_select")?.(
        { type: "model_select", model: current } as never,
        ctx,
      );
      expect(active).toEqual(["read"]);
    } finally {
      if (previousAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
      }
      await rm(agentDirectory, { recursive: true, force: true });
    }
  });

  async function shellLifecycleCase(probe?: ShellLifecycleProbe) {
    const body = async (resources: ShellLifecycleResources) => {
      const agentDirectory = resources.root;
      const config = defaultConfig();
      config.shellSessions.enabled = true;
      await mkdir(join(agentDirectory, "extensions"), { recursive: true });
      const configPath = join(
        agentDirectory,
        "extensions",
        "pi-codex-toolkit.json",
      );
      await writeFile(configPath, JSON.stringify(config), "utf8");

      const handlers = new Map<string, ExtensionHandler<never, unknown>>();
      const tools = new Map<string, ToolDefinition>();
      let command: RegisteredCommand["handler"] | undefined;
      const sourcePath = fileURLToPath(
        new URL("../src/index.ts", import.meta.url),
      );
      let active: string[] = ["read"];
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
      const ctx = {
        cwd: process.cwd(),
        model: otherModel(),
        modelRegistry: registry(),
        hasUI: true,
        ui: { notify: vi.fn() },
      } as unknown as ExtensionContext & ExtensionCommandContext;

      resources.shutdown = () =>
        handlers.get("session_shutdown")?.(
          { type: "session_shutdown", reason: "quit" } as never,
          ctx,
        );
      piCodexToolkit(withEventBus(pi));
      await handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" } as never,
        ctx,
      );
      resources.checkpoint("before-spawn");
      expect(active).toEqual(
        expect.arrayContaining([EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL]),
      );

      const exec = tools.get(EXEC_COMMAND_TOOL);
      const write = tools.get(WRITE_STDIN_TOOL);
      if (!exec || !write) throw new Error("shell tools were not registered");
      const started = await exec.execute(
        "shell-1",
        { command: "echo $$; sleep 30", yieldTimeMs: 2000 },
        undefined,
        undefined,
        ctx,
      );
      const details = started.details as {
        sessionId: string;
        stdout: string;
      };
      const pid = Number(details.stdout.trim());
      resources.checkpoint("after-spawn");
      expect(isAlive(pid)).toBe(true);

      await handlers.get("model_select")?.(
        { type: "model_select" } as never,
        ctx,
      );
      expect(active).toEqual(
        expect.arrayContaining([EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL]),
      );
      const unchangedReload = await write.execute(
        "shell-2",
        { sessionId: details.sessionId, yieldTimeMs: 150 },
        undefined,
        undefined,
        ctx,
      );
      expect((unchangedReload.details as { status: string }).status).toBe(
        "running",
      );
      expect(isAlive(pid)).toBe(true);

      if (!command) throw new Error("pct command was not registered");
      await command("reload", ctx);
      expect(isAlive(pid)).toBe(true);

      config.shellSessions.enabled = false;
      await writeFile(configPath, JSON.stringify(config), "utf8");
      await command("reload", ctx);
      expect(active).not.toContain(EXEC_COMMAND_TOOL);
      expect(await waitUntil(() => !isAlive(pid))).toBe(true);
      await expect(
        write.execute(
          "shell-3",
          { sessionId: details.sessionId, yieldTimeMs: 100 },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("not enabled");

      config.shellSessions.enabled = true;
      await writeFile(configPath, JSON.stringify(config), "utf8");
      await command("reload", ctx);
      for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
        const session = await exec.execute(
          `shutdown-${reason}`,
          { command: "echo $$; sleep 30", yieldTimeMs: 2000 },
          undefined,
          undefined,
          ctx,
        );
        const sessionDetails = session.details as {
          sessionId: string;
          stdout: string;
        };
        const sessionPid = Number(sessionDetails.stdout.trim());
        await handlers.get("session_shutdown")?.(
          { type: "session_shutdown", reason } as never,
          ctx,
        );
        expect(await waitUntil(() => !isAlive(sessionPid))).toBe(true);
        await expect(
          exec.execute(
            "stopped-start",
            { command: "printf forbidden" },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow("not enabled");
        // This harness reuses the factory: a new session must explicitly rebind.
        await handlers.get("session_start")?.(
          { type: "session_start", reason: "new" } as never,
          ctx,
        );
        await expect(
          write.execute(
            `after-${reason}`,
            { sessionId: sessionDetails.sessionId, yieldTimeMs: 100 },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toMatchObject({ code: "stale-session" });
      }
    };
    await withShellLifecycleResources("pct-shell-lifecycle-", body, probe);
  }

  it(
    "keeps shell sessions across model changes and closes them on shutdown",
    () => shellLifecycleCase(),
    120_000,
  );

  it("keeps Code Mode cells across reload and model changes and releases them on disablement", async () => {
    await withExecutionLifecycleResources(
      "pct-code-mode-lifecycle-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.shellSessions.enabled = true;
        config.codeMode.enabled = true;
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        const configPath = join(
          agentDirectory,
          "extensions",
          "pi-codex-toolkit.json",
        );
        await writeFile(configPath, JSON.stringify(config), "utf8");

        const handlers = new Map<string, ExtensionHandler<never, unknown>>();
        const tools = new Map<string, ToolDefinition>();
        let command: RegisteredCommand["handler"] | undefined;
        const sourcePath = fileURLToPath(
          new URL("../src/index.ts", import.meta.url),
        );
        let active: string[] = ["read"];
        let conflictingCodeModeName: string | undefined;
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
                  tool.name === conflictingCodeModeName
                    ? "/other/code-mode.ts"
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
        const ctx = {
          cwd: process.cwd(),
          model: otherModel(),
          modelRegistry: registry(),
          hasUI: true,
          ui: { notify: vi.fn() },
        } as unknown as ExtensionContext & ExtensionCommandContext;

        resources.shutdown = () =>
          handlers.get("session_shutdown")?.(
            { type: "session_shutdown", reason: "quit" } as never,
            ctx,
          );
        piCodexToolkit(withEventBus(pi));
        await handlers.get("session_start")?.(
          { type: "session_start", reason: "startup" } as never,
          ctx,
        );
        expect(active).toEqual(
          expect.arrayContaining([
            EXEC_COMMAND_TOOL,
            WRITE_STDIN_TOOL,
            CODE_MODE_EXEC_TOOL,
            CODE_MODE_WAIT_TOOL,
          ]),
        );

        const execCommand = tools.get(EXEC_COMMAND_TOOL);
        const writeStdin = tools.get(WRITE_STDIN_TOOL);
        const exec = tools.get(CODE_MODE_EXEC_TOOL);
        const wait = tools.get(CODE_MODE_WAIT_TOOL);
        if (!execCommand || !writeStdin || !exec || !wait) {
          throw new Error("shell or Code Mode tools were not registered");
        }

        const shell = await execCommand.execute(
          "shell-1",
          { command: "echo $$; sleep 30", yieldTimeMs: 2000 },
          undefined,
          undefined,
          ctx,
        );
        const shellDetails = shell.details as {
          sessionId: string;
          stdout: string;
        };
        const pid = Number(shellDetails.stdout.trim());
        expect(isAlive(pid)).toBe(true);

        const cell = await exec.execute(
          "exec-1",
          {
            code: "await new Promise(() => {}); return 1;",
            yieldTimeMs: 0,
          },
          undefined,
          undefined,
          ctx,
        );
        const cellDetails = cell.details as { cellId: string; status: string };
        expect(cellDetails.status).toBe("running");

        await handlers.get("model_select")?.(
          { type: "model_select" } as never,
          ctx,
        );
        expect(active).toEqual(
          expect.arrayContaining([CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL]),
        );
        const afterModel = await wait.execute(
          "wait-1",
          { cellId: cellDetails.cellId, yieldTimeMs: 100 },
          undefined,
          undefined,
          ctx,
        );
        expect((afterModel.details as { status: string }).status).toBe(
          "running",
        );

        if (!command) throw new Error("pct command was not registered");
        await command("reload", ctx);
        const afterReload = await wait.execute(
          "wait-2",
          { cellId: cellDetails.cellId, yieldTimeMs: 100 },
          undefined,
          undefined,
          ctx,
        );
        expect((afterReload.details as { status: string }).status).toBe(
          "running",
        );

        // A later owned-name conflict deactivates both Toolkit names and
        // releases cells while leaving the standalone shell session alone.
        conflictingCodeModeName = CODE_MODE_WAIT_TOOL;
        await handlers.get("model_select")?.(
          { type: "model_select" } as never,
          ctx,
        );
        expect(active).toContain(CODE_MODE_WAIT_TOOL);
        expect(active).not.toContain(CODE_MODE_EXEC_TOOL);
        expect(isAlive(pid)).toBe(true);
        conflictingCodeModeName = undefined;
        await handlers.get("model_select")?.(
          { type: "model_select" } as never,
          ctx,
        );
        expect(active).toEqual(
          expect.arrayContaining([CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL]),
        );
        await expect(
          wait.execute(
            "wait-conflict",
            { cellId: cellDetails.cellId, yieldTimeMs: 100 },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toMatchObject({ code: "stale-cell" });

        config.codeMode.enabled = false;
        await writeFile(configPath, JSON.stringify(config), "utf8");
        await command("reload", ctx);
        expect(active).not.toContain(CODE_MODE_EXEC_TOOL);
        expect(active).not.toContain(CODE_MODE_WAIT_TOOL);
        await expect(
          wait.execute(
            "wait-3",
            { cellId: cellDetails.cellId, yieldTimeMs: 100 },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow("Code Mode is not enabled.");
        await expect(
          exec.execute(
            "exec-2",
            { code: "return 1;" },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow("Code Mode is not enabled.");

        // Standalone shell sessions survive Code Mode teardown.
        expect(isAlive(pid)).toBe(true);
        const shellAfter = await writeStdin.execute(
          "shell-2",
          { sessionId: shellDetails.sessionId, yieldTimeMs: 150 },
          undefined,
          undefined,
          ctx,
        );
        expect((shellAfter.details as { status: string }).status).toBe(
          "running",
        );

        // Re-enabling invalidates the released handle, and shutdown releases
        // cells started afterwards.
        config.codeMode.enabled = true;
        await writeFile(configPath, JSON.stringify(config), "utf8");
        await command("reload", ctx);
        await expect(
          wait.execute(
            "wait-4",
            { cellId: cellDetails.cellId, yieldTimeMs: 100 },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toMatchObject({ code: "stale-cell" });

        const revived = await exec.execute(
          "exec-3",
          { code: "await new Promise(() => {}); return 1;", yieldTimeMs: 0 },
          undefined,
          undefined,
          ctx,
        );
        const revivedDetails = revived.details as {
          cellId: string;
          status: string;
        };
        expect(revivedDetails.status).toBe("running");
        await handlers.get("session_shutdown")?.(
          { type: "session_shutdown", reason: "quit" } as never,
          ctx,
        );
        await expect(
          exec.execute(
            "stopped-exec",
            { code: "return 1;" },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow("not enabled");
        await handlers.get("session_start")?.(
          { type: "session_start", reason: "new" } as never,
          ctx,
        );
        await expect(
          wait.execute(
            "wait-5",
            { cellId: revivedDetails.cellId, yieldTimeMs: 100 },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toMatchObject({ code: "stale-cell" });
      },
    );
  });

  it("defers, discovers, loads, and restores owned tools across discovery lifecycle", async () => {
    const agentDirectory = await mkdtemp(
      join(tmpdir(), "pct-discovery-lifecycle-"),
    );
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;

    try {
      const config = defaultConfig();
      config.applyPatch.enabled = true;
      config.shellSessions.enabled = true;
      config.codeMode.enabled = true;
      config.toolDiscovery.enabled = false;
      config.toolDiscovery.deferred = [
        APPLY_PATCH_TOOL,
        EXEC_COMMAND_TOOL,
        CODE_MODE_WAIT_TOOL,
      ];
      await mkdir(join(agentDirectory, "extensions"), { recursive: true });
      const configPath = join(
        agentDirectory,
        "extensions",
        "pi-codex-toolkit.json",
      );
      await writeFile(configPath, JSON.stringify(config), "utf8");

      const handlers = new Map<string, ExtensionHandler<never, unknown>>();
      const tools = new Map<string, ToolDefinition>();
      let command: RegisteredCommand["handler"] | undefined;
      const sourcePath = fileURLToPath(
        new URL("../src/index.ts", import.meta.url),
      );
      let active: string[] = ["read", "third_party"];
      let conflictingName: string | undefined;
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
                tool.name === conflictingName ? "/other/tools.ts" : sourcePath,
              source: "test",
              scope: "user" as const,
              origin: "package" as const,
            },
          })),
        setActiveTools: (names: string[]) => {
          active = names;
        },
      } as unknown as ExtensionAPI;
      const ctx = {
        cwd: process.cwd(),
        model: otherModel(),
        modelRegistry: registry(),
        hasUI: false,
      } as unknown as ExtensionContext & ExtensionCommandContext;

      piCodexToolkit(withEventBus(pi));
      await handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" } as never,
        ctx,
      );

      // Discovery is off: ordinary owned exposure and no find_tools.
      expect(active).toEqual(
        expect.arrayContaining([
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          CODE_MODE_WAIT_TOOL,
          "read",
          "third_party",
        ]),
      );
      expect(active).not.toContain(TOOL_DISCOVERY_TOOL);

      const findTools = tools.get(TOOL_DISCOVERY_TOOL);
      if (!findTools) throw new Error("find_tools was not registered");
      await expect(
        findTools.execute(
          "discovery-off",
          { query: "patch" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("Tool discovery is not enabled.");

      if (!command) throw new Error("pct command was not registered");

      // Enabling discovery hides the explicitly deferred set but keeps the
      // discovery tool itself available.
      config.toolDiscovery.enabled = true;
      await writeFile(configPath, JSON.stringify(config), "utf8");
      await command("reload", ctx);
      expect(active).toContain(TOOL_DISCOVERY_TOOL);
      expect(active).not.toContain(APPLY_PATCH_TOOL);
      expect(active).not.toContain(EXEC_COMMAND_TOOL);
      expect(active).not.toContain(CODE_MODE_WAIT_TOOL);
      expect(active).toEqual(expect.arrayContaining(["read", "third_party"]));

      const search = await findTools.execute(
        "discovery-1",
        { query: "patch" },
        undefined,
        undefined,
        ctx,
      );
      expect(search.details).toMatchObject({
        matches: [
          {
            name: APPLY_PATCH_TOOL,
            state: "eligible",
            summary: expect.stringContaining("patch"),
          },
        ],
      });

      const loaded = await findTools.execute(
        "discovery-2",
        { load: [APPLY_PATCH_TOOL, EXEC_COMMAND_TOOL, CODE_MODE_WAIT_TOOL] },
        undefined,
        undefined,
        ctx,
      );
      expect(loaded.details).toMatchObject({
        loaded: [APPLY_PATCH_TOOL, EXEC_COMMAND_TOOL, CODE_MODE_WAIT_TOOL],
      });
      expect(active).toEqual(
        expect.arrayContaining([
          TOOL_DISCOVERY_TOOL,
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]),
      );

      // An ordinary model change must not hide a discovery-loaded name.
      await handlers.get("model_select")?.(
        { type: "model_select" } as never,
        ctx,
      );
      expect(active).toEqual(
        expect.arrayContaining([
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]),
      );

      // An unchanged `/pct reload` keeps discovery-loaded names as well.
      await command("reload", ctx);
      expect(active).toEqual(
        expect.arrayContaining([
          TOOL_DISCOVERY_TOOL,
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]),
      );

      // A conflicting deferred name stays unavailable and is rejected instead
      // of replacing the third-party winner or dropping unrelated tools.
      conflictingName = CODE_MODE_WAIT_TOOL;
      const conflictedSearch = await findTools.execute(
        "discovery-3",
        { query: "cell" },
        undefined,
        undefined,
        ctx,
      );
      expect(conflictedSearch.details).toMatchObject({
        matches: [
          {
            name: CODE_MODE_WAIT_TOOL,
            state: "unavailable",
            reason: "conflicting-tool-name",
          },
        ],
      });
      const conflictedLoad = await findTools.execute(
        "discovery-4",
        { load: [CODE_MODE_WAIT_TOOL, EXEC_COMMAND_TOOL] },
        undefined,
        undefined,
        ctx,
      );
      expect(conflictedLoad.details).toMatchObject({
        loaded: [EXEC_COMMAND_TOOL],
        rejected: [
          { name: CODE_MODE_WAIT_TOOL, reason: "conflicting-tool-name" },
        ],
      });
      await handlers.get("model_select")?.(
        { type: "model_select" } as never,
        ctx,
      );
      expect(active).toEqual(
        expect.arrayContaining([
          "read",
          "third_party",
          TOOL_DISCOVERY_TOOL,
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
        ]),
      );
      conflictingName = undefined;

      // Disabling discovery restores ordinary exposure and forgets the
      // session's load choice; re-enabling hides the deferred set again.
      config.toolDiscovery.enabled = false;
      await writeFile(configPath, JSON.stringify(config), "utf8");
      await command("reload", ctx);
      expect(active).not.toContain(TOOL_DISCOVERY_TOOL);
      expect(active).toEqual(
        expect.arrayContaining([
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]),
      );

      config.toolDiscovery.enabled = true;
      await writeFile(configPath, JSON.stringify(config), "utf8");
      await command("reload", ctx);
      expect(active).toContain(TOOL_DISCOVERY_TOOL);
      expect(active).not.toContain(APPLY_PATCH_TOOL);

      const reloaded = await findTools.execute(
        "discovery-5",
        { load: [APPLY_PATCH_TOOL] },
        undefined,
        undefined,
        ctx,
      );
      expect(reloaded.details).toMatchObject({ loaded: [APPLY_PATCH_TOOL] });
      expect(active).toContain(APPLY_PATCH_TOOL);

      // A new, resumed, or forked session starts with deferred tools hidden.
      await handlers.get("session_start")?.(
        { type: "session_start", reason: "fork" } as never,
        ctx,
      );
      expect(active).not.toContain(APPLY_PATCH_TOOL);
      expect(active).toContain(TOOL_DISCOVERY_TOOL);

      // A config-disabled capability stays unavailable to discovery.
      config.shellSessions.enabled = false;
      await writeFile(configPath, JSON.stringify(config), "utf8");
      await command("reload", ctx);
      const disabledLoad = await findTools.execute(
        "discovery-6",
        { load: [EXEC_COMMAND_TOOL] },
        undefined,
        undefined,
        ctx,
      );
      expect(disabledLoad.details).toMatchObject({
        rejected: [{ name: EXEC_COMMAND_TOOL, reason: "disabled" }],
      });
      expect(active).not.toContain(EXEC_COMMAND_TOOL);
    } finally {
      if (previousAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
      }
      await rm(agentDirectory, { recursive: true, force: true });
    }
  });

  it("keeps a loaded deferred name after a find_tools conflict and when the loader returns", async () => {
    const agentDirectory = await mkdtemp(
      join(tmpdir(), "pct-discovery-conflict-loads-"),
    );
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;

    try {
      const config = defaultConfig();
      config.applyPatch.enabled = true;
      config.shellSessions.enabled = true;
      config.toolDiscovery.enabled = true;
      config.toolDiscovery.deferred = [APPLY_PATCH_TOOL, EXEC_COMMAND_TOOL];
      await mkdir(join(agentDirectory, "extensions"), { recursive: true });
      await writeFile(
        join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
        JSON.stringify(config),
        "utf8",
      );

      const handlers = new Map<string, ExtensionHandler<never, unknown>>();
      const tools = new Map<string, ToolDefinition>();
      const sourcePath = fileURLToPath(
        new URL("../src/index.ts", import.meta.url),
      );
      let active: string[] = ["read"];
      let findToolsPath = sourcePath;
      const pi = {
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
        registerCommand: () => undefined,
        on: (event: string, handler: ExtensionHandler<never, unknown>) => {
          handlers.set(event, handler);
        },
        getActiveTools: () => active,
        getAllTools: () =>
          [...tools.values()].map((tool) => ({
            ...tool,
            sourceInfo: {
              path:
                tool.name === TOOL_DISCOVERY_TOOL ? findToolsPath : sourcePath,
              source: "test",
              scope: "user" as const,
              origin: "package" as const,
            },
          })),
        setActiveTools: (names: string[]) => {
          active = names;
        },
      } as unknown as ExtensionAPI;
      const ctx = {
        cwd: process.cwd(),
        model: otherModel(),
        modelRegistry: registry(),
      } as unknown as ExtensionContext;

      piCodexToolkit(withEventBus(pi));
      await handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" } as never,
        ctx,
      );
      expect(active).toContain(TOOL_DISCOVERY_TOOL);
      expect(active).not.toContain(APPLY_PATCH_TOOL);
      expect(active).not.toContain(EXEC_COMMAND_TOOL);

      const findTools = tools.get(TOOL_DISCOVERY_TOOL);
      if (!findTools) throw new Error("find_tools was not registered");
      const loaded = await findTools.execute(
        "keep-loads-1",
        { load: [APPLY_PATCH_TOOL] },
        undefined,
        undefined,
        ctx,
      );
      expect(loaded.details).toMatchObject({ loaded: [APPLY_PATCH_TOOL] });
      expect(active).toContain(APPLY_PATCH_TOOL);
      expect(active).not.toContain(EXEC_COMMAND_TOOL);

      findToolsPath = "/other/find_tools.ts";
      await handlers.get("model_select")?.(
        { type: "model_select" } as never,
        ctx,
      );
      expect(active).toContain(APPLY_PATCH_TOOL);
      expect(active).toContain(EXEC_COMMAND_TOOL);

      findToolsPath = sourcePath;
      await handlers.get("model_select")?.(
        { type: "model_select" } as never,
        ctx,
      );
      expect(active).toContain(APPLY_PATCH_TOOL);
      expect(active).not.toContain(EXEC_COMMAND_TOOL);
      expect(active).toContain(TOOL_DISCOVERY_TOOL);
    } finally {
      if (previousAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
      }
      await rm(agentDirectory, { recursive: true, force: true });
    }
  });

  it("requires the sibling shell or Code Mode name to be eligible for a discovery load", async () => {
    const agentDirectory = await mkdtemp(
      join(tmpdir(), "pct-discovery-pair-eligibility-"),
    );
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;

    try {
      const config = defaultConfig();
      config.shellSessions.enabled = true;
      config.codeMode.enabled = true;
      config.toolDiscovery.enabled = true;
      config.toolDiscovery.deferred = [
        EXEC_COMMAND_TOOL,
        WRITE_STDIN_TOOL,
        CODE_MODE_EXEC_TOOL,
        CODE_MODE_WAIT_TOOL,
      ];
      await mkdir(join(agentDirectory, "extensions"), { recursive: true });
      await writeFile(
        join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
        JSON.stringify(config),
        "utf8",
      );

      const handlers = new Map<string, ExtensionHandler<never, unknown>>();
      const tools = new Map<string, ToolDefinition>();
      const sourcePath = fileURLToPath(
        new URL("../src/index.ts", import.meta.url),
      );
      let active: string[] = ["read"];
      let foreignName: string | undefined;
      let filteredName: string | undefined;
      const pi = {
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
        registerCommand: () => undefined,
        on: (event: string, handler: ExtensionHandler<never, unknown>) => {
          handlers.set(event, handler);
        },
        getActiveTools: () => active,
        getAllTools: () =>
          [...tools.values()]
            .filter((tool) => tool.name !== filteredName)
            .map((tool) => ({
              ...tool,
              sourceInfo: {
                path:
                  tool.name === foreignName ? "/other/tools.ts" : sourcePath,
                source: "test",
                scope: "user" as const,
                origin: "package" as const,
              },
            })),
        setActiveTools: (names: string[]) => {
          active = names;
        },
      } as unknown as ExtensionAPI;
      const ctx = {
        cwd: process.cwd(),
        model: otherModel(),
        modelRegistry: registry(),
      } as unknown as ExtensionContext;

      piCodexToolkit(withEventBus(pi));
      await handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" } as never,
        ctx,
      );

      const findTools = tools.get(TOOL_DISCOVERY_TOOL);
      if (!findTools) throw new Error("find_tools was not registered");
      const load = (names: string[]) =>
        findTools.execute(
          "pair-eligibility",
          { load: names },
          undefined,
          undefined,
          ctx,
        );

      // A foreign winner on one shell name blocks a load of its sibling.
      foreignName = WRITE_STDIN_TOOL;
      const blockedExec = await load([EXEC_COMMAND_TOOL]);
      expect(blockedExec.details).toEqual({
        rejected: [
          { name: EXEC_COMMAND_TOOL, reason: "conflicting-tool-name" },
        ],
      });
      expect(active).not.toContain(EXEC_COMMAND_TOOL);

      foreignName = EXEC_COMMAND_TOOL;
      const blockedWrite = await load([WRITE_STDIN_TOOL]);
      expect(blockedWrite.details).toEqual({
        rejected: [{ name: WRITE_STDIN_TOOL, reason: "conflicting-tool-name" }],
      });
      expect(active).not.toContain(WRITE_STDIN_TOOL);

      // The same rule holds for the Code Mode pair.
      foreignName = CODE_MODE_WAIT_TOOL;
      const blockedExecCell = await load([CODE_MODE_EXEC_TOOL]);
      expect(blockedExecCell.details).toEqual({
        rejected: [
          { name: CODE_MODE_EXEC_TOOL, reason: "conflicting-tool-name" },
        ],
      });
      expect(active).not.toContain(CODE_MODE_EXEC_TOOL);

      foreignName = CODE_MODE_EXEC_TOOL;
      const blockedWait = await load([CODE_MODE_WAIT_TOOL]);
      expect(blockedWait.details).toEqual({
        rejected: [
          { name: CODE_MODE_WAIT_TOOL, reason: "conflicting-tool-name" },
        ],
      });
      expect(active).not.toContain(CODE_MODE_WAIT_TOOL);

      // A query reports the pair as unavailable through the same check.
      foreignName = EXEC_COMMAND_TOOL;
      const search = await findTools.execute(
        "pair-eligibility-search",
        { query: "forward text" },
        undefined,
        undefined,
        ctx,
      );
      expect(search.details).toMatchObject({
        matches: [
          {
            name: WRITE_STDIN_TOOL,
            summary: expect.any(String),
            state: "unavailable",
            reason: "conflicting-tool-name",
          },
        ],
      });

      // An absent sibling (`--tools`-style projection) is `not-registered`.
      foreignName = undefined;
      filteredName = WRITE_STDIN_TOOL;
      const absentWrite = await load([EXEC_COMMAND_TOOL]);
      expect(absentWrite.details).toEqual({
        rejected: [{ name: EXEC_COMMAND_TOOL, reason: "not-registered" }],
      });
      expect(active).not.toContain(EXEC_COMMAND_TOOL);

      filteredName = EXEC_COMMAND_TOOL;
      const absentExec = await load([WRITE_STDIN_TOOL]);
      expect(absentExec.details).toEqual({
        rejected: [{ name: WRITE_STDIN_TOOL, reason: "not-registered" }],
      });
      expect(active).not.toContain(WRITE_STDIN_TOOL);

      // With both siblings eligible, the requested name loads additively and
      // the sibling is not auto-activated.
      filteredName = undefined;
      const loaded = await load([EXEC_COMMAND_TOOL, CODE_MODE_EXEC_TOOL]);
      expect(loaded.details).toEqual({
        loaded: [EXEC_COMMAND_TOOL, CODE_MODE_EXEC_TOOL],
      });
      expect(active).toContain(EXEC_COMMAND_TOOL);
      expect(active).toContain(CODE_MODE_EXEC_TOOL);
      expect(active).not.toContain(WRITE_STDIN_TOOL);
      expect(active).not.toContain(CODE_MODE_WAIT_TOOL);
    } finally {
      if (previousAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
      }
      await rm(agentDirectory, { recursive: true, force: true });
    }
  });

  it("loads and executes a deferred shell tool through ordinary dispatch with Code Mode off", async () => {
    await withExecutionLifecycleResources(
      "pct-discovery-ordinary-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.shellSessions.enabled = true;
        config.codeMode.enabled = false;
        config.toolDiscovery.enabled = true;
        config.toolDiscovery.deferred = [EXEC_COMMAND_TOOL];
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );

        const handlers = new Map<string, ExtensionHandler<never, unknown>>();
        const tools = new Map<string, ToolDefinition>();
        const sourcePath = fileURLToPath(
          new URL("../src/index.ts", import.meta.url),
        );
        let active: string[] = ["read"];
        const pi = {
          registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
          registerCommand: () => undefined,
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
        const ctx = {
          cwd: process.cwd(),
          model: otherModel(),
          modelRegistry: registry(),
        } as unknown as ExtensionContext;

        resources.shutdown = () =>
          handlers.get("session_shutdown")?.(
            { type: "session_shutdown", reason: "quit" } as never,
            ctx,
          );
        piCodexToolkit(withEventBus(pi));
        await handlers.get("session_start")?.(
          { type: "session_start", reason: "startup" } as never,
          ctx,
        );

        // Ordinary mode: the discovery tool is active, the deferred shell name
        // is hidden, and Code Mode stays off.
        expect(active).toContain(TOOL_DISCOVERY_TOOL);
        expect(active).not.toContain(EXEC_COMMAND_TOOL);
        expect(active).not.toContain(CODE_MODE_EXEC_TOOL);
        expect(active).not.toContain(CODE_MODE_WAIT_TOOL);

        const findTools = tools.get(TOOL_DISCOVERY_TOOL);
        if (!findTools) throw new Error("find_tools was not registered");
        const search = await findTools.execute(
          "ordinary-1",
          { query: "command" },
          undefined,
          undefined,
          ctx,
        );
        expect(search.details).toMatchObject({
          matches: [
            {
              name: EXEC_COMMAND_TOOL,
              state: "eligible",
              summary: expect.stringContaining("command"),
            },
          ],
        });

        const loaded = await findTools.execute(
          "ordinary-2",
          { load: [EXEC_COMMAND_TOOL] },
          undefined,
          undefined,
          ctx,
        );
        expect(loaded.details).toEqual({ loaded: [EXEC_COMMAND_TOOL] });
        expect(active).toContain(EXEC_COMMAND_TOOL);
        // The non-deferred sibling was already exposed by the ordinary
        // projection; loading exec_command changed only the requested name.
        expect(active).toContain(WRITE_STDIN_TOOL);
        expect(active).not.toContain(CODE_MODE_EXEC_TOOL);

        // Pi's normal next-turn dispatch executes the loaded definition through
        // the ordinary shell path; no Code Mode cell or nested adapter is used.
        const execCommand = tools.get(EXEC_COMMAND_TOOL);
        if (!execCommand) throw new Error("exec_command was not registered");
        const executed = await execCommand.execute(
          "ordinary-3",
          { command: "echo ordinary-ok" },
          undefined,
          undefined,
          ctx,
        );
        expect(executed.details).toMatchObject({
          status: "completed",
          exitCode: 0,
          stdout: "ordinary-ok\n",
        });
        expect(active).not.toContain(CODE_MODE_EXEC_TOOL);
        expect(active).not.toContain(CODE_MODE_WAIT_TOOL);
      },
    );
  });

  it("rechecks Toolkit Apply Patch ownership before nested dispatch", async () => {
    await withExecutionLifecycleResources(
      "pct-code-mode-apply-patch-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.applyPatch.enabled = true;
        config.codeMode.enabled = true;
        config.codeMode.approvalMode = "always";
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );

        const handlers = new Map<string, ExtensionHandler<never, unknown>>();
        const tools = new Map<string, ToolDefinition>();
        const sourcePath = fileURLToPath(
          new URL("../src/index.ts", import.meta.url),
        );
        let active: string[] = ["read"];
        let applyPatchSource = sourcePath;
        const pi = {
          registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
          registerCommand: () => undefined,
          on: (event: string, handler: ExtensionHandler<never, unknown>) => {
            handlers.set(event, handler);
          },
          getActiveTools: () => active,
          getAllTools: () =>
            [...tools.values()].map((tool) => ({
              ...tool,
              sourceInfo: {
                path:
                  tool.name === APPLY_PATCH_TOOL
                    ? applyPatchSource
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
        const ctx = {
          cwd: process.cwd(),
          model: otherModel(),
          modelRegistry: registry(),
        } as unknown as ExtensionContext;

        resources.shutdown = () =>
          handlers.get("session_shutdown")?.(
            { type: "session_shutdown", reason: "quit" } as never,
            ctx,
          );
        piCodexToolkit(withEventBus(pi));
        await handlers.get("session_start")?.(
          { type: "session_start", reason: "startup" } as never,
          ctx,
        );
        expect(active).toContain(APPLY_PATCH_TOOL);

        const exec = tools.get(CODE_MODE_EXEC_TOOL);
        if (!exec) throw new Error("exec was not registered");
        // A third-party apply_patch winner appears after the last sync; the
        // nested adapter must recheck ownership instead of dispatching.
        applyPatchSource = "/other/apply_patch.ts";
        // Admission is read live at exec, so the foreign winner is excluded
        // before the worker starts; a cell may not declare it at all.
        await expect(
          exec.execute(
            "exec-1",
            {
              code: 'return await tools.apply_patch({ patch: "*** Begin Patch\\n*** End Patch\\n" });',
              uses: [APPLY_PATCH_TOOL],
            },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toMatchObject({
          code: "invalid-uses",
          message: expect.stringContaining("not currently available"),
        });

        // Omitting `uses` never grants it either: the declared set is the
        // current admission snapshot, so the nested call fails inside the cell
        // without dispatching through the foreign winner.
        const fallback = await exec.execute(
          "exec-2",
          {
            code: 'try { await tools.apply_patch({ patch: "*** Begin Patch\\n*** End Patch\\n" }); return "dispatched"; } catch (error) { return error.message; }',
          },
          undefined,
          undefined,
          ctx,
        );
        const details = fallback.details as {
          status: string;
          result?: unknown;
        };
        expect(details.status).toBe("completed");
        expect(String(details.result)).toContain(
          'was not declared in "uses" for this cell',
        );
      },
    );
  });

  it("does not admit nested adapters for CLI-filtered names", async () => {
    await withExecutionLifecycleResources(
      "pct-code-mode-filtered-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.shellSessions.enabled = true;
        config.applyPatch.enabled = true;
        config.codeMode.enabled = true;
        config.codeMode.approvalMode = "always";
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );

        const handlers = new Map<string, ExtensionHandler<never, unknown>>();
        const tools = new Map<string, ToolDefinition>();
        const sourcePath = fileURLToPath(
          new URL("../src/index.ts", import.meta.url),
        );
        // Simulate Pi's `--tools exec,wait` projection: the host lists only the
        // allowlisted names even though this extension still registers the rest.
        const visibleNames = new Set([
          CODE_MODE_EXEC_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]);
        let foreignShellWinner = false;
        let foreignApplyPatchWinner = false;
        let active: string[] = [CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL];
        const pi = {
          registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
          registerCommand: () => undefined,
          on: (event: string, handler: ExtensionHandler<never, unknown>) => {
            handlers.set(event, handler);
          },
          getActiveTools: () => active,
          getAllTools: () => {
            const projected = [...tools.values()]
              .filter((tool) => visibleNames.has(tool.name))
              .map((tool) => ({
                ...tool,
                sourceInfo: {
                  path: sourcePath,
                  source: "test",
                  scope: "user" as const,
                  origin: "package" as const,
                },
              }));
            if (foreignShellWinner) {
              projected.push({
                name: EXEC_COMMAND_TOOL,
                sourceInfo: {
                  path: "/other/shell.ts",
                  source: "other",
                  scope: "user" as const,
                  origin: "package" as const,
                },
              } as (typeof projected)[number]);
            }
            if (foreignApplyPatchWinner) {
              projected.push({
                name: APPLY_PATCH_TOOL,
                sourceInfo: {
                  path: "/other/apply_patch.ts",
                  source: "other",
                  scope: "user" as const,
                  origin: "package" as const,
                },
              } as (typeof projected)[number]);
            }
            return projected;
          },
          setActiveTools: (names: string[]) => {
            active = names;
          },
        } as unknown as ExtensionAPI;
        const ctx = {
          cwd: agentDirectory,
          model: otherModel(),
          modelRegistry: registry(),
        } as unknown as ExtensionContext;

        resources.shutdown = () =>
          handlers.get("session_shutdown")?.(
            { type: "session_shutdown", reason: "quit" } as never,
            ctx,
          );
        piCodexToolkit(withEventBus(pi));
        await handlers.get("session_start")?.(
          { type: "session_start", reason: "startup" } as never,
          ctx,
        );
        // Absent names are CLI/role exclusions. Nested adapters require an
        // owned admitted registration, so they stay disabled here.
        expect(active).toEqual([CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL]);

        const exec = tools.get(CODE_MODE_EXEC_TOOL);
        if (!exec) throw new Error("exec was not registered");

        // An unadmitted adapter cannot even be declared, so no worker starts.
        const declare = (id: string, code: string, uses: string[]) =>
          exec.execute(id, { code, uses }, undefined, undefined, ctx);
        await expect(
          declare(
            "exec-filtered-1",
            'const r = await tools.exec_command({ command: "echo nested-ok" }); return r.stdout.trim();',
            [EXEC_COMMAND_TOOL],
          ),
        ).rejects.toMatchObject({
          code: "invalid-uses",
          message: expect.stringContaining("not currently available"),
        });
        await expect(
          declare(
            "exec-filtered-2",
            'const r = await tools.apply_patch({ patch: "*** Begin Patch\\n*** Add File: nested.txt\\n+nested content\\n*** End Patch" }); return r.operations.map((op) => op.path);',
            [APPLY_PATCH_TOOL],
          ),
        ).rejects.toMatchObject({
          code: "invalid-uses",
          message: expect.stringContaining("not currently available"),
        });

        // Omitting `uses` declares only the current admission snapshot, so a
        // filtered adapter still fails inside the cell without dispatching.
        const implicit = await exec.execute(
          "exec-filtered-implicit",
          {
            code: 'try { await tools.exec_command({ command: "echo must-not-run" }); return "dispatched"; } catch (error) { return error.message; }',
          },
          undefined,
          undefined,
          ctx,
        );
        expect(implicit.details).toMatchObject({ status: "completed" });
        expect(
          String((implicit.details as { result?: unknown }).result),
        ).toContain('was not declared in "uses" for this cell');

        // A visible third-party winner is still a conflict: rechecking disables
        // each adapter instead of dispatching through the foreign tool.
        foreignShellWinner = true;
        foreignApplyPatchWinner = true;
        await handlers.get("model_select")?.(
          { type: "model_select" } as never,
          ctx,
        );

        await expect(
          declare(
            "exec-filtered-3",
            'return await tools.exec_command({ command: "echo must-not-run" });',
            [EXEC_COMMAND_TOOL],
          ),
        ).rejects.toMatchObject({
          code: "invalid-uses",
          message: expect.stringContaining("not currently available"),
        });
        await expect(
          declare(
            "exec-filtered-4",
            'return await tools.apply_patch({ patch: "*** Begin Patch\\n*** End Patch\\n" });',
            [APPLY_PATCH_TOOL],
          ),
        ).rejects.toMatchObject({
          code: "invalid-uses",
          message: expect.stringContaining("not currently available"),
        });
      },
    );
  });

  async function nestedDiscoveryCase(probe?: ExecutionLifecycleProbe) {
    await withExecutionLifecycleResources(
      "pct-discovery-nested-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.shellSessions.enabled = true;
        config.codeMode.enabled = true;
        config.codeMode.approvalMode = "always";
        config.toolDiscovery.enabled = true;
        config.toolDiscovery.deferred = [EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL];
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );

        const handlers = new Map<string, ExtensionHandler<never, unknown>>();
        const tools = new Map<string, ToolDefinition>();
        const sourcePath = fileURLToPath(
          new URL("../src/index.ts", import.meta.url),
        );
        let active: string[] = ["read"];
        const setActiveTools = vi.fn((names: string[]) => {
          active = names;
        });
        const pi = {
          registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
          registerCommand: () => undefined,
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
          setActiveTools,
        } as unknown as ExtensionAPI;
        const ctx = {
          cwd: agentDirectory,
          model: otherModel(),
          modelRegistry: registry(),
        } as unknown as ExtensionContext;

        resources.shutdown = () =>
          handlers.get("session_shutdown")?.(
            { type: "session_shutdown", reason: "quit" } as never,
            ctx,
          );
        piCodexToolkit(withEventBus(pi));
        await handlers.get("session_start")?.(
          { type: "session_start", reason: "startup" } as never,
          ctx,
        );

        // Discovery hides only the deferred direct names; the Code Mode tools
        // and the discovery tool stay exposed.
        expect(active).toContain(CODE_MODE_EXEC_TOOL);
        expect(active).toContain(CODE_MODE_WAIT_TOOL);
        expect(active).toContain(TOOL_DISCOVERY_TOOL);
        expect(active).not.toContain(EXEC_COMMAND_TOOL);
        expect(active).not.toContain(WRITE_STDIN_TOOL);
        const syncCalls = setActiveTools.mock.calls.length;

        // The deferred names stay eligible (deferred, not disabled/conflicted).
        const findTools = tools.get(TOOL_DISCOVERY_TOOL);
        if (!findTools) throw new Error("find_tools was not registered");
        const search = await findTools.execute(
          "nested-discovery-0",
          { query: "stdin" },
          undefined,
          undefined,
          ctx,
        );
        expect(search.details).toMatchObject({
          matches: expect.arrayContaining([
            expect.objectContaining({
              name: WRITE_STDIN_TOOL,
              state: "eligible",
            }),
            expect.objectContaining({
              name: EXEC_COMMAND_TOOL,
              state: "eligible",
            }),
          ]),
        });

        const exec = tools.get(CODE_MODE_EXEC_TOOL);
        if (!exec) throw new Error("exec was not registered");

        // A cell composes exec_command and write_stdin through the nested
        // adapters, which dispatch through the shared shell executor and the
        // feature/ownership check rather than the deferred active list.
        const shellCommand = `printf 'ready\\n'; read line; printf 'got:%s\\n' "$line"`;
        const result = await exec.execute(
          "nested-discovery-1",
          {
            code: `
const first = await tools.exec_command({ command: ${JSON.stringify(shellCommand)}, yieldTimeMs: 2000 });
if (first.status !== "running") return first.stdout;
let current = await tools.write_stdin({ sessionId: first.sessionId, input: "hello\\n", yieldTimeMs: 2000 });
let output = first.stdout + current.stdout;
while (current.status === "running") {
  current = await tools.write_stdin({ sessionId: first.sessionId, yieldTimeMs: 2000 });
  output += current.stdout;
}
return output;
`,
            uses: [EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL],
          },
          undefined,
          undefined,
          ctx,
        );
        expect(result.details).toMatchObject({
          status: "completed",
          result: "ready\ngot:hello\n",
        });

        // Nested dispatch neither activates the deferred direct names nor
        // records a discovery load, so their deferred schemas stay a saving and
        // are not charged to the Code Mode exposure path.
        expect(active).not.toContain(EXEC_COMMAND_TOOL);
        expect(active).not.toContain(WRITE_STDIN_TOOL);
        expect(setActiveTools).toHaveBeenCalledTimes(syncCalls);
        resources.checkpoint("nested-output");
      },
      probe,
    );
  }

  it("dispatches nested shell adapters while discovery defers the direct names", () =>
    nestedDiscoveryCase());

  it.each(["assertion", "shutdown"])(
    "finalizes actual nested-discovery output on %s failure",
    async (failure) => {
      const previous = process.env.PI_CODING_AGENT_DIR;
      const primary = new Error("nested assertion failure");
      const shutdownError = new Error("nested shutdown failure");
      let owned!: ExecutionLifecycleResources;
      const error = await nestedDiscoveryCase((point, resources) => {
        owned = resources;
        if (point !== "nested-output") return;
        if (failure === "shutdown") {
          const original = resources.shutdown!;
          resources.shutdown = vi
            .fn()
            .mockRejectedValueOnce(shutdownError)
            .mockImplementation(original);
        }
        throw primary;
      }).catch((error: unknown) => error);
      if (failure === "assertion") expect(error).toBe(primary);
      else
        expect(error).toMatchObject({
          errors: [
            primary,
            expect.objectContaining({ errors: [shutdownError] }),
          ],
        });
      expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
      expect(owned.outputPaths.size).toBeGreaterThan(0);
      expect(
        [...owned.producers].every((producer) => producer.runningCount === 0),
      ).toBe(true);
      for (const path of [owned.root, ...owned.outputPaths])
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  async function shellConflictCase(probe?: ShellLifecycleProbe) {
    const body = async (resources: ShellLifecycleResources) => {
      const agentDirectory = resources.root;
      const config = defaultConfig();
      config.shellSessions.enabled = true;
      await mkdir(join(agentDirectory, "extensions"), { recursive: true });
      await writeFile(
        join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
        JSON.stringify(config),
        "utf8",
      );

      const handlers = new Map<string, ExtensionHandler<never, unknown>>();
      const tools = new Map<string, ToolDefinition>();
      const sourcePath = fileURLToPath(
        new URL("../src/index.ts", import.meta.url),
      );
      let active: string[] = ["read"];
      let conflictingShellName: string | undefined;
      const pi = {
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
        registerCommand: () => undefined,
        on: (event: string, handler: ExtensionHandler<never, unknown>) => {
          handlers.set(event, handler);
        },
        getActiveTools: () => active,
        getAllTools: () =>
          [...tools.values()].map((tool) => ({
            ...tool,
            sourceInfo: {
              path:
                tool.name === conflictingShellName
                  ? "/other/shell.ts"
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
      const ctx = {
        cwd: process.cwd(),
        model: otherModel(),
        modelRegistry: registry(),
      } as unknown as ExtensionContext;

      resources.shutdown = () =>
        handlers.get("session_shutdown")?.(
          { type: "session_shutdown", reason: "quit" } as never,
          ctx,
        );
      piCodexToolkit(withEventBus(pi));
      await handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" } as never,
        ctx,
      );
      resources.checkpoint("before-spawn");
      const exec = tools.get(EXEC_COMMAND_TOOL);
      const write = tools.get(WRITE_STDIN_TOOL);
      if (!exec || !write) throw new Error("shell tools were not registered");
      const started = await exec.execute(
        "conflict-1",
        { command: "echo $$; sleep 30", yieldTimeMs: 2000 },
        undefined,
        undefined,
        ctx,
      );
      const details = started.details as {
        sessionId: string;
        stdout: string;
      };
      const pid = Number(details.stdout.trim());
      resources.checkpoint("after-spawn");
      expect(isAlive(pid)).toBe(true);

      conflictingShellName = EXEC_COMMAND_TOOL;
      await handlers.get("model_select")?.(
        { type: "model_select" } as never,
        ctx,
      );
      expect(active).toEqual(["read", EXEC_COMMAND_TOOL]);
      expect(await waitUntil(() => !isAlive(pid))).toBe(true);
      await expect(
        write.execute(
          "conflicted-read",
          { sessionId: details.sessionId },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("not enabled");
      conflictingShellName = undefined;
      await handlers.get("model_select")?.(
        { type: "model_select" } as never,
        ctx,
      );
      await expect(
        write.execute(
          "conflict-2",
          { sessionId: details.sessionId, yieldTimeMs: 100 },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toMatchObject({ code: "stale-session" });
    };
    await withShellLifecycleResources("pct-shell-conflict-", body, probe);
  }

  it(
    "closes shell sessions when an owned name becomes conflicted",
    () => shellConflictCase(),
    120_000,
  );

  for (const [name, run] of [
    ["lifecycle", shellLifecycleCase],
    ["conflict", shellConflictCase],
  ] as const) {
    it.each([
      "setup",
      "before-spawn",
      "after-spawn",
      "after-spawn/shutdown-rejection",
      "after-spawn/shutdown-rejection/restore-failure",
    ] as const)(
      `${name} fixture cleans owned resources after %s failure`,
      async (failure) => {
        const previous = process.env.PI_CODING_AGENT_DIR;
        const originalStart = ShellSessionManager.prototype.start;
        const expectedEnvironment =
          failure === "before-spawn"
            ? "unchanged-shell-fixture-parent"
            : previous;
        const shutdownError = new Error("injected owned shutdown refusal");
        const restoreError = new Error("injected fixture restoration failure");
        const rejectsShutdown = failure.includes("shutdown-rejection");
        const rejectsRestore = failure.endsWith("restore-failure");
        let owned: ShellLifecycleResources | undefined;
        let primary: unknown;
        let actual: unknown;
        let finalized = false;
        const closeMethods = new Map<
          ShellSessionManager,
          ShellSessionManager["close"]
        >();
        try {
          if (expectedEnvironment === undefined)
            delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = expectedEnvironment;
          try {
            await run((point, resources) => {
              owned = resources;
              if (point === "finalized") {
                finalized = true;
                return;
              }
              if (point !== failure.split("/")[0]) return;
              if (point === "after-spawn") {
                expect(resources.pids.size).toBe(1);
                expect(resources.outputPaths.size).toBe(2);
                for (const pid of resources.pids)
                  expect(isAlive(pid)).toBe(true);
              }
              if (rejectsShutdown) {
                if (rejectsRestore) {
                  let failed = false;
                  resources.restoreBeforeRescue.push(() => {
                    if (failed) return;
                    failed = true;
                    throw restoreError;
                  });
                }
                for (const manager of resources.managers) {
                  closeMethods.set(manager, manager.close);
                  const close = vi
                    .spyOn(manager, "close")
                    .mockRejectedValue(shutdownError);
                  resources.restoreBeforeRescue.push(() => close.mockRestore());
                }
              }
              try {
                expect.fail(`injected body assertion at ${point}`);
              } catch (error) {
                primary = error;
                throw error;
              }
            });
          } catch (error) {
            actual = error;
          }
          expect(primary).toBeDefined();
          if (rejectsShutdown) {
            expect(actual).toBeInstanceOf(AggregateError);
            expect((actual as AggregateError).errors).toEqual([
              primary,
              expect.objectContaining({ cause: shutdownError }),
              ...(rejectsRestore ? [restoreError] : []),
            ]);
          } else {
            expect(actual).toBe(primary);
          }
          expect(finalized).toBe(true);
          expect(process.env.PI_CODING_AGENT_DIR).toBe(expectedEnvironment);
          expect(ShellSessionManager.prototype.start).toBe(originalStart);
          expect(owned).toBeDefined();
          expect(owned!.pids.size).toBe(
            failure.startsWith("after-spawn") ? 1 : 0,
          );
          for (const manager of owned!.managers) {
            expect(manager.runningCount).toBe(0);
            if (closeMethods.has(manager))
              expect(manager.close).toBe(closeMethods.get(manager));
          }
          for (const pid of owned!.pids) {
            expect(isAlive(pid)).toBe(false);
            if (process.platform !== "win32") expect(isAlive(-pid)).toBe(false);
          }
          for (const path of new Set([
            owned!.root,
            ...[...owned!.outputPaths].flatMap((path) => [path, dirname(path)]),
          ])) {
            await expect(readFile(path)).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
        } finally {
          // The fault check owns its injection/environment too, including when
          // a post-finalization evidence assertion itself fails.
          try {
            for (const restore of owned?.restoreBeforeRescue ?? []) restore();
          } finally {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previous;
          }
        }
      },
      120_000,
    );
  }

  it("retains the exact fixture root when shutdown remains unconfirmed", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const originalStart = ShellSessionManager.prototype.start;
    const shutdownError = new Error("unconfirmed fixture output shutdown");
    let owned: ShellLifecycleResources | undefined;
    try {
      await expect(
        withShellLifecycleResources(
          "pct-shell-lifecycle-",
          async (resources) => {
            owned = resources;
            resources.shutdown = () => {
              throw shutdownError;
            };
          },
        ),
      ).rejects.toMatchObject({
        errors: [
          shutdownError,
          shutdownError,
          expect.objectContaining({
            message: expect.stringContaining("retained owned root:"),
          }),
        ],
      });
      expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
      expect(ShellSessionManager.prototype.start).toBe(originalStart);
      expect(owned).toBeDefined();
      // This probe has no producer. Its outer supervisor alone may remove the
      // retained root after verifying that the helper did not claim settlement.
      expect(owned!.managers.size).toBe(0);
      await expect(readFile(owned!.root)).rejects.toMatchObject({
        code: "EISDIR",
      });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      if (owned) await rm(owned.root, { recursive: true, force: true });
    }
  });

  it("does not treat a timed-out shutdown as settled when its retry resolves", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const originalStart = ShellSessionManager.prototype.start;
    let owned: ShellLifecycleResources | undefined;
    let release!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let completion: Promise<unknown> | undefined;
    let heldShutdown: Promise<void> | undefined;
    try {
      completion = withShellLifecycleResources(
        "pct-shell-lifecycle-",
        async (resources) => {
          owned = resources;
          vi.useFakeTimers();
          resources.shutdown = vi
            .fn()
            .mockImplementationOnce(() => {
              heldShutdown = new Promise<void>((resolve) => {
                release = resolve;
              });
              return heldShutdown;
            })
            .mockResolvedValue(undefined);
          ready();
        },
      ).catch((error: unknown) => error);
      await started;
      await vi.advanceTimersByTimeAsync(20_000);
      const error = await completion;
      expect(error).toMatchObject({
        errors: [
          expect.objectContaining({
            message: "Shell fixture cleanup exceeded 20 seconds",
          }),
          expect.objectContaining({
            message: `Shell fixture cleanup unconfirmed; retained owned root: ${owned!.root}`,
          }),
        ],
      });
      expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
      expect(ShellSessionManager.prototype.start).toBe(originalStart);
      expect(owned!.managers.size).toBe(0);
      await expect(readFile(owned!.root)).rejects.toMatchObject({
        code: "EISDIR",
      });
    } finally {
      // Supervisor releases the deliberately held operation before deleting its
      // exact root. Fake time is used only for this no-process deadline probe.
      release?.();
      await heldShutdown;
      vi.useRealTimers();
      await completion;
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      if (owned) await rm(owned.root, { recursive: true, force: true });
    }
  });

  it("is inert during factory load and leaves disabled payloads untouched", async () => {
    const handlers = new Map<string, ExtensionHandler<never, unknown>>();
    const tools = new Map<string, ToolDefinition>();
    let command: RegisteredCommand["handler"] | undefined;
    const getActiveTools = vi.fn(() => []);
    const getAllTools = vi.fn(() => []);
    const setActiveTools = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const pi = {
      registerTool: (value: ToolDefinition) => {
        tools.set(value.name, value);
      },
      registerCommand: (
        _name: string,
        options: { handler: RegisteredCommand["handler"] },
      ) => {
        command = options.handler;
      },
      on: (event: string, handler: ExtensionHandler<never, unknown>) => {
        handlers.set(event, handler);
      },
      getActiveTools,
      getAllTools,
      setActiveTools,
    } as unknown as ExtensionAPI;

    piCodexToolkit(withEventBus(pi));

    expect([...tools.keys()]).toEqual([
      WEB_SEARCH_TOOL,
      IMAGE_GENERATION_TOOL,
      APPLY_PATCH_TOOL,
      EXEC_COMMAND_TOOL,
      WRITE_STDIN_TOOL,
      CODE_MODE_EXEC_TOOL,
      CODE_MODE_WAIT_TOOL,
      ...COMPUTER_USE_TOOLS,
      TOOL_DISCOVERY_TOOL,
    ]);
    expect(tools.get(IMAGE_GENERATION_TOOL)?.parameters).toMatchObject({
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1 },
        size: { type: "string", minLength: 1 },
      },
    });
    expect(command).toBeTypeOf("function");
    expect([...handlers.keys()]).toEqual([
      "session_start",
      "model_select",
      "session_tree",
      "session_before_switch",
      "session_before_fork",
      "session_shutdown",
      "session_before_compact",
      "before_provider_request",
    ]);
    expect(getActiveTools).not.toHaveBeenCalled();
    expect(getAllTools).not.toHaveBeenCalled();
    expect(setActiveTools).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const payload = { tools: [], unknown: { unchanged: true } };
    const beforeRequest = handlers.get("before_provider_request");
    const result = await beforeRequest?.(
      { type: "before_provider_request", payload } as never,
      {
        model: otherModel(),
        modelRegistry: registry(),
      } as unknown as ExtensionContext,
    );
    expect(result).toBeUndefined();
    expect(payload).toEqual({ tools: [], unknown: { unchanged: true } });
    expect(fetchSpy).not.toHaveBeenCalled();

    if (!command) throw new Error("pct command was not registered");
    const notify = vi.fn();
    await command("status", {
      hasUI: true,
      ui: { notify },
      model: otherModel(),
      modelRegistry: registry(),
      scopedModels: [],
    } as unknown as ExtensionCommandContext);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Pi Codex Toolkit"),
      "info",
    );
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  describe("an unreadable config at session start", () => {
    const invalidConfig =
      '{"webSearch":{"enabled":true},"applyPatch":{"enabled":"yes"}}\n';
    const detailLine =
      "Config error: invalid-config (applyPatch.enabled must be true or false)";

    function spyOnStderr() {
      return {
        write: vi.spyOn(process.stderr, "write").mockImplementation(() => true),
        consoleError: vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined),
        consoleWarn: vi
          .spyOn(console, "warn")
          .mockImplementation(() => undefined),
      };
    }

    async function startWithInvalidConfig(
      hasUI: boolean,
      body: (input: {
        configPath: string;
        notify: ReturnType<typeof vi.fn>;
        stderr: ReturnType<typeof spyOnStderr>;
        ctx: ExtensionCommandContext;
        start: () => Promise<void>;
        command: RegisteredCommand["handler"];
      }) => Promise<void>,
    ): Promise<void> {
      const agentDirectory = await mkdtemp(join(tmpdir(), "pct-config-read-"));
      const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDirectory;
      try {
        const configPath = join(
          agentDirectory,
          "extensions",
          "pi-codex-toolkit.json",
        );
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, invalidConfig, "utf8");
        // Spy before registration: `/pct` binds its default stderr sink then.
        const stderr = spyOnStderr();
        const handlers = new Map<string, ExtensionHandler<never, unknown>>();
        let command: RegisteredCommand["handler"] | undefined;
        const pi = {
          registerTool: () => undefined,
          registerCommand: (
            _name: string,
            options: { handler: RegisteredCommand["handler"] },
          ) => {
            command = options.handler;
          },
          on: (event: string, handler: ExtensionHandler<never, unknown>) => {
            handlers.set(event, handler);
          },
          getActiveTools: () => [],
          getAllTools: () => [],
          setActiveTools: vi.fn(),
        } as unknown as ExtensionAPI;
        piCodexToolkit(withEventBus(pi));
        const sessionStart = handlers.get("session_start");
        if (!sessionStart || !command) {
          throw new Error("session_start or /pct was not registered");
        }
        const notify = vi.fn();
        const ctx = {
          hasUI,
          ui: { notify },
          model: otherModel(),
          modelRegistry: registry(),
          scopedModels: [],
        } as unknown as ExtensionCommandContext;
        await body({
          configPath,
          notify,
          stderr,
          ctx,
          start: async () => {
            await sessionStart(
              { type: "session_start", reason: "startup" } as never,
              ctx,
            );
          },
          command,
        });
        await expect(readFile(configPath, "utf8")).resolves.toBe(invalidConfig);
      } finally {
        if (previousAgentDirectory === undefined) {
          delete process.env.PI_CODING_AGENT_DIR;
        } else {
          process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
        }
        await rm(agentDirectory, { recursive: true, force: true });
      }
    }

    it("warns once with the detail when a UI exists, and status shows it", () =>
      startWithInvalidConfig(
        true,
        async ({ configPath, notify, stderr, ctx, start, command }) => {
          await start();

          expect(notify.mock.calls).toEqual([
            [
              "Pi Codex Toolkit config error: invalid-config (applyPatch.enabled must be true or false); using all-off defaults.",
              "warning",
            ],
          ]);

          await command("status", ctx);

          expect(notify).toHaveBeenCalledTimes(2);
          expect(notify.mock.calls[1]?.[1]).toBe("info");
          expect(
            String(notify.mock.calls[1]?.[0]).split("\n").slice(0, 6),
          ).toEqual([
            "Pi Codex Toolkit",
            `Config: ${configPath}`,
            "Current model: anthropic/claude",
            "Current API: anthropic-messages",
            detailLine,
            "Web Search:",
          ]);
          expect(stderr.write).not.toHaveBeenCalled();
          expect(stderr.consoleError).not.toHaveBeenCalled();
          expect(stderr.consoleWarn).not.toHaveBeenCalled();
        },
      ));

    it("writes nothing at session start without a UI, stderr included", () =>
      startWithInvalidConfig(
        false,
        async ({ notify, stderr, ctx, start, command }) => {
          await start();

          expect(notify).not.toHaveBeenCalled();
          expect(stderr.write).not.toHaveBeenCalled();
          expect(stderr.consoleError).not.toHaveBeenCalled();
          expect(stderr.consoleWarn).not.toHaveBeenCalled();

          // The load did see the invalid file: status, when asked, reports it.
          await command("status", ctx);

          expect(notify).not.toHaveBeenCalled();
          expect(stderr.consoleError).toHaveBeenCalledTimes(1);
          expect(
            String(stderr.consoleError.mock.calls[0]?.[0])
              .split("\n")
              .slice(4, 6),
          ).toEqual([detailLine, "Web Search:"]);
        },
      ));
  });

  it("revalidates refreshed auth before Native payload injection", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "pct-native-route-"));
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;

    try {
      const config = defaultConfig();
      config.webSearch.enabled = true;
      config.webSearch.backend = "native";
      await mkdir(join(agentDirectory, "extensions"), { recursive: true });
      await writeFile(
        join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
        JSON.stringify(config),
        "utf8",
      );

      const handlers = new Map<string, ExtensionHandler<never, unknown>>();
      const sourcePath = fileURLToPath(
        new URL("../src/index.ts", import.meta.url),
      );
      const pi = {
        registerTool: () => undefined,
        registerCommand: () => undefined,
        on: (event: string, handler: ExtensionHandler<never, unknown>) => {
          handlers.set(event, handler);
        },
        getActiveTools: () => [],
        getAllTools: () => [
          {
            name: WEB_SEARCH_TOOL,
            sourceInfo: {
              path: sourcePath,
              source: "test",
              scope: "user" as const,
              origin: "package" as const,
            },
          },
        ],
        setActiveTools: vi.fn(),
      } as unknown as ExtensionAPI;
      const current = model();
      const getApiKeyAndHeaders = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true as const,
          apiKey: "test-key",
          baseUrl: "https://gateway.example/v1",
        })
        .mockResolvedValueOnce({
          ok: true as const,
          apiKey: "test-key",
        });
      const ctx = {
        model: current,
        modelRegistry: {
          find: () => current,
          getAvailable: () => [current],
          isUsingOAuth: () => false,
          getApiKeyAndHeaders,
        },
      } as unknown as ExtensionContext;

      piCodexToolkit(withEventBus(pi));
      await handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" } as never,
        ctx,
      );

      const payload = { tools: [], unknown: { unchanged: true } };
      const result = await handlers.get("before_provider_request")?.(
        { type: "before_provider_request", payload } as never,
        ctx,
      );

      expect(result).toBeUndefined();
      expect(payload).toEqual({ tools: [], unknown: { unchanged: true } });

      const officialResult = await handlers.get("before_provider_request")?.(
        { type: "before_provider_request", payload } as never,
        ctx,
      );
      expect(officialResult).toMatchObject({
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        unknown: { unchanged: true },
      });
      expect(getApiKeyAndHeaders).toHaveBeenCalledTimes(2);
    } finally {
      if (previousAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
      }
      await rm(agentDirectory, { recursive: true, force: true });
    }
  });
});

describe("execution-rule transitions", () => {
  const NATIVE_NAMES = ["read", "bash", "edit", "write"] as const;

  /**
   * The process-global native-suppression records for one session lineage,
   * one per factory identity that kept provenance for it. The store is
   * deliberately keyed by identity first so a factory that owns nothing
   * cannot replace another one's history.
   */
  function nativeProvenance(
    sessionFile: string,
  ): { identity: string; baseline: string[]; suppressed: string[] }[] {
    const stash = (globalThis as Record<symbol, unknown>)[
      Symbol.for("pi-codex-toolkit.native-suppression")
    ];
    // The store is created by the first factory in this process that resolves
    // an identity, so its absence is the same statement as no records for
    // this lineage. Any other value would be someone else's key collision.
    if (stash === undefined) return [];
    if (!(stash instanceof Map)) throw new Error("missing suppression stash");
    return [
      ...(
        stash as Map<
          string,
          Map<string, { baseline: Set<string>; suppressed: Set<string> }>
        >
      ).entries(),
    ].flatMap(([identity, lineages]) => {
      const entry = lineages.get(sessionFile);
      return entry
        ? [
            {
              identity,
              baseline: [...entry.baseline],
              suppressed: [...entry.suppressed],
            },
          ]
        : [];
    });
  }

  function fakeHost(
    resources: ExecutionLifecycleResources,
    options: {
      initialActive?: string[];
      /** List the builtin natives in getAllTools() as the real host does. */
      builtinNatives?: boolean;
      /** Registered names absent from the visible projection (CLI-filtered). */
      absentTools?: readonly string[];
      /** Registered names another extension visibly wins. */
      foreignTools?: readonly string[];
      /** Extension path this host attributes to its own registrations. */
      sourcePath?: string;
      /**
       * Project every registration as another factory's winner — a foreign
       * path *and* a schema object this factory never handed to
       * `registerTool`, which is what Pi shows when a second factory
       * registered the same names first. Detection can then prove nothing,
       * so this binding's identity stays unresolved. A predicate is read on
       * every projection, so a lane can publish this factory's registrations
       * partway through one session.
       */
      unresolvedIdentity?: boolean | (() => boolean);
      /** Session identity for the suppression stash. */
      sessionFile?: string;
      startReason?: "startup" | "reload" | "new" | "resume" | "fork";
      previousSessionFile?: string;
      /** Present a UI so /pct status notifies instead of writing stderr. */
      hasUI?: boolean;
      /**
       * Fires after a `getAllTools()` snapshot is built and before it is
       * returned, so a test can interleave another host event at a precise
       * point of one sync without changing what that read observed.
       */
      onToolsRead?: () => void;
      /**
       * Fires when a committed projection writes the active list, before the
       * sync records its suppression, so a lane can observe what the process
       * already knew at that exact point.
       */
      onActiveTools?: (names: readonly string[]) => void;
    } = {},
  ) {
    const agentDirectory = resources.root;
    const handlers = new Map<string, ExtensionHandler<never, unknown>>();
    const tools = new Map<string, ToolDefinition>();
    const bus = recordingEventBus();
    const sourcePath =
      options.sourcePath ??
      fileURLToPath(new URL("../src/index.ts", import.meta.url));
    let command: RegisteredCommand["handler"] | undefined;
    const notify = vi.fn();
    let active: string[] = options.initialActive ?? [...NATIVE_NAMES];
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerCommand: (
        _name: string,
        commandOptions: { handler: RegisteredCommand["handler"] },
      ) => {
        command = commandOptions.handler;
      },
      on: (event: string, handler: ExtensionHandler<never, unknown>) => {
        handlers.set(event, handler);
      },
      getActiveTools: () => active,
      getAllTools: () => {
        const unresolved =
          typeof options.unresolvedIdentity === "function"
            ? options.unresolvedIdentity()
            : options.unresolvedIdentity === true;
        const projected = [
          ...[...tools.values()]
            .filter((tool) => !(options.absentTools ?? []).includes(tool.name))
            .map((tool) => ({
              ...tool,
              ...(unresolved
                ? { parameters: { ...(tool.parameters as object) } }
                : {}),
              sourceInfo: {
                path: unresolved
                  ? "/other-factory.ts"
                  : (options.foreignTools ?? []).includes(tool.name)
                    ? "/foreign-extension.ts"
                    : sourcePath,
                source: "test",
                scope: "user" as const,
                origin: "package" as const,
              },
            })),
          ...(options.builtinNatives
            ? NATIVE_NAMES.map((name) => ({
                name,
                sourceInfo: {
                  path: `<builtin:${name}>`,
                  source: "builtin",
                  scope: "temporary" as const,
                  origin: "top-level" as const,
                },
              }))
            : []),
        ];
        options.onToolsRead?.();
        return projected;
      },
      setActiveTools: (names: string[]) => {
        active = names;
        options.onActiveTools?.(names);
      },
    } as unknown as ExtensionAPI;
    const current = model({ id: "initial", provider: "test" });
    const ctx = {
      cwd: agentDirectory,
      model: current,
      modelRegistry: registry(),
      hasUI: options.hasUI ?? false,
      ui: { notify },
      ...(options.sessionFile !== undefined
        ? {
            sessionManager: {
              getSessionFile: () => options.sessionFile,
              getSessionId: () => options.sessionFile,
            },
          }
        : {}),
    } as unknown as ExtensionContext & ExtensionCommandContext;
    resources.shutdown = () =>
      handlers.get("session_shutdown")?.(
        { type: "session_shutdown", reason: "quit" } as never,
        ctx,
      );
    piCodexToolkit(withEventBus(pi, bus));
    if (!command) throw new Error("pct command was not registered");
    const pct = command;
    return {
      handlers,
      tools,
      ctx,
      command: pct,
      notify,
      active: () => active,
      /** Owned execution-diagnostics records this factory published. */
      records: (): ExecutionDiagnosticsRecord[] =>
        bus.records
          .filter((entry) => entry.channel === EXECUTION_DIAGNOSTICS_EVENT)
          .map((entry) => entry.data as ExecutionDiagnosticsRecord),
      /** Host-side activation, e.g. Pi's transcript replay on tree nav. */
      setActiveTools: (names: string[]) => {
        active = names;
      },
      /** `/pct status` text delivered through the notify sink. */
      status: async (): Promise<string> => {
        const before = notify.mock.calls.length;
        await pct("status", ctx);
        const calls = notify.mock.calls.slice(before);
        if (calls.length !== 1 || calls[0]?.[1] !== "info") {
          throw new Error("status did not notify once with info");
        }
        return String(calls[0]?.[0]);
      },
      start: () =>
        handlers.get("session_start")?.(
          {
            type: "session_start",
            reason: options.startReason ?? "startup",
            previousSessionFile: options.previousSessionFile,
          } as never,
          ctx,
        ),
      select: (id: string) => {
        current.id = id;
        return handlers.get("model_select")?.(
          { type: "model_select" } as never,
          ctx,
        );
      },
    };
  }

  /** The indented record lines of one status section. */
  function statusSection(text: string, header: string): string[] {
    const lines = text.split("\n");
    const start = lines.indexOf(header);
    if (start < 0) throw new Error(`status section ${header} is missing`);
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("  ")) break;
      body.push(line);
    }
    return body;
  }

  it("fences a cell's adapter ceiling at creation across a Patch expansion", async () => {
    await withExecutionLifecycleResources(
      "pct-cell-ceiling-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "initial",
              match: "initial",
              patch: false,
              shell: false,
              code: true,
            },
            {
              id: "expanded",
              match: "expanded",
              patch: true,
              shell: false,
              code: true,
            },
          ],
        };
        config.codeMode.approvalMode = "always";
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const host = fakeHost(resources, { builtinNatives: true });
        await host.start();
        expect(host.active()).toEqual([
          "read",
          "edit",
          "write",
          CODE_MODE_EXEC_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]);
        const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
        const wait = host.tools.get(CODE_MODE_WAIT_TOOL);
        if (!exec || !wait) throw new Error("Code Mode tools not registered");

        // Deterministic dispatch barrier: the nested Shell call blocks until
        // the model transition commits, without spawning a real process.
        let entered!: () => void;
        let release!: () => void;
        const enteredPromise = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const realStart = ShellSessionManager.prototype.start;
        ShellSessionManager.prototype.start = (async () => {
          entered();
          await released;
          return {
            sessionId: "ceiling-barrier",
            status: "completed",
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            truncated: false,
            dropped: false,
          };
        }) as never;
        resources.restoreBeforeCleanup.push(() => {
          ShellSessionManager.prototype.start = realStart;
        });
        try {
          const patch =
            "*** Begin Patch\n*** Add File: expanded.txt\n+expanded\n*** End Patch";
          const started = await exec.execute(
            "ceiling-1",
            {
              code: [
                'await tools.exec_command({ command: "held" });',
                `return await tools.apply_patch(${JSON.stringify({ patch })});`,
              ].join("\n"),
              // Omitted: the declared set is the admission snapshot taken at
              // creation, which is this cell's ceiling as well.
              yieldTimeMs: 0,
            },
            undefined,
            undefined,
            host.ctx,
          );
          expect(started.details).toMatchObject({ status: "running" });
          await enteredPromise;

          // Expand to P+C while the cell is parked inside Shell: Code stays
          // enabled, so the manager and cell survive the transition.
          await host.select("expanded");
          release();
          const finished = await wait.execute(
            "ceiling-2",
            {
              cellId: (started.details as { cellId: string }).cellId,
              yieldTimeMs: 10_000,
            },
            undefined,
            undefined,
            host.ctx,
          );
          expect(finished.details).toMatchObject({ status: "failed" });
          // The expansion admitted Patch for new cells only; this one keeps
          // the snapshot it started with and never reaches the adapter.
          expect((finished.details as { error?: string }).error).toContain(
            'Tool "apply_patch" was not declared in "uses" for this cell',
          );
          expect((finished.details as { error?: string }).error).toContain(
            "Declared tools: exec_command, write_stdin",
          );
          await expect(
            readFile(join(agentDirectory, "expanded.txt"), "utf8"),
          ).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          release();
          ShellSessionManager.prototype.start = realStart;
        }
      },
    );
  });

  it("keeps retained-cell controls reachable when contraction cleanup fails", async () => {
    await withExecutionLifecycleResources(
      "pct-contraction-controls-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "code-only",
              match: "initial",
              patch: false,
              shell: false,
              code: true,
            },
          ],
        };
        config.codeMode.approvalMode = "always";
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const host = fakeHost(resources, { builtinNatives: true });
        await host.start();
        expect(host.active()).toEqual([
          "read",
          "edit",
          "write",
          CODE_MODE_EXEC_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]);
        const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
        const wait = host.tools.get(CODE_MODE_WAIT_TOOL);
        if (!exec || !wait) throw new Error("Code Mode tools not registered");

        const started = await exec.execute(
          "contraction-1",
          { code: "await new Promise(() => {});", yieldTimeMs: 0 },
          undefined,
          undefined,
          host.ctx,
        );
        const cellId = (started.details as { cellId: string }).cellId;
        expect(started.details).toMatchObject({ status: "running" });

        // Fail inside the real close: admission is fenced by the method's own
        // prologue while the per-cell termination step rejects.
        const proto = CodeModeCellManager.prototype as unknown as {
          terminateCell(cell: never, reason: string): Promise<void>;
        };
        const realTerminateCell = proto.terminateCell;
        proto.terminateCell = (() =>
          Promise.reject(
            new Error("injected cleanup-incomplete"),
          )) as typeof proto.terminateCell;
        resources.restoreBeforeCleanup.push(() => {
          proto.terminateCell = realTerminateCell;
        });
        try {
          await expect(host.select("off")).rejects.toThrow(
            "injected cleanup-incomplete",
          );
          proto.terminateCell = realTerminateCell;

          // The failed apply never committed: the old projection stays, so the
          // retained cell's wait/terminate controls remain reachable.
          expect(host.active()).toContain(CODE_MODE_EXEC_TOOL);
          expect(host.active()).toContain(CODE_MODE_WAIT_TOOL);
          const stopped = await wait.execute(
            "contraction-2",
            { cellId, terminate: true, yieldTimeMs: 10_000 },
            undefined,
            undefined,
            host.ctx,
          );
          expect(stopped.details).toMatchObject({ status: "terminated" });

          // New admission is fenced: the pending all-false plan's start
          // fence denies exec before the manager's own close prologue.
          await expect(
            exec.execute(
              "contraction-3",
              { code: "return 1;", yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            ),
          ).rejects.toThrow("Code Mode is not enabled.");

          // A later sync retries cleanup and then commits the native route.
          await host.select("off");
          expect(host.active()).not.toContain(CODE_MODE_EXEC_TOOL);
          expect(host.active()).not.toContain(CODE_MODE_WAIT_TOOL);
          await expect(
            wait.execute(
              "contraction-4",
              { cellId, yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            ),
          ).rejects.toThrow("Code Mode is not enabled.");
        } finally {
          proto.terminateCell = realTerminateCell;
        }
      },
    );
  });

  it("fences new Shell starts when a contraction's Code cleanup fails", async () => {
    await withExecutionLifecycleResources(
      "pct-contraction-fence-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "sc",
              match: "initial",
              patch: false,
              shell: true,
              code: true,
            },
          ],
        };
        config.codeMode.approvalMode = "always";
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const host = fakeHost(resources, { builtinNatives: true });
        await host.start();
        expect(host.active()).toEqual([
          "read",
          "edit",
          "write",
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
          CODE_MODE_EXEC_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]);
        const execCommand = host.tools.get(EXEC_COMMAND_TOOL);
        const writeStdin = host.tools.get(WRITE_STDIN_TOOL);
        const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
        const wait = host.tools.get(CODE_MODE_WAIT_TOOL);
        if (!execCommand || !writeStdin || !exec || !wait) {
          throw new Error("shell or Code Mode tools were not registered");
        }

        const started = await exec.execute(
          "fence-1",
          { code: "await new Promise(() => {});", yieldTimeMs: 0 },
          undefined,
          undefined,
          host.ctx,
        );
        const cellId = (started.details as { cellId: string }).cellId;

        // Code cleanup fails while the sibling Shell close succeeds — the
        // manager is reusable after close(), so without the per-plan start
        // fence the retained old projection would still admit new work.
        const proto = CodeModeCellManager.prototype as unknown as {
          terminateCell(cell: never, reason: string): Promise<void>;
        };
        const realTerminateCell = proto.terminateCell;
        proto.terminateCell = (() =>
          Promise.reject(
            new Error("injected cleanup-incomplete"),
          )) as typeof proto.terminateCell;
        resources.restoreBeforeCleanup.push(() => {
          proto.terminateCell = realTerminateCell;
        });
        try {
          await expect(host.select("off")).rejects.toThrow(
            "injected cleanup-incomplete",
          );
          proto.terminateCell = realTerminateCell;

          // The committed projection stays S+C, but the pending all-false
          // plan's fence already denies the newly disallowed starts.
          await expect(
            execCommand.execute(
              "fence-2",
              { command: "printf unexpected", yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            ),
          ).rejects.toThrow("Shell Sessions are not enabled.");
          await expect(
            exec.execute(
              "fence-3",
              { code: "return 1;", yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            ),
          ).rejects.toThrow("Code Mode is not enabled.");

          // Continuation controls stay reachable: write_stdin passes its
          // committed-projection gate and reports the (now closed) session's
          // real state instead of a fence error; wait still owns the cell.
          await expect(
            writeStdin.execute(
              "fence-4",
              { sessionId: "shell-gone", yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            ),
          ).rejects.toMatchObject({ code: "stale-session" });
          const stopped = await wait.execute(
            "fence-5",
            { cellId, terminate: true, yieldTimeMs: 10_000 },
            undefined,
            undefined,
            host.ctx,
          );
          expect(stopped.details).toMatchObject({ status: "terminated" });
        } finally {
          proto.terminateCell = realTerminateCell;
        }
      },
    );
  });

  it("keeps Shell starts and continuation when only Code cleanup fails", async () => {
    await withExecutionLifecycleResources(
      "pct-partial-fence-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "sc",
              match: "initial",
              patch: false,
              shell: true,
              code: true,
            },
            {
              id: "s",
              match: "shellonly",
              patch: false,
              shell: true,
              code: false,
            },
          ],
        };
        config.codeMode.approvalMode = "always";
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const host = fakeHost(resources, { builtinNatives: true });
        await host.start();
        const execCommand = host.tools.get(EXEC_COMMAND_TOOL);
        const writeStdin = host.tools.get(WRITE_STDIN_TOOL);
        const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
        const wait = host.tools.get(CODE_MODE_WAIT_TOOL);
        if (!execCommand || !writeStdin || !exec || !wait) {
          throw new Error("shell or Code Mode tools were not registered");
        }

        const shell = await execCommand.execute(
          "partial-1",
          { command: "sleep 30", yieldTimeMs: 0 },
          undefined,
          undefined,
          host.ctx,
        );
        const shellId = (shell.details as { sessionId: string }).sessionId;
        const started = await exec.execute(
          "partial-2",
          { code: "await new Promise(() => {});", yieldTimeMs: 0 },
          undefined,
          undefined,
          host.ctx,
        );
        const cellId = (started.details as { cellId: string }).cellId;

        const proto = CodeModeCellManager.prototype as unknown as {
          terminateCell(cell: never, reason: string): Promise<void>;
        };
        const realTerminateCell = proto.terminateCell;
        proto.terminateCell = (() =>
          Promise.reject(
            new Error("injected cleanup-incomplete"),
          )) as typeof proto.terminateCell;
        resources.restoreBeforeCleanup.push(() => {
          proto.terminateCell = realTerminateCell;
        });
        try {
          // S+C → S drops only Code; the Shell route is not contracted, so a
          // failed cell cleanup must fence new cells without touching shell
          // starts or the live session's stdin control.
          await expect(host.select("shellonly")).rejects.toThrow(
            "injected cleanup-incomplete",
          );
          proto.terminateCell = realTerminateCell;

          const again = await execCommand.execute(
            "partial-3",
            { command: "printf ok", yieldTimeMs: 2000 },
            undefined,
            undefined,
            host.ctx,
          );
          expect(again.details).toMatchObject({ status: "completed" });
          const polled = await writeStdin.execute(
            "partial-4",
            { sessionId: shellId, yieldTimeMs: 100 },
            undefined,
            undefined,
            host.ctx,
          );
          expect(polled.details).toMatchObject({ status: "running" });
          await expect(
            exec.execute(
              "partial-5",
              { code: "return 1;", yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            ),
          ).rejects.toThrow("Code Mode is not enabled.");
          const stopped = await wait.execute(
            "partial-6",
            { cellId, terminate: true, yieldTimeMs: 10_000 },
            undefined,
            undefined,
            host.ctx,
          );
          expect(stopped.details).toMatchObject({ status: "terminated" });
        } finally {
          proto.terminateCell = realTerminateCell;
        }
        // Let the retained session die cleanly during fixture shutdown.
        await writeStdin.execute(
          "partial-7",
          { sessionId: shellId, terminate: true, yieldTimeMs: 10_000 },
          undefined,
          undefined,
          host.ctx,
        );
      },
    );
  });

  it("commits transitions in event order so the newest selection wins", async () => {
    await withExecutionLifecycleResources(
      "pct-ordered-sync-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "code-only",
              match: "initial",
              patch: false,
              shell: false,
              code: true,
            },
            { id: "p", match: "patch", patch: true, shell: false, code: false },
          ],
        };
        config.codeMode.approvalMode = "always";
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const host = fakeHost(resources, {
          builtinNatives: true,
          hasUI: true,
        });
        await host.start();
        expect(host.active()).toEqual([
          "read",
          "edit",
          "write",
          CODE_MODE_EXEC_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]);
        const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
        if (!exec) throw new Error("Code Mode tools were not registered");
        const started = await exec.execute(
          "ordered-1",
          { code: "await new Promise(() => {});", yieldTimeMs: 0 },
          undefined,
          undefined,
          host.ctx,
        );
        expect(started.details).toMatchObject({ status: "running" });

        // Hold the older transition inside real cell cleanup, then await the
        // newer selection before releasing. Pi's setModel does not serialize
        // hooks; the newer commit must finish without waiting for the older
        // cleanup, and the older plan must not overwrite it afterwards.
        const proto = CodeModeCellManager.prototype as unknown as {
          terminateCell(cell: never, reason: string): Promise<void>;
        };
        const realTerminateCell = proto.terminateCell;
        let hold = true;
        let entered!: () => void;
        let release!: () => void;
        const enteredPromise = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const releasePromise = new Promise<void>((resolve) => {
          release = resolve;
        });
        proto.terminateCell = async function (this: never, ...args: unknown[]) {
          if (hold) {
            hold = false;
            entered();
            await releasePromise;
          }
          return realTerminateCell.apply(this, args as [never, string]);
        } as typeof proto.terminateCell;
        resources.restoreBeforeCleanup.push(() => {
          proto.terminateCell = realTerminateCell;
        });
        try {
          const older = host.select("patch");
          await enteredPromise;
          await host.select("initial");
          expect(host.active()).toEqual([
            "read",
            "edit",
            "write",
            CODE_MODE_EXEC_TOOL,
            CODE_MODE_WAIT_TOOL,
          ]);
          release();
          await older;

          // The newest selection remains the committed projection: the older
          // Patch plan never replaced it, bash stays hidden, edit/write were
          // never suppressed.
          expect(host.active()).toEqual([
            "read",
            "edit",
            "write",
            CODE_MODE_EXEC_TOOL,
            CODE_MODE_WAIT_TOOL,
          ]);
          const text = await host.status();
          expect(statusSection(text, "Execution rules:")).toEqual([
            "  schema: rules",
            "  rule: code-only",
            "  requested: C",
            "  effective: code",
            "  hide bash: yes",
            "  hide edit/write: no",
            "  notes: ",
          ]);
        } finally {
          proto.terminateCell = realTerminateCell;
        }
      },
    );
  });

  it("runs the cleanup a re-planned contraction requires before committing it", async () => {
    await withExecutionLifecycleResources(
      "pct-replan-cleanup-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "code-only",
              match: "initial",
              patch: false,
              shell: false,
              code: true,
            },
          ],
        };
        config.codeMode.approvalMode = "always";
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        // Mutable: an earlier extension wins `exec_command` mid-sync, which
        // withdraws Code's required Shell pair.
        const foreignTools: string[] = [];
        const host = fakeHost(resources, {
          builtinNatives: true,
          foreignTools,
        });
        await host.start();
        expect(host.active()).toEqual([
          "read",
          "edit",
          "write",
          CODE_MODE_EXEC_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]);
        const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
        const wait = host.tools.get(CODE_MODE_WAIT_TOOL);
        if (!exec || !wait) throw new Error("Code Mode tools not registered");
        const started = await exec.execute(
          "replan-cleanup-1",
          { code: "await new Promise(() => {});", yieldTimeMs: 0 },
          undefined,
          undefined,
          host.ctx,
        );
        expect(started.details).toMatchObject({ status: "running" });
        const cellId = (started.details as { cellId: string }).cellId;

        const proto = CodeModeCellManager.prototype as unknown as {
          close(): Promise<void>;
        };
        const realClose = proto.close;
        let closeCalls = 0;
        proto.close = function (this: never, ...args: unknown[]) {
          closeCalls += 1;
          return realClose.apply(this, args as []);
        } as typeof proto.close;
        resources.restoreBeforeCleanup.push(() => {
          proto.close = realClose;
        });
        try {
          // An unchanged selection plans Code on, so it schedules no Code
          // cleanup. The foreign winner appears while that sync is awaiting,
          // and the fresh plan withdraws `exec`/`wait`.
          const unchanged = host.select("initial");
          foreignTools.push(EXEC_COMMAND_TOOL);
          await unchanged;

          // The contraction the fresh plan committed carries its cleanup:
          // the manager was closed, so no cell keeps running behind a
          // projection that no longer exposes any control for it.
          expect(closeCalls).toBe(1);
          expect(host.active()).not.toContain(CODE_MODE_EXEC_TOOL);
          expect(host.active()).not.toContain(CODE_MODE_WAIT_TOOL);
          expect(host.active()).toContain("bash");
          expect(host.records().at(-1)).toMatchObject({
            effective: { code: false, directShell: false },
            notes: ["code-shell-pair-unavailable"],
            cleanupPending: false,
          });
          await expect(
            wait.execute(
              "replan-cleanup-2",
              { cellId, yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            ),
          ).rejects.toThrow("Code Mode is not enabled.");

          // The foreign winner goes away and Code returns on a fresh manager;
          // the cell the contraction cleaned up is gone, not still running.
          foreignTools.length = 0;
          await host.select("initial");
          expect(host.active()).toContain(CODE_MODE_EXEC_TOOL);
          await expect(
            wait.execute(
              "replan-cleanup-3",
              { cellId, yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            ),
          ).rejects.toMatchObject({ code: "stale-cell" });
        } finally {
          proto.close = realClose;
        }
      },
    );
  });

  it("commits an unchanged re-plan after a single cleanup pass", async () => {
    await withExecutionLifecycleResources(
      "pct-replan-single-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "shell",
              match: "initial",
              patch: false,
              shell: true,
              code: false,
            },
            {
              id: "off",
              match: "off",
              patch: false,
              shell: false,
              code: false,
            },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const host = fakeHost(resources, { builtinNatives: true });
        await host.start();
        expect(host.active()).toContain(EXEC_COMMAND_TOOL);

        const proto = ShellSessionManager.prototype as unknown as {
          close(): Promise<void>;
        };
        const realClose = proto.close;
        let closeCalls = 0;
        proto.close = function (this: never, ...args: unknown[]) {
          closeCalls += 1;
          return realClose.apply(this, args as []);
        } as typeof proto.close;
        resources.restoreBeforeCleanup.push(() => {
          proto.close = realClose;
        });
        try {
          // Nothing changes under the sync, so the fresh plan keeps the same
          // routes and commits without repeating the cleanup it already ran.
          await host.select("off");
          expect(closeCalls).toBe(1);
          expect(host.active()).not.toContain(EXEC_COMMAND_TOOL);
          expect(host.active()).toContain("bash");
        } finally {
          proto.close = realClose;
        }
      },
    );
  });

  it("stops re-planning after its bounded passes when the host keeps changing", async () => {
    await withExecutionLifecycleResources(
      "pct-replan-bounded-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "shell",
              match: "initial",
              patch: false,
              shell: true,
              code: false,
            },
            {
              id: "off",
              match: "off",
              patch: false,
              shell: false,
              code: false,
            },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const foreignTools: string[] = [];
        const host = fakeHost(resources, {
          builtinNatives: true,
          foreignTools,
        });
        await host.start();

        // Every cleanup flips the shell winner between foreign and owned, so
        // no re-plan ever agrees with the candidate that ran it.
        const proto = ShellSessionManager.prototype as unknown as {
          close(): Promise<void>;
        };
        const realClose = proto.close;
        let closeCalls = 0;
        proto.close = function (this: never, ...args: unknown[]) {
          closeCalls += 1;
          if (foreignTools.length === 0) foreignTools.push(EXEC_COMMAND_TOOL);
          else foreignTools.length = 0;
          return realClose.apply(this, args as []);
        } as typeof proto.close;
        resources.restoreBeforeCleanup.push(() => {
          proto.close = realClose;
        });
        try {
          // The sync ends rather than looping: three cleanup passes, then the
          // candidate whose cleanup just ran commits.
          await host.select("off");
          expect(closeCalls).toBe(3);
          expect(host.active()).toContain("bash");
          expect(host.active()).not.toContain(CODE_MODE_EXEC_TOOL);
          expect(host.records().at(-1)).toMatchObject({
            effective: { directShell: false, code: false },
            cleanupPending: false,
          });
        } finally {
          proto.close = realClose;
        }
      },
    );
  });

  it("leaves the start fence to the newer sync when a re-plan is superseded", async () => {
    await withExecutionLifecycleResources(
      "pct-replan-superseded-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "shell",
              match: "initial",
              patch: false,
              shell: true,
              code: false,
            },
            {
              id: "off",
              match: "off",
              patch: false,
              shell: false,
              code: false,
            },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const foreignTools: string[] = [];
        let closeCalls = 0;
        let armed = false;
        let reads = 0;
        let interleave: (() => void) | undefined;
        const host = fakeHost(resources, {
          builtinNatives: true,
          foreignTools,
          // The older sync's re-plan reads the host twice: once for the plan,
          // once for the transition's foreign-shell check. Interleave on the
          // second, after that sync's generation check and before the pass
          // that would publish its fence.
          onToolsRead: () => {
            if (!armed) return;
            reads += 1;
            if (reads < 2) return;
            armed = false;
            interleave?.();
          },
        });
        await host.start();
        expect(host.active()).toContain(EXEC_COMMAND_TOOL);

        const proto = ShellSessionManager.prototype as unknown as {
          close(): Promise<void>;
        };
        const realClose = proto.close;
        proto.close = function (this: never, ...args: unknown[]) {
          closeCalls += 1;
          if (closeCalls === 1) {
            // A foreign winner appears during the older sync's only cleanup,
            // so its re-plan changes the transition and needs a second pass.
            foreignTools.push(EXEC_COMMAND_TOOL);
            armed = true;
            reads = 0;
          }
          return realClose.apply(this, args as []);
        } as typeof proto.close;
        resources.restoreBeforeCleanup.push(() => {
          proto.close = realClose;
        });
        let newer: unknown;
        let closesAtInterleave = -1;
        interleave = () => {
          closesAtInterleave = closeCalls;
          // The winner is gone again, so the newer selection resolves the
          // Shell route while the older candidate still says "off".
          foreignTools.length = 0;
          newer = host.select("initial");
        };
        try {
          await host.select("off");
          expect(closesAtInterleave).toBe(1);
          expect(newer).toBeDefined();
          await newer;

          // The superseded pass published neither its fence nor its cleanup:
          // the newer projection's own Shell route is the one in force.
          expect(closeCalls).toBe(1);
          expect(host.active()).toContain(EXEC_COMMAND_TOOL);
          expect(host.active()).not.toContain("bash");
          expect(host.records().at(-1)).toMatchObject({
            effective: { directShell: true },
            cleanupPending: false,
          });
          const execCommand = host.tools.get(EXEC_COMMAND_TOOL);
          const writeStdin = host.tools.get(WRITE_STDIN_TOOL);
          if (!execCommand || !writeStdin) {
            throw new Error("shell tools were not registered");
          }
          // The assertion is that the newer route still admits a fresh start,
          // not how quickly a real command settles: a first observation can
          // expire under load. Continue through write_stdin until the job is
          // terminal, accumulating the new output each read delivers.
          type ShellRead = {
            status: "running" | "completed" | "terminated";
            sessionId: string;
            stdout: string;
          };
          let read = (
            await execCommand.execute(
              "superseded-fence-1",
              { command: "printf ok", yieldTimeMs: 2000 },
              undefined,
              undefined,
              host.ctx,
            )
          ).details as ShellRead;
          let stdout = read.stdout;
          for (let poll = 1; read.status === "running"; poll += 1) {
            read = (
              await writeStdin.execute(
                `superseded-fence-poll-${poll}`,
                { sessionId: read.sessionId, yieldTimeMs: 2000 },
                undefined,
                undefined,
                host.ctx,
              )
            ).details as ShellRead;
            stdout += read.stdout;
          }
          expect(read.status).toBe("completed");
          expect(stdout).toBe("ok");
        } finally {
          proto.close = realClose;
        }
      },
    );
  });

  /**
   * Stage the commit-boundary race: an older sync passes the generation check
   * inside `settleTransition`, and a newer selection starts before that older
   * loop can commit. The newer sync parks in its own cleanup, so the older one
   * reaches its commit while the newer projection is still in flight.
   *
   * `resolveNewer` finishes that cleanup: `undefined` lets the newer sync
   * commit, an error makes it reject the way the reviewer's variant did.
   */
  async function withCommitBoundaryRace(
    resources: ExecutionLifecycleResources,
    body: (input: {
      host: ReturnType<typeof fakeHost>;
      newer: () => Promise<unknown>;
      resolveNewer: (error?: unknown) => void;
      shellCloses: () => number;
      cellCloses: () => number;
    }) => Promise<void>,
  ): Promise<void> {
    const agentDirectory = resources.root;
    const config = defaultConfig();
    config.execution = {
      version: 1,
      rules: [
        {
          id: "code",
          match: "initial",
          patch: false,
          shell: false,
          code: true,
        },
        { id: "off", match: "off", patch: false, shell: false, code: false },
      ],
    };
    config.codeMode.approvalMode = "always";
    await mkdir(join(agentDirectory, "extensions"), { recursive: true });
    await writeFile(
      join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
      JSON.stringify(config),
      "utf8",
    );
    // Armed once the older sync's contraction has closed the shell backend:
    // its next host read is the re-plan, which runs after the generation
    // check inside `settleTransition` and immediately before the commit.
    let phase: "idle" | "armed" | "done" = "idle";
    let interleave: (() => void) | undefined;
    const host = fakeHost(resources, {
      builtinNatives: true,
      hasUI: true,
      onToolsRead: () => {
        if (phase !== "armed") return;
        phase = "done";
        interleave?.();
      },
    });
    await host.start();
    expect(host.active()).toEqual([
      "read",
      "edit",
      "write",
      CODE_MODE_EXEC_TOOL,
      CODE_MODE_WAIT_TOOL,
    ]);

    const shellProto = ShellSessionManager.prototype as unknown as {
      close(): Promise<void>;
    };
    const realShellClose = shellProto.close;
    let shellCloses = 0;
    shellProto.close = function (this: never, ...args: unknown[]) {
      shellCloses += 1;
      if (phase === "idle") phase = "armed";
      return realShellClose.apply(this, args as []);
    } as typeof shellProto.close;
    resources.restoreBeforeCleanup.push(() => {
      shellProto.close = realShellClose;
    });
    const cellProto = CodeModeCellManager.prototype as unknown as {
      close(): Promise<void>;
    };
    const realCellClose = cellProto.close;
    let cellCloses = 0;
    cellProto.close = function (this: never, ...args: unknown[]) {
      cellCloses += 1;
      return realCellClose.apply(this, args as []);
    } as typeof cellProto.close;
    resources.restoreBeforeCleanup.push(() => {
      cellProto.close = realCellClose;
    });
    // Every sync sweeps Computer Use, so this is the newer sync's own cleanup
    // await — the one the test holds open.
    const lifecycleProto = ComputerUseLifecycle.prototype as unknown as {
      cleanup(pendingOnly?: boolean): Promise<void>;
    };
    const realLifecycleCleanup = lifecycleProto.cleanup;
    let holdNext = false;
    let settleNewer: ((error?: unknown) => void) | undefined;
    lifecycleProto.cleanup = function (this: never, ...args: unknown[]) {
      if (!holdNext) return realLifecycleCleanup.apply(this, args as []);
      holdNext = false;
      return new Promise<void>((resolve, reject) => {
        settleNewer = (error) => (error ? reject(error) : resolve());
      });
    } as typeof lifecycleProto.cleanup;
    resources.restoreBeforeCleanup.push(() => {
      lifecycleProto.cleanup = realLifecycleCleanup;
    });

    // Pi builds one context per hook call, so the older sync keeps the model
    // it was started for while this newer one resolves the Code rule.
    const newerCtx = {
      ...host.ctx,
      model: model({ id: "initial", provider: "test" }),
    } as unknown as ExtensionContext;
    let newer: Promise<unknown> | undefined;
    interleave = () => {
      holdNext = true;
      newer = Promise.resolve(
        host.handlers.get("model_select")?.(
          { type: "model_select" } as never,
          newerCtx,
        ),
      );
    };
    try {
      await host.select("off");
      if (!newer) throw new Error("the newer sync did not start");
      const started = newer;
      await body({
        host,
        newer: () => started,
        resolveNewer: (error) => {
          if (!settleNewer) throw new Error("the newer sync is not parked");
          settleNewer(error);
        },
        shellCloses: () => shellCloses,
        cellCloses: () => cellCloses,
      });
    } finally {
      shellProto.close = realShellClose;
      cellProto.close = realCellClose;
      lifecycleProto.cleanup = realLifecycleCleanup;
    }
  }

  it("does not commit a contraction a newer sync superseded at the commit", async () => {
    await withExecutionLifecycleResources(
      "pct-commit-superseded-",
      async (resources) => {
        await withCommitBoundaryRace(
          resources,
          async ({ host, newer, resolveNewer, shellCloses, cellCloses }) => {
            // The older sync planned "off" and ran its cleanup, but a newer
            // selection started before it could commit: publishing that plan
            // now would remove `exec`/`wait` from the projection the newer
            // sync is about to keep.
            expect(host.active()).toContain(CODE_MODE_EXEC_TOOL);
            expect(host.active()).toContain(CODE_MODE_WAIT_TOOL);
            expect(host.active()).not.toContain("bash");

            // The newer selection's fence and the committed Code route admit
            // a fresh cell while its own cleanup is still running.
            const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
            const wait = host.tools.get(CODE_MODE_WAIT_TOOL);
            if (!exec || !wait) {
              throw new Error("Code Mode tools were not registered");
            }
            const started = await exec.execute(
              "commit-superseded-1",
              { code: "await new Promise(() => {});", yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            );
            expect(started.details).toMatchObject({ status: "running" });
            const cellId = (started.details as { cellId: string }).cellId;

            resolveNewer();
            await newer();

            expect(host.active()).toContain(CODE_MODE_EXEC_TOOL);
            expect(host.active()).not.toContain("bash");
            const polled = await wait.execute(
              "commit-superseded-2",
              { cellId, yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            );
            expect(polled.details).toMatchObject({ cellId, status: "running" });
            // Only the older contraction's own shell close ran: the
            // superseded loop added no second cleanup, and no cell manager
            // was ever closed under the running cell.
            expect(shellCloses()).toBe(1);
            expect(cellCloses()).toBe(0);
            expect(host.records().at(-1)).toMatchObject({
              effective: { code: true },
              cleanupPending: false,
            });
          },
        );
      },
    );
  });

  it("keeps a running cell controllable when the newer sync's cleanup fails", async () => {
    await withExecutionLifecycleResources(
      "pct-commit-superseded-failed-",
      async (resources) => {
        await withCommitBoundaryRace(
          resources,
          async ({ host, newer, resolveNewer, shellCloses, cellCloses }) => {
            const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
            const wait = host.tools.get(CODE_MODE_WAIT_TOOL);
            if (!exec || !wait) {
              throw new Error("Code Mode tools were not registered");
            }
            const started = await exec.execute(
              "commit-superseded-failed-1",
              { code: "await new Promise(() => {});", yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            );
            expect(started.details).toMatchObject({ status: "running" });
            const cellId = (started.details as { cellId: string }).cellId;

            // The newer sync cannot commit either: its cleanup rejects, so
            // the retained projection is the only thing holding this cell's
            // controls. A superseded "off" commit would leave a running cell
            // with no way to observe or stop it.
            resolveNewer(new Error("injected Computer Use cleanup failure"));
            await expect(newer()).rejects.toThrow(
              "injected Computer Use cleanup failure",
            );

            expect(host.active()).toContain(CODE_MODE_EXEC_TOOL);
            expect(host.active()).toContain(CODE_MODE_WAIT_TOOL);
            expect(host.active()).not.toContain("bash");
            const polled = await wait.execute(
              "commit-superseded-failed-2",
              { cellId, yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            );
            expect(polled.details).toMatchObject({ cellId, status: "running" });
            expect(shellCloses()).toBe(1);
            expect(cellCloses()).toBe(0);
            // The failure itself stays visible.
            expect(await host.status()).toContain(
              "Apply error: applying the configuration failed during owned-resource cleanup",
            );
          },
        );
      },
    );
  });

  it("commits the tool list against host state observed after cleanup", async () => {
    await withExecutionLifecycleResources(
      "pct-replan-sync-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "code-only",
              match: "initial",
              patch: false,
              shell: false,
              code: true,
            },
            {
              id: "off",
              match: "off",
              patch: false,
              shell: false,
              code: false,
            },
          ],
        };
        config.codeMode.approvalMode = "always";
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        // Another extension visibly owns the Search name, so this projection
        // never manages its activation state.
        const host = fakeHost(resources, {
          builtinNatives: true,
          foreignTools: [WEB_SEARCH_TOOL],
        });
        await host.start();
        expect(host.active()).toEqual([
          "read",
          "edit",
          "write",
          CODE_MODE_EXEC_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]);
        const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
        if (!exec) throw new Error("Code Mode tools were not registered");
        const started = await exec.execute(
          "replan-1",
          { code: "await new Promise(() => {});", yieldTimeMs: 0 },
          undefined,
          undefined,
          host.ctx,
        );
        expect(started.details).toMatchObject({ status: "running" });

        // Hold the contraction inside real cell cleanup and change the host's
        // active list while it waits.
        const proto = CodeModeCellManager.prototype as unknown as {
          terminateCell(cell: never, reason: string): Promise<void>;
        };
        const realTerminateCell = proto.terminateCell;
        let hold = true;
        let entered!: () => void;
        let release!: () => void;
        const enteredPromise = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const releasePromise = new Promise<void>((resolve) => {
          release = resolve;
        });
        proto.terminateCell = async function (this: never, ...args: unknown[]) {
          if (hold) {
            hold = false;
            entered();
            await releasePromise;
          }
          return realTerminateCell.apply(this, args as [never, string]);
        } as typeof proto.terminateCell;
        resources.restoreBeforeCleanup.push(() => {
          proto.terminateCell = realTerminateCell;
        });
        try {
          const contraction = host.select("off");
          await enteredPromise;
          // The user disables a visible builtin and another extension
          // activates its own tool while the cleanup is still running.
          host.setActiveTools([
            "read",
            "write",
            CODE_MODE_EXEC_TOOL,
            CODE_MODE_WAIT_TOOL,
            WEB_SEARCH_TOOL,
          ]);
          release();
          await contraction;

          // The list captured before the await would have restored `edit` and
          // dropped the foreign tool; the committed one is planned against
          // what the host actually reports now.
          expect(host.active()).not.toContain("edit");
          expect(host.active()).toContain(WEB_SEARCH_TOOL);
          expect(host.active()).toContain("write");
          // bash was this projection's own suppression, so it comes back.
          expect(host.active()).toContain("bash");
          expect(host.active()).not.toContain(CODE_MODE_EXEC_TOOL);
          // Native provenance stays correct: the external disable survives
          // the next sync instead of being owed back.
          await host.select("off");
          expect(host.active()).not.toContain("edit");
          expect(host.active()).toContain(WEB_SEARCH_TOOL);
        } finally {
          proto.terminateCell = realTerminateCell;
        }
      },
    );
  });

  it("keeps a superseded cleanup failure visible and recoverable", async () => {
    await withExecutionLifecycleResources(
      "pct-superseded-cleanup-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "code-only",
              match: "initial",
              patch: false,
              shell: false,
              code: true,
            },
            {
              id: "off",
              match: "off",
              patch: false,
              shell: false,
              code: false,
            },
          ],
        };
        config.codeMode.approvalMode = "always";
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const host = fakeHost(resources, {
          builtinNatives: true,
          hasUI: true,
        });
        await host.start();
        const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
        const wait = host.tools.get(CODE_MODE_WAIT_TOOL);
        if (!exec || !wait) throw new Error("Code Mode tools not registered");
        const started = await exec.execute(
          "superseded-1",
          { code: "await new Promise(() => {});", yieldTimeMs: 0 },
          undefined,
          undefined,
          host.ctx,
        );
        const cellId = (started.details as { cellId: string }).cellId;

        const proto = CodeModeCellManager.prototype as unknown as {
          terminateCell(cell: never, reason: string): Promise<void>;
        };
        const realTerminateCell = proto.terminateCell;
        let failing = true;
        let entered!: () => void;
        let release!: () => void;
        const enteredPromise = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const releasePromise = new Promise<void>((resolve) => {
          release = resolve;
        });
        proto.terminateCell = async function (this: never, ...args: unknown[]) {
          if (failing) {
            entered();
            await releasePromise;
            throw new Error("injected cleanup-incomplete");
          }
          return realTerminateCell.apply(this, args as [never, string]);
        } as typeof proto.terminateCell;
        resources.restoreBeforeCleanup.push(() => {
          proto.terminateCell = realTerminateCell;
        });
        try {
          // An off transition starts closing the manager; a newer on
          // transition commits while that close is still running.
          const older = host.select("off");
          await enteredPromise;
          await host.select("initial");
          expect(host.records().at(-1)).toMatchObject({
            effective: { code: true },
            cleanupPending: false,
          });
          release();
          await older;

          // The superseded attempt no longer owns the projection, but the
          // manager it failed to release still refuses every new cell, so the
          // failure stays visible instead of vanishing with its generation.
          expect(host.records().at(-1)).toMatchObject({
            effective: { code: true },
            cleanupPending: true,
          });
          const pendingStatus = await host.status();
          expect(pendingStatus).toContain(
            "Apply error: Code Mode cleanup did not confirm",
          );
          // The line names the recovery the implementation actually offers:
          // `exec` refuses that manager, so the retry belongs to a lifecycle
          // sync, not to the next call.
          expect(pendingStatus).toContain(
            "the next lifecycle recovery (/pct reload, a model change or session replacement) retries the cleanup before rebinding",
          );
          expect(pendingStatus).not.toContain("the next exec retries");
          await expect(
            exec.execute(
              "superseded-2",
              { code: "return 1;", yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            ),
          ).rejects.toThrow("Run /pct reload");
          // Accepted N3: the retained cell keeps its observation control.
          const polled = await wait.execute(
            "superseded-3",
            { cellId, yieldTimeMs: 0 },
            undefined,
            undefined,
            host.ctx,
          );
          expect(polled.details).toMatchObject({ cellId, status: "running" });

          // A later lifecycle cleanup retries the close, rebinds and clears
          // the pending state.
          failing = false;
          await host.command("reload", host.ctx);
          expect(host.records().at(-1)).toMatchObject({
            effective: { code: true },
            cleanupPending: false,
          });
          const status = await host.status();
          expect(status).not.toContain("Apply error:");
          const rebound = await exec.execute(
            "superseded-4",
            { code: "return 7;", yieldTimeMs: 10_000 },
            undefined,
            undefined,
            host.ctx,
          );
          expect(rebound.details).toMatchObject({
            status: "completed",
            result: 7,
          });
          await expect(
            wait.execute(
              "superseded-5",
              { cellId, yieldTimeMs: 0 },
              undefined,
              undefined,
              host.ctx,
            ),
          ).rejects.toMatchObject({ code: "stale-cell" });
        } finally {
          proto.terminateCell = realTerminateCell;
        }
      },
    );
  });

  it("reports committed routes to find_tools while an apply is pending", async () => {
    await withExecutionLifecycleResources(
      "pct-discovery-committed-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            {
              id: "pc",
              match: "initial",
              patch: true,
              shell: false,
              code: true,
            },
            {
              id: "p",
              match: "direct",
              patch: true,
              shell: false,
              code: false,
            },
          ],
        };
        config.codeMode.approvalMode = "always";
        config.toolDiscovery.enabled = true;
        config.toolDiscovery.deferred = [APPLY_PATCH_TOOL];
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const host = fakeHost(resources, { builtinNatives: true });
        await host.start();
        // P+C commits nested Patch + Code: apply_patch is nested-only.
        expect(host.active()).toEqual([
          "read",
          CODE_MODE_EXEC_TOOL,
          CODE_MODE_WAIT_TOOL,
          TOOL_DISCOVERY_TOOL,
        ]);
        const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
        const findTools = host.tools.get(TOOL_DISCOVERY_TOOL);
        if (!exec || !findTools) throw new Error("tools were not registered");
        const started = await exec.execute(
          "committed-1",
          { code: "await new Promise(() => {});", yieldTimeMs: 0 },
          undefined,
          undefined,
          host.ctx,
        );
        const cellId = (started.details as { cellId: string }).cellId;

        const proto = CodeModeCellManager.prototype as unknown as {
          terminateCell(cell: never, reason: string): Promise<void>;
        };
        const realTerminateCell = proto.terminateCell;
        proto.terminateCell = (() =>
          Promise.reject(
            new Error("injected cleanup-incomplete"),
          )) as typeof proto.terminateCell;
        resources.restoreBeforeCleanup.push(() => {
          proto.terminateCell = realTerminateCell;
        });
        try {
          // P+C → P would drop Code; the failed apply keeps the committed
          // nested-only projection, and discovery must report that — never
          // the uncommitted direct route.
          await expect(host.select("direct")).rejects.toThrow(
            "injected cleanup-incomplete",
          );
          proto.terminateCell = realTerminateCell;

          const before = host.active();
          const load = await findTools.execute(
            "committed-2",
            { load: [APPLY_PATCH_TOOL] },
            undefined,
            undefined,
            host.ctx,
          );
          expect(load.details).toEqual({
            rejected: [{ name: APPLY_PATCH_TOOL, reason: "nested-only" }],
          });
          expect(host.active()).toEqual(before);
          await expect(
            host.tools
              .get(APPLY_PATCH_TOOL)!
              .execute(
                "committed-3",
                { patch: "*** Begin Patch\n*** End Patch" },
                undefined,
                undefined,
                host.ctx,
              ),
          ).rejects.toThrow("Apply Patch is not enabled.");
        } finally {
          proto.terminateCell = realTerminateCell;
        }
        const wait = host.tools.get(CODE_MODE_WAIT_TOOL)!;
        await wait.execute(
          "committed-4",
          { cellId, terminate: true, yieldTimeMs: 10_000 },
          undefined,
          undefined,
          host.ctx,
        );
      },
    );
  });

  it("reconciles a transcript-replayed baseline only at the tree boundary", async () => {
    await withExecutionLifecycleResources(
      "pct-tree-baseline-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "ps", match: "*", patch: true, shell: true, code: false },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        const configPath = join(
          agentDirectory,
          "extensions",
          "pi-codex-toolkit.json",
        );
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const host = fakeHost(resources, {
          builtinNatives: true,
          sessionFile: join(agentDirectory, "session.jsonl"),
        });
        await host.start();
        expect(host.active()).toEqual([
          "read",
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ]);

        // Stop hiding: the committed suppression set is cleared and the
        // admitted baseline is back on the active list.
        config.execution = {
          version: 1,
          rules: [
            { id: "none", match: "*", patch: false, shell: false, code: false },
          ],
        };
        await writeFile(configPath, JSON.stringify(config), "utf8");
        await host.command("reload", host.ctx);
        expect(host.active()).toEqual([...NATIVE_NAMES]);

        // Pi's tree navigation replays the earlier branch's filtered tool
        // declaration, dropping the restored natives again; session_tree
        // reconciles them back through the retained baseline.
        host.setActiveTools([
          "read",
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ]);
        await host.handlers.get("session_tree")?.(
          {
            type: "session_tree",
            newLeafId: null,
            oldLeafId: null,
          } as never,
          host.ctx,
        );
        expect(host.active()).toEqual([...NATIVE_NAMES]);

        // Without the tree boundary the same absence stays untouched: a
        // plain sync treats it as an external removal, not ours to undo,
        // and drops the names from the admitted baseline.
        host.setActiveTools(["read"]);
        await host.select("initial");
        expect(host.active()).toEqual(["read"]);

        // Tree replay of that same read-only declaration must not revive
        // names the ordinary sync already recorded as externally disabled.
        host.setActiveTools(["read"]);
        await host.handlers.get("session_tree")?.(
          {
            type: "session_tree",
            newLeafId: null,
            oldLeafId: null,
          } as never,
          host.ctx,
        );
        expect(host.active()).toEqual(["read"]);

        // A historical enabled declaration is not an external re-enable:
        // visiting it then returning to the read-only declaration must not
        // restore natives the ordinary sync already dropped from baseline.
        host.setActiveTools([...NATIVE_NAMES]);
        await host.handlers.get("session_tree")?.(
          {
            type: "session_tree",
            newLeafId: null,
            oldLeafId: null,
          } as never,
          host.ctx,
        );
        expect(host.active()).toEqual([...NATIVE_NAMES]);
        host.setActiveTools(["read"]);
        await host.handlers.get("session_tree")?.(
          {
            type: "session_tree",
            newLeafId: null,
            oldLeafId: null,
          } as never,
          host.ctx,
        );
        expect(host.active()).toEqual(["read"]);
      },
    );
  });

  it("captures a fresh baseline on resume instead of inheriting the stash", async () => {
    await withExecutionLifecycleResources(
      "pct-resume-baseline-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "ps", match: "*", patch: true, shell: true, code: false },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        const configPath = join(
          agentDirectory,
          "extensions",
          "pi-codex-toolkit.json",
        );
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const sessionFile = join(agentDirectory, "session.jsonl");

        const first = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
        });
        await first.start();
        expect(first.active()).toEqual([
          "read",
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ]);
        await first.handlers.get("session_shutdown")?.(
          { type: "session_shutdown", reason: "quit" } as never,
          first.ctx,
        );

        // The next host is built from narrower current defaults: only read
        // is active. A resume creates a fresh runtime, so the old session
        // file's stash must not re-activate natives this host never admitted.
        config.execution = {
          version: 1,
          rules: [
            { id: "none", match: "*", patch: false, shell: false, code: false },
          ],
        };
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const resumed = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
          startReason: "resume",
          initialActive: ["read"],
        });
        await resumed.start();
        expect(resumed.active()).toEqual(["read"]);

        // A reload of that same host lineage does inherit the stash entry —
        // its baseline was already narrowed, so nothing is restored.
        await resumed.handlers.get("session_start")?.(
          { type: "session_start", reason: "reload" } as never,
          resumed.ctx,
        );
        expect(resumed.active()).toEqual(["read"]);
      },
    );
  });

  it("carries the suppression set across a factory rebuild on host reload", async () => {
    await withExecutionLifecycleResources(
      "pct-reload-suppression-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "ps", match: "*", patch: true, shell: true, code: false },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        const configPath = join(
          agentDirectory,
          "extensions",
          "pi-codex-toolkit.json",
        );
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const sessionFile = join(agentDirectory, "session.jsonl");

        const first = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
        });
        await first.start();
        expect(first.active()).toEqual([
          "read",
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ]);
        await first.handlers.get("session_shutdown")?.(
          { type: "session_shutdown", reason: "reload" } as never,
          first.ctx,
        );

        // Pi rebuilds the factory with the already-filtered active list: the
        // new binding cannot see bash/edit/write as active anywhere.
        config.execution = {
          version: 1,
          rules: [
            { id: "none", match: "*", patch: false, shell: false, code: false },
          ],
        };
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const second = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
          startReason: "reload",
          initialActive: [
            "read",
            APPLY_PATCH_TOOL,
            EXEC_COMMAND_TOOL,
            WRITE_STDIN_TOOL,
          ],
        });
        await second.start();
        expect(second.active()).toEqual(["read", "bash", "edit", "write"]);
      },
    );
  });

  it("keeps native provenance per factory identity and writes none unresolved", async () => {
    await withExecutionLifecycleResources(
      "pct-stash-identity-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "ps", match: "*", patch: true, shell: true, code: false },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        const configPath = join(
          agentDirectory,
          "extensions",
          "pi-codex-toolkit.json",
        );
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const sessionFile = join(agentDirectory, "session.jsonl");
        const ownerPath = fileURLToPath(
          new URL("../src/index.ts", import.meta.url),
        );
        const replaced = ["bash", "edit", "write"];
        const filtered = [
          "read",
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ];

        const owner = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
        });
        await owner.start();
        expect(owner.active()).toEqual(filtered);
        // One record, under this factory's own identity and lineage.
        expect(nativeProvenance(sessionFile)).toEqual([
          { identity: ownerPath, baseline: replaced, suppressed: replaced },
        ]);

        // A factory that proves no identity owns nothing in this host, so it
        // neither hides a builtin nor records provenance: replacing the
        // owner's record with its own empty sets is what left a later reload
        // with nothing to restore.
        const unresolved = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
          unresolvedIdentity: true,
          initialActive: [...filtered],
        });
        await unresolved.start();
        expect(unresolved.active()).toEqual(filtered);
        expect(nativeProvenance(sessionFile)).toEqual([
          { identity: ownerPath, baseline: replaced, suppressed: replaced },
        ]);

        // A second resolved identity in the same session keeps its own entry
        // beside the owner's instead of overwriting it.
        const other = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
          sourcePath: "/other/toolkit.ts",
          initialActive: [...filtered],
        });
        await other.start();
        expect(nativeProvenance(sessionFile)).toEqual([
          { identity: ownerPath, baseline: replaced, suppressed: replaced },
          { identity: "/other/toolkit.ts", baseline: [], suppressed: [] },
        ]);

        // The owner's own rebuild still inherits its history and restores the
        // three builtins it hid.
        config.execution = { version: 1, rules: [] };
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const reloaded = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
          startReason: "reload",
          initialActive: [...filtered],
        });
        await reloaded.start();
        expect(reloaded.active()).toEqual(["read", "bash", "edit", "write"]);
      },
    );
  });

  it("recaptures a deferred lineage's baseline before a tree replay could revive hidden builtins", async () => {
    await withExecutionLifecycleResources(
      "pct-deferred-hydration-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "ps", match: "*", patch: true, shell: true, code: false },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const filtered = [
          "read",
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ];
        // This binding proves no identity, so its hydration is deferred
        // rather than recorded. It also reaches session_start while the
        // builtins are still visible, so the per-binding baseline it starts
        // from names all three.
        const unresolved = fakeHost(resources, {
          builtinNatives: true,
          sessionFile: join(agentDirectory, "session.jsonl"),
          unresolvedIdentity: true,
        });
        await unresolved.start();
        expect(unresolved.active()).toEqual([...NATIVE_NAMES]);

        // The factory that owns the names then hides them, and Pi shows this
        // binding the already-filtered list. Tree navigation reclaims missing
        // baseline members as this projection's suppression, so a stale
        // baseline would restore builtins this binding never hid. The
        // deferred hydration the sync retries at its entry recaptures the
        // baseline from the current winners first.
        unresolved.setActiveTools([...filtered]);
        await unresolved.handlers.get("session_tree")?.(
          {
            type: "session_tree",
            newLeafId: null,
            oldLeafId: null,
          } as never,
          unresolved.ctx,
        );
        expect(unresolved.active()).toEqual(filtered);
      },
    );
  });

  it("records native provenance when the identity resolves during a sync's cleanup", async () => {
    await withExecutionLifecycleResources(
      "pct-late-identity-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "ps", match: "*", patch: true, shell: true, code: false },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        const configPath = join(
          agentDirectory,
          "extensions",
          "pi-codex-toolkit.json",
        );
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const sessionFile = join(agentDirectory, "session.jsonl");
        const ownerPath = fileURLToPath(
          new URL("../src/index.ts", import.meta.url),
        );
        const replaced = ["bash", "edit", "write"];
        const filtered = [
          "read",
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ];

        // An embedder that stages its registrations: Pi attributes none of
        // them to this factory yet, so session_start resolves no identity and
        // defers the hydration instead of recording empty sets.
        let published = false;
        const writes: ReturnType<typeof nativeProvenance>[] = [];
        const host = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
          unresolvedIdentity: () => !published,
          onActiveTools: () => writes.push(nativeProvenance(sessionFile)),
        });
        await host.start();
        expect(host.active()).toEqual([...NATIVE_NAMES]);
        expect(nativeProvenance(sessionFile)).toEqual([]);
        expect(writes).toEqual([]);

        // Hold the next sync's owned-resource cleanup and publish the staged
        // registrations while it is held: the plan that already ran saw no
        // identity, and the re-plan after the await is the first projection
        // that can hide a builtin.
        const proto = ShellSessionManager.prototype as unknown as {
          close(): Promise<void>;
        };
        const realClose = proto.close;
        let release: (() => void) | undefined;
        proto.close = function (this: never, ...args: unknown[]) {
          if (release) return realClose.apply(this, args as []);
          return new Promise<void>((resolve) => {
            release = () => resolve(realClose.apply(this, args as []));
          });
        } as typeof proto.close;
        resources.restoreBeforeCleanup.push(() => {
          proto.close = realClose;
        });

        const change = host.select("second");
        if (!release) throw new Error("the sync did not reach its cleanup");
        // Read the parked state, then publish and release before asserting
        // it: a failed assertion must not leave the held cleanup waiting.
        const parked = host.active();
        published = true;
        release();
        await change;
        expect(parked).toEqual([...NATIVE_NAMES]);
        expect(host.active()).toEqual(filtered);

        // The entry existed before the projection that hid the builtins was
        // written — its baseline is the three winners this factory had not
        // hidden yet — and the commit then recorded the suppression into it.
        expect(writes).toEqual([
          [{ identity: ownerPath, baseline: replaced, suppressed: [] }],
        ]);
        expect(nativeProvenance(sessionFile)).toEqual([
          { identity: ownerPath, baseline: replaced, suppressed: replaced },
        ]);

        // The deferred hydration is finished, so a later model change cannot
        // replace that record with the empty sets a filtered read produces.
        await host.select("third");
        expect(host.active()).toEqual(filtered);
        expect(nativeProvenance(sessionFile)).toEqual([
          { identity: ownerPath, baseline: replaced, suppressed: replaced },
        ]);

        // With the record intact, dropping the rules restores the builtins on
        // this binding and on the one a reload rebuilds against the filtered
        // list.
        config.execution = { version: 1, rules: [] };
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const reloaded = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
          startReason: "reload",
          initialActive: [...filtered],
        });
        await reloaded.start();
        expect(reloaded.active()).toEqual(["read", "bash", "edit", "write"]);
      },
    );
  });

  it("restores an inherited suppression when the identity resolves mid-sync", async () => {
    await withExecutionLifecycleResources(
      "pct-late-identity-restore-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "ps", match: "*", patch: true, shell: true, code: false },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        const configPath = join(
          agentDirectory,
          "extensions",
          "pi-codex-toolkit.json",
        );
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const sessionFile = join(agentDirectory, "session.jsonl");
        const ownerPath = fileURLToPath(
          new URL("../src/index.ts", import.meta.url),
        );
        const replaced = ["bash", "edit", "write"];
        const filtered = [
          "read",
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ];

        // The owner hides the three builtins and records that suppression.
        const owner = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
        });
        await owner.start();
        expect(owner.active()).toEqual(filtered);
        expect(nativeProvenance(sessionFile)).toEqual([
          { identity: ownerPath, baseline: replaced, suppressed: replaced },
        ]);

        // The rules are off when a reload rebuilds the factory against the
        // filtered list, and that binding stages its registrations: its
        // session_start resolves no identity, so the sync that follows
        // captures empty per-binding sets.
        config.execution = { version: 1, rules: [] };
        await writeFile(configPath, JSON.stringify(config), "utf8");
        let published = false;
        const reloaded = fakeHost(resources, {
          builtinNatives: true,
          sessionFile,
          startReason: "reload",
          initialActive: [...filtered],
          unresolvedIdentity: () => !published,
        });
        await reloaded.start();
        expect(reloaded.active()).toEqual(filtered);

        // The identity resolves while the next sync holds its cleanup, so the
        // hydration that inherits this lineage's suppression lands between
        // that sync's capture and the plan that must read it.
        const proto = ShellSessionManager.prototype as unknown as {
          close(): Promise<void>;
        };
        const realClose = proto.close;
        let release: (() => void) | undefined;
        proto.close = function (this: never, ...args: unknown[]) {
          if (release) return realClose.apply(this, args as []);
          return new Promise<void>((resolve) => {
            release = () => resolve(realClose.apply(this, args as []));
          });
        } as typeof proto.close;
        resources.restoreBeforeCleanup.push(() => {
          proto.close = realClose;
        });

        const change = reloaded.select("second");
        if (!release) throw new Error("the sync did not reach its cleanup");
        published = true;
        release();
        await change;
        // The inherited record is what restores them: a plan that read the
        // pre-hydration sets would leave the three hidden for good.
        expect(reloaded.active()).toEqual(["read", "bash", "edit", "write"]);
        expect(nativeProvenance(sessionFile)).toEqual([
          { identity: ownerPath, baseline: replaced, suppressed: [] },
        ]);
      },
    );
  });

  it("captures a fresh baseline on fork and leaves the parent's stash alone", async () => {
    await withExecutionLifecycleResources(
      "pct-fork-suppression-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "ps", match: "*", patch: true, shell: true, code: false },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        const configPath = join(
          agentDirectory,
          "extensions",
          "pi-codex-toolkit.json",
        );
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const parentFile = join(agentDirectory, "parent.jsonl");
        const childFile = join(agentDirectory, "child.jsonl");

        const parent = fakeHost(resources, {
          builtinNatives: true,
          sessionFile: parentFile,
        });
        await parent.start();
        expect(parent.active()).toEqual([
          "read",
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ]);

        // A forked host is built from the current default tools — the real
        // runtime resolves initialActiveToolNames from settings rather than
        // replaying the parent's filtered projection — so the child captures
        // a fresh admitted baseline and never inherits the parent's stash.
        const child = fakeHost(resources, {
          builtinNatives: true,
          sessionFile: childFile,
          startReason: "fork",
          previousSessionFile: parentFile,
          initialActive: [...NATIVE_NAMES],
        });
        config.execution = {
          version: 1,
          rules: [
            { id: "none", match: "*", patch: false, shell: false, code: false },
          ],
        };
        await writeFile(configPath, JSON.stringify(config), "utf8");
        await child.start();
        expect(child.active()).toEqual(["read", "bash", "edit", "write"]);

        // The child wrote only its own stash entry: the parent's recorded
        // suppression is untouched, so a parent reload still restores its
        // natives. (model_select would reuse the parent's stale snapshot.)
        await parent.handlers.get("session_start")?.(
          { type: "session_start", reason: "reload" } as never,
          parent.ctx,
        );
        expect(parent.active()).toEqual(["read", "bash", "edit", "write"]);
      },
    );
  });

  it("rejects deferred names whose effective route failed admission", async () => {
    const agentDirectory = await mkdtemp(
      join(tmpdir(), "pct-discovery-route-"),
    );
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    try {
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          {
            id: "pc",
            match: "*",
            patch: true,
            shell: false,
            code: true,
          },
        ],
      };
      config.toolDiscovery.enabled = true;
      config.toolDiscovery.deferred = [
        APPLY_PATCH_TOOL,
        CODE_MODE_EXEC_TOOL,
        CODE_MODE_WAIT_TOOL,
      ];
      await mkdir(join(agentDirectory, "extensions"), { recursive: true });
      await writeFile(
        join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
        JSON.stringify(config),
        "utf8",
      );

      const handlers = new Map<string, ExtensionHandler<never, unknown>>();
      const tools = new Map<string, ToolDefinition>();
      const sourcePath = fileURLToPath(
        new URL("../src/index.ts", import.meta.url),
      );
      let active: string[] = ["read", "bash", "edit", "write"];
      const pi = {
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
        registerCommand: () => undefined,
        on: (event: string, handler: ExtensionHandler<never, unknown>) => {
          handlers.set(event, handler);
        },
        getActiveTools: () => active,
        // exec_command is absent: the owned Shell pair is incomplete, so the
        // P+C rule's Code route and nested Patch route both fail admission.
        getAllTools: () =>
          [...tools.values()]
            .filter((tool) => tool.name !== EXEC_COMMAND_TOOL)
            .map((tool) => ({
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
      const ctx = {
        cwd: agentDirectory,
        model: model({ provider: "test" }),
        modelRegistry: registry(),
      } as unknown as ExtensionContext;
      piCodexToolkit(withEventBus(pi));
      await handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" } as never,
        ctx,
      );

      const findTools = tools.get(TOOL_DISCOVERY_TOOL);
      if (!findTools) throw new Error("find_tools was not registered");
      const loaded = await findTools.execute(
        "route-1",
        { load: [APPLY_PATCH_TOOL, CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL] },
        undefined,
        undefined,
        ctx,
      );
      expect(loaded.details).toEqual({
        rejected: [
          { name: APPLY_PATCH_TOOL, reason: "disabled" },
          { name: CODE_MODE_EXEC_TOOL, reason: "disabled" },
          { name: CODE_MODE_WAIT_TOOL, reason: "disabled" },
        ],
      });
      expect(active).not.toContain(APPLY_PATCH_TOOL);
      expect(active).not.toContain(CODE_MODE_EXEC_TOOL);
      expect(active).not.toContain(CODE_MODE_WAIT_TOOL);

      await handlers.get("session_shutdown")?.(
        { type: "session_shutdown", reason: "quit" } as never,
        ctx,
      );
    } finally {
      if (previousAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
      }
      await rm(agentDirectory, { recursive: true, force: true });
    }
  });

  it("renders the committed routes instead of the stripped legacy flags", async () => {
    await withExecutionLifecycleResources(
      "pct-status-rules-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "pc", match: "*", patch: true, shell: false, code: true },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const host = fakeHost(resources, { builtinNatives: true, hasUI: true });
        await host.start();
        // P+C commits nestedPatch+code: bash/edit/write are hidden and
        // apply_patch is nested-only, so the active list is read + the pair.
        expect(host.active()).toEqual([
          "read",
          CODE_MODE_EXEC_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]);

        const text = await host.status();
        expect(statusSection(text, "Apply Patch:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: active",
          "  reason: ",
        ]);
        expect(statusSection(text, "Shell Sessions:").slice(0, 3)).toEqual([
          "  configured: off",
          "  effective: off",
          "  reason: ",
        ]);
        expect(statusSection(text, "Code Mode:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: active",
          "  reason: ",
        ]);
        expect(statusSection(text, "Execution rules:")).toEqual([
          "  schema: rules",
          "  rule: pc",
          "  requested: P+C",
          "  effective: nestedPatch+code",
          "  hide bash: yes",
          "  hide edit/write: yes",
          "  notes: ",
        ]);
        expect(text).not.toContain("Apply error:");
      },
    );
  });

  it("surfaces requested routes that failed admission with their notes", async () => {
    await withExecutionLifecycleResources(
      "pct-status-admission-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "pc", match: "*", patch: true, shell: false, code: true },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        // exec_command is absent from the projection: the Shell pair is not
        // admitted, which fails the Code route and keeps Patch unrouted.
        const host = fakeHost(resources, {
          builtinNatives: true,
          hasUI: true,
          absentTools: [EXEC_COMMAND_TOOL],
        });
        await host.start();
        expect(host.active()).toEqual([...NATIVE_NAMES]);

        const text = await host.status();
        expect(statusSection(text, "Apply Patch:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: unavailable",
          "  reason: code-unavailable-did-not-promote-patch",
        ]);
        // exec/wait are owned here, so the Code row names the missing nested
        // Shell pair rather than its own pair.
        expect(statusSection(text, "Code Mode:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: unavailable",
          "  reason: code-shell-pair-unavailable",
        ]);
        // The rules never requested direct Shell, so that row is plain off
        // with no reason — exactly as a disabled capability reports. The
        // missing pair belongs to the Code row's note above; an absent name
        // is not this row's ownership conflict.
        expect(statusSection(text, "Shell Sessions:").slice(0, 3)).toEqual([
          "  configured: off",
          "  effective: off",
          "  reason: ",
        ]);
        expect(statusSection(text, "Execution rules:")).toEqual([
          "  schema: rules",
          "  rule: pc",
          "  requested: P+C",
          "  effective: native",
          "  hide bash: no",
          "  hide edit/write: no",
          "  notes: code-shell-pair-unavailable,code-unavailable-did-not-promote-patch",
        ]);
      },
    );
  });

  it("separates a foreign winner from an allowlist-filtered owned name", async () => {
    await withExecutionLifecycleResources(
      "pct-status-foreign-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "psc", match: "*", patch: true, shell: true, code: true },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        // Another extension wins `exec`; `apply_patch` is merely filtered out
        // of the projection by a role or CLI allowlist.
        const host = fakeHost(resources, {
          builtinNatives: true,
          hasUI: true,
          foreignTools: [CODE_MODE_EXEC_TOOL],
          absentTools: [APPLY_PATCH_TOOL],
        });
        await host.start();

        const text = await host.status();
        // A visible foreign winner is this row's conflict.
        expect(statusSection(text, "Code Mode:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: unavailable",
          "  reason: conflicting-tool-name",
        ]);
        // The absent owned Patch name is not another extension's
        // registration: the requested route was never admitted, and the
        // committed note says why instead of naming a conflict.
        expect(statusSection(text, "Apply Patch:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: unavailable",
          "  reason: code-unavailable-did-not-promote-patch",
        ]);
        // Direct Shell is unaffected by either.
        expect(statusSection(text, "Shell Sessions:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: active",
          "  reason: ",
        ]);
        expect(statusSection(text, "Execution rules:")).toEqual([
          "  schema: rules",
          "  rule: psc",
          "  requested: P+S+C",
          "  effective: directShell",
          "  hide bash: yes",
          "  hide edit/write: no",
          "  notes: code-pair-unavailable,code-unavailable-did-not-promote-patch",
        ]);
      },
    );
  });

  it("does not report eager replacement names as hidden by discovery", async () => {
    await withExecutionLifecycleResources(
      "pct-status-eager-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "ps", match: "*", patch: true, shell: true, code: false },
          ],
        };
        config.toolDiscovery.enabled = true;
        config.toolDiscovery.deferred = [
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ];
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const host = fakeHost(resources, { builtinNatives: true, hasUI: true });
        await host.start();
        // The three deferred names are eager replacements: they stay active
        // because they substitute for the hidden natives.
        expect(host.active()).toEqual([
          "read",
          APPLY_PATCH_TOOL,
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
          TOOL_DISCOVERY_TOOL,
        ]);

        const text = await host.status();
        expect(statusSection(text, "Apply Patch:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: active",
          "  reason: ",
        ]);
        expect(statusSection(text, "Shell Sessions:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: active",
          "  reason: ",
        ]);
        // The configured deferred set still counts as managed; the names are
        // simply not hidden while they eagerly replace the natives.
        expect(statusSection(text, "Tool Discovery:")).toContain(
          "  managed deferred tools: 3",
        );
        expect(statusSection(text, "Tool Discovery:")).toContain(
          "  loaded this session: 0",
        );
      },
    );
  });

  it("resolves a candidate status while the first apply has not committed", async () => {
    await withExecutionLifecycleResources(
      "pct-status-candidate-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "p", match: "*", patch: true, shell: false, code: false },
          ],
        };
        await mkdir(join(agentDirectory, "extensions"), { recursive: true });
        await writeFile(
          join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        const host = fakeHost(resources, { builtinNatives: true, hasUI: true });

        // P needs no Shell backend, so the sync's unconditional shell close
        // runs; rejecting it fails the first apply before any commit.
        const realClose = ShellSessionManager.prototype.close;
        ShellSessionManager.prototype.close = (() =>
          Promise.reject(
            new Error("injected close failure"),
          )) as typeof realClose;
        resources.restoreBeforeCleanup.push(() => {
          ShellSessionManager.prototype.close = realClose;
        });
        try {
          await expect(host.start()).rejects.toThrow("injected close failure");
        } finally {
          ShellSessionManager.prototype.close = realClose;
        }

        const text = await host.status();
        // No committed projection exists: the rows and the appended block
        // resolve the candidate routes, and the pending apply error shows.
        expect(statusSection(text, "Apply Patch:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: active",
          "  reason: ",
        ]);
        expect(statusSection(text, "Execution rules:")).toEqual([
          "  schema: rules",
          "  rule: p",
          "  requested: P",
          "  effective: directPatch",
          "  hide bash: no",
          "  hide edit/write: yes",
          "  notes: ",
        ]);
        expect(text.split("\n")).toContain(
          "Apply error: applying the configuration failed during owned-resource cleanup; the previously committed tool projection remains active",
        );

        // A retry commits the candidate; the error line clears.
        await host.select("initial");
        const retried = await host.status();
        expect(statusSection(retried, "Apply Patch:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: active",
          "  reason: ",
        ]);
        expect(retried).not.toContain("Apply error:");
      },
    );
  });

  it("keeps reporting the committed projection after a failed apply", async () => {
    await withExecutionLifecycleResources(
      "pct-status-committed-",
      async (resources) => {
        const agentDirectory = resources.root;
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "s", match: "*", patch: false, shell: true, code: false },
          ],
        };
        const configPath = join(
          agentDirectory,
          "extensions",
          "pi-codex-toolkit.json",
        );
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify(config), "utf8");
        const host = fakeHost(resources, { builtinNatives: true, hasUI: true });
        await host.start();
        expect(host.active()).toEqual([
          "read",
          "edit",
          "write",
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ]);

        // The file now requests nothing; a failed apply must not let status
        // describe that uncommitted candidate.
        const contracted = defaultConfig();
        contracted.execution = {
          version: 1,
          rules: [
            {
              id: "none",
              match: "*",
              patch: false,
              shell: false,
              code: false,
            },
          ],
        };
        await writeFile(configPath, JSON.stringify(contracted), "utf8");
        const realClose = ShellSessionManager.prototype.close;
        ShellSessionManager.prototype.close = (() =>
          Promise.reject(
            new Error("injected close failure"),
          )) as typeof realClose;
        resources.restoreBeforeCleanup.push(() => {
          ShellSessionManager.prototype.close = realClose;
        });
        try {
          await expect(host.command("reload", host.ctx)).rejects.toThrow(
            "injected close failure",
          );
        } finally {
          ShellSessionManager.prototype.close = realClose;
        }

        const text = await host.status();
        expect(statusSection(text, "Shell Sessions:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: active",
          "  reason: ",
        ]);
        expect(statusSection(text, "Execution rules:")).toEqual([
          "  schema: rules",
          "  rule: s",
          "  requested: S",
          "  effective: directShell",
          "  hide bash: yes",
          "  hide edit/write: no",
          "  notes: ",
        ]);
        expect(text.split("\n")).toContain(
          "Apply error: applying the configuration failed during owned-resource cleanup; the previously committed tool projection remains active",
        );
        // The committed projection is still what the host applies.
        expect(host.active()).toEqual([
          "read",
          "edit",
          "write",
          EXEC_COMMAND_TOOL,
          WRITE_STDIN_TOOL,
        ]);

        await host.command("reload", host.ctx);
        const retried = await host.status();
        expect(statusSection(retried, "Shell Sessions:").slice(0, 3)).toEqual([
          "  configured: off",
          "  effective: off",
          "  reason: ",
        ]);
        expect(statusSection(retried, "Execution rules:")).toEqual([
          "  schema: rules",
          "  rule: none",
          "  requested: none",
          "  effective: native",
          "  hide bash: no",
          "  hide edit/write: no",
          "  notes: ",
        ]);
        expect(retried).not.toContain("Apply error:");
        // bash rejoins at the end: a restored builtin appends where the
        // suppressed removal left the projection.
        expect(host.active()).toEqual(["read", "edit", "write", "bash"]);
      },
    );
  });
});
