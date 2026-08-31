import type { Model } from "@earendil-works/pi-ai";

import type { ToolkitConfig } from "./config.ts";
import type {
  ComputerUseRuntimeInspection,
  ComputerUseRuntimeUnavailableReason,
} from "./computer-use/app-server-client.ts";
import type { RouteUnavailableReason } from "./openai/route.ts";

export type WebSearchUnavailableReason =
  | RouteUnavailableReason
  | "current-model-missing"
  | "conflicting-tool-name";

export type ImageGenerationUnavailableReason =
  | RouteUnavailableReason
  | "current-model-missing"
  | "conflicting-tool-name";

export type ComputerUseUnavailableReason =
  | ComputerUseRuntimeUnavailableReason
  | "unsupported-platform"
  | "no-interactive-ui"
  | "current-model-missing"
  | "model-has-no-image-input"
  | "conflicting-tool-name"
  | "node-repl-unavailable"
  | "incompatible-sky-target";

export type BackendDecision =
  | { effective: "off" }
  | { effective: "native" }
  | { effective: "sidecar" }
  | { effective: "unavailable"; reason: WebSearchUnavailableReason };

export type ImageGenerationDecision =
  | { effective: "off" }
  | { effective: "active"; backend: "codex-oauth" | "api-key" }
  | { effective: "unavailable"; reason: ImageGenerationUnavailableReason };

export type ComputerUseDecision =
  | { effective: "off" }
  | { effective: "active"; transport: "node-repl" }
  | { effective: "unavailable"; reason: ComputerUseUnavailableReason };

export interface Availability {
  ok: boolean;
  reason?: RouteUnavailableReason;
}

export interface WebSearchStatus {
  configured: "on" | "off";
  effective: "active" | "unavailable" | "off";
  requestedBackend: ToolkitConfig["webSearch"]["backend"];
  effectiveBackend: "native" | "sidecar" | "unavailable" | "off";
  executor: string;
  executorEffort: string;
  reason: string;
}

export interface RemoteCompactionStatus {
  configured: "on" | "off";
  effective: "active" | "unavailable" | "off";
  reason: string;
}

export interface ImageGenerationStatus {
  configured: "on" | "off";
  effective: "active" | "unavailable" | "off";
  backend: "codex-oauth" | "api-key" | "—";
  reason: string;
}

export interface ApplyPatchStatus {
  configured: "on" | "off";
  effective: "active" | "unavailable" | "off";
  reason: "conflicting-tool-name" | "";
}

export interface ComputerUseStatus {
  configured: "on" | "off";
  effective: "active" | "unavailable" | "off";
  transport: "node-repl" | "—";
  reason: string;
}

export interface ToolkitStatus {
  configPath: string;
  configError?: string;
  currentModel: string;
  currentApi: string;
  webSearch: WebSearchStatus;
  remoteCompaction: RemoteCompactionStatus;
  imageGeneration: ImageGenerationStatus;
  applyPatch: ApplyPatchStatus;
  computerUse: ComputerUseStatus;
}

export function selectComputerUseStatus(
  config: ToolkitConfig["computerUse"],
  input: {
    isMac: boolean;
    hasUI: boolean;
    currentModelPresent: boolean;
    modelHasImageInput: boolean;
    runtime: ComputerUseRuntimeInspection;
  },
): ComputerUseDecision {
  if (!config.enabled) return { effective: "off" };
  if (!input.isMac) {
    return { effective: "unavailable", reason: "unsupported-platform" };
  }
  if (!input.hasUI) {
    return { effective: "unavailable", reason: "no-interactive-ui" };
  }
  if (!input.currentModelPresent) {
    return { effective: "unavailable", reason: "current-model-missing" };
  }
  if (!input.modelHasImageInput) {
    return {
      effective: "unavailable",
      reason: "model-has-no-image-input",
    };
  }
  if (!input.runtime.ok) {
    return { effective: "unavailable", reason: input.runtime.reason };
  }
  return { effective: "active", transport: "node-repl" };
}

export function selectImageGenerationStatus(
  config: ToolkitConfig["imageGeneration"],
  currentModelPresent: boolean,
  availability:
    | { ok: true; backend: "codex-oauth" | "api-key" }
    | { ok: false; reason: RouteUnavailableReason },
): ImageGenerationDecision {
  if (!config.enabled) return { effective: "off" };
  if (!currentModelPresent) {
    return { effective: "unavailable", reason: "current-model-missing" };
  }
  return availability.ok
    ? { effective: "active", backend: availability.backend }
    : { effective: "unavailable", reason: availability.reason };
}

export function selectRemoteCompactionStatus(
  config: ToolkitConfig["remoteCompaction"],
  currentModelPresent: boolean,
  availability: Availability,
): Pick<RemoteCompactionStatus, "effective" | "reason"> {
  if (!config.enabled) return { effective: "off", reason: "" };
  if (!currentModelPresent) {
    return { effective: "unavailable", reason: "current-model-missing" };
  }
  return availability.ok
    ? { effective: "active", reason: "" }
    : {
        effective: "unavailable",
        reason: availability.reason ?? "unsupported-provider",
      };
}

export function selectWebSearchBackend(
  config: ToolkitConfig["webSearch"],
  currentModelPresent: boolean,
  native: Availability,
  sidecar: Availability,
): BackendDecision {
  if (!config.enabled) return { effective: "off" };
  if (!currentModelPresent) {
    return { effective: "unavailable", reason: "current-model-missing" };
  }

  if (config.backend === "native") {
    return native.ok
      ? { effective: "native" }
      : {
          effective: "unavailable",
          reason: native.reason ?? "unsupported-provider",
        };
  }

  if (config.backend === "sidecar") {
    return sidecar.ok
      ? { effective: "sidecar" }
      : {
          effective: "unavailable",
          reason: sidecar.reason ?? "missing-sidecar-model",
        };
  }

  if (native.ok) return { effective: "native" };
  if (sidecar.ok) return { effective: "sidecar" };
  return {
    effective: "unavailable",
    reason: sidecar.reason ?? native.reason ?? "missing-sidecar-model",
  };
}

export function projectStatus(input: {
  config: ToolkitConfig;
  configPath: string;
  configError?: string;
  currentModel?: Model<any>;
  decision: BackendDecision;
  imageGenerationDecision: ImageGenerationDecision;
  computerUseDecision: ComputerUseDecision;
  remoteCompactionAvailability: Availability;
  toolConflict: boolean;
  imageToolConflict: boolean;
  applyPatchToolConflict: boolean;
  computerUseToolConflict: boolean;
  searchPathConflict?: boolean;
}): ToolkitStatus {
  const { config, decision, toolConflict } = input;
  const executor = config.webSearch.sidecarModel
    ? `${config.webSearch.sidecarModel.provider}/${config.webSearch.sidecarModel.model}`
    : "—";
  const executorEffort = config.webSearch.sidecarModel?.thinkingLevel ?? "—";
  const effectiveDecision =
    toolConflict && decision.effective === "sidecar"
      ? ({
          effective: "unavailable",
          reason: "conflicting-tool-name",
        } satisfies BackendDecision)
      : decision;
  const remoteCompaction = selectRemoteCompactionStatus(
    config.remoteCompaction,
    input.currentModel !== undefined,
    input.remoteCompactionAvailability,
  );
  const imageGenerationDecision =
    input.imageToolConflict &&
    input.imageGenerationDecision.effective === "active"
      ? ({
          effective: "unavailable",
          reason: "conflicting-tool-name",
        } satisfies ImageGenerationDecision)
      : input.imageGenerationDecision;
  const computerUseDecision =
    input.computerUseToolConflict &&
    input.computerUseDecision.effective === "active"
      ? ({
          effective: "unavailable",
          reason: "conflicting-tool-name",
        } satisfies ComputerUseDecision)
      : input.computerUseDecision;

  return {
    configPath: input.configPath,
    configError: input.configError,
    currentModel: input.currentModel
      ? `${input.currentModel.provider}/${input.currentModel.id}`
      : "—",
    currentApi: input.currentModel?.api ?? "—",
    webSearch: {
      configured: config.webSearch.enabled ? "on" : "off",
      effective:
        effectiveDecision.effective === "off"
          ? "off"
          : effectiveDecision.effective === "unavailable"
            ? "unavailable"
            : "active",
      requestedBackend: config.webSearch.backend,
      effectiveBackend: effectiveDecision.effective,
      executor,
      executorEffort,
      reason:
        effectiveDecision.effective === "unavailable"
          ? effectiveDecision.reason
          : input.searchPathConflict
            ? "conflicting-tool-name"
            : "",
    },
    remoteCompaction: {
      configured: config.remoteCompaction.enabled ? "on" : "off",
      ...remoteCompaction,
    },
    imageGeneration: {
      configured: config.imageGeneration.enabled ? "on" : "off",
      effective: imageGenerationDecision.effective,
      backend:
        input.imageGenerationDecision.effective === "active"
          ? input.imageGenerationDecision.backend
          : "—",
      reason:
        imageGenerationDecision.effective === "unavailable"
          ? imageGenerationDecision.reason
          : "",
    },
    applyPatch: {
      configured: config.applyPatch.enabled ? "on" : "off",
      effective: !config.applyPatch.enabled
        ? "off"
        : input.applyPatchToolConflict
          ? "unavailable"
          : "active",
      reason:
        config.applyPatch.enabled && input.applyPatchToolConflict
          ? "conflicting-tool-name"
          : "",
    },
    computerUse: {
      configured: config.computerUse.enabled ? "on" : "off",
      effective: computerUseDecision.effective,
      transport:
        input.computerUseDecision.effective === "active"
          ? input.computerUseDecision.transport
          : "—",
      reason:
        computerUseDecision.effective === "unavailable"
          ? computerUseDecision.reason
          : "",
    },
  };
}

export function formatStatus(status: ToolkitStatus): string {
  const lines = [
    "Pi Codex Toolkit",
    `Config: ${status.configPath}`,
    `Current model: ${status.currentModel}`,
    `Current API: ${status.currentApi}`,
  ];
  if (status.configError) lines.push(`Config error: ${status.configError}`);

  lines.push(
    "Web Search:",
    `  configured: ${status.webSearch.configured}`,
    `  effective: ${status.webSearch.effective}`,
    `  requested backend: ${status.webSearch.requestedBackend}`,
    `  effective backend: ${status.webSearch.effectiveBackend}`,
    `  web search executor: ${status.webSearch.executor}`,
    `  web search executor effort: ${status.webSearch.executorEffort}`,
    `  reason: ${status.webSearch.reason}`,
    "  Sidecar uses a separate OpenAI request with additional latency and cost.",
    "Remote Compaction:",
    `  configured: ${status.remoteCompaction.configured}`,
    `  effective: ${status.remoteCompaction.effective}`,
    `  reason: ${status.remoteCompaction.reason}`,
    "  active is structural only; refreshed OAuth account compatibility is checked per attempt.",
    "Image Generation:",
    `  configured: ${status.imageGeneration.configured}`,
    `  effective: ${status.imageGeneration.effective}`,
    `  backend: ${status.imageGeneration.backend}`,
    `  reason: ${status.imageGeneration.reason}`,
    "Apply Patch:",
    `  configured: ${status.applyPatch.configured}`,
    `  effective: ${status.applyPatch.effective}`,
    `  reason: ${status.applyPatch.reason}`,
    "Computer Use:",
    `  configured: ${status.computerUse.configured}`,
    `  effective: ${status.computerUse.effective}`,
    `  transport: ${status.computerUse.transport}`,
    `  reason: ${status.computerUse.reason}`,
    "  experimental local bridge through ChatGPT.app node_repl and @oai/sky.",
  );
  return lines.join("\n");
}
