import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { ModelReference } from "../config.ts";

export type RouteUnavailableReason =
  | "unsupported-provider"
  | "unsupported-api"
  | "unofficial-endpoint"
  | "credential-mismatch"
  | "missing-openai-auth"
  | "missing-sidecar-model"
  | "unsupported-sidecar-effort";

export interface OfficialRoute {
  kind: "api-key" | "codex-oauth";
  endpoint: URL;
}

export type RouteInspection =
  | { ok: true; route: OfficialRoute }
  | { ok: false; reason: RouteUnavailableReason };

export interface AuthenticatedOfficialRoute {
  model: Model<any>;
  route: OfficialRoute;
  token: string;
  headers: Record<string, string>;
}

export type AuthenticatedRouteResolution =
  | { ok: true; value: AuthenticatedOfficialRoute }
  | { ok: false; reason: RouteUnavailableReason };

export type SidecarInspection =
  | { ok: true; model: Model<any>; route: OfficialRoute }
  | { ok: false; reason: RouteUnavailableReason };

export type ImageExecutorInspection = SidecarInspection;

const IMAGE_ENDPOINTS = {
  "api-key": "https://api.openai.com/v1/images/generations",
  "codex-oauth": "https://chatgpt.com/backend-api/codex/images/generations",
} as const;

function normalizedPath(url: URL): string {
  return url.pathname.replace(/\/+$/, "") || "/";
}

function isCleanHttpsUrl(url: URL, hostname: string): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === hostname &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

function inspectEndpoint(
  baseUrl: string,
  hostname: string,
  allowedPaths: readonly string[],
  endpoint: string,
): RouteInspection {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, reason: "unofficial-endpoint" };
  }

  if (
    !isCleanHttpsUrl(parsed, hostname) ||
    !allowedPaths.includes(normalizedPath(parsed))
  ) {
    return { ok: false, reason: "unofficial-endpoint" };
  }

  return {
    ok: true,
    route: {
      kind: hostname === "api.openai.com" ? "api-key" : "codex-oauth",
      endpoint: new URL(endpoint),
    },
  };
}

export function inspectOfficialRoute(model: Model<any>): RouteInspection {
  if (model.provider === "openai") {
    if (model.api !== "openai-responses") {
      return { ok: false, reason: "unsupported-api" };
    }
    return inspectEndpoint(
      model.baseUrl,
      "api.openai.com",
      ["/v1", "/v1/responses"],
      "https://api.openai.com/v1/responses",
    );
  }

  if (model.provider === "openai-codex") {
    if (model.api !== "openai-codex-responses") {
      return { ok: false, reason: "unsupported-api" };
    }
    return inspectEndpoint(
      model.baseUrl,
      "chatgpt.com",
      ["/backend-api", "/backend-api/codex", "/backend-api/codex/responses"],
      "https://chatgpt.com/backend-api/codex/responses",
    );
  }

  return { ok: false, reason: "unsupported-provider" };
}

export function inspectCurrentNativeRoute(
  model: Model<any> | undefined,
  registry: Pick<ModelRegistry, "isUsingOAuth">,
): RouteInspection {
  if (!model) return { ok: false, reason: "unsupported-provider" };
  const inspection = inspectOfficialRoute(model);
  if (!inspection.ok) return inspection;

  const usesOAuth = registry.isUsingOAuth(model);
  if ((inspection.route.kind === "codex-oauth") !== usesOAuth) {
    return { ok: false, reason: "credential-mismatch" };
  }
  return inspection;
}

export function inspectRemoteCompactionRoute(
  model: Model<any> | undefined,
  registry: Pick<ModelRegistry, "isUsingOAuth">,
): RouteInspection {
  const inspection = inspectCurrentNativeRoute(model, registry);
  if (!inspection.ok) return inspection;
  return inspection.route.kind === "codex-oauth"
    ? inspection
    : { ok: false, reason: "unsupported-provider" };
}

function sameModel(model: Model<any>, reference: ModelReference): boolean {
  return model.provider === reference.provider && model.id === reference.model;
}

function sameModelIdentity(left: Model<any>, right: Model<any>): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function supportsSidecarEffort(
  reference: ModelReference,
  model: Model<any>,
  route: OfficialRoute,
): boolean {
  if (reference.thinkingLevel === "auto") return true;
  return (
    route.kind === "codex-oauth" &&
    getSupportedThinkingLevels(model).includes(reference.thinkingLevel)
  );
}

function inspectImageCandidate(
  model: Model<any>,
  registry: Pick<ModelRegistry, "isUsingOAuth">,
): SidecarInspection {
  const inspection = inspectOfficialRoute(model);
  if (!inspection.ok) return inspection;
  if (
    (inspection.route.kind === "codex-oauth") !==
    registry.isUsingOAuth(model)
  ) {
    return { ok: false, reason: "credential-mismatch" };
  }
  return { ok: true, model, route: inspection.route };
}

export function inspectImageExecutor(
  currentModel: Model<any> | undefined,
  registry: Pick<ModelRegistry, "getAvailable" | "isUsingOAuth">,
): ImageExecutorInspection {
  const available = registry.getAvailable();
  let firstReason: RouteUnavailableReason | undefined;

  if (
    currentModel &&
    available.some((candidate) => sameModelIdentity(candidate, currentModel))
  ) {
    const current = inspectImageCandidate(currentModel, registry);
    if (current.ok) return current;
    firstReason = current.reason;
  }

  const currentKey = currentModel
    ? `${currentModel.provider}\0${currentModel.id}`
    : undefined;
  const seen = new Set<string>();
  const candidates = [
    ...available.filter((model) => model.provider === "openai-codex"),
    ...available.filter((model) => model.provider === "openai"),
  ];

  for (const model of candidates) {
    const key = `${model.provider}\0${model.id}`;
    if (key === currentKey || seen.has(key)) continue;
    seen.add(key);
    const inspection = inspectImageCandidate(model, registry);
    if (inspection.ok) return inspection;
    firstReason ??= inspection.reason;
  }

  return { ok: false, reason: firstReason ?? "missing-openai-auth" };
}

export function imageGenerationEndpoint(kind: OfficialRoute["kind"]): URL {
  return new URL(IMAGE_ENDPOINTS[kind]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function codexAccountIdFromToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as unknown;
    if (!isRecord(payload)) return undefined;
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() !== ""
      ? accountId
      : undefined;
  } catch {
    return undefined;
  }
}

export function inspectSidecarExecutor(
  reference: ModelReference | null,
  registry: Pick<ModelRegistry, "find" | "getAvailable" | "isUsingOAuth">,
): SidecarInspection {
  if (!reference) return { ok: false, reason: "missing-sidecar-model" };

  const model = registry.find(reference.provider, reference.model);
  if (!model) return { ok: false, reason: "missing-sidecar-model" };

  const inspection = inspectOfficialRoute(model);
  if (!inspection.ok) return inspection;
  if (
    (inspection.route.kind === "codex-oauth") !==
    registry.isUsingOAuth(model)
  ) {
    return { ok: false, reason: "credential-mismatch" };
  }
  if (!supportsSidecarEffort(reference, model, inspection.route)) {
    return { ok: false, reason: "unsupported-sidecar-effort" };
  }
  if (
    !registry
      .getAvailable()
      .some((candidate) => sameModel(candidate, reference))
  ) {
    return { ok: false, reason: "missing-openai-auth" };
  }

  return { ok: true, model, route: inspection.route };
}

function stringHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
}

export async function resolveOfficialRoute(
  registry: Pick<ModelRegistry, "getApiKeyAndHeaders" | "isUsingOAuth">,
  model: Model<any>,
): Promise<AuthenticatedRouteResolution> {
  const initial = inspectOfficialRoute(model);
  if (!initial.ok) return initial;

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return { ok: false, reason: "missing-openai-auth" };
  }

  const routedModel = auth.baseUrl
    ? { ...model, baseUrl: auth.baseUrl }
    : model;
  const resolved = inspectOfficialRoute(routedModel);
  if (!resolved.ok) return resolved;
  if (resolved.route.kind !== initial.route.kind) {
    return { ok: false, reason: "credential-mismatch" };
  }

  const usesOAuth = registry.isUsingOAuth(model);
  if ((resolved.route.kind === "codex-oauth") !== usesOAuth) {
    return { ok: false, reason: "credential-mismatch" };
  }

  return {
    ok: true,
    value: {
      model,
      route: resolved.route,
      token: auth.apiKey,
      headers: stringHeaders(auth.headers),
    },
  };
}

export async function resolveSidecarRoute(
  registry: Pick<
    ModelRegistry,
    "find" | "getApiKeyAndHeaders" | "getAvailable" | "isUsingOAuth"
  >,
  reference: ModelReference | null,
): Promise<AuthenticatedRouteResolution> {
  if (!reference) return { ok: false, reason: "missing-sidecar-model" };
  const model = registry.find(reference.provider, reference.model);
  if (!model) return { ok: false, reason: "missing-sidecar-model" };
  if (
    !registry
      .getAvailable()
      .some((candidate) => sameModel(candidate, reference))
  ) {
    return { ok: false, reason: "missing-openai-auth" };
  }

  const resolved = await resolveOfficialRoute(registry, model);
  if (!resolved.ok) return resolved;
  if (!supportsSidecarEffort(reference, model, resolved.value.route)) {
    return { ok: false, reason: "unsupported-sidecar-effort" };
  }
  return resolved;
}
