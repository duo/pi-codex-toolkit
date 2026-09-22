import type { Provider, Usage } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";

import { parseRemoteCompactionResponse } from "../src/openai/remote-compaction.ts";
import type { AuthenticatedOfficialRoute } from "../src/openai/route.ts";
import {
  dispatchSidecarSearch,
  parseSidecarResponse,
  SidecarSearchError,
} from "../src/openai/sidecar-search.ts";
import { parseResponsesUsage } from "../src/openai/usage.ts";
import { codexModel, model } from "./fixtures.ts";

/**
 * Characterization of the Responses API `usage` parser shared by Sidecar
 * Search and Remote Compaction. Every table case runs through the module
 * directly and through both host entry points with strict deep equality.
 * Cost numbers are the exact values produced by the pinned pi-ai
 * `calculateCost` for the fixture model
 * (`cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }`).
 */

const ABSENT = Symbol("absent-usage");

type UsageInput = unknown | typeof ABSENT;

interface UsageCase {
  name: string;
  usage: UsageInput;
  expected: Usage | undefined;
}

function cost(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  total: number,
): Usage["cost"] {
  return { input, output, cacheRead, cacheWrite, total };
}

const COST_90_20_10_0 = cost(
  0.00008999999999999999,
  0.000039999999999999996,
  0.0000010000000000000002,
  0,
  0.00013099999999999999,
);
const COST_85_20_10_5 = cost(
  0.00008499999999999999,
  0.000039999999999999996,
  0.0000010000000000000002,
  0.000005,
  0.000131,
);
const COST_0_20_200_0 = cost(
  0,
  0.000039999999999999996,
  0.00002,
  0,
  0.000059999999999999995,
);
const COST_100_20_0_0 = cost(
  0.00009999999999999999,
  0.000039999999999999996,
  0,
  0,
  0.00014,
);
const COST_7_3_0_0 = cost(0.000007, 0.000006, 0, 0, 0.000013000000000000001);
const COST_12_4_0_0 = cost(0.000012, 0.000008, 0, 0, 0.000019999999999999998);

const BASE_TOKENS = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };

const TOKEN_FIELDS = ["input_tokens", "output_tokens", "total_tokens"] as const;

/**
 * Invalid token values. `NaN`/`Infinity` reach the direct Sidecar parser as
 * real numbers; the SSE path receives `null` because JSON coerces them. Both
 * are rejected by the parser, so the expected result is identical.
 */
const INVALID_TOKEN_VALUES: [string, unknown][] = [
  ["missing", undefined],
  ["negative", -1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["numeric string", "10"],
  ["null", null],
];

const invalidTokenCases: UsageCase[] = TOKEN_FIELDS.flatMap((field) =>
  INVALID_TOKEN_VALUES.map(([label, value]) => ({
    name: `${field} ${label} -> undefined`,
    usage:
      value === undefined
        ? Object.fromEntries(
            Object.entries(BASE_TOKENS).filter(([key]) => key !== field),
          )
        : { ...BASE_TOKENS, [field]: value },
    expected: undefined,
  })),
);

const cases: UsageCase[] = [
  { name: "absent usage -> undefined", usage: ABSENT, expected: undefined },
  { name: "null usage -> undefined", usage: null, expected: undefined },
  { name: "array usage -> undefined", usage: [], expected: undefined },
  { name: "string usage -> undefined", usage: "x", expected: undefined },
  { name: "number usage -> undefined", usage: 42, expected: undefined },
  ...invalidTokenCases,
  {
    name: "totals only -> no cache, no reasoning key",
    usage: BASE_TOKENS,
    expected: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: COST_100_20_0_0,
    },
  },
  {
    name: "cached_tokens subtracts from input",
    usage: { ...BASE_TOKENS, input_tokens_details: { cached_tokens: 10 } },
    expected: {
      input: 90,
      output: 20,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 120,
      cost: COST_90_20_10_0,
    },
  },
  {
    name: "cached_tokens and cache_write_tokens both subtract",
    usage: {
      ...BASE_TOKENS,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
    },
    expected: {
      input: 85,
      output: 20,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 120,
      cost: COST_85_20_10_5,
    },
  },
  {
    name: "cached_tokens above input clamps input to zero",
    usage: { ...BASE_TOKENS, input_tokens_details: { cached_tokens: 200 } },
    expected: {
      input: 0,
      output: 20,
      cacheRead: 200,
      cacheWrite: 0,
      totalTokens: 120,
      cost: COST_0_20_200_0,
    },
  },
  {
    name: "invalid cache values become zero, not a rejection",
    usage: {
      ...BASE_TOKENS,
      input_tokens_details: { cached_tokens: -5, cache_write_tokens: "3" },
    },
    expected: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: COST_100_20_0_0,
    },
  },
  {
    name: "non-record detail objects are treated as empty",
    usage: {
      ...BASE_TOKENS,
      input_tokens_details: "bad",
      output_tokens_details: null,
    },
    expected: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: COST_100_20_0_0,
    },
  },
  {
    name: "array detail objects are treated as empty",
    usage: {
      ...BASE_TOKENS,
      input_tokens_details: [{ cached_tokens: 10 }],
      output_tokens_details: [],
    },
    expected: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: COST_100_20_0_0,
    },
  },
  {
    name: "reasoning_tokens present is kept",
    usage: {
      ...BASE_TOKENS,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 5 },
    },
    expected: {
      input: 90,
      output: 20,
      cacheRead: 10,
      cacheWrite: 0,
      reasoning: 5,
      totalTokens: 120,
      cost: COST_90_20_10_0,
    },
  },
  {
    name: "reasoning_tokens zero is kept as zero",
    usage: { ...BASE_TOKENS, output_tokens_details: { reasoning_tokens: 0 } },
    expected: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 120,
      cost: COST_100_20_0_0,
    },
  },
  {
    name: "reasoning_tokens negative omits the key",
    usage: { ...BASE_TOKENS, output_tokens_details: { reasoning_tokens: -1 } },
    expected: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: COST_100_20_0_0,
    },
  },
  {
    name: "total_tokens is passed through without consistency checks",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 999 },
    expected: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 999,
      cost: cost(0.000001, 0.000002, 0, 0, 0.000003),
    },
  },
];

function completedResponse(usage: UsageInput): Record<string, unknown> {
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
    ...(usage === ABSENT ? {} : { usage }),
  };
}

function sseResponse(events: unknown[]): Response {
  const text = events
    .map((event) => `data: ${JSON.stringify(event)}`)
    .join("\n\n");
  return new Response(`${text}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const CHECKPOINT_ITEM = {
  type: "response.output_item.done",
  item: {
    type: "compaction",
    id: "cmp_usage",
    encrypted_content: "opaque-cmp_usage",
  },
};

function completedEvent(usage: UsageInput): Record<string, unknown> {
  return {
    type: "response.completed",
    response: usage === ABSENT ? {} : { usage },
  };
}

function remoteResponse(usage: UsageInput): Response {
  return sseResponse([CHECKPOINT_ITEM, completedEvent(usage)]);
}

function jwt(accountId: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

function codexRoute(): AuthenticatedOfficialRoute {
  return {
    model: codexModel({
      id: "gpt-5.4",
      thinkingLevelMap: { minimal: "low", xhigh: null, max: null },
    }),
    route: {
      kind: "codex-oauth",
      endpoint: new URL("https://chatgpt.com/backend-api/codex/responses"),
    },
    token: jwt("account-test"),
    headers: { "x-refreshed": "safe" },
  };
}

const codexProvider: Pick<Provider, "stream"> = {
  stream: openAICodexResponsesApi().stream,
};

const CODEX_SEARCH_ITEM = {
  type: "response.output_item.done",
  output_index: 0,
  item: {
    type: "web_search_call",
    id: "search_1",
    status: "completed",
    action: {
      sources: [{ title: "Codex source", url: "https://codex.example/source" }],
    },
  },
};

const CODEX_MESSAGE_ITEM = {
  type: "response.output_item.done",
  output_index: 1,
  item: {
    type: "message",
    id: "message_1",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "Codex answer" }],
  },
};

function codexCompletedEvent(usage: unknown): Record<string, unknown> {
  return {
    type: "response.completed",
    response: { status: "completed", usage },
  };
}

async function streamedSidecarUsage(
  completedEvents: unknown[],
): Promise<Usage | undefined> {
  const fetchMock = vi.fn(async () =>
    sseResponse([CODEX_SEARCH_ITEM, CODEX_MESSAGE_ITEM, ...completedEvents]),
  );
  const result = await dispatchSidecarSearch(
    {
      query: "query",
      config: { mode: "live", contextSize: "medium" },
      route: codexRoute(),
      thinkingLevel: "auto",
      provider: codexProvider,
    },
    fetchMock,
  );
  expect(fetchMock).toHaveBeenCalledOnce();
  return result.usage;
}

function assertUsage(actual: Usage | undefined, expected: Usage | undefined) {
  expect(actual).toStrictEqual(expected);
  if (expected !== undefined && !("reasoning" in expected)) {
    expect(actual).not.toHaveProperty("reasoning");
  }
  if (expected !== undefined) {
    expect(actual).not.toHaveProperty("cacheWrite1h");
  }
}

describe("Responses usage parser parity", () => {
  describe.each(cases)("$name", ({ usage, expected }) => {
    it("through parseResponsesUsage", () => {
      assertUsage(
        parseResponsesUsage(usage === ABSENT ? undefined : usage, model()),
        expected,
      );
    });

    it("through parseSidecarResponse", () => {
      assertUsage(
        parseSidecarResponse(completedResponse(usage), model()).usage,
        expected,
      );
    });

    it("through parseRemoteCompactionResponse", async () => {
      const parsed = await parseRemoteCompactionResponse(
        remoteResponse(usage),
        model(),
      );
      assertUsage(parsed.usage, expected);
    });
  });

  it("does not mutate the model or reuse cost objects between parses", () => {
    const fixture = model();
    const snapshot = structuredClone(fixture);
    const first = parseSidecarResponse(
      completedResponse(BASE_TOKENS),
      fixture,
    ).usage;
    const second = parseSidecarResponse(
      completedResponse(BASE_TOKENS),
      fixture,
    ).usage;
    expect(fixture).toStrictEqual(snapshot);
    expect(first).toStrictEqual(second);
    expect(first?.cost).not.toBe(second?.cost);
  });
});

describe("Responses usage streamed terminal events", () => {
  const FIRST = { ...BASE_TOKENS, input_tokens_details: { cached_tokens: 10 } };
  const SECOND = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
  const SECOND_USAGE: Usage = {
    input: 7,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: COST_7_3_0_0,
  };

  it("Remote: the last response.completed event wins", async () => {
    const parsed = await parseRemoteCompactionResponse(
      sseResponse([
        CHECKPOINT_ITEM,
        completedEvent(FIRST),
        completedEvent(SECOND),
      ]),
      model(),
    );
    assertUsage(parsed.usage, SECOND_USAGE);
  });

  it("Remote: a later response.completed without usage clears an earlier usage", async () => {
    const parsed = await parseRemoteCompactionResponse(
      sseResponse([
        CHECKPOINT_ITEM,
        completedEvent(FIRST),
        completedEvent(ABSENT),
      ]),
      model(),
    );
    expect(parsed.usage).toBeUndefined();
  });

  it("Remote: a non-record response on response.completed yields no usage", async () => {
    const parsed = await parseRemoteCompactionResponse(
      sseResponse([
        CHECKPOINT_ITEM,
        { type: "response.completed", response: "done" },
      ]),
      model(),
    );
    expect(parsed.usage).toBeUndefined();
  });

  it("Sidecar streamed Codex: usage from the single completed terminal", async () => {
    assertUsage(
      await streamedSidecarUsage([
        codexCompletedEvent({
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
        }),
      ]),
      {
        input: 12,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 16,
        cost: COST_12_4_0_0,
      },
    );
  });

  it("Sidecar streamed Codex: absent terminal usage stays undefined", async () => {
    expect(
      await streamedSidecarUsage([
        { type: "response.completed", response: { status: "completed" } },
      ]),
    ).toBeUndefined();
  });

  it("Sidecar streamed Codex: a second completed terminal is rejected, not last-wins", async () => {
    await expect(
      streamedSidecarUsage([
        codexCompletedEvent(FIRST),
        codexCompletedEvent(SECOND),
      ]),
    ).rejects.toMatchObject({ category: "incomplete-response" });
    await expect(
      streamedSidecarUsage([
        codexCompletedEvent(FIRST),
        codexCompletedEvent(SECOND),
      ]),
    ).rejects.toBeInstanceOf(SidecarSearchError);
  });
});
