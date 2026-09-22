import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import {
  EXECUTION_SCHEMA_VERSION,
  executionRuleHasUnknownField,
  type ExecutionConfig,
  type ExecutionRule,
} from "./execution-mode.ts";
import {
  COMPUTER_USE_TOOL_GROUP,
  DEFAULT_DEFERRED_TOOLS,
  isDeferrableToolName,
} from "./tool-discovery/directory.ts";

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

export type CodeModeApprovalMode = "confirm" | "always";

export interface CodeModeConfig {
  enabled: boolean;
  approvalMode: CodeModeApprovalMode;
}

export interface ShellSessionsConfig {
  enabled: boolean;
}

export interface ToolDiscoveryConfig {
  enabled: boolean;
  deferred: string[];
}

export interface ToolkitConfig {
  webSearch: WebSearchConfig;
  remoteCompaction: RemoteCompactionConfig;
  imageGeneration: ImageGenerationConfig;
  applyPatch: ApplyPatchConfig;
  computerUse: ComputerUseConfig;
  shellSessions: ShellSessionsConfig;
  codeMode: CodeModeConfig;
  toolDiscovery: ToolDiscoveryConfig;
  debug: boolean;
  /** Present only when the file uses the model-rule schema. */
  execution?: ExecutionConfig;
}

export type ConfigSaveErrorCode = "stale-revision" | "lock-held";

export class ConfigSaveError extends Error {
  readonly code: ConfigSaveErrorCode;

  constructor(code: ConfigSaveErrorCode, message: string) {
    super(message);
    this.name = "ConfigSaveError";
    this.code = code;
  }
}

export type ConfigReadError =
  | "invalid-json"
  | "invalid-config"
  | "config-read-failed";

export interface ConfigSnapshot {
  config: ToolkitConfig;
  raw: Record<string, unknown>;
  readError?: ConfigReadError;
  /**
   * What the failed read found, when known: the validation message for
   * `invalid-config`, the Node error code for `config-read-failed`. Fixed text
   * only, never the invalid value, file content or a JSON parser message.
   */
  readErrorDetail?: string;
}

const BACKENDS: readonly WebSearchBackend[] = ["auto", "native", "sidecar"];
const MODES: readonly WebSearchMode[] = ["live", "cached"];
const CONTEXT_SIZES: readonly SearchContextSize[] = ["low", "medium", "high"];
const COMPUTER_USE_APPROVAL_MODES: readonly ComputerUseApprovalMode[] = [
  "confirm",
  "always",
];
const CODE_MODE_APPROVAL_MODES: readonly CodeModeApprovalMode[] = [
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

/**
 * A rejected configuration: the qualified path of the first invalid field and
 * what it must be or do. Both are fixed text; the invalid value never appears.
 */
export class ConfigValidationError extends Error {
  constructor(path: string, expected: string) {
    super(`${path} must ${expected}`);
  }
}

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
    shellSessions: {
      enabled: false,
    },
    codeMode: {
      enabled: false,
      approvalMode: "confirm",
    },
    toolDiscovery: {
      enabled: false,
      deferred: [...DEFAULT_DEFERRED_TOOLS],
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
    shellSessions: { ...config.shellSessions },
    codeMode: { ...config.codeMode },
    toolDiscovery: {
      enabled: config.toolDiscovery.enabled,
      deferred: [...config.toolDiscovery.deferred],
    },
    debug: config.debug,
    ...(config.execution
      ? {
          execution: {
            version: EXECUTION_SCHEMA_VERSION,
            rules: config.execution.rules.map((rule) => ({ ...rule })),
          },
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read an optional root configuration section: absent becomes `{}`; a
 * non-record value throws a validation error at the section key.
 */
function readSection(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const section = value[key];
  if (section !== undefined && !isRecord(section)) {
    throw new ConfigValidationError(key, "be an object");
  }
  return section ?? {};
}

/** The qualified path of `key` inside the section at `path` ("" is the root). */
function fieldPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/** Overlay known fields onto a stored section, retaining its unknown keys. */
function mergeSection(raw: unknown, next: object): Record<string, unknown> {
  return { ...(isRecord(raw) ? raw : {}), ...next };
}

function readBoolean(
  object: Record<string, unknown>,
  path: string,
  key: string,
  fallback: boolean,
): boolean {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ConfigValidationError(fieldPath(path, key), "be true or false");
  }
  return value;
}

function readEnum<T extends string>(
  object: Record<string, unknown>,
  path: string,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ConfigValidationError(
      fieldPath(path, key),
      `be one of ${values.join(", ")}`,
    );
  }
  return value as T;
}

function readModelReference(
  value: unknown,
  path: string,
): ModelReference | null {
  if (value === undefined || value === null) return null;
  const expected = `name provider ${SIDECAR_PROVIDERS.join(" or ")} and a non-empty model`;
  if (!isRecord(value)) throw new ConfigValidationError(path, expected);

  const provider = value.provider;
  const model = value.model;
  const thinkingLevel = readEnum(
    value,
    path,
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
    throw new ConfigValidationError(path, expected);
  }

  if (provider === "openai" && thinkingLevel !== "auto") {
    throw new ConfigValidationError(
      fieldPath(path, "thinkingLevel"),
      "be auto for provider openai",
    );
  }

  return {
    provider: provider as ModelReference["provider"],
    model,
    thinkingLevel,
  };
}

/**
 * Validate a deferred list against the fixed Toolkit-owned name set. Unknown,
 * foreign, and `find_tools` names are rejected; the Computer Use group must be
 * all six names or none. Duplicates collapse while preserving order.
 */
function readDeferredTools(value: unknown, path: string): string[] {
  if (value === undefined) return [...DEFAULT_DEFERRED_TOOLS];
  const expected = "be an array of deferrable Toolkit tool names";
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(path, expected);
  }
  const deferred: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !isDeferrableToolName(entry)) {
      throw new ConfigValidationError(path, expected);
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    deferred.push(entry);
  }
  const computerUseMembers = COMPUTER_USE_TOOL_GROUP.filter((name) =>
    seen.has(name),
  ).length;
  if (
    computerUseMembers !== 0 &&
    computerUseMembers !== COMPUTER_USE_TOOL_GROUP.length
  ) {
    throw new ConfigValidationError(
      path,
      "list all six Computer Use tools or none",
    );
  }
  return deferred;
}

function readExecutionRule(value: unknown, path: string): ExecutionRule {
  const expected =
    "be an object with unique nonempty id, nonempty match, and boolean patch, shell, and code";
  if (!isRecord(value) || executionRuleHasUnknownField(value)) {
    throw new ConfigValidationError(path, expected);
  }
  const id = value.id;
  const match = value.match;
  if (typeof id !== "string" || id.trim() === "") {
    throw new ConfigValidationError(
      fieldPath(path, "id"),
      "be a nonempty string",
    );
  }
  if (typeof match !== "string" || match.trim() === "") {
    throw new ConfigValidationError(
      fieldPath(path, "match"),
      "be a nonempty glob",
    );
  }
  const patch = value.patch;
  const shell = value.shell;
  const code = value.code;
  if (
    typeof patch !== "boolean" ||
    typeof shell !== "boolean" ||
    typeof code !== "boolean"
  ) {
    throw new ConfigValidationError(path, expected);
  }
  return { id, match: match.trim(), patch, shell, code };
}

function readExecution(
  value: Record<string, unknown>,
): ExecutionConfig | undefined {
  if (value.execution === undefined) return undefined;
  if (!isRecord(value.execution)) {
    throw new ConfigValidationError("execution", "be an object");
  }
  const version = value.execution.version;
  if (version !== EXECUTION_SCHEMA_VERSION) {
    throw new ConfigValidationError("execution.version", "be 1");
  }
  const rulesValue = value.execution.rules;
  if (!Array.isArray(rulesValue)) {
    throw new ConfigValidationError("execution.rules", "be an array");
  }
  const rules: ExecutionRule[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of rulesValue.entries()) {
    const rule = readExecutionRule(entry, `execution.rules[${index}]`);
    if (ids.has(rule.id)) {
      throw new ConfigValidationError(
        `execution.rules[${index}].id`,
        "be unique",
      );
    }
    ids.add(rule.id);
    rules.push(rule);
  }
  return { version: EXECUTION_SCHEMA_VERSION, rules };
}

export function parseConfig(value: unknown): ConfigSnapshot {
  if (!isRecord(value)) {
    throw new ConfigValidationError("configuration", "be a JSON object");
  }

  const defaults = defaultConfig();
  const webSearch = readSection(value, "webSearch");
  const remoteCompaction = readSection(value, "remoteCompaction");
  const imageGeneration = readSection(value, "imageGeneration");
  const applyPatch = readSection(value, "applyPatch");
  const computerUse = readSection(value, "computerUse");
  const shellSessions = readSection(value, "shellSessions");
  const codeMode = readSection(value, "codeMode");
  const toolDiscovery = readSection(value, "toolDiscovery");
  const execution = readExecution(value);

  return {
    config: {
      webSearch: {
        enabled: readBoolean(
          webSearch,
          "webSearch",
          "enabled",
          defaults.webSearch.enabled,
        ),
        backend: readEnum(
          webSearch,
          "webSearch",
          "backend",
          BACKENDS,
          defaults.webSearch.backend,
        ),
        mode: readEnum(
          webSearch,
          "webSearch",
          "mode",
          MODES,
          defaults.webSearch.mode,
        ),
        contextSize: readEnum(
          webSearch,
          "webSearch",
          "contextSize",
          CONTEXT_SIZES,
          defaults.webSearch.contextSize,
        ),
        sidecarModel: readModelReference(
          webSearch.sidecarModel,
          "webSearch.sidecarModel",
        ),
      },
      remoteCompaction: {
        enabled: readBoolean(
          remoteCompaction,
          "remoteCompaction",
          "enabled",
          defaults.remoteCompaction.enabled,
        ),
      },
      imageGeneration: {
        enabled: readBoolean(
          imageGeneration,
          "imageGeneration",
          "enabled",
          defaults.imageGeneration.enabled,
        ),
      },
      applyPatch: {
        enabled: readBoolean(
          applyPatch,
          "applyPatch",
          "enabled",
          defaults.applyPatch.enabled,
        ),
      },
      computerUse: {
        enabled: readBoolean(
          computerUse,
          "computerUse",
          "enabled",
          defaults.computerUse.enabled,
        ),
        approvalMode: readEnum(
          computerUse,
          "computerUse",
          "approvalMode",
          COMPUTER_USE_APPROVAL_MODES,
          defaults.computerUse.approvalMode,
        ),
      },
      shellSessions: {
        enabled: readBoolean(
          shellSessions,
          "shellSessions",
          "enabled",
          defaults.shellSessions.enabled,
        ),
      },
      codeMode: {
        enabled: readBoolean(
          codeMode,
          "codeMode",
          "enabled",
          defaults.codeMode.enabled,
        ),
        approvalMode: readEnum(
          codeMode,
          "codeMode",
          "approvalMode",
          CODE_MODE_APPROVAL_MODES,
          defaults.codeMode.approvalMode,
        ),
      },
      toolDiscovery: {
        enabled: readBoolean(
          toolDiscovery,
          "toolDiscovery",
          "enabled",
          defaults.toolDiscovery.enabled,
        ),
        deferred: readDeferredTools(
          toolDiscovery.deferred,
          "toolDiscovery.deferred",
        ),
      },
      debug: readBoolean(value, "", "debug", defaults.debug),
      ...(execution ? { execution } : {}),
    },
    raw: value,
  };
}

function omitEnabled(raw: unknown, next: object): Record<string, unknown> {
  const merged = mergeSection(raw, next);
  delete merged.enabled;
  return merged;
}

function mergeKnownConfig(
  raw: Record<string, unknown>,
  config: ToolkitConfig,
): Record<string, unknown> {
  const rawWebSearch = isRecord(raw.webSearch) ? raw.webSearch : {};
  const merged: Record<string, unknown> = {
    ...raw,
    webSearch: {
      ...mergeSection(rawWebSearch, config.webSearch),
      sidecarModel: config.webSearch.sidecarModel
        ? mergeSection(rawWebSearch.sidecarModel, config.webSearch.sidecarModel)
        : null,
    },
    remoteCompaction: mergeSection(
      raw.remoteCompaction,
      config.remoteCompaction,
    ),
    imageGeneration: mergeSection(raw.imageGeneration, config.imageGeneration),
    applyPatch: mergeSection(raw.applyPatch, config.applyPatch),
    computerUse: mergeSection(raw.computerUse, config.computerUse),
    shellSessions: mergeSection(raw.shellSessions, config.shellSessions),
    codeMode: mergeSection(raw.codeMode, config.codeMode),
    toolDiscovery: mergeSection(raw.toolDiscovery, config.toolDiscovery),
    debug: config.debug,
  };
  if (!config.execution) {
    delete merged.execution;
    return merged;
  }
  merged.execution = {
    version: EXECUTION_SCHEMA_VERSION,
    rules: config.execution.rules.map((rule) => ({ ...rule })),
  };
  merged.applyPatch = omitEnabled(raw.applyPatch, {});
  merged.shellSessions = omitEnabled(raw.shellSessions, {});
  merged.codeMode = omitEnabled(raw.codeMode, {
    approvalMode: config.codeMode.approvalMode,
  });
  return merged;
}

const MISSING_REVISION = "missing";

function hashContents(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function lockPathFor(configPath: string): string {
  return `${configPath}.lock`;
}

function lockOwnerPath(lockPath: string): string {
  return join(lockPath, "owner");
}

function lockReclaimPath(lockPath: string): string {
  return join(lockPath, "reclaim");
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

interface LockPayload {
  pid: number;
  /** Per-acquisition identity written by this implementation. */
  token?: string;
}

function readLockPayload(contents: string): LockPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (
      isRecord(parsed) &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0
    ) {
      return {
        pid: parsed.pid,
        token: typeof parsed.token === "string" ? parsed.token : undefined,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * A refused acquisition. The lock stays fail-closed, so the message carries the
 * only two facts an operator needs to clear a leftover deliberately: the lock
 * directory, and the recorded owner pid with its liveness. Every caller that
 * supplies an owner has already probed that pid through `isLiveLock`, so this
 * second probe cannot fail where the first one did not.
 */
function lockHeldError(lockPath: string, owner?: LockPayload): ConfigSaveError {
  const held =
    owner === undefined
      ? "exists but has no readable owner record"
      : `is held by pid ${owner.pid} (${
          processIsAlive(owner.pid) ? "running" : "not running"
        })`;
  return new ConfigSaveError(
    "lock-held",
    `Could not save: the configuration lock ${lockPath} ${held}. If no other Pi process with this Toolkit is saving, remove that directory and retry.`,
  );
}

/**
 * Process-global save queues serializing `ConfigStore.save` per resolved lock
 * path. Pi's loader evaluates each extension load with `moduleCache: false`,
 * so module-local state does NOT cover independent loader instances in this
 * process — only `globalThis` does. The filesystem lock alone cannot exclude
 * a same-process competitor either: its pid matches ours, so without this
 * tail chain a second store could steal the live lock and both saves would
 * pass the revision check on the same base.
 */
function configSaveQueues(): Map<string, Promise<void>> {
  const key = Symbol.for("pi-codex-toolkit.config-save-queues");
  const scope = globalThis as Record<symbol, unknown>;
  const existing = scope[key];
  if (existing instanceof Map) {
    return existing as Map<string, Promise<void>>;
  }
  const created = new Map<string, Promise<void>>();
  scope[key] = created;
  return created;
}

/**
 * Process-global registry of lock tokens held by live acquisitions in this
 * process. Independent loader instances share it through `globalThis`, so a
 * same-pid lock whose token is registered here is a live same-process owner
 * rather than an orphan — a pid match alone is not proof of abandonment.
 */
function configLockTokens(): Set<string> {
  const key = Symbol.for("pi-codex-toolkit.config-lock-tokens");
  const scope = globalThis as Record<symbol, unknown>;
  const existing = scope[key];
  if (existing instanceof Set) {
    return existing as Set<string>;
  }
  const created = new Set<string>();
  scope[key] = created;
  return created;
}

function isLiveLock(payload: LockPayload, liveTokens: Set<string>): boolean {
  if (payload.token !== undefined && liveTokens.has(payload.token)) {
    return true;
  }
  // A same-pid lock whose token is not in the live registry is a leftover
  // this process abandoned. A pid match alone is not proof of abandonment
  // when the token is still registered.
  if (payload.pid === process.pid) return false;
  return processIsAlive(payload.pid);
}

async function readOwnerFile(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockOwnerPath(lockPath), "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw lockHeldError(lockPath);
  }
}

function isOccupiedDestination(error: unknown): boolean {
  const code = errnoCode(error);
  return (
    code === "EEXIST" ||
    code === "ENOTEMPTY" ||
    code === "EISDIR" ||
    code === "ENOTDIR"
  );
}

/**
 * Assemble a complete lock directory off to the side, then rename it into
 * place. The destination never appears ownerless: it is absent or it already
 * contains `owner`. Returns false when the destination exists.
 */
async function publishOwnedDirectory(
  destination: string,
  payload: string,
  token: string,
): Promise<boolean> {
  const staging = `${destination}.${process.pid}.${token}`;
  try {
    await mkdir(staging);
    await writeFile(join(staging, "owner"), payload, "utf8");
    await rename(staging, destination);
    return true;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (isOccupiedDestination(error) || errnoCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function inspectReclaim(
  lockPath: string,
): Promise<"absent" | "live" | "abandoned"> {
  const reclaim = lockReclaimPath(lockPath);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(reclaim);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "absent";
    throw lockHeldError(lockPath);
  }
  if (!info.isDirectory()) {
    await unlink(reclaim).catch(() => undefined);
    return "abandoned";
  }
  let contents: string | undefined;
  try {
    contents = await readFile(join(reclaim, "owner"), "utf8");
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw lockHeldError(lockPath);
  }
  if (contents !== undefined) {
    const current = readLockPayload(contents);
    if (current === undefined) throw lockHeldError(lockPath);
    // Live or dead: do not remove this path. A stale inspector that read a
    // dead owner can otherwise delete a replacement live reclaim and both
    // writers save one revision. Dead reclaimers fail closed; a lost update
    // is worse than requiring the leftover directory to disappear.
    return "live";
  }
  // Empty leftover from an older protocol: rmdir only succeeds when the
  // directory is still empty, so a live replacement cannot be deleted.
  try {
    await rmdir(reclaim);
  } catch {
    return "live";
  }
  return "abandoned";
}

/**
 * Take the cooperative lock, returning this acquisition's token.
 *
 * The lock is a directory published atomically by rename, so a live creator
 * never exposes an ownerless path a competitor could reclaim. Fail-closed on
 * anything unverifiable: an unparseable payload or a live owner is
 * `lock-held`. A same-pid lock whose token is in the process-global live
 * registry is a live same-process owner; a same-pid lock with an absent or
 * unknown token is a leftover this process abandoned. Dead foreign owners
 * are taken over through an exclusive `reclaim/` directory that itself
 * carries an owner record. A reclaim path that already has an owner is left
 * in place: deleting it from a stale read can remove a live replacement.
 * Empty leftover reclaim directories are removed only with `rmdir`. The
 * holder removes `reclaim/` only while the owner token is still this
 * acquisition. A leftover *file* at `lockPath` is a previous protocol; dead
 * ones are unlinked and the acquire retries as a directory. A lock that
 * keeps vanishing or reappearing fails held after a bounded number of
 * passes. Every refusal names this directory and, when an owner record was
 * read, that owner's pid and whether it is still running.
 */
async function acquireConfigLock(lockPath: string): Promise<string> {
  const token = randomUUID();
  const payload = `${JSON.stringify({ pid: process.pid, token })}\n`;
  const liveTokens = configLockTokens();
  const owner = lockOwnerPath(lockPath);
  const reclaim = lockReclaimPath(lockPath);
  // The last owner record this acquire could read, for the bounded-passes
  // rejection below: the pass that gave up already knows who is recorded.
  let recordedOwner: LockPayload | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await publishOwnedDirectory(lockPath, payload, token)) {
      liveTokens.add(token);
      return token;
    }

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(lockPath);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      throw lockHeldError(lockPath);
    }

    if (info.isFile()) {
      let existing: string;
      try {
        existing = await readFile(lockPath, "utf8");
      } catch (error) {
        if (errnoCode(error) === "ENOENT") continue;
        throw lockHeldError(lockPath);
      }
      const current = readLockPayload(existing);
      if (current === undefined) throw lockHeldError(lockPath);
      if (isLiveLock(current, liveTokens)) {
        throw lockHeldError(lockPath, current);
      }
      // Legacy file lock: remove only a verified-dead leftover, then retry
      // as a directory. The directory protocol never opens this gap.
      await unlink(lockPath).catch(() => undefined);
      continue;
    }
    if (!info.isDirectory()) throw lockHeldError(lockPath);

    const existing = await readOwnerFile(lockPath);
    if (existing !== undefined) {
      const current = readLockPayload(existing);
      if (current === undefined) throw lockHeldError(lockPath);
      if (isLiveLock(current, liveTokens)) {
        throw lockHeldError(lockPath, current);
      }
      recordedOwner = current;
    }

    const reclaimState = await inspectReclaim(lockPath);
    if (reclaimState === "live" || reclaimState === "abandoned") continue;

    if (!(await publishOwnedDirectory(reclaim, payload, token))) continue;
    try {
      const latest = await readOwnerFile(lockPath);
      if (latest !== undefined) {
        const current = readLockPayload(latest);
        if (current === undefined) throw lockHeldError(lockPath);
        if (isLiveLock(current, liveTokens)) {
          throw lockHeldError(lockPath, current);
        }
      }
      await writeFile(owner, payload, "utf8");
      liveTokens.add(token);
      return token;
    } finally {
      try {
        const held = await readFile(join(reclaim, "owner"), "utf8");
        if (readLockPayload(held)?.token === token) {
          await rm(reclaim, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      } catch {
        // Missing or unreadable reclaim is already gone or not ours.
      }
    }
  }
  throw lockHeldError(lockPath, recordedOwner);
}

/**
 * Release only the lock this acquisition still owns. A missing, unreadable, or
 * token-mismatched owner file is left alone: it may already belong to another
 * writer. The directory is removed only when empty. The token leaves the live
 * registry regardless of outcome.
 */
async function releaseConfigLock(
  lockPath: string,
  token: string,
): Promise<void> {
  try {
    let contents: string;
    try {
      contents = await readFile(lockOwnerPath(lockPath), "utf8");
    } catch {
      return;
    }
    if (readLockPayload(contents)?.token !== token) return;
    await unlink(lockOwnerPath(lockPath)).catch(() => undefined);
    await rmdir(lockPath).catch(() => undefined);
  } finally {
    configLockTokens().delete(token);
  }
}

export class ConfigStore {
  private snapshotValue: ConfigSnapshot = {
    config: defaultConfig(),
    raw: {},
  };
  private lastKnownGood = false;
  private revisionValue = MISSING_REVISION;

  constructor(readonly path: string) {}

  get snapshot(): ConfigSnapshot {
    return this.snapshotValue;
  }

  /** SHA-256 of the last successfully read file bytes, or `missing`. */
  get revision(): string {
    return this.revisionValue;
  }

  /**
   * Whether a load, a missing file included, or a save has produced a valid
   * snapshot. A failed read keeps that snapshot; until one exists the store
   * holds the all-off defaults.
   */
  get hasLastKnownGood(): boolean {
    return this.lastKnownGood;
  }

  async load(): Promise<ConfigSnapshot> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.revisionValue = MISSING_REVISION;
        this.useValidSnapshot({ config: defaultConfig(), raw: {} });
      } else {
        this.recordReadError(
          "config-read-failed",
          typeof code === "string" ? code : undefined,
        );
      }
      return this.snapshotValue;
    }

    this.revisionValue = hashContents(contents);
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      // The parser's message quotes file content, so this error has no detail.
      this.recordReadError("invalid-json");
      return this.snapshotValue;
    }

    try {
      this.useValidSnapshot(parseConfig(parsed));
    } catch (error) {
      if (!(error instanceof ConfigValidationError)) throw error;
      this.recordReadError("invalid-config", error.message);
    }
    return this.snapshotValue;
  }

  async save(
    config: ToolkitConfig,
    options: { expectedRevision?: string } = {},
  ): Promise<ConfigSnapshot> {
    if (this.snapshotValue.readError) {
      throw new Error(
        "Refusing to overwrite an unreadable configuration file.",
      );
    }

    const lockPath = resolve(lockPathFor(this.path));
    await mkdir(dirname(this.path), { recursive: true });
    const critical = async (): Promise<ConfigSnapshot> => {
      const token = await acquireConfigLock(lockPath);
      try {
        let disk: string | undefined;
        try {
          disk = await readFile(this.path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const diskRevision =
          disk === undefined ? MISSING_REVISION : hashContents(disk);
        if (
          options.expectedRevision !== undefined &&
          options.expectedRevision !== diskRevision
        ) {
          throw new ConfigSaveError(
            "stale-revision",
            "Could not save: the configuration file changed; reload and review the draft.",
          );
        }

        const normalized = parseConfig(mergeKnownConfig({}, config)).config;
        const raw = mergeKnownConfig(this.snapshotValue.raw, normalized);
        const serialized = `${JSON.stringify(raw, null, 2)}\n`;
        const directory = dirname(this.path);
        const temporaryPath = join(
          directory,
          `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
        );
        try {
          await writeFile(temporaryPath, serialized, "utf8");
          await rename(temporaryPath, this.path);
        } catch (error) {
          await unlink(temporaryPath).catch(() => undefined);
          throw error;
        }
        this.revisionValue = hashContents(serialized);
        this.useValidSnapshot({ config: normalized, raw });
        return this.snapshotValue;
      } finally {
        await releaseConfigLock(lockPath, token);
      }
    };
    // Serialize the whole acquire→write→release section per lock path: the
    // second save runs only after the first releases, then re-reads the disk
    // revision and fails `stale-revision` instead of stealing the lock. The
    // map is process-global so independent loader instances in this process
    // share the same queue. Stored tails never reject, so a predecessor's
    // failure never skips this save.
    const queues = configSaveQueues();
    const previous = queues.get(lockPath) ?? Promise.resolve();
    const run = previous.then(() => critical());
    const tail: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(lockPath, tail);
    try {
      return await run;
    } finally {
      if (queues.get(lockPath) === tail) {
        queues.delete(lockPath);
      }
    }
  }

  private useValidSnapshot(snapshot: ConfigSnapshot): void {
    this.snapshotValue = snapshot;
    this.lastKnownGood = true;
  }

  /** Keep the current configuration; no earlier error or detail survives. */
  private recordReadError(
    readError: ConfigReadError,
    readErrorDetail?: string,
  ): void {
    const { config, raw } = this.snapshotValue;
    this.snapshotValue =
      readErrorDetail === undefined
        ? { config, raw, readError }
        : { config, raw, readError, readErrorDetail };
  }
}
