import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { afterEach, describe, expect, it, vi } from "vitest";

import piCodexToolkit, {
  APPLY_PATCH_TOOL,
  COMPUTER_USE_TOOLS,
  IMAGE_GENERATION_TOOL,
  syncOwnedTool,
  WEB_SEARCH_TOOL,
} from "../src/index.ts";
import { defaultConfig } from "../src/config.ts";
import { inspectRemoteCompactionRoute } from "../src/openai/route.ts";
import { codexModel, otherModel, model } from "./fixtures.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

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
      const getApiKeyAndHeaders = vi.fn(async (_candidate: typeof current) => {
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

      piCodexToolkit(pi);
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
        "OpenAI Image Generation is unavailable: missing-openai-auth.",
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
      expect(getApiKeyAndHeaders).toHaveBeenCalledTimes(3);
      expect(
        getApiKeyAndHeaders.mock.calls.map(([candidate]) => candidate.id),
      ).toEqual([current.id, current.id, current.id]);

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

    piCodexToolkit(pi);

    expect([...tools.keys()]).toEqual([
      WEB_SEARCH_TOOL,
      IMAGE_GENERATION_TOOL,
      APPLY_PATCH_TOOL,
      ...COMPUTER_USE_TOOLS,
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

      piCodexToolkit(pi);
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
