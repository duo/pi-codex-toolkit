import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionHandler,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseClient as Client } from "../src/computer-use/app-server-client.ts";
import { INNER_BUDGET_MS } from "./fixtures/budgets.ts";

const state = vi.hoisted(() => ({
  clients: [] as Client[],
  homes: "",
  log: "",
  scenario: "delayed-exit",
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
vi.mock("../src/computer-use/app-server-client.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/computer-use/app-server-client.ts")
    >();
  // Only discovery and launch inputs are substituted. Startup, RPC, probe,
  // transport failure and close (including real child/home cleanup) are real.
  class ComputerUseClient extends actual.ComputerUseClient {
    constructor(
      options: ConstructorParameters<typeof actual.ComputerUseClient>[0],
    ) {
      super({
        ...options,
        appServerArgs: [
          fileURLToPath(
            new URL("./fixtures/fake-app-server.ts", import.meta.url),
          ),
        ],
        temporaryRoot: state.homes,
        environment: {
          ...process.env,
          FAKE_APP_SERVER_LOG: state.log,
          // Launch input remains controllable when the same client respawns.
          get FAKE_APP_SERVER_SCENARIO() {
            return state.scenario;
          },
        },
        pollIntervalMs: 5,
      });
      state.clients.push(this);
    }
  }
  return {
    ...actual,
    ComputerUseClient,
    inspectComputerUseRuntime: () => ({
      ok: true,
      runtime: {
        codexPath: process.execPath,
        nodeReplPath: "/fake/node_repl",
        nodePath: process.execPath,
        nodeModulesPath: "/fake/modules",
        helperPath: "/fake/helper.app",
      },
    }),
  };
});

import piCodexToolkit from "../src/index.ts";
import { ComputerUseClient } from "../src/computer-use/app-server-client.ts";
import { defaultConfig } from "../src/config.ts";
import { ShellSessionManager } from "../src/shell/manager.ts";
import { CodeModeCellManager } from "../src/code-mode/manager.ts";
import { model } from "./fixtures.ts";
import { withEventBus } from "./fixtures/extension-events.ts";

// Read-only test seam captures the exact owned resources; no replacement close.
function resources(client: Client) {
  return client as unknown as {
    child: ChildProcessWithoutNullStreams;
    temporaryHome: string;
    resetting?: Promise<void>;
  };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: string | undefined;
let oldAgentDir: string | undefined;
let shutdown: (() => Promise<unknown>) | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rm).mockImplementation(actual.rm);
  try {
    // Rescue is owned before assertions, restores injected faults, and awaits
    // every producer before deleting only this fixture's root.
    const results = await Promise.allSettled([
      ...state.clients.map((client) => client.close()),
      shutdown?.(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "owned factory fixture cleanup failed");
    if (root) await actual.rm(root, { recursive: true, force: true });
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    state.clients.length = 0;
    root = undefined;
    shutdown = undefined;
  }
});

async function harness(scenario = "delayed-exit") {
  state.scenario = scenario;
  oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  root = await mkdtemp(join(tmpdir(), "pct-cua-factory-"));
  state.homes = join(root, "homes");
  state.log = join(root, "server.jsonl");
  await mkdir(state.homes);
  process.env.PI_CODING_AGENT_DIR = root;
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  const config = defaultConfig();
  config.computerUse.enabled = true;
  config.codeMode.enabled = true;
  const configPath = join(root, "extensions", "pi-codex-toolkit.json");
  await mkdir(join(root, "extensions"));
  const save = () => writeFile(configPath, JSON.stringify(config));
  await save();
  const handlers = new Map<string, ExtensionHandler<never, unknown>>();
  const tools = new Map<string, ToolDefinition>();
  let command!: RegisteredCommand["handler"];
  let active: string[] = ["read"];
  const sourcePath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (_name: string, options: RegisteredCommand) => {
      command = options.handler;
    },
    on: (name: string, handler: ExtensionHandler<never, unknown>) =>
      handlers.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    getAllTools: () =>
      [...tools.values()].map((tool) => ({
        ...tool,
        sourceInfo: {
          path: sourcePath,
          source: "test",
          scope: "user",
          origin: "package",
        },
      })),
  } as unknown as ExtensionAPI;
  const currentModel = model({ input: ["text", "image"] });
  const ctx = {
    cwd: root,
    hasUI: true,
    model: currentModel,
    modelRegistry: {
      getAvailable: () => [currentModel],
      isUsingOAuth: () => false,
    },
    scopedModels: [],
    ui: { notify: vi.fn(), confirm: vi.fn(async () => true) },
  } as unknown as ExtensionCommandContext & ExtensionContext;
  const event = async (type: string, reason = "new") =>
    handlers.get(type)!({ type, reason } as never, ctx);
  piCodexToolkit(withEventBus(pi));
  shutdown = () => event("session_shutdown", "quit");
  await event("session_start", "startup");
  const tool = (
    name = "computer_use_list_apps",
    args = {},
    signal?: AbortSignal,
  ) => tools.get(name)!.execute("call", args, signal, undefined, ctx);
  return {
    config,
    pi,
    save,
    ctx,
    event,
    tool,
    command: (args: string) => command(args, ctx),
  };
}

async function failRemoval(home?: string) {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let enabled = true;
  const attempts: string[] = [];
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (
      typeof path === "string" &&
      (home ? path === home : path.startsWith(`${state.homes}/`))
    ) {
      attempts.push(path);
      if (enabled) throw new Error("PROTECTED_REMOVAL");
    }
    return actual.rm(path, options);
  });
  return {
    attempts,
    restore: () => {
      enabled = false;
    },
  };
}

describe("real Computer Use factory cleanup ownership", () => {
  it.each(["shutdown", "disable", "mode-change", "caller-abort"])(
    "cancels the actual client's forwarded confirmation on %s without waiting for the UI",
    async (boundary) => {
      const h = await harness("session-approval");
      const entered = barrier();
      let reject!: (error: Error) => void;
      const decision = new Promise<boolean>((_resolve, fail) => {
        reject = fail;
      });
      let options: { signal?: AbortSignal; timeout?: number } | undefined;
      vi.mocked(h.ctx.ui.confirm).mockImplementation(
        (_title, _message, forwarded) => {
          options = forwarded;
          entered.resolve();
          return decision; // Deliberately ignores cancellation.
        },
      );
      const caller = new AbortController();
      const result = h
        .tool("computer_use_click", { app: "App A", x: 0, y: 0 }, caller.signal)
        .catch((error) => error);
      try {
        await entered.promise;
        const client = state.clients[0]!;
        const { child, temporaryHome: home } = resources(client);
        expect(options).toEqual({ signal: expect.any(AbortSignal) });
        expect(options?.signal).not.toBe(caller.signal);
        expect(options?.signal?.aborted).toBe(false);
        if (boundary === "caller-abort") caller.abort();
        else if (boundary === "shutdown")
          await h.event("session_shutdown", "quit");
        else {
          if (boundary === "disable") h.config.computerUse.enabled = false;
          else h.config.computerUse.approvalMode = "always";
          await h.save();
          await h.command("reload");
        }
        expect(options?.signal?.aborted).toBe(true);
        expect(await result).toMatchObject({
          category: boundary === "caller-abort" ? "aborted" : "closed",
          unknownDesktopOutcome: true,
        });
        await resources(client).resetting;
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(state.homes)).toEqual([]);
        reject(new Error("PROTECTED_LATE_CONFIRMATION_REJECTION"));
        await Promise.resolve();
        await Promise.resolve();
        const rows = (await readFile(state.log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          rows.filter((row) => row.type === "input" && !row.message.method),
        ).toEqual([]);
      } finally {
        caller.abort();
        reject(new Error("PROTECTED_LATE_CONFIRMATION_REJECTION"));
        await result;
      }
    },
  );

  it.each(["kill", "removal"])(
    "retains an isClosed runtime after %s failure and fences replacement until explicit retry",
    async (failure) => {
      const h = await harness();
      await h.tool();
      const client = state.clients[0]!;
      const { child, temporaryHome: home } = resources(client);
      const removal =
        failure === "removal" ? await failRemoval(home) : undefined;
      const kill =
        failure === "kill"
          ? vi.spyOn(child, "kill").mockImplementation(() => {
              throw new Error("PROTECTED_KILL");
            })
          : undefined;
      h.config.computerUse.approvalMode = "always";
      await h.save();
      await expect(h.command("reload")).rejects.toMatchObject({
        category: "process-exit",
      });
      expect(client.isClosed).toBe(true);
      await expect(access(home)).resolves.toBeUndefined();
      await expect(h.tool()).rejects.toMatchObject({
        category: "process-exit",
      });
      await expect(h.command("status")).rejects.toMatchObject({
        category: "process-exit",
      });
      expect(state.clients).toHaveLength(1);
      kill?.mockRestore();
      removal?.restore();
      await h.command("reload");
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
      await h.tool();
      expect(state.clients).toHaveLength(2);
      // Retired listener traffic cannot dispose or clear the fresh factory slot.
      child.stdin.emit("error", new Error("PROTECTED_STALE"));
      child.stdout.emit("data", "invalid-json\n");
      await h.tool();
      expect(state.clients).toHaveLength(2);
    },
  );

  it("reclaims a failed ordinary reset at tool acquisition without overwriting its owner", async () => {
    const h = await harness();
    await h.tool();
    const client = state.clients[0]!;
    const { child, temporaryHome: home } = resources(client);
    const removal = await failRemoval(home);
    child.stdout.emit("data", "invalid-json\n");
    await expect(resources(client).resetting).rejects.toMatchObject({
      category: "process-exit",
    });
    expect(client.isClosed).toBe(false);
    expect(client.hasCleanupError).toBe(true);
    await expect(h.tool()).rejects.toMatchObject({ category: "process-exit" });
    expect(state.clients).toHaveLength(1);
    removal.restore();
    await h.tool();
    expect(state.clients).toEqual([client]);
    expect(client.isClosed).toBe(false);
    expect(client.hasCleanupError).toBe(false);
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["tool", "status", "reload"])(
    "preserves unknown-action inspection across same-session failed reset cleanup via %s",
    async (retry) => {
      const h = await harness("hang");
      // The peer logs the submitted action but deliberately sends no result.
      // Observe rejection immediately while waiting for that real wire barrier.
      const action = h
        .tool("computer_use_click", { app: "Test" })
        .catch((error) => error);
      await vi.waitFor(
        async () => {
          expect(await readFile(state.log, "utf8")).toContain(".click(");
        },
        { timeout: INNER_BUDGET_MS },
      );
      const client = state.clients[0]!;
      const { child, temporaryHome: home } = resources(client);
      const removal = await failRemoval(home);
      child.stdout.emit("data", "invalid-json\n");
      await expect(resources(client).resetting).rejects.toMatchObject({
        category: "process-exit",
      });
      expect(await action).toMatchObject({
        category: "invalid-response",
        unknownDesktopOutcome: true,
      });
      expect(client.isClosed).toBe(false);
      expect(client.hasCleanupError).toBe(true);
      await expect(access(home)).resolves.toBeUndefined();
      // Establish the actual old-client gate, without mutating private state.
      await expect(
        client.invoke("click", { app: "Test" }),
      ).rejects.toMatchObject({
        category: "inspection-required",
      });

      await expect(
        retry === "tool" ? h.tool() : h.command(retry),
      ).rejects.toMatchObject({ category: "process-exit" });
      expect(state.clients).toEqual([client]);
      expect(client.isClosed).toBe(false);
      await expect(access(home)).resolves.toBeUndefined();

      removal.restore();
      state.scenario = "normal";
      // No mode/config/session change or explicit client disposal: an explicit
      // caller through the same factory retries only failed transport cleanup.
      if (retry !== "tool") await h.command(retry);
      const next = await h
        .tool("computer_use_click", { app: "Test" })
        .catch((error) => error);
      expect.soft(next).toMatchObject({ category: "inspection-required" });
      expect(state.clients[0]).toBe(client);
      expect(state.clients).toHaveLength(retry === "status" ? 2 : 1);
      expect(client.isClosed).toBe(false);
      expect(client.hasCleanupError).toBe(false);
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
      const clickCount = async () =>
        (await readFile(state.log, "utf8")).split(".click(").length - 1;
      expect.soft(await clickCount()).toBe(1);

      await h.tool("computer_use_list_apps");
      for (const [name, args] of [
        ["computer_use_click", { app: "Test" }],
        ["computer_use_type_text", { app: "Test", text: "test" }],
        ["computer_use_press_key", { app: "Test", key: "Return" }],
        ["computer_use_scroll", { app: "Test", direction: "down" }],
      ] as const) {
        await expect(h.tool(name, args)).rejects.toMatchObject({
          category: "inspection-required",
        });
      }
      expect(await readFile(state.log, "utf8")).not.toMatch(
        /\.(?:type_text|press_key|scroll)\(/,
      );
      expect.soft(await clickCount()).toBe(1);
      expect(await readFile(state.log, "utf8")).not.toContain(
        ".get_app_state(",
      );

      await expect(
        h.tool("computer_use_get_app_state", { app: "Test" }),
      ).resolves.toMatchObject({ details: { method: "get_app_state" } });
      await expect(
        h.tool("computer_use_click", { app: "Test" }),
      ).resolves.toMatchObject({ details: { method: "click" } });
      expect.soft(await clickCount()).toBe(2);
    },
  );

  it.each(["tool", "status", "reload", "preflight"])(
    "keeps failed dedicated probe home reachable for %s retry",
    async (retry) => {
      const h = await harness();
      const removal = await failRemoval();
      await expect(h.command("status")).rejects.toMatchObject({
        category: "process-exit",
      });
      const home = removal.attempts[0]!;
      expect(state.clients).toHaveLength(1);
      const log = await readFile(state.log, "utf8");
      expect(log).toContain("Probe Computer Use runtime");
      expect(log).not.toContain(".list_apps(");
      await expect(access(home)).resolves.toBeUndefined();
      await expect(h.tool()).rejects.toMatchObject({
        category: "process-exit",
      });
      await expect(h.command("status")).rejects.toMatchObject({
        category: "process-exit",
      });
      expect(state.clients).toHaveLength(1);
      removal.restore();
      if (retry === "tool") await h.tool();
      else if (retry === "preflight")
        expect(await h.event("session_before_switch")).toBeUndefined();
      else await h.command(retry);
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
      expect(state.clients).toHaveLength(
        retry === "tool" || retry === "status" ? 2 : 1,
      );
      if (retry !== "tool") expect(await readdir(state.homes)).toEqual([]);
    },
  );

  it.each(["session_before_switch", "session_before_fork"])(
    "%s veto survives notify failure and attempts other managers before real retry",
    async (preflight) => {
      const h = await harness();
      await h.tool();
      await h.tool("exec", { code: "return 1;", uses: [] });
      const shellClose = vi.spyOn(ShellSessionManager.prototype, "close");
      const codeClose = vi.spyOn(CodeModeCellManager.prototype, "close");
      const { temporaryHome: home } = resources(state.clients[0]!);
      const removal = await failRemoval(home);
      vi.mocked(h.ctx.ui.notify).mockImplementation(() => {
        throw new Error("unavailable UI");
      });
      expect(await h.event(preflight)).toEqual({ cancel: true });
      expect(shellClose).toHaveBeenCalledOnce();
      expect(codeClose).toHaveBeenCalledOnce();
      await expect(access(home)).resolves.toBeUndefined();
      removal.restore();
      expect(await h.event(preflight)).toBeUndefined();
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
      // Another extension may cancel after successful preflight; this owner can
      // serve fresh work without requiring a shutdown that never happened.
      await h.tool();
      expect(state.clients).toHaveLength(2);
    },
  );

  it.each(["session_before_switch", "session_before_fork"])(
    "%s discards granted app access even when another participant cancels replacement",
    async (preflight) => {
      const h = await harness("session-approval");
      await h.tool("computer_use_get_app_state", { app: "App A" });
      await h.tool("computer_use_get_app_state", { app: "App A" });
      const client = state.clients[0]!;
      const { child, temporaryHome: home } = resources(client);
      expect(h.ctx.ui.confirm).toHaveBeenCalledOnce();
      expect(state.clients).toEqual([client]);

      expect(await h.event(preflight)).toBeUndefined();
      expect(client.isClosed).toBe(true);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(state.homes)).toEqual([]);
      // Model a later participant's cancellation: no shutdown/start follows,
      // and the same factory serves work. Successful disposal is not rollback.
      await h.tool("computer_use_get_app_state", { app: "App A" });
      const replacement = state.clients[1]!;
      expect(state.clients).toHaveLength(2);
      expect(replacement).not.toBe(client);
      expect(replacement.isClosed).toBe(false);
      const replacementHome = resources(replacement).temporaryHome;
      expect(replacementHome).not.toBe(home);
      await expect(access(replacementHome)).resolves.toBeUndefined();
      expect(h.ctx.ui.confirm).toHaveBeenCalledTimes(2);
      const rows = (await readFile(state.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        rows
          .filter((row) => row.type === "environment")
          .map((row) => row.CODEX_HOME),
      ).toEqual([home, replacementHome]);
      expect(
        rows
          .filter((row) => row.type === "input" && !row.message.method)
          .map((row) => row.message.result),
      ).toEqual([
        { action: "accept", content: {}, _meta: { persist: "session" } },
        {
          action: "accept",
          content: {
            source: "computer-use-persisted-state",
            scope: "conversation",
          },
          _meta: null,
        },
        { action: "accept", content: {}, _meta: { persist: "session" } },
      ]);
      const calls = rows.filter(
        (row) =>
          row.type === "input" && row.message.method === "mcpServer/tool/call",
      );
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call.message.params.arguments.code).toContain(".get_app_state(");
        expect(call.message.params.arguments.code).toContain('"app":"App A"');
      }
      await h.event("session_shutdown", "quit");
      await expect(access(replacementHome)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(state.homes)).toEqual([]);
    },
  );

  it("keeps overlapping preflights fenced until the last whole cleanup aggregate settles", async () => {
    const h = await harness();
    await h.tool();
    const client = state.clients[0]!;
    const { child, temporaryHome: home } = resources(client);
    const entered = barrier();
    const release = barrier();
    const close = ShellSessionManager.prototype.close;
    let closes = 0;
    vi.spyOn(ShellSessionManager.prototype, "close").mockImplementation(
      async function (this: ShellSessionManager) {
        const first = ++closes === 1;
        await close.call(this);
        // Hold only the first caller's return after its real cleanup. Computer
        // cleanup can finish, but this caller's aggregate must retain its fence.
        if (first) {
          entered.resolve();
          await release.promise;
        }
      },
    );
    let firstSettled = false;
    const first = h.event("session_before_switch").finally(() => {
      firstSettled = true;
    });
    let second: Promise<unknown> | undefined;
    try {
      await entered.promise;
      await vi.waitFor(
        async () => {
          await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
        },
        { timeout: INNER_BUDGET_MS },
      );
      expect(client.isClosed).toBe(true);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      const wire = await readFile(state.log, "utf8");
      await expect(h.tool()).rejects.toMatchObject({ category: "closed" });
      await expect(h.command("status")).rejects.toMatchObject({
        category: "closed",
      });
      second = h.event("session_before_fork");
      expect(await second).toBeUndefined();
      expect(closes).toBe(2);
      expect(firstSettled).toBe(false);
      // The newer preflight has settled, so epoch mismatch alone cannot fence
      // new callers. A Boolean or Computer-only release would admit them here.
      await expect(h.tool()).rejects.toMatchObject({ category: "closed" });
      await expect(h.command("status")).rejects.toMatchObject({
        category: "closed",
      });
      expect(state.clients).toEqual([client]);
      expect(await readdir(state.homes)).toEqual([]);
      expect(await readFile(state.log, "utf8")).toBe(wire);
      release.resolve();
      expect(await first).toBeUndefined();
      await h.tool();
      expect(state.clients).toHaveLength(2);
      expect(state.clients[1]).not.toBe(client);
      expect(resources(state.clients[1]!).temporaryHome).not.toBe(home);
      expect(
        (await readFile(state.log, "utf8")).split(".list_apps("),
      ).toHaveLength(3);
      await h.event("session_shutdown", "quit");
      expect(await readdir(state.homes)).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it.each(["quit", "reload"])(
    "surfaces non-cancellable %s residue and never respawns from stale callers",
    async (reason) => {
      const h = await harness();
      await h.tool();
      const { temporaryHome: home } = resources(state.clients[0]!);
      const removal = await failRemoval(home);
      await expect(h.event("session_shutdown", reason)).rejects.toThrow(
        "cleanup references do not survive host replacement",
      );
      removal.restore();
      // A still-reachable explicit old call may reclaim ownership, not restart.
      await expect(h.tool()).rejects.toMatchObject({ category: "closed" });
      await expect(h.command("status")).rejects.toMatchObject({
        category: "closed",
      });
      await h.command("reload");
      expect(state.clients).toHaveLength(1);
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["tool", "status"])(
    "a %s begun while stopped cannot spawn across a reused-factory session start",
    async (caller) => {
      const h = await harness();
      await h.tool();
      const { temporaryHome: home } = resources(state.clients[0]!);
      const removal = await failRemoval(home);
      await expect(h.event("session_shutdown", "reload")).rejects.toThrow(
        "cleanup references do not survive host replacement",
      );
      removal.restore();
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      const entered = barrier();
      const release = barrier();
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (path === home) {
          entered.resolve();
          await release.promise;
        }
        return actual.rm(path, options);
      });
      const resumeCaller = barrier();
      const client = state.clients[0]!;
      const close = client.close.bind(client);
      let closes = 0;
      vi.spyOn(client, "close").mockImplementation(async () => {
        const staleCaller = ++closes === 2;
        await close();
        // Both callers run real cleanup. Only delay the old caller's return
        // after cleanup, making the rebind/continuation order deterministic.
        if (staleCaller) await resumeCaller.promise;
      });
      const restart = h.event("session_start", "resume");
      let stale: Promise<unknown> | undefined;
      try {
        await entered.promise;
        stale = (caller === "tool" ? h.tool() : h.command("status")).catch(
          (error) => error,
        );
        release.resolve();
        await restart;
        expect(closes).toBe(2);
        resumeCaller.resolve();
        expect(await stale).toMatchObject({ category: "closed" });
        expect(state.clients).toHaveLength(1);
        await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(state.homes)).toEqual([]);
        await h.tool();
        expect(state.clients).toHaveLength(2);
      } finally {
        release.resolve();
        resumeCaller.resolve();
        await Promise.allSettled([restart, stale]);
      }
    },
  );

  it("a shutdown overtaking restart cleanup cannot reopen the factory", async () => {
    const h = await harness();
    await h.tool();
    const { temporaryHome: home } = resources(state.clients[0]!);
    const removal = await failRemoval(home);
    await expect(h.event("session_shutdown", "reload")).rejects.toThrow(
      "cleanup references do not survive host replacement",
    );
    removal.restore();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const entered = barrier();
    const release = barrier();
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path === home) {
        entered.resolve();
        await release.promise;
      }
      return actual.rm(path, options);
    });
    const restart = h.event("session_start", "resume").catch((error) => error);
    let stop: Promise<unknown> | undefined;
    try {
      await entered.promise;
      stop = h.event("session_shutdown", "quit");
      release.resolve();
      await stop;
      expect(await restart).toMatchObject({ category: "closed" });
      await expect(h.tool()).rejects.toMatchObject({ category: "closed" });
      expect(state.clients).toHaveLength(1);
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
      await Promise.allSettled([restart, stop]);
    }
  });

  it.each(["disabled", "no UI", "text model", "foreign owner"])(
    "rechecks %s after real pending cleanup before tool or probe dispatch",
    async (change) => {
      const h = await harness();
      const removal = await failRemoval();
      await expect(h.command("status")).rejects.toMatchObject({
        category: "process-exit",
      });
      const home = removal.attempts[0]!;
      removal.restore();
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      const entered = barrier();
      const release = barrier();
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (path === home) {
          entered.resolve();
          await release.promise;
        }
        return actual.rm(path, options);
      });
      const tool = h.tool().catch((error) => error);
      const status = h.command("status");
      let reload: Promise<unknown> | undefined;
      try {
        await entered.promise;
        if (change === "disabled") {
          h.config.computerUse.enabled = false;
          await h.save();
          // Loading config precedes sync's retry. Observe that real retry so
          // the changed snapshot is installed before releasing the callers.
          const retried = barrier();
          const client = state.clients[0]!;
          const close = client.close.bind(client);
          vi.spyOn(client, "close").mockImplementation(() => {
            retried.resolve();
            return close();
          });
          reload = h.command("reload");
          await retried.promise;
        } else if (change === "no UI") h.ctx.hasUI = false;
        else if (change === "text model") h.ctx.model!.input = ["text"];
        else {
          const tools = h.pi.getAllTools();
          vi.spyOn(h.pi, "getAllTools").mockReturnValue(
            tools.map((tool) =>
              tool.name === "computer_use_click"
                ? {
                    ...tool,
                    sourceInfo: { ...tool.sourceInfo, path: "/foreign.ts" },
                  }
                : tool,
            ),
          );
        }
        release.resolve();
        await reload;
        expect(await tool).toMatchObject({
          message: "Computer Use is not active for the current session.",
        });
        await status;
        expect(state.clients).toHaveLength(1);
        await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(state.homes)).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([tool, status, reload]);
      }
    },
  );

  it.each(["confirm", "always"] as const)(
    "uses refreshed %s approval after pending probe cleanup and runtime disposal",
    async (mode) => {
      const h = await harness();
      h.config.computerUse.approvalMode =
        mode === "confirm" ? "always" : "confirm";
      await h.save();
      await h.command("reload");
      await h.tool();
      const runtimeHome = resources(state.clients[0]!).temporaryHome;
      const removal = await failRemoval();
      await expect(h.command("status")).rejects.toMatchObject({
        category: "process-exit",
      });
      const probeHome = removal.attempts[0]!;
      removal.restore();
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      const entered = barrier();
      const release = barrier();
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (path === probeHome) {
          entered.resolve();
          await release.promise;
        }
        return actual.rm(path, options);
      });
      const tool = h.tool("computer_use_get_app_state", { app: "App A" });
      let reload: Promise<unknown> | undefined;
      try {
        await entered.promise;
        h.config.computerUse.approvalMode = mode;
        await h.save();
        const disposing = barrier();
        const client = state.clients[0]!;
        const close = client.close.bind(client);
        vi.spyOn(client, "close").mockImplementation(() => {
          disposing.resolve();
          return close();
        });
        reload = h.command("reload");
        await disposing.promise;
        state.scenario = "session-approval";
        release.resolve();
        await reload;
        await tool;
        expect(state.clients).toHaveLength(3);
        expect(h.ctx.ui.confirm).toHaveBeenCalledTimes(
          mode === "confirm" ? 1 : 0,
        );
        await expect(access(runtimeHome)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(access(probeHome)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readdir(state.homes)).toHaveLength(1);
      } finally {
        release.resolve();
        await Promise.allSettled([tool, reload]);
      }
    },
  );

  it.each(["healthy", "tool", "status", "reload"])(
    "preserves valid client grants through ordinary factory reset with %s cleanup",
    async (retry) => {
      const h = await harness("session-approval");
      await h.tool("computer_use_get_app_state", { app: "App A" });
      const client = state.clients[0]!;
      const { child, temporaryHome: home } = resources(client);
      expect(h.ctx.ui.confirm).toHaveBeenCalledOnce();
      const removal = retry === "healthy" ? undefined : await failRemoval(home);
      child.stdout.emit("data", "invalid-json\n");
      if (removal) {
        await expect(resources(client).resetting).rejects.toMatchObject({
          category: "process-exit",
        });
        expect(client.hasCleanupError).toBe(true);
        await expect(access(home)).resolves.toBeUndefined();
        removal.restore();
        if (retry !== "tool") await h.command(retry);
      } else {
        await resources(client).resetting;
      }
      await h.tool("computer_use_get_app_state", { app: "App A" });
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
      expect(client.hasCleanupError).toBe(false);
      expect(state.clients).toHaveLength(retry === "status" ? 2 : 1);
      expect(client.isClosed).toBe(false);
      expect(h.ctx.ui.confirm).toHaveBeenCalledOnce();
      expect(await readFile(state.log, "utf8")).toContain(
        "computer-use-persisted-state",
      );
    },
  );

  it.each([
    ["session_before_switch", false],
    ["session_before_switch", true],
    ["session_shutdown", false],
    ["session_shutdown", true],
  ] as const)(
    "coalesces live cleanup retry with %s close (removal fails: %s)",
    async (lifecycle, fails) => {
      const h = await harness();
      await h.tool();
      const client = state.clients[0]!;
      const { child, temporaryHome: home } = resources(client);
      const removal = await failRemoval(home);
      child.stdout.emit("data", "invalid-json\n");
      await expect(resources(client).resetting).rejects.toMatchObject({
        category: "process-exit",
      });
      removal.restore();
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      const entered = barrier();
      const release = barrier();
      let attempts = 0;
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (path === home) {
          attempts++;
          entered.resolve();
          await release.promise;
          if (fails) throw new Error("PROTECTED_RETRY_REMOVAL");
        }
        return actual.rm(path, options);
      });
      const retryCleanup = vi.spyOn(client, "retryCleanup");
      const tool = h.tool().catch((error) => error);
      const status = h.command("status").catch((error) => error);
      let disposal: Promise<unknown> | undefined;
      let closedRetry: Promise<unknown> | undefined;
      try {
        await entered.promise;
        expect(retryCleanup).toHaveBeenCalledTimes(2);
        expect(client.isClosed).toBe(false);
        disposal = h.event(lifecycle, "reload").catch((error) => error);
        expect(client.isClosed).toBe(true);
        // The closed-client retry branch must join the same terminal attempt.
        closedRetry = client.retryCleanup().catch((error) => error);
        release.resolve();
        const category = fails ? "process-exit" : "closed";
        expect(await tool).toMatchObject({ category });
        expect(await status).toMatchObject({ category });
        if (fails) {
          expect(await closedRetry).toMatchObject({
            category: "process-exit",
          });
          if (lifecycle === "session_before_switch")
            expect(await disposal).toEqual({ cancel: true });
          else
            expect(await disposal).toMatchObject({
              message: expect.stringContaining("cleanup-incomplete"),
            });
          expect(client.hasCleanupError).toBe(true);
          await expect(access(home)).resolves.toBeUndefined();
        } else {
          expect(await closedRetry).toBeUndefined();
          expect(await disposal).toBeUndefined();
          await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(attempts).toBe(1);
        expect(state.clients).toEqual([client]);
        expect(
          (await readFile(state.log, "utf8")).split(".list_apps("),
        ).toHaveLength(2);
        vi.mocked(rm).mockImplementation(actual.rm);
        await h.command("reload");
        expect(client.isClosed).toBe(true);
        expect(client.hasCleanupError).toBe(false);
        await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(state.homes)).toEqual([]);
        if (lifecycle === "session_shutdown") {
          await expect(h.tool()).rejects.toMatchObject({ category: "closed" });
          await h.event("session_start", "resume");
        }
        await h.tool();
        expect(state.clients).toHaveLength(2);
        expect(state.clients[1]!.isClosed).toBe(false);
      } finally {
        release.resolve();
        vi.mocked(rm).mockImplementation(actual.rm);
        await Promise.allSettled([tool, status, disposal, closedRetry]);
      }
    },
  );

  it("a late dedicated probe finally cannot clear a replacement runtime slot", async () => {
    const h = await harness();
    await h.tool();
    const entered = barrier();
    const release = barrier();
    const probeTarget = ComputerUseClient.prototype.probeTarget;
    vi.spyOn(ComputerUseClient.prototype, "probeTarget").mockImplementation(
      async function (this: Client, signal) {
        await probeTarget.call(this, signal);
        entered.resolve();
        await release.promise;
      },
    );
    const status = h.command("status").catch((error) => error);
    try {
      await entered.promise;
      expect(state.clients).toHaveLength(2);
      expect(await h.event("session_before_fork")).toBeUndefined();
      await h.tool();
      const replacement = state.clients[2]!;
      release.resolve();
      expect(await status).toMatchObject({ category: "closed" });
      await h.tool();
      expect(replacement.isClosed).toBe(false);
      expect(state.clients).toHaveLength(3);
      expect(await readdir(state.homes)).toHaveLength(1);
    } finally {
      release.resolve();
      await status;
    }
  });

  it("fences callers held across preflight/shutdown and coalesces actual close", async () => {
    const h = await harness();
    await h.tool();
    const { temporaryHome: home, child } = resources(state.clients[0]!);
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const entered = barrier();
    const release = barrier();
    const killed = vi.spyOn(child, "kill");
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path === home) {
        entered.resolve();
        await release.promise;
      }
      return actual.rm(path, options);
    });
    const preflight = h.event("session_before_switch");
    let tool: Promise<unknown> | undefined;
    let status: Promise<unknown> | undefined;
    let stop: Promise<unknown> | undefined;
    try {
      await entered.promise;
      tool = h.tool().catch((error) => error);
      status = h.command("status").catch((error) => error);
      stop = h.event("session_shutdown", "reload");
      release.resolve();
      expect(await preflight).toBeUndefined();
      await stop;
      expect(await tool).toMatchObject({ category: "closed" });
      expect(await status).toMatchObject({ category: "closed" });
      expect(killed).toHaveBeenCalledOnce();
      expect(state.clients).toHaveLength(1);
      expect(await readdir(state.homes)).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([preflight, tool, status, stop]);
    }
  });
});
