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

interface Invocation {
  child: ChildProcessWithoutNullStreams;
  signal?: AbortSignal;
  approvalHandler?: ApprovalHandler;
  confirmation: AbortController;
  active: boolean;
}

interface PendingRequest {
  id: number;
  child: ChildProcessWithoutNullStreams;
  invocation?: Invocation;
  resolve(value: unknown): void;
  reject(error: ComputerUseClientError): void;
  timer?: ReturnType<typeof setTimeout>;
  remainingMs: number;
  activeStartedAt: number;
  approvalWaiters: number;
  signal?: AbortSignal;
  abort?: () => void;
  dispatched: boolean;
  unknownOnFailure: boolean;
}

type ApprovalHandler = (
  message: string,
  signal: AbortSignal,
) => boolean | Promise<boolean>;

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

function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const finish = (error?: ComputerUseClientError): void => {
      clearTimeout(timer);
      child.off("close", closed);
      if (error) reject(error);
      else resolve();
    };
    const closed = (): void => finish();
    const timer = setTimeout(
      () => finish(new ComputerUseClientError("process-exit")),
      PROCESS_EXIT_GRACE_MS,
    );
    child.once("close", closed);
    try {
      // Signal submission (including false) is not a close observation.
      // A racing exit may still close stdio within the existing grace.
      child.kill();
    } catch {
      finish(new ComputerUseClientError("process-exit"));
    }
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
  // Inactive for RPC/UI, but still owned until stop/removal is confirmed.
  private retiredChild?: ChildProcessWithoutNullStreams;
  private retiredHome?: string;
  private threadId?: string;
  private stdoutBuffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private approvedApps = new Set<string>();
  private starting?: Promise<void>;
  private invocation?: Invocation;
  private cleanupError?: ComputerUseClientError;
  private closed = false;
  private closing?: Promise<void>;
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

  /** Failed transport cleanup needs an explicit retry before new transport. */
  get hasCleanupError(): boolean {
    return this.cleanupError !== undefined;
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
    const child = this.child;
    if (!child || this.closed) throw new ComputerUseClientError("closed");
    const invocation: Invocation = {
      child,
      signal,
      approvalHandler,
      confirmation: new AbortController(),
      active: true,
    };
    this.invocation = invocation;
    try {
      const result = await this.callNodeRepl(
        buildComputerUseJavaScript(method, args),
        toolTitle(method),
        signal,
        TOOL_TIMEOUT_MS,
        isComputerUseAction(method),
        invocation,
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
      this.invalidateInvocation(invocation);
      if (this.invocation === invocation) this.invocation = undefined;
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

  /** Reclaim retired transport without discarding live-client safety state. */
  async retryCleanup(): Promise<void> {
    if (this.closed) return this.close();
    if (this.resetting) return this.resetting;
    if (this.cleanupError) await this.resetTransport(this.cleanupError);
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Reset invalidates RPC/UI now. Joining startup also owns a home whose
    // allocation has not returned yet. Reset itself must never join startup:
    // startup's error boundary awaits reset, so that would create a cycle.
    this.closing = Promise.allSettled([
      this.resetTransport(new ComputerUseClientError("closed")),
      this.starting,
    ])
      .then(([reset]) => {
        // Startup's request error belongs to its caller; its cleanup failure
        // belongs to close as well and is retained by resetTransport.
        if (this.cleanupError) throw this.cleanupError;
        if (reset.status === "rejected") throw reset.reason;
      })
      .finally(() => {
        this.closing = undefined;
      });
    return this.closing;
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new ComputerUseClientError("closed");
    if (this.resetting) await this.resetting;
    if (this.cleanupError) throw this.cleanupError;
    if (this.closed) throw new ComputerUseClientError("closed");
    if (this.threadId) return;
    if (!this.starting) {
      const starting = this.start(signal)
        .catch(async (error) => {
          const normalized =
            error instanceof ComputerUseClientError &&
            error.category !== "timeout"
              ? error
              : new ComputerUseClientError("node-repl-unavailable");
          if (this.resetting) await this.resetting;
          if (this.cleanupError) throw this.cleanupError;
          // Startup stays registered until its own cleanup settles, fencing
          // replacement and letting close join late allocation cleanup.
          await this.resetTransport(normalized);
          throw normalized;
        })
        .finally(() => {
          if (this.starting === starting) this.starting = undefined;
        });
      this.starting = starting;
    }
    await this.starting;
  }

  private async start(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new ComputerUseClientError("aborted");
    const temporaryHome = await mkdtemp(
      join(this.temporaryRoot, "pi-codex-toolkit-computer-use-"),
    );
    this.temporaryHome = temporaryHome;
    if (this.closed || signal?.aborted) {
      throw new ComputerUseClientError(this.closed ? "closed" : "aborted");
    }
    const child = spawn(this.runtime.codexPath, this.appServerArgs, {
      cwd: this.temporaryHome,
      env: { ...this.environment, CODEX_HOME: this.temporaryHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdin.on("error", () => this.failTransport(child, "process-exit"));
    child.stdout.on("data", (chunk: string) => this.onStdout(child, chunk));
    child.stderr.resume();
    child.on("error", () => this.failTransport(child, "process-exit"));
    child.once("exit", () => this.failTransport(child, "process-exit"));

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "pi-codex-toolkit",
          title: "Pi Codex Toolkit",
          version: "0.2.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          extensions: { "openai/form": {} },
        },
      },
      signal,
    );
    this.writeNotification(child, "initialized");

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
    if (this.child !== child) throw new ComputerUseClientError("process-exit");
    this.threadId = started.thread.id;
    await this.waitForNodeRepl(child, signal);
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

  private async waitForNodeRepl(
    child: ChildProcessWithoutNullStreams,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child !== child)
        throw new ComputerUseClientError("process-exit");
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
    invocation?: Invocation,
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
      invocation,
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
    invocation?: Invocation,
  ): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(new ComputerUseClientError("aborted"));
    }
    const child = invocation?.child ?? this.child;
    if (
      !child ||
      this.child !== child ||
      this.closed ||
      !child.stdin.writable
    ) {
      return Promise.reject(new ComputerUseClientError("closed"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        child,
        invocation,
        resolve,
        reject,
        dispatched: false,
        unknownOnFailure,
        remainingMs: timeoutMs,
        activeStartedAt: performance.now(),
        approvalWaiters: 0,
        signal,
      };
      if (signal) {
        pending.abort = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(pending.timer);
          this.removeAbort(pending);
          const error = new ComputerUseClientError(
            "aborted",
            pending.dispatched && pending.unknownOnFailure,
          );
          reject(error);
          if (pending.dispatched) this.failTransport(child, error.category);
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      this.armRequestTimer(pending);
      this.writeMessage(child, { method, id, params }, pending);
    });
  }

  private hasRequestBudget(pending: PendingRequest): boolean {
    if (
      this.pending.get(pending.id) !== pending ||
      this.child !== pending.child
    )
      return false;
    if (pending.approvalWaiters === 0) {
      const now = performance.now();
      pending.remainingMs -= now - pending.activeStartedAt;
      pending.activeStartedAt = now;
    }
    if (pending.remainingMs > 0) return true;
    this.pending.delete(pending.id);
    this.removeAbort(pending);
    const error = new ComputerUseClientError(
      "timeout",
      pending.dispatched && pending.unknownOnFailure,
    );
    pending.reject(error);
    this.failTransport(pending.child, error.category);
    return false;
  }

  private armRequestTimer(pending: PendingRequest): void {
    const timer = setTimeout(() => {
      // A superseded callback must not erase a replacement or resume a pause.
      if (pending.timer !== timer || pending.approvalWaiters > 0) return;
      pending.timer = undefined;
      // Node may deliver a rounded timer early. Never refill its remainder.
      if (this.hasRequestBudget(pending)) this.armRequestTimer(pending);
    }, pending.remainingMs);
    pending.timer = timer;
  }

  private pauseForApproval(pending: PendingRequest): (() => void) | undefined {
    if (!this.hasRequestBudget(pending)) return;
    clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.approvalWaiters++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.pending.get(pending.id) !== pending) return;
      if (--pending.approvalWaiters !== 0) return;
      pending.activeStartedAt = performance.now();
      if (this.hasRequestBudget(pending)) this.armRequestTimer(pending);
    };
  }

  private writeMessage(
    child: ChildProcessWithoutNullStreams,
    message: unknown,
    pending?: PendingRequest,
  ): void {
    if (this.child !== child || this.closed) return;
    try {
      if (!child.stdin.writable) {
        this.failTransport(child, "process-exit");
        return;
      }
      const line = `${JSON.stringify(message)}\n`;
      // Submission is potentially dispatch, not application acknowledgement.
      if (pending) pending.dispatched = true;
      child.stdin.write(line, (error) => {
        if (error) this.failTransport(child, "process-exit");
      });
    } catch {
      this.failTransport(child, "process-exit");
    }
  }

  private writeNotification(
    child: ChildProcessWithoutNullStreams,
    method: string,
  ): void {
    this.writeMessage(child, { method });
    if (this.child !== child) throw new ComputerUseClientError("process-exit");
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.stdoutBuffer += chunk;
    while (this.child === child) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.onLine(child, line);
    }
  }

  private onLine(child: ChildProcessWithoutNullStreams, line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.failTransport(child, "invalid-response");
      return;
    }
    if (!isRecord(message)) {
      this.failTransport(child, "invalid-response");
      return;
    }

    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      typeof message.method === "string"
    ) {
      void this.handleServerRequest(child, message).catch(() => {
        this.failTransport(child, "process-exit");
      });
      return;
    }

    if (
      typeof message.id === "number" &&
      this.pending.get(message.id)?.child === child
    ) {
      if ("error" in message) {
        this.settleError(
          message.id,
          new ComputerUseClientError("app-server-error"),
        );
      } else if ("result" in message) {
        this.settleResult(message.id, message.result);
      } else {
        this.failTransport(child, "invalid-response");
      }
      return;
    }
  }

  private async handleServerRequest(
    child: ChildProcessWithoutNullStreams,
    request: Record<string, unknown>,
  ): Promise<void> {
    if (request.method !== "mcpServer/elicitation/request") {
      this.writeServerError(child, request.id as number | string);
      return;
    }
    const invocation = this.invocation;
    // Capture the exact request, never rediscover a replacement after UI waits.
    const pending = invocation
      ? [...this.pending.values()].find(
          (entry) => entry.invocation === invocation,
        )
      : undefined;
    const authorized = (): boolean =>
      !!invocation &&
      !!pending &&
      this.isActiveInvocation(child, invocation) &&
      this.hasRequestBudget(pending);
    const params = request.params;
    let accepted = false;
    let persisted = false;
    if (
      invocation &&
      authorized() &&
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
      } else if (invocation.approvalHandler) {
        try {
          const decision = invocation.approvalHandler(
            params.message,
            invocation.confirmation.signal,
          );
          if (typeof decision === "boolean") {
            accepted = decision;
          } else {
            // Observe even if callback reentrancy retired/expired the request.
            const observed = Promise.resolve(decision).catch(() => false);
            const release =
              authorized() && pending
                ? this.pauseForApproval(pending)
                : undefined;
            if (!release) return;
            try {
              accepted = await observed;
            } finally {
              release();
            }
          }
        } catch {
          accepted = false;
        }
        if (!authorized()) return;
        if (accepted) this.approvedApps.add(app);
      }
    }
    if (invocation && !authorized()) return;
    this.writeServerResult(
      child,
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

  private isActiveInvocation(
    child: ChildProcessWithoutNullStreams,
    invocation: Invocation,
  ): boolean {
    return (
      !this.closed &&
      this.child === child &&
      invocation.child === child &&
      this.invocation === invocation &&
      invocation.active &&
      !invocation.signal?.aborted
    );
  }

  private writeServerResult(
    child: ChildProcessWithoutNullStreams,
    id: number | string,
    result: unknown,
  ): void {
    this.writeMessage(child, { id, result });
  }

  private writeServerError(
    child: ChildProcessWithoutNullStreams,
    id: number | string,
  ): void {
    this.writeMessage(child, {
      id,
      error: { code: -32601, message: "Unsupported request" },
    });
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

  private invalidateInvocation(invocation: Invocation): void {
    invocation.active = false;
    invocation.confirmation.abort();
  }

  private removeAbort(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    pending.timer = undefined;
    if (pending.invocation) this.invalidateInvocation(pending.invocation);
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

  private failTransport(
    child: ChildProcessWithoutNullStreams,
    category: ComputerUseClientErrorCategory,
  ): void {
    if (this.child !== child) return;
    void this.resetTransport(new ComputerUseClientError(category)).catch(() => {
      // Keep failed cleanup visible at the next owned invoke/close boundary.
      this.cleanupError = new ComputerUseClientError("process-exit");
    });
  }

  private resetTransport(error: ComputerUseClientError): Promise<void> {
    if (this.resetting) return this.resetting;
    this.rejectPending(error);
    if (this.invocation) this.invalidateInvocation(this.invocation);
    this.invocation = undefined;
    this.retiredChild ??= this.child;
    this.retiredHome ??= this.temporaryHome;
    this.child = undefined;
    this.temporaryHome = undefined;
    this.threadId = undefined;
    this.stdoutBuffer = "";
    this.resetting = (async () => {
      if (this.retiredChild) {
        await stopProcess(this.retiredChild);
        this.retiredChild = undefined;
      }
      // Never remove a home while the owned child could recreate it. Failed
      // resources stay reachable for a later explicit cleanup/close retry.
      if (this.retiredHome) {
        await rm(this.retiredHome, { recursive: true, force: true });
        this.retiredHome = undefined;
      }
      this.cleanupError = undefined;
    })()
      .catch(() => {
        this.cleanupError = new ComputerUseClientError("process-exit");
        throw this.cleanupError;
      })
      .finally(() => {
        this.resetting = undefined;
      });
    return this.resetting;
  }
}
