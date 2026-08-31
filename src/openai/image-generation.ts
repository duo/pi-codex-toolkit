import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  codexAccountIdFromToken,
  imageGenerationEndpoint,
  type AuthenticatedOfficialRoute,
} from "./route.ts";

export const IMAGE_GENERATION_TIMEOUT_MS = 300_000;

export type ImageGenerationQuality = "auto" | "low" | "medium" | "high";

export type ImageGenerationErrorCategory =
  | "aborted"
  | "timeout"
  | "network-error"
  | "http-error"
  | "invalid-json"
  | "missing-image"
  | "invalid-image"
  | "missing-account-claim"
  | "artifact-write-error";

export class ImageGenerationError extends Error {
  constructor(
    readonly category: ImageGenerationErrorCategory,
    readonly unknownResult = false,
  ) {
    super(
      `Image Generation failed: ${category}.${
        unknownResult ? " The hosted generation result may be unknown." : ""
      }`,
    );
  }
}

export interface ImageGenerationResult {
  path: string;
  data: string;
  mimeType: "image/png";
}

interface ImageGenerationInput {
  prompt: string;
  size?: string;
  quality?: ImageGenerationQuality;
  toolCallId: string;
  route: AuthenticatedOfficialRoute;
  signal?: AbortSignal;
  debug?: boolean;
}

export function buildImageGenerationRequest(
  input: Pick<ImageGenerationInput, "prompt" | "size" | "quality">,
): Record<string, string> {
  return {
    prompt: input.prompt,
    model: "gpt-image-2",
    background: "auto",
    quality: input.quality ?? "auto",
    size: input.size ?? "auto",
  };
}

function requestHeaders(input: ImageGenerationInput): Headers {
  const headers = new Headers(input.route.model.headers);
  new Headers(input.route.headers).forEach((value, key) => {
    headers.set(key, value);
  });

  headers.delete("openai-beta");
  headers.delete("x-openai-beta");
  headers.delete("x-codex-beta-features");
  headers.set("authorization", `Bearer ${input.route.token}`);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  headers.set("originator", "pi");
  headers.set("x-codex-image-turn-id", input.toolCallId);

  if (input.route.route.kind === "codex-oauth") {
    const accountId = codexAccountIdFromToken(input.route.token);
    if (!accountId) throw new ImageGenerationError("missing-account-claim");
    headers.set("chatgpt-account-id", accountId);
  } else {
    headers.delete("chatgpt-account-id");
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function imageBytes(value: unknown): Buffer {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new ImageGenerationError("missing-image", true);
  }
  const first = value.data[0];
  if (!isRecord(first) || typeof first.b64_json !== "string") {
    throw new ImageGenerationError("missing-image", true);
  }
  const encoded = first.b64_json.trim();
  if (encoded === "") throw new ImageGenerationError("missing-image", true);

  const bytes = Buffer.from(encoded, "base64");
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < signature.length ||
    signature.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new ImageGenerationError("invalid-image", true);
  }
  return bytes;
}

async function persistImage(bytes: Buffer): Promise<string> {
  const directory = resolve(getAgentDir(), "artifacts", "pi-codex-toolkit");
  const path = join(directory, `${randomUUID()}.png`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
  return path;
}

function debugLine(input: {
  route: AuthenticatedOfficialRoute;
  endpoint: URL;
  durationMs: number;
  status?: number;
  requestId?: string;
  errorCategory?: ImageGenerationErrorCategory;
}): string {
  return JSON.stringify({
    feature: "image-generation",
    provider: input.route.model.provider,
    api: input.route.model.api,
    model: "gpt-image-2",
    endpointHost: input.endpoint.hostname,
    durationMs: input.durationMs,
    status: input.status,
    requestId: input.requestId,
    errorCategory: input.errorCategory,
  });
}

export async function generateImage(
  input: ImageGenerationInput,
  fetchImpl: typeof fetch = globalThis.fetch,
  debugOutput: (line: string) => void = console.error,
): Promise<ImageGenerationResult> {
  if (input.signal?.aborted) throw new ImageGenerationError("aborted");

  const endpoint = imageGenerationEndpoint(input.route.route.kind);
  const startedAt = Date.now();
  let headers: Headers;
  try {
    headers = requestHeaders(input);
  } catch (error) {
    const requestError =
      error instanceof ImageGenerationError
        ? error
        : new ImageGenerationError("network-error");
    if (input.debug) {
      debugOutput(
        debugLine({
          route: input.route,
          endpoint,
          durationMs: Date.now() - startedAt,
          errorCategory: requestError.category,
        }),
      );
    }
    throw requestError;
  }
  const timeoutSignal = AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  let response: Response;

  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(buildImageGenerationRequest(input)),
      signal,
      redirect: "manual",
    });
  } catch {
    const category: ImageGenerationErrorCategory = input.signal?.aborted
      ? "aborted"
      : timeoutSignal.aborted
        ? "timeout"
        : "network-error";
    if (input.debug) {
      debugOutput(
        debugLine({
          route: input.route,
          endpoint,
          durationMs: Date.now() - startedAt,
          errorCategory: category,
        }),
      );
    }
    throw new ImageGenerationError(category, true);
  }

  const commonDebug = () => ({
    route: input.route,
    endpoint,
    durationMs: Date.now() - startedAt,
    status: response.status,
    requestId: response.headers.get("x-request-id") ?? undefined,
  });
  if (!response.ok) {
    if (input.debug) {
      debugOutput(debugLine({ ...commonDebug(), errorCategory: "http-error" }));
    }
    throw new ImageGenerationError("http-error", true);
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    const category: ImageGenerationErrorCategory = input.signal?.aborted
      ? "aborted"
      : timeoutSignal.aborted
        ? "timeout"
        : "invalid-json";
    if (input.debug) {
      debugOutput(debugLine({ ...commonDebug(), errorCategory: category }));
    }
    throw new ImageGenerationError(category, true);
  }

  let bytes: Buffer;
  try {
    bytes = imageBytes(value);
  } catch (error) {
    const imageError =
      error instanceof ImageGenerationError
        ? error
        : new ImageGenerationError("invalid-image", true);
    if (input.debug) {
      debugOutput(
        debugLine({ ...commonDebug(), errorCategory: imageError.category }),
      );
    }
    throw imageError;
  }

  let path: string;
  try {
    path = await persistImage(bytes);
  } catch {
    if (input.debug) {
      debugOutput(
        debugLine({
          ...commonDebug(),
          errorCategory: "artifact-write-error",
        }),
      );
    }
    throw new ImageGenerationError("artifact-write-error", true);
  }

  if (input.debug) debugOutput(debugLine(commonDebug()));
  return {
    path,
    data: bytes.toString("base64"),
    mimeType: "image/png",
  };
}
