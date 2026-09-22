import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAssistantMessageEventStream,
  type Model,
  type Provider,
  type Tool,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import type {
  CompactionEntry,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import {
  buildRemoteCompactionHeaders,
  buildRemoteCompactionSummary,
  captureRemoteCompactionPayload,
  createRemoteCompaction,
  emitRemoteCompactionDebug,
  isRemoteCompactionDetails,
  newestRemoteCompaction,
  parseRemoteCompactionResponse,
  REMOTE_COMPACTION_FALLBACK_LIMIT,
  REMOTE_COMPACTION_KIND,
  RemoteCompactionError,
  replayRemoteCompaction,
  resolveRemoteCompactionIdentity,
  selectRetainedInput,
  type RemoteCompactionCompatibility,
  type RemoteCompactionDetailsV1,
} from "../src/openai/remote-compaction.ts";
import {
  resolveOfficialRoute,
  type AuthenticatedOfficialRoute,
} from "../src/openai/route.ts";
import { codexModel, model } from "./fixtures.ts";

const codexProvider: Pick<Provider, "stream"> = {
  stream: openAICodexResponsesApi().stream,
};

function jwt(accountId: string, nonce = "one"): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    nonce,
  })}.signature`;
}

function route(
  overrides: {
    token?: string;
    model?: Model<any>;
    headers?: Record<string, string>;
  } = {},
): AuthenticatedOfficialRoute {
  return {
    model: overrides.model ?? codexModel(),
    route: {
      kind: "codex-oauth",
      endpoint: new URL("https://chatgpt.com/backend-api/codex/responses"),
    },
    token: overrides.token ?? jwt("account-123"),
    headers: overrides.headers ?? {},
  };
}

function preparation(
  overrides: Partial<SessionBeforeCompactEvent["preparation"]> = {},
): SessionBeforeCompactEvent["preparation"] {
  return {
    firstKeptEntryId: "kept-entry",
    messagesToSummarize: [
      { role: "user", content: "discarded user text", timestamp: 1 },
    ],
    turnPrefixMessages: [
      { role: "user", content: "split turn prefix", timestamp: 2 },
    ],
    isSplitTurn: true,
    tokensBefore: 42_000,
    fileOps: {
      read: new Set(["z-read.ts", "a-read.ts"]),
      written: new Set(["written.ts"]),
      edited: new Set(["edited.ts", "written.ts"]),
    },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 8_000 },
    ...overrides,
  };
}

function compatibility(
  overrides: Partial<RemoteCompactionCompatibility> = {},
): RemoteCompactionCompatibility {
  return {
    provider: "openai-codex",
    api: "openai-codex-responses",
    model: "gpt-5-codex",
    endpoint: "https://chatgpt.com/backend-api/codex/responses",
    authKind: "codex-oauth",
    accountFingerprint: `sha256:${createHash("sha256").update("account-123").digest("hex")}`,
    ...overrides,
  };
}

function details(
  overrides: Partial<RemoteCompactionDetailsV1> = {},
): RemoteCompactionDetailsV1 {
  return {
    kind: REMOTE_COMPACTION_KIND,
    version: 1,
    marker: `[${REMOTE_COMPACTION_KIND}:marker-one]`,
    retainedInput: [
      {
        role: "user",
        content: [{ type: "input_text", text: "retained" }],
      },
    ],
    checkpoint: {
      type: "compaction",
      id: "cmp_old",
      encrypted_content: "opaque-old",
    },
    compatibility: compatibility(),
    ...overrides,
  };
}

function compactionEntry(
  entryDetails: unknown,
  summary = `[${REMOTE_COMPACTION_KIND}:marker-one]\n\nreadable`,
  id = "compaction-one",
): CompactionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    summary,
    firstKeptEntryId: "kept-entry",
    tokensBefore: 10_000,
    details: entryDetails,
  };
}

function sseResponse(
  events: unknown[],
  init: ResponseInit = {},
  terminate = true,
): Response {
  const text = events
    .map((event) => `data: ${JSON.stringify(event)}`)
    .join("\n\n");
  return new Response(`${text}${terminate ? "\n\n" : ""}`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...init.headers },
    ...init,
  });
}

function successfulResponse(checkpointId = "cmp_new"): Response {
  return sseResponse(
    [
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          id: "message_1",
          status: "completed",
          role: "assistant",
          content: [],
        },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "compaction",
          id: checkpointId,
          encrypted_content: `opaque-${checkpointId}`,
        },
      },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: 10 },
            output_tokens_details: { reasoning_tokens: 5 },
          },
        },
      },
    ],
    { headers: { "x-request-id": "req-safe" } },
  );
}

async function expectCategory(
  promise: Promise<unknown>,
  category: RemoteCompactionError["category"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ category });
}

describe("Remote Compaction identity and durable shape", () => {
  it("derives a stable non-secret account fingerprint from refreshed OAuth", () => {
    const first = resolveRemoteCompactionIdentity(
      route({ token: jwt("account-123", "first") }),
    );
    const refreshed = resolveRemoteCompactionIdentity(
      route({ token: jwt("account-123", "second") }),
    );

    expect(first).toEqual(refreshed);
    expect(first?.accountId).toBe("account-123");
    expect(first?.compatibility.accountFingerprint).toBe(
      `sha256:${createHash("sha256").update("account-123").digest("hex")}`,
    );
    expect(JSON.stringify(first?.compatibility)).not.toContain("account-123");
    expect(JSON.stringify(first?.compatibility)).not.toContain("signature");
  });

  it("rejects missing claims, invalid tokens, API-key routes, and non-Codex APIs", () => {
    expect(
      resolveRemoteCompactionIdentity(route({ token: "not-a-jwt" })),
    ).toBeUndefined();
    expect(
      resolveRemoteCompactionIdentity(
        route({
          token: `${Buffer.from("{}").toString("base64url")}.${Buffer.from("{}").toString("base64url")}.sig`,
        }),
      ),
    ).toBeUndefined();
    expect(
      resolveRemoteCompactionIdentity({
        ...route({ model: model() }),
        route: {
          kind: "api-key",
          endpoint: new URL("https://api.openai.com/v1/responses"),
        },
      }),
    ).toBeUndefined();
  });

  it("validates only the versioned checkpoint contract and newest boundary", () => {
    const valid = details();
    expect(isRemoteCompactionDetails(valid)).toBe(true);
    expect(isRemoteCompactionDetails({ ...valid, version: 2 })).toBe(false);
    expect(
      isRemoteCompactionDetails({
        ...valid,
        checkpoint: { type: "message", content: "not opaque" },
      }),
    ).toBe(false);
    // A stored fingerprint is exactly "sha256:" plus 64 lowercase hex digits. A
    // digit short, uppercase, unprefixed and empty values are all malformed.
    const fingerprintHex = createHash("sha256")
      .update("account-123")
      .digest("hex");
    for (const accountFingerprint of [
      `sha256:${fingerprintHex.slice(1)}`,
      `sha256:${fingerprintHex.toUpperCase()}`,
      fingerprintHex,
      "",
    ]) {
      const malformed = details({
        compatibility: compatibility({ accountFingerprint }),
      });
      expect(isRemoteCompactionDetails(malformed)).toBe(false);
      expect(
        newestRemoteCompaction([compactionEntry(malformed)]),
      ).toBeUndefined();
    }

    const oldRemote = compactionEntry(valid);
    const native = compactionEntry(undefined, "native summary", "native-newer");
    expect(newestRemoteCompaction([oldRemote])).toEqual(valid);
    expect(newestRemoteCompaction([oldRemote, native])).toBeUndefined();
    expect(
      newestRemoteCompaction([
        compactionEntry(valid, "summary without the exact marker"),
      ]),
    ).toBeUndefined();
  });
});

describe("Remote Compaction fallback and retained input", () => {
  it("builds one bounded labelled transcript with sorted file operations", () => {
    const marker = `[${REMOTE_COMPACTION_KIND}:new-marker]`;
    const summary = buildRemoteCompactionSummary(
      marker,
      preparation({
        previousSummary: `[${REMOTE_COMPACTION_KIND}:old-marker]\n\nold readable fallback`,
        messagesToSummarize: [
          { role: "user", content: "x".repeat(20_000), timestamp: 1 },
        ],
      }),
    );

    expect(summary).toHaveLength(REMOTE_COMPACTION_FALLBACK_LIMIT);
    expect(summary.startsWith(marker)).toBe(true);
    expect(summary).toContain("transcript excerpt; not a semantic summary");
    expect(summary).toContain("old readable fallback");
    expect(summary).not.toContain("old-marker");
    expect(summary.indexOf("a-read.ts")).toBeLessThan(
      summary.indexOf("z-read.ts"),
    );
    expect(summary).toContain("[… transcript excerpt omitted …]");
  });

  it("keeps the newest contiguous provider-visible user window only", () => {
    const old = {
      role: "user",
      content: [{ type: "input_text", text: "old" }],
    };
    const assistant = { type: "message", role: "assistant", content: [] };
    const newest = {
      role: "user",
      content: [{ type: "input_text", text: "new" }],
    };
    expect(selectRetainedInput([old, assistant, newest])).toEqual([
      old,
      newest,
    ]);

    const tooLarge = {
      role: "user",
      content: [{ type: "input_text", text: "x".repeat(70_000) }],
    };
    expect(selectRetainedInput([old, tooLarge])).toEqual([]);
  });
});

describe("Remote Compaction request and response", () => {
  it("captures Pi 0.87 provider input and tools without transport", async () => {
    const currentRoute = route({ headers: { "x-refreshed": "safe" } });
    let providerFetch: ReturnType<typeof vi.fn> | undefined;
    const observingProvider = {
      stream: vi.fn((currentModel, context, options) => {
        expect(options?.apiKey).toBe(currentRoute.token);
        expect(options?.transport).toBe("sse");
        expect(options?.maxRetries).toBe(0);
        providerFetch = vi.fn(options?.fetch);
        return codexProvider.stream(currentModel, context, {
          ...options,
          fetch: providerFetch as unknown as typeof fetch,
        });
      }),
    } as unknown as Pick<Provider, "stream">;
    const tool: Tool = {
      name: "read",
      description: "Read a file",
      parameters: Type.Object({ path: Type.String() }),
    };

    const captured = await captureRemoteCompactionPayload({
      provider: observingProvider,
      route: currentRoute,
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      systemPrompt: "system",
      tools: [tool],
    });

    expect(captured?.input).toContainEqual(
      expect.objectContaining({ role: "user" }),
    );
    expect(captured?.tools).toEqual([
      expect.objectContaining({ type: "function", name: "read" }),
    ]);
    expect(observingProvider.stream).toHaveBeenCalledOnce();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("ignores saved native system state while capturing current tools", async () => {
    const currentRoute = route();
    const stale: Tool = {
      name: "stale_tool",
      description: "removed schema",
      parameters: Type.Object({ path: Type.String() }),
    };
    const current: Tool = {
      name: "read",
      description: "current schema",
      parameters: Type.Object({ path: Type.String() }),
    };
    const captured = await captureRemoteCompactionPayload({
      provider: codexProvider,
      route: currentRoute,
      messages: [
        {
          role: "system",
          content: "stale-native-prompt",
          toolsAdded: [stale],
          timestamp: 1,
        },
        { role: "user", content: "hello", timestamp: 2 },
      ],
      systemPrompt: "current-prompt",
      tools: [current],
    });

    expect(JSON.stringify(captured?.input)).toContain("hello");
    expect(JSON.stringify(captured?.input)).not.toContain(
      "stale-native-prompt",
    );
    expect(JSON.stringify(captured?.tools)).not.toContain("stale_tool");
    expect(captured?.tools).toEqual([
      expect.objectContaining({ type: "function", name: "read" }),
    ]);
  });

  it.each([
    {
      name: "an attempted provider transport",
      attemptTransport: true,
      extraEvent: false,
      providerFetches: 1,
    },
    {
      name: "an unexpected stream event",
      attemptTransport: false,
      extraEvent: true,
      providerFetches: 0,
    },
  ])(
    "falls back before Remote dispatch after $name",
    async ({ attemptTransport, extraEvent, providerFetches }) => {
      const currentRoute = route();
      let captureFetch: typeof fetch | undefined;
      const captureFetchSpy = vi.fn(
        (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
          if (!captureFetch) throw new Error("capture fetch missing");
          return captureFetch(...args);
        },
      );
      const provider = {
        stream: ((currentModel, context, options) => {
          captureFetch = options?.fetch;
          const wrappedOptions = {
            ...options,
            onPayload: async (payload, payloadModel) => {
              try {
                return await options?.onPayload?.(payload, payloadModel);
              } catch (error) {
                if (attemptTransport) {
                  await captureFetchSpy("https://capture.invalid");
                }
                throw error;
              }
            },
          } as typeof options;
          const inner = codexProvider.stream(
            currentModel,
            context,
            wrappedOptions,
          );
          if (!extraEvent) return inner;

          const outer = createAssistantMessageEventStream();
          // eslint-disable-next-line @typescript-eslint/no-floating-promises -- cannot reject: Pi 0.84.4 EventStream iteration, push() and end() do not throw; stream() must return outer synchronously
          void (async () => {
            for await (const event of inner) {
              if (event.type === "error") {
                outer.push({ type: "start", partial: event.error });
              }
              outer.push(event);
            }
            outer.end();
          })();
          return outer;
        }) as Provider["stream"],
      };
      const remoteFetch = vi.fn() as unknown as typeof fetch;

      const result = await createRemoteCompaction(
        {
          provider,
          route: currentRoute,
          identity: resolveRemoteCompactionIdentity(currentRoute)!,
          preparation: preparation(),
          branchEntries: [],
          systemPrompt: "system",
          tools: [],
        },
        remoteFetch,
      );

      expect(result).toBeUndefined();
      expect(captureFetchSpy).toHaveBeenCalledTimes(providerFetches);
      expect(remoteFetch).not.toHaveBeenCalled();
    },
  );

  it("applies nullable refreshed headers at the actual Remote dispatch boundary", async () => {
    const original = route({
      model: codexModel({
        headers: {
          "X-Optional": "old",
          "X-Replaced": "old",
          "X-Kept": "kept",
          "X-Codex-Beta-Features": "old_feature",
        },
      }),
    });
    const resolved = await resolveOfficialRoute(
      {
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: original.token,
          headers: {
            "x-optional": null,
            "x-replaced": "new",
            "X-Absent": null,
            Authorization: null,
            "ChatGPT-Account-ID": null,
            Originator: null,
            "OpenAI-Beta": null,
            Accept: null,
            "Content-Type": null,
            "x-codex-beta-features": null,
          },
        }),
        isUsingOAuth: () => true,
      },
      original.model,
    );
    if (!resolved.ok) throw new Error("test route unavailable");
    let emitted: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      emitted = new Headers(init?.headers);
      return successfulResponse();
    });
    const result = await createRemoteCompaction(
      {
        provider: codexProvider,
        route: resolved.value,
        identity: resolveRemoteCompactionIdentity(resolved.value)!,
        preparation: preparation(),
        branchEntries: [],
        systemPrompt: "system",
        tools: [],
      },
      fetchImpl,
    );
    expect(result).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(emitted?.has("X-Optional")).toBe(false);
    expect(emitted?.has("x-absent")).toBe(false);
    expect(emitted?.get("x-replaced")).toBe("new");
    expect(emitted?.get("x-kept")).toBe("kept");
    expect(emitted?.get("authorization")).toBe(`Bearer ${original.token}`);
    expect(emitted?.get("chatgpt-account-id")).toBe("account-123");
    expect(emitted?.get("originator")).toBe("pi");
    expect(emitted?.get("openai-beta")).toBe("responses=experimental");
    expect(emitted?.get("accept")).toBe("text/event-stream");
    expect(emitted?.get("content-type")).toBe("application/json");
    expect(emitted?.get("x-codex-beta-features")).toBe("remote_compaction_v2");
    emitted!.forEach((value) => expect(value).not.toBe("null"));
    expect(original.model.headers?.["X-Optional"]).toBe("old");
  });

  it("sends one minimal request, overrides stale headers, and returns Pi boundaries", async () => {
    const currentRoute = route({
      model: codexModel({
        headers: {
          authorization: "Bearer stale-model-token",
          "chatgpt-account-id": "stale-model-account",
          "x-codex-beta-features": "existing_feature",
        },
      }),
      headers: {
        authorization: "Bearer stale-auth-token",
        "chatgpt-account-id": "stale-auth-account",
      },
    });
    const identity = resolveRemoteCompactionIdentity(currentRoute)!;
    const fetchImpl = vi.fn(async () =>
      successfulResponse(),
    ) as unknown as typeof fetch;
    const ordinaryTool: Tool = {
      name: "read",
      description: "Read a file",
      parameters: Type.Object({ path: Type.String() }),
    };

    const result = await createRemoteCompaction(
      {
        provider: codexProvider,
        route: currentRoute,
        identity,
        preparation: preparation(),
        branchEntries: [],
        systemPrompt: "system-safe",
        tools: [ordinaryTool],
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("authorization")).toBe(`Bearer ${currentRoute.token}`);
    expect(headers.get("chatgpt-account-id")).toBe("account-123");
    expect(headers.get("originator")).toBe("pi");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    expect(headers.get("x-codex-beta-features")).toBe(
      "existing_feature,remote_compaction_v2",
    );

    const body = JSON.parse((init as RequestInit).body as string) as {
      input: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    expect(body).toMatchObject({
      model: "gpt-5-codex",
      store: false,
      stream: true,
      instructions: "system-safe",
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    expect(body.input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(
      body.input.filter((item) => item.type === "compaction_trigger"),
    ).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("kept-entry");
    expect(body.tools).toEqual([
      expect.objectContaining({ type: "function", name: "read" }),
    ]);

    expect(result).toMatchObject({
      firstKeptEntryId: "kept-entry",
      tokensBefore: 42_000,
      usage: { input: 90, output: 20, cacheRead: 10, totalTokens: 120 },
      details: {
        kind: REMOTE_COMPACTION_KIND,
        version: 1,
        checkpoint: { type: "compaction", id: "cmp_new" },
        compatibility: identity.compatibility,
      },
    });
    expect(result?.details?.retainedInput).toHaveLength(2);
    expect(JSON.stringify(result?.details)).not.toContain("compaction_trigger");
    expect(result?.details).not.toHaveProperty("usage");
  });

  it("includes a prior native summary in the request but not retained replay", async () => {
    const currentRoute = route();
    const native = compactionEntry(undefined, "native readable summary");
    const fetchImpl = vi.fn(async () =>
      successfulResponse(),
    ) as unknown as typeof fetch;
    const result = await createRemoteCompaction(
      {
        provider: codexProvider,
        route: currentRoute,
        identity: resolveRemoteCompactionIdentity(currentRoute)!,
        preparation: preparation({ previousSummary: native.summary }),
        branchEntries: [native],
        systemPrompt: "system",
        tools: [],
      },
      fetchImpl,
    );

    const body = JSON.parse(
      (
        (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
          .calls[0]![1] as RequestInit
      ).body as string,
    );
    expect(JSON.stringify(body.input)).toContain("native readable summary");
    expect(JSON.stringify(result?.details?.retainedInput)).not.toContain(
      "native readable summary",
    );
  });

  it("does not revive prompt or tools from a prior native systemMessage", async () => {
    const currentRoute = route();
    const native: CompactionEntry = {
      ...compactionEntry(undefined, "native readable summary"),
      systemMessage: {
        role: "system",
        content: "stale-native-prompt",
        toolsAdded: [
          {
            name: "stale_tool",
            description: "removed",
            parameters: Type.Object({ path: Type.String() }),
          },
        ],
        timestamp: 1,
      },
    };
    const fetchImpl = vi.fn(async () =>
      successfulResponse(),
    ) as unknown as typeof fetch;
    const ordinaryTool: Tool = {
      name: "read",
      description: "Read a file",
      parameters: Type.Object({ path: Type.String() }),
    };
    const result = await createRemoteCompaction(
      {
        provider: codexProvider,
        route: currentRoute,
        identity: resolveRemoteCompactionIdentity(currentRoute)!,
        preparation: preparation({ previousSummary: native.summary }),
        branchEntries: [native],
        systemPrompt: "current-prompt",
        tools: [ordinaryTool],
      },
      fetchImpl,
    );

    const body = JSON.parse(
      (
        (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
          .calls[0]![1] as RequestInit
      ).body as string,
    ) as {
      instructions?: string;
      input: unknown[];
      tools: unknown[];
    };
    expect(body.instructions).toBe("current-prompt");
    expect(JSON.stringify(body)).not.toContain("stale-native-prompt");
    expect(JSON.stringify(body)).not.toContain("stale_tool");
    expect(JSON.stringify(body.input)).toContain("native readable summary");
    expect(body.tools).toEqual([
      expect.objectContaining({ type: "function", name: "read" }),
    ]);
    expect(result?.firstKeptEntryId).toBe("kept-entry");
  });

  it("persists native systemMessage through SessionManager open/fork without reviving tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-remote-session-"));
    const sessionDir = join(root, "sessions");
    await mkdir(sessionDir);
    try {
      const manager = SessionManager.create(root, sessionDir);
      manager.appendMessage({
        role: "system",
        content: "stale-native-prompt",
        toolsAdded: [
          {
            name: "stale_tool",
            description: "removed",
            parameters: Type.Object({ path: Type.String() }),
          },
        ],
        timestamp: Date.now(),
      });
      const firstKeptEntryId = manager.appendMessage({
        role: "user",
        content: "hello",
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5-codex",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "user",
        content: "later",
        timestamp: Date.now(),
      });
      const compactId = manager.appendCompaction(
        "native readable summary",
        firstKeptEntryId,
        5_000,
      );
      const sessionFile = manager.getSessionFile();
      if (!sessionFile)
        throw new Error("SessionManager.create did not persist");
      const reopened = SessionManager.open(sessionFile);
      const native = reopened.getEntry(compactId) as CompactionEntry;
      expect(native.type).toBe("compaction");
      expect(
        native.systemMessage?.toolsAdded?.map((tool) => tool.name),
      ).toEqual(["stale_tool"]);
      const forked = SessionManager.forkFrom(sessionFile, root, sessionDir);
      const forkedNative = forked.getEntry(compactId) as CompactionEntry;
      expect(forkedNative.type).toBe("compaction");
      expect(forkedNative.firstKeptEntryId).toBe(firstKeptEntryId);

      const ordinaryTool: Tool = {
        name: "read",
        description: "Read a file",
        parameters: Type.Object({ path: Type.String() }),
      };
      for (const supportsMidConvoSystemMessages of [false, true]) {
        const currentRoute = route({
          model: codexModel({
            compat: { supportsMidConvoSystemMessages },
          }),
        });
        const fetchImpl = vi.fn(async () =>
          successfulResponse(),
        ) as unknown as typeof fetch;
        const result = await createRemoteCompaction(
          {
            provider: codexProvider,
            route: currentRoute,
            identity: resolveRemoteCompactionIdentity(currentRoute)!,
            preparation: preparation({
              previousSummary: native.summary,
              firstKeptEntryId,
            }),
            branchEntries: forked.getBranch(),
            systemPrompt: "current-prompt",
            tools: [ordinaryTool],
          },
          fetchImpl,
        );
        const body = JSON.parse(
          (
            (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
              .calls[0]![1] as RequestInit
          ).body as string,
        ) as { instructions?: string; input: unknown[]; tools: unknown[] };
        expect(body.instructions).toBe("current-prompt");
        expect(JSON.stringify(body)).not.toContain("stale-native-prompt");
        expect(JSON.stringify(body)).not.toContain("stale_tool");
        expect(JSON.stringify(body.input)).toContain("native readable summary");
        expect(body.tools).toEqual([
          expect.objectContaining({ type: "function", name: "read" }),
        ]);
        expect(result?.firstKeptEntryId).toBe(firstKeptEntryId);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("folds one prior compatible checkpoint and stores only the new one", async () => {
    const currentRoute = route();
    const prior = details();
    const priorEntry = compactionEntry(prior);
    const fetchImpl = vi.fn(async () =>
      successfulResponse("cmp_second"),
    ) as unknown as typeof fetch;
    const result = await createRemoteCompaction(
      {
        provider: codexProvider,
        route: currentRoute,
        identity: resolveRemoteCompactionIdentity(currentRoute)!,
        preparation: preparation({ previousSummary: priorEntry.summary }),
        branchEntries: [priorEntry],
        systemPrompt: "system",
        tools: [],
      },
      fetchImpl,
    );

    const body = JSON.parse(
      (
        (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
          .calls[0]![1] as RequestInit
      ).body as string,
    ) as { input: unknown[] };
    expect(body.input.slice(0, 2)).toEqual([
      ...prior.retainedInput,
      prior.checkpoint,
    ]);
    expect(result?.details?.checkpoint).toMatchObject({ id: "cmp_second" });
    expect(JSON.stringify(result?.details)).not.toContain("cmp_old");
    expect(JSON.stringify(result?.details)).not.toContain("opaque-old");
  });

  it("delegates incompatible or malformed prior checkpoints without dispatch", async () => {
    const currentRoute = route();
    const prior = details({
      compatibility: compatibility({ model: "another-codex-model" }),
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      createRemoteCompaction(
        {
          provider: codexProvider,
          route: currentRoute,
          identity: resolveRemoteCompactionIdentity(currentRoute)!,
          preparation: preparation({ previousSummary: "readable" }),
          branchEntries: [compactionEntry(prior)],
          systemPrompt: "system",
          tools: [],
        },
        fetchImpl,
      ),
    ).resolves.toBeUndefined();
    await expect(
      createRemoteCompaction(
        {
          provider: codexProvider,
          route: currentRoute,
          identity: resolveRemoteCompactionIdentity(currentRoute)!,
          preparation: preparation({ previousSummary: "readable" }),
          branchEntries: [
            compactionEntry(
              undefined,
              `[${REMOTE_COMPACTION_KIND}:missing-details]\n\nreadable`,
            ),
          ],
          systemPrompt: "system",
          tools: [],
        },
        fetchImpl,
      ),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts unrelated completed items and requires one completed checkpoint", async () => {
    const parsed = await parseRemoteCompactionResponse(
      successfulResponse(),
      codexModel(),
    );
    expect(parsed).toMatchObject({
      checkpoint: { type: "compaction", id: "cmp_new" },
      completedItems: 2,
      compactionItems: 1,
    });
  });

  it.each([
    [
      "explicit failure",
      sseResponse([{ type: "response.failed", response: {} }]),
      "incomplete-response",
    ],
    ["malformed JSON", new Response("data: {bad}\n\n"), "invalid-sse"],
    [
      "early EOF",
      sseResponse([
        {
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "opaque" },
        },
      ]),
      "incomplete-stream",
    ],
    [
      "zero checkpoints",
      sseResponse([{ type: "response.completed", response: {} }]),
      "checkpoint-count",
    ],
    [
      "incomplete checkpoint",
      sseResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "compaction",
            status: "incomplete",
            encrypted_content: "partial",
          },
        },
        { type: "response.completed", response: {} },
      ]),
      "checkpoint-count",
    ],
    [
      "multiple checkpoints",
      sseResponse([
        {
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "one" },
        },
        {
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "two" },
        },
        { type: "response.completed", response: {} },
      ]),
      "checkpoint-count",
    ],
  ] as const)("rejects %s", async (_name, response, category) => {
    await expectCategory(
      parseRemoteCompactionResponse(response, codexModel()),
      category,
    );
  });

  it("classifies HTTP, network, abort, and timeout without retry", async () => {
    const currentRoute = route();
    const base = {
      provider: codexProvider,
      route: currentRoute,
      identity: resolveRemoteCompactionIdentity(currentRoute)!,
      preparation: preparation(),
      branchEntries: [] as SessionEntry[],
      systemPrompt: "system",
      tools: [] as Tool[],
    };

    const httpFetch = vi.fn(
      async () => new Response("no", { status: 500 }),
    ) as unknown as typeof fetch;
    await expectCategory(createRemoteCompaction(base, httpFetch), "http-error");
    expect(httpFetch).toHaveBeenCalledOnce();

    const networkFetch = vi.fn(async () => {
      throw new Error("secret network payload");
    }) as unknown as typeof fetch;
    await expectCategory(
      createRemoteCompaction(base, networkFetch),
      "network-error",
    );
    expect(networkFetch).toHaveBeenCalledOnce();

    const caller = new AbortController();
    caller.abort();
    const abortFetch = vi.fn() as unknown as typeof fetch;
    await expectCategory(
      createRemoteCompaction({ ...base, signal: caller.signal }, abortFetch),
      "aborted",
    );
    expect(abortFetch).not.toHaveBeenCalled();

    const timeout = new AbortController();
    timeout.abort();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(timeout.signal);
    const timeoutFetch = vi.fn(async () => {
      throw new Error("timed out");
    }) as unknown as typeof fetch;
    await expectCategory(createRemoteCompaction(base, timeoutFetch), "timeout");
    expect(timeoutFetch).toHaveBeenCalledOnce();
    timeoutSpy.mockRestore();
  });

  it("classifies caller abort and internal timeout while reading the SSE body", async () => {
    const currentRoute = route();
    const base = {
      provider: codexProvider,
      route: currentRoute,
      identity: resolveRemoteCompactionIdentity(currentRoute)!,
      preparation: preparation(),
      branchEntries: [] as SessionEntry[],
      systemPrompt: "system",
      tools: [] as Tool[],
    };
    const pendingBody = (interrupt: () => void) => {
      let scheduled = false;
      return new Response(
        new ReadableStream({
          pull() {
            if (scheduled) return;
            scheduled = true;
            setTimeout(interrupt, 0);
          },
        }),
      );
    };

    const caller = new AbortController();
    const abortFetch = vi.fn(async () =>
      pendingBody(() => caller.abort()),
    ) as unknown as typeof fetch;
    await expectCategory(
      createRemoteCompaction({ ...base, signal: caller.signal }, abortFetch),
      "aborted",
    );
    expect(abortFetch).toHaveBeenCalledOnce();

    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(timeout.signal);
    const timeoutFetch = vi.fn(async () =>
      pendingBody(() => timeout.abort()),
    ) as unknown as typeof fetch;
    await expectCategory(createRemoteCompaction(base, timeoutFetch), "timeout");
    expect(timeoutFetch).toHaveBeenCalledOnce();
    timeoutSpy.mockRestore();
  });

  it("emits metadata-only debug output", async () => {
    const protectedRoute = route({
      token: jwt("raw-account-secret"),
      headers: {
        "x-secret-header": "header-secret",
      },
    });
    const debugOutput = vi.fn();
    await createRemoteCompaction(
      {
        provider: codexProvider,
        route: protectedRoute,
        identity: resolveRemoteCompactionIdentity(protectedRoute)!,
        preparation: preparation({
          messagesToSummarize: [
            { role: "user", content: "prompt-secret", timestamp: 1 },
          ],
        }),
        branchEntries: [],
        systemPrompt: "system-secret",
        tools: [],
        debug: true,
      },
      vi.fn(async () => successfulResponse()) as unknown as typeof fetch,
      debugOutput,
    );

    const output = debugOutput.mock.calls.flat().join("\n");
    expect(output).toContain('"outcome":"remote-success"');
    for (const protectedText of [
      "raw-account-secret",
      "header-secret",
      "prompt-secret",
      "system-secret",
      "opaque-cmp_new",
      "sha256:",
    ]) {
      expect(output).not.toContain(protectedText);
    }

    const untrustedDebugRecord = {
      outcome: "native-fallback" as const,
      reason: "safe",
      protectedPayload: "direct-debug-secret",
    };
    emitRemoteCompactionDebug(untrustedDebugRecord, debugOutput);
    expect(debugOutput.mock.calls.flat().join("\n")).not.toContain(
      "direct-debug-secret",
    );
  });
});

describe("Remote Compaction replay", () => {
  it("replaces exactly one marked summary before the kept tail", () => {
    const checkpoint = details();
    const summary = {
      role: "user",
      content: [
        {
          type: "input_text",
          text: `Pi wrapper ${checkpoint.marker}\nreadable fallback`,
        },
      ],
    };
    const keptTail = {
      role: "user",
      content: [{ type: "input_text", text: "kept tail" }],
    };
    const payload = { input: [summary, keptTail], unknown: { keep: true } };
    const replayed = replayRemoteCompaction(
      payload,
      checkpoint,
      checkpoint.compatibility,
    ) as { input: unknown[] };

    expect(replayed).not.toBe(payload);
    expect(replayed.input).toEqual([
      ...checkpoint.retainedInput,
      checkpoint.checkpoint,
      keptTail,
    ]);
    expect(replayed).toMatchObject({ unknown: { keep: true } });
    expect(
      replayRemoteCompaction(replayed, checkpoint, checkpoint.compatibility),
    ).toBe(replayed);
  });

  it("leaves disabled, malformed, mismatched, absent, and duplicate markers unchanged", () => {
    const checkpoint = details();
    const marked = {
      role: "user",
      content: [{ type: "input_text", text: checkpoint.marker }],
    };
    const payload = { input: [marked] };

    expect(replayRemoteCompaction(payload, undefined, undefined)).toBe(payload);
    for (const mismatched of [
      compatibility({ model: "another-codex-model" }),
      compatibility({ endpoint: "https://chatgpt.com/backend-api/responses" }),
      compatibility({ accountFingerprint: `sha256:${"0".repeat(64)}` }),
    ]) {
      expect(replayRemoteCompaction(payload, checkpoint, mismatched)).toBe(
        payload,
      );
    }
    expect(
      replayRemoteCompaction(
        { input: [] },
        checkpoint,
        checkpoint.compatibility,
      ),
    ).toEqual({ input: [] });
    const duplicated = { input: [marked, marked] };
    expect(
      replayRemoteCompaction(duplicated, checkpoint, checkpoint.compatibility),
    ).toBe(duplicated);
    expect(
      replayRemoteCompaction("bad", checkpoint, checkpoint.compatibility),
    ).toBe("bad");
  });

  it("builds authoritative request headers without mutating source records", () => {
    const currentRoute = route({
      headers: { "x-codex-beta-features": "a, remote_compaction_v2" },
    });
    const before = structuredClone(currentRoute.headers);
    const headers = buildRemoteCompactionHeaders({
      route: currentRoute,
      accountId: "account-123",
    });
    expect(headers.get("x-codex-beta-features")).toBe("a,remote_compaction_v2");
    expect(currentRoute.headers).toEqual(before);
  });
});
