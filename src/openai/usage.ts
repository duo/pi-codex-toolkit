import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Parse a Responses API `usage` object into Pi `Usage` with the model's cost
 * applied. Returns `undefined` when the value is absent, not a record, or any
 * of the three token totals is missing or invalid; cache and reasoning detail
 * fields degrade independently. Shared by Sidecar Search and Remote
 * Compaction, which keep their own non-usage parsing.
 */
export function parseResponsesUsage(
  value: unknown,
  model: Model<any>,
): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberValue(value.input_tokens);
  const outputTokens = numberValue(value.output_tokens);
  const totalTokens = numberValue(value.total_tokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }

  const inputDetails = isRecord(value.input_tokens_details)
    ? value.input_tokens_details
    : {};
  const outputDetails = isRecord(value.output_tokens_details)
    ? value.output_tokens_details
    : {};
  const cacheRead = numberValue(inputDetails.cached_tokens) ?? 0;
  const cacheWrite = numberValue(inputDetails.cache_write_tokens) ?? 0;
  const reasoning = numberValue(outputDetails.reasoning_tokens);
  const usage: Usage = {
    input: Math.max(0, inputTokens - cacheRead - cacheWrite),
    output: outputTokens,
    cacheRead,
    cacheWrite,
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}
