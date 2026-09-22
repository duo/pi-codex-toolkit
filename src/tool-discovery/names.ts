/**
 * Toolkit-owned tool names used by discovery, status overlay, and the
 * configured deferred set. This module is deliberately import-free so
 * `status.ts` can load it under the native coverage runner, which cannot
 * emit constructor parameter properties from `bounded-text.ts`.
 *
 * `find_tools` is absent: it cannot be deferred or loaded. A drift test
 * compares {@link DEFERRABLE_TOOL_NAMES} with the feature tool modules.
 */

export const WEB_SEARCH_SIDECAR_TOOL = "openai_web_search";
export const IMAGE_GENERATION_TOOL_NAME = "openai_generate_image";
export const APPLY_PATCH_TOOL_NAME = "apply_patch";

export const SHELL_TOOL_NAMES = ["exec_command", "write_stdin"] as const;
export const CODE_MODE_TOOL_NAMES = ["exec", "wait"] as const;

/**
 * The Computer Use tools are one atomic capability. Configuration must defer
 * all six names or none, a query reports each member, and a load request for
 * one member validates and loads the whole group.
 */
export const COMPUTER_USE_TOOL_GROUP = [
  "computer_use_list_apps",
  "computer_use_get_app_state",
  "computer_use_click",
  "computer_use_type_text",
  "computer_use_press_key",
  "computer_use_scroll",
] as const;

export const DEFERRABLE_TOOL_NAMES: readonly string[] = [
  WEB_SEARCH_SIDECAR_TOOL,
  IMAGE_GENERATION_TOOL_NAME,
  APPLY_PATCH_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  ...CODE_MODE_TOOL_NAMES,
  ...COMPUTER_USE_TOOL_GROUP,
];

/** Default `toolDiscovery.deferred`: Image Generation plus the Computer Use group. */
export const DEFAULT_DEFERRED_TOOLS: readonly string[] = [
  IMAGE_GENERATION_TOOL_NAME,
  ...COMPUTER_USE_TOOL_GROUP,
];
