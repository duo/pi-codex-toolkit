import { afterEach, describe, expect, it, vi } from "vitest";
import { zstdDecompressSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type {
  Model,
  OpenAICodexResponsesOptions,
  Provider,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";

import {
  resolveOfficialRoute,
  type AuthenticatedOfficialRoute,
} from "../src/openai/route.ts";
import {
  buildSidecarRequest,
  dispatchSidecarSearch,
  parseSidecarResponse,
  SidecarSearchError,
} from "../src/openai/sidecar-search.ts";
import { codexModel, model } from "./fixtures.ts";
import { outerBudget } from "./fixtures/budgets.ts";

const codexProvider: Pick<Provider, "stream"> = {
  stream: openAICodexResponsesApi().stream,
};

function observingCodexProvider(): {
  provider: Pick<Provider, "stream">;
  reasoningEffort: () => unknown;
} {
  let reasoningEffort: unknown;
  return {
    provider: {
      stream: (currentModel, context, streamOptions) => {
        reasoningEffort =
          streamOptions && "reasoningEffort" in streamOptions
            ? streamOptions.reasoningEffort
            : undefined;
        return codexProvider.stream(currentModel, context, streamOptions);
      },
    },
    reasoningEffort: () => reasoningEffort,
  };
}

function route(): AuthenticatedOfficialRoute {
  return {
    model: model(),
    route: {
      kind: "api-key",
      endpoint: new URL("https://api.openai.com/v1/responses"),
    },
    token: "test-key",
    headers: { "x-client": "test" },
  };
}

function jwt(accountId: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

function codexRoute(
  modelOverrides: Partial<Model<any>> = {},
): AuthenticatedOfficialRoute {
  return {
    model: codexModel({
      id: "gpt-5.4",
      thinkingLevelMap: { minimal: "low", xhigh: null, max: null },
      ...modelOverrides,
    }),
    route: {
      kind: "codex-oauth",
      endpoint: new URL("https://chatgpt.com/backend-api/codex/responses"),
    },
    token: jwt("account-test"),
    headers: { "x-refreshed": "safe" },
  };
}

function sseResponse(events: unknown[], init: ResponseInit = {}): Response {
  return new Response(
    `${events
      .map((event) => `data: ${JSON.stringify(event)}`)
      .join("\n\n")}\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream", ...init.headers },
      ...init,
    },
  );
}

function successfulCodexResponse(): Response {
  return sseResponse(
    [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "web_search_call",
          id: "search_1",
          status: "completed",
          action: {
            sources: [
              { title: "Codex source", url: "https://codex.example/source" },
            ],
          },
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "message",
          id: "message_1",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Codex answer" }],
        },
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 12,
            output_tokens: 4,
            total_tokens: 16,
          },
        },
      },
    ],
    { headers: { "x-request-id": "req_codex" } },
  );
}

function requestJson(init: RequestInit): Record<string, unknown> {
  const bytes =
    typeof init.body === "string"
      ? Buffer.from(init.body)
      : Buffer.from(init.body as Uint8Array);
  const decoded =
    new Headers(init.headers).get("content-encoding") === "zstd"
      ? zstdDecompressSync(bytes)
      : bytes;
  return JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
}

function completedResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_test",
    status: "completed",
    output: [
      {
        type: "web_search_call",
        action: {
          sources: [{ title: "Example", url: "https://example.com/page" }],
        },
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "Answer" }],
      },
    ],
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...init.headers },
      ...init,
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Sidecar request shape", () => {
  it("sends only the verbatim query and fixed hosted-search settings", () => {
    const query = "verbatim query with conversation-derived details";
    expect(
      buildSidecarRequest(query, model(), {
        mode: "cached",
        contextSize: "high",
      }),
    ).toEqual({
      model: "gpt-5",
      input: query,
      tools: [
        {
          type: "web_search",
          search_context_size: "high",
          external_web_access: false,
        },
      ],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      store: false,
    });
  });

  it("dispatches exactly once with official credentials", async () => {
    const fetchMock = vi.fn(() =>
      jsonResponse(completedResponse(), {
        headers: { "x-request-id": "req_test" },
      }),
    );
    const result = await dispatchSidecarSearch(
      {
        query: "exact query",
        config: { mode: "live", contextSize: "medium" },
        route: route(),
        thinkingLevel: "auto",
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.href).toBe("https://api.openai.com/v1/responses");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      input: "exact query",
      store: false,
    });
    expect(result.text).toContain("[Example](https://example.com/page)");
  });
});

describe("Sidecar nullable auth headers", () => {
  it.each(["api-key", "codex-oauth"] as const)(
    "preserves deletion instructions through the %s wire boundary",
    async (kind) => {
      const original = kind === "api-key" ? route() : codexRoute();
      original.model.headers = {
        "X-Optional": "old",
        "X-Replaced": "old",
        "X-Model-Only": "kept-only-for-codex",
      };
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
              "Content-Type": null,
              ...(kind === "codex-oauth"
                ? {
                    "ChatGPT-Account-ID": null,
                    Originator: null,
                    "OpenAI-Beta": null,
                    Accept: null,
                  }
                : {}),
            },
          }),
          isUsingOAuth: () => kind === "codex-oauth",
        },
        original.model,
      );
      if (!resolved.ok) throw new Error("test route unavailable");
      let emitted: Headers | undefined;
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        emitted = new Headers(init?.headers);
        return kind === "api-key"
          ? jsonResponse(completedResponse())
          : successfulCodexResponse();
      });
      await dispatchSidecarSearch(
        {
          query: "query",
          config: { mode: "live", contextSize: "medium" },
          route: resolved.value,
          thinkingLevel: "auto",
          provider: codexProvider,
        },
        fetchMock,
      );
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(emitted?.has("X-Optional")).toBe(false);
      expect(emitted?.has("x-absent")).toBe(false);
      expect(emitted?.get("x-replaced")).toBe("new");
      expect(emitted?.get("x-model-only")).toBe(
        kind === "codex-oauth" ? "kept-only-for-codex" : null,
      );
      expect(emitted?.get("authorization")).toBe(`Bearer ${original.token}`);
      expect(emitted?.get("content-type")).toBe("application/json");
      if (kind === "codex-oauth") {
        expect(emitted?.get("chatgpt-account-id")).toBe("account-test");
        expect(emitted?.get("originator")).toBe("pi");
        expect(emitted?.get("openai-beta")).toBe("responses=experimental");
        expect(emitted?.get("accept")).toBe("text/event-stream");
      }
      emitted!.forEach((value) => expect(value).not.toBe("null"));
      expect(original.model.headers["X-Optional"]).toBe("old");
    },
  );
});

describe("Codex clone-body ownership", () => {
  // Each case is a fresh Node process that loads the TypeScript compiler to
  // transpile the Sidecar sources before it can run.
  const PROBE_TIMEOUT_MS = 40_000;

  it.each([
    "delayed-done",
    "delayed-throw",
    "iterator-first",
    "aborted",
    "timeout",
  ])(
    "owns a real rejected clone body with %s under strict Node rejection policy",
    async (scenario) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          "--unhandled-rejections=strict",
          fileURLToPath(
            new URL("./fixtures/sidecar-clone-rejection.mjs", import.meta.url),
          ),
          scenario,
        ],
        {
          timeout: PROBE_TIMEOUT_MS,
          env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
        },
      );
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({
        scenario,
        category:
          scenario === "aborted" || scenario === "timeout"
            ? scenario
            : "network-error",
        fetches: 1,
        settlements: 1,
        bodyFailed: true,
      });
    },
    outerBudget(PROBE_TIMEOUT_MS),
  );
});

describe("Codex OAuth Sidecar transport", () => {
  it("uses Pi's Codex provider once with query-only hosted Search and mapped effort", async () => {
    const fetchMock = vi.fn(async () => successfulCodexResponse());

    const result = await dispatchSidecarSearch(
      {
        query: "exact OAuth query",
        config: { mode: "cached", contextSize: "high" },
        route: codexRoute(),
        thinkingLevel: "minimal",
        provider: codexProvider,
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new URL(url).href).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${codexRoute().token}`);
    expect(headers.get("chatgpt-account-id")).toBe("account-test");
    expect(headers.get("originator")).toBe("pi");
    expect(headers.get("x-refreshed")).toBe("safe");
    const body = requestJson(init);
    expect(body).toMatchObject({
      model: "gpt-5.4",
      store: false,
      stream: true,
      instructions:
        "Search the web for the user's query and answer accurately and concisely.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "exact OAuth query" }],
        },
      ],
      tools: [
        {
          type: "web_search",
          search_context_size: "high",
          external_web_access: false,
        },
      ],
      tool_choice: "required",
      reasoning: { effort: "low", summary: "auto" },
    });
    expect(body.include).toEqual([
      "reasoning.encrypted_content",
      "web_search_call.action.sources",
    ]);
    expect(JSON.stringify(body)).not.toContain("conversation history");
    expect(result).toMatchObject({
      answer: "Codex answer",
      sources: [{ title: "Codex source", url: "https://codex.example/source" }],
      usage: { input: 12, output: 4, totalTokens: 16 },
    });
  });

  it.each([
    {
      name: "auto",
      level: "auto" as const,
      option: undefined,
      wire: "none",
    },
    {
      name: "off",
      level: "off" as const,
      option: "none" as const,
      wire: "none",
    },
    {
      name: "low",
      level: "low" as const,
      option: "low" as const,
      wire: "low",
    },
  ])(
    "maps executor effort $name independently",
    async ({ level, option, wire }) => {
      let body: Record<string, unknown> | undefined;
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        body = requestJson(init);
        return successfulCodexResponse();
      });
      const observed = observingCodexProvider();

      await dispatchSidecarSearch(
        {
          query: "effort query",
          config: { mode: "live", contextSize: "medium" },
          route: codexRoute(),
          thinkingLevel: level,
          provider: observed.provider,
        },
        fetchMock as unknown as typeof fetch,
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(observed.reasoningEffort()).toBe(option);
      expect(
        (body?.reasoning as Record<string, unknown> | undefined)?.effort,
      ).toBe(wire);
    },
  );

  it("keeps auto as no Toolkit override when Off is unsupported", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      body = requestJson(init);
      return successfulCodexResponse();
    });
    const observed = observingCodexProvider();

    await dispatchSidecarSearch(
      {
        query: "effort query",
        config: { mode: "live", contextSize: "medium" },
        route: codexRoute({
          thinkingLevelMap: {
            off: null,
            minimal: "low",
            xhigh: null,
            max: null,
          },
        }),
        thinkingLevel: "auto",
        provider: observed.provider,
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(observed.reasoningEffort()).toBeUndefined();
    expect(body?.reasoning).toBeUndefined();
  });

  it("does not force a Toolkit effort when Off maps to a non-default value", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      body = requestJson(init);
      return successfulCodexResponse();
    });
    const observed = observingCodexProvider();

    await dispatchSidecarSearch(
      {
        query: "effort query",
        config: { mode: "live", contextSize: "medium" },
        route: codexRoute({
          thinkingLevelMap: {
            off: "low",
            minimal: "low",
            xhigh: null,
            max: null,
          },
        }),
        thinkingLevel: "auto",
        provider: observed.provider,
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(observed.reasoningEffort()).toBeUndefined();
    expect(
      (body?.reasoning as Record<string, unknown> | undefined)?.effort,
    ).toBe("low");
  });

  it("rejects a missing provider or stale effort before dispatch", async () => {
    const fetchMock = vi.fn();
    await expect(
      dispatchSidecarSearch(
        {
          query: "query",
          config: { mode: "live", contextSize: "medium" },
          route: codexRoute(),
          thinkingLevel: "low",
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ category: "provider-unavailable" });
    await expect(
      dispatchSidecarSearch(
        {
          query: "query",
          config: { mode: "live", contextSize: "medium" },
          route: codexRoute(),
          thinkingLevel: "xhigh",
          provider: codexProvider,
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ category: "unsupported-sidecar-effort" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a provider's second fetch before another request is sent", async () => {
    let providerFetchAttempts = 0;
    const duplicateFetchProvider: Pick<Provider, "stream"> = {
      stream(model, context, options) {
        const codexOptions = options as OpenAICodexResponsesOptions;
        const delegateFetch = codexOptions.fetch;
        if (!delegateFetch) throw new Error("missing test fetch");
        return openAICodexResponsesApi().stream(model, context, {
          ...codexOptions,
          fetch: async (url, init) => {
            providerFetchAttempts += 1;
            const response = await delegateFetch(url, init);
            providerFetchAttempts += 1;
            await delegateFetch(url, init);
            return response;
          },
        });
      },
    };
    const fetchMock = vi.fn(async () => successfulCodexResponse());

    await expect(
      dispatchSidecarSearch(
        {
          query: "query",
          config: { mode: "live", contextSize: "medium" },
          route: codexRoute(),
          thinkingLevel: "low",
          provider: duplicateFetchProvider,
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ category: "incomplete-response" });
    expect(providerFetchAttempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed SSE", new Response("data: {bad}\n\n"), "invalid-json"],
    [
      "raw error",
      sseResponse([{ type: "error", message: "private" }]),
      "incomplete-response",
    ],
    [
      "failed terminal",
      sseResponse([{ type: "response.failed", response: {} }]),
      "incomplete-response",
    ],
    [
      "early EOF",
      sseResponse([
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "web_search_call", action: { sources: [] } },
        },
      ]),
      "incomplete-response",
    ],
    [
      "item after terminal",
      sseResponse([
        {
          type: "response.completed",
          response: { status: "completed" },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "web_search_call", action: { sources: [] } },
        },
      ]),
      "incomplete-response",
    ],
    [
      "missing Search call",
      sseResponse([
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: "message_1",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "No search" }],
          },
        },
        {
          type: "response.completed",
          response: { status: "completed" },
        },
      ]),
      "missing-search-call",
    ],
    [
      "missing answer",
      sseResponse([
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "web_search_call", action: { sources: [] } },
        },
        {
          type: "response.completed",
          response: { status: "completed" },
        },
      ]),
      "missing-answer",
    ],
  ] as const)("fails once for %s", async (_name, response, category) => {
    const fetchMock = vi.fn(async () => response.clone());
    await expect(
      dispatchSidecarSearch(
        {
          query: "query",
          config: { mode: "live", contextSize: "medium" },
          route: codexRoute(),
          thinkingLevel: "low",
          provider: codexProvider,
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ category });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("classifies one Codex HTTP failure without retry", async () => {
    const fetchMock = vi.fn(
      async () => new Response("failed", { status: 500 }),
    );
    await expect(
      dispatchSidecarSearch(
        {
          query: "query",
          config: { mode: "live", contextSize: "medium" },
          route: codexRoute(),
          thinkingLevel: "low",
          provider: codexProvider,
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ category: "http-error" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["aborted", "timeout"] as const)(
    "classifies one Codex %s without retry",
    async (category) => {
      const caller = new AbortController();
      const timeout = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      const fetchMock = vi.fn(async () => {
        if (category === "aborted") caller.abort();
        else timeout.abort();
        throw new DOMException(category, "AbortError");
      });

      await expect(
        dispatchSidecarSearch(
          {
            query: "query",
            config: { mode: "live", contextSize: "medium" },
            route: codexRoute(),
            thinkingLevel: "low",
            provider: codexProvider,
            ...(category === "aborted" ? { signal: caller.signal } : {}),
          },
          fetchMock as unknown as typeof fetch,
        ),
      ).rejects.toMatchObject({ category });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("keeps Codex raw transport data out of debug output", async () => {
    const currentRoute = codexRoute();
    currentRoute.token =
      "e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiU0VDUkVUX0FDQ09VTlQifX0.signature";
    const debugOutput = vi.fn();
    const fetchMock = vi.fn(async () => successfulCodexResponse());

    await dispatchSidecarSearch(
      {
        query: "SECRET_QUERY",
        config: { mode: "live", contextSize: "medium" },
        route: currentRoute,
        thinkingLevel: "low",
        provider: codexProvider,
        debug: true,
      },
      fetchMock as unknown as typeof fetch,
      debugOutput,
    );

    const output = debugOutput.mock.calls.flat().join("\n");
    expect(output).toContain("web-search-sidecar");
    for (const secret of [
      "SECRET_QUERY",
      "SECRET_ACCOUNT",
      "Codex answer",
      "Codex source",
      "codex.example",
      currentRoute.token,
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});

describe("Sidecar response parsing", () => {
  it("handles arbitrary item order, multiple calls/messages, stable deduplication, source cap, and usage", () => {
    const actionSources = Array.from({ length: 22 }, (_, index) => ({
      title: `Source ${index}`,
      url: `https://sources.example/${index}`,
    }));
    const parsed = parseSidecarResponse(
      completedResponse({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "First",
                annotations: [
                  {
                    type: "url_citation",
                    title: "First source",
                    url: "https://sources.example/0#fragment",
                  },
                ],
              },
            ],
          },
          {
            type: "web_search_call",
            action: { sources: actionSources },
          },
          { type: "web_search_call", action: { sources: [] } },
          {
            type: "message",
            content: [{ type: "output_text", text: "Second" }],
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 10 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      }),
      model(),
    );

    expect(parsed.answer).toBe("First\nSecond");
    expect(parsed.sources).toHaveLength(20);
    expect(parsed.sources[0]).toEqual({
      title: "First source",
      url: "https://sources.example/0",
    });
    expect(parsed.sources[1]?.url).toBe("https://sources.example/1");
    expect(parsed.usage).toMatchObject({
      input: 90,
      output: 20,
      cacheRead: 10,
      reasoning: 5,
      totalTokens: 120,
    });
    expect(parsed.usage?.cost.total).toBeGreaterThan(0);
  });

  it("allows absent usage", () => {
    expect(
      parseSidecarResponse(completedResponse(), model()).usage,
    ).toBeUndefined();
  });

  it.each([
    ["incomplete-response", { status: "incomplete", output: [] }],
    [
      "missing-search-call",
      {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "No search" }],
          },
        ],
      },
    ],
    [
      "missing-answer",
      {
        status: "completed",
        output: [{ type: "web_search_call", action: { sources: [] } }],
      },
    ],
  ])("rejects %s", (category, response) => {
    expect(() => parseSidecarResponse(response, model())).toThrowError(
      expect.objectContaining({ category }),
    );
  });
});

describe("Sidecar terminal failures", () => {
  it("does not dispatch an already-aborted call", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    await expect(
      dispatchSidecarSearch(
        {
          query: "query",
          config: { mode: "live", contextSize: "medium" },
          route: route(),
          thinkingLevel: "auto",
          signal: controller.signal,
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ category: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates caller abort without retry", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      controller.abort();
      expect(init.signal?.aborted).toBe(true);
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      dispatchSidecarSearch(
        {
          query: "query",
          config: { mode: "live", contextSize: "medium" },
          route: route(),
          thinkingLevel: "auto",
          signal: controller.signal,
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ category: "aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces the fixed timeout without retry", async () => {
    const timeout = new AbortController();
    timeout.abort();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetchMock = vi.fn(async () => {
      throw new DOMException("timeout", "TimeoutError");
    });
    await expect(
      dispatchSidecarSearch(
        {
          query: "query",
          config: { mode: "live", contextSize: "medium" },
          route: route(),
          thinkingLevel: "auto",
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ category: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["aborted", "timeout"] as const)(
    "preserves %s while reading the response body",
    async (category) => {
      const caller = new AbortController();
      const timeout = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      const fetchMock = vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => {
            if (category === "aborted") caller.abort();
            else timeout.abort();
            throw new DOMException(category, "AbortError");
          },
        } as unknown as Response;
      });

      await expect(
        dispatchSidecarSearch(
          {
            query: "query",
            config: { mode: "live", contextSize: "medium" },
            route: route(),
            thinkingLevel: "auto",
            ...(category === "aborted" ? { signal: caller.signal } : {}),
          },
          fetchMock as unknown as typeof fetch,
        ),
      ).rejects.toMatchObject({ category });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["network-error", () => Promise.reject(new TypeError("offline"))],
    ["http-error", () => jsonResponse({}, { status: 500 })],
    [
      "missing-search-call",
      () =>
        jsonResponse({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "No search" }],
            },
          ],
        }),
    ],
  ])("does not retry or fall back after %s", async (category, response) => {
    const fetchMock = vi.fn(response);
    await expect(
      dispatchSidecarSearch(
        {
          query: "query",
          config: { mode: "live", contextSize: "medium" },
          route: route(),
          thinkingLevel: "auto",
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toEqual(expect.objectContaining({ category }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON without retry", async () => {
    const fetchMock = vi.fn(async () => new Response("not-json"));
    await expect(
      dispatchSidecarSearch(
        {
          query: "query",
          config: { mode: "live", contextSize: "medium" },
          route: route(),
          thinkingLevel: "auto",
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ category: "invalid-json" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Sidecar debug output", () => {
  it("contains metadata only", async () => {
    const sensitiveRoute = route();
    sensitiveRoute.token = "SECRET_KEY";
    sensitiveRoute.headers.authorization = "SECRET_HEADER";
    const debugOutput = vi.fn();
    const fetchMock = vi.fn(() =>
      jsonResponse(
        completedResponse({
          privatePayload: "SECRET_RAW_PAYLOAD",
          output: [
            {
              type: "web_search_call",
              action: {
                sources: [
                  { title: "SECRET_SOURCE", url: "https://secret.example" },
                ],
              },
            },
            {
              type: "message",
              content: [{ type: "output_text", text: "SECRET_ANSWER" }],
            },
          ],
        }),
      ),
    );

    await dispatchSidecarSearch(
      {
        query: "SECRET_QUERY",
        config: { mode: "live", contextSize: "medium" },
        route: sensitiveRoute,
        thinkingLevel: "auto",
        debug: true,
      },
      fetchMock as unknown as typeof fetch,
      debugOutput,
    );

    const output = debugOutput.mock.calls.flat().join("\n");
    expect(output).toContain("web-search-sidecar");
    expect(output).toContain("api.openai.com");
    for (const secret of [
      "SECRET_KEY",
      "SECRET_HEADER",
      "SECRET_QUERY",
      "SECRET_ANSWER",
      "SECRET_SOURCE",
      "secret.example",
      "SECRET_RAW_PAYLOAD",
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
