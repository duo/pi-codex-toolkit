import type { Model } from "@earendil-works/pi-ai";

import type { ToolkitConfig } from "./config.ts";
import type {
  ComputerUseRuntimeInspection,
  ComputerUseRuntimeUnavailableReason,
} from "./computer-use/app-server-client.ts";
import type { ExecutionRoutes } from "./execution-mode.ts";
import type { RouteUnavailableReason } from "./openai/route.ts";
import {
  APPLY_PATCH_TOOL_NAME,
  CODE_MODE_TOOL_NAMES,
  COMPUTER_USE_TOOL_GROUP,
  IMAGE_GENERATION_TOOL_NAME,
  SHELL_TOOL_NAMES,
  WEB_SEARCH_SIDECAR_TOOL,
} from "./tool-discovery/names.ts";

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

export type CapabilityEffective = "active" | "deferred" | "unavailable" | "off";

export interface WebSearchStatus {
  configured: "on" | "off";
  effective: CapabilityEffective;
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
  effective: CapabilityEffective;
  backend: "codex-oauth" | "api-key" | "—";
  reason: string;
}

/**
 * Why a requested Patch route is not effective: a foreign or absent winner
 * took the `apply_patch` name, or the committed routes record which admission
 * failure kept native editing in place.
 */
export type ApplyPatchUnavailableReason =
  | "conflicting-tool-name"
  | "patch-unavailable"
  | "code-unavailable-did-not-promote-patch"
  | "patch-unavailable-kept-native-editing";

export interface ApplyPatchStatus {
  configured: "on" | "off";
  effective: CapabilityEffective;
  reason: ApplyPatchUnavailableReason | "";
}

export interface ComputerUseStatus {
  configured: "on" | "off";
  effective: CapabilityEffective;
  transport: "node-repl" | "—";
  reason: string;
}

export type ShellSessionsUnavailableReason =
  | "conflicting-tool-name"
  | "shell-unavailable"
  | "shell-pair-unavailable";

export interface ShellSessionsStatus {
  configured: "on" | "off";
  effective: CapabilityEffective;
  reason: ShellSessionsUnavailableReason | "";
}

export type CodeModeUnavailableReason =
  | "conflicting-tool-name"
  | "code-pair-unavailable"
  | "code-shell-pair-unavailable";

export interface CodeModeStatus {
  configured: "on" | "off";
  effective: CapabilityEffective;
  reason: CodeModeUnavailableReason | "";
}

/**
 * On-demand discovery status. `managed` and `loaded` are 0 unless the
 * `find_tools` loader is available. When it is, `managed` is the configured
 * deferred set size and `loaded` counts names `find_tools` loaded this
 * session that are still active.
 */
export interface ToolDiscoveryStatus {
  configured: "on" | "off";
  effective: "active" | "unavailable" | "off";
  reason: "conflicting-tool-name" | "";
  managed: number;
  loaded: number;
}

export interface ToolkitStatus {
  configPath: string;
  configError?: string;
  configErrorDetail?: string;
  /**
   * The last apply transition rejected before committing, so the previously
   * committed projection is still active. Fixed text only — a rejection can
   * carry paths or other process detail that does not belong in status.
   */
  applyError?: string;
  currentModel: string;
  currentApi: string;
  webSearch: WebSearchStatus;
  remoteCompaction: RemoteCompactionStatus;
  imageGeneration: ImageGenerationStatus;
  applyPatch: ApplyPatchStatus;
  computerUse: ComputerUseStatus;
  shellSessions: ShellSessionsStatus;
  codeMode: CodeModeStatus;
  toolDiscovery: ToolDiscoveryStatus;
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

export function selectShellSessionsStatus(
  config: ToolkitConfig["shellSessions"],
  runtimeAvailable: boolean,
  toolConflict: boolean,
): Pick<ShellSessionsStatus, "effective" | "reason"> {
  if (!config.enabled) return { effective: "off", reason: "" };
  if (toolConflict) {
    return { effective: "unavailable", reason: "conflicting-tool-name" };
  }
  if (!runtimeAvailable) {
    return { effective: "unavailable", reason: "shell-unavailable" };
  }
  return { effective: "active", reason: "" };
}

export function selectCodeModeStatus(
  config: ToolkitConfig["codeMode"],
  toolConflict: boolean,
): Pick<CodeModeStatus, "effective" | "reason"> {
  if (!config.enabled) return { effective: "off", reason: "" };
  if (toolConflict) {
    return { effective: "unavailable", reason: "conflicting-tool-name" };
  }
  return { effective: "active", reason: "" };
}

export function selectToolDiscoveryStatus(
  config: ToolkitConfig["toolDiscovery"],
  toolConflict: boolean,
): Pick<ToolDiscoveryStatus, "effective" | "reason"> {
  if (!config.enabled) return { effective: "off", reason: "" };
  if (toolConflict) {
    return { effective: "unavailable", reason: "conflicting-tool-name" };
  }
  return { effective: "active", reason: "" };
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

/**
 * Overlay `deferred` only when ordinary `effective` would still be `active`
 * and every deferred member of the capability is hidden. An empty member set
 * is not deferred: `every([])` would mis-report a fully active capability.
 */
function overlayDiscoveryDeferred(
  ordinary: CapabilityEffective,
  memberNames: readonly string[],
  deferred: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
): CapabilityEffective {
  if (ordinary !== "active") return ordinary;
  const members = memberNames.filter((name) => deferred.has(name));
  if (members.length === 0) return ordinary;
  return members.every((name) => hidden.has(name)) ? "deferred" : ordinary;
}

/** Route notes that belong to the Apply Patch row; the Shell and Code rows own their `*-pair-unavailable` entries. */
const PATCH_ROUTE_NOTES: ReadonlySet<string> = new Set([
  "patch-unavailable",
  "code-unavailable-did-not-promote-patch",
  "patch-unavailable-kept-native-editing",
]);

function isPatchRouteNote(
  note: string,
): note is Exclude<ApplyPatchUnavailableReason, "conflicting-tool-name"> {
  return PATCH_ROUTE_NOTES.has(note);
}

/** Route notes that belong to the Code Mode row: the owned pair and its nested Shell dependency are distinct failures. */
const CODE_ROUTE_NOTES: ReadonlySet<string> = new Set([
  "code-pair-unavailable",
  "code-shell-pair-unavailable",
]);

function isCodeRouteNote(
  note: string,
): note is Exclude<CodeModeUnavailableReason, "conflicting-tool-name"> {
  return CODE_ROUTE_NOTES.has(note);
}

/**
 * One rules-managed capability row, in the same precedence the legacy
 * selectors use: a route the rules never requested is plain `off` and carries
 * no reason, a visible foreign winner on an owned name outranks the committed
 * route, and only a requested route that is not active reports its admission
 * note. An owned name that is merely absent is not a conflict; its route was
 * never admitted, so the note carries the reason. The caller resolves that
 * note, so a row can never report `active` and a failure reason at once.
 */
function selectRulesRouteStatus<Reason extends string>(input: {
  requested: boolean;
  active: boolean;
  conflict: boolean;
  note: Reason | "";
}): {
  effective: "active" | "unavailable" | "off";
  reason: Reason | "conflicting-tool-name" | "";
} {
  if (!input.requested) return { effective: "off", reason: "" };
  if (input.conflict) {
    return { effective: "unavailable", reason: "conflicting-tool-name" };
  }
  if (input.active) return { effective: "active", reason: "" };
  return { effective: "unavailable", reason: input.note };
}

export function projectStatus(input: {
  config: ToolkitConfig;
  configPath: string;
  configError?: string;
  configErrorDetail?: string;
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
  shellConflict?: boolean;
  shellRuntimeAvailable?: boolean;
  codeModeConflict?: boolean;
  /**
   * Visible foreign winners on the owned execution names. A rules-managed row
   * reports `conflicting-tool-name` only for these: a name that is merely
   * absent (a role or CLI allowlist filtered it) is not another extension's
   * registration, and the committed route's admission note already says the
   * route could not be admitted. Absent means `false` here, so a caller that
   * does not inspect ownership never reports a conflict it did not observe.
   * The legacy rows keep using the broader `*Conflict` flags.
   */
  applyPatchForeignConflict?: boolean;
  shellForeignConflict?: boolean;
  codeModeForeignConflict?: boolean;
  /**
   * The committed execution routes (the resolved candidate before the first
   * successful sync). On a rules-managed file the legacy flags are stripped
   * at save, so the Patch/Shell/Code rows derive from these routes — the same
   * object the appended execution block reports. Ignored when
   * `config.execution` is absent.
   */
  executionRoutes?: ExecutionRoutes;
  /** Pending apply failure, surfaced between the header and the rows. */
  applyError?: string;
  toolDiscovery?: {
    deferred: readonly string[];
    hidden: readonly string[];
    loaded: number;
    conflict: boolean;
  };
}): ToolkitStatus {
  const { config, decision, toolConflict } = input;
  const discoveryConflict = input.toolDiscovery?.conflict ?? false;
  const deferredNames = input.toolDiscovery?.deferred ?? [];
  const hiddenNames = input.toolDiscovery?.hidden ?? [];
  const deferredSet = new Set(deferredNames);
  const hiddenSet = new Set(hiddenNames);
  const loaderAvailable = config.toolDiscovery.enabled && !discoveryConflict;
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
  const webSearchOrdinaryEffective: "active" | "unavailable" | "off" =
    effectiveDecision.effective === "off"
      ? "off"
      : effectiveDecision.effective === "unavailable"
        ? "unavailable"
        : "active";
  const webSearchEffective =
    effectiveDecision.effective === "sidecar"
      ? overlayDiscoveryDeferred(
          webSearchOrdinaryEffective,
          [WEB_SEARCH_SIDECAR_TOOL],
          deferredSet,
          hiddenSet,
        )
      : webSearchOrdinaryEffective;
  // Rules-managed files strip the legacy capability flags at save, so the
  // Patch/Shell/Code rows derive from the committed routes the appended
  // execution block reports instead of those stripped flags. Each row keeps
  // the legacy precedence (see `selectRulesRouteStatus`): a route the rules
  // did not request is plain `off`, a foreign or absent owned name outranks
  // the committed route, and otherwise the committed admission notes carry
  // the reason a requested route stayed unavailable.
  const rulesRoutes =
    config.execution !== undefined ? input.executionRoutes : undefined;
  const patchRouteNote = rulesRoutes?.notes.find(isPatchRouteNote);
  const codeRouteNote = rulesRoutes?.notes.find(isCodeRouteNote);
  const shellRuntimeAvailable = input.shellRuntimeAvailable ?? true;
  const applyPatchOrdinary: Pick<ApplyPatchStatus, "reason"> & {
    effective: "active" | "unavailable" | "off";
  } = rulesRoutes
    ? selectRulesRouteStatus({
        requested: rulesRoutes.requested.patch,
        active: rulesRoutes.directPatch || rulesRoutes.nestedPatch,
        conflict: input.applyPatchForeignConflict === true,
        note: patchRouteNote ?? "",
      })
    : {
        effective: !config.applyPatch.enabled
          ? "off"
          : input.applyPatchToolConflict
            ? "unavailable"
            : "active",
        reason:
          config.applyPatch.enabled && input.applyPatchToolConflict
            ? "conflicting-tool-name"
            : "",
      };
  const shellSessionsOrdinary: Pick<
    ShellSessionsStatus,
    "effective" | "reason"
  > = rulesRoutes
    ? selectRulesRouteStatus({
        requested: rulesRoutes.requested.shell,
        // Rules admit the owned pair; they cannot see whether this host has a
        // usable shell binary, so the legacy runtime reason still applies.
        active: rulesRoutes.directShell && shellRuntimeAvailable,
        conflict: input.shellForeignConflict === true,
        note: rulesRoutes.directShell
          ? "shell-unavailable"
          : rulesRoutes.notes.includes("shell-pair-unavailable")
            ? "shell-pair-unavailable"
            : "",
      })
    : selectShellSessionsStatus(
        config.shellSessions,
        shellRuntimeAvailable,
        input.shellConflict ?? false,
      );
  const codeModeOrdinary: Pick<CodeModeStatus, "effective" | "reason"> =
    rulesRoutes
      ? selectRulesRouteStatus({
          requested: rulesRoutes.requested.code,
          active: rulesRoutes.code,
          conflict: input.codeModeForeignConflict === true,
          note: codeRouteNote ?? "",
        })
      : selectCodeModeStatus(config.codeMode, input.codeModeConflict ?? false);

  return {
    configPath: input.configPath,
    configError: input.configError,
    configErrorDetail: input.configErrorDetail,
    applyError: input.applyError,
    currentModel: input.currentModel
      ? `${input.currentModel.provider}/${input.currentModel.id}`
      : "—",
    currentApi: input.currentModel?.api ?? "—",
    webSearch: {
      configured: config.webSearch.enabled ? "on" : "off",
      effective: webSearchEffective,
      requestedBackend: config.webSearch.backend,
      effectiveBackend: effectiveDecision.effective,
      executor,
      executorEffort,
      reason:
        webSearchEffective === "deferred"
          ? ""
          : effectiveDecision.effective === "unavailable"
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
      effective: overlayDiscoveryDeferred(
        imageGenerationDecision.effective,
        [IMAGE_GENERATION_TOOL_NAME],
        deferredSet,
        hiddenSet,
      ),
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
      configured: rulesRoutes
        ? rulesRoutes.requested.patch
          ? "on"
          : "off"
        : config.applyPatch.enabled
          ? "on"
          : "off",
      effective: overlayDiscoveryDeferred(
        applyPatchOrdinary.effective,
        [APPLY_PATCH_TOOL_NAME],
        deferredSet,
        hiddenSet,
      ),
      reason: applyPatchOrdinary.reason,
    },
    computerUse: {
      configured: config.computerUse.enabled ? "on" : "off",
      effective: overlayDiscoveryDeferred(
        computerUseDecision.effective,
        COMPUTER_USE_TOOL_GROUP,
        deferredSet,
        hiddenSet,
      ),
      transport:
        input.computerUseDecision.effective === "active"
          ? input.computerUseDecision.transport
          : "—",
      reason:
        computerUseDecision.effective === "unavailable"
          ? computerUseDecision.reason
          : "",
    },
    shellSessions: {
      configured: rulesRoutes
        ? rulesRoutes.requested.shell
          ? "on"
          : "off"
        : config.shellSessions.enabled
          ? "on"
          : "off",
      effective: overlayDiscoveryDeferred(
        shellSessionsOrdinary.effective,
        SHELL_TOOL_NAMES,
        deferredSet,
        hiddenSet,
      ),
      reason: shellSessionsOrdinary.reason,
    },
    codeMode: {
      configured: rulesRoutes
        ? rulesRoutes.requested.code
          ? "on"
          : "off"
        : config.codeMode.enabled
          ? "on"
          : "off",
      effective: overlayDiscoveryDeferred(
        codeModeOrdinary.effective,
        CODE_MODE_TOOL_NAMES,
        deferredSet,
        hiddenSet,
      ),
      reason: codeModeOrdinary.reason,
    },
    toolDiscovery: {
      configured: config.toolDiscovery.enabled ? "on" : "off",
      ...selectToolDiscoveryStatus(config.toolDiscovery, discoveryConflict),
      managed: loaderAvailable ? deferredNames.length : 0,
      loaded: loaderAvailable ? (input.toolDiscovery?.loaded ?? 0) : 0,
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
  if (status.configError) {
    lines.push(
      status.configErrorDetail
        ? `Config error: ${status.configError} (${status.configErrorDetail})`
        : `Config error: ${status.configError}`,
    );
  }
  if (status.applyError) {
    lines.push(`Apply error: ${status.applyError}`);
  }

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
    "Shell Sessions:",
    `  configured: ${status.shellSessions.configured}`,
    `  effective: ${status.shellSessions.effective}`,
    `  reason: ${status.shellSessions.reason}`,
    "  local pipes only; no TTY; commands launch once and are never replayed.",
    "Code Mode:",
    `  configured: ${status.codeMode.configured}`,
    `  effective: ${status.codeMode.effective}`,
    `  reason: ${status.codeMode.reason}`,
    "  nested calls dispatch only declared adapters; per-call tool hooks and third-party permission interceptors do not see them.",
    "Tool Discovery:",
    `  configured: ${status.toolDiscovery.configured}`,
    `  effective: ${status.toolDiscovery.effective}`,
    `  reason: ${status.toolDiscovery.reason}`,
    `  managed deferred tools: ${status.toolDiscovery.managed}`,
    `  loaded this session: ${status.toolDiscovery.loaded}`,
    "  only explicitly managed Toolkit-owned tools can be loaded; discovery never enables a disabled capability or grants permission.",
  );
  return lines.join("\n");
}
