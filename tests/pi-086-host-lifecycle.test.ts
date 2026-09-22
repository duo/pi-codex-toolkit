import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  InMemoryCredentialStore,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { APPLY_PATCH_TOOL } from "../src/apply-patch.ts";
import { defaultConfig, type ToolkitConfig } from "../src/config.ts";
import {
  CODE_MODE_EXEC_TOOL,
  CODE_MODE_WAIT_TOOL,
  createPiCodexToolkit,
  EXEC_COMMAND_TOOL,
  TOOL_DISCOVERY_TOOL,
  WRITE_STDIN_TOOL,
} from "../src/index.ts";
import type { ExecutionDiagnosticsRecord } from "../src/execution-diagnostics.ts";
import {
  newestRemoteCompaction,
  REMOTE_COMPACTION_KIND,
  type RemoteCompactionDetailsV1,
} from "../src/openai/remote-compaction.ts";
import { ShellSessionManager } from "../src/shell/manager.ts";
import { codexModel, otherModel } from "./fixtures.ts";
import { INNER_BUDGET_MS } from "./fixtures/budgets.ts";

const HOST_BUDGET_MS = 40_000;
const ACCOUNT_ID = "account-host";
const POST_COMPACTION_INPUT = "user input after first compaction";
const PAYLOAD_CAPTURED = "pi-086-host-payload-captured";

afterEach(() => vi.restoreAllMocks());

function jwt(accountId: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

function remoteSse(checkpointId: string): Response {
  const events = [
    {
      type: "response.output_item.done",
      item: {
        type: "compaction",
        id: checkpointId,
        encrypted_content: `opaque-${checkpointId}`,
      },
    },
    { type: "response.completed", response: {} },
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function assistantDone(
  currentModel: Model<Api>,
  text: string,
): AssistantMessage {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: currentModel.api,
    provider: currentModel.provider,
    model: currentModel.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function webSearchCount(payload: unknown): number {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return 0;
  return payload.tools.filter(
    (tool) => isRecord(tool) && tool.type === "web_search",
  ).length;
}

function checkpointIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return [];
  return payload.input.flatMap((item) =>
    isRecord(item) && item.type === "compaction" && typeof item.id === "string"
      ? [item.id]
      : [],
  );
}

function responsePayload(payload: unknown): {
  input: Record<string, unknown>[];
  tools: Record<string, unknown>[];
} {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.input) ||
    !payload.input.every(isRecord) ||
    !Array.isArray(payload.tools) ||
    !payload.tools.every(isRecord)
  ) {
    throw new Error("missing converted Responses input/tools");
  }
  return { input: payload.input, tools: payload.tools };
}

function keptAssistant(manager: SessionManager): AssistantMessage {
  const compaction = manager
    .getBranch()
    .findLast((entry) => entry.type === "compaction");
  if (!compaction) throw new Error("missing persisted compaction");
  const kept = manager.getEntry(compaction.firstKeptEntryId);
  if (kept?.type !== "message" || kept.message.role !== "assistant") {
    throw new Error("expected the real first kept entry to be an assistant");
  }
  return kept.message;
}

function expectCheckpointThenTail(
  payload: unknown,
  details: RemoteCompactionDetailsV1,
  kept: AssistantMessage,
  userInput: string,
): void {
  const { input } = responsePayload(payload);
  // A fresh host may add a cwd system-section update. Conversation order must
  // still match the actual firstKeptEntryId, not a string in retainedInput.
  expect(input.filter((item) => item.role !== "developer")).toEqual([
    ...details.retainedInput,
    details.checkpoint,
    expect.objectContaining({
      type: "message",
      role: "assistant",
      content: kept.content.map((block) => {
        if (block.type !== "text")
          throw new Error("expected a text-only kept assistant");
        return { type: "output_text", text: block.text, annotations: [] };
      }),
    }),
    { role: "user", content: [{ type: "input_text", text: userInput }] },
  ]);
  expect(JSON.stringify(input)).not.toContain(details.marker);
}

/** Owned execution-diagnostics records one receipt file collected. */
async function diagnosticsRecords(
  receiptPath: string,
): Promise<ExecutionDiagnosticsRecord[]> {
  const receipt = await readFile(receiptPath, "utf8");
  return receipt
    .split("\n")
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        (JSON.parse(line) as { record: ExecutionDiagnosticsRecord }).record,
    );
}

type StreamCall = {
  model: Model<Api>;
  context: Context;
  options?: ModelsSimpleStreamOptions;
  transformed: unknown;
};

async function capturePayload(
  models: ModelRuntime,
  model: Model<Api>,
  context: Context,
  options?: ModelsSimpleStreamOptions,
): Promise<unknown> {
  const provider = models.getProvider(model.provider);
  if (!provider) throw new Error(`missing provider: ${model.provider}`);
  let transformed: unknown;
  let fetchCalls = 0;
  const events: AssistantMessageEvent[] = [];
  const capture = provider.stream(model, normalizeContext(context), {
    ...options,
    apiKey: jwt(ACCOUNT_ID),
    transport: "sse",
    maxRetries: 0,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("capture transport forbidden");
    },
    onPayload: async (payload) => {
      transformed = (await options?.onPayload?.(payload, model)) ?? payload;
      throw new Error(PAYLOAD_CAPTURED);
    },
  });
  for await (const event of capture) events.push(event);
  expect(fetchCalls).toBe(0);
  const terminal = events[0];
  if (events.length !== 1 || terminal?.type !== "error") {
    throw new Error("capture did not produce its sole error terminal");
  }
  if (terminal.error.errorMessage !== PAYLOAD_CAPTURED) {
    throw new Error(
      terminal.error.errorMessage ?? "capture failed without an error",
    );
  }
  if (transformed === undefined)
    throw new Error("provider did not invoke onPayload");
  return transformed;
}

async function withHost(
  options: {
    config: ToolkitConfig;
    currentModel?: Model<Api>;
    /** Omit for an unrestricted host: no `tools` allowlist reaches the SDK. */
    tools?: string[];
    /**
     * Per-construction `defaultTools` setting; evaluated on every session
     * build so a test can narrow the fresh host's baseline mid-flight.
     */
    defaultTools?: () => string[] | undefined;
    cacheWarming?: "off" | "streaming" | "idle";
    persist?: boolean;
    sessionManager?: SessionManager;
    compactable?: boolean;
    allowCodexFetch?: boolean;
    /**
     * Extension sources this host loads. Defaults to the repository package,
     * whose `pi.extensions` manifest entry is `./src/index.ts`; a wrapper lane
     * points at its own extension file instead.
     */
    extensionSources?: (root: string) => string[] | Promise<string[]>;
    /**
     * SDK extensions this host loads from already-built factories, after the
     * file extensions and in this order. Pi gives each one an `<inline:name>`
     * identity, so two factories created from the same imported module — the
     * embedding shape the ownership detection has to separate — load as
     * distinct extensions in one process.
     */
    extensionFactories?: InlineExtension[];
    /**
     * Loading two extensions that register the same tool names is the subject
     * of the ownership lanes, and Pi reports every duplicate as a load error.
     * Only those exact conflict entries are tolerated; any other load error
     * still fails the lane.
     */
    expectToolNameConflicts?: boolean;
  },
  body: (input: {
    runtime: AgentSessionRuntime;
    models: ModelRuntime;
    config: ToolkitConfig;
    configPath: string;
    requests: StreamCall[];
    fetch: Mock<typeof globalThis.fetch>;
    errors: unknown[];
    root: string;
    sessionDir: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pct-086-host-"));
  const sessionDir = join(root, "sessions");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = root;
  let runtime: AgentSessionRuntime | undefined;
  const errors: unknown[] = [];
  const requests: StreamCall[] = [];
  const producers: Promise<void>[] = [];
  const fetch: Mock<typeof globalThis.fetch> = vi.fn(async (input) => {
    const url = String(input);
    if (
      options.allowCodexFetch &&
      url.includes("https://chatgpt.com/backend-api/codex/responses")
    ) {
      return remoteSse(`cmp_${fetch.mock.calls.length}`);
    }
    throw new Error("network forbidden");
  });
  try {
    globalThis.fetch = fetch;
    await mkdir(join(root, "extensions"));
    await mkdir(sessionDir);
    const configPath = join(root, "extensions", "pi-codex-toolkit.json");
    await writeFile(configPath, JSON.stringify(options.config));
    const extensionPaths = options.extensionSources
      ? await options.extensionSources(root)
      : [resolve(".")];
    const models = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(root, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    vi.spyOn(models, "stream").mockImplementation(() => {
      throw new Error("model stream forbidden");
    });
    vi.spyOn(models, "hasConfiguredAuth").mockReturnValue(true);
    vi.spyOn(models, "isUsingOAuth").mockImplementation(
      (providerId) => providerId === "openai-codex",
    );
    vi.spyOn(models, "getAuth").mockResolvedValue({
      auth: { apiKey: jwt(ACCOUNT_ID) },
    });
    vi.spyOn(models, "streamSimple").mockImplementation(
      (currentModel, context, streamOptions) => {
        const stream = createAssistantMessageEventStream();
        producers.push(
          (async () => {
            try {
              const transformed = await capturePayload(
                models,
                currentModel,
                context,
                streamOptions,
              );
              requests.push({
                model: currentModel,
                context,
                options: streamOptions,
                transformed,
              });
              const message = assistantDone(
                currentModel,
                `offline answer ${requests.length}`,
              );
              stream.push({
                type: "start",
                partial: { ...message, content: [] },
              });
              stream.push({ type: "done", reason: "stop", message });
            } catch (error) {
              stream.push({
                type: "error",
                reason: "error",
                error: {
                  ...assistantDone(currentModel, ""),
                  content: [],
                  stopReason: "error",
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                },
              });
            } finally {
              stream.end();
            }
          })(),
        );
        return stream;
      },
    );
    const currentModel = options.currentModel ?? otherModel();
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
          compaction: options.compactable
            ? { enabled: true, keepRecentTokens: 1, reserveTokens: 0 }
            : { enabled: false },
          cacheWarming: options.cacheWarming ?? "off",
          defaultTools: options.defaultTools?.(),
        }),
        resourceLoaderOptions: {
          additionalExtensionPaths: extensionPaths,
          ...(options.extensionFactories
            ? { extensionFactories: options.extensionFactories }
            : {}),
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
        model: currentModel,
        tools: options.tools,
      });
      expect(
        options.expectToolNameConflicts
          ? result.extensionsResult.errors.filter(
              (entry) => !/^Tool "[^"]+" conflicts with /.test(entry.error),
            )
          : result.extensionsResult.errors,
      ).toEqual([]);
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
      sessionManager:
        options.sessionManager ??
        (options.persist
          ? SessionManager.create(root, sessionDir)
          : SessionManager.inMemory(root)),
    });
    await body({
      runtime,
      models,
      config: options.config,
      configPath,
      requests,
      fetch,
      errors,
      root,
      sessionDir,
    });
    expect(errors).toEqual([]);
  } finally {
    try {
      await Promise.all(producers);
      await runtime?.dispose();
    } finally {
      globalThis.fetch = previousFetch;
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  }
}

/**
 * An embedder that stages the Toolkit's tool registrations: Pi attributes no
 * tool to the factory — and therefore no identity, and no native provenance
 * keyed by it — until the lane calls `publish()` and the definitions reach
 * Pi's public `registerTool`. Every other call goes straight to the real
 * host, and a binding created after the publication registers normally, which
 * is what a reload rebuilds.
 */
function stagingToolkit(): {
  factory: (pi: ExtensionAPI) => void;
  publish: () => void;
} {
  const staged: ToolDefinition[] = [];
  let bound: ExtensionAPI | undefined;
  let staging = true;
  return {
    factory: (pi) => {
      bound = pi;
      createPiCodexToolkit()(
        new Proxy(pi, {
          get(target, property, receiver) {
            if (property !== "registerTool") {
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (tool: ToolDefinition): void => {
              if (staging) staged.push(tool);
              else pi.registerTool(tool);
            };
          },
        }),
      );
    },
    publish: () => {
      staging = false;
      const pi = bound;
      if (!pi) throw new Error("the staging factory was never bound");
      for (const tool of staged.splice(0)) pi.registerTool(tool);
    },
  };
}

function remoteConfig(): ToolkitConfig {
  const config = defaultConfig();
  config.webSearch.enabled = true;
  config.webSearch.backend = "native";
  config.remoteCompaction.enabled = true;
  config.applyPatch.enabled = true;
  return config;
}

describe("Pi 0.87 host lifecycle", () => {
  it(
    "restores suppressed builtins after a host reload on an unrestricted session",
    async () => {
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          { id: "all", match: "*", patch: true, shell: true, code: false },
        ],
      };
      await withHost(
        { config, currentModel: otherModel() },
        async ({ runtime, configPath }) => {
          // The suppressing rule replaces the builtins with owned Patch/Shell.
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            APPLY_PATCH_TOOL,
            "exec_command",
            "write_stdin",
          ]);
          // reload() rebuilds the factory against the already-filtered active
          // list; the process-global suppression record is what makes the
          // builtin restoration possible once the rules stop hiding them.
          config.execution = {
            version: 1,
            rules: [
              {
                id: "all",
                match: "*",
                patch: false,
                shell: false,
                code: false,
              },
            ],
          };
          await writeFile(configPath, JSON.stringify(config));
          await runtime.session.reload();
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            "bash",
            "edit",
            "write",
          ]);
        },
      );
    },
    HOST_BUDGET_MS,
  );

  it(
    "restores suppressed builtins after a reload beside an unpinned wrapper",
    async () => {
      // The package extension wins every owned name; the wrapper file loaded
      // beside it resolves no identity and owns nothing. Native provenance is
      // kept per factory identity, so the loser neither records nor replaces
      // the winner's history — the reload still restores all three builtins.
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          { id: "ps", match: "*", patch: true, shell: true, code: false },
        ],
      };
      const toolkitEntry = fileURLToPath(
        new URL("../src/index.ts", import.meta.url),
      );
      const wrapperRoot = await mkdtemp(join(tmpdir(), "pct-086-stash-"));
      const wrapperPath = join(wrapperRoot, "wrapper-extension.ts");
      await writeFile(
        wrapperPath,
        `import { createPiCodexToolkit } from ${JSON.stringify(toolkitEntry)};\n\n` +
          `export default createPiCodexToolkit();\n`,
        "utf8",
      );
      try {
        await withHost(
          {
            config,
            currentModel: otherModel(),
            expectToolNameConflicts: true,
            extensionSources: () => [resolve("."), wrapperPath],
          },
          async ({ runtime, configPath }) => {
            expect(runtime.session.getActiveToolNames()).toEqual([
              "read",
              APPLY_PATCH_TOOL,
              "exec_command",
              "write_stdin",
            ]);
            config.execution = { version: 1, rules: [] };
            await writeFile(configPath, JSON.stringify(config));
            await runtime.session.reload();
            expect(runtime.session.getActiveToolNames()).toEqual([
              "read",
              "bash",
              "edit",
              "write",
            ]);
          },
        );
      } finally {
        await rm(wrapperRoot, { recursive: true, force: true });
      }
    },
    HOST_BUDGET_MS,
  );

  it(
    "restores suppressed builtins after a reload beside a second SDK factory",
    async () => {
      // Two factories built from one imported module, the embedding shape the
      // per-factory schema identity separates. The second owns nothing here,
      // so only the first keeps native provenance for this session lineage.
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          { id: "ps", match: "*", patch: true, shell: true, code: false },
        ],
      };
      await withHost(
        {
          config,
          currentModel: otherModel(),
          expectToolNameConflicts: true,
          extensionSources: () => [],
          extensionFactories: [
            { name: "first", factory: createPiCodexToolkit() },
            { name: "second", factory: createPiCodexToolkit() },
          ],
        },
        async ({ runtime, configPath }) => {
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            APPLY_PATCH_TOOL,
            "exec_command",
            "write_stdin",
          ]);
          config.execution = { version: 1, rules: [] };
          await writeFile(configPath, JSON.stringify(config));
          await runtime.session.reload();
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            "bash",
            "edit",
            "write",
          ]);
        },
      );
    },
    HOST_BUDGET_MS,
  );

  it(
    "records native provenance when staged registrations arrive during a sync",
    async () => {
      // An embedder that publishes late: session_start and the sync that
      // follows it run before Pi can attribute a single tool to this factory,
      // so its identity is unresolved and the native hydration is deferred.
      // The definitions then reach Pi's public registerTool while the next
      // sync is parked in its owned-resource cleanup, which makes the re-plan
      // after that await the first projection able to hide a builtin.
      // Hydrating there is what leaves a record for the later restore.
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          { id: "ps", match: "*", patch: true, shell: true, code: false },
        ],
      };
      const embedder = stagingToolkit();
      const proto = ShellSessionManager.prototype as unknown as {
        close(): Promise<void>;
      };
      const realClose = proto.close;
      let hold = false;
      let release: (() => void) | undefined;
      proto.close = function (this: never, ...args: unknown[]) {
        if (!hold) return realClose.apply(this, args as []);
        hold = false;
        return new Promise<void>((resolve) => {
          release = () => resolve(realClose.apply(this, args as []));
        });
      } as typeof proto.close;
      try {
        await withHost(
          {
            config,
            currentModel: otherModel(),
            extensionSources: () => [],
            extensionFactories: [{ name: "staged", factory: embedder.factory }],
          },
          async ({ runtime, models, configPath }) => {
            // Nothing is attributed to the factory yet: it owns no name,
            // admits no route and hides no builtin.
            expect(runtime.session.getActiveToolNames()).toEqual([
              "read",
              "bash",
              "edit",
              "write",
            ]);
            vi.spyOn(models, "checkAuth").mockResolvedValue({
              type: "api_key",
            });
            hold = true;
            const change = runtime.session.setModel(codexModel());
            try {
              await vi.waitFor(
                () => {
                  if (!release) throw new Error("the sync held no cleanup yet");
                },
                { timeout: INNER_BUDGET_MS, interval: 5 },
              );
            } catch (error) {
              // The rule below, applied to the one failure that precedes it:
              // disarm the hold and release whatever is already parked, or
              // the host's teardown waits for a cleanup nothing completes.
              hold = false;
              release?.();
              throw error;
            }
            // Read the parked state, then publish and release before
            // asserting it: a failed assertion must not leave the held
            // cleanup — and the host's teardown — waiting forever. Pi
            // activates the three names as it registers them, while the sync
            // still awaits the cleanup it started before they existed.
            const parked = runtime.session.getActiveToolNames();
            embedder.publish();
            release?.();
            await change;
            expect(parked).toEqual(["read", "bash", "edit", "write"]);
            expect(runtime.session.getActiveToolNames()).toEqual([
              "read",
              APPLY_PATCH_TOOL,
              "exec_command",
              "write_stdin",
            ]);

            // The deferred hydration is finished, so this model change cannot
            // retry it against the list the projection above filtered.
            await runtime.session.setModel(otherModel());
            expect(runtime.session.getActiveToolNames()).toEqual([
              "read",
              APPLY_PATCH_TOOL,
              "exec_command",
              "write_stdin",
            ]);

            // The record the mid-sync hydration created is what a reload
            // rebuilt against the filtered list restores the builtins from.
            config.execution = { version: 1, rules: [] };
            await writeFile(configPath, JSON.stringify(config));
            await runtime.session.reload();
            expect(runtime.session.getActiveToolNames()).toEqual([
              "read",
              "bash",
              "edit",
              "write",
            ]);
          },
        );
      } finally {
        proto.close = realClose;
      }
    },
    HOST_BUDGET_MS,
  );

  it(
    "restores suppressed builtins when staged registrations precede the sync",
    async () => {
      // The control for the lane above: the same staging embedder publishes
      // its definitions before session_start, so the identity resolves at the
      // ordinary point and the staging itself changes nothing.
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          { id: "ps", match: "*", patch: true, shell: true, code: false },
        ],
      };
      const embedder = stagingToolkit();
      await withHost(
        {
          config,
          currentModel: otherModel(),
          extensionSources: () => [],
          extensionFactories: [
            {
              name: "staged",
              factory: (pi) => {
                embedder.factory(pi);
                embedder.publish();
              },
            },
          ],
        },
        async ({ runtime, configPath }) => {
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            APPLY_PATCH_TOOL,
            "exec_command",
            "write_stdin",
          ]);
          config.execution = { version: 1, rules: [] };
          await writeFile(configPath, JSON.stringify(config));
          await runtime.session.reload();
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            "bash",
            "edit",
            "write",
          ]);
        },
      );
    },
    HOST_BUDGET_MS,
  );

  it(
    "re-syncs disabled Apply Patch after tree navigation restores transcript tools",
    async () => {
      const config = defaultConfig();
      config.applyPatch.enabled = true;
      await withHost(
        { config, tools: ["read", APPLY_PATCH_TOOL] },
        async ({ runtime, configPath, requests, fetch }) => {
          await runtime.session.prompt("first request with patch enabled");
          const firstAssistant = runtime.session.sessionManager
            .getBranch()
            .find(
              (entry) =>
                entry.type === "message" && entry.message.role === "assistant",
            );
          if (!firstAssistant || firstAssistant.type !== "message") {
            throw new Error("missing first assistant entry");
          }
          await runtime.session.prompt("second request with patch enabled");
          config.applyPatch.enabled = false;
          await writeFile(configPath, JSON.stringify(config));
          await runtime.session.prompt("/pct reload");
          expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
          await runtime.session.navigateTree(firstAssistant.id);
          expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
          expect(
            runtime.session.agent.state.tools.map((tool) => tool.name),
          ).not.toContain(APPLY_PATCH_TOOL);
          requests.length = 0;
          await runtime.session.prompt(
            "request after tree while patch disabled",
          );
          const latest = requests.at(-1)?.context;
          if (!latest) throw new Error("missing tree-navigation request");
          expect(
            getCurrentTools(latest.messages).map((tool) => tool.name),
          ).toEqual(["read"]);
          expect(fetch).not.toHaveBeenCalled();
        },
      );
    },
    HOST_BUDGET_MS,
  );

  it(
    "keeps a session-loaded deferred tool across tree navigation",
    async () => {
      const config = defaultConfig();
      config.applyPatch.enabled = true;
      config.toolDiscovery.enabled = true;
      config.toolDiscovery.deferred = [APPLY_PATCH_TOOL];
      await withHost(
        {
          config,
          tools: ["read", APPLY_PATCH_TOOL, TOOL_DISCOVERY_TOOL],
        },
        async ({ runtime, fetch }) => {
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            TOOL_DISCOVERY_TOOL,
          ]);
          await runtime.session.prompt("before loading deferred patch");
          const firstAssistant = runtime.session.sessionManager
            .getBranch()
            .find(
              (entry) =>
                entry.type === "message" && entry.message.role === "assistant",
            );
          if (!firstAssistant) throw new Error("missing first assistant entry");
          const finder = runtime.session.agent.state.tools.find(
            (tool) => tool.name === TOOL_DISCOVERY_TOOL,
          );
          if (!finder) throw new Error("missing find_tools");
          const loadDeferred = finder.execute as (
            toolCallId: string,
            params: { load: string[] },
            signal?: AbortSignal,
            onUpdate?: unknown,
            ctx?: {
              model: ReturnType<typeof otherModel>;
              modelRegistry: {
                find: () => undefined;
                getAvailable: () => never[];
                isUsingOAuth: () => boolean;
              };
              hasUI: boolean;
            },
          ) => Promise<unknown>;
          await loadDeferred(
            "load-patch",
            { load: [APPLY_PATCH_TOOL] },
            undefined,
            undefined,
            {
              model: otherModel(),
              modelRegistry: {
                find: () => undefined,
                getAvailable: () => [],
                isUsingOAuth: () => false,
              },
              hasUI: false,
            },
          );
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            TOOL_DISCOVERY_TOOL,
            APPLY_PATCH_TOOL,
          ]);
          await runtime.session.prompt("after loading deferred patch");
          await runtime.session.navigateTree(firstAssistant.id);
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            TOOL_DISCOVERY_TOOL,
            APPLY_PATCH_TOOL,
          ]);
          expect(fetch).not.toHaveBeenCalled();
        },
      );
    },
    HOST_BUDGET_MS,
  );

  it(
    "restores the admitted baseline after a tree replay of a filtered declaration",
    async () => {
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          { id: "ps", match: "*", patch: true, shell: true, code: false },
        ],
      };
      await withHost(
        { config, currentModel: otherModel() },
        async ({ runtime, configPath }) => {
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            APPLY_PATCH_TOOL,
            "exec_command",
            "write_stdin",
          ]);
          // Record a branch whose system declaration carries the filtered
          // tool list; the later all-false reload clears suppression.
          await runtime.session.prompt("record the filtered declaration");
          const firstAssistant = runtime.session.sessionManager
            .getBranch()
            .find(
              (entry) =>
                entry.type === "message" && entry.message.role === "assistant",
            );
          if (!firstAssistant) throw new Error("missing first assistant");
          config.execution = {
            version: 1,
            rules: [
              {
                id: "none",
                match: "*",
                patch: false,
                shell: false,
                code: false,
              },
            ],
          };
          await writeFile(configPath, JSON.stringify(config));
          await runtime.session.prompt("/pct reload");
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            "bash",
            "edit",
            "write",
          ]);
          // A newer branch point keeps the earlier declaration replayable.
          await runtime.session.prompt("after restoring the natives");
          await runtime.session.navigateTree(firstAssistant.id, {
            summarize: false,
          });
          // The replay re-asserted the filtered declaration; session_tree
          // reconciliation claims the dropped admitted baseline back and the
          // all-false rules restore it.
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            "bash",
            "edit",
            "write",
          ]);
        },
      );
    },
    HOST_BUDGET_MS,
  );

  it(
    "does not restore natives externally disabled before tree navigation",
    async () => {
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          {
            id: "none",
            match: "*",
            patch: false,
            shell: false,
            code: false,
          },
        ],
      };
      await withHost(
        { config, currentModel: otherModel() },
        async ({ runtime }) => {
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            "bash",
            "edit",
            "write",
          ]);
          runtime.session.setActiveToolsByName(["read"]);
          expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
          await runtime.session.prompt("/pct reload");
          expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
          await runtime.session.prompt("record the read-only declaration");
          const firstAssistant = runtime.session.sessionManager
            .getBranch()
            .find(
              (entry) =>
                entry.type === "message" && entry.message.role === "assistant",
            );
          if (!firstAssistant) throw new Error("missing first assistant");
          await runtime.session.prompt("later branch");
          await runtime.session.navigateTree(firstAssistant.id, {
            summarize: false,
          });
          expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
        },
      );
    },
    HOST_BUDGET_MS,
  );

  it(
    "restores re-enabled natives after tree replay of a filtered declaration",
    async () => {
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          {
            id: "none",
            match: "*",
            patch: false,
            shell: false,
            code: false,
          },
        ],
      };
      await withHost(
        { config, currentModel: otherModel() },
        async ({ runtime, configPath }) => {
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            "bash",
            "edit",
            "write",
          ]);
          runtime.session.setActiveToolsByName(["read"]);
          await runtime.session.prompt("/pct reload");
          expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
          runtime.session.setActiveToolsByName([
            "read",
            "bash",
            "edit",
            "write",
          ]);
          await runtime.session.prompt("/pct reload");
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            "bash",
            "edit",
            "write",
          ]);
          config.execution = {
            version: 1,
            rules: [
              { id: "ps", match: "*", patch: true, shell: true, code: false },
            ],
          };
          await writeFile(configPath, JSON.stringify(config));
          await runtime.session.prompt("/pct reload");
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            APPLY_PATCH_TOOL,
            "exec_command",
            "write_stdin",
          ]);
          await runtime.session.prompt("record the filtered declaration");
          const firstAssistant = runtime.session.sessionManager
            .getBranch()
            .find(
              (entry) =>
                entry.type === "message" && entry.message.role === "assistant",
            );
          if (!firstAssistant) throw new Error("missing first assistant");
          config.execution = {
            version: 1,
            rules: [
              {
                id: "none",
                match: "*",
                patch: false,
                shell: false,
                code: false,
              },
            ],
          };
          await writeFile(configPath, JSON.stringify(config));
          await runtime.session.prompt("/pct reload");
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            "bash",
            "edit",
            "write",
          ]);
          await runtime.session.prompt("after restoring the natives");
          await runtime.session.navigateTree(firstAssistant.id, {
            summarize: false,
          });
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            "bash",
            "edit",
            "write",
          ]);
        },
      );
    },
    HOST_BUDGET_MS,
  );

  it(
    "keeps a resumed host's fresh default-tool baseline instead of inheriting suppression",
    async () => {
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          { id: "ps", match: "*", patch: true, shell: true, code: false },
        ],
      };
      let defaultTools: string[] | undefined;
      await withHost(
        {
          config,
          currentModel: otherModel(),
          persist: true,
          defaultTools: () => defaultTools,
        },
        async ({ runtime, configPath }) => {
          // P+S suppresses the builtins and records the suppression under
          // this session file in the process-global stash.
          expect(runtime.session.getActiveToolNames()).toEqual([
            "read",
            APPLY_PATCH_TOOL,
            "exec_command",
            "write_stdin",
          ]);
          await runtime.session.prompt("persist a suppressed projection");
          const sessionFile = runtime.session.sessionManager.getSessionFile();
          if (!sessionFile) throw new Error("session was not persisted");

          // The next runtime starts with narrower defaults; both the new and
          // the resumed host keep their own admitted baseline.
          defaultTools = ["read"];
          config.execution = {
            version: 1,
            rules: [
              {
                id: "none",
                match: "*",
                patch: false,
                shell: false,
                code: false,
              },
            ],
          };
          await writeFile(configPath, JSON.stringify(config));
          const fresh = await runtime.newSession();
          expect(fresh.cancelled).toBe(false);
          expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
          const resumed = await runtime.switchSession(sessionFile);
          expect(resumed.cancelled).toBe(false);
          expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
        },
      );
    },
    HOST_BUDGET_MS,
  );

  it(
    "replays saved streamSimple options through onPayload for cache warming",
    async () => {
      await withHost(
        {
          config: remoteConfig(),
          currentModel: codexModel(),
          tools: ["read", APPLY_PATCH_TOOL],
          cacheWarming: "streaming",
          compactable: true,
          persist: true,
          allowCodexFetch: true,
        },
        async ({ runtime, models, requests, fetch }) => {
          await runtime.session.prompt("before remote compact");
          await runtime.session.prompt("second turn before compact");
          await runtime.session.compact();
          const details = newestRemoteCompaction(
            runtime.session.sessionManager.getBranch(),
          );
          if (!details) throw new Error("missing Remote checkpoint");
          expect(details.kind).toBe(REMOTE_COMPACTION_KIND);
          const kept = keptAssistant(runtime.session.sessionManager);
          requests.length = 0;
          fetch.mockClear();
          await runtime.session.prompt(POST_COMPACTION_INPUT);
          const first = requests.at(-1);
          if (!first) throw new Error("missing saved SDK request");
          expect(first.options?.onPayload).toEqual(expect.any(Function));
          expect(webSearchCount(first.transformed)).toBe(1);
          expectCheckpointThenTail(
            first.transformed,
            details,
            kept,
            POST_COMPACTION_INPUT,
          );
          const expectedPayload = structuredClone(
            responsePayload(first.transformed),
          );
          expect(
            expectedPayload.tools.map((tool) => tool.name).filter(Boolean),
          ).toEqual(["read", APPLY_PATCH_TOOL]);
          const beforeWarm = requests.length;
          const warmStream = models.streamSimple(first.model, first.context, {
            ...first.options,
            maxTokens: 1,
            maxRetries: 0,
          });
          for await (const _event of warmStream) {
            // Drain the modeled CacheWarmer.refresh streamSimple replay.
          }
          expect((await warmStream.result()).stopReason).toBe("stop");
          expect(requests.length).toBe(beforeWarm + 1);
          const warmed = requests.at(-1);
          if (!warmed) throw new Error("missing warm request");
          expect(responsePayload(warmed.transformed)).toEqual(expectedPayload);
          expectCheckpointThenTail(
            warmed.transformed,
            details,
            kept,
            POST_COMPACTION_INPUT,
          );
          expect(warmed.context).toBe(first.context);
          expect(warmed.options?.onPayload).toBe(first.options?.onPayload);
          expect(warmed.options?.maxTokens).toBe(1);
          expect(warmed.options?.maxRetries).toBe(0);

          // A real conversion must lose the transcript when its saved context is
          // lost; the callback alone cannot reconstruct checkpoint, tail or tools.
          const emptyStream = models.streamSimple(
            first.model,
            { messages: [] },
            {
              ...first.options,
              maxTokens: 1,
              maxRetries: 0,
            },
          );
          for await (const _event of emptyStream) {
            // Drain the explicit empty-context negative control.
          }
          expect((await emptyStream.result()).stopReason).toBe("stop");
          const empty = responsePayload(requests.at(-1)?.transformed);
          expect(empty.input).toEqual([]);
          expect(checkpointIds(requests.at(-1)?.transformed)).toEqual([]);
          expect(empty.tools.map((tool) => tool.type)).toEqual(["web_search"]);
          expect(empty).not.toEqual(expectedPayload);
          expect(fetch).not.toHaveBeenCalled();
        },
      );
    },
    HOST_BUDGET_MS,
  );

  it(
    "ends rejected onPayload producers with an error terminal and cleans up the host",
    async () => {
      const previous = process.env.PI_CODING_AGENT_DIR;
      const previousFetch = globalThis.fetch;
      let hostRoot: string | undefined;
      let disposed: ReturnType<typeof vi.spyOn> | undefined;
      const onPayload = vi.fn(async () => {
        throw new Error("payload callback rejected");
      });
      await withHost(
        {
          config: defaultConfig(),
          currentModel: codexModel(),
          tools: ["read"],
        },
        async ({ runtime, models, requests, fetch, root }) => {
          hostRoot = root;
          disposed = vi.spyOn(runtime, "dispose");
          const stream = models.streamSimple(
            codexModel(),
            {
              messages: [
                { role: "user", content: "rejection probe", timestamp: 0 },
              ],
            },
            { onPayload },
          );
          const events: AssistantMessageEvent[] = [];
          for await (const event of stream) events.push(event);
          expect(events).toEqual([
            {
              type: "error",
              reason: "error",
              error: expect.objectContaining({
                content: [],
                stopReason: "error",
                errorMessage: "payload callback rejected",
              }),
            },
          ]);
          expect(await stream.result()).toBe(
            events[0]?.type === "error" ? events[0].error : undefined,
          );
          expect(onPayload).toHaveBeenCalledTimes(1);
          expect(requests).toEqual([]);
          expect(fetch).not.toHaveBeenCalled();
        },
      );
      expect(disposed).toHaveBeenCalledTimes(1);
      expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
      expect(globalThis.fetch).toBe(previousFetch);
      if (!hostRoot) throw new Error("host did not allocate its root");
      await expect(stat(hostRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
    HOST_BUDGET_MS,
  );

  it.each([false, true])(
    "persists Remote compaction and replays checkpoint after open/fork (midConvo=%s)",
    async (supportsMidConvoSystemMessages) => {
      const config = remoteConfig();
      await withHost(
        {
          config,
          currentModel: codexModel({
            compat: { supportsMidConvoSystemMessages },
          }),
          tools: ["read", APPLY_PATCH_TOOL],
          compactable: true,
          persist: true,
          allowCodexFetch: true,
        },
        async ({ runtime, fetch, root, sessionDir, configPath }) => {
          await runtime.session.prompt("native history before remote compact");
          await runtime.session.prompt("more history");
          await runtime.session.compact();
          const first = newestRemoteCompaction(
            runtime.session.sessionManager.getBranch(),
          );
          if (!first) throw new Error("missing first Remote checkpoint");
          expect(first.kind).toBe(REMOTE_COMPACTION_KIND);
          await runtime.session.prompt(POST_COMPACTION_INPUT);
          await runtime.session.compact();
          const second = newestRemoteCompaction(
            runtime.session.sessionManager.getBranch(),
          );
          if (!second) throw new Error("missing second Remote checkpoint");
          const kept = keptAssistant(runtime.session.sessionManager);
          expect(second.checkpoint.id).not.toBe(first.checkpoint.id);
          expect(JSON.stringify(second)).not.toContain(first.checkpoint.id);
          const sessionFile = runtime.session.sessionManager.getSessionFile();
          if (!sessionFile)
            throw new Error("compacted session was not persisted");
          expect(fetch).toHaveBeenCalledTimes(2);
          config.applyPatch.enabled = false;
          await writeFile(configPath, JSON.stringify(config));
          // Snapshot both paths before the resumed host appends its new turn.
          const restored = [
            { mode: "open", manager: SessionManager.open(sessionFile) },
            {
              mode: "fork",
              manager: SessionManager.forkFrom(sessionFile, root, sessionDir),
            },
          ];
          for (const { mode, manager } of restored) {
            expect(keptAssistant(manager)).toEqual(kept);
            await withHost(
              {
                config,
                currentModel: codexModel({
                  compat: { supportsMidConvoSystemMessages },
                }),
                tools: ["read", APPLY_PATCH_TOOL],
                sessionManager: manager,
              },
              async ({ runtime: resumed, requests, fetch: resumedFetch }) => {
                expect(resumed.session.getActiveToolNames()).toEqual(["read"]);
                const userInput = `after ${mode}`;
                await resumed.session.prompt(userInput);
                const payload = requests.at(-1)?.transformed;
                expect(webSearchCount(payload)).toBe(1);
                expectCheckpointThenTail(payload, second, kept, userInput);
                expect(checkpointIds(payload)).toEqual([second.checkpoint.id]);
                expect(
                  JSON.stringify(responsePayload(payload).input),
                ).not.toContain(first.checkpoint.id);
                expect(
                  responsePayload(payload)
                    .tools.map((tool) => tool.name)
                    .filter(Boolean),
                ).toEqual(["read"]);
                expect(
                  JSON.stringify(responsePayload(payload).tools),
                ).not.toContain(APPLY_PATCH_TOOL);
                expect(
                  newestRemoteCompaction(
                    resumed.session.sessionManager.getBranch(),
                  ),
                ).toEqual(second);
                expect(resumedFetch).not.toHaveBeenCalled();
              },
            );
          }
        },
      );
    },
    HOST_BUDGET_MS,
  );

  it(
    "owns the tools an embedder's wrapper extension registers",
    async () => {
      // The documented embedder shape: another extension file default-exports
      // createPiCodexToolkit(...), so Pi attributes every Toolkit tool to that
      // file instead of src/index.ts.
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          { id: "pc", match: "*", patch: true, shell: false, code: true },
        ],
      };
      const toolkitEntry = fileURLToPath(
        new URL("../src/index.ts", import.meta.url),
      );
      const receiptExtension = fileURLToPath(
        new URL("./fixtures/child/diagnostics-receipt.ts", import.meta.url),
      );
      const wrapperRoot = await mkdtemp(join(tmpdir(), "pct-086-wrapper-"));
      const wrapperPath = join(wrapperRoot, "wrapper-extension.ts");
      const receiptPath = join(wrapperRoot, "diagnostics.jsonl");
      await writeFile(
        wrapperPath,
        `import { createPiCodexToolkit } from ${JSON.stringify(toolkitEntry)};\n\n` +
          `export default createPiCodexToolkit({\n` +
          `  invocationHooks: {\n` +
          `    policy: (call) => ({\n` +
          `      allow: false,\n` +
          `      reason: "wrapper hook saw " + call.tool + " " + call.path,\n` +
          `    }),\n` +
          `  },\n` +
          `});\n`,
        "utf8",
      );
      const previousReceipt = process.env.PCT_RECEIPT_FILE;
      process.env.PCT_RECEIPT_FILE = receiptPath;
      try {
        await withHost(
          {
            config,
            currentModel: otherModel(),
            extensionSources: () => [wrapperPath, receiptExtension],
          },
          async ({ runtime, root }) => {
            // Root cause: Pi reports the wrapper file for the Toolkit's own
            // registrations, so ownership cannot be compared against this
            // module's path.
            const projected = runtime.session
              .getAllTools()
              .find((tool) => tool.name === CODE_MODE_EXEC_TOOL);
            expect(projected?.sourceInfo.path).toBe(wrapperPath);

            // The routes take effect exactly as they do for a direct load.
            expect(runtime.session.getActiveToolNames()).toEqual([
              "read",
              CODE_MODE_EXEC_TOOL,
              CODE_MODE_WAIT_TOOL,
            ]);
            const receipt = await readFile(receiptPath, "utf8");
            const records = receipt
              .split("\n")
              .filter((line) => line.length > 0)
              .map(
                (line) =>
                  (
                    JSON.parse(line) as {
                      record: ExecutionDiagnosticsRecord;
                    }
                  ).record,
              );
            expect(records.at(-1)).toMatchObject({
              admittedNames: [
                APPLY_PATCH_TOOL,
                EXEC_COMMAND_TOOL,
                WRITE_STDIN_TOOL,
                CODE_MODE_EXEC_TOOL,
                CODE_MODE_WAIT_TOOL,
              ],
              visibleNames: [CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL],
              nestedNames: [
                APPLY_PATCH_TOOL,
                EXEC_COMMAND_TOOL,
                WRITE_STDIN_TOOL,
              ],
              hiddenNatives: ["bash", "edit", "write"],
              effective: { nestedPatch: true, code: true },
            });

            // The wrapper's own hook runs on the direct path: its denial
            // rejects the call before any command is dispatched.
            const execCommand =
              runtime.session.getToolDefinition(EXEC_COMMAND_TOOL);
            if (!execCommand) throw new Error("exec_command is not registered");
            await expect(
              execCommand.execute(
                "wrapper-direct-1",
                { command: "printf unexpected", yieldTimeMs: 0 },
                undefined,
                undefined,
                { cwd: root } as never,
              ),
            ).rejects.toThrow("wrapper hook saw exec_command direct");
          },
        );
      } finally {
        if (previousReceipt === undefined) delete process.env.PCT_RECEIPT_FILE;
        else process.env.PCT_RECEIPT_FILE = previousReceipt;
        await rm(wrapperRoot, { recursive: true, force: true });
      }
    },
    HOST_BUDGET_MS,
  );

  it(
    "claims no registration another factory in this process made",
    async () => {
      // Two SDK factories from one imported module: the first one registers
      // the winning Shell pair, and both read the same module-level parameter
      // schemas. The second must not read that registration as its own — it
      // owns nothing here, so it may not hide `bash`.
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          { id: "ps", match: "*", patch: true, shell: true, code: false },
        ],
      };
      const receiptExtension = fileURLToPath(
        new URL("./fixtures/child/diagnostics-receipt.ts", import.meta.url),
      );
      const receiptRoot = await mkdtemp(join(tmpdir(), "pct-086-factories-"));
      const receiptPath = join(receiptRoot, "diagnostics.jsonl");
      const previousReceipt = process.env.PCT_RECEIPT_FILE;
      process.env.PCT_RECEIPT_FILE = receiptPath;
      try {
        await withHost(
          {
            config,
            currentModel: otherModel(),
            // The whole Toolkit surface except this pair is filtered away, so
            // nothing else can resolve the second factory's identity.
            tools: ["read", "bash", EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL],
            expectToolNameConflicts: true,
            extensionSources: () => [receiptExtension],
            extensionFactories: [
              {
                name: "other-toolkit",
                // Pinned elsewhere on purpose: this factory owns nothing
                // either, so a retained `bash` can only mean the factory
                // under test declined the foreign pair.
                factory: createPiCodexToolkit({
                  sourcePath: "/pct-test/other-toolkit.ts",
                }),
              },
              { name: "toolkit", factory: createPiCodexToolkit() },
            ],
          },
          async ({ runtime }) => {
            // Pi's winner for the pair is the first factory's registration.
            const winner = runtime.session
              .getAllTools()
              .find((tool) => tool.name === EXEC_COMMAND_TOOL);
            expect(winner?.sourceInfo.path).toBe("<inline:other-toolkit>");

            // The replacement never activated, so the native shell stays.
            expect(runtime.session.getActiveToolNames()).toContain("bash");
            expect(new Set(runtime.session.getActiveToolNames())).toEqual(
              new Set(["read", "bash", EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL]),
            );

            const records = await diagnosticsRecords(receiptPath);
            expect(records).toHaveLength(2);
            for (const record of records) {
              expect(record).toMatchObject({
                requested: { patch: true, shell: true, code: false },
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
              });
            }
          },
        );
      } finally {
        if (previousReceipt === undefined) delete process.env.PCT_RECEIPT_FILE;
        else process.env.PCT_RECEIPT_FILE = previousReceipt;
        await rm(receiptRoot, { recursive: true, force: true });
      }
    },
    HOST_BUDGET_MS,
  );

  it(
    "leaves an unpinned wrapper that owns nothing claiming nothing",
    async () => {
      // The default Toolkit and an unpinned wrapper, each loaded from its own
      // file: distinct module instances that compute the same module path.
      // Only the winner may report Apply Patch as admitted.
      const config = defaultConfig();
      config.execution = {
        version: 1,
        rules: [
          { id: "p", match: "*", patch: true, shell: false, code: false },
        ],
      };
      const toolkitEntry = fileURLToPath(
        new URL("../src/index.ts", import.meta.url),
      );
      const receiptExtension = fileURLToPath(
        new URL("./fixtures/child/diagnostics-receipt.ts", import.meta.url),
      );
      const wrapperRoot = await mkdtemp(join(tmpdir(), "pct-086-unpinned-"));
      const wrapperPath = join(wrapperRoot, "wrapper-extension.ts");
      const receiptPath = join(wrapperRoot, "diagnostics.jsonl");
      await writeFile(
        wrapperPath,
        `import { createPiCodexToolkit } from ${JSON.stringify(toolkitEntry)};\n\n` +
          `export default createPiCodexToolkit();\n`,
        "utf8",
      );
      const previousReceipt = process.env.PCT_RECEIPT_FILE;
      process.env.PCT_RECEIPT_FILE = receiptPath;
      try {
        await withHost(
          {
            config,
            currentModel: otherModel(),
            tools: ["read", "edit", "write", APPLY_PATCH_TOOL],
            expectToolNameConflicts: true,
            extensionSources: () => [
              resolve("."),
              wrapperPath,
              receiptExtension,
            ],
          },
          async ({ runtime }) => {
            // The package extension registered first, so it wins the name.
            const winner = runtime.session
              .getAllTools()
              .find((tool) => tool.name === APPLY_PATCH_TOOL);
            expect(winner?.sourceInfo.path).toBe(toolkitEntry);
            expect(runtime.session.getActiveToolNames()).toEqual([
              "read",
              APPLY_PATCH_TOOL,
            ]);

            const records = await diagnosticsRecords(receiptPath);
            expect(records).toHaveLength(2);
            expect(
              records.filter(
                (record) => record.admittedNames.join(",") === APPLY_PATCH_TOOL,
              ),
            ).toHaveLength(1);
            expect(
              records.filter((record) => record.admittedNames.length === 0),
            ).toHaveLength(1);
            // Only the owner suppressed the builtins it replaced.
            expect(
              records.filter(
                (record) => record.hiddenNatives.join(",") === "edit,write",
              ),
            ).toHaveLength(1);
          },
        );
      } finally {
        if (previousReceipt === undefined) delete process.env.PCT_RECEIPT_FILE;
        else process.env.PCT_RECEIPT_FILE = previousReceipt;
        await rm(wrapperRoot, { recursive: true, force: true });
      }
    },
    HOST_BUDGET_MS,
  );
});
