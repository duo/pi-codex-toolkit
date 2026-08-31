import { describe, expect, it } from "vitest";

import { defaultConfig } from "../src/config.ts";
import { injectNativeSearch } from "../src/openai/native-search.ts";
import { transformProviderRequest } from "../src/openai/request-pipeline.ts";

describe("Native Search payload transform", () => {
  it.each(["off", "sidecar", "unavailable"] as const)(
    "is a strict identity when the effective backend is %s",
    (effective) => {
      const payload = { tools: [], unknown: { retained: true } };
      const decision =
        effective === "unavailable"
          ? ({
              effective,
              reason: "missing-sidecar-model" as const,
            } as const)
          : ({ effective } as const);
      expect(
        transformProviderRequest(payload, defaultConfig().webSearch, decision),
      ).toBe(payload);
    },
  );

  it.each([null, "payload", [], { tools: "invalid" }, { include: {} }])(
    "fails closed for unexpected payload %#",
    (payload) => {
      expect(injectNativeSearch(payload, defaultConfig().webSearch)).toBe(
        payload,
      );
    },
  );

  it("copy-on-write merges search while preserving caller fields", () => {
    const payload = {
      model: "gpt-5",
      tools: [{ type: "function", name: "read" }],
      include: ["reasoning.encrypted_content"],
      tool_choice: { type: "function", name: "read" },
      unknown: { nested: true },
    };
    const before = structuredClone(payload);
    const result = injectNativeSearch(payload, {
      mode: "cached",
      contextSize: "high",
    }) as Record<string, unknown>;

    expect(payload).toEqual(before);
    expect(result).toMatchObject({
      model: "gpt-5",
      tool_choice: { type: "function", name: "read" },
      unknown: { nested: true },
    });
    expect(result.tools).toEqual([
      { type: "function", name: "read" },
      {
        type: "web_search",
        search_context_size: "high",
        external_web_access: false,
      },
    ]);
    expect(result.include).toEqual([
      "reasoning.encrypted_content",
      "web_search_call.action.sources",
    ]);
  });

  it("preserves explicit search settings, deduplicates its tool, and is idempotent", () => {
    const payload = {
      tools: [
        { type: "web_search", search_context_size: "low", custom: true },
        { type: "web_search", external_web_access: false },
      ],
      include: ["web_search_call.action.sources"],
    };
    const once = injectNativeSearch(payload, {
      mode: "live",
      contextSize: "high",
    });
    const twice = injectNativeSearch(once, {
      mode: "live",
      contextSize: "high",
    });

    expect(once).toEqual(twice);
    expect((once as { tools: unknown[] }).tools).toEqual([
      {
        type: "web_search",
        search_context_size: "low",
        external_web_access: true,
        custom: true,
      },
    ]);
    expect(once).toMatchObject({ tool_choice: "auto" });
  });
});
