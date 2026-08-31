import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type WebSearchBackend = "auto" | "native" | "sidecar";
export type WebSearchMode = "live" | "cached";
export type SearchContextSize = "low" | "medium" | "high";
export type SearchExecutorThinkingLevel = "auto" | ModelThinkingLevel;

export interface ModelReference {
  provider: "openai" | "openai-codex";
  model: string;
  thinkingLevel: SearchExecutorThinkingLevel;
}

export interface WebSearchConfig {
  enabled: boolean;
  backend: WebSearchBackend;
  mode: WebSearchMode;
  contextSize: SearchContextSize;
  sidecarModel: ModelReference | null;
}

export interface RemoteCompactionConfig {
  enabled: boolean;
}

export interface ImageGenerationConfig {
  enabled: boolean;
}

export interface ApplyPatchConfig {
  enabled: boolean;
}

export type ComputerUseApprovalMode = "confirm" | "always";

export interface ComputerUseConfig {
  enabled: boolean;
  approvalMode: ComputerUseApprovalMode;
}

export interface ToolkitConfig {
  webSearch: WebSearchConfig;
  remoteCompaction: RemoteCompactionConfig;
  imageGeneration: ImageGenerationConfig;
  applyPatch: ApplyPatchConfig;
  computerUse: ComputerUseConfig;
  debug: boolean;
}

export type ConfigReadError =
  | "invalid-json"
  | "invalid-config"
  | "config-read-failed";

export interface ConfigSnapshot {
  config: ToolkitConfig;
  raw: Record<string, unknown>;
  readError?: ConfigReadError;
}

const BACKENDS: readonly WebSearchBackend[] = ["auto", "native", "sidecar"];
const MODES: readonly WebSearchMode[] = ["live", "cached"];
const CONTEXT_SIZES: readonly SearchContextSize[] = ["low", "medium", "high"];
const COMPUTER_USE_APPROVAL_MODES: readonly ComputerUseApprovalMode[] = [
  "confirm",
  "always",
];
const EXECUTOR_THINKING_LEVELS: readonly SearchExecutorThinkingLevel[] = [
  "auto",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const SIDECAR_PROVIDERS: readonly ModelReference["provider"][] = [
  "openai",
  "openai-codex",
];

class ConfigValidationError extends Error {}

export function defaultConfig(): ToolkitConfig {
  return {
    webSearch: {
      enabled: false,
      backend: "auto",
      mode: "live",
      contextSize: "medium",
      sidecarModel: null,
    },
    remoteCompaction: {
      enabled: false,
    },
    imageGeneration: {
      enabled: false,
    },
    applyPatch: {
      enabled: false,
    },
    computerUse: {
      enabled: false,
      approvalMode: "confirm",
    },
    debug: false,
  };
}

export function cloneConfig(config: ToolkitConfig): ToolkitConfig {
  return {
    webSearch: {
      ...config.webSearch,
      sidecarModel: config.webSearch.sidecarModel
        ? { ...config.webSearch.sidecarModel }
        : null,
    },
    remoteCompaction: { ...config.remoteCompaction },
    imageGeneration: { ...config.imageGeneration },
    applyPatch: { ...config.applyPatch },
    computerUse: { ...config.computerUse },
    debug: config.debug,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(
  object: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigValidationError(key);
  return value;
}

function readEnum<T extends string>(
  object: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ConfigValidationError(key);
  }
  return value as T;
}

function readModelReference(value: unknown): ModelReference | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new ConfigValidationError("sidecarModel");

  const provider = value.provider;
  const model = value.model;
  const thinkingLevel = readEnum(
    value,
    "thinkingLevel",
    EXECUTOR_THINKING_LEVELS,
    "auto",
  );
  if (
    typeof provider !== "string" ||
    !SIDECAR_PROVIDERS.includes(provider as ModelReference["provider"]) ||
    typeof model !== "string" ||
    model.trim() === ""
  ) {
    throw new ConfigValidationError("sidecarModel");
  }

  if (provider === "openai" && thinkingLevel !== "auto") {
    throw new ConfigValidationError("sidecarModel");
  }

  return {
    provider: provider as ModelReference["provider"],
    model,
    thinkingLevel,
  };
}

export function parseConfig(value: unknown): ConfigSnapshot {
  if (!isRecord(value)) throw new ConfigValidationError("root");

  const defaults = defaultConfig();
  const webSearchValue = value.webSearch;
  if (webSearchValue !== undefined && !isRecord(webSearchValue)) {
    throw new ConfigValidationError("webSearch");
  }
  const webSearch = webSearchValue ?? {};
  const remoteCompactionValue = value.remoteCompaction;
  if (remoteCompactionValue !== undefined && !isRecord(remoteCompactionValue)) {
    throw new ConfigValidationError("remoteCompaction");
  }
  const remoteCompaction = remoteCompactionValue ?? {};
  const imageGenerationValue = value.imageGeneration;
  if (imageGenerationValue !== undefined && !isRecord(imageGenerationValue)) {
    throw new ConfigValidationError("imageGeneration");
  }
  const imageGeneration = imageGenerationValue ?? {};
  const applyPatchValue = value.applyPatch;
  if (applyPatchValue !== undefined && !isRecord(applyPatchValue)) {
    throw new ConfigValidationError("applyPatch");
  }
  const applyPatch = applyPatchValue ?? {};
  const computerUseValue = value.computerUse;
  if (computerUseValue !== undefined && !isRecord(computerUseValue)) {
    throw new ConfigValidationError("computerUse");
  }
  const computerUse = computerUseValue ?? {};

  return {
    config: {
      webSearch: {
        enabled: readBoolean(webSearch, "enabled", defaults.webSearch.enabled),
        backend: readEnum(
          webSearch,
          "backend",
          BACKENDS,
          defaults.webSearch.backend,
        ),
        mode: readEnum(webSearch, "mode", MODES, defaults.webSearch.mode),
        contextSize: readEnum(
          webSearch,
          "contextSize",
          CONTEXT_SIZES,
          defaults.webSearch.contextSize,
        ),
        sidecarModel: readModelReference(webSearch.sidecarModel),
      },
      remoteCompaction: {
        enabled: readBoolean(
          remoteCompaction,
          "enabled",
          defaults.remoteCompaction.enabled,
        ),
      },
      imageGeneration: {
        enabled: readBoolean(
          imageGeneration,
          "enabled",
          defaults.imageGeneration.enabled,
        ),
      },
      applyPatch: {
        enabled: readBoolean(
          applyPatch,
          "enabled",
          defaults.applyPatch.enabled,
        ),
      },
      computerUse: {
        enabled: readBoolean(
          computerUse,
          "enabled",
          defaults.computerUse.enabled,
        ),
        approvalMode: readEnum(
          computerUse,
          "approvalMode",
          COMPUTER_USE_APPROVAL_MODES,
          defaults.computerUse.approvalMode,
        ),
      },
      debug: readBoolean(value, "debug", defaults.debug),
    },
    raw: value,
  };
}

function mergeKnownConfig(
  raw: Record<string, unknown>,
  config: ToolkitConfig,
): Record<string, unknown> {
  const rawWebSearch = isRecord(raw.webSearch) ? raw.webSearch : {};
  const rawSidecarModel = isRecord(rawWebSearch.sidecarModel)
    ? rawWebSearch.sidecarModel
    : {};
  const rawRemoteCompaction = isRecord(raw.remoteCompaction)
    ? raw.remoteCompaction
    : {};
  const rawImageGeneration = isRecord(raw.imageGeneration)
    ? raw.imageGeneration
    : {};
  const rawApplyPatch = isRecord(raw.applyPatch) ? raw.applyPatch : {};
  const rawComputerUse = isRecord(raw.computerUse) ? raw.computerUse : {};
  return {
    ...raw,
    webSearch: {
      ...rawWebSearch,
      ...config.webSearch,
      sidecarModel: config.webSearch.sidecarModel
        ? { ...rawSidecarModel, ...config.webSearch.sidecarModel }
        : null,
    },
    remoteCompaction: {
      ...rawRemoteCompaction,
      ...config.remoteCompaction,
    },
    imageGeneration: {
      ...rawImageGeneration,
      ...config.imageGeneration,
    },
    applyPatch: {
      ...rawApplyPatch,
      ...config.applyPatch,
    },
    computerUse: {
      ...rawComputerUse,
      ...config.computerUse,
    },
    debug: config.debug,
  };
}

export class ConfigStore {
  private snapshotValue: ConfigSnapshot = {
    config: defaultConfig(),
    raw: {},
  };

  constructor(readonly path: string) {}

  get snapshot(): ConfigSnapshot {
    return this.snapshotValue;
  }

  async load(): Promise<ConfigSnapshot> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.snapshotValue = { config: defaultConfig(), raw: {} };
      } else {
        this.snapshotValue = {
          ...this.snapshotValue,
          readError: "config-read-failed",
        };
      }
      return this.snapshotValue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      this.snapshotValue = { ...this.snapshotValue, readError: "invalid-json" };
      return this.snapshotValue;
    }

    try {
      this.snapshotValue = parseConfig(parsed);
    } catch (error) {
      if (!(error instanceof ConfigValidationError)) throw error;
      this.snapshotValue = {
        ...this.snapshotValue,
        readError: "invalid-config",
      };
    }
    return this.snapshotValue;
  }

  async save(config: ToolkitConfig): Promise<ConfigSnapshot> {
    if (this.snapshotValue.readError) {
      throw new Error(
        "Refusing to overwrite an unreadable configuration file.",
      );
    }

    const normalized = parseConfig(mergeKnownConfig({}, config)).config;
    const raw = mergeKnownConfig(this.snapshotValue.raw, normalized);
    const directory = dirname(this.path);
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    );

    await mkdir(directory, { recursive: true });
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(raw, null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    this.snapshotValue = { config: normalized, raw };
    return this.snapshotValue;
  }
}
