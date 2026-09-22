/**
 * Pure managed-set logic for on-demand tool discovery.
 *
 * This module owns the bounded search/load rules. Owned names live in
 * `names.ts` and are re-exported here. Feature enablement, ownership, and the
 * actual active-tool change are injected by the caller; nothing here touches
 * Pi APIs or configuration storage.
 */

import { takeLeadingCodePoints } from "../bounded-text.ts";
import { COMPUTER_USE_TOOL_GROUP, DEFERRABLE_TOOL_NAMES } from "./names.ts";

export {
  APPLY_PATCH_TOOL_NAME,
  CODE_MODE_TOOL_NAMES,
  COMPUTER_USE_TOOL_GROUP,
  DEFAULT_DEFERRED_TOOLS,
  DEFERRABLE_TOOL_NAMES,
  IMAGE_GENERATION_TOOL_NAME,
  SHELL_TOOL_NAMES,
  WEB_SEARCH_SIDECAR_TOOL,
} from "./names.ts";

/** Groups that load only when every member is eligible. */
const ATOMIC_TOOL_GROUPS: readonly (readonly string[])[] = [
  COMPUTER_USE_TOOL_GROUP,
];

/** Maximum number of search matches returned by one `find_tools` query. */
export const DISCOVERY_MATCH_LIMIT = 8;

/** Maximum length of a one-line match summary derived from a description. */
export const DISCOVERY_SUMMARY_MAX_LENGTH = 140;

/** Reason reported when a requested name is not in the managed set. */
export const NOT_MANAGED_REASON = "not-managed";

export type EligibilityResult = { ok: true } | { ok: false; reason: string };

export type DiscoveryState = "active" | "eligible" | "unavailable";

export interface DiscoveryMatch {
  name: string;
  summary: string;
  state: DiscoveryState;
  /** Present only when `state` is `"unavailable"`. */
  reason?: string;
}

export interface RejectedName {
  name: string;
  reason: string;
}

/** Structural input so callers can pass `ToolkitConfig["toolDiscovery"]`. */
export interface DeferredSetInput {
  deferred: readonly string[];
}

export function isDeferrableToolName(name: string): boolean {
  return DEFERRABLE_TOOL_NAMES.includes(name);
}

/**
 * Normalize a configured deferred list into the canonical managed set:
 * unknown names are dropped (a fail-safe for programmatic callers), duplicates
 * collapse, and ordering follows {@link DEFERRABLE_TOOL_NAMES}.
 */
export function resolveDeferredSet(input: DeferredSetInput): string[] {
  const selected = new Set(input.deferred);
  return DEFERRABLE_TOOL_NAMES.filter((name) => selected.has(name));
}

function asNameSet(
  value: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> {
  return value instanceof Set ? value : new Set(value);
}

/**
 * True when Tool Discovery is managing `name` and has not loaded it yet.
 * Losing the `find_tools` loader (`loaderAvailable: false`) is treated like
 * discovery being off: nothing is hidden and ordinary owned exposure returns.
 */
export function isHiddenByDiscovery(
  name: string,
  input: {
    loaderAvailable: boolean;
    deferred: ReadonlySet<string> | readonly string[];
    discovered: ReadonlySet<string> | readonly string[];
  },
): boolean {
  return (
    input.loaderAvailable &&
    asNameSet(input.deferred).has(name) &&
    !asNameSet(input.discovered).has(name)
  );
}

function collapseSummary(description: string | undefined): string {
  const collapsed = (description ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= DISCOVERY_SUMMARY_MAX_LENGTH) return collapsed;
  // The ellipsis is inside the bound, so the head gets one unit less.
  const head = takeLeadingCodePoints(
    collapsed,
    DISCOVERY_SUMMARY_MAX_LENGTH - 1,
    "utf16",
  ).text;
  return `${head.trimEnd()}…`;
}

/**
 * Render a tool description as a one-line summary for a discovery match.
 * Exported so result rendering and tests share the same bound.
 */
export function summarizeDescription(description: string | undefined): string {
  return collapseSummary(description);
}

export interface SearchDeferredToolsOptions {
  query: string;
  deferred: readonly string[];
  active: readonly string[];
  isEligible: (name: string) => EligibilityResult;
  /** Registry description for a managed name, or undefined when absent. */
  describe: (name: string) => string | undefined;
}

/**
 * Search the managed set by name and description. Ranking is exact name
 * match, then name substring, then description substring; ties keep the
 * managed-set order. Results are capped at {@link DISCOVERY_MATCH_LIMIT}.
 */
export function searchDeferredTools(
  options: SearchDeferredToolsOptions,
): DiscoveryMatch[] {
  const query = options.query.trim().toLowerCase();
  if (query === "") return [];
  const deferred = [...new Set(options.deferred)];
  const active = new Set(options.active);
  const ranked: Array<{ tier: number; order: number; match: DiscoveryMatch }> =
    [];

  deferred.forEach((name, order) => {
    const description = options.describe(name);
    const lowerName = name.toLowerCase();
    let tier: number | undefined;
    if (lowerName === query) tier = 0;
    else if (lowerName.includes(query)) tier = 1;
    else if ((description ?? "").toLowerCase().includes(query)) tier = 2;
    if (tier === undefined) return;

    const eligibility = options.isEligible(name);
    const match: DiscoveryMatch = eligibility.ok
      ? {
          name,
          summary: collapseSummary(description),
          state: active.has(name) ? "active" : "eligible",
        }
      : {
          name,
          summary: collapseSummary(description),
          state: "unavailable",
          reason: eligibility.reason,
        };
    ranked.push({ tier, order, match });
  });

  ranked.sort(
    (left, right) => left.tier - right.tier || left.order - right.order,
  );
  return ranked.slice(0, DISCOVERY_MATCH_LIMIT).map((entry) => entry.match);
}

export interface LoadNamesOptions {
  requested: readonly string[];
  deferred: readonly string[];
  active: readonly string[];
  isEligible: (name: string) => EligibilityResult;
}

export interface LoadNamesResult {
  /** Eligible names not currently active, in activation order. */
  add: string[];
  /** Every eligible requested name after atomic-group expansion, including active ones. */
  loaded: string[];
  /** Names that must not be activated, each with a reason. */
  rejected: RejectedName[];
}

function groupContaining(name: string): readonly string[] | undefined {
  return ATOMIC_TOOL_GROUPS.find((group) => group.includes(name));
}

/**
 * Validate a load request without activating anything. Requested names must be
 * managed; requesting one member of an atomic group validates the whole group.
 * A group loads only when every member is both managed and eligible, otherwise
 * the group is rejected with the failing member's reason. The returned `add`
 * never removes or duplicates unrelated active names.
 */
export function loadNames(options: LoadNamesOptions): LoadNamesResult {
  const deferred = new Set(options.deferred);
  const active = new Set(options.active);
  const requested = [...new Set(options.requested)];
  const handled = new Set<string>();
  const add: string[] = [];
  const loaded: string[] = [];
  const rejected: RejectedName[] = [];

  for (const name of requested) {
    if (handled.has(name)) continue;
    if (!deferred.has(name)) {
      rejected.push({ name, reason: NOT_MANAGED_REASON });
      continue;
    }

    const group = groupContaining(name);
    const members = group ?? [name];
    if (group) for (const member of group) handled.add(member);
    const unmanaged = members.find((member) => !deferred.has(member));
    if (group && unmanaged) {
      const reason = `group incomplete: ${unmanaged} is not managed`;
      for (const member of members) rejected.push({ name: member, reason });
      continue;
    }
    const eligibility = members.map((member) => ({
      member,
      result: options.isEligible(member),
    }));
    const failure = eligibility.find((entry) => !entry.result.ok);

    if (failure && !failure.result.ok) {
      const reason = group
        ? `group blocked by ${failure.member}: ${failure.result.reason}`
        : failure.result.reason;
      for (const member of members) rejected.push({ name: member, reason });
      continue;
    }

    for (const member of members) {
      if (!loaded.includes(member)) loaded.push(member);
      if (!active.has(member)) add.push(member);
    }
  }

  return { add, loaded, rejected };
}
