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
import { EXEC_LARK_GRAMMAR } from "../src/code-mode/tools.ts";
import piCodexToolkit, {
  APPLY_PATCH_TOOL,
  WEB_SEARCH_TOOL,
} from "../src/index.ts";
import { REMOTE_COMPACTION_KIND } from "../src/openai/remote-compaction.ts";
import * as remoteCompaction from "../src/openai/remote-compaction.ts";
import { codexModel, otherModel } from "./fixtures.ts";
import { withEventBus } from "./fixtures/extension-events.ts";

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
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: the catch receives the Error the capture hook throws, and Pi 0.84.4 EventStream push()/end() do not throw; stream() must return synchronously
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

function extensionHarness(
  branch: { entries: CompactionEntry[] },
  options: { extraTools?: ToolInfo[]; active?: string[] } = {},
) {
  const handlers = new Map<string, ExtensionHandler<any, any>>();
  let activeTools = options.active ?? ["read"];
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
    ...(options.extraTools ?? []),
  ];
  // Pi 0.87 projects `definition.parameters` by reference, and that identity
  // is how a factory proves a registration is its own. Record what the factory
  // registers so an entry at this extension's path carries its schema object;
  // a foreign owner keeps the literal one written above.
  const registered = new Map<string, { parameters: unknown }>();
  const pi = {
    registerTool: (tool: { name: string; parameters: unknown }) => {
      registered.set(tool.name, tool);
    },
    registerCommand: () => undefined,
    on: (event: string, handler: ExtensionHandler<any, any>) => {
      handlers.set(event, handler);
    },
    getActiveTools: () => activeTools,
    getAllTools: () =>
      tools.map((tool) => {
        const own =
          tool.sourceInfo.path === sourcePath
            ? registered.get(tool.name)
            : undefined;
        return own ? { ...tool, parameters: own.parameters } : tool;
      }),
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
  } as unknown as ExtensionAPI;
  piCodexToolkit(withEventBus(pi));
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

describe("Provider hook exceptional resolution diagnostics", () => {
  it.each([
    [false, false, "auth"],
    [true, false, "auth"],
    [false, true, "auth"],
    [true, true, "auth"],
    [false, false, "identity"],
    [true, false, "identity"],
    [false, true, "identity"],
    [true, true, "identity"],
  ] as const)(
    "debug=%s priorRemote=%s failure=%s preserves fallback and refresh",
    async (debug, priorRemote, failure) => {
      const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
      const configured = await configureAgent((config) => {
        config.debug = debug;
        config.remoteCompaction.enabled = priorRemote;
        config.webSearch.enabled = !priorRemote;
        config.webSearch.backend = "native";
      });
      process.env.PI_CODING_AGENT_DIR = configured.directory;
      try {
        const current = codexModel();
        const token = jwt("PRIVATE_ACCOUNT");
        const identity = remoteCompaction.resolveRemoteCompactionIdentity({
          model: current,
          token,
          headers: {},
          route: {
            kind: "codex-oauth",
            endpoint: new URL(
              "https://chatgpt.com/backend-api/codex/responses",
            ),
          },
        })!;
        const marker = `[${REMOTE_COMPACTION_KIND}:test]`;
        const branch = {
          entries: (priorRemote
            ? [
                {
                  type: "compaction",
                  id: "prior",
                  parentId: null,
                  timestamp: new Date(0).toISOString(),
                  summary: marker + " PRIVATE_SUMMARY",
                  firstKeptEntryId: "kept",
                  tokensBefore: 100,
                  details: {
                    kind: REMOTE_COMPACTION_KIND,
                    version: 1,
                    marker,
                    retainedInput: [
                      { role: "user", content: "PRIVATE_RETAINED" },
                    ],
                    checkpoint: {
                      type: "compaction",
                      encrypted_content: "PRIVATE_CHECKPOINT",
                    },
                    compatibility: identity.compatibility,
                  },
                },
              ]
            : []) as CompactionEntry[],
        };
        const beforeBranch = structuredClone(branch.entries);
        const harness = extensionHarness(branch);
        const currentRegistry = registry(current, token);
        const ctx = context(current, currentRegistry, branch);
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockRejectedValue(new Error("unexpected transport"));
        const debugSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        await harness.handlers.get("session_start")?.(
          { type: "session_start", reason: "startup" },
          ctx,
        );
        debugSpy.mockClear();
        if (failure === "auth") {
          currentRegistry.getApiKeyAndHeaders.mockRejectedValueOnce(
            new Error(
              `PRIVATE_AUTH_ERROR ${token} PRIVATE_HEADER ${identity.compatibility.accountFingerprint}`,
            ),
          );
        } else {
          vi.spyOn(
            remoteCompaction,
            "resolveRemoteCompactionIdentity",
          ).mockImplementationOnce(() => {
            throw new Error(
              `PRIVATE_IDENTITY_ERROR ${token} PRIVATE_UI ${identity.compatibility.accountFingerprint}`,
            );
          });
        }
        const payload = {
          input: [{ role: "user", content: marker + " PRIVATE_SUMMARY" }],
          tools: [],
          unknown: { private: "PRIVATE_PAYLOAD" },
        };
        const beforePayload = structuredClone(payload);
        const hook = harness.handlers.get("before_provider_request")!;
        const result = await hook(
          { type: "before_provider_request", payload },
          ctx,
        );
        expect(result).toBeUndefined();
        expect(payload).toEqual(beforePayload);
        expect(branch.entries).toEqual(beforeBranch);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(currentRegistry.getApiKeyAndHeaders).toHaveBeenCalledOnce();
        expect(debugSpy).toHaveBeenCalledTimes(debug ? 1 : 0);
        if (debug) {
          expect(JSON.parse(debugSpy.mock.calls[0]![0] as string)).toEqual({
            feature: "provider-request",
            provider: current.provider,
            api: current.api,
            model: current.id,
            errorCategory: "route-resolution-failed",
          });
        }
        expect(JSON.stringify(debugSpy.mock.calls)).not.toContain("PRIVATE_");
        expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(token);
        expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(
          identity.compatibility.accountFingerprint,
        );
        // Failure is not cached: next applicable request refreshes again and transforms.
        const recovered = await hook(
          { type: "before_provider_request", payload },
          ctx,
        );
        expect(recovered).toBeDefined();
        if (priorRemote) {
          expect(recovered.input).toContainEqual({
            type: "compaction",
            encrypted_content: "PRIVATE_CHECKPOINT",
          });
        } else {
          expect(recovered.tools).toContainEqual(
            expect.objectContaining({ type: "web_search" }),
          );
        }
        expect(payload).toEqual(beforePayload);
        expect(branch.entries).toEqual(beforeBranch);
        expect(currentRegistry.getApiKeyAndHeaders).toHaveBeenCalledTimes(2);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalledTimes(debug ? 1 : 0);
      } finally {
        if (previousAgentDirectory === undefined)
          delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
      }
    },
  );
});

describe("owned exec grammar in the remote-compaction projection", () => {
  const sourcePath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const codeModeTools = (owner: string): ToolInfo[] =>
    ["exec", "wait"].map((name) => ({
      name,
      description: `Toolkit ${name}`,
      parameters:
        name === "exec"
          ? Type.Object({ code: Type.String() })
          : Type.Object({ cell_id: Type.Optional(Type.String()) }),
      sourceInfo: {
        path: owner,
        source: "test",
        scope: "user",
        origin: "package",
      },
    })) as ToolInfo[];

  /** One assistant turn whose exec call arrived as raw custom-tool input. */
  function execHistory(model: Model<any>): AssistantMessage[] {
    return [
      {
        role: "assistant",
        // A different model produced this turn, so the converter also takes
        // its cross-model identity path for the custom tool call.
        api: model.api,
        provider: model.provider,
        model: "gpt-5-previous",
        content: [
          {
            type: "toolCall",
            id: "call_exec_1|ctc_exec_1",
            name: "exec",
            arguments: { code: 'print("history");' },
          },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      } as unknown as AssistantMessage,
    ];
  }

  async function compactionRequest(
    owner: string,
    current: Model<any>,
    history: AssistantMessage[] = [],
  ): Promise<{ tools: unknown[]; input: unknown[] }> {
    const branch = { entries: [] as CompactionEntry[] };
    const harness = extensionHarness(branch, {
      extraTools: codeModeTools(owner),
      active: ["read", "exec", "wait"],
    });
    const currentRegistry = registry(current);
    const ctx = context(current, currentRegistry, branch);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(remoteResponse("cmp_exec"));
    await harness.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    // A model change recomputes the projection for the new model.
    await harness.handlers.get("model_select")?.(
      { type: "model_select", model: current, source: "user" },
      ctx,
    );
    await harness.handlers.get("session_before_compact")?.(
      {
        type: "session_before_compact",
        preparation: preparation(
          history.length > 0 ? { messagesToSummarize: history } : {},
        ),
        branchEntries: [],
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      },
      ctx,
    );
    return JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body)) as {
      tools: unknown[];
      input: unknown[];
    };
  }

  it("restores the exec grammar for the owned winner and never for a foreign one", async () => {
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    const configured = await configureAgent((config) => {
      config.remoteCompaction.enabled = true;
      config.codeMode.enabled = true;
      config.shellSessions.enabled = true;
    });
    process.env.PI_CODING_AGENT_DIR = configured.directory;
    try {
      const grammarModel = codexModel({
        compat: { supportsOpenAIGrammarTools: true },
      });
      const owned = await compactionRequest(sourcePath, grammarModel);
      expect(owned.tools).toContainEqual({
        type: "custom",
        name: "exec",
        description: "Toolkit exec",
        format: {
          type: "grammar",
          syntax: "lark",
          definition: EXEC_LARK_GRAMMAR,
        },
      });
      // `wait` stays an ordinary JSON tool; only exec carries the grammar.
      expect(owned.tools).toContainEqual(
        expect.objectContaining({ type: "function", name: "wait" }),
      );

      // Pi 0.87 omits constrainedSampling from getAllTools(), so a foreign
      // winner must not inherit the Toolkit's grammar.
      const foreign = await compactionRequest("/foreign-exec.ts", grammarModel);
      expect(foreign.tools).toContainEqual(
        expect.objectContaining({ type: "function", name: "exec" }),
      );
      expect(JSON.stringify(foreign.tools)).not.toContain("pragma_source");

      // A model without grammar support keeps the ordinary JSON transport.
      const jsonOnly = await compactionRequest(sourcePath, codexModel());
      expect(jsonOnly.tools).toContainEqual(
        expect.objectContaining({ type: "function", name: "exec" }),
      );

      // Raw custom-tool history survives the compaction projection and the
      // model change: the source stays the custom call's literal input.
      const replayed = await compactionRequest(
        sourcePath,
        grammarModel,
        execHistory(grammarModel),
      );
      expect(replayed.input).toContainEqual({
        type: "custom_tool_call",
        call_id: "call_exec_1",
        name: "exec",
        input: 'print("history");',
      });
      // Without the grammar the same history replays as a function call.
      const replayedAsJson = await compactionRequest(
        "/foreign-exec.ts",
        grammarModel,
        execHistory(grammarModel),
      );
      expect(replayedAsJson.input).toContainEqual(
        expect.objectContaining({
          type: "function_call",
          name: "exec",
          arguments: JSON.stringify({ code: 'print("history");' }),
        }),
      );
    } finally {
      if (previousAgentDirectory === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
  });
});

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
