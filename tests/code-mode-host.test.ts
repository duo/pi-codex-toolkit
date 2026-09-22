import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../src/config.ts";
import type { CodeModeCellResult } from "../src/code-mode/manager.ts";
import { otherModel } from "./fixtures.ts";
afterEach(() => vi.restoreAllMocks());

// A real Pi host in this process. A cold transform of the package dominates, and
// it scales with CPU contention far beyond the idle figure.
const HOST_BUDGET_MS = 40_000;

describe("public Pi ordinary-host execution/recovery", () => {
  it(
    "Pi 0.87 loads the package, binds hidden adapters, survives feature disable, and replaces the session",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pct-code-host-"));
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = root;
      let runtime: AgentSessionRuntime | undefined;
      const errors: unknown[] = [];
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("network forbidden"));
      try {
        const config = defaultConfig();
        config.shellSessions.enabled = true;
        config.codeMode.enabled = true;
        await mkdir(join(root, "extensions"));
        const configPath = join(root, "extensions", "pi-codex-toolkit.json");
        await writeFile(configPath, JSON.stringify(config));
        const models = await ModelRuntime.create({
          credentials: new InMemoryCredentialStore(),
          modelsPath: null,
          modelsStorePath: join(root, "models-store.json"),
          allowModelNetwork: false,
          refreshOnCreate: false,
        });
        const modelCall = vi.spyOn(models, "stream").mockImplementation(() => {
          throw new Error("model calls forbidden");
        });
        const simpleCall = vi
          .spyOn(models, "streamSimple")
          .mockImplementation(() => {
            throw new Error("model calls forbidden");
          });
        const factory: CreateAgentSessionRuntimeFactory = async ({
          cwd,
          sessionManager,
          sessionStartEvent,
        }) => {
          const services = await createAgentSessionServices({
            cwd,
            agentDir: root,
            modelRuntime: models,
            settingsManager: SettingsManager.inMemory({
              compaction: { enabled: false },
            }),
            resourceLoaderOptions: {
              additionalExtensionPaths: [resolve(".")],
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
            },
          });
          const result = await createAgentSessionFromServices({
            services,
            sessionManager,
            sessionStartEvent,
            model: otherModel(),
            tools: [
              "read",
              "bash",
              "exec",
              "wait",
              "exec_command",
              "write_stdin",
            ],
          });
          expect(result.extensionsResult.errors).toEqual([]);
          await result.session.bindExtensions({
            mode: "print",
            onError: (error) => {
              errors.push(error);
            },
          });
          return { ...result, services, diagnostics: services.diagnostics };
        };
        runtime = await createAgentSessionRuntime(factory, {
          cwd: root,
          agentDir: root,
          sessionManager: SessionManager.inMemory(root),
        });
        const tool = (name: string) => {
          const found = runtime!.session.agent.state.tools.find(
            (t) => t.name === name,
          );
          if (!found) throw new Error(`missing active ${name}`);
          return found;
        };
        expect(runtime.session.agent.state.tools.map((t) => t.name)).toEqual(
          expect.arrayContaining([
            "read",
            "bash",
            "exec",
            "wait",
            "exec_command",
            "write_stdin",
          ]),
        );
        const oldExec = tool("exec");
        let r = (
          await oldExec.execute("host-exec", {
            code: 'const s=await tools.exec_command({command:"printf \'%06000d\' 0",maxOutputBytes:1024}); print("cell-output-".repeat(1000)); return {shellRecovery:s.recovery};',
            uses: ["exec_command"],
            maxOutputBytes: 1024,
          })
        ).details as CodeModeCellResult;
        for (let n = 0; r.status === "running" && n < 30; n++)
          r = (
            await tool("wait").execute(`host-wait-${n}`, {
              cellId: r.cellId,
              maxOutputBytes: 1024,
            })
          ).details as CodeModeCellResult;
        expect(r.status).toBe("completed");
        const cellPath = r.recovery!.output!.path!;
        const shellPath = (
          r.result as { shellRecovery: { stdout: { path: string } } }
        ).shellRecovery.stdout.path;
        config.shellSessions.enabled = false;
        config.codeMode.enabled = false;
        await writeFile(configPath, JSON.stringify(config));
        // Real public command dispatch; this path must not invoke a provider.
        await runtime.session.prompt("/pct reload");
        expect(
          runtime.session.agent.state.tools.map((t) => t.name),
        ).not.toContain("exec");
        for (const [path, marker] of [
          [cellPath, "cell-output-"],
          [shellPath, "000000"],
        ]) {
          const recovered = await tool("read").execute("recover", {
            path,
            limit: 2,
          });
          expect(
            recovered.content.some(
              (c) => c.type === "text" && c.text.includes(marker),
            ),
          ).toBe(true);
        }
        config.shellSessions.enabled = true;
        config.codeMode.enabled = true;
        await writeFile(configPath, JSON.stringify(config));
        await runtime.newSession();
        await expect(readFile(cellPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(shellPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          oldExec.execute("old-owner", { code: "return 0;" }),
        ).rejects.toThrow();
        const fresh = (
          await tool("exec").execute("fresh-owner", {
            code: 'return (await tools.exec_command({command:"printf fresh"})).stdout;',
            uses: ["exec_command"],
          })
        ).details as CodeModeCellResult;
        expect(fresh.status).toBe("completed");
        expect(fresh.result).toBe("fresh");
        expect(errors).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
        expect(modelCall).not.toHaveBeenCalled();
        expect(simpleCall).not.toHaveBeenCalled();
      } finally {
        try {
          await runtime?.dispose();
        } finally {
          if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previous;
          await rm(root, { recursive: true, force: true });
        }
      }
    },
    HOST_BUDGET_MS,
  );
});
