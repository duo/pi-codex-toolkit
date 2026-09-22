import {
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComputerUseClient,
  ComputerUseClientError,
  inspectComputerUseRuntime,
  type ComputerUseRuntime,
} from "../src/computer-use/app-server-client.ts";
import { INNER_BUDGET_MS, outerBudget } from "./fixtures/budgets.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: vi.fn(actual.mkdtemp),
    rm: vi.fn(actual.rm),
  };
});

const fixturePath = fileURLToPath(
  new URL("./fixtures/fake-app-server.ts", import.meta.url),
);
const temporaryDirectories: string[] = [];
const clients: ComputerUseClient[] = [];

interface FakeLogEntry {
  type: "environment" | "input";
  CODEX_HOME?: string;
  cwd?: string;
  message?: {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  };
}

interface Harness {
  client: ComputerUseClient;
  directory: string;
  homes: string;
  logPath: string;
  statePath: string;
  runtime: ComputerUseRuntime;
}

// A request to a freshly spawned fake app server includes that child's start,
// which took up to 1.8 s with four suites sharing eight CPUs. Keep requests and
// readiness under a bound the start cannot exhaust; cases that exercise a
// timeout pass or set their own.
const HARNESS_REQUEST_TIMEOUT_MS = 6_000;
const HARNESS_STARTUP_TIMEOUT_MS = 6_000;

async function harness(scenario = "normal"): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "pct-app-server-client-"));
  temporaryDirectories.push(directory);
  const homes = join(directory, "homes");
  await mkdir(homes);
  const logPath = join(directory, "fake-log.jsonl");
  const statePath = join(directory, "fake-state");
  const runtime = {
    codexPath: process.execPath,
    nodeReplPath: "/chatgpt/cua_node/bin/node_repl",
    nodePath: "/chatgpt/cua_node/bin/node",
    nodeModulesPath: "/chatgpt/cua_node/lib/node_modules",
    helperPath: "/real-codex-home/computer-use/Codex Computer Use.app",
  };
  const client = new ComputerUseClient({
    runtime,
    appServerArgs: [fixturePath],
    environment: {
      ...process.env,
      CODEX_HOME: "PROTECTED_REAL_CODEX_HOME",
      FAKE_APP_SERVER_LOG: logPath,
      FAKE_APP_SERVER_SCENARIO: scenario,
      FAKE_APP_SERVER_STATE: statePath,
    },
    temporaryRoot: homes,
    pollIntervalMs: 5,
    startupTimeoutMs: HARNESS_STARTUP_TIMEOUT_MS,
    requestTimeoutMs: HARNESS_REQUEST_TIMEOUT_MS,
  });
  clients.push(client);
  return { client, directory, homes, logPath, statePath, runtime };
}

// One owner for decoding and projecting fake-child JSONL records. Strict
// readers parse every remaining line; only polling applies newline framing.
function decodeLogLines(text: string): FakeLogEntry[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeLogEntry);
}

async function logs(path: string): Promise<FakeLogEntry[]> {
  return decodeLogLines(await readFile(path, "utf8"));
}

function projectInputMessages(
  entries: FakeLogEntry[],
): NonNullable<FakeLogEntry["message"]>[] {
  return entries.flatMap((entry) =>
    entry.type === "input" && entry.message ? [entry.message] : [],
  );
}

async function inputs(
  path: string,
): Promise<NonNullable<FakeLogEntry["message"]>[]> {
  return projectInputMessages(await logs(path));
}

interface InputSnapshot {
  messages: NonNullable<FakeLogEntry["message"]>[];
  // Bytes after the final newline are a record still being written; they are
  // not a receipt even when they already parse as valid JSON.
  pending: boolean;
}

function snapshotInputs(text: string): InputSnapshot {
  // Completion is framing, not parseability: locate the final LF on the raw
  // text before trimming, then decode only newline-completed records through
  // the shared parser. A malformed completed line still throws here; an
  // unterminated suffix is unfinished, never silently accepted.
  const lastNewline = text.lastIndexOf("\n");
  const completed = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
  return {
    messages: projectInputMessages(decodeLogLines(completed)),
    pending: text.length > 0 && !text.endsWith("\n"),
  };
}

async function waitForInputs(
  path: string,
  ready: (messages: Awaited<ReturnType<typeof inputs>>) => boolean,
  description: string,
  timeoutMs = 1_000,
): Promise<void> {
  // Only after restoring the controlled request clock. Neither microtask
  // flushing nor vi.waitFor (which advances fake time) is an I/O receipt.
  if (vi.isFakeTimers()) throw new Error("input receipts require real timers");
  const deadline = performance.now() + timeoutMs;
  let observed: Awaited<ReturnType<typeof inputs>> = [];
  let blocked: string | undefined;
  do {
    try {
      const snapshot = snapshotInputs(await readFile(path, "utf8"));
      observed = snapshot.messages;
      blocked = snapshot.pending ? "an unfinished trailing record" : undefined;
    } catch (error) {
      // The original callers can start polling before the child creates its
      // log. Other I/O/parse errors are real failures, not 'not ready yet',
      // and a missing log can never pass on a previously cached ready prefix.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      observed = [];
      blocked = "a not-yet-created log";
    }
    if (performance.now() >= deadline) break;
    // A ready completed prefix does not pass while a trailing record is
    // unfinished: the next poll may reveal its completion.
    if (blocked === undefined && ready(observed)) return;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(5, Math.max(0, deadline - performance.now())),
      ),
    );
  } while (performance.now() < deadline);
  throw new Error(
    `fake app-server did not receive ${description} within ${timeoutMs}ms; last inputs: ${JSON.stringify(observed)}${blocked ? `; still waiting on ${blocked}` : ""}`,
  );
}

async function waitForToolCall(path: string): Promise<void> {
  await waitForInputs(
    path,
    (messages) => messages.some((row) => row.method === "mcpServer/tool/call"),
    "a tool call",
    INNER_BUDGET_MS,
  );
}

// Narrow test-only seams keep the real startup/request/reset/elicitation bodies.
interface RequestTimerSeam {
  reject(error: ComputerUseClientError): void;
  dispatched: boolean;
  remainingMs: number;
  approvalWaiters: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface ClientSeam {
  child?: ChildProcessWithoutNullStreams;
  temporaryHome?: string;
  retiredChild?: ChildProcessWithoutNullStreams;
  retiredHome?: string;
  starting?: Promise<void>;
  cleanupError?: ComputerUseClientError;
  pending: Map<number, RequestTimerSeam>;
  approvedApps: Set<string>;
  requestTimeoutMs: number;
  resetting?: Promise<void>;
  ensureStarted(): Promise<void>;
  armRequestTimer(pending: RequestTimerSeam): void;
  request(...args: unknown[]): Promise<unknown>;
  handleServerRequest(
    child: ChildProcessWithoutNullStreams,
    message: Record<string, unknown>,
  ): Promise<void>;
}

function seam(client: ComputerUseClient): ClientSeam {
  return client as unknown as ClientSeam;
}

/** Expire the real startup timer only after the fake child received its RPC. */
async function startupTimeoutAfterReceipt(
  test: Harness,
  methods: readonly string[],
): Promise<unknown> {
  // Own a possible early rejection while waiting for the real child receipt.
  // If observation fails, this file's afterEach restores faults and closes the
  // registered client; close joins this startup before deleting its home.
  const outcome = test.client.probeTarget().then(
    () => undefined,
    (error: unknown) => error,
  );
  await waitForInputs(
    test.logPath,
    (messages) => messages.length >= methods.length,
    `${methods.join(" -> ")} startup requests`,
    INNER_BUDGET_MS,
  );
  const received = await inputs(test.logPath);
  expect(received.map((message) => message.method)).toEqual(methods);
  const receipt = received.at(-1);
  if (typeof receipt?.id !== "number")
    throw new Error("missing startup request id");
  expect(received.filter((message) => message.id === receipt.id)).toHaveLength(
    1,
  );
  const internal = seam(test.client);
  const pending = internal.pending.get(receipt.id);
  if (!pending?.timer) throw new Error("startup request is no longer armed");
  expect(pending.dispatched).toBe(true);
  expect(pending.approvalWaiters).toBe(0);
  const originalTimer = pending.timer;
  clearTimeout(originalTimer);
  // Keep the existing harness allowance for child startup. Once receipt is
  // proven, expire this exact request through its real timer/budget/reset path.
  pending.remainingMs = 0;
  internal.armRequestTimer(pending);
  expect(pending.timer).not.toBe(originalTimer);
  return outcome;
}

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function trackServerRequests(client: ComputerUseClient): Promise<void>[] {
  const internal = seam(client);
  const original = internal.handleServerRequest.bind(internal);
  const requests: Promise<void>[] = [];
  vi.spyOn(internal, "handleServerRequest").mockImplementation((...args) => {
    const request = original(...args);
    requests.push(request);
    return request;
  });
  return requests;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Pins zero src/ lines: this is the opt-in qualification fixture's own gate.
// Missing or mismatched components must block with exit 2 before any native probe.
describe("opt-in approval qualification fixture gate", () => {
  // A fresh Node process that stops at preflight, before any native probe.
  const PREFLIGHT_TIMEOUT_MS = 10_000;

  it.each(["missing", "mismatched"])(
    "blocks native qualification with %s components before any probe",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "pct-approval-preflight-"));
      temporaryDirectories.push(root);
      if (kind === "mismatched") {
        await mkdir(join(root, "cua_node", "bin"), { recursive: true });
        for (const file of [
          "codex",
          "cua_node/bin/node_repl",
          "cua_node/bin/node",
          "cua_node/manifest.json",
        ]) {
          await writeFile(join(root, file), "not qualified", { mode: 0o700 });
        }
      }
      const fixture = fileURLToPath(
        new URL(
          "./fixtures/computer-use-approval-runtime.mjs",
          import.meta.url,
        ),
      );
      const result = await promisify(execFile)(
        process.execPath,
        [fixture, "--preflight-only", root],
        { timeout: PREFLIGHT_TIMEOUT_MS },
      ).then(
        (output) => ({ ...output, code: 0 }),
        (error) => ({
          stdout: error.stdout,
          stderr: error.stderr,
          code: error.code,
        }),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        status: "blocked",
        nativeProbeStarts: 0,
        versionProbeStarts: 0,
        reason:
          process.platform !== "darwin" || process.arch !== "arm64"
            ? "unsupported-platform"
            : kind === "missing"
              ? "missing-component"
              : "component-identity-mismatch",
      });
    },
    outerBudget(PREFLIGHT_TIMEOUT_MS),
  );
});

describe("Computer Use runtime discovery", () => {
  it("requires one paired ChatGPT bundle and the installed helper", () => {
    const resources = "/Applications/Test ChatGPT.app/Contents/Resources";
    const codexHome = "/test-codex-home";
    const required = new Set([
      join(resources, "codex"),
      join(resources, "cua_node", "bin", "node_repl"),
      join(resources, "cua_node", "bin", "node"),
      join(resources, "cua_node", "lib", "node_modules"),
      join(codexHome, "computer-use", "Codex Computer Use.app"),
    ]);
    const ready = inspectComputerUseRuntime({
      resourcesPath: resources,
      codexHome,
      exists: (path) => required.has(path),
    });

    expect(ready).toEqual({
      ok: true,
      runtime: {
        codexPath: join(resources, "codex"),
        nodeReplPath: join(resources, "cua_node", "bin", "node_repl"),
        nodePath: join(resources, "cua_node", "bin", "node"),
        nodeModulesPath: join(resources, "cua_node", "lib", "node_modules"),
        helperPath: join(codexHome, "computer-use", "Codex Computer Use.app"),
      },
    });

    required.delete(join(resources, "cua_node", "bin", "node"));
    expect(
      inspectComputerUseRuntime({
        resourcesPath: resources,
        codexHome,
        exists: (path) => required.has(path),
      }),
    ).toEqual({
      ok: false,
      reason: "missing-chatgpt-desktop-component",
    });
    required.add(join(resources, "cua_node", "bin", "node"));
    required.delete(join(codexHome, "computer-use", "Codex Computer Use.app"));
    expect(
      inspectComputerUseRuntime({
        resourcesPath: resources,
        codexHome,
        exists: (path) => required.has(path),
      }),
    ).toEqual({ ok: false, reason: "missing-computer-use-helper" });
  });
});

describe("Computer Use transport and approval lifetime regressions", () => {
  // An isolated Node process that owns a real fake peer. After a failed probe
  // the peer's own 1 s watchdog must also expire before the root is removed.
  const EPIPE_PROBE_TIMEOUT_MS = 30_000;
  const PEER_WATCHDOG_EXIT_MS = 1_100;

  it(
    "contains a real OS EPIPE at the client action write boundary in an isolated process",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "pct-computer-use-epipe-"),
      );
      temporaryDirectories.push(directory);
      const fixture = fileURLToPath(
        new URL("./fixtures/computer-use-epipe.mjs", import.meta.url),
      );
      const result = await promisify(execFile)(
        process.execPath,
        [fixture, directory],
        {
          timeout: EPIPE_PROBE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
      ).then(
        (output) => ({ ...output, code: 0 }),
        async (error) => {
          // The fake peer's 1s watchdog owns its lifetime even if this probe
          // crashes. Let it exit before afterEach removes this exact root.
          await new Promise((resolve) =>
            setTimeout(resolve, PEER_WATCHDOG_EXIT_MS),
          );
          return {
            stdout: error.stdout,
            stderr: error.stderr,
            code: error.code,
          };
        },
      );
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        codes: ["EPIPE"],
        submissions: 1,
        settlements: 1,
        cleaned: true,
      });
      expect(await readdir(join(directory, "homes"))).toEqual([]);
    },
    outerBudget(EPIPE_PROBE_TIMEOUT_MS + PEER_WATCHDOG_EXIT_MS),
  );

  it.each(
    [
      "initialize",
      "initialized",
      "request",
      "accept",
      "decline",
      "unsupported",
    ].flatMap((target) =>
      ["callback", "stream", "throw"].map((failure) => ({ target, failure })),
    ),
  )(
    "owns $failure failures on $target writes without exposing payloads or replaying",
    async ({ target, failure }) => {
      const test = await harness(
        target === "unsupported" ? "unsupported-request" : "session-approval",
      );
      const internal = seam(test.client);
      const request = internal.request.bind(internal);
      let intercepted: ChildProcessWithoutNullStreams | undefined;
      let attempts = 0;
      const rejected: ReturnType<typeof vi.spyOn>[] = [];
      vi.spyOn(internal, "request").mockImplementation((...args) => {
        const child = internal.child!;
        if (child && child !== intercepted) {
          intercepted = child;
          const write = child.stdin.write.bind(child.stdin);
          vi.spyOn(child.stdin, "write").mockImplementation(
            (...writeArgs: unknown[]) => {
              const message = JSON.parse(String(writeArgs[0]));
              const matches =
                target === "request"
                  ? message.method === "mcpServer/tool/call"
                  : target === "accept" || target === "decline"
                    ? message.result?.action === target
                    : target === "unsupported"
                      ? message.error?.code === -32601
                      : message.method === target;
              if (!matches)
                return (write as (...args: unknown[]) => boolean)(...writeArgs);
              attempts++;
              for (const pending of internal.pending.values())
                rejected.push(vi.spyOn(pending, "reject"));
              const error = new Error("PROTECTED_STDIN_WRITE_ERROR");
              if (failure === "throw") throw error;
              queueMicrotask(() => {
                if (failure === "stream") child.stdin.emit("error", error);
                else (writeArgs.at(-1) as (error: Error) => void)(error);
              });
              return true;
            },
          );
        }
        return request(...args);
      });
      const outcome = await test.client
        .invoke(
          "click",
          { app: "App A" },
          undefined,
          async () => target !== "decline",
        )
        .catch((error) => error);
      expect(outcome).toBeInstanceOf(ComputerUseClientError);
      expect(outcome).toMatchObject({
        category: "process-exit",
        unknownDesktopOutcome:
          target !== "initialize" && target !== "initialized",
      });
      expect(String(outcome)).not.toContain("PROTECTED");
      expect(attempts).toBe(1);
      for (const reject of rejected) expect(reject).toHaveBeenCalledOnce();
      expect(internal.pending.size).toBe(0);
      await test.client.close();
      expect(await readdir(test.homes)).toEqual([]);
      const messages = await inputs(test.logPath).catch((error) => {
        if (target !== "initialize" || error.code !== "ENOENT") throw error;
        return [];
      });
      const calls = messages.filter(
        (message) => message.method === "mcpServer/tool/call",
      );
      expect(calls.length).toBeLessThanOrEqual(1);
    },
  );

  it.each(["sync", "async"])(
    "declines a %s UI failure without granting authority",
    async (kind) => {
      const test = await harness("session-approval");
      const handler = () => {
        if (kind === "sync") throw new Error("PROTECTED_UI_ERROR");
        return Promise.reject(new Error("PROTECTED_UI_ERROR"));
      };
      await expect(
        test.client.invoke(
          "get_app_state",
          { app: "App A" },
          undefined,
          handler,
        ),
      ).rejects.toMatchObject({ category: "mcp-error" });
      expect(seam(test.client).approvedApps.size).toBe(0);
      const replies = (await inputs(test.logPath)).filter(
        (message) => !message.method,
      );
      expect(replies.map((message) => message.result)).toEqual([
        { action: "decline", content: null, _meta: null },
      ]);
    },
  );

  it("observes a rejected fire-and-forget server handler at its transport boundary", async () => {
    const test = await harness("session-approval");
    vi.spyOn(seam(test.client), "handleServerRequest").mockRejectedValue(
      new Error("PROTECTED_HANDLER_ERROR"),
    );
    await expect(
      test.client.invoke("click", { app: "App A" }),
    ).rejects.toMatchObject({
      category: "process-exit",
      unknownDesktopOutcome: true,
    });
    await test.client.close();
    expect(await readdir(test.homes)).toEqual([]);
  });

  it.each(
    ["reset", "close"].flatMap((boundary) =>
      ["throw", "refuse", "timeout"].map((failure) => ({ boundary, failure })),
    ),
  )(
    "retains exact child/home after $boundary kill $failure and retries cleanup explicitly",
    async ({ boundary, failure }) => {
      const test = await harness("session-approval");
      const internal = seam(test.client);
      await internal.ensureStarted();
      const child = internal.child!;
      const home = internal.temporaryHome!;
      const kill = child.kill.bind(child);
      const closeListeners = child.listenerCount("close");
      const entered = barrier<void>();
      const decision = barrier<boolean>();
      const handlers = trackServerRequests(test.client);
      if (failure !== "throw") {
        internal.requestTimeoutMs = 20_000;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const result = test.client
        .invoke("click", { app: "App A" }, undefined, () => {
          entered.resolve();
          return decision.promise;
        })
        .catch((error) => error);
      let cleanup: Promise<unknown> | undefined;
      try {
        await entered.promise;
        const refusedKill = vi.spyOn(child, "kill").mockImplementation(() => {
          if (failure === "throw") throw new Error("PROTECTED_CLEANUP_ERROR");
          // A true return is signal submission, not confirmed termination.
          return failure === "timeout";
        });
        if (boundary === "close") {
          cleanup = test.client.close().catch((error) => error);
        } else {
          child.stdin.emit("error", new Error("PROTECTED_STREAM_ERROR"));
          cleanup = internal.resetting!.catch((error) => error);
        }
        if (failure !== "throw") {
          let settled = false;
          // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: cleanup ends in .catch((error) => error) and this callback only sets a flag; awaiting would stall before the timers advance
          void cleanup.then(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(4_999);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(await result).toMatchObject({
          category: boundary === "close" ? "closed" : "process-exit",
          unknownDesktopOutcome: true,
        });
        const error = await cleanup;
        expect(error).toBeInstanceOf(ComputerUseClientError);
        expect(error).toMatchObject({ category: "process-exit" });
        expect(String(error)).not.toContain("PROTECTED");
        expect(refusedKill).toHaveBeenCalledOnce();
        expect(child.listenerCount("close")).toBe(closeListeners);
        if (failure !== "throw") expect(vi.getTimerCount()).toBe(0);
        expect(internal.child).toBeUndefined();
        expect(internal.temporaryHome).toBeUndefined();
        expect(internal.retiredChild).toBe(child);
        expect(internal.retiredHome).toBe(home);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(() => process.kill(child.pid!, 0)).not.toThrow();
        await expect(access(home)).resolves.toBeUndefined();
        await expect(
          test.client.invoke("get_app_state", { app: "App A" }),
        ).rejects.toMatchObject({
          category: boundary === "close" ? "closed" : "process-exit",
        });
        expect(internal.pending.size).toBe(0);
        // Retention is not renewed transport/approval authority.
        child.stdin.emit("error", new Error("PROTECTED_RETIRED_ERROR"));
        decision.resolve(true);
        await Promise.all(handlers);
        expect(internal.approvedApps.size).toBe(0);
        expect(refusedKill).toHaveBeenCalledOnce();
        expect((await inputs(test.logPath)).filter((m) => !m.method)).toEqual(
          [],
        );
        expect(
          (await logs(test.logPath)).filter((m) => m.type === "environment"),
        ).toHaveLength(1);

        refusedKill.mockRestore();
        vi.useRealTimers();
        const retriedKill = vi.spyOn(child, "kill");
        await test.client.close();
        expect(retriedKill).toHaveBeenCalledOnce();
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        expect(internal.retiredChild).toBeUndefined();
        expect(internal.retiredHome).toBeUndefined();
        expect(internal.cleanupError).toBeUndefined();
        expect(await readdir(test.homes)).toEqual([]);
        await test.client.close();
        expect(retriedKill).toHaveBeenCalledOnce();
      } finally {
        decision.resolve(false);
        vi.useRealTimers();
        vi.restoreAllMocks();
        await result;
        await cleanup;
        await Promise.all(handlers);
        try {
          await test.client.close();
        } finally {
          // Assertion-failure rescue only; success above must be client-owned.
          if (child.exitCode === null && child.signalCode === null) {
            const closed = once(child, "close");
            kill();
            await closed;
          }
          await rm(home, { recursive: true, force: true });
        }
      }
    },
  );

  it.each(["reset", "close"])(
    "retains only the exact home after %s stops the child but removal fails",
    async (boundary) => {
      const test = await harness("delayed-exit");
      const internal = seam(test.client);
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      await test.client.invoke("list_apps", {});
      const child = internal.child!;
      const home = internal.temporaryHome!;
      const kill = child.kill.bind(child);
      const killed = vi.spyOn(child, "kill");
      const attempts: string[] = [];
      let rejectRemoval = true;
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (path === home) {
          attempts.push(home);
          expect(child.exitCode !== null || child.signalCode !== null).toBe(
            true,
          );
          if (rejectRemoval) throw new Error("PROTECTED_HOME_REMOVAL_ERROR");
        }
        return actual.rm(path, options);
      });
      try {
        let cleanup: Promise<void>;
        if (boundary === "close") cleanup = test.client.close();
        else {
          child.stdout.emit("data", "invalid-json\n");
          cleanup = internal.resetting!;
        }
        await expect(cleanup).rejects.toMatchObject({
          category: "process-exit",
        });
        expect(killed).toHaveBeenCalledOnce();
        expect(internal.child).toBeUndefined();
        expect(internal.retiredChild).toBeUndefined();
        expect(internal.retiredHome).toBe(home);
        expect(await readFile(join(home, "late-write"), "utf8")).toBe("late");
        await expect(test.client.invoke("list_apps", {})).rejects.toMatchObject(
          {
            category: boundary === "close" ? "closed" : "process-exit",
          },
        );
        expect(
          (await logs(test.logPath)).filter((m) => m.type === "environment"),
        ).toHaveLength(1);
        await expect(test.client.close()).rejects.toMatchObject({
          category: "process-exit",
        });
        expect(internal.retiredHome).toBe(home);
        rejectRemoval = false;
        await test.client.close();
        expect(attempts).toEqual([home, home, home]);
        expect(killed).toHaveBeenCalledOnce();
        expect(internal.retiredHome).toBeUndefined();
        expect(internal.cleanupError).toBeUndefined();
        expect(await readdir(test.homes)).toEqual([]);
      } finally {
        vi.mocked(rm).mockImplementation(actual.rm);
        killed.mockRestore();
        try {
          await test.client.close();
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            const closed = once(child, "close");
            kill();
            await closed;
          }
          await actual.rm(home, { recursive: true, force: true });
        }
      }
    },
  );

  it("accepts real eventual close after kill returns false without early home removal", async () => {
    const test = await harness("delayed-exit");
    await test.client.invoke("list_apps", {});
    const internal = seam(test.client);
    const child = internal.child!;
    const home = internal.temporaryHome!;
    const kill = child.kill.bind(child);
    const killed = vi.spyOn(child, "kill").mockReturnValue(false);
    let settled = false;
    const closing = test.client.close().then(() => {
      settled = true;
    });
    // Observe rejection immediately even if an assertion fails before awaiting close.
    const outcome = closing.catch((error) => error);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      await expect(access(home)).resolves.toBeUndefined();
      kill();
      expect(await outcome).toBeUndefined();
      expect(settled).toBe(true);
      expect(killed).toHaveBeenCalledOnce();
      expect(await readdir(test.homes)).toEqual([]);
    } finally {
      killed.mockRestore();
      if (child.exitCode === null && child.signalCode === null) kill();
      await outcome;
      await test.client.close();
    }
  });

  it.each([false, true])(
    "joins in-flight handshake cleanup without a startup/reset cycle (kill refuses=%s)",
    async (refuses) => {
      const test = await harness();
      const internal = seam(test.client);
      const entered = barrier<void>();
      const request = internal.request.bind(internal);
      let child: ChildProcessWithoutNullStreams | undefined;
      let home: string | undefined;
      vi.spyOn(internal, "request").mockImplementation((...args) => {
        const result = request(...args);
        if (args[0] === "initialize") {
          child = internal.child;
          home = internal.temporaryHome;
          entered.resolve();
        }
        return result;
      });
      const result = test.client
        .invoke("list_apps", {})
        .catch((error) => error);
      try {
        await entered.promise;
        expect(internal.starting).toBeDefined();
        if (refuses) {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          vi.spyOn(child!, "kill").mockReturnValue(false);
        }
        const closing = test.client.close().catch((error) => error);
        const concurrentClose = test.client.close().catch((error) => error);
        if (refuses) await vi.advanceTimersByTimeAsync(5_000);
        vi.useRealTimers();
        expect(await result).toMatchObject({
          category: refuses ? "process-exit" : "closed",
        });
        if (refuses) {
          expect(await closing).toMatchObject({ category: "process-exit" });
          expect(await concurrentClose).toMatchObject({
            category: "process-exit",
          });
          expect(internal.retiredChild).toBe(child);
          expect(internal.retiredHome).toBe(home);
          await expect(access(home!)).resolves.toBeUndefined();
        } else {
          expect(await closing).toBeUndefined();
          expect(await concurrentClose).toBeUndefined();
        }
        expect(internal.starting).toBeUndefined();
        vi.restoreAllMocks();
        await test.client.close();
        expect(child!.exitCode !== null || child!.signalCode !== null).toBe(
          true,
        );
        expect(internal.retiredChild).toBeUndefined();
        expect(internal.retiredHome).toBeUndefined();
        expect(await readdir(test.homes)).toEqual([]);
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
        if (child && child.exitCode === null && child.signalCode === null)
          child.kill();
        await result;
        try {
          await test.client.close();
        } finally {
          if (child && child.exitCode === null && child.signalCode === null) {
            const closed = once(child, "close");
            child.kill();
            await closed;
          }
          if (home) await rm(home, { recursive: true, force: true });
        }
      }
    },
  );

  it.each(
    ["close", "abort"].flatMap((boundary) =>
      [false, true].map((removalFails) => ({ boundary, removalFails })),
    ),
  )(
    "joins gated allocation/$boundary cleanup with removal failure=$removalFails",
    async ({ boundary, removalFails }) => {
      const test = await harness();
      const internal = seam(test.client);
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      const allocated = barrier<void>();
      const releaseAllocation = barrier<void>();
      const removing = barrier<void>();
      const releaseRemoval = barrier<void>();
      let home: string | undefined;
      let rejectRemoval = removalFails;
      const removed: string[] = [];
      vi.mocked(mkdtemp).mockImplementation(async (prefix, options) => {
        const path = await actual.mkdtemp(prefix, options);
        home = String(path);
        allocated.resolve();
        await releaseAllocation.promise;
        return path;
      });
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (path === home) {
          removed.push(home);
          removing.resolve();
          await releaseRemoval.promise;
          if (rejectRemoval) throw new Error("PROTECTED_HOME_REMOVAL_ERROR");
        }
        return actual.rm(path, options);
      });
      const controller = new AbortController();
      const result = test.client
        .invoke("list_apps", {}, controller.signal)
        .catch((error) => error);
      let closeSettled = false;
      let closing: Promise<unknown> | undefined;
      let concurrentClose: Promise<unknown> | undefined;
      try {
        await allocated.promise;
        if (boundary === "close") {
          closing = test.client.close().then(
            () => {
              closeSettled = true;
            },
            (error) => {
              closeSettled = true;
              return error;
            },
          );
          concurrentClose = test.client.close().catch((error) => error);
          await internal.resetting;
          // Drain reactions from the initial empty reset, not the allocation.
          await Promise.resolve();
          await Promise.resolve();
          expect(closeSettled).toBe(false);
        } else {
          controller.abort();
        }
        expect(internal.starting).toBeDefined();
        await expect(access(home!)).resolves.toBeUndefined();
        releaseAllocation.resolve();
        await removing.promise;
        expect(closeSettled).toBe(false);
        expect(internal.child).toBeUndefined();
        await expect(access(test.logPath)).rejects.toThrow();
        releaseRemoval.resolve();
        expect(await result).toMatchObject({
          category: removalFails
            ? "process-exit"
            : boundary === "close"
              ? "closed"
              : "aborted",
        });
        if (closing) {
          if (removalFails) {
            expect(await closing).toMatchObject({ category: "process-exit" });
            expect(await concurrentClose).toMatchObject({
              category: "process-exit",
            });
          } else {
            expect(await closing).toBeUndefined();
            expect(await concurrentClose).toBeUndefined();
          }
        }
        expect(internal.starting).toBeUndefined();
        expect(removed).toEqual([home]);
        if (removalFails) {
          expect(internal.retiredHome).toBe(home);
          expect(internal.cleanupError).toMatchObject({
            category: "process-exit",
          });
          await expect(access(home!)).resolves.toBeUndefined();
          await expect(
            test.client.invoke("list_apps", {}),
          ).rejects.toMatchObject({
            category: boundary === "close" ? "closed" : "process-exit",
          });
          await expect(test.client.close()).rejects.toMatchObject({
            category: "process-exit",
          });
          expect(internal.retiredHome).toBe(home);
          rejectRemoval = false;
          await test.client.close();
          expect(removed).toEqual([home, home, home]);
        } else {
          await test.client.close();
        }
        expect(internal.retiredHome).toBeUndefined();
        expect(internal.cleanupError).toBeUndefined();
        expect(await readdir(test.homes)).toEqual([]);
        await expect(access(test.logPath)).rejects.toThrow();
      } finally {
        releaseAllocation.resolve();
        releaseRemoval.resolve();
        vi.mocked(mkdtemp).mockImplementation(actual.mkdtemp);
        vi.mocked(rm).mockImplementation(actual.rm);
        await result;
        await closing;
        await concurrentClose;
        try {
          await test.client.close();
        } finally {
          if (home) await actual.rm(home, { recursive: true, force: true });
        }
      }
    },
  );

  it.each(
    [
      "timeout",
      "abort",
      "reset",
      "close",
      "completion",
      "exit",
      "write-error",
      "rpc-error",
    ].flatMap((end) => [true, false].map((answer) => ({ end, answer }))),
  )(
    "discards late $answer after $end, before cache mutation or a colliding reply",
    async ({ end, answer }) => {
      const test = await harness(
        end === "completion" ? "elicitation-completes" : "session-approval",
      );
      const internal = seam(test.client);
      const handlers = trackServerRequests(test.client);
      await internal.ensureStarted();
      const oldChild = internal.child!;
      const entered = barrier<void>();
      const decision = barrier<boolean>();
      const controller = new AbortController();
      let confirmationSignal: AbortSignal | undefined;
      const old = test.client
        .invoke(
          "get_app_state",
          { app: "App A" },
          controller.signal,
          (_message, signal) => {
            confirmationSignal = signal;
            entered.resolve();
            return decision.promise;
          },
        )
        .then(
          (value) => value,
          (error) => error,
        );
      let replacement: Promise<unknown> | undefined;
      const newDecision = barrier<boolean>();
      try {
        await entered.promise;
        expect(confirmationSignal).not.toBe(controller.signal);
        if (end === "timeout") {
          // An unrelated finite RPC still resets a held human confirmation.
          await expect(
            internal.request("fake/never-reply", {}, undefined, 20),
          ).rejects.toMatchObject({ category: "timeout" });
        }
        if (end === "exit") oldChild.emit("exit", 17);
        if (end === "write-error")
          oldChild.stdin.emit("error", new Error("test"));
        if (end === "rpc-error")
          oldChild.stdout.emit(
            "data",
            `${JSON.stringify({
              id: [...internal.pending.keys()][0],
              error: { code: -32000 },
            })}\n`,
          );
        if (end === "abort") controller.abort();
        if (end === "reset") oldChild.stdout.emit("data", "not-json\n");
        if (end === "close") await test.client.close();
        const outcome = await old;
        expect(confirmationSignal?.aborted).toBe(true);
        if (end !== "completion") {
          expect(outcome).toMatchObject({
            category:
              end === "reset"
                ? "invalid-response"
                : end === "abort"
                  ? "aborted"
                  : end === "close"
                    ? "closed"
                    : end === "exit" || end === "write-error"
                      ? "process-exit"
                      : end === "rpc-error"
                        ? "app-server-error"
                        : "timeout",
          });
        }
        internal.requestTimeoutMs = HARNESS_REQUEST_TIMEOUT_MS;
        if (end !== "close") {
          const newEntered = barrier<void>();
          replacement = test.client
            .invoke("get_app_state", { app: "App A" }, undefined, () => {
              newEntered.resolve();
              return newDecision.promise;
            })
            .then(
              (value) => value,
              (error) => error,
            );
          await newEntered.promise;
          if (end !== "completion" && end !== "rpc-error")
            expect(internal.child).not.toBe(oldChild);
          else expect(internal.child).toBe(oldChild);
        }
        decision.resolve(answer);
        await handlers[0];
        expect(internal.approvedApps.has("com.example.app-a")).toBe(false);
        expect(
          (await inputs(test.logPath)).filter((message) => !message.method),
        ).toEqual([]);
        if (replacement) {
          expect(internal.pending.size).toBe(1);
          newDecision.resolve(true);
          expect(await replacement).toMatchObject({
            details: { method: "get_app_state" },
          });
          const replies = (await inputs(test.logPath)).filter(
            (message) => !message.method,
          );
          expect(replies).toHaveLength(1);
          expect(replies[0]).toMatchObject({
            id:
              end === "completion"
                ? "approval-request"
                : end === "rpc-error"
                  ? "approval-request-2"
                  : "approval-request-1",
            result: {
              action: "accept",
              content: {},
              _meta: { persist: "session" },
            },
          });
        }
      } finally {
        decision.resolve(false);
        newDecision.resolve(false);
        await test.client.close();
        await old;
        await replacement;
        await Promise.all(handlers);
      }
      expect(await readdir(test.homes)).toEqual([]);
    },
  );

  it("keeps already valid client grants across ordinary reset", async () => {
    const test = await harness("session-approval");
    const approval = vi.fn(async () => true);
    await test.client.invoke(
      "get_app_state",
      { app: "App A" },
      undefined,
      approval,
    );
    const internal = seam(test.client);
    internal.child!.stdout.emit("data", "invalid-json\n");
    await internal.resetting;
    await test.client.invoke(
      "get_app_state",
      { app: "App A" },
      undefined,
      approval,
    );
    expect(approval).toHaveBeenCalledOnce();
    const replies = (await inputs(test.logPath)).filter(
      (message) => !message.method,
    );
    expect(replies.at(-1)?.result).toEqual({
      action: "accept",
      content: {
        source: "computer-use-persisted-state",
        scope: "conversation",
      },
      _meta: null,
    });
  });

  it("ignores retired child callback/error/exit/stdout while a replacement approval is pending", async () => {
    const test = await harness("session-approval");
    const internal = seam(test.client);
    await internal.ensureStarted();
    const oldChild = internal.child!;
    const write = oldChild.stdin.write.bind(oldChild.stdin);
    let lateCallback: ((error?: Error | null) => void) | undefined;
    vi.spyOn(oldChild.stdin, "write").mockImplementation(
      (...args: unknown[]) => {
        lateCallback = args.at(-1) as typeof lateCallback;
        return write(args[0] as string);
      },
    );
    const controller = new AbortController();
    const entered = barrier<void>();
    const decision = barrier<boolean>();
    const first = test.client
      .invoke("click", { app: "App A" }, controller.signal, () => {
        entered.resolve();
        return decision.promise;
      })
      .catch((error) => error);
    const handlers = trackServerRequests(test.client);
    const nextEntered = barrier<void>();
    const nextDecision = barrier<boolean>();
    let next: Promise<unknown> | undefined;
    try {
      await entered.promise;
      controller.abort();
      expect(await first).toMatchObject({
        category: "aborted",
        unknownDesktopOutcome: true,
      });
      next = test.client
        .invoke("get_app_state", { app: "App A" }, undefined, () => {
          nextEntered.resolve();
          return nextDecision.promise;
        })
        .catch((error) => error);
      await nextEntered.promise;
      const replacement = internal.child!;
      const kill = vi.spyOn(replacement, "kill");
      const reject = vi.fn();
      // The replacement must survive even if retired traffic guesses its ID.
      const id = [...internal.pending.keys()][0];
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: next ends in .catch((error) => error) and reject is a bare vi.fn(); awaiting would block until nextDecision resolves
      void next.then(reject);
      const error = new Error("PROTECTED_OLD_TRANSPORT_ERROR");
      expect(lateCallback).toBeTypeOf("function");
      lateCallback?.(error);
      lateCallback?.(error);
      oldChild.stdin.emit("error", error);
      oldChild.stdin.emit("error", error);
      oldChild.emit("error", error);
      oldChild.emit("error", error);
      oldChild.emit("exit", 1);
      oldChild.stdout.emit(
        "data",
        `${JSON.stringify({ id, result: {} })}\ninvalid\n`,
      );
      decision.resolve(true);
      await handlers[0];
      expect(internal.child).toBe(replacement);
      expect(internal.pending.size).toBe(1);
      expect(kill).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
      expect(internal.approvedApps.size).toBe(0);
      nextDecision.resolve(true);
      expect(await next).toMatchObject({
        details: { method: "get_app_state" },
      });
      expect(internal.pending.size).toBe(0);
      expect(
        (await inputs(test.logPath)).filter(
          (message) => message.method === "mcpServer/tool/call",
        ),
      ).toHaveLength(2);
    } finally {
      decision.resolve(false);
      nextDecision.resolve(false);
      await test.client.close();
      await first;
      await next;
      await Promise.all(handlers);
    }
  });
});

describe("Computer Use active budget", () => {
  // Real startup/child and actual client bodies; only clock and inbound fake
  // peer events are controlled. No real desktop or UI renderer is involved.
  // Affected success/control cases only: startup RPCs (up to three requests plus
  // readiness), an optional control request, receipt 3s (including held input),
  // close grace 5s, and the scheduling/assertion margin. Not a product budget.
  const receiptTestTimeoutMs = outerBudget(
    3 * HARNESS_REQUEST_TIMEOUT_MS +
      HARNESS_STARTUP_TIMEOUT_MS +
      HARNESS_REQUEST_TIMEOUT_MS +
      3_000 +
      5_000,
  );

  async function withReceiptHarness(
    body: (test: Harness) => Promise<void>,
    inputHoldMs = 0,
  ) {
    const errors: unknown[] = [];
    let test: Harness | undefined;
    try {
      test = await harness("hang");
      if (inputHoldMs) {
        await seam(test.client).ensureStarted();
        await seam(test.client).request("fake/hold-input", {
          durationMs: inputHoldMs,
        });
      }
      await body(test);
    } catch (error) {
      errors.push(error);
    } finally {
      // Restoration and close remain independent even after failed setup,
      // assertions or receipt observation. The existing afterEach retains the
      // registered owner/root for close retry; no deletion follows failed close.
      try {
        vi.restoreAllMocks();
      } catch (error) {
        errors.push(error);
      }
      vi.useRealTimers();
      try {
        await test?.client.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, "active-budget body and cleanup failed");
    return test!;
  }

  async function activeCall(
    handler?: Parameters<ComputerUseClient["invoke"]>[3],
    owner?: Harness,
  ) {
    const test = owner ?? (await harness("hang"));
    const internal = seam(test.client);
    await internal.ensureStarted();
    internal.requestTimeoutMs = 100;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const controller = new AbortController();
    const outcome = test.client
      .invoke("click", { app: "synthetic" }, controller.signal, handler)
      .catch((error) => error);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const [id, pending] = [...internal.pending.entries()][0]!;
    const child = internal.child!;
    const send = (message: unknown) =>
      child.stdout.emit("data", `${JSON.stringify(message)}\n`);
    const approve = (id = "approval", params: Record<string, unknown> = {}) =>
      send({
        id,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-test",
          serverName: "node_repl",
          mode: "form",
          message: "synthetic",
          _meta: { connector_id: "computer-use", tool_params: { app: id } },
          ...params,
        },
      });
    const finish = () =>
      send({ id, result: { content: [{ type: "text", text: "done" }] } });
    return {
      ...test,
      internal,
      pending,
      controller,
      outcome,
      approve,
      finish,
      send,
    };
  }

  it.each([true, false])(
    "excludes a long approval then resumes remaining time after %s",
    async (answer) => {
      const decision = barrier<boolean>();
      const test = await activeCall(() => decision.promise);
      try {
        await vi.advanceTimersByTimeAsync(65);
        test.approve();
        expect(test.pending.remainingMs).toBe(35);
        expect(test.pending.approvalWaiters).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(test.internal.pending.size).toBe(1);
        decision.resolve(answer);
        await vi.advanceTimersByTimeAsync(0);
        expect(test.pending.approvalWaiters).toBe(0);
        await vi.advanceTimersByTimeAsync(34);
        expect(test.internal.pending.size).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await test.outcome).toMatchObject({
          category: "timeout",
          unknownDesktopOutcome: true,
        });
      } finally {
        decision.resolve(false);
        vi.useRealTimers();
        await test.client.close();
      }
    },
  );

  it.each([0, 1_000])(
    "succeeds once after a hold longer than the budget, cancelling its owned signal on result (input hold %sms)",
    async (inputHoldMs) => {
      const decision = barrier<boolean>();
      let signal: AbortSignal | undefined;
      const owner = await withReceiptHarness(async (owner) => {
        const test = await activeCall((_message, owned) => {
          signal = owned;
          return decision.promise;
        }, owner);
        try {
          test.approve();
          await vi.advanceTimersByTimeAsync(1_000);
          expect(signal?.aborted).toBe(false);
          decision.resolve(true);
          await vi.advanceTimersByTimeAsync(0);
          test.finish();
          expect(await test.outcome).toMatchObject({
            details: { method: "click" },
          });
          expect(signal?.aborted).toBe(true);
          expect(test.internal.pending.size).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
          vi.restoreAllMocks();
          vi.useRealTimers();
          await waitForInputs(
            test.logPath,
            (messages) =>
              messages.some((row) => row.method === "mcpServer/tool/call"),
            "a tool call before close",
            3_000,
          );
        } finally {
          decision.resolve(false);
        }
      }, inputHoldMs);
      expect(
        (await inputs(owner.logPath)).filter(
          (row) => row.method === "mcpServer/tool/call",
        ),
      ).toHaveLength(1);
      expect(await readdir(owner.homes)).toEqual([]);
    },
    receiptTestTimeoutMs,
  );

  it("conserves serial and overlapping waits without early rearm or progress refill", async () => {
    const decisions = [
      barrier<boolean>(),
      barrier<boolean>(),
      barrier<boolean>(),
    ];
    let index = 0;
    const test = await activeCall(() => decisions[index++]!.promise);
    try {
      await vi.advanceTimersByTimeAsync(25);
      test.approve("first");
      await vi.advanceTimersByTimeAsync(400);
      test.approve("second");
      expect(test.pending.remainingMs).toBe(75);
      expect(test.pending.approvalWaiters).toBe(2);
      decisions[0]!.resolve(true);
      await vi.advanceTimersByTimeAsync(400);
      expect(test.pending.approvalWaiters).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      decisions[1]!.resolve(false);
      await vi.advanceTimersByTimeAsync(30);
      test.approve("third");
      expect(test.pending.remainingMs).toBe(45);
      await vi.advanceTimersByTimeAsync(400);
      decisions[2]!.resolve(true);
      await vi.advanceTimersByTimeAsync(44);
      test.send({ method: "notifications/progress", params: { progress: 1 } });
      expect(test.internal.pending.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await test.outcome).toMatchObject({ category: "timeout" });
    } finally {
      for (const decision of decisions) decision.resolve(false);
      vi.useRealTimers();
      await test.client.close();
    }
  });

  it.each([
    { boundary: "pause", inputHoldMs: 0 },
    { boundary: "replacement", inputHoldMs: 0 },
    { boundary: "pause", inputHoldMs: 1_000 },
    { boundary: "replacement", inputHoldMs: 1_000 },
  ])(
    "ignores a superseded timer callback delivered during $boundary (input hold $inputHoldMs ms)",
    async ({ boundary, inputHoldMs }) => {
      const decisions = [
        barrier<boolean>(),
        barrier<boolean>(),
        barrier<boolean>(),
      ];
      let index = 0;
      let signal: AbortSignal | undefined;
      const owner = await withReceiptHarness(async (owner) => {
        const test = await activeCall((_message, owned) => {
          signal = owned;
          return decisions[index++]!.promise;
        }, owner);
        const timers = vi.spyOn(globalThis, "setTimeout");
        const reject = vi.spyOn(test.pending, "reject");
        // Independent parent-side oracle for owned outgoing replies. The
        // default call-through spy is installed after activeCall — startup
        // RPCs and the already-dispatched tool call precede it — and before
        // the first approval. It preserves receiver, arguments, callback,
        // return and thrown errors; it is not a child-receipt
        // acknowledgement.
        const handlers = trackServerRequests(test.client);
        const writes = vi.spyOn(test.internal.child!.stdin, "write");
        try {
          await vi.advanceTimersByTimeAsync(25);
          test.approve("first");
          decisions[0]!.resolve(false);
          await vi.advanceTimersByTimeAsync(0);
          const staleHandle = test.pending.timer;
          const staleCallback = timers.mock.calls[0]![0];
          expect(staleHandle).toBeDefined();
          expect(timers).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(30);
          test.approve("second");
          expect(test.pending.remainingMs).toBe(45);
          expect(test.pending.timer).toBeUndefined();
          expect(vi.getTimerCount()).toBe(0);

          // Deliberately inject a cancelled callback; this is not an ordinary
          // Node I/O reproducer. It must not restart a paused timer chain.
          if (boundary === "pause") {
            staleCallback();
            expect(test.pending.timer).toBeUndefined();
            expect(timers).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
          }
          await vi.advanceTimersByTimeAsync(1_000);
          expect(test.pending.remainingMs).toBe(45);
          decisions[1]!.resolve(false);
          await vi.advanceTimersByTimeAsync(0);
          const currentHandle = test.pending.timer;
          expect(currentHandle).toBeDefined();
          expect(currentHandle).not.toBe(staleHandle);
          expect(timers).toHaveBeenCalledTimes(2);
          expect(vi.getTimerCount()).toBe(1);

          // Nor may it erase an installed replacement or create a second chain.
          staleCallback();
          expect(test.pending.timer).toBe(currentHandle);
          expect(test.pending.remainingMs).toBe(45);
          expect(timers).toHaveBeenCalledTimes(2);
          expect(vi.getTimerCount()).toBe(1);
          await vi.advanceTimersByTimeAsync(44);
          test.approve("late");
          expect(test.pending.remainingMs).toBe(1);
          expect(vi.getTimerCount()).toBe(0);
          test.finish();
          expect(await test.outcome).toMatchObject({
            details: { method: "click" },
          });
          expect(signal?.aborted).toBe(true);
          decisions[2]!.resolve(true);
          staleCallback();
          await vi.advanceTimersByTimeAsync(1_000);
          expect(test.internal.pending.size).toBe(0);
          expect(test.pending.timer).toBeUndefined();
          expect(test.internal.approvedApps.size).toBe(0);
          expect(timers).toHaveBeenCalledTimes(2);
          expect(vi.getTimerCount()).toBe(0);
          expect(reject).not.toHaveBeenCalled();
          // Settle the three known approval-handler operations, then snapshot
          // the raw first write arguments before mock restoration could erase
          // them. Parsing happens here, outside the real write path: only
          // frames with no method and a defined protocol id are replies.
          await Promise.all(handlers);
          const written = writes.mock.calls.map((call) => String(call[0]));
          expect(
            written
              .map(
                (line) =>
                  JSON.parse(line) as {
                    id?: number | string;
                    method?: string;
                  },
              )
              .filter(
                (message) =>
                  message.method === undefined && message.id !== undefined,
              )
              .map((message) => message.id),
          ).toEqual(["first", "second"]);
          vi.restoreAllMocks();
          vi.useRealTimers();
          await waitForInputs(
            test.logPath,
            (messages) =>
              messages.filter((row) => !row.method).length >= 2 &&
              messages.some((row) => row.method === "mcpServer/tool/call"),
            "first/second replies and a tool call before close",
            3_000,
          );
        } finally {
          for (const decision of decisions) decision.resolve(false);
        }
      }, inputHoldMs);
      const messages = await inputs(owner.logPath);
      expect(
        messages.filter((row) => !row.method).map((row) => row.id),
      ).toEqual(["first", "second"]);
      expect(
        messages.filter((row) => row.method === "mcpServer/tool/call"),
      ).toHaveLength(1);
      expect(await readdir(owner.homes)).toEqual([]);
    },
    receiptTestTimeoutMs,
  );

  it.each(["setup", "body", "observation", "cleanup", "body-and-cleanup"])(
    "preserves receipt-test failures and owned settlement at %s",
    async (failure) => {
      const primary = new Error(`synthetic ${failure} failure`);
      let owner!: Harness;
      let child!: ChildProcessWithoutNullStreams;
      let closed!: Promise<unknown>;
      let observationFailure:
        | { elapsed: number; exit: number | null; signal: string | null }
        | undefined;
      const result = await withReceiptHarness(async (testOwner) => {
        owner = testOwner;
        // A setup failure after a real child exists must still reach close.
        await seam(owner.client).ensureStarted();
        child = seam(owner.client).child!;
        closed = once(child, "close");
        if (failure === "setup") throw primary;
        const test = await activeCall(undefined, owner);
        const clock = performance.now();
        await expect(
          waitForInputs(owner.logPath, () => true, "a receipt", 100),
        ).rejects.toThrow("input receipts require real timers");
        expect(performance.now()).toBe(clock);
        expect(vi.getTimerCount()).toBe(1);
        test.finish();
        expect(await test.outcome).toMatchObject({
          details: { method: "click" },
        });
        if (failure === "cleanup" || failure === "body-and-cleanup") {
          // The real child settles, but its home remains owned until explicit
          // retry of a one-shot removal failure. Do not erase the first error.
          vi.mocked(rm).mockRejectedValueOnce(
            new Error("synthetic cleanup failure"),
          );
        }
        if (failure === "body" || failure === "body-and-cleanup") throw primary;
        if (failure === "observation") {
          vi.restoreAllMocks();
          vi.useRealTimers();
          const started = performance.now();
          try {
            await waitForInputs(
              owner.logPath,
              (messages) => messages.some((row) => row.id === "never-sent"),
              "never-sent reply",
              100,
            );
          } catch (error) {
            observationFailure = {
              elapsed: performance.now() - started,
              exit: child.exitCode,
              signal: child.signalCode,
            };
            throw error;
          }
        }
      }).catch((error: unknown) => error);
      expect(vi.isFakeTimers()).toBe(false);
      await closed;
      expect(
        child.stdin.closed && child.stdout.closed && child.stderr.closed,
      ).toBe(true);
      expect(seam(owner.client).pending.size).toBe(0);
      if (failure === "body-and-cleanup") {
        expect(result).toBeInstanceOf(AggregateError);
        expect((result as AggregateError).errors).toEqual([
          primary,
          expect.objectContaining({ category: "process-exit" }),
        ]);
      } else if (failure === "cleanup") {
        expect(result).toMatchObject({ category: "process-exit" });
      } else if (failure === "observation") {
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toContain(
          "never-sent reply within 100ms; last inputs:",
        );
        expect(observationFailure).toMatchObject({ exit: null, signal: null });
        expect(observationFailure!.elapsed).toBeGreaterThanOrEqual(100);
        expect(observationFailure!.elapsed).toBeLessThan(1_000);
      } else {
        expect(result).toBe(primary);
      }
      if (failure === "cleanup" || failure === "body-and-cleanup") {
        expect(await readdir(owner.homes)).toHaveLength(1);
        expect(seam(owner.client).retiredHome).toBeDefined();
        await owner.client.close();
      }
      expect(await readdir(owner.homes)).toEqual([]);
    },
    receiptTestTimeoutMs,
  );

  it.each([
    "sync-yes",
    "sync-no",
    "throw",
    "reject",
    "cached",
    "no-handler",
    "foreign",
  ])("does not create human waiting for %s", async (mode) => {
    const handler = vi.fn(() => {
      if (mode === "throw") throw new Error("synthetic");
      if (mode === "reject") return Promise.reject(new Error("synthetic"));
      return mode !== "sync-no";
    });
    const test = await activeCall(mode === "no-handler" ? undefined : handler);
    try {
      if (mode === "cached") test.internal.approvedApps.add("approval");
      await vi.advanceTimersByTimeAsync(80);
      test.approve(
        "approval",
        mode === "foreign" ? { serverName: "foreign" } : {},
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(test.pending.approvalWaiters).toBe(0);
      if (["cached", "no-handler", "foreign"].includes(mode))
        expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(await test.outcome).toMatchObject({ category: "timeout" });
    } finally {
      vi.useRealTimers();
      await test.client.close();
    }
  });

  it.each([
    "before-handler",
    "sync-answer",
    "async-admission",
    "reentrant-abort",
  ])(
    "fences expired/reentrant authority at %s, observing rejected promises",
    async (boundary) => {
      let test: Awaited<ReturnType<typeof activeCall>>;
      const handler = vi.fn(() => {
        if (boundary === "reentrant-abort") test.controller.abort();
        else vi.spyOn(performance, "now").mockReturnValue(100);
        if (boundary === "sync-answer") return true;
        return Promise.reject(new Error("synthetic late rejection"));
      });
      test = await activeCall(handler);
      try {
        if (boundary === "before-handler")
          vi.spyOn(performance, "now").mockReturnValue(100);
        test.approve();
        await Promise.resolve();
        expect(await test.outcome).toMatchObject({
          category: boundary === "reentrant-abort" ? "aborted" : "timeout",
          unknownDesktopOutcome: true,
        });
        expect(test.internal.approvedApps.size).toBe(0);
        if (boundary === "before-handler")
          expect(handler).not.toHaveBeenCalled();
        expect(test.pending.timer).toBeUndefined();
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
        await test.client.close();
      }
      expect((await inputs(test.logPath)).filter((row) => !row.method)).toEqual(
        [],
      );
    },
  );

  it("does not grant a fresh slice when the remaining budget is below timer resolution", async () => {
    const decision = barrier<boolean>();
    const handler = vi.fn(() => decision.promise);
    const test = await activeCall(handler);
    try {
      await vi.advanceTimersByTimeAsync(99.75);
      test.approve("first");
      expect(test.pending.remainingMs).toBe(0.25);
      await vi.advanceTimersByTimeAsync(1_000);
      decision.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(test.pending.remainingMs).toBe(0.25);
      // A rounded timer may not fire at this fractional deadline. Admission
      // must independently check elapsed time, not trust timer delivery.
      await vi.advanceTimersByTimeAsync(0.25);
      test.approve("expired");
      expect(await test.outcome).toMatchObject({
        category: "timeout",
        unknownDesktopOutcome: true,
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(test.internal.approvedApps.has("expired")).toBe(false);
      expect(test.pending.timer).toBeUndefined();
    } finally {
      decision.resolve(false);
      vi.useRealTimers();
      await test.client.close();
    }
  });

  it.each(["result", "abort", "reset"])(
    "retires authority before synchronous confirmation cancellation reactions on %s",
    async (boundary) => {
      const decision = barrier<boolean>();
      let test: Awaited<ReturnType<typeof activeCall>>;
      let atCancellation: { pending: number; timer: unknown } | undefined;
      const handler = vi.fn((_message: string, signal: AbortSignal) => {
        signal.addEventListener(
          "abort",
          () => {
            atCancellation = {
              pending: test.internal.pending.size,
              timer: test.pending.timer,
            };
            // Reentrant inbound approval and a UI that resolves Yes on abort
            // must not recover the request's retired authority.
            test.approve("reentrant");
            decision.resolve(true);
          },
          { once: true },
        );
        return decision.promise;
      });
      test = await activeCall(handler);
      try {
        test.approve("first");
        if (boundary === "result") test.finish();
        else if (boundary === "abort") test.controller.abort();
        else test.internal.child!.stdout.emit("data", "invalid-json\n");
        expect(atCancellation).toEqual({ pending: 0, timer: undefined });
        const outcome = await test.outcome;
        if (boundary === "result")
          expect(outcome).toMatchObject({ details: { method: "click" } });
        else
          expect(outcome).toMatchObject({
            category: boundary === "abort" ? "aborted" : "invalid-response",
            unknownDesktopOutcome: true,
          });
        expect(handler).toHaveBeenCalledOnce();
        expect(test.internal.approvedApps.size).toBe(0);
        expect(test.pending.timer).toBeUndefined();
      } finally {
        decision.resolve(false);
        vi.useRealTimers();
        await test.client.close();
      }
      expect((await inputs(test.logPath)).filter((row) => !row.method)).toEqual(
        [],
      );
      expect(await readdir(test.homes)).toEqual([]);
    },
  );

  it("closes without awaiting an ignored signal and owns a late rejection", async () => {
    let reject!: (error: Error) => void;
    let signal: AbortSignal | undefined;
    const decision = new Promise<boolean>((_resolve, fail) => {
      reject = fail;
    });
    const test = await activeCall((_message, owned) => {
      signal = owned;
      return decision;
    });
    test.approve();
    vi.useRealTimers();
    await test.client.close();
    expect(await test.outcome).toMatchObject({
      category: "closed",
      unknownDesktopOutcome: true,
    });
    expect(signal?.aborted).toBe(true);
    expect(test.pending.timer).toBeUndefined();
    expect(test.internal.pending.size).toBe(0);
    expect(await readdir(test.homes)).toEqual([]);
    reject(new Error("synthetic late rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(test.internal.approvedApps.size).toBe(0);
  });
});

describe("app-server input log framing", () => {
  // Deterministic synthetic logs at test-owned paths only; nothing here is a
  // real fake-child receipt and no real child's log is touched. The common
  // snapshot decoder is exercised directly and the real poller is driven by
  // owned write sequences — a partial state is proven by the wait's own
  // last-complete-input diagnostics, never inferred from a sleep.
  const entry = (id: number | string) =>
    JSON.stringify({ type: "input", message: { id } });
  const hasId =
    (id: number | string) =>
    (messages: NonNullable<FakeLogEntry["message"]>[]) =>
      messages.some((row) => row.id === id);

  async function ownedLog(): Promise<{ directory: string; path: string }> {
    const directory = await mkdtemp(join(tmpdir(), "pct-input-framing-"));
    temporaryDirectories.push(directory);
    return { directory, path: join(directory, "synthetic-inputs.jsonl") };
  }

  it("classifies raw log bytes by newline completion, not parseability", () => {
    expect(snapshotInputs(`${entry("a")}\n`)).toEqual({
      messages: [{ id: "a" }],
      pending: false,
    });
    // A record that already parses is still unfinished without its newline.
    expect(snapshotInputs(`${entry("a")}\n${entry("b")}`)).toEqual({
      messages: [{ id: "a" }],
      pending: true,
    });
    expect(snapshotInputs(entry("b"))).toEqual({
      messages: [],
      pending: true,
    });
    expect(snapshotInputs(`${entry("a")}\n{"type":"input","mes`)).toEqual({
      messages: [{ id: "a" }],
      pending: true,
    });
    expect(snapshotInputs("")).toEqual({ messages: [], pending: false });
    // A CRLF line stays complete; the shared decoder tolerates the return.
    expect(snapshotInputs(`${entry("a")}\r\n`)).toEqual({
      messages: [{ id: "a" }],
      pending: false,
    });
    // A malformed completed record throws instead of looking unfinished.
    expect(() => snapshotInputs(`${entry("a")}\nnot-json\n`)).toThrow(
      SyntaxError,
    );
  });

  it("observes a partially written record only after its newline arrives", async () => {
    const { path } = await ownedLog();
    const complete = `${entry("tail")}\n`;
    const cut = complete.indexOf('"tail"');
    await writeFile(path, complete.slice(0, cut));
    // The ready predicate runs only on fully framed snapshots: while the
    // tail is unfinished it is never even evaluated, so no completed prefix
    // can silently pass.
    const evaluated: NonNullable<FakeLogEntry["message"]>[][] = [];
    const ready = (messages: NonNullable<FakeLogEntry["message"]>[]) => {
      evaluated.push(messages);
      return hasId("tail")(messages);
    };
    await expect(
      waitForInputs(path, ready, "the completed record", 250),
    ).rejects.toThrow(
      /within 250ms; last inputs: \[\]; still waiting on an unfinished trailing record/,
    );
    expect(evaluated).toEqual([]);
    // Completing the fragment makes the intended record observable.
    await appendFile(path, complete.slice(cut));
    await waitForInputs(path, ready, "the completed record", 1_000);
    expect(evaluated.at(-1)).toEqual([{ id: "tail" }]);
    await expect(inputs(path)).resolves.toEqual([{ id: "tail" }]);
  });

  it("waits for a syntactically valid final record missing only its newline", async () => {
    const { path } = await ownedLog();
    await writeFile(path, `${entry("head")}\n${entry("tail")}`);
    // Strict reads keep their default behavior and still parse the
    // unterminated but parseable tail; only polling treats it as unfinished.
    await expect(inputs(path)).resolves.toEqual([
      { id: "head" },
      { id: "tail" },
    ]);
    await expect(
      waitForInputs(path, hasId("tail"), "a newline-completed tail", 250),
    ).rejects.toThrow(
      /within 250ms; last inputs: \[{"id":"head"}\]; still waiting on an unfinished trailing record/,
    );
    await appendFile(path, "\n");
    await waitForInputs(path, hasId("tail"), "a newline-completed tail", 1_000);
  });

  it("fails at the deadline while an unfinished tail follows a ready prefix", async () => {
    const { path } = await ownedLog();
    await writeFile(path, `${entry("ready")}\n${entry("later").slice(0, 12)}`);
    const started = performance.now();
    await expect(
      waitForInputs(path, hasId("ready"), "a completed tail", 250),
    ).rejects.toThrow(
      /did not receive a completed tail within 250ms; last inputs: \[{"id":"ready"}\]; still waiting on an unfinished trailing record/,
    );
    // The existing monotonic deadline, not an inflated or guessed window.
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it.each(["middle", "final"])(
    "rejects a malformed %s completed record immediately",
    async (position) => {
      const { path } = await ownedLog();
      await writeFile(
        path,
        position === "middle"
          ? `${entry("early")}\nnot-json\n${entry("late")}\n`
          : `${entry("early")}\nnot-json\n`,
      );
      const started = performance.now();
      await expect(
        waitForInputs(path, () => true, "any input", 5_000),
      ).rejects.toThrow(SyntaxError);
      expect(performance.now() - started).toBeLessThan(1_000);
      // The strict reader fails on the same bytes; polling adds no new parser.
      await expect(logs(path)).rejects.toThrow(SyntaxError);
    },
  );

  it("waits for a missing log but propagates other I/O failures", async () => {
    const { directory, path } = await ownedLog();
    // An absent log may wait, but it can never satisfy readiness — even a
    // trivially-true predicate cannot pass on nothing ever read.
    const started = performance.now();
    await expect(
      waitForInputs(path, () => true, "a created log", 250),
    ).rejects.toThrow(
      /within 250ms; last inputs: \[\]; still waiting on a not-yet-created log/,
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    // A non-ENOENT I/O failure is a real error, not 'not ready yet': it
    // propagates immediately rather than consuming its deadline.
    const restart = performance.now();
    await expect(
      waitForInputs(directory, () => true, "a directory", 5_000),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect(performance.now() - restart).toBeLessThan(1_000);
  });
});

describe("narrow app-server client", () => {
  it("uses the isolated handshake, exact node_repl config, and one JS call", async () => {
    const test = await harness("readiness-delay");
    const result = await test.client.invoke("list_apps", {});
    await test.client.close();
    const allLogs = await logs(test.logPath);
    const messages = allLogs.flatMap((entry) =>
      entry.type === "input" && entry.message ? [entry.message] : [],
    );
    const methods = messages.map((message) => message.method);

    expect(methods).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "mcpServerStatus/list",
      "mcpServerStatus/list",
      "mcpServer/tool/call",
    ]);
    expect(
      messages
        .filter((message) => message.id !== undefined)
        .map(({ id }) => id),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(messages[0]?.params).toMatchObject({
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        extensions: { "openai/form": {} },
      },
    });

    const thread = messages.find(
      (message) => message.method === "thread/start",
    );
    expect(thread?.params).toMatchObject({
      ephemeral: true,
      sandbox: "read-only",
    });
    expect(thread?.params?.approvalPolicy).toEqual({
      granular: {
        sandbox_approval: false,
        rules: false,
        skill_approval: false,
        request_permissions: false,
        mcp_elicitations: true,
      },
    });
    const config = thread?.params?.config as Record<string, unknown>;
    const servers = config.mcp_servers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["node_repl"]);
    expect(servers).not.toHaveProperty("computer-use");
    const nodeRepl = servers.node_repl as Record<string, unknown>;
    expect(nodeRepl).toMatchObject({
      command: test.runtime.nodeReplPath,
      args: [],
      startup_timeout_sec: 120,
      enabled_tools: ["js"],
    });
    const env = nodeRepl.env as Record<string, string>;
    expect(env).toEqual({
      CODEX_HOME: expect.stringContaining("pi-codex-toolkit-computer-use-"),
      CODEX_CLI_PATH: test.runtime.codexPath,
      NODE_REPL_NODE_PATH: test.runtime.nodePath,
      NODE_REPL_NODE_MODULE_DIRS: test.runtime.nodeModulesPath,
      NODE_REPL_TRUSTED_CODE_PATHS: expect.stringMatching(
        new RegExp(`${delimiter}${test.runtime.nodeModulesPath}$`),
      ),
      NODE_REPL_TRUSTED_SERVICES: '{"sky":"@oai/sky/service"}',
      NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
      NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE:
        "Control desktop apps on macOS through Computer Use.",
      SKY_CUA_SERVICE_PATH: test.runtime.helperPath,
    });
    expect(env.CODEX_HOME).not.toBe("PROTECTED_REAL_CODEX_HOME");
    expect(
      allLogs.find((entry) => entry.type === "environment")?.CODEX_HOME,
    ).toBe(env.CODEX_HOME);
    expect(
      allLogs
        .find((entry) => entry.type === "environment")
        ?.cwd?.endsWith(env.CODEX_HOME),
    ).toBe(true);
    expect(thread?.params?.cwd).toBe(env.CODEX_HOME);

    const calls = messages.filter(
      (message) => message.method === "mcpServer/tool/call",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      threadId: "thread-test",
      server: "node_repl",
      tool: "js",
      arguments: {
        code: expect.stringContaining(".list_apps()"),
        title: "List desktop apps",
        timeout_ms: 120_000,
      },
    });
    expect(methods).not.toContain("turn/start");
    expect(result).toEqual({
      content: [{ type: "text", text: '[{"name":"PROTECTED_APP"}]' }],
      details: {
        method: "list_apps",
        blockCount: 1,
        blockTypes: ["text"],
      },
    });
    expect(await readdir(test.homes)).toEqual([]);
  });

  it("correlates interleaved responses by request ID", async () => {
    const test = await harness("reorder");
    const first = test.client.invoke("get_app_state", { app: "first-app" });
    const second = test.client.invoke("get_app_state", { app: "second-app" });

    await expect(first).resolves.toMatchObject({
      content: [{ type: "text", text: "first-result" }],
    });
    await expect(second).resolves.toMatchObject({
      content: [{ type: "text", text: "second-result" }],
    });
    expect(
      (await inputs(test.logPath)).filter(
        (message) => message.method === "mcpServer/tool/call",
      ),
    ).toHaveLength(2);
  });

  it("handles only the active Computer Use elicitation and supports string IDs", async () => {
    const accepted = await harness("elicitation");
    const approval = async (message: string): Promise<boolean> => {
      expect(message).toBe("PROTECTED_APPROVAL_MESSAGE");
      return true;
    };
    await accepted.client.invoke("click", { app: "Test" }, undefined, approval);
    const acceptedResponse = (await inputs(accepted.logPath)).find(
      (message) => message.id === "approval-request" && !message.method,
    );
    expect(acceptedResponse?.result).toEqual({
      action: "accept",
      content: {},
      _meta: { persist: "session" },
    });

    const declined = await harness("foreign-elicitation");
    const autoAccept = vi.fn(async () => true);
    await declined.client.invoke(
      "click",
      { app: "Test" },
      undefined,
      autoAccept,
    );
    const declinedResponse = (await inputs(declined.logPath)).find(
      (message) => message.id === "approval-request" && !message.method,
    );
    expect(declinedResponse?.result).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
    expect(autoAccept).not.toHaveBeenCalled();
  });

  it.each([
    "wrong-thread-elicitation",
    "url-elicitation",
    "other-connector-elicitation",
    "malformed-elicitation",
    "missing-app-elicitation",
    "empty-app-elicitation",
  ])("declines an out-of-scope %s", async (scenario) => {
    const test = await harness(scenario);
    const autoAccept = vi.fn(async () => true);

    await test.client.invoke(
      "get_app_state",
      { app: "App A" },
      undefined,
      autoAccept,
    );

    const response = (await inputs(test.logPath)).find(
      (message) => message.id === "approval-request" && !message.method,
    );
    expect(response?.result).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
    expect(autoAccept).not.toHaveBeenCalled();
  });

  it("remembers a confirmed app for the client session and asks for another app", async () => {
    const test = await harness("session-approval");
    const approval = vi.fn(async () => true);

    await test.client.invoke(
      "get_app_state",
      { app: "App A" },
      undefined,
      approval,
    );
    await test.client.invoke(
      "get_app_state",
      { app: "App A" },
      undefined,
      approval,
    );
    await test.client.invoke(
      "get_app_state",
      { app: "App B" },
      undefined,
      approval,
    );

    expect(approval).toHaveBeenCalledTimes(2);
    const responses = (await inputs(test.logPath)).filter(
      (message) =>
        typeof message.id === "string" &&
        message.id.startsWith("approval-request-") &&
        !message.method,
    );
    expect(responses.map((message) => message.result)).toEqual([
      {
        action: "accept",
        content: {},
        _meta: { persist: "session" },
      },
      {
        action: "accept",
        content: {
          source: "computer-use-persisted-state",
          scope: "conversation",
        },
        _meta: null,
      },
      {
        action: "accept",
        content: {},
        _meta: { persist: "session" },
      },
    ]);
  });

  it("does not cache a decline and asks for the same app again", async () => {
    const test = await harness("session-approval");
    const decisions = [false, true];
    const approval = vi.fn(async () => decisions.shift() ?? true);

    await expect(
      test.client.invoke(
        "get_app_state",
        { app: "App A" },
        undefined,
        approval,
      ),
    ).rejects.toMatchObject({ category: "mcp-error" });
    await expect(
      test.client.invoke(
        "get_app_state",
        { app: "App A" },
        undefined,
        approval,
      ),
    ).resolves.toBeDefined();
    await expect(
      test.client.invoke(
        "get_app_state",
        { app: "App A" },
        undefined,
        approval,
      ),
    ).resolves.toBeDefined();

    expect(approval).toHaveBeenCalledTimes(2);
    const responses = (await inputs(test.logPath)).filter(
      (message) =>
        typeof message.id === "string" &&
        message.id.startsWith("approval-request-") &&
        !message.method,
    );
    expect(responses.map((message) => message.result)).toEqual([
      { action: "decline", content: null, _meta: null },
      {
        action: "accept",
        content: {},
        _meta: { persist: "session" },
      },
      {
        action: "accept",
        content: {
          source: "computer-use-persisted-state",
          scope: "conversation",
        },
        _meta: null,
      },
    ]);
  });

  it("does not share confirmed apps across clients", async () => {
    const first = await harness("session-approval");
    const second = await harness("session-approval");
    const firstApproval = vi.fn(async () => true);
    const secondApproval = vi.fn(async () => true);

    await first.client.invoke(
      "get_app_state",
      { app: "App A" },
      undefined,
      firstApproval,
    );
    await second.client.invoke(
      "get_app_state",
      { app: "App A" },
      undefined,
      secondApproval,
    );

    expect(firstApproval).toHaveBeenCalledOnce();
    expect(secondApproval).toHaveBeenCalledOnce();
    for (const test of [first, second]) {
      const response = (await inputs(test.logPath)).find(
        (message) =>
          typeof message.id === "string" &&
          message.id.startsWith("approval-request-") &&
          !message.method,
      );
      expect(response?.result).toEqual({
        action: "accept",
        content: {},
        _meta: { persist: "session" },
      });
    }
  });

  it("preserves canonical app identifier case when keying approvals", async () => {
    const test = await harness("session-approval");
    const approval = vi.fn(async () => true);

    await test.client.invoke(
      "get_app_state",
      { app: "App A" },
      undefined,
      approval,
    );
    await test.client.invoke(
      "get_app_state",
      { app: "App A Case Variant" },
      undefined,
      approval,
    );

    expect(approval).toHaveBeenCalledTimes(2);
  });

  it("keeps bidirectional request IDs separate during elicitation", async () => {
    const test = await harness("elicitation-id-collision");

    await expect(
      test.client.invoke("click", { app: "Test" }, undefined, async () => true),
    ).resolves.toMatchObject({ details: { method: "click" } });
    const messages = await inputs(test.logPath);
    const call = messages.find(
      (message) => message.method === "mcpServer/tool/call",
    );
    expect(
      messages.find(
        (message) => message.id === call?.id && message.method === undefined,
      )?.result,
    ).toMatchObject({ action: "accept" });
  });

  it("returns fixed errors without exposing RPC, MCP, or stderr payloads", async () => {
    for (const [scenario, category, protectedValue] of [
      ["mcp-error", "mcp-error", "PROTECTED_RAW_MCP_ERROR"],
      ["app-server-error", "app-server-error", "PROTECTED_RAW_RPC_ERROR"],
      ["exit", "process-exit", "PROTECTED_STDERR"],
    ] as const) {
      const test = await harness(scenario);
      let caught: unknown;
      try {
        await test.client.invoke("click", { app: "PROTECTED_APP_ARGUMENT" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ComputerUseClientError);
      expect(caught).toMatchObject({ category });
      if (scenario === "mcp-error") {
        expect(caught).toMatchObject({
          message:
            "Computer Use failed. If the target app was not resolved, use computer_use_list_apps and a returned app identifier; PIDs and bare executable paths are unsupported.",
        });
      }
      expect(String(caught)).not.toContain(protectedValue);
      expect(String(caught)).not.toContain("PROTECTED_APP_ARGUMENT");
      await test.client.close();
      expect(await readdir(test.homes)).toEqual([]);
    }
  });

  it("waits for app-server exit before removing its temporary home", async () => {
    const test = await harness("delayed-exit");
    await test.client.invoke("list_apps", {});

    await test.client.close();
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(await readdir(test.homes)).toEqual([]);
  });

  it("treats malformed action output as an unknown desktop outcome", async () => {
    const test = await harness("invalid-content");

    await expect(
      test.client.invoke("click", { app: "Test" }),
    ).rejects.toMatchObject({
      category: "invalid-response",
      unknownDesktopOutcome: true,
    });
    await expect(
      test.client.invoke("click", { app: "Test" }),
    ).rejects.toMatchObject({ category: "inspection-required" });
  });

  it("honors pre-dispatch abort without spawning or writing", async () => {
    const test = await harness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      test.client.invoke("click", { app: "Test" }, controller.signal),
    ).rejects.toMatchObject({
      category: "aborted",
      unknownDesktopOutcome: false,
    });
    await expect(access(test.logPath)).rejects.toThrow();
    expect(await readdir(test.homes)).toEqual([]);
  });

  it("does not mark an action unknown when startup fails before dispatch", async () => {
    const test = await harness("startup-exit");

    await expect(
      test.client.invoke("click", { app: "Test" }),
    ).rejects.toMatchObject({
      category: "process-exit",
      unknownDesktopOutcome: false,
    });
    await expect(
      test.client.invoke("scroll", { app: "Test", direction: "down" }),
    ).rejects.toMatchObject({
      category: "process-exit",
      unknownDesktopOutcome: false,
    });
    expect(
      (await inputs(test.logPath)).filter(
        (message) => message.method === "mcpServer/tool/call",
      ),
    ).toHaveLength(0);
  });

  it("aborts one dispatched call without replaying it", async () => {
    const test = await harness("hang");
    const controller = new AbortController();
    const pending = test.client.invoke(
      "click",
      { app: "Test" },
      controller.signal,
    );
    await waitForToolCall(test.logPath);
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      category: "aborted",
      unknownDesktopOutcome: true,
    });
    expect(
      (await inputs(test.logPath)).filter(
        (message) => message.method === "mcpServer/tool/call",
      ),
    ).toHaveLength(1);
  });

  it("bounds a dispatched timeout and marks the action outcome unknown", async () => {
    const test = await harness("hang");
    // Bound only the dispatched call, not the fake child's start.
    await seam(test.client).ensureStarted();
    seam(test.client).requestTimeoutMs = 500;
    const pending = test.client.invoke("click", { app: "Test" });
    await waitForToolCall(test.logPath);

    await expect(pending).rejects.toMatchObject({
      category: "timeout",
      unknownDesktopOutcome: true,
    });
    await expect(
      test.client.invoke("scroll", { app: "Test", direction: "down" }),
    ).rejects.toMatchObject({ category: "inspection-required" });
    expect(
      (await inputs(test.logPath)).filter(
        (message) => message.method === "mcpServer/tool/call",
      ),
    ).toHaveLength(1);
  });

  it("requires one explicit successful state read after an ambiguous action", async () => {
    const test = await harness("ambiguous-once");

    await expect(
      test.client.invoke("click", { app: "Test" }),
    ).rejects.toMatchObject({
      category: "process-exit",
      unknownDesktopOutcome: true,
    });
    await expect(
      test.client.invoke("click", { app: "Test" }),
    ).rejects.toMatchObject({ category: "inspection-required" });
    await expect(test.client.invoke("list_apps", {})).resolves.toBeDefined();
    await expect(
      test.client.invoke("scroll", { app: "Test", direction: "down" }),
    ).rejects.toMatchObject({ category: "inspection-required" });
    await expect(
      test.client.invoke("get_app_state", { app: "Test" }),
    ).resolves.toMatchObject({
      details: { method: "get_app_state", blockTypes: ["text", "image"] },
    });
    await expect(
      test.client.invoke("click", { app: "Test" }),
    ).resolves.toMatchObject({ details: { method: "click" } });

    const calls = (await inputs(test.logPath)).filter(
      (message) => message.method === "mcpServer/tool/call",
    );
    expect(calls).toHaveLength(4);
    const sources = calls.map(
      (message) =>
        (message.params?.arguments as Record<string, string> | undefined)?.code,
    );
    expect(
      sources.filter((source) => source?.includes(".click(")),
    ).toHaveLength(2);
    expect(
      sources.filter((source) => source?.includes(".get_app_state(")),
    ).toHaveLength(1);
  });

  it("keeps the action gate when an explicit state result is invalid", async () => {
    const test = await harness("ambiguous-invalid-state");

    await expect(
      test.client.invoke("click", { app: "Test" }),
    ).rejects.toMatchObject({ unknownDesktopOutcome: true });
    await expect(
      test.client.invoke("get_app_state", { app: "Test" }),
    ).rejects.toMatchObject({ category: "invalid-response" });
    await expect(
      test.client.invoke("click", { app: "Test" }),
    ).rejects.toMatchObject({ category: "inspection-required" });
  });

  it("runs only the import target probe and rejects incompatible Sky", async () => {
    const ready = await harness();
    await expect(ready.client.probeTarget()).resolves.toBeUndefined();
    const readyCalls = (await inputs(ready.logPath)).filter(
      (message) => message.method === "mcpServer/tool/call",
    );
    expect(readyCalls).toHaveLength(1);
    expect(
      (readyCalls[0]?.params?.arguments as Record<string, string>).code,
    ).toContain(".target");
    expect(
      (readyCalls[0]?.params?.arguments as Record<string, string>).code,
    ).not.toMatch(/list_apps|get_app_state|\.click\(|\.type_text\(/);

    const incompatible = await harness("target-mismatch");
    await expect(incompatible.client.probeTarget()).rejects.toMatchObject({
      category: "incompatible-sky-target",
    });
  });

  it("reports a failed home allocation at startup as node_repl unavailable", async () => {
    const test = await harness();
    // harness() has made its own directories; the next one is the client home.
    vi.mocked(mkdtemp).mockRejectedValueOnce(
      Object.assign(new Error("PROTECTED_HOME_ALLOCATION_ERROR"), {
        code: "EACCES",
      }),
    );
    try {
      await expect(test.client.probeTarget()).rejects.toStrictEqual(
        new ComputerUseClientError("node-repl-unavailable"),
      );
      // No app-server was spawned, so none created its log.
      expect(await readdir(test.directory)).toEqual(["homes"]);
    } finally {
      // Also drops the rejection if startup never reached the allocation.
      vi.mocked(mkdtemp).mockReset();
    }
  });

  it.each(["failed", "cancelled", "disabled"])(
    "reports node_repl unavailable as soon as readiness reports it %s",
    async (status) => {
      const test = await harness(`readiness-status-${status}`);
      await expect(test.client.probeTarget()).rejects.toStrictEqual(
        new ComputerUseClientError("node-repl-unavailable"),
      );
      expect(
        (await inputs(test.logPath)).map((message) => message.method),
      ).toEqual([
        "initialize",
        "initialized",
        "thread/start",
        "mcpServerStatus/list",
      ]);
      expect(await readdir(test.homes)).toEqual([]);
    },
  );

  // The clock is moved on purpose. Each poll may wait only for what remains
  // of the readiness deadline, so a real short deadline can run out while a
  // poll is in flight, and under CPU load that poll fails as a timeout. Moving
  // the clock after the second answer ends readiness between polls; a real
  // deadline must not come back here. The exact error pins the category
  // readiness reports when it runs out; the two-poll method list pins that
  // readiness stops at its deadline instead of polling again.
  it("reports node_repl unavailable when it is not ready by the readiness deadline", async () => {
    const test = await harness("readiness-never");
    const internal = seam(test.client);
    const request = internal.request.bind(internal);
    const now = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
    let polls = 0;
    vi.spyOn(internal, "request").mockImplementation(async (...args) => {
      const result = await request(...args);
      if (args[0] === "mcpServerStatus/list" && ++polls === 2) {
        offset = HARNESS_STARTUP_TIMEOUT_MS;
      }
      return result;
    });
    await expect(test.client.probeTarget()).rejects.toStrictEqual(
      new ComputerUseClientError("node-repl-unavailable"),
    );
    expect(
      (await inputs(test.logPath)).map((message) => message.method),
    ).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "mcpServerStatus/list",
      "mcpServerStatus/list",
    ]);
    expect(await readdir(test.homes)).toEqual([]);
  });

  // GR-L13: a startup that never becomes ready reports node-repl-unavailable
  // wherever it stalls; timeout belongs to dispatched calls. The deadline
  // expiring between polls is the test above; a dispatched call keeps its
  // timeout and unknown-outcome flag in "bounds a dispatched timeout and
  // marks the action outcome unknown".
  it("reports node_repl unavailable when the readiness deadline expires during a poll", async () => {
    const test = await harness("readiness-hang-second");
    const internal = seam(test.client);
    const request = internal.request.bind(internal);
    const now = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
    let polls = 0;
    vi.spyOn(internal, "request").mockImplementation(async (...args) => {
      const result = await request(...args);
      // Move the clock once the first poll is answered: the second poll is
      // recorded and never answered, so only the deadline's remaining slice,
      // armed as that request's budget, can end readiness inside the poll.
      if (args[0] === "mcpServerStatus/list" && ++polls === 1) {
        offset = HARNESS_STARTUP_TIMEOUT_MS - 150;
      }
      return result;
    });
    await expect(test.client.probeTarget()).rejects.toStrictEqual(
      new ComputerUseClientError("node-repl-unavailable"),
    );
    expect(
      (await inputs(test.logPath)).map((message) => message.method),
    ).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "mcpServerStatus/list",
      "mcpServerStatus/list",
    ]);
    expect(await readdir(test.homes)).toEqual([]);
  });

  it.each([
    {
      stall: "a readiness poll",
      scenario: "readiness-hang-second",
      methods: [
        "initialize",
        "initialized",
        "thread/start",
        "mcpServerStatus/list",
        "mcpServerStatus/list",
      ],
    },
    {
      stall: "the initialize handshake",
      scenario: "initialize-hang",
      methods: ["initialize"],
    },
    {
      stall: "the thread/start handshake",
      scenario: "thread-start-hang",
      methods: ["initialize", "initialized", "thread/start"],
    },
  ])(
    "reports node_repl unavailable when the request budget ends $stall",
    async ({ scenario, methods }) => {
      const test = await harness(scenario);
      await expect(
        startupTimeoutAfterReceipt(test, methods),
      ).resolves.toStrictEqual(
        new ComputerUseClientError("node-repl-unavailable"),
      );
      expect(
        (await inputs(test.logPath)).map((message) => message.method),
      ).toEqual(methods);
      expect(await readdir(test.homes)).toEqual([]);
    },
  );

  it("keeps a failed reset after a startup timeout as process-exit", async () => {
    const test = await harness("initialize-hang");
    const internal = seam(test.client);
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    // The timeout's failTransport reset must fail: the startup catch joins it
    // and rethrows its process-exit cleanup error, which is never remapped.
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path).includes("pi-codex-toolkit-computer-use-")) {
        throw new Error("PROTECTED_HOME_REMOVAL_ERROR");
      }
      return actual.rm(path, options);
    });
    let outcome: unknown;
    try {
      outcome = await startupTimeoutAfterReceipt(test, ["initialize"]);
    } finally {
      vi.mocked(rm).mockImplementation(actual.rm);
    }
    expect(outcome).toStrictEqual(new ComputerUseClientError("process-exit"));
    expect(String(outcome)).not.toContain("PROTECTED");
    expect(internal.cleanupError).toStrictEqual(
      new ComputerUseClientError("process-exit"),
    );
    expect(
      (await inputs(test.logPath)).map((message) => message.method),
    ).toEqual(["initialize"]);
    // The retained home is reclaimed by the explicit close retry.
    const homes = await readdir(test.homes);
    expect(homes).toHaveLength(1);
    expect(internal.retiredHome).toBe(join(test.homes, homes[0]));
    await test.client.close();
    expect(await readdir(test.homes)).toEqual([]);
    expect(internal.retiredHome).toBeUndefined();
    expect(internal.cleanupError).toBeUndefined();
  });
});
