import type { WebSearchConfig } from "../config.ts";

const SOURCES_INCLUDE = "web_search_call.action.sources";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function injectNativeSearch(
  payload: unknown,
  config: Pick<WebSearchConfig, "mode" | "contextSize">,
): unknown {
  if (!isRecord(payload)) return payload;
  if (payload.tools !== undefined && !Array.isArray(payload.tools))
    return payload;
  if (payload.include !== undefined && !Array.isArray(payload.include)) {
    return payload;
  }

  const existingTools = payload.tools ?? [];
  const tools: unknown[] = [];
  let foundSearch = false;

  for (const tool of existingTools) {
    if (isRecord(tool) && tool.type === "web_search") {
      if (foundSearch) continue;
      foundSearch = true;
      tools.push({
        type: "web_search",
        search_context_size: config.contextSize,
        external_web_access: config.mode === "live",
        ...tool,
      });
    } else {
      tools.push(tool);
    }
  }

  if (!foundSearch) {
    tools.push({
      type: "web_search",
      search_context_size: config.contextSize,
      external_web_access: config.mode === "live",
    });
  }

  const include = [...(payload.include ?? [])];
  if (!include.includes(SOURCES_INCLUDE)) include.push(SOURCES_INCLUDE);

  return {
    ...payload,
    tools,
    include,
    ...(Object.hasOwn(payload, "tool_choice") ? {} : { tool_choice: "auto" }),
  };
}
