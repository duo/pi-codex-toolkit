import {
  calculateCost,
  getSupportedThinkingLevels,
  hasApi,
} from "@earendil-works/pi-ai";
import type {
  Model,
  OpenAICodexResponsesOptions,
  Provider,
  Usage,
} from "@earendil-works/pi-ai";

import type {
  SearchExecutorThinkingLevel,
  WebSearchConfig,
} from "../config.ts";
import type { AuthenticatedOfficialRoute } from "./route.ts";

export const SIDECAR_TIMEOUT_MS = 30_000;
const SOURCES_INCLUDE = "web_search_call.action.sources";
const SOURCE_LIMIT = 20;
const SIDECAR_SYSTEM_PROMPT =
  "Search the web for the user's query and answer accurately and concisely.";

export type SidecarErrorCategory =
  | "aborted"
  | "timeout"
  | "network-error"
  | "http-error"
  | "invalid-json"
  | "incomplete-response"
  | "missing-search-call"
  | "missing-answer"
  | "provider-unavailable"
  | "unsupported-sidecar-effort";

export interface SearchSource {
  title: string;
  url: string;
}

export interface SidecarSearchDetails {
  answer: string;
  sources: SearchSource[];
}

export interface SidecarSearchResult extends SidecarSearchDetails {
  text: string;
  usage?: Usage;
}

interface ParsedResponse extends SidecarSearchDetails {
  usage?: Usage;
  blockCounts: Record<string, number>;
}

export class SidecarSearchError extends Error {
  constructor(readonly category: SidecarErrorCategory) {
    super(`OpenAI Web Search failed: ${category}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseUsage(value: unknown, model: Model<any>): Usage | undefined {
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

function normalizedSource(value: unknown): SearchSource | undefined {
  if (!isRecord(value) || typeof value.url !== "string") return undefined;

  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  url.hash = "";

  const title =
    typeof value.title === "string" && value.title.trim() !== ""
      ? value.title.trim()
      : url.hostname;
  return { title, url: url.href };
}

function addSource(
  value: unknown,
  sources: SearchSource[],
  seen: Set<string>,
): void {
  if (sources.length >= SOURCE_LIMIT) return;
  const source = normalizedSource(value);
  if (!source || seen.has(source.url)) return;
  seen.add(source.url);
  sources.push(source);
}

export function parseSidecarResponse(
  value: unknown,
  model: Model<any>,
): ParsedResponse {
  if (!isRecord(value) || value.status !== "completed") {
    throw new SidecarSearchError("incomplete-response");
  }
  if (!Array.isArray(value.output)) {
    throw new SidecarSearchError("missing-search-call");
  }

  const answerParts: string[] = [];
  const sources: SearchSource[] = [];
  const seenSources = new Set<string>();
  const blockCounts: Record<string, number> = {};
  let searchCalls = 0;

  for (const item of value.output) {
    if (!isRecord(item) || typeof item.type !== "string") continue;
    blockCounts[item.type] = (blockCounts[item.type] ?? 0) + 1;

    if (item.type === "web_search_call") {
      searchCalls += 1;
      const action = isRecord(item.action) ? item.action : undefined;
      if (Array.isArray(action?.sources)) {
        for (const source of action.sources) {
          addSource(source, sources, seenSources);
        }
      }
      continue;
    }

    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content) || content.type !== "output_text") continue;
      blockCounts.output_text = (blockCounts.output_text ?? 0) + 1;
      if (typeof content.text === "string" && content.text.trim() !== "") {
        answerParts.push(content.text.trim());
      }
      if (!Array.isArray(content.annotations)) continue;
      for (const annotation of content.annotations) {
        if (isRecord(annotation) && annotation.type === "url_citation") {
          addSource(annotation, sources, seenSources);
        }
      }
    }
  }

  if (searchCalls === 0) throw new SidecarSearchError("missing-search-call");
  const answer = answerParts.join("\n").trim();
  if (answer === "") throw new SidecarSearchError("missing-answer");

  return {
    answer,
    sources,
    usage: parseUsage(value.usage, model),
    blockCounts,
  };
}

export function buildSidecarRequest(
  query: string,
  model: Model<any>,
  config: Pick<WebSearchConfig, "mode" | "contextSize">,
): Record<string, unknown> {
  return {
    model: model.id,
    input: query,
    tools: [
      {
        type: "web_search",
        search_context_size: config.contextSize,
        external_web_access: config.mode === "live",
      },
    ],
    tool_choice: "required",
    include: [SOURCES_INCLUDE],
    store: false,
  };
}

interface DispatchMetadata {
  status?: number;
  requestId?: string;
}

function codexPayload(
  value: unknown,
  config: Pick<WebSearchConfig, "mode" | "contextSize">,
): Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.input)) {
    throw new SidecarSearchError("incomplete-response");
  }
  const include = Array.isArray(value.include) ? [...value.include] : [];
  if (!include.includes(SOURCES_INCLUDE)) include.push(SOURCES_INCLUDE);
  return {
    ...value,
    store: false,
    stream: true,
    tools: [
      {
        type: "web_search",
        search_context_size: config.contextSize,
        external_web_access: config.mode === "live",
      },
    ],
    tool_choice: "required",
    include,
  };
}

function parseCodexSse(text: string, model: Model<any>): ParsedResponse {
  const output: unknown[] = [];
  let completed: Record<string, unknown> | undefined;

  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (data === "" || data === "[DONE]") continue;

    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new SidecarSearchError("invalid-json");
    }
    if (completed) throw new SidecarSearchError("incomplete-response");
    if (!isRecord(event) || typeof event.type !== "string") continue;
    if (
      event.type === "error" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      throw new SidecarSearchError("incomplete-response");
    }
    if (event.type === "response.output_item.done") {
      if (isRecord(event.item)) output.push(event.item);
      continue;
    }
    if (event.type === "response.completed") {
      if (!isRecord(event.response) || event.response.status !== "completed") {
        throw new SidecarSearchError("incomplete-response");
      }
      completed = event.response;
    }
  }

  if (!completed) {
    throw new SidecarSearchError("incomplete-response");
  }
  return parseSidecarResponse(
    { status: "completed", output, usage: completed.usage },
    model,
  );
}

async function dispatchApiKeySearch(input: {
  query: string;
  config: Pick<WebSearchConfig, "mode" | "contextSize">;
  route: AuthenticatedOfficialRoute;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  metadata: DispatchMetadata;
}): Promise<ParsedResponse> {
  let response: Response;
  try {
    const headers = new Headers(input.route.headers);
    headers.set("authorization", `Bearer ${input.route.token}`);
    headers.set("content-type", "application/json");
    response = await input.fetchImpl(input.route.route.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(
        buildSidecarRequest(input.query, input.route.model, input.config),
      ),
      signal: input.signal,
    });
  } catch {
    throw new SidecarSearchError("network-error");
  }

  input.metadata.status = response.status;
  input.metadata.requestId = response.headers.get("x-request-id") ?? undefined;
  if (!response.ok) throw new SidecarSearchError("http-error");

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new SidecarSearchError("invalid-json");
  }
  return parseSidecarResponse(value, input.route.model);
}

async function dispatchCodexSearch(input: {
  query: string;
  config: Pick<WebSearchConfig, "mode" | "contextSize">;
  route: AuthenticatedOfficialRoute;
  thinkingLevel: SearchExecutorThinkingLevel;
  provider: Pick<Provider, "stream">;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  metadata: DispatchMetadata;
}): Promise<ParsedResponse> {
  if (!hasApi(input.route.model, "openai-codex-responses")) {
    throw new SidecarSearchError("provider-unavailable");
  }
  if (
    input.thinkingLevel !== "auto" &&
    !getSupportedThinkingLevels(input.route.model).includes(input.thinkingLevel)
  ) {
    throw new SidecarSearchError("unsupported-sidecar-effort");
  }

  let fetchCount = 0;
  let rawText: Promise<string> | undefined;
  let transportCategory: SidecarErrorCategory | undefined;
  const observedFetch: typeof fetch = async (url, init) => {
    fetchCount += 1;
    if (fetchCount > 1) {
      transportCategory = "incomplete-response";
      throw new SidecarSearchError("incomplete-response");
    }
    try {
      const response = await input.fetchImpl(url, init);
      input.metadata.status = response.status;
      input.metadata.requestId =
        response.headers.get("x-request-id") ?? undefined;
      if (!response.ok) {
        transportCategory = "http-error";
      } else {
        rawText = response.clone().text();
      }
      return response;
    } catch (error) {
      transportCategory = "network-error";
      throw error;
    }
  };
  const reasoningEffort =
    input.thinkingLevel === "auto"
      ? undefined
      : input.thinkingLevel === "off"
        ? "none"
        : input.thinkingLevel;
  const options: OpenAICodexResponsesOptions = {
    apiKey: input.route.token,
    headers: input.route.headers,
    fetch: observedFetch,
    signal: input.signal,
    transport: "sse",
    maxRetries: 0,
    onPayload: (payload) => codexPayload(payload, input.config),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };

  let providerDone = false;
  let providerError = false;
  const routedModel = {
    ...input.route.model,
    baseUrl: input.route.route.endpoint.href,
  };
  const stream = input.provider.stream(
    routedModel,
    {
      systemPrompt: SIDECAR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: input.query, timestamp: Date.now() }],
    },
    options,
  );
  for await (const event of stream) {
    if (event.type === "done") providerDone = true;
    if (event.type === "error") providerError = true;
  }

  if (fetchCount !== 1 || !rawText) {
    throw new SidecarSearchError(transportCategory ?? "incomplete-response");
  }
  let text: string;
  try {
    text = await rawText;
  } catch {
    throw new SidecarSearchError("network-error");
  }
  const parsed = parseCodexSse(text, input.route.model);
  if (providerError || !providerDone) {
    throw new SidecarSearchError("incomplete-response");
  }
  return parsed;
}

function formatResult(answer: string, sources: SearchSource[]): string {
  if (sources.length === 0) return answer;
  const sourceLines = sources.map((source) => {
    const title = source.title.replaceAll("[", "\\[").replaceAll("]", "\\]");
    return `- [${title}](${source.url.replaceAll(")", "%29")})`;
  });
  return `${answer}\n\nSources:\n${sourceLines.join("\n")}`;
}

function debugLine(input: {
  route: AuthenticatedOfficialRoute;
  durationMs: number;
  status?: number;
  requestId?: string;
  blockCounts?: Record<string, number>;
  errorCategory?: SidecarErrorCategory;
}): string {
  return JSON.stringify({
    feature: "web-search-sidecar",
    provider: input.route.model.provider,
    api: input.route.model.api,
    model: input.route.model.id,
    endpointHost: input.route.route.endpoint.hostname,
    durationMs: input.durationMs,
    status: input.status,
    requestId: input.requestId,
    contentBlocks: input.blockCounts,
    errorCategory: input.errorCategory,
  });
}

export async function dispatchSidecarSearch(
  input: {
    query: string;
    config: Pick<WebSearchConfig, "mode" | "contextSize">;
    route: AuthenticatedOfficialRoute;
    thinkingLevel: SearchExecutorThinkingLevel;
    provider?: Pick<Provider, "stream">;
    signal?: AbortSignal;
    debug?: boolean;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
  debugOutput: (line: string) => void = console.error,
): Promise<SidecarSearchResult> {
  if (input.signal?.aborted) throw new SidecarSearchError("aborted");

  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(SIDECAR_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  const metadata: DispatchMetadata = {};
  let result: ParsedResponse;

  try {
    if (input.route.route.kind === "codex-oauth") {
      if (!input.provider) {
        throw new SidecarSearchError("provider-unavailable");
      }
      result = await dispatchCodexSearch({
        query: input.query,
        config: input.config,
        route: input.route,
        thinkingLevel: input.thinkingLevel,
        provider: input.provider,
        signal,
        fetchImpl,
        metadata,
      });
    } else {
      if (input.thinkingLevel !== "auto") {
        throw new SidecarSearchError("unsupported-sidecar-effort");
      }
      result = await dispatchApiKeySearch({
        query: input.query,
        config: input.config,
        route: input.route,
        signal,
        fetchImpl,
        metadata,
      });
    }
  } catch (error) {
    const category: SidecarErrorCategory = input.signal?.aborted
      ? "aborted"
      : timeoutSignal.aborted
        ? "timeout"
        : error instanceof SidecarSearchError
          ? error.category
          : "network-error";
    if (input.debug) {
      debugOutput(
        debugLine({
          route: input.route,
          durationMs: Date.now() - startedAt,
          ...metadata,
          errorCategory: category,
        }),
      );
    }
    throw new SidecarSearchError(category);
  }

  if (input.debug) {
    debugOutput(
      debugLine({
        route: input.route,
        durationMs: Date.now() - startedAt,
        ...metadata,
        blockCounts: result.blockCounts,
      }),
    );
  }
  return {
    answer: result.answer,
    sources: result.sources,
    text: formatResult(result.answer, result.sources),
    usage: result.usage,
  };
}
