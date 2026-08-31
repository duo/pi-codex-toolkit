import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComputerUseClient,
  ComputerUseClientError,
  inspectComputerUseRuntime,
  type ComputerUseRuntime,
} from "../src/computer-use/app-server-client.ts";

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

async function harness(
  scenario = "normal",
  requestTimeoutMs = 2_000,
): Promise<Harness> {
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
    startupTimeoutMs: 1_000,
    requestTimeoutMs,
  });
  clients.push(client);
  return { client, directory, homes, logPath, statePath, runtime };
}

async function logs(path: string): Promise<FakeLogEntry[]> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeLogEntry);
}

async function inputs(
  path: string,
): Promise<NonNullable<FakeLogEntry["message"]>[]> {
  return (await logs(path)).flatMap((entry) =>
    entry.type === "input" && entry.message ? [entry.message] : [],
  );
}

async function waitForToolCall(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const found = await readFile(path, "utf8")
      .then((text) => text.includes('"method":"mcpServer/tool/call"'))
      .catch(() => false);
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fake app-server did not receive a tool call");
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
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
    const test = await harness("hang", 500);
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
});
