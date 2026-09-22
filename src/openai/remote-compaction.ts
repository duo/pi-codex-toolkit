import { createHash, randomUUID } from "node:crypto";

import {
  normalizeContext,
  type Message,
  type Model,
  type Provider,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  serializeConversation,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type CompactionResult,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  codexAccountIdFromToken,
  layerOptionalHeaders,
  type AuthenticatedOfficialRoute,
} from "./route.ts";
import { parseResponsesUsage } from "./usage.ts";

export const REMOTE_COMPACTION_KIND =
  "pi-codex-toolkit.remote-compaction-v2" as const;
export const REMOTE_COMPACTION_TIMEOUT_MS = 180_000;
export const REMOTE_COMPACTION_FALLBACK_LIMIT = 12_000;
export const REMOTE_COMPACTION_RETAINED_LIMIT = 64_000;

const MARKER_PREFIX = `[${REMOTE_COMPACTION_KIND}:`;
const FALLBACK_LABEL =
  "Remote Compaction checkpoint fallback (transcript excerpt; not a semantic summary):";

export interface RemoteCompactionCompatibility {
  provider: "openai-codex";
  api: "openai-codex-responses";
  model: string;
  endpoint: string;
  authKind: "codex-oauth";
  accountFingerprint: string;
}

export interface RemoteCompactionDetailsV1 {
  kind: typeof REMOTE_COMPACTION_KIND;
  version: 1;
  marker: string;
  retainedInput: unknown[];
  checkpoint: Record<string, unknown>;
  compatibility: RemoteCompactionCompatibility;
}

export interface RemoteCompactionIdentity {
  accountId: string;
  compatibility: RemoteCompactionCompatibility;
}

export type RemoteCompactionErrorCategory =
  | "aborted"
  | "timeout"
  | "network-error"
  | "http-error"
  | "invalid-sse"
  | "incomplete-response"
  | "incomplete-stream"
  | "checkpoint-count";

export class RemoteCompactionError extends Error {
  constructor(readonly category: RemoteCompactionErrorCategory) {
    super(`Remote Compaction failed: ${category}.`);
  }
}

export interface RemoteCompactionDebugRecord {
  outcome: "remote-success" | "native-fallback" | "remote-failure";
  provider?: string;
  api?: string;
  model?: string;
  endpointHost?: string;
  durationMs?: number;
  status?: number;
  requestId?: string;
  completedItems?: number;
  compactionItems?: number;
  reason?: string;
  errorCategory?: RemoteCompactionErrorCategory | "hook-error";
}

interface RemoteResponse {
  checkpoint: Record<string, unknown>;
  usage?: Usage;
  completedItems: number;
  compactionItems: number;
}

interface PreparedRemoteInput {
  requestInput: unknown[];
  retainedInput: unknown[];
  tools: unknown[];
}

interface CapturedRemotePayload {
  input: unknown[];
  tools: unknown[];
}

const PAYLOAD_CAPTURED = "pi-codex-toolkit:remote-payload-captured";
const PAYLOAD_CAPTURE_NETWORK_BLOCKED =
  "pi-codex-toolkit:remote-payload-capture-network-blocked";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveRemoteCompactionIdentity(
  route: AuthenticatedOfficialRoute,
): RemoteCompactionIdentity | undefined {
  if (
    route.route.kind !== "codex-oauth" ||
    route.model.provider !== "openai-codex" ||
    route.model.api !== "openai-codex-responses"
  ) {
    return undefined;
  }
  const accountId = codexAccountIdFromToken(route.token);
  if (!accountId) return undefined;
  return {
    accountId,
    compatibility: {
      provider: "openai-codex",
      api: "openai-codex-responses",
      model: route.model.id,
      endpoint: route.route.endpoint.href,
      authKind: "codex-oauth",
      accountFingerprint: `sha256:${createHash("sha256").update(accountId).digest("hex")}`,
    },
  };
}

function validCompatibility(
  value: unknown,
): value is RemoteCompactionCompatibility {
  return (
    isRecord(value) &&
    value.provider === "openai-codex" &&
    value.api === "openai-codex-responses" &&
    typeof value.model === "string" &&
    value.model !== "" &&
    typeof value.endpoint === "string" &&
    value.endpoint !== "" &&
    value.authKind === "codex-oauth" &&
    typeof value.accountFingerprint === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value.accountFingerprint)
  );
}

export function isRemoteCompactionDetails(
  value: unknown,
): value is RemoteCompactionDetailsV1 {
  return (
    isRecord(value) &&
    value.kind === REMOTE_COMPACTION_KIND &&
    value.version === 1 &&
    typeof value.marker === "string" &&
    value.marker.startsWith(MARKER_PREFIX) &&
    value.marker.endsWith("]") &&
    Array.isArray(value.retainedInput) &&
    isRecord(value.checkpoint) &&
    value.checkpoint.type === "compaction" &&
    validCompatibility(value.compatibility)
  );
}

function sameCompatibility(
  left: RemoteCompactionCompatibility,
  right: RemoteCompactionCompatibility,
): boolean {
  return (
    left.provider === right.provider &&
    left.api === right.api &&
    left.model === right.model &&
    left.endpoint === right.endpoint &&
    left.authKind === right.authKind &&
    left.accountFingerprint === right.accountFingerprint
  );
}

function newestCompaction(
  entries: readonly SessionEntry[],
): CompactionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "compaction") return entry;
  }
  return undefined;
}

export function newestRemoteCompaction(
  entries: readonly SessionEntry[],
): RemoteCompactionDetailsV1 | undefined {
  const entry = newestCompaction(entries);
  if (!entry || !isRemoteCompactionDetails(entry.details)) return undefined;
  return entry.summary.startsWith(entry.details.marker)
    ? entry.details
    : undefined;
}

function looksLikeRemoteCompaction(
  entry: CompactionEntry | undefined,
): boolean {
  return (
    entry?.summary.startsWith(MARKER_PREFIX) === true ||
    (isRecord(entry?.details) && entry.details.kind === REMOTE_COMPACTION_KIND)
  );
}

function stripRemoteMarker(summary: string): string {
  if (!summary.startsWith(MARKER_PREFIX)) return summary;
  const markerEnd = summary.indexOf("]");
  return markerEnd === -1 ? summary : summary.slice(markerEnd + 1).trimStart();
}

function formatFileOperations(
  fileOps: SessionBeforeCompactEvent["preparation"]["fileOps"],
): string {
  const read = [...fileOps.read].sort();
  const modified = [...new Set([...fileOps.written, ...fileOps.edited])].sort();
  const sections: string[] = [];
  if (read.length > 0) {
    sections.push(`Files read:\n${read.map((file) => `- ${file}`).join("\n")}`);
  }
  if (modified.length > 0) {
    sections.push(
      `Files modified:\n${modified.map((file) => `- ${file}`).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

function boundText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const omitted = "\n\n[… transcript excerpt omitted …]\n\n";
  const available = Math.max(0, limit - omitted.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${omitted}${value.slice(value.length - tail)}`;
}

export function buildRemoteCompactionSummary(
  marker: string,
  preparation: SessionBeforeCompactEvent["preparation"],
): string {
  const sections: string[] = [];
  if (preparation.previousSummary) {
    sections.push(stripRemoteMarker(preparation.previousSummary));
  }
  const transcript = serializeConversation(
    convertToLlm([
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ]),
  ).trim();
  if (transcript) sections.push(transcript);
  const files = formatFileOperations(preparation.fileOps);
  if (files) sections.push(files);

  const prefix = `${marker}\n\n${FALLBACK_LABEL}\n\n`;
  return `${prefix}${boundText(
    sections.join("\n\n"),
    REMOTE_COMPACTION_FALLBACK_LIMIT - prefix.length,
  )}`;
}

function isUserInput(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.role === "user" &&
    (value.type === undefined || value.type === "message")
  );
}

export function selectRetainedInput(input: readonly unknown[]): unknown[] {
  const retained: unknown[] = [];
  let characters = 0;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isUserInput(item)) continue;
    const size = JSON.stringify(item).length;
    if (characters + size > REMOTE_COMPACTION_RETAINED_LIMIT) break;
    characters += size;
    retained.push(item);
  }
  return retained.reverse();
}

function capturedRemotePayload(
  value: unknown,
): CapturedRemotePayload | undefined {
  if (!isRecord(value) || !Array.isArray(value.input)) return undefined;
  if (value.tools !== undefined && !Array.isArray(value.tools)) {
    return undefined;
  }
  return {
    input: [...value.input],
    tools: Array.isArray(value.tools) ? [...value.tools] : [],
  };
}

function conversationMessages(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message.role !== "system");
}

export async function captureRemoteCompactionPayload(input: {
  provider: Pick<Provider, "stream">;
  route: AuthenticatedOfficialRoute;
  messages: readonly Message[];
  systemPrompt: string;
  tools: readonly Tool[];
}): Promise<CapturedRemotePayload | undefined> {
  let captured: unknown;
  let fetchCalls = 0;
  let terminalError: string | undefined;
  let eventCount = 0;
  const unreachableFetch: typeof fetch = async () => {
    fetchCalls += 1;
    throw new Error(PAYLOAD_CAPTURE_NETWORK_BLOCKED);
  };
  try {
    const stream = input.provider.stream(
      input.route.model,
      normalizeContext({
        systemPrompt: input.systemPrompt,
        messages: conversationMessages(input.messages),
        ...(input.tools.length > 0 ? { tools: [...input.tools] } : {}),
      }),
      {
        apiKey: input.route.token,
        fetch: unreachableFetch,
        maxRetries: 0,
        transport: "sse",
        onPayload: (payload: unknown) => {
          captured = payload;
          throw new Error(PAYLOAD_CAPTURED);
        },
      },
    );
    for await (const event of stream) {
      eventCount += 1;
      if (event.type === "error") terminalError = event.error.errorMessage;
    }
  } catch {
    return undefined;
  }
  if (
    fetchCalls !== 0 ||
    eventCount !== 1 ||
    terminalError !== PAYLOAD_CAPTURED
  ) {
    return undefined;
  }
  return capturedRemotePayload(captured);
}

async function prepareRemoteInput(input: {
  provider: Pick<Provider, "stream">;
  route: AuthenticatedOfficialRoute;
  preparation: SessionBeforeCompactEvent["preparation"];
  branchEntries: readonly SessionEntry[];
  compatibility: RemoteCompactionCompatibility;
  systemPrompt: string;
  tools: readonly Tool[];
}): Promise<PreparedRemoteInput | undefined> {
  const latest = newestCompaction(input.branchEntries);
  const priorRemote = newestRemoteCompaction(input.branchEntries);
  if (looksLikeRemoteCompaction(latest) && !priorRemote) return undefined;
  if (
    priorRemote &&
    !sameCompatibility(priorRemote.compatibility, input.compatibility)
  ) {
    return undefined;
  }

  const requestInput: unknown[] = [];
  const retainedCandidates: unknown[] = [];

  if (priorRemote) {
    requestInput.push(...priorRemote.retainedInput, priorRemote.checkpoint);
    retainedCandidates.push(...priorRemote.retainedInput);
  } else if (input.preparation.previousSummary && latest) {
    const previous = await captureRemoteCompactionPayload({
      provider: input.provider,
      route: input.route,
      messages: convertToLlm(sessionEntryToContextMessages(latest)),
      systemPrompt: input.systemPrompt,
      tools: [],
    });
    if (!previous) return undefined;
    requestInput.push(...previous.input);
  }

  const current = await captureRemoteCompactionPayload({
    provider: input.provider,
    route: input.route,
    messages: convertToLlm([
      ...input.preparation.messagesToSummarize,
      ...input.preparation.turnPrefixMessages,
    ]),
    systemPrompt: input.systemPrompt,
    tools: input.tools,
  });
  if (!current) return undefined;

  requestInput.push(...current.input);
  retainedCandidates.push(...current.input);
  return {
    requestInput,
    retainedInput: selectRetainedInput(retainedCandidates),
    tools: current.tools,
  };
}

export function buildRemoteCompactionRequest(input: {
  model: Model<any>;
  systemPrompt: string;
  requestInput: readonly unknown[];
  tools: readonly unknown[];
}): Record<string, unknown> {
  return {
    model: input.model.id,
    store: false,
    stream: true,
    instructions: input.systemPrompt || "You are a helpful assistant.",
    input: [...input.requestInput, { type: "compaction_trigger" }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    ...(input.tools.length > 0 ? { tools: [...input.tools] } : {}),
  };
}

function mergeFeatureHeader(value: string | null): string {
  const features = (value ?? "")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
  if (!features.includes("remote_compaction_v2")) {
    features.push("remote_compaction_v2");
  }
  return features.join(",");
}

export function buildRemoteCompactionHeaders(input: {
  route: AuthenticatedOfficialRoute;
  accountId: string;
}): Headers {
  const headers = layerOptionalHeaders(
    input.route.model.headers,
    input.route.headers,
  );
  headers.set("authorization", `Bearer ${input.route.token}`);
  headers.set("chatgpt-account-id", input.accountId);
  headers.set("originator", "pi");
  headers.set("openai-beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set(
    "x-codex-beta-features",
    mergeFeatureHeader(headers.get("x-codex-beta-features")),
  );
  return headers;
}

function parseEventBlock(block: string): Record<string, unknown> | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) throw new Error("event is not an object");
    return parsed;
  } catch {
    throw new RemoteCompactionError("invalid-sse");
  }
}

export async function parseRemoteCompactionResponse(
  response: Response,
  model: Model<any>,
  signal?: AbortSignal,
): Promise<RemoteResponse> {
  if (!response.body) throw new RemoteCompactionError("incomplete-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let usage: Usage | undefined;
  let completedItems = 0;
  const checkpoints: Record<string, unknown>[] = [];

  const consume = (event: Record<string, unknown>): void => {
    const type = event.type;
    if (
      type === "error" ||
      type === "response.failed" ||
      type === "response.incomplete"
    ) {
      throw new RemoteCompactionError("incomplete-response");
    }
    if (type === "response.output_item.done") {
      completedItems += 1;
      if (
        isRecord(event.item) &&
        event.item.type === "compaction" &&
        (event.item.status === undefined || event.item.status === "completed")
      ) {
        checkpoints.push(event.item);
      }
      return;
    }
    if (type === "response.completed") {
      completed = true;
      const responseValue = isRecord(event.response)
        ? event.response
        : undefined;
      usage = parseResponsesUsage(responseValue?.usage, model);
    }
  };

  const consumeBuffer = (flush = false): void => {
    while (true) {
      const separator = buffer.search(/\r?\n\r?\n/);
      if (separator === -1) break;
      const match = buffer.slice(separator).match(/^(?:\r?\n){2}/);
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + (match?.[0].length ?? 2));
      const event = parseEventBlock(block);
      if (event) consume(event);
    }
    if (flush && buffer.trim() !== "") {
      const event = parseEventBlock(buffer);
      buffer = "";
      if (event) consume(event);
    }
  };

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new RemoteCompactionError("aborted");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new RemoteCompactionError("aborted");
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consumeBuffer();
    }
    buffer += decoder.decode();
    consumeBuffer(true);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (!completed) throw new RemoteCompactionError("incomplete-stream");
  if (checkpoints.length !== 1) {
    throw new RemoteCompactionError("checkpoint-count");
  }
  return {
    checkpoint: checkpoints[0]!,
    usage,
    completedItems,
    compactionItems: checkpoints.length,
  };
}

export function emitRemoteCompactionDebug(
  record: RemoteCompactionDebugRecord,
  output: (line: string) => void = console.error,
): void {
  output(
    JSON.stringify({
      feature: "remote-compaction-v2",
      outcome: record.outcome,
      provider: record.provider,
      api: record.api,
      model: record.model,
      endpointHost: record.endpointHost,
      durationMs: record.durationMs,
      status: record.status,
      requestId: record.requestId,
      completedItems: record.completedItems,
      compactionItems: record.compactionItems,
      reason: record.reason,
      errorCategory: record.errorCategory,
    }),
  );
}

async function dispatchRemoteCompaction(
  input: {
    route: AuthenticatedOfficialRoute;
    identity: RemoteCompactionIdentity;
    body: Record<string, unknown>;
    signal?: AbortSignal;
    debug?: boolean;
  },
  fetchImpl: typeof fetch,
  debugOutput: (line: string) => void,
): Promise<RemoteResponse> {
  const startedAt = Date.now();
  if (input.signal?.aborted) {
    if (input.debug) {
      emitRemoteCompactionDebug(
        {
          outcome: "remote-failure",
          provider: input.route.model.provider,
          api: input.route.model.api,
          model: input.route.model.id,
          endpointHost: input.route.route.endpoint.hostname,
          durationMs: 0,
          errorCategory: "aborted",
        },
        debugOutput,
      );
    }
    throw new RemoteCompactionError("aborted");
  }
  const timeoutSignal = AbortSignal.timeout(REMOTE_COMPACTION_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  let response: Response | undefined;
  try {
    response = await fetchImpl(input.route.route.endpoint, {
      method: "POST",
      headers: buildRemoteCompactionHeaders({
        route: input.route,
        accountId: input.identity.accountId,
      }),
      body: JSON.stringify(input.body),
      signal,
    });
    if (!response.ok) throw new RemoteCompactionError("http-error");
    const parsed = await parseRemoteCompactionResponse(
      response,
      input.route.model,
      signal,
    );
    if (input.debug) {
      emitRemoteCompactionDebug(
        {
          outcome: "remote-success",
          provider: input.route.model.provider,
          api: input.route.model.api,
          model: input.route.model.id,
          endpointHost: input.route.route.endpoint.hostname,
          durationMs: Date.now() - startedAt,
          status: response.status,
          requestId: response.headers.get("x-request-id") ?? undefined,
          completedItems: parsed.completedItems,
          compactionItems: parsed.compactionItems,
        },
        debugOutput,
      );
    }
    return parsed;
  } catch (error) {
    const category: RemoteCompactionErrorCategory = input.signal?.aborted
      ? "aborted"
      : timeoutSignal.aborted
        ? "timeout"
        : error instanceof RemoteCompactionError
          ? error.category
          : "network-error";
    if (input.debug) {
      emitRemoteCompactionDebug(
        {
          outcome: "remote-failure",
          provider: input.route.model.provider,
          api: input.route.model.api,
          model: input.route.model.id,
          endpointHost: input.route.route.endpoint.hostname,
          durationMs: Date.now() - startedAt,
          status: response?.status,
          requestId: response?.headers.get("x-request-id") ?? undefined,
          errorCategory: category,
        },
        debugOutput,
      );
    }
    throw new RemoteCompactionError(category);
  }
}

export async function createRemoteCompaction(
  input: {
    provider: Pick<Provider, "stream">;
    route: AuthenticatedOfficialRoute;
    identity: RemoteCompactionIdentity;
    preparation: SessionBeforeCompactEvent["preparation"];
    branchEntries: readonly SessionEntry[];
    systemPrompt: string;
    tools: readonly Tool[];
    signal?: AbortSignal;
    debug?: boolean;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
  debugOutput: (line: string) => void = console.error,
): Promise<CompactionResult<RemoteCompactionDetailsV1> | undefined> {
  const prepared = await prepareRemoteInput({
    provider: input.provider,
    route: input.route,
    preparation: input.preparation,
    branchEntries: input.branchEntries,
    compatibility: input.identity.compatibility,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
  });
  if (!prepared) return undefined;

  const response = await dispatchRemoteCompaction(
    {
      route: input.route,
      identity: input.identity,
      body: buildRemoteCompactionRequest({
        model: input.route.model,
        systemPrompt: input.systemPrompt,
        requestInput: prepared.requestInput,
        tools: prepared.tools,
      }),
      signal: input.signal,
      debug: input.debug,
    },
    fetchImpl,
    debugOutput,
  );
  const marker = `${MARKER_PREFIX}${randomUUID()}]`;
  return {
    summary: buildRemoteCompactionSummary(marker, input.preparation),
    firstKeptEntryId: input.preparation.firstKeptEntryId,
    tokensBefore: input.preparation.tokensBefore,
    ...(response.usage ? { usage: response.usage } : {}),
    details: {
      kind: REMOTE_COMPACTION_KIND,
      version: 1,
      marker,
      retainedInput: prepared.retainedInput,
      checkpoint: response.checkpoint,
      compatibility: input.identity.compatibility,
    },
  };
}

function messageContainsMarker(value: unknown, marker: string): boolean {
  if (!isRecord(value) || value.role !== "user") return false;
  if (typeof value.content === "string") return value.content.includes(marker);
  if (!Array.isArray(value.content)) return false;
  return value.content.some(
    (part) =>
      isRecord(part) &&
      typeof part.text === "string" &&
      part.text.includes(marker),
  );
}

export function replayRemoteCompaction(
  payload: unknown,
  details: RemoteCompactionDetailsV1 | undefined,
  compatibility: RemoteCompactionCompatibility | undefined,
): unknown {
  if (
    !details ||
    !compatibility ||
    !sameCompatibility(details.compatibility, compatibility) ||
    !isRecord(payload) ||
    !Array.isArray(payload.input)
  ) {
    return payload;
  }

  const matches: number[] = [];
  payload.input.forEach((item, index) => {
    if (messageContainsMarker(item, details.marker)) matches.push(index);
  });
  if (matches.length !== 1) return payload;

  const index = matches[0]!;
  return {
    ...payload,
    input: [
      ...payload.input.slice(0, index),
      ...details.retainedInput,
      details.checkpoint,
      ...payload.input.slice(index + 1),
    ],
  };
}
