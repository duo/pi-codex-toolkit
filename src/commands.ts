import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";

import {
  cloneConfig,
  type ConfigStore,
  type ModelReference,
  type SearchContextSize,
  type SearchExecutorThinkingLevel,
  type WebSearchBackend,
  type WebSearchMode,
} from "./config.ts";
import { inspectOfficialRoute } from "./openai/route.ts";

interface SidecarCandidate {
  model: Model<any>;
  reference: ModelReference;
}

interface CommandDependencies {
  store: ConfigStore;
  sync(ctx: ExtensionCommandContext): Promise<void> | void;
  status(ctx: ExtensionCommandContext): string | Promise<string>;
  stderr?: (message: string) => void;
}

function sidecarCandidates(ctx: ExtensionCommandContext): SidecarCandidate[] {
  const available = ctx.modelRegistry.getAvailable();
  const models =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels.map((entry) => entry.model)
      : available;

  return models.flatMap((model) => {
    if (
      !available.some(
        (candidate) =>
          candidate.provider === model.provider && candidate.id === model.id,
      )
    ) {
      return [];
    }
    const route = inspectOfficialRoute(model);
    if (!route.ok) {
      return [];
    }
    const usesOAuth = ctx.modelRegistry.isUsingOAuth(model);
    if ((route.route.kind === "codex-oauth") !== usesOAuth) return [];
    return [
      {
        model,
        reference: {
          provider: model.provider as ModelReference["provider"],
          model: model.id,
          thinkingLevel: "auto" as const,
        },
      },
    ];
  });
}

function executorEfforts(
  candidate: SidecarCandidate,
): readonly SearchExecutorThinkingLevel[] {
  return candidate.reference.provider === "openai-codex"
    ? ["auto", ...getSupportedThinkingLevels(candidate.model)]
    : ["auto"];
}

async function selectValue<T extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  values: readonly T[],
): Promise<T | undefined> {
  return (await ctx.ui.select(title, [...values])) as T | undefined;
}

async function configure(
  ctx: ExtensionCommandContext,
  dependencies: CommandDependencies,
): Promise<void> {
  const stderr = dependencies.stderr ?? console.error;
  if (!ctx.hasUI) {
    stderr(`Pi Codex Toolkit config: ${dependencies.store.path}`);
    return;
  }

  const config = cloneConfig(dependencies.store.snapshot.config);
  while (true) {
    const choice = await ctx.ui.select("Pi Codex Toolkit", [
      `Web Search: ${config.webSearch.enabled ? "on" : "off"}`,
      `Backend: ${config.webSearch.backend}`,
      `Mode: ${config.webSearch.mode}`,
      `Context size: ${config.webSearch.contextSize}`,
      `Web Search executor: ${config.webSearch.sidecarModel ? `${config.webSearch.sidecarModel.provider}/${config.webSearch.sidecarModel.model}` : "none"}`,
      `Web Search executor effort: ${config.webSearch.sidecarModel?.thinkingLevel ?? "-"}`,
      `Remote Compaction: ${config.remoteCompaction.enabled ? "on" : "off"}`,
      `Image Generation: ${config.imageGeneration.enabled ? "on" : "off"}`,
      `Apply Patch: ${config.applyPatch.enabled ? "on" : "off"}`,
      `Computer Use: ${config.computerUse.enabled ? "on" : "off"}`,
      `Computer Use approval: ${config.computerUse.approvalMode === "confirm" ? "Confirm" : "Always"}`,
      `Debug metadata: ${config.debug ? "on" : "off"}`,
      "Save",
      "Cancel",
    ]);
    if (choice === undefined || choice === "Cancel") return;

    if (choice.startsWith("Web Search:")) {
      config.webSearch.enabled = !config.webSearch.enabled;
    } else if (choice.startsWith("Backend:")) {
      const value = await selectValue<WebSearchBackend>(ctx, "Backend", [
        "auto",
        "native",
        "sidecar",
      ]);
      if (value) config.webSearch.backend = value;
    } else if (choice.startsWith("Mode:")) {
      const value = await selectValue<WebSearchMode>(ctx, "Mode", [
        "live",
        "cached",
      ]);
      if (value) config.webSearch.mode = value;
    } else if (choice.startsWith("Context size:")) {
      const value = await selectValue<SearchContextSize>(ctx, "Context size", [
        "low",
        "medium",
        "high",
      ]);
      if (value) config.webSearch.contextSize = value;
    } else if (choice.startsWith("Web Search executor:")) {
      const candidates = sidecarCandidates(ctx);
      const labels = [
        "None",
        ...candidates.map(
          (candidate) =>
            `${candidate.reference.provider}/${candidate.reference.model}`,
        ),
      ];
      const selected = await ctx.ui.select("Web Search executor", labels);
      if (selected === "None") {
        config.webSearch.sidecarModel = null;
      } else if (selected) {
        config.webSearch.sidecarModel =
          candidates[labels.indexOf(selected) - 1]?.reference ?? null;
      }
    } else if (choice.startsWith("Web Search executor effort:")) {
      if (!config.webSearch.sidecarModel) continue;
      const selectedModel = sidecarCandidates(ctx).find(
        (candidate) =>
          candidate.reference.provider ===
            config.webSearch.sidecarModel?.provider &&
          candidate.reference.model === config.webSearch.sidecarModel.model,
      );
      if (!selectedModel) continue;
      const value = await selectValue<SearchExecutorThinkingLevel>(
        ctx,
        "Web Search executor effort",
        executorEfforts(selectedModel),
      );
      if (value) {
        config.webSearch.sidecarModel.thinkingLevel = value;
      }
    } else if (choice.startsWith("Remote Compaction:")) {
      config.remoteCompaction.enabled = !config.remoteCompaction.enabled;
    } else if (choice.startsWith("Image Generation:")) {
      config.imageGeneration.enabled = !config.imageGeneration.enabled;
    } else if (choice.startsWith("Apply Patch:")) {
      config.applyPatch.enabled = !config.applyPatch.enabled;
    } else if (choice.startsWith("Computer Use:")) {
      config.computerUse.enabled = !config.computerUse.enabled;
    } else if (choice.startsWith("Computer Use approval:")) {
      const value = await selectValue<"Confirm" | "Always">(
        ctx,
        "Computer Use approval",
        ["Confirm", "Always"],
      );
      if (value) {
        config.computerUse.approvalMode =
          value === "Confirm" ? "confirm" : "always";
      }
    } else if (choice.startsWith("Debug metadata:")) {
      config.debug = !config.debug;
    } else if (choice === "Save") {
      try {
        await dependencies.store.save(config);
      } catch {
        ctx.ui.notify(
          "Could not save Pi Codex Toolkit configuration; the existing file was left untouched.",
          "error",
        );
        return;
      }
      await dependencies.sync(ctx);
      ctx.ui.notify("Pi Codex Toolkit configuration saved.", "info");
      return;
    }
  }
}

export function registerCommands(
  pi: Pick<ExtensionAPI, "registerCommand">,
  dependencies: CommandDependencies,
): void {
  const stderr = dependencies.stderr ?? console.error;
  pi.registerCommand("pct", {
    description: "Configure or inspect Pi Codex Toolkit",
    handler: async (args, ctx) => {
      const command = args.trim() || "config";
      if (command === "config") {
        await configure(ctx, dependencies);
        return;
      }
      if (command === "status") {
        const message = await dependencies.status(ctx);
        if (ctx.hasUI) ctx.ui.notify(message, "info");
        else stderr(message);
        return;
      }
      if (command === "reload") {
        const snapshot = await dependencies.store.load();
        await dependencies.sync(ctx);
        const message = snapshot.readError
          ? `Pi Codex Toolkit config error: ${snapshot.readError}; using last known good settings.`
          : "Pi Codex Toolkit configuration reloaded.";
        if (ctx.hasUI) {
          ctx.ui.notify(message, snapshot.readError ? "warning" : "info");
        } else {
          stderr(message);
        }
        return;
      }

      const usage = "Usage: /pct [config|status|reload]";
      if (ctx.hasUI) ctx.ui.notify(usage, "warning");
      else stderr(usage);
    },
  });
}
