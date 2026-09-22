import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { describe, expect, it, vi } from "vitest";

import piCodexToolkit, {
  CODE_MODE_EXEC_TOOL,
  CODE_MODE_WAIT_TOOL,
  EXEC_COMMAND_TOOL,
  syncOwnedTool,
  TOOL_DISCOVERY_TOOL,
  WRITE_STDIN_TOOL,
} from "../src/index.ts";
import { APPLY_PATCH_TOOL } from "../src/apply-patch.ts";
import { defaultConfig } from "../src/config.ts";
import { otherModel } from "./fixtures.ts";
import { withExecutionLifecycleResources } from "./fixtures/execution-lifecycle-resources.ts";
import { withEventBus } from "./fixtures/extension-events.ts";

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

const SOURCE_PATH = "/extension/src/index.ts";

function info(name: string, path: string): ToolInfo {
  return {
    name,
    sourceInfo: { path, source: "test", scope: "user", origin: "package" },
  } as ToolInfo;
}

/**
 * The extension's own registration as Pi 0.87 projects it: `parameters` by
 * reference, which is how a factory proves the winner is its own. A foreign
 * winner is another extension's registration, so it keeps `info()`'s bare
 * entry and can never contribute this extension's identity.
 */
function ownedInfo(tool: ToolDefinition, path: string): ToolInfo {
  return { ...info(tool.name, path), parameters: tool.parameters } as ToolInfo;
}

function registry() {
  return {
    find: () => undefined,
    getAvailable: () => [],
    isUsingOAuth: () => false,
  };
}

function syncContext(): Pick<ExtensionContext, "model" | "modelRegistry"> {
  return { model: otherModel(), modelRegistry: registry() } as unknown as Pick<
    ExtensionContext,
    "model" | "modelRegistry"
  >;
}

/** Sync `find_tools` alone: its owned-name check is the direct P1 predicate. */
function syncFindTools(
  tools: ToolInfo[],
  sourcePath = SOURCE_PATH,
): { conflict: boolean; active: string[] } {
  const config = defaultConfig();
  config.toolDiscovery.enabled = true;
  let active = ["read"];
  const pi = {
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    getAllTools: () => tools,
  } as unknown as Pick<
    ExtensionAPI,
    "getActiveTools" | "getAllTools" | "setActiveTools"
  >;
  const state = syncOwnedTool(pi, config, syncContext(), sourcePath);
  return { conflict: state.findToolsConflict, active };
}

function section(text: string, header: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(header);
  if (start < 0) throw new Error(`status section ${header} is missing`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    body.push(line);
  }
  return body;
}

interface Host {
  tools: Map<string, ToolDefinition>;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  command: RegisteredCommand["handler"];
  sourcePath: string;
  active(): string[];
  setActiveTools: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
}

// Fake Pi host over a real config directory; executions are real.
async function withHost(
  prefix: string,
  config: ReturnType<typeof defaultConfig>,
  project: (tool: ToolDefinition, sourcePath: string) => ToolInfo | undefined,
  run: (host: Host) => Promise<void>,
): Promise<void> {
  await withExecutionLifecycleResources(prefix, async (resources) => {
    const agentDirectory = resources.root;
    await mkdir(join(agentDirectory, "extensions"), { recursive: true });
    await writeFile(
      join(agentDirectory, "extensions", "pi-codex-toolkit.json"),
      JSON.stringify(config),
      "utf8",
    );
    const handlers = new Map<string, ExtensionHandler<never, unknown>>();
    const tools = new Map<string, ToolDefinition>();
    const sourcePath = fileURLToPath(
      new URL("../src/index.ts", import.meta.url),
    );
    let command: RegisteredCommand["handler"] | undefined;
    let active = ["read"];
    const setActiveTools = vi.fn((names: string[]) => {
      active = names;
    });
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerCommand: (
        _name: string,
        options: { handler: RegisteredCommand["handler"] },
      ) => {
        command = options.handler;
      },
      on: (event: string, handler: ExtensionHandler<never, unknown>) => {
        handlers.set(event, handler);
      },
      getActiveTools: () => active,
      getAllTools: () =>
        [...tools.values()].flatMap((tool) => {
          const projected = project(tool, sourcePath);
          return projected ? [projected] : [];
        }),
      setActiveTools,
    } as unknown as ExtensionAPI;
    const notify = vi.fn();
    const ctx = {
      cwd: agentDirectory,
      hasUI: true,
      ui: { notify },
      model: otherModel(),
      modelRegistry: registry(),
      scopedModels: [],
    } as unknown as ExtensionContext;
    resources.shutdown = () =>
      handlers.get("session_shutdown")?.(
        { type: "session_shutdown", reason: "quit" } as never,
        ctx,
      );
    piCodexToolkit(withEventBus(pi));
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" } as never,
      ctx,
    );
    if (!command) throw new Error("pct command was not registered");
    await run({
      tools,
      pi,
      ctx,
      command,
      sourcePath,
      active: () => active,
      setActiveTools,
      notify,
    });
  });
}

describe("tool ownership through owned-tool synchronization (P1)", () => {
  const owned = info(TOOL_DISCOVERY_TOOL, SOURCE_PATH);
  const foreign = info(TOOL_DISCOVERY_TOOL, "/other/discovery.ts");

  it.each<[string, ToolInfo[], boolean, string[]]>([
    ["an empty projection is unavailable", [], true, ["read"]],
    [
      "an owned winner with the same path is available",
      [owned],
      false,
      ["read", TOOL_DISCOVERY_TOOL],
    ],
    [
      "an owned winner with an equivalent unnormalized path is available",
      [info(TOOL_DISCOVERY_TOOL, "/extension/src/../src/./index.ts")],
      false,
      ["read", TOOL_DISCOVERY_TOOL],
    ],
    ["a foreign winner is a conflict", [foreign], true, ["read"]],
    [
      "the first projected entry wins over a later owned duplicate",
      [foreign, owned],
      true,
      ["read"],
    ],
    [
      "the first projected entry wins over a later foreign duplicate",
      [owned, foreign],
      false,
      ["read", TOOL_DISCOVERY_TOOL],
    ],
    [
      "the name comparison is exact",
      [info(TOOL_DISCOVERY_TOOL.toUpperCase(), SOURCE_PATH)],
      true,
      ["read"],
    ],
  ])("%s", (_title, tools, conflict, active) => {
    expect(syncFindTools(tools)).toEqual({ conflict, active });
  });

  it("normalizes the extension's own source path before comparing", () => {
    expect(syncFindTools([owned], "/extension/src/../src/index.ts")).toEqual({
      conflict: false,
      active: ["read", TOOL_DISCOVERY_TOOL],
    });
  });
});

describe("tool ownership through the Pi host", () => {
  it("absent names: sync reports unavailable and nested dispatch stays disabled", async () => {
    const config = defaultConfig();
    config.shellSessions.enabled = true;
    config.codeMode.enabled = true;
    // Simulate Pi's `--tools exec,wait` projection: the host lists only the
    // allowlisted names even though this extension registers the rest.
    const visible = new Set([CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL]);
    await withHost(
      "pct-ownership-absent-",
      config,
      (tool, sourcePath) =>
        visible.has(tool.name) ? ownedInfo(tool, sourcePath) : undefined,
      async (host) => {
        expect(host.active()).toEqual([
          "read",
          CODE_MODE_EXEC_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]);
        // P1 over the identical projection: an absent owned name cannot be
        // activated, so sync reports the Shell pair as conflicted.
        const state = syncOwnedTool(
          host.pi,
          config,
          syncContext(),
          host.sourcePath,
        );
        expect(state.shellConflict).toBe(true);
        expect(state.codeModeConflict).toBe(false);
        expect(host.active()).toEqual([
          "read",
          CODE_MODE_EXEC_TOOL,
          CODE_MODE_WAIT_TOOL,
        ]);

        // Absence is a CLI/role exclusion: nested Shell does not bypass it.
        const exec = host.tools.get(CODE_MODE_EXEC_TOOL);
        if (!exec) throw new Error("exec was not registered");
        // The filtered pair was never admitted, so it cannot be declared and
        // no worker starts.
        await expect(
          exec.execute(
            "ownership-absent-1",
            {
              code: 'const r = await tools.exec_command({ command: "echo nested-ok" }); return r.stdout.trim();',
              uses: [EXEC_COMMAND_TOOL],
            },
            undefined,
            undefined,
            host.ctx,
          ),
        ).rejects.toMatchObject({
          code: "invalid-uses",
          message: expect.stringContaining("not currently available"),
        });
        const nested = await exec.execute(
          "ownership-absent-2",
          {
            code: 'try { await tools.exec_command({ command: "echo nested-ok" }); return "dispatched"; } catch (error) { return error.message; }',
          },
          undefined,
          undefined,
          host.ctx,
        );
        expect(nested.details).toMatchObject({ status: "completed" });
        // The creation-time snapshot excludes the adapter, so an omitted
        // `uses` does not reopen it either.
        expect(
          String((nested.details as { result?: unknown }).result),
        ).toContain('was not declared in "uses" for this cell');
      },
    );
  });

  it("status renders one foreign and one absent Toolkit name as conflicts without syncing", async () => {
    const config = defaultConfig();
    config.shellSessions.enabled = true;
    config.codeMode.enabled = true;
    config.toolDiscovery.enabled = true;
    await withHost(
      "pct-ownership-status-",
      config,
      (tool, sourcePath) => {
        if (tool.name === TOOL_DISCOVERY_TOOL) return undefined;
        if (tool.name === CODE_MODE_EXEC_TOOL) {
          return info(tool.name, "/other/code-mode.ts");
        }
        return ownedInfo(tool, sourcePath);
      },
      async (host) => {
        const syncWrites = host.setActiveTools.mock.calls.length;
        await host.command("status", host.ctx as ExtensionCommandContext);
        expect(host.notify).toHaveBeenCalledTimes(1);
        const [text, level] = host.notify.mock.calls[0] as [string, string];
        expect(level).toBe("info");
        expect(section(text, "Code Mode:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: unavailable",
          "  reason: conflicting-tool-name",
        ]);
        expect(section(text, "Tool Discovery:").slice(0, 3)).toEqual([
          "  configured: on",
          "  effective: unavailable",
          "  reason: conflicting-tool-name",
        ]);
        const shell = section(text, "Shell Sessions:");
        expect(shell[0]).toBe("  configured: on");
        expect(shell[2]).not.toBe("  reason: conflicting-tool-name");
        expect(host.setActiveTools.mock.calls.length).toBe(syncWrites);
        // The visible foreign winner keeps its own activation state.
        expect(host.active()).not.toContain(CODE_MODE_WAIT_TOOL);
        expect(host.active()).not.toContain(TOOL_DISCOVERY_TOOL);
      },
    );
  });

  it("status matches the active set for deferred, loaded, and find_tools-absent restore", async () => {
    const config = defaultConfig();
    config.toolDiscovery.enabled = true;
    config.toolDiscovery.deferred = [APPLY_PATCH_TOOL, EXEC_COMMAND_TOOL];
    config.applyPatch.enabled = true;
    config.shellSessions.enabled = true;
    config.codeMode.enabled = true;
    let findToolsWinner: "owned" | "absent" = "owned";
    await withHost(
      "pct-status-truth-",
      config,
      (tool, sourcePath) => {
        if (tool.name === TOOL_DISCOVERY_TOOL && findToolsWinner === "absent") {
          return undefined;
        }
        return ownedInfo(tool, sourcePath);
      },
      async (host) => {
        const headers = [
          "Web Search:",
          "Remote Compaction:",
          "Image Generation:",
          "Apply Patch:",
          "Computer Use:",
          "Shell Sessions:",
          "Code Mode:",
          "Tool Discovery:",
        ];
        const effectiveOf = (text: string, header: string): string => {
          const line = section(text, header).find((entry) =>
            entry.startsWith("  effective: "),
          );
          if (!line) throw new Error(`${header} is missing effective`);
          return line.slice("  effective: ".length);
        };
        const discoveryField = (text: string, label: string): string => {
          const line = section(text, "Tool Discovery:").find((entry) =>
            entry.startsWith(`  ${label}: `),
          );
          if (!line) throw new Error(`Tool Discovery is missing ${label}`);
          return line.slice(`  ${label}: `.length);
        };

        const syncWrites = host.setActiveTools.mock.calls.length;
        await host.command("status", host.ctx as ExtensionCommandContext);
        expect(host.setActiveTools.mock.calls.length).toBe(syncWrites);
        expect(host.notify).toHaveBeenCalledTimes(1);
        const [hiddenText, hiddenLevel] = host.notify.mock.calls[0] as [
          string,
          string,
        ];
        expect(hiddenLevel).toBe("info");
        for (const header of headers) {
          expect(hiddenText.split("\n")).toContain(header);
        }
        expect(effectiveOf(hiddenText, "Apply Patch:")).toBe("deferred");
        expect(effectiveOf(hiddenText, "Shell Sessions:")).toBe("deferred");
        expect(effectiveOf(hiddenText, "Code Mode:")).toBe("active");
        expect(effectiveOf(hiddenText, "Tool Discovery:")).toBe("active");
        expect(effectiveOf(hiddenText, "Web Search:")).toBe("off");
        expect(effectiveOf(hiddenText, "Remote Compaction:")).toBe("off");
        expect(effectiveOf(hiddenText, "Image Generation:")).toBe("off");
        expect(effectiveOf(hiddenText, "Computer Use:")).toBe("off");
        expect(host.active()).not.toContain(APPLY_PATCH_TOOL);
        expect(host.active()).not.toContain(EXEC_COMMAND_TOOL);
        expect(host.active()).toContain(WRITE_STDIN_TOOL);
        expect(host.active()).toContain(CODE_MODE_EXEC_TOOL);
        expect(host.active()).toContain(CODE_MODE_WAIT_TOOL);
        expect(host.active()).toContain(TOOL_DISCOVERY_TOOL);
        expect(discoveryField(hiddenText, "managed deferred tools")).toBe("2");
        expect(discoveryField(hiddenText, "loaded this session")).toBe("0");

        const findTools = host.tools.get(TOOL_DISCOVERY_TOOL);
        if (!findTools) throw new Error("find_tools was not registered");
        await findTools.execute(
          "status-truth-load",
          { load: [APPLY_PATCH_TOOL] },
          undefined,
          undefined,
          host.ctx,
        );
        host.notify.mockClear();
        const afterLoadWrites = host.setActiveTools.mock.calls.length;
        await host.command("status", host.ctx as ExtensionCommandContext);
        expect(host.setActiveTools.mock.calls.length).toBe(afterLoadWrites);
        const [loadedText] = host.notify.mock.calls[0] as [string, string];
        expect(effectiveOf(loadedText, "Apply Patch:")).toBe("active");
        expect(effectiveOf(loadedText, "Shell Sessions:")).toBe("deferred");
        expect(host.active()).toContain(APPLY_PATCH_TOOL);
        expect(host.active()).not.toContain(EXEC_COMMAND_TOOL);
        expect(discoveryField(loadedText, "loaded this session")).toBe("1");

        findToolsWinner = "absent";
        await host.command("reload", host.ctx as ExtensionCommandContext);
        host.notify.mockClear();
        const afterRestoreWrites = host.setActiveTools.mock.calls.length;
        await host.command("status", host.ctx as ExtensionCommandContext);
        expect(host.setActiveTools.mock.calls.length).toBe(afterRestoreWrites);
        const [restoredText] = host.notify.mock.calls[0] as [string, string];
        expect(effectiveOf(restoredText, "Apply Patch:")).toBe("active");
        expect(effectiveOf(restoredText, "Shell Sessions:")).toBe("active");
        expect(effectiveOf(restoredText, "Tool Discovery:")).toBe(
          "unavailable",
        );
        expect(host.active()).toContain(APPLY_PATCH_TOOL);
        expect(host.active()).toContain(EXEC_COMMAND_TOOL);
        expect(host.active()).toContain(WRITE_STDIN_TOOL);
        expect(discoveryField(restoredText, "managed deferred tools")).toBe(
          "0",
        );
        expect(discoveryField(restoredText, "loaded this session")).toBe("0");
      },
    );
  });
});

describe("apply_patch enablement through the Pi host", () => {
  const patchText = [
    "*** Begin Patch",
    "*** Update File: gate.txt",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");

  it("refuses a real dispatch while configured off, then honours a reload that enables it", async () => {
    // defaultConfig() leaves applyPatch.enabled false, which is the shipped state.
    const config = defaultConfig();
    await withHost(
      "pct-apply-patch-gate-",
      config,
      (tool, sourcePath) => ownedInfo(tool, sourcePath),
      async (host) => {
        const applyPatch = host.tools.get(APPLY_PATCH_TOOL);
        if (!applyPatch) throw new Error("apply_patch was not registered");

        // Registration is unconditional; sync is what removes a disabled name.
        // The gate has to hold even so, because a dispatch can reach a
        // registered definition that sync has not yet pruned.
        expect(host.active()).not.toContain(APPLY_PATCH_TOOL);

        const target = join(host.ctx.cwd, "gate.txt");
        await writeFile(target, "old\n", "utf8");

        await expect(
          applyPatch.execute(
            "h1-off",
            { patch: patchText },
            undefined,
            undefined,
            host.ctx,
          ),
        ).rejects.toThrow("Apply Patch is not enabled.");
        await expect(readFile(target, "utf8")).resolves.toBe("old\n");

        // The predicate reads the live snapshot, so a reload must take effect on
        // the same registered definition rather than a captured copy.
        config.applyPatch.enabled = true;
        await writeFile(
          join(host.ctx.cwd, "extensions", "pi-codex-toolkit.json"),
          JSON.stringify(config),
          "utf8",
        );
        await host.command("reload", host.ctx as ExtensionCommandContext);
        expect(host.active()).toContain(APPLY_PATCH_TOOL);

        await applyPatch.execute(
          "h1-on",
          { patch: patchText },
          undefined,
          undefined,
          host.ctx,
        );
        await expect(readFile(target, "utf8")).resolves.toBe("new\n");
      },
    );
  });
});
