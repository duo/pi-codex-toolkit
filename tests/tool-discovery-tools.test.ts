import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { COMPUTER_USE_TOOLS } from "../src/computer-use/tools.ts";
import {
  COMPUTER_USE_TOOL_GROUP,
  DEFAULT_DEFERRED_TOOLS,
  type EligibilityResult,
} from "../src/tool-discovery/directory.ts";
import {
  createToolDiscoveryTool,
  formatToolDiscoveryResult,
  TOOL_DISCOVERY_TOOL,
  type ToolDiscoveryDetails,
} from "../src/tool-discovery/tools.ts";

const ENTRIES = [
  {
    name: "openai_generate_image",
    description:
      "Generate one image with OpenAI and return it as a Pi image result.",
  },
  {
    name: "exec_command",
    description: "Run one shell command and return new output.",
  },
  {
    name: "computer_use_list_apps",
    description: "List macOS apps available to Computer Use.",
  },
  {
    name: "computer_use_get_app_state",
    description:
      "Read the current accessibility state and screenshot for one macOS app.",
  },
  ...COMPUTER_USE_TOOLS.slice(2).map((name) => ({
    name,
    description: `Computer Use action ${name}.`,
  })),
];

type AnyTool = ToolDefinition<any, any, any>;

function context(): ExtensionContext {
  return { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext;
}

function createHarness(
  options: {
    enabled?: boolean;
    deferred?: readonly string[];
    active?: readonly string[];
    rejected?: Map<string, string>;
    onLoaded?: (names: readonly string[]) => void;
    failActivation?: boolean;
  } = {},
) {
  let active = [...(options.active ?? ["read", "bash"])];
  const setActiveTools = vi.fn((names: string[]) => {
    if (options.failActivation) throw new Error("activation failed");
    active = names;
  });
  const rejected = options.rejected ?? new Map<string, string>();
  const isEligible = (name: string): EligibilityResult => {
    const reason = rejected.get(name);
    return reason === undefined ? { ok: true } : { ok: false, reason };
  };
  const [definition] = createToolDiscoveryTool({
    isEnabled: () => options.enabled ?? true,
    getConfig: () => ({
      deferred: options.deferred ?? [...DEFAULT_DEFERRED_TOOLS],
    }),
    getActiveTools: () => active,
    setActiveTools,
    isEligible,
    describeTool: (name) =>
      ENTRIES.find((entry) => entry.name === name)?.description,
    onLoaded: options.onLoaded,
  });
  return {
    tool: definition as AnyTool,
    setActiveTools,
    active: () => active,
    reject: (name: string, reason: string) => rejected.set(name, reason),
  };
}

async function execute(
  tool: AnyTool,
  params: unknown,
): Promise<{ details: ToolDiscoveryDetails; text: string }> {
  const result = await tool.execute(
    "call-1",
    params,
    undefined,
    undefined,
    context(),
  );
  const first = result.content[0] as { type: "text"; text: string };
  return { details: result.details as ToolDiscoveryDetails, text: first.text };
}

describe("find_tools definition", () => {
  it("exposes exactly the one discovery tool with the finalized schema", () => {
    const { tool } = createHarness();
    expect(tool.name).toBe(TOOL_DISCOVERY_TOOL);
    expect(tool.label).toBe("Find Tools");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
        load: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
      },
    });
    expect((tool.parameters as { required?: string[] }).required ?? []).toEqual(
      [],
    );
  });

  it("throws before dispatch when discovery is disabled", async () => {
    const { tool } = createHarness({ enabled: false });
    await expect(execute(tool, { query: "image" })).rejects.toThrow(
      "Tool discovery is not enabled.",
    );
  });

  it("throws for missing, blank, or malformed arguments", async () => {
    const { tool } = createHarness();
    await expect(execute(tool, {})).rejects.toThrow(/requires a query/);
    await expect(execute(tool, { query: "   " })).rejects.toThrow(
      /requires a query/,
    );
    await expect(execute(tool, { load: [] })).rejects.toThrow(
      /requires a query/,
    );
    await expect(execute(tool, { load: "exec_command" })).rejects.toThrow(
      /array of tool names/,
    );
    await expect(execute(tool, { load: ["exec_command", 7] })).rejects.toThrow(
      /non-empty tool names/,
    );
  });

  it("returns bounded matches without changing the active set", async () => {
    const harness = createHarness();
    const { details, text } = await execute(harness.tool, {
      query: "screenshot",
    });
    expect(details).toEqual({
      matches: [
        {
          name: "computer_use_get_app_state",
          summary:
            "Read the current accessibility state and screenshot for one macOS app.",
          state: "eligible",
        },
      ],
    });
    expect(harness.setActiveTools).not.toHaveBeenCalled();
    expect(text).toContain("Matches (1):");
    expect(text).toContain("- computer_use_get_app_state [eligible]");
    expect(text).toContain("Load eligible matches");
  });

  it("reports an empty match set for an unknown query", async () => {
    const { details, text } = await execute(createHarness().tool, {
      query: "dinosaur",
    });
    expect(details).toEqual({ matches: [] });
    expect(text).toBe("No matching managed tools.");
  });

  it("loads an eligible name additively and idempotently", async () => {
    const harness = createHarness({
      deferred: ["exec_command"],
      active: ["read", "bash"],
    });
    const first = await execute(harness.tool, { load: ["exec_command"] });
    expect(harness.setActiveTools).toHaveBeenCalledTimes(1);
    expect(harness.setActiveTools).toHaveBeenCalledWith([
      "read",
      "bash",
      "exec_command",
    ]);
    expect(first.details).toEqual({ loaded: ["exec_command"] });
    expect(first.text).toContain("Loaded: exec_command");

    const second = await execute(harness.tool, { load: ["exec_command"] });
    expect(harness.setActiveTools).toHaveBeenCalledTimes(1);
    expect(second.details).toEqual({ loaded: ["exec_command"] });
  });

  it("reports validated loaded names through onLoaded, including already-active names", async () => {
    const loadedNames: string[][] = [];
    const harness = createHarness({
      deferred: ["exec_command"],
      active: ["read", "exec_command"],
      onLoaded: (names) => loadedNames.push([...names]),
    });
    const { details } = await execute(harness.tool, {
      load: ["exec_command"],
    });
    expect(loadedNames).toEqual([["exec_command"]]);
    expect(details).toEqual({ loaded: ["exec_command"] });
    expect(harness.setActiveTools).not.toHaveBeenCalled();
  });

  it("reports loaded names only after activation succeeds", async () => {
    const observed: string[][] = [];
    const harness = createHarness({
      deferred: ["exec_command"],
      active: ["read"],
      onLoaded: () => observed.push([...harness.active()]),
    });
    const { details } = await execute(harness.tool, {
      load: ["exec_command"],
    });
    expect(details).toEqual({ loaded: ["exec_command"] });
    // The callback observed the activated set, not the pre-activation set.
    expect(observed).toEqual([["read", "exec_command"]]);
  });

  it("does not report loaded names when activation fails", async () => {
    const loadedNames: string[][] = [];
    const harness = createHarness({
      deferred: ["exec_command"],
      active: ["read"],
      failActivation: true,
      onLoaded: (names) => loadedNames.push([...names]),
    });
    await expect(
      execute(harness.tool, { load: ["exec_command"] }),
    ).rejects.toThrow("activation failed");
    expect(harness.setActiveTools).toHaveBeenCalledTimes(1);
    expect(loadedNames).toEqual([]);
  });

  it("reports rejected names without activating or throwing", async () => {
    const harness = createHarness();
    harness.reject("openai_generate_image", "feature-disabled");
    const { details, text } = await execute(harness.tool, {
      load: ["openai_generate_image", "read"],
    });
    expect(harness.setActiveTools).not.toHaveBeenCalled();
    expect(details).toEqual({
      rejected: [
        { name: "openai_generate_image", reason: "feature-disabled" },
        { name: "read", reason: "not-managed" },
      ],
    });
    expect(text).toContain("Rejected:");
    expect(text).toContain("- openai_generate_image: feature-disabled");
    expect(text).toContain("- read: not-managed");
  });

  it("loads an atomic Computer Use group as a whole", async () => {
    const harness = createHarness();
    const { details } = await execute(harness.tool, {
      load: ["computer_use_click"],
    });
    expect(harness.active()).toEqual(["read", "bash", ...COMPUTER_USE_TOOLS]);
    expect(details).toEqual({ loaded: [...COMPUTER_USE_TOOL_GROUP] });
  });

  it("rejects the whole atomic group when one member is ineligible", async () => {
    const harness = createHarness();
    harness.reject("computer_use_click", "conflicting-tool-name");
    const { details } = await execute(harness.tool, {
      load: ["computer_use_list_apps"],
    });
    expect(harness.setActiveTools).not.toHaveBeenCalled();
    expect(details.loaded).toBeUndefined();
    expect(details.rejected).toHaveLength(COMPUTER_USE_TOOL_GROUP.length);
    for (const rejection of details.rejected ?? []) {
      expect(COMPUTER_USE_TOOL_GROUP).toContain(rejection.name);
      expect(rejection.reason).toContain("computer_use_click");
      expect(rejection.reason).toContain("conflicting-tool-name");
    }
  });

  it("supports a query and a load in the same call", async () => {
    const harness = createHarness({
      deferred: ["exec_command"],
      active: ["read"],
    });
    const { details, text } = await execute(harness.tool, {
      query: "command",
      load: ["exec_command"],
    });
    expect(details.matches).toEqual([
      {
        name: "exec_command",
        summary: "Run one shell command and return new output.",
        state: "eligible",
      },
    ]);
    expect(details.loaded).toEqual(["exec_command"]);
    expect(harness.active()).toEqual(["read", "exec_command"]);
    expect(text).toContain("Matches (1):");
    expect(text).toContain("Loaded: exec_command");
  });
});

describe("formatToolDiscoveryResult", () => {
  it("renders no-match, match, unavailable, loaded, and rejected evidence", () => {
    expect(formatToolDiscoveryResult({ matches: [] })).toBe(
      "No matching managed tools.",
    );
    const matches = formatToolDiscoveryResult({
      matches: [
        {
          name: "exec_command",
          summary: "Run one command.",
          state: "eligible",
        },
        {
          name: "openai_generate_image",
          summary: "",
          state: "unavailable",
          reason: "feature-disabled",
        },
      ],
    });
    expect(matches).toContain("Matches (2):");
    expect(matches).toContain("- exec_command [eligible] Run one command.");
    expect(matches).toContain(
      "- openai_generate_image [unavailable: feature-disabled]",
    );
    expect(matches).toContain("Load eligible matches");

    const load = formatToolDiscoveryResult({
      loaded: ["exec_command"],
      rejected: [{ name: "read", reason: "not-managed" }],
    });
    expect(load).toContain("Loaded: exec_command");
    expect(load).toContain("- read: not-managed");
  });
});
