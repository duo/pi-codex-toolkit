import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import piCodexToolkit, {
  COMPUTER_USE_TOOLS,
  detectExtensionSourcePath,
  EXEC_COMMAND_TOOL,
  WRITE_STDIN_TOOL,
} from "../src/index.ts";
import { EXEC_COMMAND_SCHEMA, WRITE_STDIN_SCHEMA } from "../src/shell/tools.ts";
import {
  inspectToolOwnership,
  isUnavailableOwnership,
  isVisibleForeignOwnership,
  type ToolOwnership,
} from "../src/tool-ownership.ts";
import { withEventBus } from "./fixtures/extension-events.ts";

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

const NAME = "find_tools";
const SOURCE_PATH = "/extension/src/index.ts";

function info(name: string, path: string): ToolInfo {
  return {
    name,
    sourceInfo: { path, source: "test", scope: "user", origin: "package" },
  } as ToolInfo;
}

const owned = info(NAME, SOURCE_PATH);
const foreign = info(NAME, "/other/discovery.ts");
const unnormalized = info(NAME, "/extension/src/../src/./index.ts");

describe("inspectToolOwnership", () => {
  it.each<[string, ToolInfo[], string, ToolOwnership]>([
    ["empty projection", [], SOURCE_PATH, { state: "absent" }],
    [
      "owned same path",
      [owned],
      SOURCE_PATH,
      { state: "owned", winner: owned },
    ],
    [
      "owned equivalent unnormalized winner path",
      [unnormalized],
      SOURCE_PATH,
      { state: "owned", winner: unnormalized },
    ],
    [
      "owned equivalent unnormalized extension path",
      [owned],
      "/extension/src/../src/index.ts",
      { state: "owned", winner: owned },
    ],
    [
      "foreign winner",
      [foreign],
      SOURCE_PATH,
      { state: "foreign", winner: foreign },
    ],
    [
      "first entry wins over a later owned duplicate",
      [foreign, owned],
      SOURCE_PATH,
      { state: "foreign", winner: foreign },
    ],
    [
      "first entry wins over a later foreign duplicate",
      [owned, foreign],
      SOURCE_PATH,
      { state: "owned", winner: owned },
    ],
    [
      "name comparison is exact",
      [info(NAME.toUpperCase(), SOURCE_PATH)],
      SOURCE_PATH,
      { state: "absent" },
    ],
    [
      "unrelated names do not win",
      [info("other_tool", SOURCE_PATH)],
      SOURCE_PATH,
      { state: "absent" },
    ],
  ])("%s", (_title, tools, sourcePath, expected) => {
    expect(inspectToolOwnership(tools, NAME, sourcePath)).toEqual(expected);
  });

  it("returns the winner by identity", () => {
    const ownership = inspectToolOwnership([owned], NAME, SOURCE_PATH);
    expect(ownership.state === "owned" && ownership.winner === owned).toBe(
      true,
    );
  });

  it("owns nothing while the extension identity is unresolved", () => {
    // Nothing in the projection is provably this factory's registration, so
    // it owns nothing — and reports `absent` rather than a conflict it cannot
    // substantiate, even against a visible winner it might have registered.
    for (const winner of [owned, foreign, unnormalized]) {
      const ownership = inspectToolOwnership([winner], NAME, undefined);
      expect(ownership).toEqual({ state: "absent" });
      expect(isUnavailableOwnership(ownership)).toBe(true);
      expect(isVisibleForeignOwnership(ownership)).toBe(false);
    }
  });
});

describe("per-factory registration identity", () => {
  /** Everything one factory hands `registerTool`, with no host projection. */
  function registrations(): Map<string, ToolDefinition> {
    const tools = new Map<string, ToolDefinition>();
    const pi = withEventBus({
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerCommand: () => undefined,
      on: () => undefined,
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => undefined,
    } as unknown as ExtensionAPI);
    piCodexToolkit(pi);
    return tools;
  }

  const first = registrations();
  const second = registrations();
  const schemasOf = (tools: Map<string, ToolDefinition>) =>
    new Map<string, unknown>(
      [...tools].map(([name, tool]) => [name, tool.parameters]),
    );
  const projection = (tools: Map<string, ToolDefinition>, path: string) =>
    [...tools].map(
      ([name, tool]) =>
        ({
          name,
          parameters: tool.parameters,
          sourceInfo: {
            path,
            source: "test",
            scope: "user",
            origin: "package",
          },
        }) as unknown as ToolInfo,
    );

  it("registers a schema object no other factory shares", () => {
    expect(first.size).toBeGreaterThan(0);
    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [name, tool] of first) {
      const other = second.get(name);
      expect(other?.parameters).toBeDefined();
      // Two factories built from one module instance must not share the
      // object Pi projects by reference, or each could read the other's
      // registration as its own.
      expect(other?.parameters).not.toBe(tool.parameters);
      // The wire shape is untouched.
      expect(JSON.stringify(other?.parameters)).toBe(
        JSON.stringify(tool.parameters),
      );
    }
  });

  it("does not register the shared module-level schema objects", () => {
    // `EXEC_COMMAND_SCHEMA`, `WRITE_STDIN_SCHEMA` and the Computer Use
    // schemas are one object per module instance: a registration carrying one
    // of them identifies the module, not a factory.
    for (const [name, shared] of [
      [EXEC_COMMAND_TOOL, EXEC_COMMAND_SCHEMA],
      [WRITE_STDIN_TOOL, WRITE_STDIN_SCHEMA],
    ] as const) {
      const registered = first.get(name)?.parameters;
      expect(registered).toBeDefined();
      expect(registered).not.toBe(shared);
      expect(JSON.stringify(registered)).toBe(JSON.stringify(shared));
      // The clone still validates exactly like the schema it copied.
      const valid = { command: "printf ok" };
      const invalid = { command: "printf ok", nope: 1 };
      expect(Value.Check(registered as never, valid)).toBe(
        Value.Check(shared, valid),
      );
      expect(Value.Check(registered as never, invalid)).toBe(
        Value.Check(shared, invalid),
      );
    }
    // Computer Use shares six module-level schemas the same way.
    for (const name of COMPUTER_USE_TOOLS) {
      expect(first.get(name)?.parameters).not.toBe(
        second.get(name)?.parameters,
      );
    }
  });

  it("never resolves its identity from another factory's registrations", () => {
    const ours = schemasOf(first);
    // The other factory won every owned name at its own path: nothing in this
    // projection is provably ours, so the identity stays unresolved.
    expect(
      detectExtensionSourcePath(projection(second, "/other/toolkit.ts"), ours),
    ).toBeUndefined();
    // A registration this factory made does decide it.
    expect(
      detectExtensionSourcePath(projection(first, "/agent/toolkit.ts"), ours),
    ).toBe("/agent/toolkit.ts");
  });
});

describe("detectExtensionSourcePath", () => {
  const WRAPPER_PATH = "/agent/extensions/embedder.ts";
  /** Registration identity Pi projects by reference in `getAllTools()`. */
  const registered = new Map<string, unknown>([
    ["apply_patch", Type.Object({ patch: Type.String() })],
    ["exec_command", Type.Object({ command: Type.String() })],
    ["exec", Type.Object({ code: Type.String() })],
  ]);
  const projected = (name: string, path: string): ToolInfo =>
    ({
      name,
      parameters: registered.get(name),
      sourceInfo: { path, source: "test", scope: "user", origin: "package" },
    }) as ToolInfo;

  it("reports the path Pi attributes to this factory's registrations", () => {
    const tools = [...registered.keys()].map((name) =>
      projected(name, WRAPPER_PATH),
    );
    expect(detectExtensionSourcePath(tools, registered)).toBe(WRAPPER_PATH);
  });

  it("does not let a name taken by a foreign winner decide", () => {
    const tools: ToolInfo[] = [
      // Another extension won `apply_patch`: its registration is a different
      // object, so the path it reports contributes nothing.
      {
        name: "apply_patch",
        parameters: Type.Object({ patch: Type.String() }),
        sourceInfo: {
          path: "/other/patch.ts",
          source: "test",
          scope: "user",
          origin: "package",
        },
      } as unknown as ToolInfo,
      projected("exec_command", WRAPPER_PATH),
      projected("exec", WRAPPER_PATH),
      info("read", "<builtin:read>"),
    ];
    expect(detectExtensionSourcePath(tools, registered)).toBe(WRAPPER_PATH);
  });

  it("ignores foreign winners even when they hold most owned names", () => {
    // The majority is only ever taken among proven registrations: a host where
    // another extension won two of the three owned names still resolves to the
    // one entry whose schema object this factory registered.
    const foreignWinner = (name: string): ToolInfo =>
      ({
        name,
        parameters: Type.Object({ other: Type.String() }),
        sourceInfo: {
          path: "/other/tools.ts",
          source: "test",
          scope: "user",
          origin: "package",
        },
      }) as unknown as ToolInfo;
    const tools: ToolInfo[] = [
      foreignWinner("apply_patch"),
      foreignWinner("exec_command"),
      projected("exec", WRAPPER_PATH),
    ];
    expect(detectExtensionSourcePath(tools, registered)).toBe(WRAPPER_PATH);
  });

  it("prefers the path most of the proven registrations share", () => {
    // A stale duplicate registration at another path must not outvote the
    // file Pi loaded this factory from.
    const tools = [
      projected("apply_patch", "/agent/extensions/old-copy.ts"),
      projected("exec_command", WRAPPER_PATH),
      projected("exec", WRAPPER_PATH),
    ];
    expect(detectExtensionSourcePath(tools, registered)).toBe(WRAPPER_PATH);
  });

  it("reports nothing when no registration is provably ours", () => {
    // Every owned name filtered out of the projection, and a host that copies
    // parameter schemas, both leave the caller on its own module path.
    expect(detectExtensionSourcePath([], registered)).toBeUndefined();
    expect(
      detectExtensionSourcePath(
        [info("exec_command", WRAPPER_PATH)],
        registered,
      ),
    ).toBeUndefined();
  });
});

describe("ownership predicates", () => {
  it.each<[ToolOwnership["state"], boolean, boolean]>([
    ["owned", false, false],
    ["foreign", true, true],
    ["absent", true, false],
  ])("%s: unavailable=%s, visibleForeign=%s", (state, unavailable, visible) => {
    const ownership =
      state === "absent"
        ? inspectToolOwnership([], NAME, SOURCE_PATH)
        : inspectToolOwnership(
            [state === "owned" ? owned : foreign],
            NAME,
            SOURCE_PATH,
          );
    expect(ownership.state).toBe(state);
    expect(isUnavailableOwnership(ownership)).toBe(unavailable);
    expect(isVisibleForeignOwnership(ownership)).toBe(visible);
  });

  it("disagree only on the absent case", () => {
    const absent = inspectToolOwnership([], NAME, SOURCE_PATH);
    expect(isUnavailableOwnership(absent)).toBe(true);
    expect(isVisibleForeignOwnership(absent)).toBe(false);
  });
});
