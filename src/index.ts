import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import type { Tool } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  APPLY_PATCH_TOOL,
  APPLY_PATCH_TOOL_DEFINITION,
} from "./apply-patch.ts";
import { registerCommands } from "./commands.ts";
import {
  ConfigStore,
  type ComputerUseApprovalMode,
  type ToolkitConfig,
} from "./config.ts";
import {
  ComputerUseClient,
  ComputerUseClientError,
  inspectComputerUseRuntime,
  type ComputerUseRuntimeInspection,
} from "./computer-use/app-server-client.ts";
import {
  COMPUTER_USE_TOOLS,
  createComputerUseTools,
} from "./computer-use/tools.ts";
import {
  generateImage,
  type ImageGenerationQuality,
} from "./openai/image-generation.ts";
import {
  inspectCurrentNativeRoute,
  inspectImageExecutor,
  inspectRemoteCompactionRoute,
  inspectSidecarExecutor,
  resolveOfficialRoute,
  resolveSidecarRoute,
} from "./openai/route.ts";
import {
  createRemoteCompaction,
  emitRemoteCompactionDebug,
  newestRemoteCompaction,
  RemoteCompactionError,
  resolveRemoteCompactionIdentity,
} from "./openai/remote-compaction.ts";
import { transformProviderRequest } from "./openai/request-pipeline.ts";
import { dispatchSidecarSearch } from "./openai/sidecar-search.ts";
import {
  formatStatus,
  projectStatus,
  selectComputerUseStatus,
  selectImageGenerationStatus,
  selectWebSearchBackend,
  type Availability,
  type BackendDecision,
  type ComputerUseDecision,
  type ImageGenerationDecision,
} from "./status.ts";

export { COMPUTER_USE_TOOLS } from "./computer-use/tools.ts";
export { APPLY_PATCH_TOOL } from "./apply-patch.ts";

export const WEB_SEARCH_TOOL = "openai_web_search";
export const IMAGE_GENERATION_TOOL = "openai_generate_image";
const EXTENSION_SOURCE_PATH = fileURLToPath(import.meta.url);

export function getConfigPath(): string {
  return join(getAgentDir(), "extensions", "pi-codex-toolkit.json");
}

function availability(
  inspection: { ok: true } | { ok: false; reason: Availability["reason"] },
): Availability {
  return inspection.ok
    ? { ok: true }
    : { ok: false, reason: inspection.reason };
}

function activeToolSchemas(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
): Tool[] {
  const active = new Set(pi.getActiveTools());
  return pi
    .getAllTools()
    .filter((tool) => active.has(tool.name))
    .map((tool) => {
      const isOwnedApplyPatch =
        tool.name === APPLY_PATCH_TOOL &&
        resolve(tool.sourceInfo.path) === resolve(EXTENSION_SOURCE_PATH);
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(isOwnedApplyPatch && APPLY_PATCH_TOOL_DEFINITION.constrainedSampling
          ? {
              constrainedSampling:
                APPLY_PATCH_TOOL_DEFINITION.constrainedSampling,
            }
          : {}),
      };
    });
}

export function runtimeDecision(
  config: ToolkitConfig,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
): BackendDecision {
  const native = inspectCurrentNativeRoute(ctx.model, ctx.modelRegistry);
  const sidecar = inspectSidecarExecutor(
    config.webSearch.sidecarModel,
    ctx.modelRegistry,
  );
  return selectWebSearchBackend(
    config.webSearch,
    ctx.model !== undefined,
    availability(native),
    availability(sidecar),
  );
}

export function runtimeImageGenerationDecision(
  config: ToolkitConfig,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
): ImageGenerationDecision {
  if (!config.imageGeneration.enabled) {
    return { effective: "off" };
  }
  if (!ctx.model) {
    return selectImageGenerationStatus(config.imageGeneration, false, {
      ok: false,
      reason: "missing-openai-auth",
    });
  }
  const inspection = inspectImageExecutor(ctx.model, ctx.modelRegistry);
  return selectImageGenerationStatus(
    config.imageGeneration,
    true,
    inspection.ok
      ? { ok: true, backend: inspection.route.kind }
      : { ok: false, reason: inspection.reason },
  );
}

export function runtimeComputerUseDecision(
  config: ToolkitConfig,
  ctx: Pick<ExtensionContext, "model"> &
    Partial<Pick<ExtensionContext, "hasUI">>,
  inspection: ComputerUseRuntimeInspection = inspectComputerUseRuntime(),
  platform: NodeJS.Platform = process.platform,
): ComputerUseDecision {
  return selectComputerUseStatus(config.computerUse, {
    isMac: platform === "darwin",
    hasUI: ctx.hasUI === true,
    currentModelPresent: ctx.model !== undefined,
    modelHasImageInput: ctx.model?.input.includes("image") ?? false,
    runtime: inspection,
  });
}

function ownedToolConflict(
  tools: ReturnType<ExtensionAPI["getAllTools"]>,
  toolName: string,
  sourcePath: string,
): boolean {
  const winner = tools.find((tool) => tool.name === toolName);
  return !winner || resolve(winner.sourceInfo.path) !== resolve(sourcePath);
}

export function syncOwnedTool(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "setActiveTools">,
  config: ToolkitConfig,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry"> &
    Partial<Pick<ExtensionContext, "hasUI">>,
  sourcePath = EXTENSION_SOURCE_PATH,
  computerUseRuntime: {
    inspection?: ComputerUseRuntimeInspection;
    platform?: NodeJS.Platform;
  } = {},
): {
  decision: BackendDecision;
  conflict: boolean;
  imageDecision: ImageGenerationDecision;
  imageConflict: boolean;
  applyPatchConflict: boolean;
  computerUseDecision: ComputerUseDecision;
  computerUseConflict: boolean;
} {
  const decision = runtimeDecision(config, ctx);
  const imageDecision = runtimeImageGenerationDecision(config, ctx);
  const computerUseDecision = runtimeComputerUseDecision(
    config,
    ctx,
    computerUseRuntime.inspection,
    computerUseRuntime.platform,
  );
  const active = pi.getActiveTools();
  const tools = pi.getAllTools();
  const conflict = ownedToolConflict(tools, WEB_SEARCH_TOOL, sourcePath);
  const imageConflict = ownedToolConflict(
    tools,
    IMAGE_GENERATION_TOOL,
    sourcePath,
  );
  const applyPatchConflict = ownedToolConflict(
    tools,
    APPLY_PATCH_TOOL,
    sourcePath,
  );
  const computerUseConflicts = COMPUTER_USE_TOOLS.map((name) =>
    ownedToolConflict(tools, name, sourcePath),
  );
  const computerUseConflict = computerUseConflicts.some(Boolean);
  const desired = new Set(active);

  if (!conflict) {
    if (decision.effective === "sidecar") desired.add(WEB_SEARCH_TOOL);
    else desired.delete(WEB_SEARCH_TOOL);
  }
  if (!imageConflict) {
    if (imageDecision.effective === "active") {
      desired.add(IMAGE_GENERATION_TOOL);
    } else {
      desired.delete(IMAGE_GENERATION_TOOL);
    }
  }
  if (!applyPatchConflict) {
    if (config.applyPatch.enabled) desired.add(APPLY_PATCH_TOOL);
    else desired.delete(APPLY_PATCH_TOOL);
  }
  for (const [index, name] of COMPUTER_USE_TOOLS.entries()) {
    if (computerUseConflicts[index]) continue;
    if (!computerUseConflict && computerUseDecision.effective === "active") {
      desired.add(name);
    } else {
      desired.delete(name);
    }
  }

  const next = [...desired];
  if (
    next.length !== active.length ||
    next.some((name, index) => name !== active[index])
  ) {
    pi.setActiveTools(next);
  }
  return {
    decision,
    conflict,
    imageDecision,
    imageConflict,
    applyPatchConflict,
    computerUseDecision,
    computerUseConflict,
  };
}

export default function piCodexToolkit(pi: ExtensionAPI): void {
  const store = new ConfigStore(getConfigPath());
  let computerUseClient: ComputerUseClient | undefined;
  let computerUseClientApprovalMode: ComputerUseApprovalMode | undefined;

  const closeComputerUseClient = async (): Promise<void> => {
    const client = computerUseClient;
    computerUseClient = undefined;
    computerUseClientApprovalMode = undefined;
    await client?.close();
  };
  const sync = async (ctx: ExtensionContext): Promise<void> => {
    const state = syncOwnedTool(pi, store.snapshot.config, ctx);
    if (
      state.computerUseDecision.effective !== "active" ||
      state.computerUseConflict ||
      (computerUseClient !== undefined &&
        computerUseClientApprovalMode !==
          store.snapshot.config.computerUse.approvalMode)
    ) {
      await closeComputerUseClient();
    }
  };
  const status = async (ctx: ExtensionContext): Promise<string> => {
    const decision = runtimeDecision(store.snapshot.config, ctx);
    const imageGenerationDecision = runtimeImageGenerationDecision(
      store.snapshot.config,
      ctx,
    );
    const tools = pi.getAllTools();
    const conflict = ownedToolConflict(
      tools,
      WEB_SEARCH_TOOL,
      EXTENSION_SOURCE_PATH,
    );
    const imageToolConflict = ownedToolConflict(
      tools,
      IMAGE_GENERATION_TOOL,
      EXTENSION_SOURCE_PATH,
    );
    const applyPatchToolConflict = ownedToolConflict(
      tools,
      APPLY_PATCH_TOOL,
      EXTENSION_SOURCE_PATH,
    );
    const computerUseToolConflict = COMPUTER_USE_TOOLS.some((name) =>
      ownedToolConflict(tools, name, EXTENSION_SOURCE_PATH),
    );
    const computerUseInspection = inspectComputerUseRuntime();
    let computerUseDecision = runtimeComputerUseDecision(
      store.snapshot.config,
      ctx,
      computerUseInspection,
    );
    if (
      computerUseDecision.effective === "active" &&
      !computerUseToolConflict &&
      computerUseInspection.ok
    ) {
      const probe = new ComputerUseClient({
        runtime: computerUseInspection.runtime,
      });
      try {
        await probe.probeTarget(ctx.signal);
      } catch (error) {
        computerUseDecision = {
          effective: "unavailable",
          reason:
            error instanceof ComputerUseClientError &&
            error.category === "incompatible-sky-target"
              ? "incompatible-sky-target"
              : "node-repl-unavailable",
        };
      } finally {
        await probe.close();
      }
    }
    const searchPathConflict =
      store.snapshot.config.webSearch.enabled &&
      pi.getActiveTools().includes("web_search");
    return formatStatus(
      projectStatus({
        config: store.snapshot.config,
        configPath: store.path,
        configError: store.snapshot.readError,
        currentModel: ctx.model,
        decision,
        imageGenerationDecision,
        computerUseDecision,
        remoteCompactionAvailability: availability(
          inspectRemoteCompactionRoute(ctx.model, ctx.modelRegistry),
        ),
        toolConflict: conflict,
        imageToolConflict,
        applyPatchToolConflict,
        computerUseToolConflict,
        searchPathConflict,
      }),
    );
  };

  pi.registerTool({
    name: WEB_SEARCH_TOOL,
    label: "OpenAI Web Search",
    description:
      "Search the web through the configured OpenAI Responses sidecar and return an answer with sources.",
    parameters: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          description: "The complete search query to send verbatim.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const decision = runtimeDecision(store.snapshot.config, ctx);
      if (decision.effective !== "sidecar") {
        throw new Error(
          "OpenAI Web Search is not active for the current model.",
        );
      }

      const route = await resolveSidecarRoute(
        ctx.modelRegistry,
        store.snapshot.config.webSearch.sidecarModel,
      );
      if (!route.ok) {
        throw new Error(`OpenAI Web Search is unavailable: ${route.reason}.`);
      }
      const provider =
        route.value.route.kind === "codex-oauth"
          ? ctx.modelRegistry.getProvider(route.value.model.provider)
          : undefined;

      const result = await dispatchSidecarSearch({
        query: params.query,
        config: store.snapshot.config.webSearch,
        route: route.value,
        thinkingLevel:
          store.snapshot.config.webSearch.sidecarModel?.thinkingLevel ?? "auto",
        provider,
        signal,
        debug: store.snapshot.config.debug,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: { answer: result.answer, sources: result.sources },
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
  });

  pi.registerTool({
    name: IMAGE_GENERATION_TOOL,
    label: "OpenAI Image Generation",
    description:
      "Generate one image with OpenAI, save the original PNG, and return it as a Pi image result.",
    parameters: Type.Object(
      {
        prompt: Type.String({
          minLength: 1,
          description: "The image prompt to send verbatim.",
        }),
        size: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Optional image dimensions accepted by OpenAI.",
          }),
        ),
        quality: Type.Optional(
          Type.Union([
            Type.Literal("auto"),
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
          ]),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      if (!store.snapshot.config.imageGeneration.enabled || !ctx.model) {
        throw new Error(
          "OpenAI Image Generation is not active for the current model.",
        );
      }

      const executor = inspectImageExecutor(ctx.model, ctx.modelRegistry);
      if (!executor.ok) {
        throw new Error(
          `OpenAI Image Generation is unavailable: ${executor.reason}.`,
        );
      }
      const route = await resolveOfficialRoute(
        ctx.modelRegistry,
        executor.model,
      ).catch(() => ({
        ok: false as const,
        reason: "missing-openai-auth" as const,
      }));
      if (!route.ok) {
        throw new Error(
          `OpenAI Image Generation is unavailable: ${route.reason}.`,
        );
      }

      const result = await generateImage({
        prompt: params.prompt,
        size: params.size,
        quality: params.quality as ImageGenerationQuality | undefined,
        toolCallId,
        route: route.value,
        signal,
        debug: store.snapshot.config.debug,
      });
      const inspectionNote = ctx.model.input.includes("image")
        ? ""
        : " The current model cannot visually inspect this image.";
      return {
        content: [
          {
            type: "text",
            text: `Generated image saved to ${result.path}.${inspectionNote}`,
          },
          { type: "image", data: result.data, mimeType: result.mimeType },
        ],
        details: { path: result.path, mimeType: result.mimeType },
      };
    },
  });

  pi.registerTool(APPLY_PATCH_TOOL_DEFINITION);

  for (const tool of createComputerUseTools(
    async (method, args, signal, ctx) => {
      const inspection = inspectComputerUseRuntime();
      const decision = runtimeComputerUseDecision(
        store.snapshot.config,
        ctx,
        inspection,
      );
      if (decision.effective !== "active" || !inspection.ok) {
        throw new Error("Computer Use is not active for the current session.");
      }

      if (!computerUseClient || computerUseClient.isClosed) {
        computerUseClient = new ComputerUseClient({
          runtime: inspection.runtime,
        });
        computerUseClientApprovalMode =
          store.snapshot.config.computerUse.approvalMode;
      }
      const approvalMode = store.snapshot.config.computerUse.approvalMode;
      return computerUseClient.invoke(
        method,
        args,
        signal,
        approvalMode === "always"
          ? async () => true
          : ctx.hasUI
            ? (message) =>
                ctx.ui.confirm("Computer Use access", message, { signal })
            : undefined,
      );
    },
  )) {
    pi.registerTool(tool);
  }

  registerCommands(pi, { store, sync, status });

  pi.on("session_start", async (_event, ctx) => {
    await store.load();
    await sync(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    await sync(ctx);
  });
  pi.on("session_shutdown", async () => {
    await closeComputerUseClient();
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const config = store.snapshot.config;
    const fallback = (reason: string): undefined => {
      if (config.debug) {
        emitRemoteCompactionDebug({
          outcome: "native-fallback",
          provider: ctx.model?.provider,
          api: ctx.model?.api,
          model: ctx.model?.id,
          reason,
        });
      }
      return undefined;
    };

    if (!config.remoteCompaction.enabled) return fallback("disabled");
    if (event.customInstructions !== undefined) {
      return fallback("custom-instructions");
    }
    const inspection = inspectRemoteCompactionRoute(
      ctx.model,
      ctx.modelRegistry,
    );
    if (!inspection.ok) return fallback(inspection.reason);
    if (!ctx.model) return fallback("current-model-missing");
    const provider = ctx.modelRegistry.getProvider(ctx.model.provider);
    if (!provider) return fallback("provider-unavailable");

    try {
      const route = await resolveOfficialRoute(ctx.modelRegistry, ctx.model);
      if (!route.ok) return fallback(route.reason);
      const identity = resolveRemoteCompactionIdentity(route.value);
      if (!identity) return fallback("missing-account-claim");
      const compaction = await createRemoteCompaction({
        provider,
        route: route.value,
        identity,
        preparation: event.preparation,
        branchEntries: event.branchEntries,
        systemPrompt: ctx.getSystemPrompt(),
        tools: activeToolSchemas(pi),
        signal: event.signal,
        debug: config.debug,
      });
      return compaction ? { compaction } : fallback("preparation-unavailable");
    } catch (error) {
      if (config.debug && !(error instanceof RemoteCompactionError)) {
        emitRemoteCompactionDebug({
          outcome: "remote-failure",
          provider: ctx.model.provider,
          api: ctx.model.api,
          model: ctx.model.id,
          errorCategory: "hook-error",
        });
      }
      return undefined;
    }
  });
  pi.on("before_provider_request", async (event, ctx) => {
    const decision = runtimeDecision(store.snapshot.config, ctx);
    const details = store.snapshot.config.remoteCompaction.enabled
      ? newestRemoteCompaction(ctx.sessionManager.getBranch())
      : undefined;
    let compatibility;
    if (details || decision.effective === "native") {
      if (!ctx.model) return undefined;
      try {
        const route = await resolveOfficialRoute(ctx.modelRegistry, ctx.model);
        if (!route.ok) return undefined;
        compatibility = resolveRemoteCompactionIdentity(
          route.value,
        )?.compatibility;
      } catch {
        return undefined;
      }
    }
    const transformed = transformProviderRequest(
      event.payload,
      store.snapshot.config.webSearch,
      decision,
      { details, compatibility },
    );
    return transformed === event.payload ? undefined : transformed;
  });
}
