import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";

import {
  cloneConfig,
  ConfigSaveError,
  ConfigValidationError,
  type ConfigStore,
  type ModelReference,
  type SearchContextSize,
  type SearchExecutorThinkingLevel,
  type WebSearchBackend,
  type WebSearchMode,
} from "./config.ts";
import {
  editExecutionRules,
  executionRulesMenuLabel,
} from "./execution-editor.ts";
import {
  EXECUTION_SCHEMA_VERSION,
  formatRequestedFlags,
  previewLegacyMigration,
  type ExecutionRule,
} from "./execution-mode.ts";
import { inspectOfficialRoute } from "./openai/route.ts";

interface SidecarCandidate {
  model: Model<any>;
  reference: ModelReference;
}

interface CommandDependencies {
  store: ConfigStore;
  sync(ctx: ExtensionCommandContext): Promise<void> | void;
  status(ctx: ExtensionCommandContext): string | Promise<string>;
  /**
   * Effective-route preview for a rules draft against the live model and
   * admission state; the editor itself owns no admission data.
   */
  describeExecutionPreview(
    rules: readonly ExecutionRule[],
    ctx: ExtensionCommandContext,
  ): string;
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

/**
 * The message for a failed configuration read, shared by `/pct reload` and the
 * session-start warning; `undefined` when the last read succeeded. The detail is
 * fixed text or a Node error code, never a configured value.
 */
export function configReadErrorMessage(
  store: Pick<ConfigStore, "snapshot" | "hasLastKnownGood">,
): string | undefined {
  const { readError, readErrorDetail } = store.snapshot;
  if (!readError) return undefined;
  const error = readErrorDetail
    ? `${readError} (${readErrorDetail})`
    : readError;
  const settings = store.hasLastKnownGood
    ? "last known good settings"
    : "all-off defaults";
  return `Pi Codex Toolkit config error: ${error}; using ${settings}.`;
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
  const expectedRevision = dependencies.store.revision;
  let rulesDraft: ExecutionRule[] | undefined = config.execution
    ? config.execution.rules.map((rule) => ({ ...rule }))
    : undefined;
  while (true) {
    const rulesLabel =
      rulesDraft !== undefined || config.execution
        ? executionRulesMenuLabel(rulesDraft ?? config.execution?.rules ?? [])
        : config.applyPatch.enabled ||
            config.shellSessions.enabled ||
            config.codeMode.enabled
          ? "Execution rules: legacy flags (open to migrate)"
          : "Execution rules: none (native baseline)";
    const choice = await ctx.ui.select("Pi Codex Toolkit", [
      `Web Search: ${config.webSearch.enabled ? "on" : "off"}`,
      `Backend: ${config.webSearch.backend}`,
      `Mode: ${config.webSearch.mode}`,
      `Context size: ${config.webSearch.contextSize}`,
      `Web Search executor: ${config.webSearch.sidecarModel ? `${config.webSearch.sidecarModel.provider}/${config.webSearch.sidecarModel.model}` : "none"}`,
      `Web Search executor effort: ${config.webSearch.sidecarModel?.thinkingLevel ?? "-"}`,
      `Remote Compaction: ${config.remoteCompaction.enabled ? "on" : "off"}`,
      `Image Generation: ${config.imageGeneration.enabled ? "on" : "off"}`,
      `Computer Use: ${config.computerUse.enabled ? "on" : "off"}`,
      `Computer Use approval: ${config.computerUse.approvalMode === "confirm" ? "Confirm" : "Always"}`,
      rulesLabel,
      `Code Mode nested Apply Patch confirmation: ${config.codeMode.approvalMode === "confirm" ? "Confirm" : "Always"}`,
      `Tool Discovery: ${config.toolDiscovery.enabled ? "on" : "off"}`,
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
    } else if (choice.startsWith("Execution rules:")) {
      // A legacy file's migration is this page's draft, not a decision the
      // menu has already taken: it is previewed here, and only leaving the
      // page with `Back` adopts it.
      let page = rulesDraft;
      if (page === undefined) {
        page = previewLegacyMigration({
          patch: config.applyPatch.enabled,
          shell: config.shellSessions.enabled,
          code: config.codeMode.enabled,
        });
        const migrated = page[0];
        ctx.ui.notify(
          migrated === undefined
            ? "Save will store an empty rule list (native baseline) and remove the legacy Apply Patch / Shell / Code switches."
            : `Save will store one catch-all rule ${migrated.id} (${formatRequestedFlags(
                {
                  patch: migrated.patch,
                  shell: migrated.shell,
                  code: migrated.code,
                  source: "rules",
                  ruleId: migrated.id,
                },
              )}) and remove the legacy enabled flags. Code-only also starts the nested Shell backend.`,
          "info",
        );
      }
      const edited = await editExecutionRules(
        ctx,
        page,
        dependencies.describeExecutionPreview,
      );
      // Escape out of the rule page discards that page's changes, including a
      // migration draft this open seeded: a legacy file stays legacy until the
      // page is left with `Back` and the menu is saved.
      if (edited) rulesDraft = edited;
    } else if (
      choice.startsWith("Code Mode nested Apply Patch confirmation:")
    ) {
      const value = await selectValue<"Confirm" | "Always">(
        ctx,
        "Code Mode nested Apply Patch confirmation",
        ["Confirm", "Always"],
      );
      if (value) {
        config.codeMode.approvalMode =
          value === "Confirm" ? "confirm" : "always";
      }
    } else if (choice.startsWith("Tool Discovery:")) {
      // The deferred list is file-level configuration; the menu only toggles
      // discovery itself.
      config.toolDiscovery.enabled = !config.toolDiscovery.enabled;
    } else if (choice.startsWith("Debug metadata:")) {
      config.debug = !config.debug;
    } else if (choice === "Save") {
      if (rulesDraft) {
        config.execution = {
          version: EXECUTION_SCHEMA_VERSION,
          rules: rulesDraft,
        };
      }
      try {
        await dependencies.store.save(config, { expectedRevision });
      } catch (error) {
        // A rejected save — stale revision, held lock, or a draft that fails
        // validation — keeps the editor open with the draft intact and shows
        // the actionable message.
        if (
          error instanceof ConfigSaveError ||
          error instanceof ConfigValidationError
        ) {
          ctx.ui.notify(error.message, "error");
          continue;
        }
        ctx.ui.notify(
          "Could not save Pi Codex Toolkit configuration; the existing file was left untouched.",
          "error",
        );
        return;
      }
      try {
        await dependencies.sync(ctx);
      } catch (error) {
        ctx.ui.notify(
          "Pi Codex Toolkit configuration saved, but applying it failed. Reload or retry; the file was written.",
          "error",
        );
        throw error;
      }
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
        await dependencies.store.load();
        await dependencies.sync(ctx);
        const warning = configReadErrorMessage(dependencies.store);
        const message = warning ?? "Pi Codex Toolkit configuration reloaded.";
        if (ctx.hasUI) {
          ctx.ui.notify(message, warning ? "warning" : "info");
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
