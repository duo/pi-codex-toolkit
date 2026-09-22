import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  loadNames,
  resolveDeferredSet,
  searchDeferredTools,
  type DeferredSetInput,
  type DiscoveryMatch,
  type EligibilityResult,
  type RejectedName,
} from "./directory.ts";

export const TOOL_DISCOVERY_TOOL = "find_tools";
export const TOOL_DISCOVERY_TOOLS: readonly string[] = [TOOL_DISCOVERY_TOOL];

export interface ToolDiscoveryDetails {
  matches?: DiscoveryMatch[];
  loaded?: string[];
  rejected?: RejectedName[];
}

export interface ToolDiscoveryToolOptions {
  /** Discovery is enabled and `find_tools` itself is owned and unconflicted. */
  isEnabled: () => boolean;
  /** Current `toolDiscovery` configuration; the managed set is resolved here. */
  getConfig: () => DeferredSetInput;
  getActiveTools: () => readonly string[];
  setActiveTools: (names: string[]) => void;
  /** Per-name ownership, feature, and runtime decision recheck. */
  isEligible: (name: string, ctx: ExtensionContext) => EligibilityResult;
  /** Visible registry description for a managed name, when present. */
  describeTool: (name: string) => string | undefined;
  /**
   * Called with the validated names a load request accepted, including names
   * that were already active. Called only after any activation through
   * `setActiveTools` has succeeded, so the caller never remembers a name that
   * was not actually activated. Activation itself still happens only through
   * `setActiveTools`.
   */
  onLoaded?: (names: readonly string[]) => void;
}

/**
 * Render discovery/load evidence concisely. The same information is also
 * returned in `details` for programmatic consumers.
 */
export function formatToolDiscoveryResult(
  details: ToolDiscoveryDetails,
): string {
  const lines: string[] = [];
  if (details.matches) {
    if (details.matches.length === 0) {
      lines.push("No matching managed tools.");
    } else {
      lines.push(`Matches (${details.matches.length}):`);
      for (const match of details.matches) {
        const state =
          match.state === "unavailable"
            ? `unavailable: ${match.reason ?? "unknown"}`
            : match.state;
        lines.push(
          `- ${match.name} [${state}]${match.summary ? ` ${match.summary}` : ""}`,
        );
      }
      if (details.matches.some((match) => match.state === "eligible")) {
        lines.push("Load eligible matches to expose them on the next turn.");
      }
    }
  }
  if (details.loaded && details.loaded.length > 0) {
    lines.push(`Loaded: ${details.loaded.join(", ")}`);
  }
  if (details.rejected && details.rejected.length > 0) {
    lines.push("Rejected:");
    for (const rejection of details.rejected) {
      lines.push(`- ${rejection.name}: ${rejection.reason}`);
    }
  }
  return lines.join("\n");
}

/**
 * Build the single `find_tools` discovery/load tool. Loading only mutates the
 * active set additively; execution is left to Pi's normal next-turn dispatch.
 */
export function createToolDiscoveryTool(
  options: ToolDiscoveryToolOptions,
): ToolDefinition[] {
  return [
    defineTool({
      name: TOOL_DISCOVERY_TOOL,
      label: "Find Tools",
      description:
        "Discover and load explicitly managed Toolkit tools that are not currently exposed. query searches managed names and descriptions and returns at most 8 matches with each tool's state; load activates exact managed names (atomic groups load together) for the next turn. Loading is additive, idempotent, and revalidated per call; disabled, conflicting, or unmanaged names are reported as rejected and never enable a capability or grant permission.",
      parameters: Type.Object(
        {
          query: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                "Case-insensitive search over managed tool names and descriptions. Returns at most 8 matches with the tool's current state and a one-line summary.",
            }),
          ),
          load: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              minItems: 1,
              uniqueItems: true,
              description:
                "Exact managed tool names to activate for the next model turn. Requesting one member of an atomic group checks and loads the whole group. Unknown, unmanaged, disabled, or conflicting names are returned in rejected, not activated.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        if (!options.isEnabled()) {
          throw new Error("Tool discovery is not enabled.");
        }
        if (params.load !== undefined && !Array.isArray(params.load)) {
          throw new Error("find_tools load must be an array of tool names.");
        }
        if (
          params.load !== undefined &&
          params.load.some(
            (name) => typeof name !== "string" || name.length === 0,
          )
        ) {
          throw new Error("find_tools load must contain non-empty tool names.");
        }
        const query =
          typeof params.query === "string" ? params.query.trim() : "";
        const load = params.load ?? [];
        if (query === "" && load.length === 0) {
          throw new Error(
            "find_tools requires a query or a non-empty load list.",
          );
        }

        const config = options.getConfig();
        const deferred = resolveDeferredSet(config);
        const active = options.getActiveTools();
        const details: ToolDiscoveryDetails = {};

        if (query !== "") {
          details.matches = searchDeferredTools({
            query,
            deferred,
            active,
            isEligible: (name) => options.isEligible(name, ctx),
            describe: options.describeTool,
          });
        }
        if (load.length > 0) {
          const result = loadNames({
            requested: load,
            deferred,
            active,
            isEligible: (name) => options.isEligible(name, ctx),
          });
          if (result.rejected.length > 0) details.rejected = result.rejected;
          if (result.add.length > 0) {
            options.setActiveTools([...active, ...result.add]);
          }
          if (result.loaded.length > 0) {
            details.loaded = result.loaded;
            options.onLoaded?.(result.loaded);
          }
        }

        return {
          content: [{ type: "text", text: formatToolDiscoveryResult(details) }],
          details,
        };
      },
    }),
  ];
}
