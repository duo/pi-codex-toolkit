import { describe, expect, it } from "vitest";

import { APPLY_PATCH_TOOL } from "../src/apply-patch.ts";
import { CODE_MODE_TOOLS } from "../src/code-mode/tools.ts";
import { COMPUTER_USE_TOOLS } from "../src/computer-use/tools.ts";
import { parseConfig } from "../src/config.ts";
import { IMAGE_GENERATION_TOOL, WEB_SEARCH_TOOL } from "../src/index.ts";
import { SHELL_TOOLS } from "../src/shell/tools.ts";
import {
  APPLY_PATCH_TOOL_NAME,
  CODE_MODE_TOOL_NAMES,
  COMPUTER_USE_TOOL_GROUP,
  DEFAULT_DEFERRED_TOOLS,
  DEFERRABLE_TOOL_NAMES,
  DISCOVERY_MATCH_LIMIT,
  DISCOVERY_SUMMARY_MAX_LENGTH,
  IMAGE_GENERATION_TOOL_NAME,
  isHiddenByDiscovery,
  loadNames,
  resolveDeferredSet,
  searchDeferredTools,
  SHELL_TOOL_NAMES,
  summarizeDescription,
  WEB_SEARCH_SIDECAR_TOOL,
  type EligibilityResult,
} from "../src/tool-discovery/directory.ts";
import { TOOL_DISCOVERY_TOOL } from "../src/tool-discovery/tools.ts";
import { isWellFormed } from "./fixtures/well-formed.ts";

const TWO_BYTE = "é"; // one UTF-16 unit, two UTF-8 bytes
const ASTRAL = "\u{1F600}"; // one surrogate pair, four UTF-8 bytes

const ENTRIES = [
  {
    name: "openai_generate_image",
    description:
      "Generate one image with OpenAI and return it as a Pi image result.",
  },
  {
    name: "exec_command",
    description: "Run one shell command and wait for output or a session id.",
  },
  {
    name: "wait",
    description: "Continue a Code Mode cell returned by exec.",
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
];

function describeTool(name: string): string | undefined {
  return ENTRIES.find((entry) => entry.name === name)?.description;
}

const alwaysEligible = (): EligibilityResult => ({ ok: true });

describe("tool discovery managed set", () => {
  it("tracks every deferrable Toolkit-owned tool name except find_tools", () => {
    expect(new Set(DEFERRABLE_TOOL_NAMES)).toEqual(
      new Set([
        "openai_web_search",
        "openai_generate_image",
        APPLY_PATCH_TOOL,
        ...SHELL_TOOLS,
        ...CODE_MODE_TOOLS,
        ...COMPUTER_USE_TOOLS,
      ]),
    );
    expect(DEFERRABLE_TOOL_NAMES).not.toContain(TOOL_DISCOVERY_TOOL);
  });

  it("keeps every overlay group and single name equal to its feature module", () => {
    expect([...COMPUTER_USE_TOOL_GROUP]).toEqual([...COMPUTER_USE_TOOLS]);
    expect([...SHELL_TOOL_NAMES]).toEqual([...SHELL_TOOLS]);
    expect([...CODE_MODE_TOOL_NAMES]).toEqual([...CODE_MODE_TOOLS]);
    expect(APPLY_PATCH_TOOL_NAME).toBe(APPLY_PATCH_TOOL);
    expect(WEB_SEARCH_SIDECAR_TOOL).toBe(WEB_SEARCH_TOOL);
    expect(IMAGE_GENERATION_TOOL_NAME).toBe(IMAGE_GENERATION_TOOL);
    expect([...DEFAULT_DEFERRED_TOOLS]).toEqual([
      "openai_generate_image",
      ...COMPUTER_USE_TOOLS,
    ]);
  });

  it("resolves the configured deferred set in canonical order", () => {
    expect(
      resolveDeferredSet({ deferred: [...DEFAULT_DEFERRED_TOOLS] }),
    ).toEqual([...DEFAULT_DEFERRED_TOOLS]);
    expect(
      resolveDeferredSet({
        deferred: ["wait", "apply_patch", "wait", "external_tool"],
      }),
    ).toEqual(["apply_patch", "wait"]);
    expect(resolveDeferredSet({ deferred: [] })).toEqual([]);
  });

  it("hides a deferred name only while the find_tools loader is available", () => {
    const deferred = ["openai_generate_image", "apply_patch"];
    const discovered = new Set(["apply_patch"]);
    expect(
      isHiddenByDiscovery("openai_generate_image", {
        loaderAvailable: true,
        deferred,
        discovered,
      }),
    ).toBe(true);
    expect(
      isHiddenByDiscovery("apply_patch", {
        loaderAvailable: true,
        deferred,
        discovered,
      }),
    ).toBe(false);
    expect(
      isHiddenByDiscovery("openai_generate_image", {
        loaderAvailable: false,
        deferred,
        discovered: [],
      }),
    ).toBe(false);
    expect(
      isHiddenByDiscovery("exec_command", {
        loaderAvailable: true,
        deferred: new Set(deferred),
        discovered: new Set<string>(),
      }),
    ).toBe(false);
  });

  it("accepts the default set and rejects unknown or partial-group overrides", () => {
    expect(() =>
      parseConfig({ toolDiscovery: { deferred: [...DEFAULT_DEFERRED_TOOLS] } }),
    ).not.toThrow();
    expect(() =>
      parseConfig({ toolDiscovery: { deferred: [TOOL_DISCOVERY_TOOL] } }),
    ).toThrow();
    expect(() =>
      parseConfig({
        toolDiscovery: { deferred: ["computer_use_click"] },
      }),
    ).toThrow();
  });
});

describe("bounded deferred search", () => {
  const deferred = [
    "exec_command",
    "wait",
    "openai_generate_image",
    "computer_use_list_apps",
    "computer_use_get_app_state",
  ];

  function search(
    query: string,
    overrides: {
      active?: string[];
      isEligible?: (name: string) => EligibilityResult;
    } = {},
  ) {
    return searchDeferredTools({
      query,
      deferred,
      active: overrides.active ?? [],
      isEligible: overrides.isEligible ?? alwaysEligible,
      describe: describeTool,
    });
  }

  it("ranks exact names before description matches", () => {
    const matches = search("wait");
    expect(matches.map((match) => match.name)).toEqual([
      "wait",
      "exec_command",
    ]);
    expect(matches[0]).toMatchObject({ state: "eligible" });
    expect(matches[0].summary).toContain("Code Mode cell");
    expect(matches[1].summary).toContain("wait for output");
  });

  it("matches name substrings and descriptions case-insensitively", () => {
    expect(search("GENERATE").map((match) => match.name)).toEqual([
      "openai_generate_image",
    ]);
    expect(search("SCREENSHOT").map((match) => match.name)).toEqual([
      "computer_use_get_app_state",
    ]);
    expect(search("macOS APPS").map((match) => match.name)).toEqual([
      "computer_use_list_apps",
    ]);
  });

  it("returns no matches for an unrelated query and for blank queries", () => {
    expect(search("dinosaur")).toEqual([]);
    expect(search("   ")).toEqual([]);
  });

  it("reports active and unavailable states with reasons", () => {
    expect(search("image", { active: ["openai_generate_image"] })).toEqual([
      {
        name: "openai_generate_image",
        summary: ENTRIES[0].description,
        state: "active",
      },
    ]);
    expect(
      search("exec_command", {
        isEligible: (name) =>
          name === "exec_command"
            ? { ok: false, reason: "conflicting-tool-name" }
            : { ok: true },
      }),
    ).toEqual([
      {
        name: "exec_command",
        summary: ENTRIES[1].description,
        state: "unavailable",
        reason: "conflicting-tool-name",
      },
    ]);
  });

  it("bounds results to eight matches in managed order", () => {
    const many = Array.from({ length: 10 }, (_, index) => `managed_${index}`);
    const matches = searchDeferredTools({
      query: "managed",
      deferred: many,
      active: [],
      isEligible: alwaysEligible,
      describe: () => undefined,
    });
    expect(matches).toHaveLength(DISCOVERY_MATCH_LIMIT);
    expect(matches.map((match) => match.name)).toEqual(many.slice(0, 8));
  });

  it("summarizes whitespace and truncates long descriptions", () => {
    expect(summarizeDescription("  first\n\nsecond   line  ")).toBe(
      "first second line",
    );
    const long = "x".repeat(DISCOVERY_SUMMARY_MAX_LENGTH + 20);
    const summary = summarizeDescription(long);
    expect(summary.length).toBeLessThanOrEqual(DISCOVERY_SUMMARY_MAX_LENGTH);
    expect(summary.endsWith("…")).toBe(true);
    expect(summarizeDescription(undefined)).toBe("");
  });

  it("keeps a surrogate pair straddling the bound out of the summary", () => {
    // The pair occupies units 138-139, the last two the 140-unit bound allows
    // once the ellipsis takes one.
    const head = "x".repeat(DISCOVERY_SUMMARY_MAX_LENGTH - 2);
    const summary = summarizeDescription(`${head}${ASTRAL}${"x".repeat(20)}`);
    expect(summary).toBe(`${head}…`);
    expect(isWellFormed(summary)).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(DISCOVERY_SUMMARY_MAX_LENGTH);
  });

  it("bounds the summary in UTF-16 units, not in UTF-8 bytes", () => {
    // Every character is one unit and two bytes, so a byte bound would cut at
    // half the length.
    const summary = summarizeDescription(TWO_BYTE.repeat(200));
    expect(summary).toBe(
      `${TWO_BYTE.repeat(DISCOVERY_SUMMARY_MAX_LENGTH - 1)}…`,
    );
    expect(summary.length).toBe(DISCOVERY_SUMMARY_MAX_LENGTH);
  });
});

describe("deferred load validation", () => {
  const deferred = ["apply_patch", "exec_command", ...COMPUTER_USE_TOOL_GROUP];

  it("adds an eligible managed name without touching unrelated active names", () => {
    expect(
      loadNames({
        requested: ["apply_patch"],
        deferred,
        active: ["read", "bash"],
        isEligible: alwaysEligible,
      }),
    ).toEqual({
      add: ["apply_patch"],
      loaded: ["apply_patch"],
      rejected: [],
    });
  });

  it("is idempotent for a name that is already active", () => {
    expect(
      loadNames({
        requested: ["apply_patch", "apply_patch"],
        deferred,
        active: ["read", "apply_patch"],
        isEligible: alwaysEligible,
      }),
    ).toEqual({
      add: [],
      loaded: ["apply_patch"],
      rejected: [],
    });
  });

  it("rejects unmanaged and ineligible names with reasons", () => {
    expect(
      loadNames({
        requested: ["read", "exec_command"],
        deferred,
        active: ["read"],
        isEligible: (name) =>
          name === "exec_command"
            ? { ok: false, reason: "feature-disabled" }
            : { ok: true },
      }),
    ).toEqual({
      add: [],
      loaded: [],
      rejected: [
        { name: "read", reason: "not-managed" },
        { name: "exec_command", reason: "feature-disabled" },
      ],
    });
  });

  it("loads one Computer Use member as the whole atomic group", () => {
    expect(
      loadNames({
        requested: ["computer_use_click"],
        deferred,
        active: ["read"],
        isEligible: alwaysEligible,
      }),
    ).toEqual({
      add: [...COMPUTER_USE_TOOL_GROUP],
      loaded: [...COMPUTER_USE_TOOL_GROUP],
      rejected: [],
    });
    expect(
      loadNames({
        requested: ["computer_use_click"],
        deferred,
        active: ["computer_use_list_apps", "read"],
        isEligible: alwaysEligible,
      }).add,
    ).toEqual(COMPUTER_USE_TOOL_GROUP.slice(1));
  });

  it("rejects the whole Computer Use group when any member is ineligible", () => {
    const result = loadNames({
      requested: ["computer_use_list_apps", "computer_use_click"],
      deferred,
      active: ["read"],
      isEligible: (name) =>
        name === "computer_use_click"
          ? { ok: false, reason: "conflicting-tool-name" }
          : { ok: true },
    });
    expect(result.add).toEqual([]);
    expect(result.loaded).toEqual([]);
    expect(result.rejected).toHaveLength(COMPUTER_USE_TOOL_GROUP.length);
    expect(new Set(result.rejected.map((entry) => entry.name))).toEqual(
      new Set(COMPUTER_USE_TOOL_GROUP),
    );
    for (const entry of result.rejected) {
      expect(entry.reason).toContain("computer_use_click");
      expect(entry.reason).toContain("conflicting-tool-name");
    }
  });

  it("rejects a partially deferred atomic group as a fail-safe", () => {
    const result = loadNames({
      requested: ["computer_use_click"],
      deferred: ["computer_use_click"],
      active: ["read"],
      isEligible: alwaysEligible,
    });
    expect(result.add).toEqual([]);
    expect(result.rejected).toHaveLength(COMPUTER_USE_TOOL_GROUP.length);
    for (const entry of result.rejected) {
      expect(entry.reason).toContain("group incomplete");
    }
  });
});
