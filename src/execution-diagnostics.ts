/**
 * Owned execution diagnostics. Each sync that reaches a decision publishes one
 * bounded record describing what the loaded rules requested, what this host
 * admitted and what the live projection exposes, so a child session can report
 * its own resolution without a launcher protocol.
 *
 * The record carries names, flags and a config revision only: never the
 * environment, a command, a patch, program text, an argument or a filesystem
 * path. `src/index.ts` owns the host reads that fill it.
 */

import { readFileSync } from "node:fs";

import {
  isNestedOnlyName,
  type ExecutionNote,
  type ExecutionRoutes,
  type ExecutionSource,
} from "./execution-mode.ts";

/** Shared extension event-bus channel for {@link ExecutionDiagnosticsRecord}. */
export const EXECUTION_DIAGNOSTICS_EVENT =
  "pi-codex-toolkit.execution-diagnostics";

/** Record schema version. Independent of the configuration schema version. */
export const EXECUTION_DIAGNOSTICS_VERSION = 1;

/** Package name reported when the packed manifest cannot be read. */
const FALLBACK_TOOLKIT_NAME = "pi-codex-toolkit";
const UNKNOWN_TOOLKIT_VERSION = "unknown";

/** Whether this session can ask the nested Apply Patch confirmation. */
export type ExecutionApprovalTransport = "dialog" | "unavailable";

export interface ExecutionDiagnosticsRecord {
  version: typeof EXECUTION_DIAGNOSTICS_VERSION;
  /** Absent when the session has no current model. Provider and id only. */
  model?: { provider: string; id: string };
  source: ExecutionSource;
  ruleId?: string;
  requested: { patch: boolean; shell: boolean; code: boolean };
  effective: {
    directPatch: boolean;
    nestedPatch: boolean;
    directShell: boolean;
    code: boolean;
  };
  /** Owned execution names this host registered and this extension won. */
  admittedNames: string[];
  /** Admitted names the live active list exposes at top level. */
  visibleNames: string[];
  /** Admitted names reachable only from inside a Code Mode cell. */
  nestedNames: string[];
  /** Builtin names the committed projection currently suppresses. */
  hiddenNatives: string[];
  notes: ExecutionNote[];
  approvalTransport: ExecutionApprovalTransport;
  /** An owned-resource cleanup rejection is still outstanding. */
  cleanupPending: boolean;
  configRevision: string;
  toolkit: { name: string; version: string };
}

export interface ExecutionDiagnosticsInput {
  /** The routes the live projection committed, not a candidate plan. */
  routes: ExecutionRoutes;
  model?: { provider?: string; id?: string };
  /** Owned execution names in the canonical report order. */
  names: readonly string[];
  /** Subset of `names` whose visible winner is this extension. */
  admitted: readonly string[];
  /** The host's live active list. */
  active: readonly string[];
  /** Builtin names this projection suppresses, in canonical order. */
  hiddenNatives: readonly string[];
  approvalTransport: ExecutionApprovalTransport;
  cleanupPending: boolean;
  configRevision: string;
  toolkit: { name: string; version: string };
}

export function buildExecutionDiagnostics(
  input: ExecutionDiagnosticsInput,
): ExecutionDiagnosticsRecord {
  const admitted = input.names.filter((name) => input.admitted.includes(name));
  const active = new Set(input.active);
  const { requested } = input.routes;
  return {
    version: EXECUTION_DIAGNOSTICS_VERSION,
    // A model identity is reported only when both parts are known; a partial
    // identity would read as a rule target that never matched.
    ...(input.model?.provider !== undefined && input.model.id !== undefined
      ? { model: { provider: input.model.provider, id: input.model.id } }
      : {}),
    source: requested.source,
    ...(requested.ruleId === undefined ? {} : { ruleId: requested.ruleId }),
    requested: {
      patch: requested.patch,
      shell: requested.shell,
      code: requested.code,
    },
    effective: {
      directPatch: input.routes.directPatch,
      nestedPatch: input.routes.nestedPatch,
      directShell: input.routes.directShell,
      code: input.routes.code,
    },
    admittedNames: admitted,
    // A foreign winner is never reported as visible or nested: it is not this
    // extension's registration, whatever the active list says.
    visibleNames: admitted.filter((name) => active.has(name)),
    nestedNames: admitted.filter((name) =>
      isNestedOnlyName(name, input.routes),
    ),
    hiddenNatives: [...input.hiddenNatives],
    notes: [...input.routes.notes],
    approvalTransport: input.approvalTransport,
    cleanupPending: input.cleanupPending,
    configRevision: input.configRevision,
    toolkit: { ...input.toolkit },
  };
}

/**
 * Read the packed package identity. Only `name` and `version` are read, and an
 * unreadable or malformed manifest reports the known extension name with an
 * unknown version rather than guessing one.
 */
export function readToolkitIdentity(manifestPath: string): {
  name: string;
  version: string;
} {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    const manifest = parsed as { name?: unknown; version?: unknown };
    return {
      name:
        typeof manifest.name === "string" && manifest.name.length > 0
          ? manifest.name
          : FALLBACK_TOOLKIT_NAME,
      version:
        typeof manifest.version === "string" && manifest.version.length > 0
          ? manifest.version
          : UNKNOWN_TOOLKIT_VERSION,
    };
  } catch {
    return { name: FALLBACK_TOOLKIT_NAME, version: UNKNOWN_TOOLKIT_VERSION };
  }
}
