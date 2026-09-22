import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { defaultConfig } from "../src/config.ts";
import {
  buildExecutionDiagnostics,
  EXECUTION_DIAGNOSTICS_EVENT,
  readToolkitIdentity,
  type ExecutionDiagnosticsRecord,
} from "../src/execution-diagnostics.ts";
import {
  requestCapabilities,
  resolveExecutionRoutes,
} from "../src/execution-mode.ts";
import piCodexToolkit, {
  APPLY_PATCH_TOOL,
  CODE_MODE_EXEC_TOOL,
  CODE_MODE_WAIT_TOOL,
  EXEC_COMMAND_TOOL,
  WRITE_STDIN_TOOL,
} from "../src/index.ts";
import { ShellSessionManager } from "../src/shell/manager.ts";
import { model } from "./fixtures.ts";
import {
  withExecutionLifecycleResources,
  type ExecutionLifecycleResources,
} from "./fixtures/execution-lifecycle-resources.ts";
import {
  recordingEventBus,
  withEventBus,
} from "./fixtures/extension-events.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

const NATIVE_NAMES = ["read", "bash", "edit", "write"] as const;
const OWNED_NAMES = [
  APPLY_PATCH_TOOL,
  EXEC_COMMAND_TOOL,
  WRITE_STDIN_TOOL,
  CODE_MODE_EXEC_TOOL,
  CODE_MODE_WAIT_TOOL,
] as const;

/** Rules that request Patch + Code for `astra`, and nothing for other ids. */
function astraConfig() {
  const config = defaultConfig();
  config.execution = {
    version: 1,
    rules: [
      { id: "astra", match: "astra", patch: true, shell: false, code: true },
    ],
  };
  return config;
}

async function writeConfig(
  resources: ExecutionLifecycleResources,
  config: ReturnType<typeof defaultConfig>,
): Promise<void> {
  await mkdir(join(resources.root, "extensions"), { recursive: true });
  await writeFile(
    join(resources.root, "extensions", "pi-codex-toolkit.json"),
    JSON.stringify(config),
    "utf8",
  );
}

/**
 * A host that registers every owned name unless `absentTools` filters it, as a
 * child role's `--tools` allowlist does.
 */
function diagnosticsHost(
  resources: ExecutionLifecycleResources,
  options: { absentTools?: readonly string[]; hasUI?: boolean } = {},
) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  const sourcePath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const bus = recordingEventBus();
  let active: string[] = [...NATIVE_NAMES];
  const pi = withEventBus(
    {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerCommand: () => undefined,
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      getActiveTools: () => active,
      getAllTools: () => [
        ...[...tools.values()]
          .filter((tool) => !(options.absentTools ?? []).includes(tool.name))
          .map((tool) => ({
            ...tool,
            sourceInfo: {
              path: sourcePath,
              source: "test",
              scope: "user" as const,
              origin: "package" as const,
            },
          })),
        ...NATIVE_NAMES.map((name) => ({
          name,
          sourceInfo: {
            path: `<builtin:${name}>`,
            source: "builtin",
            scope: "temporary" as const,
            origin: "top-level" as const,
          },
        })),
      ],
      setActiveTools: (names: string[]) => {
        active = names;
      },
    } as unknown as ExtensionAPI,
    bus,
  );
  const current = model({ id: "astra", provider: "pct-offline" });
  const ctx = {
    cwd: resources.root,
    model: current,
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
      isUsingOAuth: () => false,
    },
    hasUI: options.hasUI ?? false,
    ui: {
      notify: vi.fn(),
      ...(options.hasUI ? { confirm: vi.fn(async () => true) } : {}),
    },
  } as unknown as ExtensionContext;
  resources.shutdown = () =>
    handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" } as never,
      ctx,
    );
  piCodexToolkit(pi);
  return {
    ctx,
    active: () => active,
    records: (): ExecutionDiagnosticsRecord[] =>
      bus.records
        .filter((entry) => entry.channel === EXECUTION_DIAGNOSTICS_EVENT)
        .map((entry) => entry.data as ExecutionDiagnosticsRecord),
    start: () =>
      handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" } as never,
        ctx,
      ),
    select: (id: string) => {
      current.id = id;
      return handlers.get("model_select")?.(
        { type: "model_select" } as never,
        ctx,
      );
    },
  };
}

/**
 * Replace `ShellSessionManager.close` for the syncs one test drives. The
 * returned restore runs before the fixture's own cleanup either way, so an
 * injected failure never becomes the shutdown's failure.
 */
function interceptShellClose(
  resources: ExecutionLifecycleResources,
  replacement: () => Promise<void>,
): () => void {
  const real = ShellSessionManager.prototype.close;
  ShellSessionManager.prototype.close =
    replacement as typeof ShellSessionManager.prototype.close;
  const restore = () => {
    ShellSessionManager.prototype.close = real;
  };
  resources.restoreBeforeCleanup.push(restore);
  return restore;
}

describe("execution diagnostics record", () => {
  it("publishes the committed projection on the first sync", async () => {
    await withExecutionLifecycleResources("pct-diagnostics-", async (r) => {
      await writeConfig(r, astraConfig());
      const host = diagnosticsHost(r, { hasUI: true });
      await host.start();

      const manifest = JSON.parse(
        await readFile(
          fileURLToPath(new URL("../package.json", import.meta.url)),
          "utf8",
        ),
      ) as { name: string; version: string };
      const records = host.records();
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({
        version: 1,
        model: { provider: "pct-offline", id: "astra" },
        source: "rules",
        ruleId: "astra",
        requested: { patch: true, shell: false, code: true },
        effective: {
          directPatch: false,
          nestedPatch: true,
          directShell: false,
          code: true,
        },
        admittedNames: [...OWNED_NAMES],
        visibleNames: [CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL],
        nestedNames: [APPLY_PATCH_TOOL, EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL],
        hiddenNatives: ["bash", "edit", "write"],
        notes: [],
        approvalTransport: "dialog",
        cleanupPending: false,
        configRevision: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        toolkit: { name: manifest.name, version: manifest.version },
      });
      // Names, flags and a revision only: no path, environment or file text.
      expect(JSON.stringify(records[0])).not.toContain(r.root);
    });
  });

  it("reports a role-filtered child as requested without any route", async () => {
    await withExecutionLifecycleResources(
      "pct-diagnostics-role-",
      async (r) => {
        await writeConfig(r, astraConfig());
        const host = diagnosticsHost(r, { absentTools: OWNED_NAMES });
        await host.start();

        const [record] = host.records();
        expect(record).toMatchObject({
          requested: { patch: true, shell: false, code: true },
          effective: {
            directPatch: false,
            nestedPatch: false,
            directShell: false,
            code: false,
          },
          admittedNames: [],
          visibleNames: [],
          nestedNames: [],
          hiddenNatives: [],
          notes: [
            "code-pair-unavailable",
            "code-unavailable-did-not-promote-patch",
          ],
          approvalTransport: "unavailable",
        });
        // The native baseline is untouched when no replacement is admitted.
        expect(host.active()).toEqual([...NATIVE_NAMES]);
      },
    );
  });

  it("publishes nothing for a superseded sync", async () => {
    await withExecutionLifecycleResources(
      "pct-diagnostics-race-",
      async (r) => {
        const config = astraConfig();
        config.execution?.rules.push({
          id: "third",
          match: "third",
          patch: true,
          shell: true,
          code: false,
        });
        await writeConfig(r, config);
        const host = diagnosticsHost(r);
        await host.start();
        expect(host.records()).toHaveLength(1);

        // The superseded sync holds its cleanup; the newer one commits first.
        let entered!: () => void;
        const reached = new Promise<void>((resolve) => (entered = resolve));
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        let blocked = true;
        interceptShellClose(r, async () => {
          if (!blocked) return;
          blocked = false;
          entered();
          await held;
        });
        const superseded = host.select("second");
        await reached;
        await host.select("third");
        release();
        await superseded;

        const records = host.records().slice(1);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          ruleId: "third",
          effective: {
            directPatch: true,
            nestedPatch: false,
            directShell: true,
            code: false,
          },
        });
      },
    );
  });

  it("publishes the retained projection while an apply stays rejected", async () => {
    await withExecutionLifecycleResources(
      "pct-diagnostics-pending-",
      async (r) => {
        await writeConfig(r, astraConfig());
        const host = diagnosticsHost(r);
        await host.start();

        let failing = true;
        interceptShellClose(r, async () => {
          if (failing) throw new Error("injected close failure");
        });
        // The unmatched model would drop every route, but the contraction
        // never commits: the record keeps describing the live projection.
        await expect(host.select("other")).rejects.toThrow(
          "injected close failure",
        );
        const rejected = host.records().at(-1);
        expect(rejected).toMatchObject({
          model: { id: "other" },
          source: "rules",
          ruleId: "astra",
          effective: {
            directPatch: false,
            nestedPatch: true,
            directShell: false,
            code: true,
          },
          visibleNames: [CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL],
          cleanupPending: true,
        });

        failing = false;
        await host.select("other");
        expect(host.records().at(-1)).toMatchObject({
          source: "unmatched",
          effective: {
            directPatch: false,
            nestedPatch: false,
            directShell: false,
            code: false,
          },
          visibleNames: [],
          hiddenNatives: [],
          cleanupPending: false,
        });
      },
    );
  });

  it("publishes nothing when the first apply rejects before any commit", async () => {
    await withExecutionLifecycleResources(
      "pct-diagnostics-first-",
      async (r) => {
        // Patch alone needs no Shell backend, so the sync's unconditional
        // close runs and fails this first apply before any commit.
        const config = defaultConfig();
        config.execution = {
          version: 1,
          rules: [
            { id: "p", match: "*", patch: true, shell: false, code: false },
          ],
        };
        await writeConfig(r, config);
        const host = diagnosticsHost(r);
        const restore = interceptShellClose(r, async () => {
          throw new Error("injected close failure");
        });
        try {
          await expect(host.start()).rejects.toThrow("injected close failure");
        } finally {
          restore();
        }
        expect(host.records()).toEqual([]);
      },
    );
  });
});

describe("diagnostics record shape", () => {
  const routes = resolveExecutionRoutes(
    requestCapabilities({
      legacy: { patch: false, shell: false, code: false },
      model: { id: "anything" },
    }),
    {
      patchOwnedAdmitted: false,
      shellPairAdmitted: false,
      codePairAdmitted: false,
    },
  );
  const input = {
    routes,
    names: [APPLY_PATCH_TOOL],
    admitted: [],
    active: [],
    hiddenNatives: [],
    approvalTransport: "unavailable" as const,
    cleanupPending: false,
    configRevision: "missing",
    toolkit: { name: "pi-codex-toolkit", version: "0.0.0-test" },
  };

  it.each([
    { name: "no model", model: undefined },
    { name: "a provider without an id", model: { provider: "pct-offline" } },
    { name: "an id without a provider", model: { id: "gpt-6-astra" } },
  ])("omits the identity for $name", ({ model: identity }) => {
    const record = buildExecutionDiagnostics({
      ...input,
      ...(identity ? { model: identity } : {}),
    });
    expect("model" in record).toBe(false);
    // A legacy source has no rule to name either.
    expect("ruleId" in record).toBe(false);
    expect(record.source).toBe("legacy");
  });
});

describe("packed toolkit identity", () => {
  it("reads name and version from the packed manifest", () => {
    const manifestPath = fileURLToPath(
      new URL("../package.json", import.meta.url),
    );
    const manifest = readToolkitIdentity(manifestPath);
    expect(manifest).toEqual({
      name: "pi-codex-toolkit",
      version: expect.stringMatching(/^\d+\.\d+\.\d+/) as string,
    });
  });

  it("reports an unknown version for an unreadable or partial manifest", async () => {
    await withExecutionLifecycleResources("pct-identity-", async (r) => {
      expect(readToolkitIdentity(join(r.root, "missing.json"))).toEqual({
        name: "pi-codex-toolkit",
        version: "unknown",
      });
      const partial = join(r.root, "partial.json");
      await writeFile(partial, JSON.stringify({ name: 7, version: "" }));
      expect(readToolkitIdentity(partial)).toEqual({
        name: "pi-codex-toolkit",
        version: "unknown",
      });
    });
  });
});
