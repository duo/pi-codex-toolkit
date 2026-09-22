import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { Tool } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  APPLY_PATCH_TOOL,
  APPLY_PATCH_TOOL_DEFINITION,
  createApplyPatchTool,
} from "./apply-patch.ts";
import { configReadErrorMessage, registerCommands } from "./commands.ts";
import {
  CodeModeAdapters,
  hasMutationApprovalUI,
} from "./code-mode/adapters.ts";
import { CodeModeCellManager, CodeModeError } from "./code-mode/manager.ts";
import { ExecutionOutputOwner } from "./execution-output.ts";
import {
  CODE_MODE_EXEC_TOOL,
  CODE_MODE_TOOLS,
  createCodeModeTools,
  EXEC_CONSTRAINED_SAMPLING,
  type CodeModeManagerPurpose,
} from "./code-mode/tools.ts";
import { ConfigStore, type ToolkitConfig } from "./config.ts";
import {
  buildExecutionDiagnostics,
  EXECUTION_DIAGNOSTICS_EVENT,
  readToolkitIdentity,
  type ExecutionApprovalTransport,
} from "./execution-diagnostics.ts";
import {
  appendExecutionStatus,
  EXECUTION_SCHEMA_VERSION,
  formatExecutionStatus,
  isEagerReplacement,
  isNestedOnlyName,
  PI_BUILTIN_BASH,
  PI_BUILTIN_EDIT,
  PI_BUILTIN_WRITE,
  PI_REPLACED_BUILTINS,
  requestCapabilities,
  resolveExecutionRoutes,
  resolveLegacyRoutes,
  type ExecutionAdmission,
  type ExecutionRule,
  type ExecutionRoutes,
} from "./execution-mode.ts";
import type { ExecutionInvocationHooks } from "./execution-invocation.ts";
import { ComputerUseLifecycle } from "./computer-use/lifecycle.ts";
import {
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
  emitProviderRouteResolutionDebug,
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
import { inspectShellRuntime, ShellSessionManager } from "./shell/manager.ts";
import { createShellTools, SHELL_TOOLS } from "./shell/tools.ts";
import {
  inspectToolOwnership,
  isBuiltinWinner,
  isUnavailableOwnership,
  isVisibleForeignOwnership,
  type ToolInfo,
} from "./tool-ownership.ts";
import {
  isHiddenByDiscovery,
  resolveDeferredSet,
  type EligibilityResult,
} from "./tool-discovery/directory.ts";
import {
  IMAGE_GENERATION_TOOL_NAME,
  WEB_SEARCH_SIDECAR_TOOL,
} from "./tool-discovery/names.ts";
import {
  createToolDiscoveryTool,
  TOOL_DISCOVERY_TOOL,
} from "./tool-discovery/tools.ts";

export { COMPUTER_USE_TOOLS } from "./computer-use/tools.ts";
export { APPLY_PATCH_TOOL } from "./apply-patch.ts";
export { EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL } from "./shell/tools.ts";
export {
  CODE_MODE_EXEC_TOOL,
  CODE_MODE_TOOLS,
  CODE_MODE_WAIT_TOOL,
} from "./code-mode/tools.ts";
export { TOOL_DISCOVERY_TOOL } from "./tool-discovery/tools.ts";
export {
  EXECUTION_DIAGNOSTICS_EVENT,
  EXECUTION_DIAGNOSTICS_VERSION,
  type ExecutionDiagnosticsRecord,
} from "./execution-diagnostics.ts";

export const WEB_SEARCH_TOOL = WEB_SEARCH_SIDECAR_TOOL;
export const IMAGE_GENERATION_TOOL = IMAGE_GENERATION_TOOL_NAME;
/**
 * This module's own file. It locates the packed manifest and nothing else:
 * ownership never falls back to it, because a second factory built from this
 * module reports the same path and would inherit the first one's
 * registrations (see `toolkitSourcePath`).
 */
const EXTENSION_SOURCE_PATH = fileURLToPath(import.meta.url);

interface NativeSuppressionEntry {
  /**
   * Builtin names this host lineage admitted: captured from the active
   * builtin winners at session start, unioned forward across reloads, and
   * reconciled on ordinary syncs that observe a visible builtin become
   * inactive (drop) or active again (rejoin). Transcript replay may drop a
   * remaining member; tree reconciliation may restore that member. A name
   * absent from the baseline is not ours to revive until a later ordinary
   * sync observes it enabled.
   */
  baseline: Set<string>;
  /**
   * Builtin names the committed projection currently suppresses. Committed
   * syncs rewrite its contents in place, preserving the Set identity the
   * stash shares with the live factory binding.
   */
  suppressed: Set<string>;
}

/**
 * Process-global store of admitted-native provenance, keyed by **resolved
 * factory identity** and then by session lineage (session file, falling back
 * to session id). Pi's `session.reload()` rebuilds a factory against the
 * already-filtered active list, so a baseline recaptured at `session_start`
 * cannot tell Toolkit suppression from external removal. The stash survives
 * factory re-instantiation inside the process; each entry's `suppressed` Set
 * keeps its identity because committed syncs mutate it in place.
 *
 * The identity level is what keeps two factories in one process apart. A
 * second factory — an unpinned wrapper beside the package, two SDK factories
 * from one module — sees the winner's suppression as an ordinary filtered
 * list, so a record keyed by session alone would be replaced with that
 * factory's empty sets and the reload could never restore the builtins. A
 * factory that resolves no identity owns nothing and therefore writes nothing
 * here; two factories pinning the same `sourcePath` declare themselves one
 * identity and deliberately share the record.
 */
function nativeSuppressionStash(): Map<
  string,
  Map<string, NativeSuppressionEntry>
> {
  const key = Symbol.for("pi-codex-toolkit.native-suppression");
  const scope = globalThis as Record<symbol, unknown>;
  const existing = scope[key];
  if (existing instanceof Map) {
    return existing as Map<string, Map<string, NativeSuppressionEntry>>;
  }
  const created = new Map<string, Map<string, NativeSuppressionEntry>>();
  scope[key] = created;
  return created;
}

/** Deferred-name eligibility reason: the feature is configured off. */
export const DISCOVERY_DISABLED_REASON = "disabled";
/**
 * Deferred-name eligibility reason: the name is absent from the visible
 * `getAllTools()` projection. A CLI `--tools` allowlist removes filtered names
 * and `setActiveTools` ignores unknown names, so an absent name cannot be
 * loaded.
 */
export const DISCOVERY_NOT_REGISTERED_REASON = "not-registered";
/**
 * Deferred-name eligibility reason: Web Search is active through the native
 * backend, so the Sidecar `openai_web_search` tool is not part of the ordinary
 * projection for this model.
 */
export const DISCOVERY_NATIVE_BACKEND_REASON = "native-backend";
/** Deferred-name eligibility reason: another extension owns the name. */
export const DISCOVERY_CONFLICT_REASON = "conflicting-tool-name";
/** Deferred-name eligibility reason: the name is nested-only under Code. */
export const DISCOVERY_NESTED_ONLY_REASON = "nested-only";

/** Owned execution names, in the order diagnostics report them. */
const EXECUTION_TOOL_NAMES: readonly string[] = [
  APPLY_PATCH_TOOL,
  ...SHELL_TOOLS,
  ...CODE_MODE_TOOLS,
];

/** Packed identity for diagnostics; the manifest is read at most once. */
let packagedIdentity: { name: string; version: string } | undefined;
function toolkitIdentity(): { name: string; version: string } {
  packagedIdentity ??= readToolkitIdentity(
    join(EXTENSION_SOURCE_PATH, "..", "..", "package.json"),
  );
  return packagedIdentity;
}

export function getConfigPath(): string {
  return join(getAgentDir(), "extensions", "pi-codex-toolkit.json");
}

/**
 * Copy one parameter schema so this factory's registration has an object
 * identity no other factory shares.
 *
 * Property descriptors and the prototype are preserved — TypeBox keeps its
 * kind marker as a non-enumerable own property — so the clone validates
 * exactly like the original and serializes to byte-identical JSON. Nested
 * subschemas stay shared by reference: only the top-level object identity
 * Pi projects in `getAllTools()` has to be distinct.
 */
function cloneToolSchema<T extends object>(schema: T): T {
  return Object.create(
    Object.getPrototypeOf(schema) as object | null,
    Object.getOwnPropertyDescriptors(schema),
  ) as T;
}

/**
 * Resolve the extension identity Pi attributes to one factory's registrations.
 *
 * Ownership is decided by `sourceInfo.path`, and Pi stamps every tool with the
 * **loaded extension file**, not the module that defines it. An embedder that
 * writes `export default createPiCodexToolkit({ … })` in its own extension file
 * therefore makes Pi report that file for every Toolkit tool, and comparing
 * against this module's path would classify all owned names as foreign.
 *
 * Registrations are recognized by the identity of the parameter schema object
 * handed to `registerTool`: Pi 0.87's `getAllTools()` projects
 * `definition.parameters` by reference, so a registration this factory did not
 * make carries a different object and cannot contribute a path. Those objects
 * are per-factory clones (`registerOwnedTool`), so a second factory built from
 * the same module instance — two SDK factories in one process, a wrapper
 * beside the default export — votes only for its own registrations even though
 * both read the same module-level schema constants. The path shared by the
 * most proven registrations wins, which also keeps one replaced name from
 * deciding. Returns `undefined` when nothing is provably ours — every owned
 * name filtered out of the projection, another factory winning them, or a host
 * that copies schemas — and the caller then owns nothing.
 */
export function detectExtensionSourcePath(
  tools: readonly ToolInfo[],
  registeredSchemas: ReadonlyMap<string, unknown>,
): string | undefined {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const registered = registeredSchemas.get(tool.name);
    if (registered === undefined || tool.parameters !== registered) continue;
    const path = tool.sourceInfo?.path;
    if (typeof path !== "string" || path.length === 0) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  let winner: string | undefined;
  let best = 0;
  for (const [path, count] of counts) {
    if (count > best) {
      winner = path;
      best = count;
    }
  }
  return winner;
}

export function inspectExecutionAdmission(
  tools: ReturnType<ExtensionAPI["getAllTools"]>,
  sourcePath: string | undefined,
): ExecutionAdmission {
  const owned = (name: string): boolean =>
    inspectToolOwnership(tools, name, sourcePath).state === "owned";
  return {
    patchOwnedAdmitted: owned(APPLY_PATCH_TOOL),
    shellPairAdmitted: SHELL_TOOLS.every((name) => owned(name)),
    codePairAdmitted: CODE_MODE_TOOLS.every((name) => owned(name)),
  };
}

export function resolveToolkitRoutes(
  config: ToolkitConfig,
  model: { provider?: string; id?: string } | undefined,
  admission: ExecutionAdmission,
): ExecutionRoutes {
  const requested = requestCapabilities({
    execution: config.execution,
    legacy: {
      patch: config.applyPatch.enabled,
      shell: config.shellSessions.enabled,
      code: config.codeMode.enabled,
    },
    model: { provider: model?.provider, id: model?.id },
  });
  return requested.source === "legacy"
    ? resolveLegacyRoutes(requested, admission)
    : resolveExecutionRoutes(requested, admission);
}

function availability(
  inspection: { ok: true } | { ok: false; reason: Availability["reason"] },
): Availability {
  return inspection.ok
    ? { ok: true }
    : { ok: false, reason: inspection.reason };
}

/**
 * Grammar transport Pi 0.87's `getAllTools()` projection drops, keyed by the
 * owned name that declares it. A Map, not an object: a tool name is foreign
 * input, and an inherited `Object.prototype` member must never read as a
 * registered grammar.
 */
const OWNED_CONSTRAINED_SAMPLING = new Map<
  string,
  (typeof APPLY_PATCH_TOOL_DEFINITION)["constrainedSampling"]
>([
  [APPLY_PATCH_TOOL, APPLY_PATCH_TOOL_DEFINITION.constrainedSampling],
  [CODE_MODE_EXEC_TOOL, EXEC_CONSTRAINED_SAMPLING],
]);

function activeToolSchemas(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  sourcePath: string | undefined,
): Tool[] {
  const active = new Set(pi.getActiveTools());
  return pi
    .getAllTools()
    .filter((tool) => active.has(tool.name))
    .map((tool) => {
      const sampling = OWNED_CONSTRAINED_SAMPLING.get(tool.name);
      const restoreGrammar =
        sampling !== undefined &&
        inspectToolOwnership([tool], tool.name, sourcePath).state === "owned";
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(restoreGrammar ? { constrainedSampling: sampling } : {}),
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

/** True when this extension cannot activate `toolName`: absent or foreign winner. */
function ownedToolConflict(
  tools: ReturnType<ExtensionAPI["getAllTools"]>,
  toolName: string,
  sourcePath: string | undefined,
): boolean {
  return isUnavailableOwnership(
    inspectToolOwnership(tools, toolName, sourcePath),
  );
}

/**
 * True only when the `getAllTools()` projection visibly reports a winner for
 * `toolName` that this extension does not own. Unlike `ownedToolConflict`, an
 * absent name is not a conflict: the host removes names filtered by a user or
 * CLI allowlist (for example `--tools exec,wait`), and nested Code Mode
 * adapters dispatch through the existing executors rather than the projected
 * tool, so they stay available in that setup.
 */
function visibleForeignToolConflict(
  tools: ReturnType<ExtensionAPI["getAllTools"]>,
  toolName: string,
  sourcePath: string | undefined,
): boolean {
  return isVisibleForeignOwnership(
    inspectToolOwnership(tools, toolName, sourcePath),
  );
}

export interface OwnedToolSyncOptions {
  inspection?: ComputerUseRuntimeInspection;
  platform?: NodeJS.Platform;
  /** Deferred names loaded by `find_tools` in this session. */
  discovered?: readonly string[];
  /**
   * Builtin names whose suppression the committed projection owns. Planning
   * reads it without mutating; the apply step rewrites its contents in place
   * (same Set identity) only when the projection actually commits, so a
   * rejected transition keeps the last committed suppression set.
   */
  nativeSuppressed?: Set<string>;
  /**
   * Builtin names this host lineage admitted. Planning copies it; the apply
   * step rewrites its contents in place only when the projection commits, so
   * a rejected transition keeps the last committed baseline.
   */
  nativeBaseline?: Set<string>;
  /**
   * Session-tree reconcile mode: Pi replays a transcript tool declaration
   * that can predate a suppression-clearing restore, so a baseline member
   * that is now absent from the projection is claimed back as this
   * projection's suppression — letting the ordinary hide/restore logic
   * bring it back — instead of being treated as an external removal.
   * Ordinary syncs that observe an inactive, unsuppressed builtin shrink
   * the baseline instead, so a later tree replay cannot revive an external
   * disable performed while the name was visible.
   */
  reconcileBaseline?: boolean;
}

export interface OwnedToolSyncPlan {
  decision: BackendDecision;
  conflict: boolean;
  imageDecision: ImageGenerationDecision;
  imageConflict: boolean;
  applyPatchConflict: boolean;
  computerUseDecision: ComputerUseDecision;
  computerUseConflict: boolean;
  shellConflict: boolean;
  codeModeConflict: boolean;
  findToolsConflict: boolean;
  routes: ExecutionRoutes;
  /** Full intended active list, published only when the caller commits. */
  desiredNames: string[];
  /** Builtin-name suppression this plan's projection owns once committed. */
  suppressedNames: string[];
  /** Admitted-native baseline this plan's projection owns once committed. */
  baselineNames: string[];
}

/**
 * Compute the Toolkit-owned projection without touching the host. The caller
 * decides when `desiredNames`/`suppressedNames` commit: `syncOwnedTool`
 * applies immediately, while the session `sync` holds the plan until owned
 * resource cleanup settles so a rejected contraction keeps the old
 * projection — and its retained cells' controls — intact.
 */
export function planOwnedToolSync(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "setActiveTools">,
  config: ToolkitConfig,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry"> &
    Partial<Pick<ExtensionContext, "hasUI">>,
  /** Resolved extension identity; `undefined` owns nothing (see `toolkitSourcePath`). */
  sourcePath: string | undefined,
  syncOptions: OwnedToolSyncOptions = {},
): OwnedToolSyncPlan {
  const decision = runtimeDecision(config, ctx);
  const imageDecision = runtimeImageGenerationDecision(config, ctx);
  const computerUseDecision = runtimeComputerUseDecision(
    config,
    ctx,
    syncOptions.inspection,
    syncOptions.platform,
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
  const shellConflict = SHELL_TOOLS.some((name) =>
    ownedToolConflict(tools, name, sourcePath),
  );
  const codeModeConflicts = CODE_MODE_TOOLS.map((name) =>
    ownedToolConflict(tools, name, sourcePath),
  );
  const codeModeConflict = codeModeConflicts.some(Boolean);
  const findToolsConflict = ownedToolConflict(
    tools,
    TOOL_DISCOVERY_TOOL,
    sourcePath,
  );
  const discoveryEnabled = config.toolDiscovery.enabled;
  const deferred = new Set(resolveDeferredSet(config.toolDiscovery));
  const discovered = new Set(syncOptions.discovered ?? []);
  const loaderAvailable = discoveryEnabled && !findToolsConflict;
  const hiddenByDiscovery = (name: string): boolean =>
    isHiddenByDiscovery(name, { loaderAvailable, deferred, discovered });
  const routes = resolveToolkitRoutes(
    config,
    ctx.model,
    inspectExecutionAdmission(tools, sourcePath),
  );
  const wantsVisible = (name: string, routeVisible: boolean): boolean => {
    if (!routeVisible || isNestedOnlyName(name, routes)) return false;
    if (isEagerReplacement(name, routes)) return true;
    return !hiddenByDiscovery(name);
  };
  const desired = new Set(active);

  if (!conflict) {
    if (
      decision.effective === "sidecar" &&
      !hiddenByDiscovery(WEB_SEARCH_TOOL)
    ) {
      desired.add(WEB_SEARCH_TOOL);
    } else {
      desired.delete(WEB_SEARCH_TOOL);
    }
  }
  if (!imageConflict) {
    if (
      imageDecision.effective === "active" &&
      !hiddenByDiscovery(IMAGE_GENERATION_TOOL)
    ) {
      desired.add(IMAGE_GENERATION_TOOL);
    } else {
      desired.delete(IMAGE_GENERATION_TOOL);
    }
  }
  if (!applyPatchConflict) {
    if (wantsVisible(APPLY_PATCH_TOOL, routes.directPatch)) {
      desired.add(APPLY_PATCH_TOOL);
    } else {
      desired.delete(APPLY_PATCH_TOOL);
    }
  }
  for (const [index, name] of COMPUTER_USE_TOOLS.entries()) {
    if (computerUseConflicts[index]) continue;
    if (
      !computerUseConflict &&
      computerUseDecision.effective === "active" &&
      !hiddenByDiscovery(name)
    ) {
      desired.add(name);
    } else {
      desired.delete(name);
    }
  }
  if (!shellConflict) {
    for (const name of SHELL_TOOLS) {
      if (wantsVisible(name, routes.directShell)) {
        desired.add(name);
      } else {
        desired.delete(name);
      }
    }
  } else {
    for (const name of SHELL_TOOLS) {
      if (ownedToolConflict(tools, name, sourcePath)) continue;
      desired.delete(name);
    }
  }
  if (!codeModeConflict) {
    for (const name of CODE_MODE_TOOLS) {
      if (wantsVisible(name, routes.code)) {
        desired.add(name);
      } else {
        desired.delete(name);
      }
    }
  } else {
    for (const [index, name] of CODE_MODE_TOOLS.entries()) {
      if (codeModeConflicts[index]) continue;
      desired.delete(name);
    }
  }
  if (!findToolsConflict) {
    if (discoveryEnabled) desired.add(TOOL_DISCOVERY_TOOL);
    else desired.delete(TOOL_DISCOVERY_TOOL);
  }
  // Native substitution is Toolkit-owned suppression keyed by builtin source
  // identity, never name alone. A foreign same-name winner keeps its own
  // activation state — it is not ours to hide — and a name we never
  // suppressed is never restored, so externally disabling a visible builtin
  // survives every sync. Suppression records only removals this projection
  // actually performs: a builtin already inactive before hiding is not
  // revived later. `suppressed` is a working copy; the caller commits it only
  // once `desiredNames` is applied. Accepted boundary (design.md): an
  // external disable performed while the same name is already hidden is
  // indistinguishable from our own suppression and cannot be detected.
  const suppressed = new Set(syncOptions.nativeSuppressed);
  const baseline = new Set(syncOptions.nativeBaseline);
  if (syncOptions.reconcileBaseline) {
    // A transcript replay re-asserted a filtered tool declaration: every
    // admitted baseline member that is now absent from the projection is
    // reclaimed as ours, so the hide/restore loop below restores it when
    // the rules no longer hide it — and keeps it marked when they do.
    for (const name of baseline) {
      if (!desired.has(name) && isBuiltinWinner(tools, name)) {
        suppressed.add(name);
      }
    }
  }
  for (const [name, hide] of [
    [PI_BUILTIN_BASH, routes.hideBash],
    [PI_BUILTIN_EDIT, routes.hideEditWrite],
    [PI_BUILTIN_WRITE, routes.hideEditWrite],
  ] as const) {
    if (hide) {
      if (isBuiltinWinner(tools, name)) {
        if (desired.has(name)) {
          if (!suppressed.has(name) && !syncOptions.reconcileBaseline) {
            // Symmetric to the removal below: an ordinary sync observes the
            // live active list before it hides anything, so a visible builtin
            // that is active and not ours rejoined the admitted baseline
            // externally. Without this observation an enable made immediately
            // before a hiding route is suppressed without ever entering the
            // baseline, and a later tree reconcile cannot claim it back.
            baseline.add(name);
          }
          suppressed.add(name);
        } else if (!suppressed.has(name) && !syncOptions.reconcileBaseline) {
          // An ordinary sync observes the live active list before it hides
          // anything: a visible builtin that is already inactive and not ours
          // left the admitted baseline externally. Without this observation
          // the stale member survives the hiding route, and a later tree
          // reconcile would claim it as this projection's suppression and
          // restore a builtin the user disabled.
          baseline.delete(name);
        }
        desired.delete(name);
      } else {
        // Foreign or absent winner: nothing to hide and nothing owed back
        // should the builtin later regain the name.
        suppressed.delete(name);
      }
    } else if (suppressed.has(name)) {
      suppressed.delete(name);
      // Restore only what we suppressed, and only while the visible winner
      // is still the builtin registration.
      if (isBuiltinWinner(tools, name)) desired.add(name);
    } else if (isBuiltinWinner(tools, name) && !syncOptions.reconcileBaseline) {
      // Ordinary syncs observe the live active list. Tree replay must not:
      // a historical enabled declaration would otherwise rejoin baseline and
      // a later visit to the disabled declaration would restore those names.
      if (desired.has(name)) baseline.add(name);
      else baseline.delete(name);
    }
  }

  return {
    decision,
    conflict,
    imageDecision,
    imageConflict,
    applyPatchConflict,
    computerUseDecision,
    computerUseConflict,
    shellConflict,
    codeModeConflict,
    findToolsConflict,
    routes,
    desiredNames: [...desired],
    suppressedNames: [...suppressed],
    baselineNames: [...baseline],
  };
}

/**
 * The part of a plan that decides which owned resources must be cleaned up
 * before it may be published, plus the routes its start fence denies. Two
 * candidates that agree here need the same cleanup, which is what lets the
 * session sync stop re-planning. The conflict flags come from the host read
 * that produced the plan: a visible foreign shell winner fences the shell
 * backend, and an unavailable Code pair closes the cell manager.
 */
interface ExecutionTransition {
  directPatch: boolean;
  nestedPatch: boolean;
  directShell: boolean;
  code: boolean;
  needsShellBackend: boolean;
  shellForeignConflict: boolean;
  codeModeConflict: boolean;
  /**
   * Computer Use owes a full `cleanup()` (disposal of every owned client), not
   * the pending-only sweep an unchanged sync performs. It belongs here for the
   * same reason as the execution routes: a foreign winner taking a Computer
   * Use name — or a decision or approval-mode change — during the cleanup
   * await turns a pending-only obligation into a full one, and committing the
   * fresh plan without running it would drop the owned client the re-plan just
   * contracted.
   */
  computerUseFullCleanup: boolean;
}

/** A plan and the transition its cleanup and start fence follow. */
interface SyncCandidate {
  plan: OwnedToolSyncPlan;
  /**
   * The sync's native-provenance epoch when this plan was built. It changes
   * only when a deferred hydration resolves mid-sync and re-captures the
   * suppression/baseline pair, so a plan whose epoch is no longer current
   * read sets the commit would no longer write into.
   */
  provenance: number;
  transition: ExecutionTransition;
}

function sameExecutionTransition(
  current: ExecutionTransition,
  fresh: ExecutionTransition,
): boolean {
  return (
    current.directPatch === fresh.directPatch &&
    current.nestedPatch === fresh.nestedPatch &&
    current.directShell === fresh.directShell &&
    current.code === fresh.code &&
    current.needsShellBackend === fresh.needsShellBackend &&
    current.shellForeignConflict === fresh.shellForeignConflict &&
    current.codeModeConflict === fresh.codeModeConflict &&
    current.computerUseFullCleanup === fresh.computerUseFullCleanup
  );
}

/**
 * Cleanup/re-plan passes one session sync performs before it commits. Each
 * pass runs the cleanup its candidate requires, so an oscillating host cannot
 * hold a sync open: after the last pass the settled candidate commits.
 */
const MAX_SYNC_PLANNING_PASSES = 3;

/** Write the planned active list, diffed against a fresh host read. */
function applyDesiredTools(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  desiredNames: readonly string[],
): void {
  const current = pi.getActiveTools();
  if (
    desiredNames.length !== current.length ||
    desiredNames.some((name, index) => name !== current[index])
  ) {
    pi.setActiveTools([...desiredNames]);
  }
}

/**
 * Rewrite one committed name set (suppression or admitted baseline) in place,
 * preserving the Set identity the stash shares with the live binding.
 */
function commitNameSet(target: Set<string>, names: readonly string[]): void {
  target.clear();
  for (const name of names) target.add(name);
}

/**
 * Synchronize the Toolkit-owned ordinary tool projection.
 *
 * On-demand discovery is an explicit, session-scoped layer on top of the
 * ordinary rules: when the `find_tools` loader is available (discovery enabled
 * and the visible winner is Toolkit-owned), a configured deferred name is
 * omitted from the projection unless `find_tools` loaded it in this session
 * (`discovered`). Losing the loader restores ordinary owned exposure and does
 * not rewrite a foreign `find_tools` winner. Loaded names then follow the
 * ordinary rule for their feature, so disabling the feature or losing
 * ownership removes them again without reviving a user-disabled name.
 * `find_tools` itself is an independently checked owned name: active only when
 * discovery is enabled and the visible winner is Toolkit-owned.
 */
export function syncOwnedTool(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "setActiveTools">,
  config: ToolkitConfig,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry"> &
    Partial<Pick<ExtensionContext, "hasUI">>,
  /** Resolved extension identity; `undefined` owns nothing (see `toolkitSourcePath`). */
  sourcePath: string | undefined,
  syncOptions: OwnedToolSyncOptions = {},
): OwnedToolSyncPlan {
  const plan = planOwnedToolSync(pi, config, ctx, sourcePath, syncOptions);
  applyDesiredTools(pi, plan.desiredNames);
  if (syncOptions.nativeSuppressed) {
    commitNameSet(syncOptions.nativeSuppressed, plan.suppressedNames);
  }
  if (syncOptions.nativeBaseline) {
    commitNameSet(syncOptions.nativeBaseline, plan.baselineNames);
  }
  return plan;
}

/** Embedder options; the default extension export supplies none of them. */
export interface PiCodexToolkitOptions {
  /**
   * Generic invocation seam for the direct tools and the nested Code Mode
   * adapters. The Toolkit ships no built-in caller and derives nothing from a
   * particular orchestrator: an embedder supplies the trusted per-call
   * environment and the applicable policy decision.
   */
  invocationHooks?: ExecutionInvocationHooks;
  /**
   * Extension identity for ownership comparisons, pinned by the embedder —
   * normally `fileURLToPath(import.meta.url)` in the extension file Pi loads.
   * Omitted, the factory resolves it from the registrations Pi reports, which
   * is enough for the documented wrapper; pin it when the embedder wants that
   * identity fixed rather than detected. Pinning is also the only way to keep
   * an identity while none of this factory's registrations is visible: an
   * unresolved identity owns nothing.
   */
  sourcePath?: string;
}

/**
 * Build the extension factory with embedder options. Pi loads the default
 * export, which installs no hooks; an embedder that wants the invocation seam
 * registers the factory this returns instead.
 */
export function createPiCodexToolkit(
  options: PiCodexToolkitOptions = {},
): (pi: ExtensionAPI) => void {
  return (pi) => piCodexToolkit(pi, options);
}

export default function piCodexToolkit(
  pi: ExtensionAPI,
  options: PiCodexToolkitOptions = {},
): void {
  const store = new ConfigStore(getConfigPath());
  /**
   * Parameter schema identity of every tool this factory registers, recorded
   * by `registerOwnedTool` so the extension path Pi attributes to them can be
   * resolved later. The recorded objects are this factory's clones, never the
   * module-level schema constants, so a registration is proof of *this*
   * factory rather than of the module.
   */
  const registeredSchemas = new Map<string, unknown>();
  const registerOwnedTool: ExtensionAPI["registerTool"] = (tool) => {
    // Per-factory identity, not per-module: `EXEC_COMMAND_SCHEMA`, the
    // Computer Use schemas and any other shared constant are one object per
    // module instance, so two factories built from it would hand Pi the same
    // reference and each could read the other's registration as its own.
    // The clone keeps the JSON shape and validation behaviour byte-identical.
    const parameters = cloneToolSchema(tool.parameters);
    registeredSchemas.set(tool.name, parameters);
    pi.registerTool({ ...tool, parameters });
  };
  /**
   * The extension identity every ownership comparison in this factory uses.
   * Pi attributes tools to the extension file it loaded, which is this module
   * for the default export and the embedder's file for a
   * `createPiCodexToolkit(…)` wrapper. An explicit option pins it; otherwise
   * the first lookup after registration detects it from the host projection
   * and memoizes that answer.
   *
   * A detection that finds nothing stays **unresolved** and is not memoized:
   * this factory owns nothing until one of its own registrations is visible
   * again. There is no fallback to this module's path — another factory built
   * from the same module reports that same path, so the fallback would claim
   * its registrations — and an unresolved identity answers `absent` for every
   * name, which leaves the routes unavailable with their ordinary admission
   * notes rather than inventing a conflict.
   */
  let boundSourcePath =
    typeof options.sourcePath === "string" && options.sourcePath.length > 0
      ? options.sourcePath
      : undefined;
  const toolkitSourcePath = (): string | undefined => {
    if (boundSourcePath !== undefined) return boundSourcePath;
    const detected = detectExtensionSourcePath(
      pi.getAllTools(),
      registeredSchemas,
    );
    if (detected === undefined) return undefined;
    boundSourcePath = detected;
    return detected;
  };
  // Files are lazy and belong to the Pi session, not feature enablement.
  let outputOwner = new ExecutionOutputOwner();
  let shellManager = new ShellSessionManager({ outputOwner });
  let codeModeManager: CodeModeCellManager | undefined;
  let sessionStopped = false;
  const computerUse = new ComputerUseLifecycle(() => sessionStopped);
  let executionShutdown: Promise<void> | undefined;
  let codeModeConflict = false;
  // Builtin names this factory's committed projection suppressed, and the
  // admitted-native baseline this host lineage started with; both hydrated
  // from the process-global stash entry at session_start — or at the first
  // sync that resolves this factory's identity — so a host reload restores
  // natives it cannot distinguish from a fresh baseline.
  let nativeSuppressed = new Set<string>();
  let nativeBaseline = new Set<string>();
  /**
   * A session lineage whose native provenance this factory could not hydrate
   * at `session_start` because its identity was still unresolved. An
   * unresolved factory owns nothing, so it may not create, replace or delete
   * the stash entry another factory keeps for the same session; the next sync
   * retries with this lineage and reason until one resolves an identity.
   */
  let pendingNativeHydration:
    | { reason: SessionStartEvent["reason"]; session: string }
    | undefined;
  /**
   * Set once a committed projection of this binding actually suppressed a
   * builtin. It closes the deferred hydration above for good: a factory that
   * has hidden a builtin can no longer read an unfiltered admitted baseline,
   * and a retry could only replace the sets that record that suppression with
   * the empty ones a filtered list produces. Hydration runs ahead of the
   * first suppressing plan (`adoptResolvedProvenance`), so a pending record
   * never survives into that commit; this flag is what keeps it so.
   */
  let nativeSuppressionCommitted = false;
  /**
   * Point this binding's `nativeSuppressed`/`nativeBaseline` at the stash
   * entry for its own identity and session lineage.
   *
   * Identity resolves **first**, because it is half of the stash key: a
   * factory that can prove no identity owns no name in this host, so it has
   * no provenance to keep and may not touch a record another factory keeps.
   * Registration precedes `session_start`, so a factory whose registrations
   * are visible resolves here; one whose names another factory won stays
   * unresolved, writes nothing and retries at its next sync instead of
   * replacing the winner's history with empty sets.
   *
   * A retry can also land **inside** a sync, at the first plan that resolves
   * an identity — an embedder may publish its registrations late, and Pi
   * activates them as soon as it does. That plan is also the first one that
   * can hide a builtin, so hydration precedes it and the admitted baseline it
   * records is read while those builtins are still visible.
   */
  const hydrateNativeProvenance = (
    reason: SessionStartEvent["reason"],
    session: string | undefined,
  ): void => {
    const identity = toolkitSourcePath();
    const allTools = pi.getAllTools();
    const active = new Set(pi.getActiveTools());
    // Builtin winners this host admits right now: what a fresh lineage starts
    // from, and what a reload unions onto the inherited baseline.
    const admitted = new Set(
      PI_REPLACED_BUILTINS.filter(
        (name) => active.has(name) && isBuiltinWinner(allTools, name),
      ),
    );
    pendingNativeHydration =
      identity === undefined && session !== undefined
        ? { reason, session }
        : undefined;
    if (identity === undefined || session === undefined) {
      // Unresolved identity: nothing is written, so the owner's record
      // survives. Without a readable session identity the entry is
      // per-binding, which matches the old baseline's capture boundary.
      nativeSuppressed = new Set();
      nativeBaseline = admitted;
      return;
    }
    const stash = nativeSuppressionStash();
    let lineages = stash.get(identity);
    if (lineages === undefined) {
      lineages = new Map<string, NativeSuppressionEntry>();
      stash.set(identity, lineages);
    }
    // Only "reload" shares this lineage: it inherits the entry and unions its
    // baseline with the currently active builtin winners. Every other reason
    // builds a fresh runtime from the current defaults — createAgentSession
    // resolves initialActiveToolNames from settings, never from the old
    // host's filtered projection — so the baseline is recaptured from those
    // winners and suppression starts empty. A forked host gets those fresh
    // defaults too, not the parent's filtered list.
    const inherited = reason === "reload" ? lineages.get(session) : undefined;
    const entry: NativeSuppressionEntry = inherited
      ? {
          baseline: new Set([...inherited.baseline, ...admitted]),
          suppressed: inherited.suppressed,
        }
      : { baseline: admitted, suppressed: new Set() };
    nativeSuppressed = entry.suppressed;
    nativeBaseline = entry.baseline;
    lineages.set(session, entry);
  };
  let appliedRoutes: ExecutionRoutes | undefined;
  // Per-plan start fence, assigned synchronously when a sync computes its
  // candidate projection — before any cleanup await — and never cleared by a
  // failed apply. A pending contraction denies the newly disallowed
  // capability's fresh starts even while the retained committed projection
  // keeps continuation controls reachable. `patch`/`shell` cover the whole
  // capability (direct or nested; needsShellBackend is already the
  // direct-or-code union). A re-plan that changes the routes becomes the
  // candidate and reassigns these flags before running its own cleanup, so
  // after a successful commit each flag is the committed capability's
  // absence; a rejected apply keeps the failing candidate's value.
  const deniedStarts = { patch: false, shell: false, code: false };
  // The last apply rejection still outstanding. The committed projection is
  // authoritative, so status reports the pending failure rather than a
  // candidate route set; fixed text only, a rejection can carry paths.
  let lastSyncError: string | undefined;
  // A Code manager close that rejected and has not since been retried
  // successfully. Tracked independently of `syncGeneration`: a newer
  // projection can supersede the attempt that observed the failure, but the
  // retained manager keeps its admission fenced either way (accepted N3), so
  // status, diagnostics and the next `exec` read this flag rather than the
  // generation that happened to see it.
  let codeModeCleanupPending = false;
  /** Fixed status text for an outstanding cleanup; never a rejection reason. */
  const pendingCleanupError = (): string | undefined =>
    codeModeCleanupPending
      ? "Code Mode cleanup did not confirm; that manager admits no new cell until the cleanup succeeds. Retained cells keep wait/terminate, and the next lifecycle recovery (/pct reload, a model change or session replacement) retries the cleanup before rebinding"
      : undefined;
  // Direct Pi dispatch gate. An ownership conflict is deliberately not part of
  // it: a foreign winner is reported as `conflicting-tool-name` and Pi dispatches
  // to that winner, so folding the conflict in here would change a classification
  // this gate has no business touching. The nested Code Mode adapter keeps its
  // own predicate below, including its ownership recheck.
  const applyPatchToolEnabled = (): boolean =>
    !sessionStopped &&
    (appliedRoutes?.directPatch ?? false) &&
    // Direct Patch is always a fresh mutation, never retained work.
    !deniedStarts.patch;
  const shellAdapterEnabled = (): boolean =>
    !sessionStopped &&
    (appliedRoutes?.needsShellBackend ?? false) &&
    !SHELL_TOOLS.some((name) =>
      visibleForeignToolConflict(pi.getAllTools(), name, toolkitSourcePath()),
    );
  // `exec_command` starts follow the pending fence; `write_stdin` keeps the
  // committed projection's continuation control on retained sessions.
  const shellStartEnabled = (): boolean =>
    shellAdapterEnabled() && !deniedStarts.shell;
  // Stable definitions/adapters resolve current bindings after session replacement.
  const shellExecutor = {
    start: (...args: Parameters<ShellSessionManager["start"]>) =>
      shellManager.start(...args),
    write: (...args: Parameters<ShellSessionManager["write"]>) =>
      shellManager.write(...args),
    close: () => shellManager.close(),
    continuation: (id: string) => shellManager.continuation(id),
  };
  /** Deferred names loaded through `find_tools` in this session. */
  const discoveredTools = new Set<string>();
  const codeModeAdapters = new CodeModeAdapters({
    shell: shellExecutor,
    shellStartEnabled: shellStartEnabled,
    shellContinueEnabled: shellAdapterEnabled,
    applyPatch: {
      definition: APPLY_PATCH_TOOL_DEFINITION,
      isEnabled: () =>
        !sessionStopped &&
        (appliedRoutes?.nestedPatch ?? false) &&
        // A nested Patch call is a fresh mutation too: the pending
        // contraction fence applies on top of the committed route.
        !deniedStarts.patch &&
        // Recheck ownership at dispatch time: a visible third-party apply_patch
        // winner disables the nested adapter even if configuration is
        // unchanged. A filtered/absent name is not a conflict because nested
        // dispatch goes through this extension's own executor.
        !visibleForeignToolConflict(
          pi.getAllTools(),
          APPLY_PATCH_TOOL,
          toolkitSourcePath(),
        ),
    },
    approvalMode: () => store.snapshot.config.codeMode.approvalMode,
    ...(options.invocationHooks
      ? { invocationHooks: options.invocationHooks }
      : {}),
  });
  const codeModeToolsEnabled = (): boolean =>
    !sessionStopped &&
    (appliedRoutes?.code ?? false) &&
    !codeModeConflict &&
    !CODE_MODE_TOOLS.some((name) =>
      visibleForeignToolConflict(pi.getAllTools(), name, toolkitSourcePath()),
    );
  // `exec` admits a new cell, so it follows the pending fence; `wait` keeps
  // the committed projection's observation/terminate control on retained
  // cells after a failed contraction.
  const codeModeAdmissionEnabled = (): boolean =>
    codeModeToolsEnabled() && !deniedStarts.code;
  const getCodeModeManager = (
    purpose: CodeModeManagerPurpose,
  ): CodeModeCellManager | undefined => {
    if (!codeModeToolsEnabled()) return undefined;
    // `observe` keeps reaching the retained manager: a failed close fences
    // its admission but leaves its cells' wait/terminate controls reachable
    // (accepted N3). `admit` is never handed that manager — it could only
    // reject the cell — and says what recovers it. Retrying the cleanup and
    // rebinding belong to the lifecycle path (`/pct reload`, a model change,
    // session replacement), which is the only place allowed to rebind.
    if (purpose === "admit" && codeModeManager?.admissionClosed === true) {
      throw new CodeModeError(
        "closed",
        "Code Mode is not active: this session's cell manager was closed and its cleanup is still outstanding, so it admits no new cell. Retained cells keep wait and terminate. Run /pct reload (or change the model) to retry the cleanup and rebind.",
      );
    }
    if (!codeModeManager) {
      codeModeManager = new CodeModeCellManager({
        dispatcher: codeModeAdapters,
        outputOwner,
      });
    }
    return codeModeManager;
  };

  /**
   * Recheck one managed deferred name at call time. Ownership requires a
   * visible winning registration from this extension: a foreign winner is a
   * conflict, and an absent name (for example removed by a Pi `--tools`
   * allowlist) cannot be activated because `setActiveTools` ignores unknown
   * names. Feature enablement and decision-gated runtime decisions match the
   * ordinary synchronization rules, so discovery can never revive a name that
   * sync would immediately remove.
   */
  const baseToolEligibility = (
    name: string,
    ctx: ExtensionContext,
  ): EligibilityResult => {
    const ownership = inspectToolOwnership(
      pi.getAllTools(),
      name,
      toolkitSourcePath(),
    );
    switch (ownership.state) {
      case "absent":
        return { ok: false, reason: DISCOVERY_NOT_REGISTERED_REASON };
      case "foreign":
        return { ok: false, reason: DISCOVERY_CONFLICT_REASON };
      case "owned":
        break;
    }

    const config = store.snapshot.config;
    if (name === WEB_SEARCH_TOOL) {
      const decision = runtimeDecision(config, ctx);
      if (decision.effective === "sidecar") return { ok: true };
      return {
        ok: false,
        reason:
          decision.effective === "unavailable"
            ? decision.reason
            : decision.effective === "off"
              ? DISCOVERY_DISABLED_REASON
              : DISCOVERY_NATIVE_BACKEND_REASON,
      };
    }
    if (name === IMAGE_GENERATION_TOOL) {
      const decision = runtimeImageGenerationDecision(config, ctx);
      if (decision.effective === "active") return { ok: true };
      return {
        ok: false,
        reason:
          decision.effective === "unavailable"
            ? decision.reason
            : DISCOVERY_DISABLED_REASON,
      };
    }
    // Deferred names follow the committed projection — the same state tool
    // execution and status report — intersected with the pending start
    // fence, so a failed apply never makes a nested-only or newly denied
    // name loadable. The candidate resolver only runs before the first
    // committed sync.
    const committed =
      appliedRoutes ??
      resolveToolkitRoutes(
        config,
        ctx.model,
        inspectExecutionAdmission(pi.getAllTools(), toolkitSourcePath()),
      );
    if (name === APPLY_PATCH_TOOL) {
      if (isNestedOnlyName(name, committed)) {
        return { ok: false, reason: DISCOVERY_NESTED_ONLY_REASON };
      }
      return committed.directPatch && !deniedStarts.patch
        ? { ok: true }
        : { ok: false, reason: DISCOVERY_DISABLED_REASON };
    }
    if (SHELL_TOOLS.includes(name)) {
      if (isNestedOnlyName(name, committed)) {
        return { ok: false, reason: DISCOVERY_NESTED_ONLY_REASON };
      }
      return committed.directShell && !deniedStarts.shell
        ? { ok: true }
        : { ok: false, reason: DISCOVERY_DISABLED_REASON };
    }
    if (CODE_MODE_TOOLS.includes(name)) {
      return committed.code && !deniedStarts.code
        ? { ok: true }
        : { ok: false, reason: DISCOVERY_DISABLED_REASON };
    }
    if (COMPUTER_USE_TOOLS.some((toolName) => toolName === name)) {
      const decision = runtimeComputerUseDecision(config, ctx);
      if (decision.effective === "active") return { ok: true };
      return {
        ok: false,
        reason:
          decision.effective === "unavailable"
            ? decision.reason
            : DISCOVERY_DISABLED_REASON,
      };
    }
    // Unreachable while DEFERRABLE_TOOL_NAMES stays the union of the feature
    // lists above (enforced by a drift test); fail closed for a future name.
    return { ok: false, reason: DISCOVERY_DISABLED_REASON };
  };

  /**
   * Shell Sessions and Code Mode are atomic pairs. A deferred member loads
   * only when its sibling passes the same eligibility check, so a foreign or
   * absent sibling can never split the pair. Loading still activates only the
   * requested name; the Computer Use group is the sole load-time expansion.
   */
  const toolEligibility = (
    name: string,
    ctx: ExtensionContext,
  ): EligibilityResult => {
    const group = [SHELL_TOOLS, CODE_MODE_TOOLS].find((members) =>
      members.includes(name),
    );
    // Surface a foreign or absent sibling's own reason before the shared
    // route check can mask it as a plain disablement.
    if (group) {
      for (const sibling of group) {
        if (sibling === name) continue;
        const ownership = inspectToolOwnership(
          pi.getAllTools(),
          sibling,
          toolkitSourcePath(),
        );
        if (ownership.state !== "owned") {
          return baseToolEligibility(sibling, ctx);
        }
      }
    }
    const own = baseToolEligibility(name, ctx);
    if (!own.ok) return own;
    if (!group) return { ok: true };
    for (const sibling of group) {
      if (sibling === name) continue;
      const siblingResult = baseToolEligibility(sibling, ctx);
      if (!siblingResult.ok) return siblingResult;
    }
    return { ok: true };
  };

  const closeCodeModeManager = async (): Promise<void> => {
    const manager = codeModeManager;
    if (!manager) {
      // Nothing is retained, so no cleanup is outstanding.
      codeModeCleanupPending = false;
      return;
    }
    try {
      await manager.close();
    } catch (error) {
      // Record the outstanding cleanup here, where it is observed, not at the
      // commit that happens to survive: a newer projection can supersede this
      // attempt while the manager it failed to release stays fenced.
      codeModeCleanupPending = true;
      throw error;
    }
    codeModeCleanupPending = false;
    // A rejected cleanup must retain the manager and its unsettled effects.
    if (codeModeManager === manager) codeModeManager = undefined;
  };
  const shutdownExecution = (): Promise<void> => {
    sessionStopped = true;
    if (executionShutdown) return executionShutdown;
    executionShutdown = (async () => {
      const results = await Promise.allSettled([
        shellManager.close(),
        closeCodeModeManager(),
      ]);
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (rejected) throw rejected.reason;
      // Remove files only after producer cleanup is confirmed. Failed cleanup
      // retains both manager responsibility and this output owner for retry.
      await outputOwner.close();
    })().finally(() => {
      executionShutdown = undefined;
    });
    return executionShutdown;
  };
  /**
   * Publish the owned diagnostics record for the projection that is actually
   * live. Host reads happen here, after the caller settled the projection, so
   * the admitted/visible sets are the host's answer rather than a plan's
   * intent. Listener failures are the bus's business; a sync never depends on
   * this record being consumed.
   */
  const emitExecutionDiagnostics = (
    ctx: ExtensionContext,
    routes: ExecutionRoutes,
    cleanupPending: boolean,
  ): void => {
    const tools = pi.getAllTools();
    const approvalTransport: ExecutionApprovalTransport = hasMutationApprovalUI(
      ctx,
    )
      ? "dialog"
      : "unavailable";
    pi.events.emit(
      EXECUTION_DIAGNOSTICS_EVENT,
      buildExecutionDiagnostics({
        routes,
        ...(ctx.model
          ? { model: { provider: ctx.model.provider, id: ctx.model.id } }
          : {}),
        names: EXECUTION_TOOL_NAMES,
        admitted: EXECUTION_TOOL_NAMES.filter(
          (name) =>
            inspectToolOwnership(tools, name, toolkitSourcePath()).state ===
            "owned",
        ),
        active: pi.getActiveTools(),
        hiddenNatives: PI_REPLACED_BUILTINS.filter((name) =>
          nativeSuppressed.has(name),
        ),
        approvalTransport,
        cleanupPending,
        configRevision: store.revision,
        toolkit: toolkitIdentity(),
      }),
    );
  };
  interface SessionSyncOptions {
    /**
     * session_tree only: Pi replays a transcript tool declaration that can
     * predate a suppression-clearing restore, so baseline-member absences
     * are reclaimed as this projection's suppression rather than treated as
     * external removals.
     */
    reconcileBaseline?: boolean;
  }
  // Each syncNow increments this at entry. After an await, only the latest
  // generation may commit: an older plan must not overwrite a newer
  // selection, and overlapping model_select hooks must not wait for each
  // other's cleanup. Pi does not serialize setModel().
  let syncGeneration = 0;
  const syncNow = async (
    ctx: ExtensionContext,
    options?: SessionSyncOptions,
  ): Promise<void> => {
    // Detection needs the host tool list, so a factory can reach
    // `session_start` without an identity. Retry the hydration it deferred —
    // synchronously, before this sync captures the provenance sets. A
    // registration published later can resolve the identity mid-sync, so
    // `adoptResolvedProvenance` retries before every plan as well; between
    // the two a hydration never lands between a plan and the commit that
    // writes into that plan's sets. While it stays unresolved this factory
    // owns no name, hides no builtin and still records nothing.
    //
    // The retry is a **first** hydration only. Once this binding has
    // committed a suppression the deferred record is abandoned: the sets it
    // already holds are that suppression's provenance, and re-reading a
    // baseline from the list this factory itself filtered would replace them
    // with empty ones. Hydration ahead of the first suppressing plan keeps
    // that case unreachable; this is the rule that states it.
    if (nativeSuppressionCommitted) pendingNativeHydration = undefined;
    if (pendingNativeHydration) {
      hydrateNativeProvenance(
        pendingNativeHydration.reason,
        pendingNativeHydration.session,
      );
    }
    const generation = ++syncGeneration;
    // One snapshot for this sync: the plan before cleanup and the plan that
    // commits after it must decide from the same configuration, so only the
    // host state can differ between them.
    const config = store.snapshot.config;
    // Discovery state is per factory/session. While discovery is off, forget
    // loaded names so re-enabling starts with every deferred name hidden
    // again instead of re-exposing a stale session choice. A find_tools
    // conflict or absence does not clear this set: the loader is often
    // transient, and forgetting would hide names the user already loaded
    // once it returns.
    if (!config.toolDiscovery.enabled) discoveredTools.clear();
    // The suppression and baseline sets the candidate plan reads are the ones
    // committed back on success; capture both halves of the stash entry here
    // so planning and the commit can never write into different objects. A
    // deferred hydration that resolves inside this sync re-captures the pair
    // before the plan that reads it, so the two stay the same objects.
    let suppressed = nativeSuppressed;
    let baseline = nativeBaseline;
    let planOptions: OwnedToolSyncOptions = {
      discovered: [...discoveredTools],
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
      reconcileBaseline: options?.reconcileBaseline === true,
    };
    /**
     * Bumped when a deferred hydration resolves inside this sync. A plan
     * built before that point read the pre-hydration sets, so its names may
     * not be committed into the entry hydration just attached.
     */
    let provenanceEpoch = 0;
    /**
     * Hydrate a deferred `session_start` record as soon as this factory's
     * identity resolves. An embedder can publish its registrations late — Pi
     * activates them at `registerTool`, so this can happen while a sync
     * awaits its owned-resource cleanup — and the first plan that sees them
     * is also the first plan that can hide a builtin. Running here, directly
     * before that plan and from the host state it is about to read, keeps
     * both halves true: the admitted baseline is captured while the builtins
     * this factory has never hidden are still visible, and the stash entry
     * exists before the commit that records the suppression into it.
     *
     * A still-unresolved identity changes nothing: this sync keeps the
     * per-binding sets it captured, because a factory that proves no identity
     * owns no name, admits no route and therefore hides no builtin.
     */
    const adoptResolvedProvenance = (): void => {
      const pending = pendingNativeHydration;
      if (!pending || toolkitSourcePath() === undefined) return;
      hydrateNativeProvenance(pending.reason, pending.session);
      suppressed = nativeSuppressed;
      baseline = nativeBaseline;
      planOptions = {
        ...planOptions,
        nativeSuppressed: suppressed,
        nativeBaseline: baseline,
      };
      provenanceEpoch += 1;
    };
    // Planning never mutates the committed name sets, so the same options
    // replan identically against fresh host state after cleanup. The
    // transition is captured beside the plan because the flags that decide
    // cleanup — a visible foreign shell winner, an unavailable Code pair, a
    // Computer Use client this plan no longer keeps — are read from the host
    // and the lifecycle at planning time.
    const planCandidate = (): SyncCandidate => {
      // Hydration precedes the plan, so the first projection that can hide a
      // builtin already reads — and the commit that publishes it already
      // writes — the stash entry that records the suppression.
      adoptResolvedProvenance();
      const plan = planOwnedToolSync(
        pi,
        config,
        ctx,
        toolkitSourcePath(),
        planOptions,
      );
      return {
        plan,
        provenance: provenanceEpoch,
        transition: {
          directPatch: plan.routes.directPatch,
          nestedPatch: plan.routes.nestedPatch,
          directShell: plan.routes.directShell,
          code: plan.routes.code,
          needsShellBackend: plan.routes.needsShellBackend,
          shellForeignConflict: SHELL_TOOLS.some((name) =>
            visibleForeignToolConflict(
              pi.getAllTools(),
              name,
              toolkitSourcePath(),
            ),
          ),
          codeModeConflict: plan.codeModeConflict,
          computerUseFullCleanup:
            plan.computerUseDecision.effective !== "active" ||
            plan.computerUseConflict ||
            computerUse.approvalModeChanged(config.computerUse.approvalMode),
        },
      };
    };
    /**
     * Publish this candidate's start fence, run the cleanups its routes
     * require and wait for them. Returns `true` when a newer sync superseded
     * this one — checked both before the fence and after the cleanup, so a
     * superseded pass publishes nothing and starts nothing; throws the
     * rejection reason after recording the apply failure. Cleanup obligations
     * always belong to the candidate that may commit next, so a contraction
     * can never be published without its cleanup.
     */
    const settleTransition = async (
      candidate: SyncCandidate,
    ): Promise<boolean> => {
      const { transition } = candidate;
      // The loop resumes from its previous pass in a microtask, so a newer
      // sync can have started since that pass's generation check. Re-read the
      // generation here, synchronously before the fence and the cleanup: a
      // superseded pass must neither publish an older fence over the newer
      // sync's nor run a contraction's cleanup against resources the newer
      // selection keeps. Pass 1 reaches this line without an await, but its
      // planning already read the host, which can reenter this factory, so it
      // is checked here too rather than assumed current.
      if (generation !== syncGeneration) return true;
      // The start fence follows the plan, not the commit: a fresh mutation or
      // session start the candidate projection disallows is denied from here
      // on, even when the cleanup below fails and the committed projection —
      // with its retained continuation controls — stays. A re-plan that
      // changes the routes becomes the candidate, so the fence and the
      // cleanup keep describing the same intent; both are assigned
      // synchronously after the generation check, so a newer sync's fence is
      // never overwritten by an older one.
      deniedStarts.patch = !(transition.directPatch || transition.nestedPatch);
      deniedStarts.shell = !transition.needsShellBackend;
      deniedStarts.code = !transition.code;
      // Contraction intent is evaluated against the candidate plan, not the
      // committed routes: the new projection publishes only after the cleanup
      // it requires has settled.
      const wantShell =
        !sessionStopped &&
        transition.needsShellBackend &&
        !transition.shellForeignConflict;
      const wantCode =
        !sessionStopped && transition.code && !transition.codeModeConflict;
      const cleanups: Promise<void>[] = [];
      // Full versus pending-only is the candidate's own obligation, compared
      // in `sameExecutionTransition`: a re-plan that newly owes the full
      // disposal becomes the candidate and runs it before it can commit.
      cleanups.push(
        transition.computerUseFullCleanup
          ? computerUse.cleanup()
          : computerUse.cleanup(true),
      );
      if (!wantShell) {
        cleanups.push(shellManager.close());
      }
      // Disablement and owned-name conflicts terminate cells; an unchanged
      // reload or ordinary model change leaves the live manager untouched.
      // A retained manager whose earlier close actually rejected is the
      // exception: its admission stays fenced, so it can never run another
      // cell, and this lifecycle sync retries that cleanup even while Code
      // stays on. Only a confirmed cleanup releases the binding, and the next
      // `exec` then builds a fresh manager; a second failure is reported
      // again. A newer selection that still wants Code neither starts nor
      // joins a first close attempt — it commits while that attempt runs, so
      // it never waits for an older sync's cleanup. Once a failure has been
      // recorded, `close()` installs one shared attempt, so a sync arriving
      // during a retry joins that bounded attempt instead of starting a
      // second teardown.
      if (codeModeManager && (!wantCode || codeModeCleanupPending)) {
        cleanups.push(closeCodeModeManager());
      }
      // Both cleanups always run; a failing Computer Use close must not skip
      // releasing shell resources. Visibility commits only after owned-resource
      // cleanup settles: on rejection the old appliedRoutes, recorded
      // suppression, and the active list all stay, so retained managers and
      // cells keep reachable wait/terminate/write_stdin controls while the
      // manager's own close() fences new admission. The sync path still
      // surfaces the failure.
      const results = await Promise.allSettled(cleanups);
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      // A newer selection can run its hook while this cleanup is still
      // awaiting. Committing the plan captured before that await would
      // replace the newer projection. A superseded attempt also must not
      // surface its cleanup failure as the live apply error — the newer
      // sync owns the fence, the commit, and any failure it still observes.
      if (generation !== syncGeneration) {
        // Cleanup settlement is not a projection decision, so it is not
        // superseded with the plan: the retained owners this attempt failed to
        // release are still outstanding against whatever the newer sync
        // committed. Republish that live projection with the failure flagged
        // instead of letting it disappear.
        if (rejected && appliedRoutes) {
          emitExecutionDiagnostics(ctx, appliedRoutes, true);
        }
        return true;
      }
      if (rejected) {
        // The committed projection stays authoritative; status reports the
        // pending apply failure with fixed text — a rejection reason can carry
        // paths or process detail that must not reach the status output.
        lastSyncError =
          "applying the configuration failed during owned-resource cleanup; the previously committed tool projection remains active";
        // Diagnostics describe the live projection, so a rejection reports the
        // retained committed routes with the outstanding failure flagged. A
        // rejection before the first commit has no committed projection to
        // describe and publishes nothing.
        if (appliedRoutes) emitExecutionDiagnostics(ctx, appliedRoutes, true);
        throw rejected.reason;
      }
      return false;
    };
    // Re-plan against fresh host state before committing. The awaited cleanup
    // is long enough for another extension or the user to disable a visible
    // builtin, activate a foreign tool or win an owned execution name, and
    // writing the whole list captured before that await would silently revert
    // their change. When that fresh plan keeps the same routes it also needs
    // the same cleanup, so it commits; when it does not, it becomes the
    // candidate and the cleanup its routes require runs before it can commit —
    // a contraction is never published with live work still running behind it.
    let candidate = planCandidate();
    let committed: OwnedToolSyncPlan | undefined;
    for (let pass = 1; committed === undefined; pass++) {
      if (await settleTransition(candidate)) return;
      // `settleTransition`'s own check runs before it returns, and this
      // `await` is another promise boundary: a newer sync can start in it,
      // publish its fence and commit its projection. Recheck before doing
      // anything else — a superseded loop re-plans nothing, runs no further
      // cleanup and leaves the newer sync's fence alone.
      if (generation !== syncGeneration) return;
      const fresh = planCandidate();
      if (sameExecutionTransition(candidate.transition, fresh.transition)) {
        committed = fresh.plan;
      } else if (pass >= MAX_SYNC_PLANNING_PASSES) {
        if (candidate.provenance !== provenanceEpoch) {
          // The identity resolved on this sync's last pass, so the candidate
          // whose cleanup just ran read the sets hydration has since replaced.
          // Committing its names would write them into the entry that now
          // records this lineage's provenance, so nothing is published here:
          // the natives stay visible, the record stays intact, and the next
          // sync activates the native-hiding routes behind it.
          return;
        }
        // Bounded: the host kept changing routes under this sync. Commit the
        // candidate whose cleanup just ran rather than looping — its routes
        // are settled, and the next sync re-plans against a host that is
        // still moving. Only in this bounded case can the committed name list
        // predate the last cleanup await.
        committed = candidate.plan;
      } else {
        candidate = fresh;
      }
    }
    // The commit is the last point where a newer selection can be observed,
    // and planning reads the host, which can reenter this factory. Recheck
    // once more: publishing a superseded plan here would replace the newer
    // sync's committed projection — removing controls from work it just
    // admitted — and no later sync is guaranteed to put it back.
    if (generation !== syncGeneration) return;
    applyDesiredTools(pi, committed.desiredNames);
    commitNameSet(suppressed, committed.suppressedNames);
    commitNameSet(baseline, committed.baselineNames);
    // This binding has now hidden a builtin, so the deferred hydration above
    // is closed: these sets are the suppression's provenance and no later
    // retry may read a baseline from the list this projection filtered.
    if (committed.suppressedNames.length > 0) nativeSuppressionCommitted = true;
    appliedRoutes = committed.routes;
    codeModeConflict = committed.codeModeConflict;
    lastSyncError = undefined;
    emitExecutionDiagnostics(ctx, committed.routes, codeModeCleanupPending);
  };
  const sync = (
    ctx: ExtensionContext,
    options?: SessionSyncOptions,
  ): Promise<void> => syncNow(ctx, options);
  const status = async (ctx: ExtensionContext): Promise<string> => {
    const epoch = computerUse.epoch;
    await computerUse.cleanup(true);
    computerUse.assertLifetime(epoch);
    const decision = runtimeDecision(store.snapshot.config, ctx);
    const imageGenerationDecision = runtimeImageGenerationDecision(
      store.snapshot.config,
      ctx,
    );
    const tools = pi.getAllTools();
    const activeTools = pi.getActiveTools();
    const conflict = ownedToolConflict(
      tools,
      WEB_SEARCH_TOOL,
      toolkitSourcePath(),
    );
    const imageToolConflict = ownedToolConflict(
      tools,
      IMAGE_GENERATION_TOOL,
      toolkitSourcePath(),
    );
    const applyPatchToolConflict = ownedToolConflict(
      tools,
      APPLY_PATCH_TOOL,
      toolkitSourcePath(),
    );
    const computerUseToolConflict = COMPUTER_USE_TOOLS.some((name) =>
      ownedToolConflict(tools, name, toolkitSourcePath()),
    );
    const shellToolConflict = SHELL_TOOLS.some((name) =>
      ownedToolConflict(tools, name, toolkitSourcePath()),
    );
    const codeModeToolConflict = CODE_MODE_TOOLS.some((name) =>
      ownedToolConflict(tools, name, toolkitSourcePath()),
    );
    // Rules-managed rows separate the two ways an owned name can be
    // unavailable: another extension visibly won it, or an allowlist filtered
    // it out. Only the first is `conflicting-tool-name`; the second already
    // has the committed route's admission note.
    const applyPatchForeignConflict = visibleForeignToolConflict(
      tools,
      APPLY_PATCH_TOOL,
      toolkitSourcePath(),
    );
    const shellForeignConflict = SHELL_TOOLS.some((name) =>
      visibleForeignToolConflict(tools, name, toolkitSourcePath()),
    );
    const codeModeForeignConflict = CODE_MODE_TOOLS.some((name) =>
      visibleForeignToolConflict(tools, name, toolkitSourcePath()),
    );
    const findToolsToolConflict = ownedToolConflict(
      tools,
      TOOL_DISCOVERY_TOOL,
      toolkitSourcePath(),
    );
    const deferredTools = resolveDeferredSet(
      store.snapshot.config.toolDiscovery,
    );
    const loaderAvailable =
      store.snapshot.config.toolDiscovery.enabled && !findToolsToolConflict;
    // The committed projection is authoritative for the capability rows, the
    // hidden-by-discovery set and the appended execution block; resolve a
    // candidate only before the first successful sync.
    const statusRoutes =
      appliedRoutes ??
      resolveToolkitRoutes(
        store.snapshot.config,
        ctx.model,
        inspectExecutionAdmission(tools, toolkitSourcePath()),
      );
    // Eager-replacement members are active in the committed projection even
    // when configured deferred, and nested-only members are unreachable
    // through find_tools; neither is hidden by discovery, so neither can flip
    // a capability row to `deferred`.
    const hiddenTools = deferredTools.filter(
      (name) =>
        isHiddenByDiscovery(name, {
          loaderAvailable,
          deferred: deferredTools,
          discovered: discoveredTools,
        }) &&
        !isEagerReplacement(name, statusRoutes) &&
        !isNestedOnlyName(name, statusRoutes),
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
      const probe = computerUse.createProbe(computerUseInspection.runtime);
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
        await computerUse.dispose(probe);
      }
      computerUse.assertLifetime(epoch);
    }
    const searchPathConflict =
      store.snapshot.config.webSearch.enabled &&
      activeTools.includes("web_search");
    const text = formatStatus(
      projectStatus({
        config: store.snapshot.config,
        configPath: store.path,
        configError: store.snapshot.readError,
        configErrorDetail: store.snapshot.readErrorDetail,
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
        shellConflict: shellToolConflict,
        shellRuntimeAvailable: inspectShellRuntime().ok,
        codeModeConflict: codeModeToolConflict,
        applyPatchForeignConflict,
        shellForeignConflict,
        codeModeForeignConflict,
        executionRoutes: statusRoutes,
        applyError: lastSyncError ?? pendingCleanupError(),
        toolDiscovery: {
          deferred: deferredTools,
          hidden: hiddenTools,
          loaded: deferredTools.filter(
            (name) => discoveredTools.has(name) && activeTools.includes(name),
          ).length,
          conflict: findToolsToolConflict,
        },
      }),
    );
    return store.snapshot.config.execution
      ? appendExecutionStatus(text, statusRoutes)
      : text;
  };

  registerOwnedTool({
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

  registerOwnedTool({
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
        reason: "route-resolution-failed" as const,
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

  registerOwnedTool(
    createApplyPatchTool(applyPatchToolEnabled, options.invocationHooks),
  );

  // The resolver form: each direct call binds the live manager before its
  // awaited invocation seam, so a call admitted in one session can never
  // spawn on a replacement session's manager.
  for (const tool of createShellTools(() => shellManager, {
    isStartEnabled: shellStartEnabled,
    isContinueEnabled: shellAdapterEnabled,
    ...(options.invocationHooks
      ? { invocationHooks: options.invocationHooks }
      : {}),
  })) {
    registerOwnedTool(tool);
  }

  for (const tool of createCodeModeTools({
    getManager: getCodeModeManager,
    isExecEnabled: codeModeAdmissionEnabled,
    isWaitEnabled: codeModeToolsEnabled,
  })) {
    registerOwnedTool(tool);
  }

  for (const tool of createComputerUseTools(
    async (method, args, signal, ctx) => {
      const epoch = computerUse.epoch;
      await computerUse.cleanup(true);
      computerUse.assertLifetime(epoch);
      if (
        computerUse.approvalModeChanged(
          store.snapshot.config.computerUse.approvalMode,
        )
      ) {
        await computerUse.cleanup();
        computerUse.assertLifetime(epoch);
      }
      const inspection = inspectComputerUseRuntime();
      const decision = runtimeComputerUseDecision(
        store.snapshot.config,
        ctx,
        inspection,
      );
      if (
        decision.effective !== "active" ||
        !inspection.ok ||
        COMPUTER_USE_TOOLS.some((name) =>
          visibleForeignToolConflict(
            pi.getAllTools(),
            name,
            toolkitSourcePath(),
          ),
        )
      ) {
        throw new Error("Computer Use is not active for the current session.");
      }

      const computerUseClient = computerUse.getOrCreateRuntime(
        inspection.runtime,
        store.snapshot.config.computerUse.approvalMode,
      );
      const approvalMode = store.snapshot.config.computerUse.approvalMode;
      return computerUseClient.invoke(
        method,
        args,
        signal,
        approvalMode === "always"
          ? () => true
          : ctx.hasUI
            ? (message, confirmationSignal) =>
                ctx.ui.confirm("Computer Use access", message, {
                  signal: confirmationSignal,
                })
            : undefined,
      );
    },
  )) {
    registerOwnedTool(tool);
  }

  for (const tool of createToolDiscoveryTool({
    isEnabled: () =>
      store.snapshot.config.toolDiscovery.enabled &&
      !ownedToolConflict(
        pi.getAllTools(),
        TOOL_DISCOVERY_TOOL,
        toolkitSourcePath(),
      ),
    getConfig: () => store.snapshot.config.toolDiscovery,
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
    isEligible: toolEligibility,
    describeTool: (name) =>
      pi.getAllTools().find((tool) => tool.name === name)?.description,
    onLoaded: (names) => {
      const deferred = new Set(
        resolveDeferredSet(store.snapshot.config.toolDiscovery),
      );
      for (const name of names) {
        if (deferred.has(name)) discoveredTools.add(name);
      }
    },
  })) {
    registerOwnedTool(tool);
  }

  registerCommands(pi, {
    store,
    sync,
    status,
    // The editor owns no admission state; preview the draft through the same
    // resolver as the live projection so requested vs effective is visible.
    describeExecutionPreview: (
      rules: readonly ExecutionRule[],
      ctx: ExtensionCommandContext,
    ): string =>
      formatExecutionStatus(
        resolveToolkitRoutes(
          {
            ...store.snapshot.config,
            execution: {
              version: EXECUTION_SCHEMA_VERSION,
              rules: rules.map((rule) => ({ ...rule })),
            },
          },
          ctx.model,
          inspectExecutionAdmission(pi.getAllTools(), toolkitSourcePath()),
        ),
      ),
  });

  pi.on("session_start", async (event, ctx) => {
    // A new, resumed, or forked session starts with deferred tools hidden
    // again; nothing about a previous session's discovery is persisted.
    discoveredTools.clear();
    if (sessionStopped) {
      const epoch = computerUse.epoch;
      // Retry incomplete cleanup before rebinding; never discard owned work.
      const results = await Promise.allSettled([
        shutdownExecution(),
        computerUse.cleanup(),
      ]);
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (rejected) throw rejected.reason;
      if (epoch !== computerUse.epoch)
        throw new ComputerUseClientError("closed");
      outputOwner = new ExecutionOutputOwner();
      shellManager = new ShellSessionManager({ outputOwner });
      // Calls begun while stopped may finish cleanup, not enter this lifetime.
      computerUse.invalidate();
      sessionStopped = false;
    }
    // Hydrate this binding's native provenance from the stash. Pi rebuilds
    // the factory on session.reload() with the already-filtered active list,
    // so the stash — keyed by this factory's resolved identity and then by
    // session file, falling back to session id — is the only record that can
    // restore natives after a rebuild.
    hydrateNativeProvenance(
      event.reason,
      ctx.sessionManager?.getSessionFile?.() ??
        ctx.sessionManager?.getSessionId?.(),
    );
    await store.load();
    await sync(ctx);
    // Without a UI (print and JSON modes) a warning would join the command's
    // own stderr output; `/pct status` still reports the error there.
    const warning = configReadErrorMessage(store);
    if (warning && ctx.hasUI) ctx.ui.notify(warning, "warning");
  });
  pi.on("model_select", async (_event, ctx) => {
    await sync(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    // Tree navigation restores transcript tool declarations before this
    // event; a replayed branch can re-assert a filtered list that predates
    // a suppression-clearing restore. Reconcile: baseline members the replay
    // dropped are claimed back as ours so the ordinary rules restore them.
    await sync(ctx, { reconcileBaseline: true });
  });
  const prepareExecutionReplacement = async (
    _event: unknown,
    ctx: ExtensionContext,
  ): Promise<{ cancel: true } | undefined> => {
    // Pi reports shutdown-hook errors but still replaces the extension factory.
    // Use its cancellable boundary to retain real controls on incomplete cleanup.
    // Do not close the file owner here: another extension may cancel a switch
    // even after our cleanup succeeds, leaving this Pi session in use.
    const leavePreflight = computerUse.enterPreflight();
    const results = await Promise.allSettled([
      shellManager.close(),
      closeCodeModeManager(),
      computerUse.cleanup(),
    ]).finally(leavePreflight);
    if (results.some((result) => result.status === "rejected")) {
      try {
        ctx.ui.notify(
          "Session replacement cancelled: execution or Computer Use cleanup is incomplete. Owned resources and recovery files remain in this session; retry wait/terminate, Computer Use cleanup via tool/status/reload, or the session change. No work was replayed.",
          "error",
        );
      } catch {
        // An unavailable notification must not turn this veto into a hook
        // exception, which Pi would report and then ignore during replacement.
      }
      return { cancel: true };
    }
    return undefined;
  };
  pi.on("session_before_switch", prepareExecutionReplacement);
  pi.on("session_before_fork", prepareExecutionReplacement);
  pi.on("session_shutdown", async (event) => {
    // Quit/reload still have no cancellable preflight. Retain responsibility,
    // but don't promise usable old handles after the host tears this owner down.
    // Run every cleanup, but don't mistake allSettled for successful cleanup.
    computerUse.invalidate();
    sessionStopped = true;
    const results = await Promise.allSettled([
      computerUse.cleanup(),
      shutdownExecution(),
    ]);
    const execution = results[1];
    if (execution.status === "rejected")
      throw new Error(
        `Execution cleanup-incomplete during Pi ${event.reason}: some owned work or files may remain. This teardown cannot be vetoed here; old handles are not usable after replacement. No work was replayed.`,
        { cause: execution.reason },
      );
    const computerUseCleanup = results[0];
    if (computerUseCleanup.status === "rejected")
      throw new Error(
        `Computer Use cleanup-incomplete during Pi ${event.reason}: an owned process or temporary home may remain. This teardown cannot be vetoed here; cleanup references do not survive host replacement. No action was replayed.`,
        { cause: computerUseCleanup.reason },
      );
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
        tools: activeToolSchemas(pi, toolkitSourcePath()),
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
        if (store.snapshot.config.debug) {
          emitProviderRouteResolutionDebug({
            provider: ctx.model.provider,
            api: ctx.model.api,
            model: ctx.model.id,
          });
        }
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
