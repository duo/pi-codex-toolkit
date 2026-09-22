import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

/**
 * Ownership of one tool name in Pi's visible `getAllTools()` projection:
 * `owned` when this extension's registration is the winner, `foreign` when
 * another registration wins, `absent` when the host lists no winner (for
 * example a user or CLI `--tools` allowlist filtered the name).
 */
export type ToolOwnership =
  | { state: "owned"; winner: ToolInfo }
  | { state: "foreign"; winner: ToolInfo }
  | { state: "absent" };

/**
 * Exact source-path comparison against the visible `getAllTools()` winner.
 *
 * An `undefined` source path is an **unresolved** extension identity: nothing
 * in the host projection is provably this factory's registration, so it owns
 * nothing. Every name then answers `absent` — not `foreign`, which would claim
 * a conflict this factory cannot substantiate — and its routes report the
 * ordinary admission note instead.
 */
export function inspectToolOwnership(
  tools: readonly ToolInfo[],
  toolName: string,
  sourcePath: string | undefined,
): ToolOwnership {
  if (sourcePath === undefined) return { state: "absent" };
  const winner = tools.find((tool) => tool.name === toolName);
  if (!winner) return { state: "absent" };
  return resolve(winner.sourceInfo.path) === resolve(sourcePath)
    ? { state: "owned", winner }
    : { state: "foreign", winner };
}

/**
 * Native-substitution reading: the visible `getAllTools()` winner exists and
 * is the host's builtin registration (`sourceInfo.source === "builtin"`).
 * Builtin identity, not ownership by this extension, decides whether a native
 * name is ours to hide or restore: a foreign same-name winner and an absent
 * name both answer false.
 */
export function isBuiltinWinner(
  tools: readonly ToolInfo[],
  toolName: string,
): boolean {
  return (
    tools.find((tool) => tool.name === toolName)?.sourceInfo.source ===
    "builtin"
  );
}

/**
 * Activation/eligibility reading: an absent name cannot be activated because
 * `setActiveTools` ignores unknown names, so absent and foreign are both
 * unavailable to this extension.
 */
export function isUnavailableOwnership(ownership: ToolOwnership): boolean {
  return ownership.state !== "owned";
}

/**
 * Dispatch reading: only a visibly foreign winner blocks nested/live use.
 * Unlike `isUnavailableOwnership`, an absent name is not a conflict: the host
 * removes names filtered by a user or CLI allowlist (for example
 * `--tools exec,wait`), and nested Code Mode adapters dispatch through the
 * existing executors rather than the projected tool, so they stay available
 * in that setup.
 */
export function isVisibleForeignOwnership(ownership: ToolOwnership): boolean {
  return ownership.state === "foreign";
}
