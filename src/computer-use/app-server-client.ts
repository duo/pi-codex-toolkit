import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  buildComputerUseJavaScript,
  convertComputerUseMcpContent,
  isComputerUseAction,
  type ComputerUseMethod,
  type ComputerUseToolResult,
} from "./tools.ts";

const CHATGPT_RESOURCES = "/Applications/ChatGPT.app/Contents/Resources";
const TOOL_TIMEOUT_MS = 120_000;
const PROCESS_EXIT_GRACE_MS = 5_000;
const SKY_GLOBAL = "globalThis.__piCodexToolkitSky";

export type ComputerUseRuntimeUnavailableReason =
  | "missing-chatgpt-desktop-component"
  | "missing-computer-use-helper";

export interface ComputerUseRuntime {
  codexPath: string;
  nodeReplPath: string;
  nodePath: string;
  nodeModulesPath: string;
  helperPath: string;
}

export type ComputerUseRuntimeInspection =
  | { ok: true; runtime: ComputerUseRuntime }
  | { ok: false; reason: ComputerUseRuntimeUnavailableReason };

export interface InspectComputerUseRuntimeOptions {
  resourcesPath?: string;
  codexHome?: string;
  exists?: (path: string) => boolean;
}

export function getRealCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured || join(homedir(), ".codex");
}

export function inspectComputerUseRuntime(
  options: InspectComputerUseRuntimeOptions = {},
): ComputerUseRuntimeInspection {
  const resources = options.resourcesPath ?? CHATGPT_RESOURCES;
  const codexHome = options.codexHome ?? getRealCodexHome();
  const exists = options.exists ?? existsSync;
  const runtime: ComputerUseRuntime = {
    codexPath: join(resources, "codex"),
    nodeReplPath: join(resources, "cua_node", "bin", "node_repl"),
    nodePath: join(resources, "cua_node", "bin", "node"),
    nodeModulesPath: join(resources, "cua_node", "lib", "node_modules"),
    helperPath: join(codexHome, "computer-use", "Codex Computer Use.app"),
  };

  if (
    !exists(runtime.codexPath) ||
    !exists(runtime.nodeReplPath) ||
    !exists(runtime.nodePath) ||
    !exists(runtime.nodeModulesPath)
  ) {
    return { ok: false, reason: "missing-chatgpt-desktop-component" };
  }
  if (!exists(runtime.helperPath)) {
    return { ok: false, reason: "missing-computer-use-helper" };
  }
  return { ok: true, runtime };
}

export type ComputerUseClientErrorCategory =
  | "aborted"
  | "timeout"
  | "process-exit"
  | "invalid-response"
  | "app-server-error"
  | "mcp-error"
  | "node-repl-unavailable"
  | "incompatible-sky-target"
  | "inspection-required"
  | "closed";

const ERROR_MESSAGES: Record<ComputerUseClientErrorCategory, string> = {
  aborted: "Computer Use was aborted.",
  timeout: "Computer Use timed out.",
  "process-exit": "Computer Use app-server exited.",
  "invalid-response": "Computer Use returned an invalid response.",
  "app-server-error": "Computer Use app-server rejected the request.",
  "mcp-error":
    "Computer Use failed. If the target app was not resolved, use computer_use_list_apps and a returned app identifier; PIDs and bare executable paths are unsupported.",
  "node-repl-unavailable": "Computer Use node_repl is unavailable.",
  "incompatible-sky-target": "Computer Use Sky target is incompatible.",
  "inspection-required":
    "The previous desktop action may have completed. Inspect the app state before another action.",
  closed: "Computer Use is closed.",
};

export class ComputerUseClientError extends Error {
  constructor(
    readonly category: ComputerUseClientErrorCategory,
    readonly unknownDesktopOutcome = false,
  ) {
    super(ERROR_MESSAGES[category]);
    this.name = "ComputerUseClientError";
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: ComputerUseClientError): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
  dispatched: boolean;
  unknownOnFailure: boolean;
}

type ApprovalHandler = (message: string) => Promise<boolean>;

export interface ComputerUseClientOptions {
  runtime: ComputerUseRuntime;
  appServerArgs?: string[];
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  temporaryRoot?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ComputerUseClientError("aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new ComputerUseClientError("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function waitForProcessClose(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      child.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, PROCESS_EXIT_GRACE_MS);
    child.once("close", finish);
  });
}

function toolTitle(method: ComputerUseMethod): string {
  switch (method) {
    case "list_apps":
      return "List desktop apps";
    case "get_app_state":
      return "Inspect desktop app";
    case "click":
      return "Click desktop app";
    case "type_text":
      return "Type in desktop app";
    case "press_key":
      return "Press key in desktop app";
    case "scroll":
      return "Scroll desktop app";
  }
}

export class ComputerUseClient {
  private readonly runtime: ComputerUseRuntime;
  private readonly appServerArgs: string[];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly temporaryRoot: string;
  private child?: ChildProcessWithoutNullStreams;
  private temporaryHome?: string;
  private threadId?: string;
  private stdoutBuffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private approvedApps = new Set<string>();
  private starting?: Promise<void>;
  private approvalHandler?: ApprovalHandler;
  private closed = false;
  private resetting?: Promise<void>;
  private requiresInspection = false;

  constructor(options: ComputerUseClientOptions) {
    this.runtime = options.runtime;
    this.appServerArgs = options.appServerArgs ?? ["app-server", "--stdio"];
    this.environment = options.environment ?? process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 130_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.temporaryRoot = options.temporaryRoot ?? tmpdir();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async invoke(
    method: ComputerUseMethod,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    approvalHandler?: ApprovalHandler,
  ): Promise<ComputerUseToolResult> {
    if (signal?.aborted) throw new ComputerUseClientError("aborted");
    if (isComputerUseAction(method) && this.requiresInspection) {
      throw new ComputerUseClientError("inspection-required");
    }

    await this.ensureStarted(signal);
    this.approvalHandler = approvalHandler;
    try {
      const result = await this.callNodeRepl(
        buildComputerUseJavaScript(method, args),
        toolTitle(method),
        signal,
        TOOL_TIMEOUT_MS,
        isComputerUseAction(method),
      );
      let converted: ComputerUseToolResult;
      try {
        converted = convertComputerUseMcpContent(method, result.content);
      } catch {
        throw new ComputerUseClientError(
          "invalid-response",
          isComputerUseAction(method),
        );
      }
      if (method === "get_app_state") this.requiresInspection = false;
      return converted;
    } catch (error) {
      if (
        isComputerUseAction(method) &&
        error instanceof ComputerUseClientError &&
        error.unknownDesktopOutcome
      ) {
        this.requiresInspection = true;
      }
      throw error;
    } finally {
      this.approvalHandler = undefined;
    }
  }

  async probeTarget(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new ComputerUseClientError("aborted");
    await this.ensureStarted(signal);
    const result = await this.callNodeRepl(
      `${SKY_GLOBAL} ??= (await import("@oai/sky")).sky;\nnodeRepl.write(String(${SKY_GLOBAL}.target));`,
      "Probe Computer Use runtime",
      signal,
      30_000,
    );
    const target = result.content.find(
      (block) => isRecord(block) && block.type === "text",
    );
    if (!isRecord(target) || target.text !== "mac") {
      throw new ComputerUseClientError("incompatible-sky-target");
    }
  }

  async close(): Promise<void> {
    if (this.closed && this.resetting) return this.resetting;
    this.closed = true;
    return this.resetTransport(new ComputerUseClientError("closed"));
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new ComputerUseClientError("closed");
    if (this.resetting) await this.resetting;
    if (this.threadId) return;
    if (!this.starting) {
      this.starting = this.start(signal).catch(async (error) => {
        const normalized =
          error instanceof ComputerUseClientError
            ? error
            : new ComputerUseClientError("node-repl-unavailable");
        await this.resetTransport(normalized);
        throw normalized;
      });
    }
    await this.starting;
  }

  private async start(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new ComputerUseClientError("aborted");
    this.temporaryHome = await mkdtemp(
      join(this.temporaryRoot, "pi-codex-toolkit-computer-use-"),
    );
    const child = spawn(this.runtime.codexPath, this.appServerArgs, {
      cwd: this.temporaryHome,
      env: { ...this.environment, CODEX_HOME: this.temporaryHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.resume();
    child.once("error", () => this.onProcessFailure());
    child.once("exit", () => this.onProcessFailure());

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "pi-codex-toolkit",
          title: "Pi Codex Toolkit",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          extensions: { "openai/form": {} },
        },
      },
      signal,
    );
    this.writeNotification("initialized");

    const started = await this.request(
      "thread/start",
      {
        cwd: this.temporaryHome,
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: {
          granular: {
            sandbox_approval: false,
            rules: false,
            skill_approval: false,
            request_permissions: false,
            mcp_elicitations: true,
          },
        },
        config: this.threadConfig(),
      },
      signal,
    );
    if (
      !isRecord(started) ||
      !isRecord(started.thread) ||
      typeof started.thread.id !== "string"
    ) {
      throw new ComputerUseClientError("invalid-response");
    }
    this.threadId = started.thread.id;
    await this.waitForNodeRepl(signal);
  }

  private threadConfig(): Record<string, unknown> {
    if (!this.temporaryHome) throw new ComputerUseClientError("closed");
    return {
      mcp_servers: {
        node_repl: {
          command: this.runtime.nodeReplPath,
          args: [],
          startup_timeout_sec: 120,
          enabled_tools: ["js"],
          env: {
            CODEX_HOME: this.temporaryHome,
            CODEX_CLI_PATH: this.runtime.codexPath,
            NODE_REPL_NODE_PATH: this.runtime.nodePath,
            NODE_REPL_NODE_MODULE_DIRS: this.runtime.nodeModulesPath,
            NODE_REPL_TRUSTED_CODE_PATHS: `${this.temporaryHome}${delimiter}${this.runtime.nodeModulesPath}`,
            NODE_REPL_TRUSTED_SERVICES: '{"sky":"@oai/sky/service"}',
            NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
            NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE:
              "Control desktop apps on macOS through Computer Use.",
            SKY_CUA_SERVICE_PATH: this.runtime.helperPath,
          },
        },
      },
    };
  }

  private async waitForNodeRepl(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      let cursor: string | null = null;
      let sawNodeRepl = false;
      do {
        const response = await this.request(
          "mcpServerStatus/list",
          {
            threadId: this.threadId,
            detail: "toolsAndAuthOnly",
            cursor,
          },
          signal,
          Math.min(this.requestTimeoutMs, Math.max(1, deadline - Date.now())),
        );
        if (!isRecord(response) || !Array.isArray(response.data)) {
          throw new ComputerUseClientError("invalid-response");
        }
        for (const entry of response.data) {
          if (!isRecord(entry) || entry.name !== "node_repl") continue;
          sawNodeRepl = true;
          if (
            entry.runtimeStatus === "connected" &&
            isRecord(entry.tools) &&
            isRecord(entry.tools.js)
          ) {
            return;
          }
          if (
            entry.runtimeStatus === "failed" ||
            entry.runtimeStatus === "cancelled" ||
            entry.runtimeStatus === "disabled"
          ) {
            throw new ComputerUseClientError("node-repl-unavailable");
          }
        }
        cursor =
          typeof response.nextCursor === "string" ? response.nextCursor : null;
      } while (cursor && Date.now() < deadline);

      if (!sawNodeRepl || Date.now() < deadline) {
        await delay(
          Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())),
          signal,
        );
      }
    }
    throw new ComputerUseClientError("node-repl-unavailable");
  }

  private async callNodeRepl(
    code: string,
    title: string,
    signal?: AbortSignal,
    timeoutMs = TOOL_TIMEOUT_MS,
    unknownOnFailure = false,
  ): Promise<{ content: unknown[] }> {
    const response = await this.request(
      "mcpServer/tool/call",
      {
        threadId: this.threadId,
        server: "node_repl",
        tool: "js",
        arguments: { code, title, timeout_ms: timeoutMs },
      },
      signal,
      Math.min(this.requestTimeoutMs, timeoutMs + 10_000),
      unknownOnFailure,
    );
    if (!isRecord(response)) {
      throw new ComputerUseClientError("invalid-response", unknownOnFailure);
    }
    if (response.isError === true) {
      throw new ComputerUseClientError("mcp-error");
    }
    if (!Array.isArray(response.content)) {
      throw new ComputerUseClientError("invalid-response", unknownOnFailure);
    }
    return { content: response.content };
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
    unknownOnFailure = false,
  ): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(new ComputerUseClientError("aborted"));
    }
    const child = this.child;
    if (!child || this.closed || !child.stdin.writable) {
      return Promise.reject(new ComputerUseClientError("closed"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        dispatched: false,
        unknownOnFailure,
        timer: setTimeout(() => {
          if (!this.pending.delete(id)) return;
          this.removeAbort(pending);
          const error = new ComputerUseClientError(
            "timeout",
            pending.dispatched && pending.unknownOnFailure,
          );
          reject(error);
          void this.resetTransport(error);
        }, timeoutMs),
        signal,
      };
      if (signal) {
        pending.abort = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(pending.timer);
          const error = new ComputerUseClientError(
            "aborted",
            pending.dispatched && pending.unknownOnFailure,
          );
          reject(error);
          if (pending.dispatched) void this.resetTransport(error);
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      try {
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
        pending.dispatched = true;
      } catch {
        this.settleError(id, new ComputerUseClientError("process-exit"));
        void this.resetTransport(new ComputerUseClientError("process-exit"));
      }
    });
  }

  private writeNotification(method: string): void {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new ComputerUseClientError("closed");
    }
    child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.failTransport("invalid-response");
      return;
    }
    if (!isRecord(message)) {
      this.failTransport("invalid-response");
      return;
    }

    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      typeof message.method === "string"
    ) {
      void this.handleServerRequest(message);
      return;
    }

    if (typeof message.id === "number" && this.pending.has(message.id)) {
      if ("error" in message) {
        this.settleError(
          message.id,
          new ComputerUseClientError("app-server-error"),
        );
      } else if ("result" in message) {
        this.settleResult(message.id, message.result);
      } else {
        this.failTransport("invalid-response");
      }
      return;
    }
  }

  private async handleServerRequest(
    request: Record<string, unknown>,
  ): Promise<void> {
    if (request.method !== "mcpServer/elicitation/request") {
      this.writeServerError(request.id as number | string);
      return;
    }
    const params = request.params;
    let accepted = false;
    let persisted = false;
    if (
      isRecord(params) &&
      params.threadId === this.threadId &&
      params.serverName === "node_repl" &&
      (params.mode === "form" || params.mode === "openai/form") &&
      isRecord(params._meta) &&
      params._meta.connector_id === "computer-use" &&
      isRecord(params._meta.tool_params) &&
      typeof params._meta.tool_params.app === "string" &&
      params._meta.tool_params.app.trim().length > 0 &&
      typeof params.message === "string"
    ) {
      const app = params._meta.tool_params.app.trim();
      persisted = this.approvedApps.has(app);
      if (persisted) {
        accepted = true;
      } else if (this.approvalHandler) {
        accepted = await this.approvalHandler(params.message).catch(
          () => false,
        );
        if (accepted) this.approvedApps.add(app);
      }
    }
    this.writeServerResult(
      request.id as number | string,
      accepted
        ? persisted
          ? {
              action: "accept",
              content: {
                source: "computer-use-persisted-state",
                scope: "conversation",
              },
              _meta: null,
            }
          : {
              action: "accept",
              content: {},
              _meta: { persist: "session" },
            }
        : { action: "decline", content: null, _meta: null },
    );
  }

  private writeServerResult(id: number | string, result: unknown): void {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private writeServerError(id: number | string): void {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    child.stdin.write(
      `${JSON.stringify({ id, error: { code: -32601, message: "Unsupported request" } })}\n`,
    );
  }

  private settleResult(id: number, result: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    this.removeAbort(pending);
    pending.resolve(result);
  }

  private settleError(id: number, error: ComputerUseClientError): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    this.removeAbort(pending);
    pending.reject(error);
  }

  private removeAbort(pending: PendingRequest): void {
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
  }

  private rejectPending(error: ComputerUseClientError): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      this.removeAbort(pending);
      pending.reject(
        new ComputerUseClientError(
          error.category,
          pending.dispatched && pending.unknownOnFailure,
        ),
      );
    }
  }

  private failTransport(category: ComputerUseClientErrorCategory): void {
    void this.resetTransport(new ComputerUseClientError(category));
  }

  private onProcessFailure(): void {
    void this.resetTransport(new ComputerUseClientError("process-exit"));
  }

  private resetTransport(error: ComputerUseClientError): Promise<void> {
    if (this.resetting) return this.resetting;
    this.rejectPending(error);
    const child = this.child;
    const temporaryHome = this.temporaryHome;
    this.child = undefined;
    this.temporaryHome = undefined;
    this.threadId = undefined;
    this.starting = undefined;
    this.stdoutBuffer = "";
    this.resetting = (async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = waitForProcessClose(child);
        child.kill();
        await closed;
      }
      if (temporaryHome) {
        await rm(temporaryHome, { recursive: true, force: true });
      }
    })().finally(() => {
      this.resetting = undefined;
    });
    return this.resetting;
  }
}
