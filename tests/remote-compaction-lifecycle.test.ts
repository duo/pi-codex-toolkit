import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import type {
  CompactionEntry,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../src/config.ts";
import { APPLY_PATCH_LARK_GRAMMAR } from "../src/apply-patch.ts";
import piCodexToolkit, {
  APPLY_PATCH_TOOL,
  WEB_SEARCH_TOOL,
} from "../src/index.ts";
import { REMOTE_COMPACTION_KIND } from "../src/openai/remote-compaction.ts";
import { codexModel, otherModel } from "./fixtures.ts";

const temporaryDirectories: string[] = [];
const codexProvider: Pick<Provider, "stream"> = {
  stream: openAICodexResponsesApi().stream,
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function jwt(accountId?: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": accountId
      ? { chatgpt_account_id: accountId }
      : {},
  })}.signature`;
}

function remoteResponse(id: string): Response {
  const events = [
    {
      type: "response.output_item.done",
      item: {
        type: "compaction",
        id,
        encrypted_content: `opaque-${id}`,
      },
    },
    { type: "response.completed", response: {} },
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function preparation(
  overrides: Partial<SessionBeforeCompactEvent["preparation"]> = {},
): SessionBeforeCompactEvent["preparation"] {
  return {
    firstKeptEntryId: "kept-entry",
    messagesToSummarize: [{ role: "user", content: "discarded", timestamp: 1 }],
    turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 2 }],
    isSplitTurn: true,
    tokensBefore: 32_000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 8_000 },
    ...overrides,
  };
}

function compactionEntry(
  result: NonNullable<
    Awaited<ReturnType<ExtensionHandler<SessionBeforeCompactEvent, unknown>>>
  >,
): CompactionEntry {
  const compaction = (result as { compaction: CompactionEntry }).compaction;
  return {
    ...compaction,
    type: "compaction",
    id: `entry-${Math.random()}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    fromHook: true,
  };
}

function registry(
  current: Model<any>,
  token = jwt("account-one"),
  provider: Pick<Provider, "stream"> | null = codexProvider,
) {
  return {
    find: (provider: string, id: string) =>
      provider === current.provider && id === current.id ? current : undefined,
    getAvailable: () => [current],
    getProvider: () => provider ?? undefined,
    isUsingOAuth: (candidate: Model<any>) =>
      candidate.provider === "openai-codex",
    getApiKeyAndHeaders: vi.fn(async () => ({
      ok: true as const,
      apiKey: token,
      baseUrl: current.baseUrl,
      headers: { "x-refreshed": "safe" },
    })),
  };
}

function captureProvider(
  payload: unknown,
  invokePayload = true,
): Pick<Provider, "stream"> {
  return {
    stream: ((currentModel, _context, options) => {
      const stream = createAssistantMessageEventStream();
      void Promise.resolve().then(async () => {
        if (invokePayload) {
          try {
            await options?.onPayload?.(payload, currentModel);
          } catch (error) {
            const message: AssistantMessage = {
              role: "assistant",
              content: [],
              api: currentModel.api,
              provider: currentModel.provider,
              model: currentModel.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "error",
              errorMessage:
                error instanceof Error ? error.message : String(error),
              timestamp: Date.now(),
            };
            stream.push({ type: "error", reason: "error", error: message });
          }
        }
        stream.end();
      });
      return stream;
    }) as Provider["stream"],
  };
}

function extensionHarness(branch: { entries: CompactionEntry[] }) {
  const handlers = new Map<string, ExtensionHandler<any, any>>();
  let activeTools = ["read"];
  const sourcePath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const tools: ToolInfo[] = [
    {
      name: WEB_SEARCH_TOOL,
      description: "Toolkit search",
      parameters: Type.Object({ query: Type.String() }),
      sourceInfo: {
        path: sourcePath,
        source: "test",
        scope: "user",
        origin: "package",
      },
    },
    {
      name: APPLY_PATCH_TOOL,
      description: "Apply a patch",
      parameters: Type.Object({ patch: Type.String() }),
      sourceInfo: {
        path: sourcePath,
        source: "test",
        scope: "user",
        origin: "package",
      },
    },
    {
      name: "read",
      description: "Read a file",
      parameters: Type.Object({ path: Type.String() }),
      sourceInfo: {
        path: "/pi/read.ts",
        source: "test",
        scope: "user",
        origin: "package",
      },
    },
  ];
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: (event: string, handler: ExtensionHandler<any, any>) => {
      handlers.set(event, handler);
    },
    getActiveTools: () => activeTools,
    getAllTools: () => tools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
  } as unknown as ExtensionAPI;
  piCodexToolkit(pi);
  return { handlers, getActiveTools: () => activeTools };
}

function context(
  current: Model<any>,
  modelRegistry: ReturnType<typeof registry>,
  branch: { entries: CompactionEntry[] },
): ExtensionContext {
  return {
    model: current,
    modelRegistry,
    sessionManager: { getBranch: () => branch.entries },
    getSystemPrompt: () => "system prompt",
  } as unknown as ExtensionContext;
}

async function configureAgent(
  update: (config: ReturnType<typeof defaultConfig>) => void,
): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pct-remote-lifecycle-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "extensions", "pi-codex-toolkit.json");
  const config = defaultConfig();
  update(config);
  await mkdir(join(directory, "extensions"), { recursive: true });
  await writeFile(path, JSON.stringify(config), "utf8");
  return { directory, path };
}

describe("Remote Compaction extension lifecycle", () => {
  it("preserves consecutive, reload/fork, model-switch, disable, and replay order", async () => {
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    const configured = await configureAgent((config) => {
      config.remoteCompaction.enabled = true;
      config.webSearch.enabled = true;
      config.webSearch.backend = "native";
      config.applyPatch.enabled = true;
    });
    process.env.PI_CODING_AGENT_DIR = configured.directory;

    try {
      const branch = { entries: [] as CompactionEntry[] };
      const harness = extensionHarness(branch);
      const current = codexModel({
        compat: { supportsOpenAIGrammarTools: true },
      });
      const currentRegistry = registry(current);
      const ctx = context(current, currentRegistry, branch);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(remoteResponse("cmp_first"))
        .mockResolvedValueOnce(remoteResponse("cmp_second"));

      await harness.handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" },
        ctx,
      );

      const firstResult = await harness.handlers.get(
        "session_before_compact",
      )?.(
        {
          type: "session_before_compact",
          preparation: preparation(),
          branchEntries: [],
          reason: "threshold",
          willRetry: false,
          signal: new AbortController().signal,
        },
        ctx,
      );
      const first = compactionEntry(firstResult);
      branch.entries = [first];
      expect(first.details).toMatchObject({
        kind: REMOTE_COMPACTION_KIND,
        checkpoint: { id: "cmp_first" },
      });
      const firstRequest = JSON.parse(
        String(fetchSpy.mock.calls[0]?.[1]?.body),
      ) as { tools: unknown[] };
      expect(firstRequest.tools).toContainEqual({
        type: "custom",
        name: APPLY_PATCH_TOOL,
        description: "Apply a patch",
        format: {
          type: "grammar",
          syntax: "lark",
          definition: APPLY_PATCH_LARK_GRAMMAR,
        },
      });

      const keptTail = {
        role: "user",
        content: [{ type: "input_text", text: "kept tail" }],
      };
      const firstPayload = {
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: first.summary }],
          },
          keptTail,
        ],
        tools: [],
      };
      const replayed = (await harness.handlers.get("before_provider_request")?.(
        { type: "before_provider_request", payload: firstPayload },
        ctx,
      )) as { input: Array<Record<string, unknown>>; tools: unknown[] };
      expect(replayed.input.at(-2)).toMatchObject({
        type: "compaction",
        id: "cmp_first",
      });
      expect(replayed.input.at(-1)).toBe(keptTail);
      expect(replayed.tools).toContainEqual(
        expect.objectContaining({ type: "web_search" }),
      );

      const secondResult = await harness.handlers.get(
        "session_before_compact",
      )?.(
        {
          type: "session_before_compact",
          preparation: preparation({ previousSummary: first.summary }),
          branchEntries: [first],
          reason: "threshold",
          willRetry: false,
          signal: new AbortController().signal,
        },
        ctx,
      );
      const second = compactionEntry(secondResult);
      branch.entries = [structuredClone(second)];
      expect(second.details).toMatchObject({
        checkpoint: { id: "cmp_second" },
      });
      expect(JSON.stringify(second.details)).not.toContain("cmp_first");
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const resumedPayload = {
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: second.summary }],
          },
          keptTail,
        ],
      };
      const resumed = (await harness.handlers.get("before_provider_request")?.(
        { type: "before_provider_request", payload: resumedPayload },
        ctx,
      )) as { input: Array<Record<string, unknown>> };
      expect(resumed.input.at(-2)).toMatchObject({ id: "cmp_second" });
      expect(resumed.input.at(-1)).toBe(keptTail);

      const away = otherModel();
      const awayPayload = structuredClone(resumedPayload);
      const awayResult = await harness.handlers.get(
        "before_provider_request",
      )?.(
        { type: "before_provider_request", payload: awayPayload },
        context(away, registry(away, "api-key"), branch),
      );
      expect(awayResult).toBeUndefined();
      expect(awayPayload.input[0]).toMatchObject({
        content: [{ text: expect.stringContaining(second.summary) }],
      });
      const backResult = (await harness.handlers.get(
        "before_provider_request",
      )?.(
        {
          type: "before_provider_request",
          payload: structuredClone(resumedPayload),
        },
        ctx,
      )) as { input: Array<Record<string, unknown>> };
      expect(backResult.input.at(-2)).toMatchObject({ id: "cmp_second" });

      const disabled = defaultConfig();
      disabled.webSearch.enabled = true;
      disabled.webSearch.backend = "native";
      await writeFile(configured.path, JSON.stringify(disabled), "utf8");
      await harness.handlers.get("session_start")?.(
        { type: "session_start", reason: "resume" },
        ctx,
      );
      const disabledPayload = structuredClone(resumedPayload);
      const disabledResult = (await harness.handlers.get(
        "before_provider_request",
      )?.(
        { type: "before_provider_request", payload: disabledPayload },
        ctx,
      )) as { input: unknown[]; tools: unknown[] };
      expect(disabledResult.input).toEqual(disabledPayload.input);
      expect(JSON.stringify(disabledResult.input)).not.toContain("cmp_second");
      expect(disabledResult.tools).toContainEqual(
        expect.objectContaining({ type: "web_search" }),
      );
      expect(
        await harness.handlers.get("session_before_compact")?.(
          {
            type: "session_before_compact",
            preparation: preparation(),
            branchEntries: branch.entries,
            reason: "manual",
            willRetry: false,
            signal: new AbortController().signal,
          },
          ctx,
        ),
      ).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      if (previousAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
      }
    }
  });

  it("delegates custom, unsupported, unresolved, missing-account, and remote failures", async () => {
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    const configured = await configureAgent((config) => {
      config.remoteCompaction.enabled = true;
    });
    process.env.PI_CODING_AGENT_DIR = configured.directory;

    try {
      const branch = { entries: [] as CompactionEntry[] };
      const harness = extensionHarness(branch);
      const current = codexModel();
      const baseRegistry = registry(current);
      const ctx = context(current, baseRegistry, branch);
      await harness.handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" },
        ctx,
      );
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("failed", { status: 500 }));
      const event = {
        type: "session_before_compact",
        preparation: preparation(),
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      } as const;

      expect(
        await harness.handlers.get("session_before_compact")?.(
          { ...event, customInstructions: "focus" },
          ctx,
        ),
      ).toBeUndefined();
      expect(
        await harness.handlers.get("session_before_compact")?.(
          event,
          context(otherModel(), registry(otherModel(), "key"), branch),
        ),
      ).toBeUndefined();
      expect(
        await harness.handlers.get("session_before_compact")?.(
          event,
          context(current, registry(current, jwt()), branch),
        ),
      ).toBeUndefined();

      const throwingRegistry = registry(current);
      throwingRegistry.getApiKeyAndHeaders.mockRejectedValueOnce(
        new Error("auth refresh failed"),
      );
      expect(
        await harness.handlers.get("session_before_compact")?.(
          event,
          context(current, throwingRegistry, branch),
        ),
      ).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(
        await harness.handlers.get("session_before_compact")?.(
          event,
          context(current, registry(current, jwt("account-one"), null), branch),
        ),
      ).toBeUndefined();
      expect(
        await harness.handlers.get("session_before_compact")?.(
          event,
          context(
            current,
            registry(
              current,
              jwt("account-one"),
              captureProvider(undefined, false),
            ),
            branch,
          ),
        ),
      ).toBeUndefined();
      expect(
        await harness.handlers.get("session_before_compact")?.(
          event,
          context(
            current,
            registry(
              current,
              jwt("account-one"),
              captureProvider({ input: "malformed" }),
            ),
            branch,
          ),
        ),
      ).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(
        await harness.handlers.get("session_before_compact")?.(
          {
            ...event,
            preparation: preparation({
              messagesToSummarize: [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "thinking",
                      thinking: "",
                      thinkingSignature: "invalid-converter-payload",
                    },
                  ],
                  api: current.api,
                  provider: current.provider,
                  model: current.id,
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      total: 0,
                    },
                  },
                  stopReason: "stop",
                  timestamp: 1,
                },
              ],
            }),
          },
          ctx,
        ),
      ).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(
        await harness.handlers.get("session_before_compact")?.(event, ctx),
      ).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      if (previousAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
      }
    }
  });
});
