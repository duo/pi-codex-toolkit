/**
 * Model-rule matching and route admission. Pure: no filesystem, no Pi host.
 * `src/config.ts` validates the on-disk section; `src/index.ts` supplies
 * current model and registration ownership.
 */

export const EXECUTION_SCHEMA_VERSION = 1;

export const PI_BUILTIN_READ = "read";
export const PI_BUILTIN_BASH = "bash";
export const PI_BUILTIN_EDIT = "edit";
export const PI_BUILTIN_WRITE = "write";

/** Native tools a replacement route may hide. Never includes `read`. */
export const PI_REPLACED_BUILTINS = [
  PI_BUILTIN_BASH,
  PI_BUILTIN_EDIT,
  PI_BUILTIN_WRITE,
] as const;

export interface ExecutionRule {
  id: string;
  match: string;
  patch: boolean;
  shell: boolean;
  code: boolean;
}

export interface ExecutionConfig {
  version: typeof EXECUTION_SCHEMA_VERSION;
  rules: ExecutionRule[];
}

export interface ModelIdentity {
  provider?: string;
  id?: string;
}

export type ExecutionSource = "rules" | "legacy" | "unmatched";

export interface RequestedCapabilities {
  patch: boolean;
  shell: boolean;
  code: boolean;
  source: ExecutionSource;
  ruleId?: string;
}

export interface ExecutionAdmission {
  patchOwnedAdmitted: boolean;
  shellPairAdmitted: boolean;
  codePairAdmitted: boolean;
}

export type ExecutionNote =
  | "code-pair-unavailable"
  | "code-shell-pair-unavailable"
  | "shell-pair-unavailable"
  | "patch-unavailable"
  | "code-unavailable-did-not-promote-patch"
  | "patch-unavailable-kept-native-editing";

export interface ExecutionRoutes {
  requested: RequestedCapabilities;
  directPatch: boolean;
  nestedPatch: boolean;
  directShell: boolean;
  code: boolean;
  needsShellBackend: boolean;
  hideBash: boolean;
  hideEditWrite: boolean;
  notes: ExecutionNote[];
}

const RULE_KEYS = new Set(["id", "match", "patch", "shell", "code"]);

function escapeRegex(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Entire-string, case-sensitive glob. `*` = any run, `?` = one character;
 * every other character is literal. A pattern containing `/` is matched
 * against `provider/id`; otherwise against `id` alone.
 */
export function matchExecutionPattern(
  pattern: string,
  identity: ModelIdentity,
): boolean {
  const target = pattern.includes("/")
    ? identity.provider !== undefined && identity.id !== undefined
      ? `${identity.provider}/${identity.id}`
      : undefined
    : identity.id;
  if (target === undefined) return false;
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += escapeRegex(character);
  }
  source += "$";
  return new RegExp(source, "u").test(target);
}

export function firstMatchingRule(
  rules: readonly ExecutionRule[],
  identity: ModelIdentity,
): ExecutionRule | undefined {
  return rules.find((rule) => matchExecutionPattern(rule.match, identity));
}

export function requestCapabilities(input: {
  execution?: ExecutionConfig;
  legacy: { patch: boolean; shell: boolean; code: boolean };
  model: ModelIdentity;
}): RequestedCapabilities {
  const none: RequestedCapabilities = {
    patch: false,
    shell: false,
    code: false,
    source: "unmatched",
  };
  if (input.execution) {
    if (input.model.id === undefined) return none;
    const rule = firstMatchingRule(input.execution.rules, input.model);
    if (!rule) return none;
    return {
      patch: rule.patch,
      shell: rule.shell,
      code: rule.code,
      source: "rules",
      ruleId: rule.id,
    };
  }
  return {
    patch: input.legacy.patch,
    shell: input.legacy.shell,
    code: input.legacy.code,
    source: "legacy",
  };
}

/**
 * Resolve requested routes against owned admissions. Do not reconstruct a
 * combination by clearing unavailable bits: a failed Code route never becomes
 * direct Shell or direct Patch by omission.
 */
/** Pre-rules boolean flags: additive tools, no native substitution. */
export function resolveLegacyRoutes(
  requested: RequestedCapabilities,
  admission: ExecutionAdmission,
): ExecutionRoutes {
  const directPatch = requested.patch && admission.patchOwnedAdmitted;
  const nestedPatch =
    requested.patch && requested.code && admission.patchOwnedAdmitted;
  const directShell = requested.shell && admission.shellPairAdmitted;
  const code = requested.code && admission.codePairAdmitted;
  return {
    requested,
    directPatch,
    nestedPatch,
    directShell,
    code,
    needsShellBackend: directShell,
    hideBash: false,
    hideEditWrite: false,
    notes: [],
  };
}

export function resolveExecutionRoutes(
  requested: RequestedCapabilities,
  admission: ExecutionAdmission,
): ExecutionRoutes {
  const notes: ExecutionNote[] = [];
  const directShell = requested.shell && admission.shellPairAdmitted;
  if (requested.shell && !admission.shellPairAdmitted) {
    notes.push("shell-pair-unavailable");
  }

  let code = false;
  if (requested.code) {
    // Name the missing dependency: a missing owned exec/wait pair and a
    // missing nested Shell pair fail the same route for different reasons.
    if (!admission.codePairAdmitted) {
      notes.push("code-pair-unavailable");
    } else if (!admission.shellPairAdmitted) {
      notes.push("code-shell-pair-unavailable");
    } else {
      code = true;
    }
  }

  let directPatch = false;
  let nestedPatch = false;
  if (requested.patch && requested.code) {
    if (code) {
      if (admission.patchOwnedAdmitted) nestedPatch = true;
      else notes.push("patch-unavailable-kept-native-editing");
    } else {
      notes.push("code-unavailable-did-not-promote-patch");
    }
  } else if (requested.patch) {
    if (admission.patchOwnedAdmitted) directPatch = true;
    else notes.push("patch-unavailable");
  }

  const hideBash = directShell || code;
  const hideEditWrite = directPatch || nestedPatch;
  return {
    requested,
    directPatch,
    nestedPatch,
    directShell,
    code,
    needsShellBackend: directShell || code,
    hideBash,
    hideEditWrite,
    notes,
  };
}

/** Catch-all `*` rule from legacy flags. All-off yields no rules. */
export function previewLegacyMigration(legacy: {
  patch: boolean;
  shell: boolean;
  code: boolean;
}): ExecutionRule[] {
  if (!legacy.patch && !legacy.shell && !legacy.code) return [];
  return [
    {
      id: "migrated",
      match: "*",
      patch: legacy.patch,
      shell: legacy.shell,
      code: legacy.code,
    },
  ];
}

export function formatRequestedFlags(requested: RequestedCapabilities): string {
  const flags = [
    requested.patch ? "P" : undefined,
    requested.shell ? "S" : undefined,
    requested.code ? "C" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  return flags.length === 0 ? "none" : flags.join("+");
}

export function formatExecutionStatus(routes: ExecutionRoutes): string {
  return [
    "Execution rules:",
    `  schema: ${routes.requested.source}`,
    `  rule: ${routes.requested.ruleId ?? "—"}`,
    `  requested: ${formatRequestedFlags(routes.requested)}`,
    `  effective: ${formatEffectiveRoutes(routes)}`,
    `  hide bash: ${routes.hideBash ? "yes" : "no"}`,
    `  hide edit/write: ${routes.hideEditWrite ? "yes" : "no"}`,
    `  notes: ${routes.notes.join(",")}`,
  ].join("\n");
}

export function appendExecutionStatus(
  text: string,
  routes: ExecutionRoutes,
): string {
  const insertion = formatExecutionStatus(routes);
  const apiLine = text
    .split("\n")
    .find((line) => line.startsWith("Current API:"));
  if (!apiLine) return `${text}\n${insertion}`;
  return text.replace(apiLine, `${apiLine}\n${insertion}`);
}

export function formatEffectiveRoutes(routes: ExecutionRoutes): string {
  const parts: string[] = [];
  if (routes.directPatch) parts.push("directPatch");
  if (routes.nestedPatch) parts.push("nestedPatch");
  if (routes.directShell) parts.push("directShell");
  if (routes.code) parts.push("code");
  return parts.length === 0 ? "native" : parts.join("+");
}

export function isEagerReplacement(
  name: string,
  routes: ExecutionRoutes,
): boolean {
  if (routes.hideEditWrite && name === "apply_patch" && routes.directPatch) {
    return true;
  }
  if (routes.hideBash && routes.directShell) {
    if (name === "exec_command" || name === "write_stdin") return true;
  }
  if (routes.hideBash && routes.code) {
    if (name === "exec" || name === "wait") return true;
  }
  return false;
}

export function isNestedOnlyName(
  name: string,
  routes: ExecutionRoutes,
): boolean {
  if (name === "apply_patch") return routes.nestedPatch && !routes.directPatch;
  if (name === "exec_command" || name === "write_stdin") {
    return routes.needsShellBackend && !routes.directShell;
  }
  return false;
}

/** Fields a rule object may contain. Used by config validation. */
export function executionRuleHasUnknownField(
  value: Record<string, unknown>,
): boolean {
  return Object.keys(value).some((key) => !RULE_KEYS.has(key));
}
