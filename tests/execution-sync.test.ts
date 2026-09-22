import { describe, expect, it, vi } from "vitest";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { defaultConfig } from "../src/config.ts";
import {
  APPLY_PATCH_TOOL,
  CODE_MODE_EXEC_TOOL,
  CODE_MODE_WAIT_TOOL,
  EXEC_COMMAND_TOOL,
  syncOwnedTool,
  WRITE_STDIN_TOOL,
} from "../src/index.ts";
import {
  PI_BUILTIN_BASH,
  PI_BUILTIN_EDIT,
  PI_BUILTIN_WRITE,
} from "../src/execution-mode.ts";
import { otherModel } from "./fixtures.ts";

const SOURCE = "/extension/src/index.ts";

const TOOLKIT_NAMES = [
  APPLY_PATCH_TOOL,
  EXEC_COMMAND_TOOL,
  WRITE_STDIN_TOOL,
  CODE_MODE_EXEC_TOOL,
  CODE_MODE_WAIT_TOOL,
] as const;

function tool(name: string, path = SOURCE, source = "test") {
  return {
    name,
    sourceInfo: {
      path,
      source,
      scope: "user" as const,
      origin: "package" as const,
    },
  };
}

/** A builtin registration as the real host reports it in `getAllTools()`. */
function builtin(name: string) {
  return tool(name, `<builtin:${name}>`, "builtin");
}

function harness(active: string[]) {
  let current = [...active];
  const setActiveTools = vi.fn((names: string[]) => {
    current = names;
  });
  let foreignNatives = new Set<string>();
  const pi = {
    getActiveTools: () => current,
    setActiveTools,
    getAllTools: () => [
      ...TOOLKIT_NAMES.map((name) => tool(name)),
      ...[PI_BUILTIN_BASH, PI_BUILTIN_EDIT, PI_BUILTIN_WRITE, "read"].map(
        (name) =>
          foreignNatives.has(name)
            ? tool(name, `/foreign/${name}.ts`, "inline")
            : builtin(name),
      ),
    ],
  } as unknown as Pick<
    ExtensionAPI,
    "getActiveTools" | "getAllTools" | "setActiveTools"
  >;
  const ctx = {
    model: otherModel({ id: "gpt-6-astra", provider: "openai-codex" }),
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
      isUsingOAuth: () => false,
    },
  } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;
  return {
    pi,
    ctx,
    active: () => current,
    /** The committed suppression set, carried across syncs like the stash. */
    suppressed: new Set<string>(),
    setForeignNatives: (names: string[]) => {
      foreignNatives = new Set(names);
    },
  };
}

function ruleConfig(patch: boolean, shell: boolean, code: boolean) {
  const config = defaultConfig();
  config.execution = {
    version: 1,
    rules: [
      {
        id: "astra",
        match: "gpt-6-astra",
        patch,
        shell,
        code,
      },
    ],
  };
  return config;
}

describe("execution-mode tool projection", () => {
  const natives = ["read", PI_BUILTIN_BASH, PI_BUILTIN_EDIT, PI_BUILTIN_WRITE];

  it.each([
    {
      name: "none",
      flags: [false, false, false] as const,
      expectActive: natives,
    },
    {
      name: "P",
      flags: [true, false, false] as const,
      expectActive: ["read", PI_BUILTIN_BASH, APPLY_PATCH_TOOL],
    },
    {
      name: "S",
      flags: [false, true, false] as const,
      expectActive: [
        "read",
        PI_BUILTIN_EDIT,
        PI_BUILTIN_WRITE,
        EXEC_COMMAND_TOOL,
        WRITE_STDIN_TOOL,
      ],
    },
    {
      name: "P+S",
      flags: [true, true, false] as const,
      expectActive: [
        "read",
        APPLY_PATCH_TOOL,
        EXEC_COMMAND_TOOL,
        WRITE_STDIN_TOOL,
      ],
    },
    {
      name: "C",
      flags: [false, false, true] as const,
      expectActive: [
        "read",
        PI_BUILTIN_EDIT,
        PI_BUILTIN_WRITE,
        CODE_MODE_EXEC_TOOL,
        CODE_MODE_WAIT_TOOL,
      ],
    },
    {
      name: "P+C",
      flags: [true, false, true] as const,
      expectActive: ["read", CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL],
    },
    {
      name: "S+C",
      flags: [false, true, true] as const,
      expectActive: [
        "read",
        PI_BUILTIN_EDIT,
        PI_BUILTIN_WRITE,
        EXEC_COMMAND_TOOL,
        WRITE_STDIN_TOOL,
        CODE_MODE_EXEC_TOOL,
        CODE_MODE_WAIT_TOOL,
      ],
    },
    {
      name: "P+S+C",
      flags: [true, true, true] as const,
      expectActive: [
        "read",
        EXEC_COMMAND_TOOL,
        WRITE_STDIN_TOOL,
        CODE_MODE_EXEC_TOOL,
        CODE_MODE_WAIT_TOOL,
      ],
    },
  ])("projects $name", ({ flags, expectActive }) => {
    const { pi, ctx, active, suppressed } = harness([...natives]);
    const state = syncOwnedTool(
      pi,
      ruleConfig(flags[0], flags[1], flags[2]),
      ctx,
      SOURCE,
      {
        nativeSuppressed: suppressed,
      },
    );
    expect(active()).toEqual(expectActive);
    expect(state.routes.hideBash).toBe(flags[1] || flags[2]);
    expect(state.routes.hideEditWrite).toBe(flags[0]);
  });

  it("does not hide builtins in legacy flag mode", () => {
    const { pi, ctx, active, suppressed } = harness([...natives]);
    const config = defaultConfig();
    config.applyPatch.enabled = true;
    config.shellSessions.enabled = true;
    config.codeMode.enabled = true;
    syncOwnedTool(pi, config, ctx, SOURCE, { nativeSuppressed: suppressed });
    expect(active()).toEqual([
      ...natives,
      APPLY_PATCH_TOOL,
      EXEC_COMMAND_TOOL,
      WRITE_STDIN_TOOL,
      CODE_MODE_EXEC_TOOL,
      CODE_MODE_WAIT_TOOL,
    ]);
    expect(suppressed.size).toBe(0);
  });

  it("restores the builtins it suppressed when a replacement ends", () => {
    const { pi, ctx, active, suppressed } = harness([...natives]);
    syncOwnedTool(pi, ruleConfig(true, true, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
    });
    expect(active()).not.toContain(PI_BUILTIN_BASH);
    expect(suppressed).toEqual(
      new Set([PI_BUILTIN_BASH, PI_BUILTIN_EDIT, PI_BUILTIN_WRITE]),
    );
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
    });
    expect(active()).toEqual(natives);
    expect(suppressed.size).toBe(0);
  });

  it("never activates a builtin it did not suppress", () => {
    const { pi, ctx, active, suppressed } = harness(["read"]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
    });
    expect(active()).toEqual(["read"]);
    // A recorded suppression whose winner is still builtin restores the name.
    suppressed.add(PI_BUILTIN_BASH);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
    });
    expect(active()).toEqual(["read", PI_BUILTIN_BASH]);
    expect(suppressed.size).toBe(0);
  });

  it("does not restore a suppressed name whose winner became foreign", () => {
    const { pi, ctx, active, suppressed, setForeignNatives } = harness([
      ...natives,
    ]);
    syncOwnedTool(pi, ruleConfig(true, true, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
    });
    expect(suppressed.size).toBe(3);
    // Another extension wins bash while it is hidden; unhiding must not
    // re-activate the foreign winner — its state is never ours to touch.
    setForeignNatives([PI_BUILTIN_BASH]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
    });
    expect(active()).toEqual(["read", PI_BUILTIN_EDIT, PI_BUILTIN_WRITE]);
    expect(suppressed.size).toBe(0);
  });

  it("preserves a foreign same-name winner under a hiding route", () => {
    const { pi, ctx, active, suppressed, setForeignNatives } = harness([
      ...natives,
    ]);
    setForeignNatives([PI_BUILTIN_BASH, PI_BUILTIN_EDIT]);
    const baseline = new Set<string>();
    const state = syncOwnedTool(
      pi,
      ruleConfig(true, true, false),
      ctx,
      SOURCE,
      {
        nativeSuppressed: suppressed,
        nativeBaseline: baseline,
      },
    );
    // Only the builtin winner this projection actually removed joins the
    // admitted baseline: an active foreign same-name winner is never ours to
    // record, hide or owe back.
    expect(baseline).toEqual(new Set([PI_BUILTIN_WRITE]));
    expect(state.routes.hideBash).toBe(true);
    expect(state.routes.hideEditWrite).toBe(true);
    // Foreign bash/edit keep their active state; only the builtin write is
    // suppressed by this projection.
    expect(active()).toEqual([
      "read",
      PI_BUILTIN_BASH,
      PI_BUILTIN_EDIT,
      APPLY_PATCH_TOOL,
      EXEC_COMMAND_TOOL,
      WRITE_STDIN_TOOL,
    ]);
    expect(suppressed).toEqual(new Set([PI_BUILTIN_WRITE]));

    // Unhide: the foreign winners' activation state is still never touched.
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
    });
    expect(active()).toEqual([
      "read",
      PI_BUILTIN_BASH,
      PI_BUILTIN_EDIT,
      PI_BUILTIN_WRITE,
    ]);
    expect(suppressed.size).toBe(0);
  });

  it("keeps an external disablement of a visible builtin across syncs", () => {
    const { pi, ctx, active, suppressed } = harness(["read"]);
    // All-false rules leave natives visible; the active list only has read
    // because another extension removed the builtins, not Toolkit suppression.
    const state = syncOwnedTool(
      pi,
      ruleConfig(false, false, false),
      ctx,
      SOURCE,
      { nativeSuppressed: suppressed },
    );
    expect(state.routes.hideBash).toBe(false);
    expect(active()).toEqual(["read"]);
    // Repeat syncs stay inert instead of re-adding the removed builtins.
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
    });
    expect(active()).toEqual(["read"]);
  });

  it("marks suppression only for removals the projection actually performs", () => {
    // bash is visible but already inactive before the hiding route applies.
    const { pi, ctx, active, suppressed } = harness([
      "read",
      PI_BUILTIN_EDIT,
      PI_BUILTIN_WRITE,
    ]);
    syncOwnedTool(pi, ruleConfig(true, true, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
    });
    // bash was not active, so nothing was removed and nothing is owed back.
    expect(suppressed).toEqual(new Set([PI_BUILTIN_EDIT, PI_BUILTIN_WRITE]));
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
    });
    expect(active()).toEqual(["read", PI_BUILTIN_EDIT, PI_BUILTIN_WRITE]);
    expect(active()).not.toContain(PI_BUILTIN_BASH);
  });

  it("drops an externally disabled builtin from the admitted baseline", () => {
    const { pi, ctx, active, suppressed } = harness(["read"]);
    const baseline = new Set([
      PI_BUILTIN_BASH,
      PI_BUILTIN_EDIT,
      PI_BUILTIN_WRITE,
    ]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    expect(active()).toEqual(["read"]);
    expect(baseline.size).toBe(0);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
      reconcileBaseline: true,
    });
    expect(active()).toEqual(["read"]);
  });

  it("records an enable made immediately before a hiding route in the baseline", () => {
    // bash left the admitted baseline through an external disable made while
    // it was visible.
    const { pi, ctx, active, suppressed } = harness([...natives]);
    const baseline = new Set([
      PI_BUILTIN_BASH,
      PI_BUILTIN_EDIT,
      PI_BUILTIN_WRITE,
    ]);
    pi.setActiveTools(["read", PI_BUILTIN_EDIT, PI_BUILTIN_WRITE]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    expect(baseline.has(PI_BUILTIN_BASH)).toBe(false);

    // The user re-enables it while natives are visible, and the very next
    // sync enters Code: only the hiding branch can observe that enable.
    pi.setActiveTools([...natives]);
    syncOwnedTool(pi, ruleConfig(false, false, true), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    expect(suppressed.has(PI_BUILTIN_BASH)).toBe(true);
    expect(baseline.has(PI_BUILTIN_BASH)).toBe(true);
    expect(active()).not.toContain(PI_BUILTIN_BASH);

    // Leaving Code restores it, as before.
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    expect(active()).toContain(PI_BUILTIN_BASH);

    // A later tree replay of the filtered declaration can still claim it
    // back, because the enable reached the admitted baseline.
    pi.setActiveTools(["read", PI_BUILTIN_EDIT, PI_BUILTIN_WRITE]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
      reconcileBaseline: true,
    });
    expect(active()).toContain(PI_BUILTIN_BASH);
    expect(active()).toContain(PI_BUILTIN_EDIT);
    expect(active()).toContain(PI_BUILTIN_WRITE);
  });

  it("keeps an external disable made while visible across a hiding route and tree navigation", () => {
    // bash is enabled and visible; another extension disables it while the
    // Toolkit is not hiding anything.
    const { pi, ctx, active, suppressed } = harness([...natives]);
    const baseline = new Set([
      PI_BUILTIN_BASH,
      PI_BUILTIN_EDIT,
      PI_BUILTIN_WRITE,
    ]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    pi.setActiveTools(["read", PI_BUILTIN_EDIT, PI_BUILTIN_WRITE]);

    // Selecting Code hides bash; entering that route must still observe the
    // external removal instead of carrying a stale baseline member into the
    // tree reconcile.
    syncOwnedTool(pi, ruleConfig(false, false, true), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    expect(suppressed.has(PI_BUILTIN_BASH)).toBe(false);
    expect(baseline.has(PI_BUILTIN_BASH)).toBe(false);
    syncOwnedTool(pi, ruleConfig(false, false, true), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
      reconcileBaseline: true,
    });
    expect(suppressed.has(PI_BUILTIN_BASH)).toBe(false);

    // Back to a native-only combination: the user's disablement survives.
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    expect(active()).toEqual(["read", PI_BUILTIN_EDIT, PI_BUILTIN_WRITE]);
    expect(active()).not.toContain(PI_BUILTIN_BASH);
  });

  it("restores a transcript-dropped baseline member only at the tree boundary", () => {
    const { pi, ctx, active, suppressed } = harness([...natives]);
    const baseline = new Set([
      PI_BUILTIN_BASH,
      PI_BUILTIN_EDIT,
      PI_BUILTIN_WRITE,
    ]);
    syncOwnedTool(pi, ruleConfig(true, true, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    expect(active()).toEqual([...natives]);
    expect(baseline).toEqual(
      new Set([PI_BUILTIN_BASH, PI_BUILTIN_EDIT, PI_BUILTIN_WRITE]),
    );
    pi.setActiveTools(["read"]);
    expect(active()).toEqual(["read"]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
      reconcileBaseline: true,
    });
    expect(active()).toEqual([...natives]);
  });

  it("returns a re-enabled builtin to the admitted baseline", () => {
    const { pi, ctx, active, suppressed } = harness(["read"]);
    const baseline = new Set([
      PI_BUILTIN_BASH,
      PI_BUILTIN_EDIT,
      PI_BUILTIN_WRITE,
    ]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    expect(baseline.size).toBe(0);
    pi.setActiveTools([
      "read",
      PI_BUILTIN_BASH,
      PI_BUILTIN_EDIT,
      PI_BUILTIN_WRITE,
    ]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    expect(active()).toEqual([...natives]);
    expect(baseline).toEqual(
      new Set([PI_BUILTIN_BASH, PI_BUILTIN_EDIT, PI_BUILTIN_WRITE]),
    );
    syncOwnedTool(pi, ruleConfig(true, true, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    expect(active()).toEqual([...natives]);
    pi.setActiveTools(["read"]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
      reconcileBaseline: true,
    });
    expect(active()).toEqual([...natives]);
  });

  it("does not treat a tree-replayed enablement as an external re-enable", () => {
    const { pi, ctx, active, suppressed } = harness([...natives]);
    const baseline = new Set([
      PI_BUILTIN_BASH,
      PI_BUILTIN_EDIT,
      PI_BUILTIN_WRITE,
    ]);
    pi.setActiveTools(["read"]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
    });
    expect(active()).toEqual(["read"]);
    expect(baseline.size).toBe(0);
    pi.setActiveTools([...natives]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
      reconcileBaseline: true,
    });
    expect(active()).toEqual([...natives]);
    expect(baseline.size).toBe(0);
    pi.setActiveTools(["read"]);
    syncOwnedTool(pi, ruleConfig(false, false, false), ctx, SOURCE, {
      nativeSuppressed: suppressed,
      nativeBaseline: baseline,
      reconcileBaseline: true,
    });
    expect(active()).toEqual(["read"]);
  });
});
