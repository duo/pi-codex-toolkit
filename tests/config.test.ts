import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConfigSaveError,
  ConfigStore,
  defaultConfig,
  parseConfig,
} from "../src/config.ts";

// A read failure without a Node error code cannot be produced through the real
// filesystem; every other call reads the real file.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
  };
});

const temporaryDirectories: string[] = [];

async function configPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pct-config-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "pi-codex-toolkit.json");
}

/**
 * Whether `detail` contains `value` as a whole token. A value inside a longer
 * word of a fixed phrase, such as `x` in `openai-codex`, is not an echo.
 */
function echoes(detail: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "u").test(detail);
}

async function storedConfig(contents: string): Promise<string> {
  const path = await configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
  return path;
}

async function writeLockOwner(
  configPath: string,
  payload: { pid: number; token?: string },
): Promise<string> {
  const lockPath = `${configPath}.lock`;
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner"),
    `${JSON.stringify(payload)}\n`,
    "utf8",
  );
  return lockPath;
}

const INVALID_APPLY_PATCH =
  '{"webSearch":{"enabled":true},"applyPatch":{"enabled":"yes"}}\n';

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("configuration", () => {
  it("uses all-off defaults when the file is absent", async () => {
    const store = new ConfigStore(await configPath());
    await expect(store.load()).resolves.toEqual({
      config: defaultConfig(),
      raw: {},
    });
  });

  it("normalizes known fields while retaining unknown data", () => {
    const raw = {
      futureRoot: { retained: true },
      webSearch: {
        enabled: true,
        backend: "sidecar",
        futureNested: [1, 2, 3],
      },
    };
    const parsed = parseConfig(raw);
    expect(parsed.config).toEqual({
      webSearch: {
        enabled: true,
        backend: "sidecar",
        mode: "live",
        contextSize: "medium",
        sidecarModel: null,
      },
      remoteCompaction: { enabled: false },
      imageGeneration: { enabled: false },
      applyPatch: { enabled: false },
      computerUse: { enabled: false, approvalMode: "confirm" },
      shellSessions: { enabled: false },
      codeMode: { enabled: false, approvalMode: "confirm" },
      toolDiscovery: {
        enabled: false,
        deferred: [
          "openai_generate_image",
          "computer_use_list_apps",
          "computer_use_get_app_state",
          "computer_use_click",
          "computer_use_type_text",
          "computer_use_press_key",
          "computer_use_scroll",
        ],
      },
      debug: false,
    });
    expect(parsed.raw).toBe(raw);
  });

  it("normalizes an older Web Search executor to automatic effort", () => {
    expect(
      parseConfig({
        webSearch: {
          sidecarModel: { provider: "openai-codex", model: "gpt-5.4" },
        },
      }).config.webSearch.sidecarModel,
    ).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
      thinkingLevel: "auto",
    });
  });

  it.each(["confirm", "always"] as const)(
    "round-trips the %s Computer Use approval mode",
    (approvalMode) => {
      expect(
        parseConfig({ computerUse: { approvalMode } }).config.computerUse,
      ).toEqual({ enabled: false, approvalMode });
    },
  );

  it.each(["confirm", "always"] as const)(
    "round-trips the %s Code Mode approval mode",
    (approvalMode) => {
      expect(
        parseConfig({ codeMode: { approvalMode } }).config.codeMode,
      ).toEqual({ enabled: false, approvalMode });
    },
  );

  it("defaults Tool Discovery to Image Generation plus the Computer Use group", () => {
    expect(parseConfig({}).config.toolDiscovery).toEqual({
      enabled: false,
      deferred: [
        "openai_generate_image",
        "computer_use_list_apps",
        "computer_use_get_app_state",
        "computer_use_click",
        "computer_use_type_text",
        "computer_use_press_key",
        "computer_use_scroll",
      ],
    });
  });

  it("round-trips a custom deferred set and drops duplicates", () => {
    expect(
      parseConfig({
        toolDiscovery: {
          enabled: true,
          deferred: ["wait", "apply_patch", "wait"],
        },
      }).config.toolDiscovery,
    ).toEqual({
      enabled: true,
      deferred: ["wait", "apply_patch"],
    });
  });

  // Each row: the whole detail, the rejected input, and the input's invalid
  // parts, which the detail must not echo. The last five rows reach the leaf
  // rules the earlier rows do not.
  it.each<[string, unknown, string[]]>([
    ["configuration must be a JSON object", null, ["null"]],
    ["configuration must be a JSON object", [], ["[]"]],
    ["debug must be true or false", { debug: "yes" }, ["yes"]],
    ["webSearch must be an object", { webSearch: false }, ["false"]],
    [
      "remoteCompaction must be an object",
      { remoteCompaction: false },
      ["false"],
    ],
    [
      "remoteCompaction.enabled must be true or false",
      { remoteCompaction: { enabled: "yes" } },
      ["yes"],
    ],
    [
      "imageGeneration must be an object",
      { imageGeneration: false },
      ["false"],
    ],
    [
      "imageGeneration.enabled must be true or false",
      { imageGeneration: { enabled: "yes" } },
      ["yes"],
    ],
    ["applyPatch must be an object", { applyPatch: false }, ["false"]],
    [
      "applyPatch.enabled must be true or false",
      { applyPatch: { enabled: "yes" } },
      ["yes"],
    ],
    ["computerUse must be an object", { computerUse: false }, ["false"]],
    [
      "computerUse.enabled must be true or false",
      { computerUse: { enabled: "yes" } },
      ["yes"],
    ],
    [
      "computerUse.approvalMode must be one of confirm, always",
      { computerUse: { approvalMode: "sometimes" } },
      ["sometimes"],
    ],
    ["shellSessions must be an object", { shellSessions: false }, ["false"]],
    [
      "shellSessions.enabled must be true or false",
      { shellSessions: { enabled: "yes" } },
      ["yes"],
    ],
    ["codeMode must be an object", { codeMode: false }, ["false"]],
    [
      "codeMode.enabled must be true or false",
      { codeMode: { enabled: "yes" } },
      ["yes"],
    ],
    [
      "codeMode.approvalMode must be one of confirm, always",
      { codeMode: { approvalMode: "sometimes" } },
      ["sometimes"],
    ],
    ["toolDiscovery must be an object", { toolDiscovery: false }, ["false"]],
    [
      "toolDiscovery.enabled must be true or false",
      { toolDiscovery: { enabled: "yes" } },
      ["yes"],
    ],
    [
      "toolDiscovery.deferred must be an array of deferrable Toolkit tool names",
      { toolDiscovery: { deferred: "openai_generate_image" } },
      ["openai_generate_image"],
    ],
    [
      "toolDiscovery.deferred must be an array of deferrable Toolkit tool names",
      { toolDiscovery: { deferred: [42] } },
      ["42"],
    ],
    [
      "toolDiscovery.deferred must be an array of deferrable Toolkit tool names",
      { toolDiscovery: { deferred: ["external_tool"] } },
      ["external_tool"],
    ],
    [
      "toolDiscovery.deferred must be an array of deferrable Toolkit tool names",
      { toolDiscovery: { deferred: ["find_tools"] } },
      ["find_tools"],
    ],
    [
      "toolDiscovery.deferred must list all six Computer Use tools or none",
      { toolDiscovery: { deferred: ["computer_use_click"] } },
      ["computer_use_click"],
    ],
    [
      "toolDiscovery.deferred must list all six Computer Use tools or none",
      {
        toolDiscovery: {
          deferred: ["openai_generate_image", "computer_use_click"],
        },
      },
      ["openai_generate_image", "computer_use_click"],
    ],
    [
      "webSearch.backend must be one of auto, native, sidecar",
      { webSearch: { backend: "fallback" } },
      ["fallback"],
    ],
    [
      "webSearch.sidecarModel must name provider openai or openai-codex and a non-empty model",
      { webSearch: { sidecarModel: { provider: "other", model: "x" } } },
      ["other", "x"],
    ],
    [
      "webSearch.sidecarModel.thinkingLevel must be one of auto, off, minimal, low, medium, high, xhigh, max",
      {
        webSearch: {
          sidecarModel: {
            provider: "openai-codex",
            model: "gpt-5.4",
            thinkingLevel: "extreme",
          },
        },
      },
      ["extreme", "gpt-5.4"],
    ],
    [
      "webSearch.sidecarModel.thinkingLevel must be auto for provider openai",
      {
        webSearch: {
          sidecarModel: {
            provider: "openai",
            model: "gpt-5",
            thinkingLevel: "low",
          },
        },
      },
      ["low", "gpt-5"],
    ],
    [
      "webSearch.enabled must be true or false",
      { webSearch: { enabled: "yes" } },
      ["yes"],
    ],
    [
      "webSearch.mode must be one of live, cached",
      { webSearch: { mode: "later" } },
      ["later"],
    ],
    [
      "webSearch.contextSize must be one of low, medium, high",
      { webSearch: { contextSize: "huge" } },
      ["huge"],
    ],
    [
      "webSearch.sidecarModel must name provider openai or openai-codex and a non-empty model",
      { webSearch: { sidecarModel: "gpt" } },
      ["gpt"],
    ],
    [
      "webSearch.sidecarModel must name provider openai or openai-codex and a non-empty model",
      { webSearch: { sidecarModel: { provider: "openai", model: " " } } },
      [" "],
    ],
    ["execution must be an object", { execution: false }, ["false"]],
    [
      "execution.version must be 1",
      { execution: { version: 2, rules: [] } },
      ["2"],
    ],
    [
      "execution.rules must be an array",
      { execution: { version: 1, rules: {} } },
      [],
    ],
    [
      "execution.rules[0].id must be a nonempty string",
      {
        execution: {
          version: 1,
          rules: [
            { id: "", match: "*", patch: false, shell: false, code: false },
          ],
        },
      },
      [],
    ],
    [
      "execution.rules[1].id must be unique",
      {
        execution: {
          version: 1,
          rules: [
            { id: "a", match: "gpt*", patch: true, shell: false, code: true },
            { id: "a", match: "grok*", patch: true, shell: true, code: false },
          ],
        },
      },
      [],
    ],
  ])("rejects invalid known configuration %#: %s", (detail, value, invalid) => {
    expect(invalid.filter((part) => echoes(detail, part))).toEqual([]);
    expect(() => parseConfig(value)).toThrow(new Error(detail));
  });

  it("keeps the last known good snapshot and leaves invalid JSON untouched", async () => {
    const path = await configPath();
    const store = new ConfigStore(path);
    await store.save({
      ...defaultConfig(),
      debug: true,
    });
    await writeFile(path, "{invalid secret-value", "utf8");

    const snapshot = await store.load();
    expect(snapshot.config.debug).toBe(true);
    expect(snapshot.readError).toBe("invalid-json");
    await expect(store.save(defaultConfig())).rejects.toThrow(/Refusing/);
    await expect(readFile(path, "utf8")).resolves.toBe("{invalid secret-value");
  });

  it("uses defaults on a cold invalid read", async () => {
    const path = await configPath();
    await writeFile(path, "not-json", "utf8").catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "not-json", "utf8");
    });
    const store = new ConfigStore(path);
    const snapshot = await store.load();
    expect(snapshot.config).toEqual(defaultConfig());
    expect(snapshot.readError).toBe("invalid-json");
  });

  it("saves atomically and preserves unknown root and nested keys", async () => {
    const path = await configPath();
    const store = new ConfigStore(path);
    await store.save(defaultConfig());
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    raw.futureRoot = "keep";
    (raw.webSearch as Record<string, unknown>).futureNested = { keep: true };
    (raw.webSearch as Record<string, unknown>).sidecarModel = {
      provider: "openai",
      model: "gpt-5",
      futureModelKey: "keep-model",
    };
    (raw.remoteCompaction as Record<string, unknown>).futureNested = "keep";
    (raw.imageGeneration as Record<string, unknown>).futureNested = "keep";
    (raw.applyPatch as Record<string, unknown>).futureNested = "keep";
    (raw.computerUse as Record<string, unknown>).futureNested = "keep";
    (raw.shellSessions as Record<string, unknown>).futureNested = "keep";
    (raw.codeMode as Record<string, unknown>).futureNested = "keep";
    (raw.toolDiscovery as Record<string, unknown>).futureNested = "keep";
    await writeFile(path, `${JSON.stringify(raw)}\n`, "utf8");
    await store.load();

    const next = defaultConfig();
    next.webSearch.enabled = true;
    next.webSearch.contextSize = "high";
    next.webSearch.sidecarModel = {
      provider: "openai",
      model: "gpt-5",
      thinkingLevel: "auto",
    };
    next.remoteCompaction.enabled = true;
    next.imageGeneration.enabled = true;
    next.applyPatch.enabled = true;
    next.computerUse.enabled = true;
    next.computerUse.approvalMode = "always";
    next.shellSessions.enabled = true;
    next.codeMode.enabled = true;
    next.codeMode.approvalMode = "always";
    next.toolDiscovery.enabled = true;
    next.toolDiscovery.deferred = ["exec_command", "wait"];
    await store.save(next);

    const saved = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved.futureRoot).toBe("keep");
    expect(saved.webSearch).toMatchObject({
      enabled: true,
      contextSize: "high",
      futureNested: { keep: true },
      sidecarModel: {
        provider: "openai",
        model: "gpt-5",
        futureModelKey: "keep-model",
      },
    });
    expect(saved.remoteCompaction).toEqual({
      enabled: true,
      futureNested: "keep",
    });
    expect(saved.imageGeneration).toEqual({
      enabled: true,
      futureNested: "keep",
    });
    expect(saved.applyPatch).toEqual({
      enabled: true,
      futureNested: "keep",
    });
    expect(saved.computerUse).toEqual({
      enabled: true,
      approvalMode: "always",
      futureNested: "keep",
    });
    expect(saved.shellSessions).toEqual({
      enabled: true,
      futureNested: "keep",
    });
    expect(saved.codeMode).toEqual({
      enabled: true,
      approvalMode: "always",
      futureNested: "keep",
    });
    expect(saved.toolDiscovery).toEqual({
      enabled: true,
      deferred: ["exec_command", "wait"],
      futureNested: "keep",
    });
    expect(
      (await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});

const SECTION_KEYS = [
  "webSearch",
  "remoteCompaction",
  "imageGeneration",
  "applyPatch",
  "computerUse",
  "shellSessions",
  "codeMode",
  "toolDiscovery",
] as const;

const DEFAULT_SAVED_JSON = `{
  "webSearch": {
    "enabled": false,
    "backend": "auto",
    "mode": "live",
    "contextSize": "medium",
    "sidecarModel": null
  },
  "remoteCompaction": {
    "enabled": false
  },
  "imageGeneration": {
    "enabled": false
  },
  "applyPatch": {
    "enabled": false
  },
  "computerUse": {
    "enabled": false,
    "approvalMode": "confirm"
  },
  "shellSessions": {
    "enabled": false
  },
  "codeMode": {
    "enabled": false,
    "approvalMode": "confirm"
  },
  "toolDiscovery": {
    "enabled": false,
    "deferred": [
      "openai_generate_image",
      "computer_use_list_apps",
      "computer_use_get_app_state",
      "computer_use_click",
      "computer_use_type_text",
      "computer_use_press_key",
      "computer_use_scroll"
    ]
  },
  "debug": false
}
`;

describe("configuration section characterization", () => {
  it.each(SECTION_KEYS)(
    "rejects a null %s section with its path in the detail",
    (key) => {
      expect(() => parseConfig({ [key]: null })).toThrow(
        new Error(`${key} must be an object`),
      );
    },
  );

  it.each(SECTION_KEYS)(
    "rejects a non-record %s section with its path in the detail",
    (key) => {
      for (const value of ["x", 1, true, [], [{}]]) {
        expect(() => parseConfig({ [key]: value })).toThrow(
          new Error(`${key} must be an object`),
        );
      }
    },
  );

  it("saves the default configuration as a golden JSON document", async () => {
    const path = await configPath();
    const store = new ConfigStore(path);
    const snapshot = await store.save(defaultConfig());
    await expect(readFile(path, "utf8")).resolves.toBe(DEFAULT_SAVED_JSON);
    expect(`${JSON.stringify(snapshot.raw, null, 2)}\n`).toBe(
      DEFAULT_SAVED_JSON,
    );
    expect(snapshot.config).toEqual(defaultConfig());
    expect(Object.keys(snapshot.raw)).toEqual([...SECTION_KEYS, "debug"]);
  });

  it("fills absent stored sections on save while keeping unknown root keys", async () => {
    const path = await configPath();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, '{"futureRoot":"keep","debug":true}\n', "utf8");
    const store = new ConfigStore(path);
    await store.load();
    const snapshot = await store.save(defaultConfig());
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved).toStrictEqual({
      futureRoot: "keep",
      ...JSON.parse(DEFAULT_SAVED_JSON),
    });
    // Stored root keys keep their original position through the raw spread;
    // `debug` was already present, so it is reassigned in place.
    expect(Object.keys(saved)).toEqual([
      "futureRoot",
      "debug",
      ...SECTION_KEYS,
    ]);
    expect(snapshot.raw).toStrictEqual(saved);
  });

  it("refuses to save over a stored non-record section because load already rejected it", async () => {
    const path = await configPath();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(path, ".."), { recursive: true });
    const stored = '{"webSearch":"x","futureRoot":"keep"}\n';
    await writeFile(path, stored, "utf8");
    const store = new ConfigStore(path);
    const loaded = await store.load();
    expect(loaded.readError).toBe("invalid-config");
    expect(loaded.config).toEqual(defaultConfig());
    await expect(store.save(defaultConfig())).rejects.toThrow(/Refusing/);
    await expect(readFile(path, "utf8")).resolves.toBe(stored);
  });

  it("drops a stored sidecar model with unknown keys when the selector is null", async () => {
    const path = await configPath();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        webSearch: {
          enabled: true,
          futureNested: { keep: true },
          sidecarModel: {
            provider: "openai-codex",
            model: "gpt-5.4",
            thinkingLevel: "high",
            futureModelKey: "keep-model",
          },
        },
      })}\n`,
      "utf8",
    );
    const store = new ConfigStore(path);
    const loaded = await store.load();
    expect(loaded.config.webSearch.sidecarModel).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
      thinkingLevel: "high",
    });

    await store.save(defaultConfig());
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved.webSearch).toStrictEqual({
      enabled: false,
      futureNested: { keep: true },
      sidecarModel: null,
      backend: "auto",
      mode: "live",
      contextSize: "medium",
    });
    expect(Object.keys(saved.webSearch as object)).toEqual([
      "enabled",
      "futureNested",
      "sidecarModel",
      "backend",
      "mode",
      "contextSize",
    ]);
  });

  it("removes the temporary file and leaves the target untouched when rename fails", async () => {
    const path = await configPath();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "occupant.txt"), "occupied", "utf8");
    const store = new ConfigStore(path);
    const before = store.snapshot;

    await expect(store.save(defaultConfig())).rejects.toMatchObject({
      code: "EISDIR",
    });

    expect(
      (await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    await expect(readdir(path)).resolves.toEqual(["occupant.txt"]);
    await expect(readFile(join(path, "occupant.txt"), "utf8")).resolves.toBe(
      "occupied",
    );
    expect(store.snapshot).toBe(before);
    expect(store.snapshot).toEqual({ config: defaultConfig(), raw: {} });
  });

  it("parses model rules and ignores leftover enabled flags as extra keys", () => {
    const parsed = parseConfig({
      applyPatch: { enabled: true },
      shellSessions: { enabled: true },
      codeMode: { enabled: true, approvalMode: "always" },
      execution: {
        version: 1,
        rules: [
          {
            id: "astra",
            match: "gpt-6-astra",
            patch: true,
            shell: false,
            code: true,
          },
        ],
      },
    });
    expect(parsed.config.execution).toEqual({
      version: 1,
      rules: [
        {
          id: "astra",
          match: "gpt-6-astra",
          patch: true,
          shell: false,
          code: true,
        },
      ],
    });
    expect(parsed.config.codeMode.approvalMode).toBe("always");
  });

  it("writes rules without legacy enabled flags and preserves approval", async () => {
    const path = await configPath();
    const store = new ConfigStore(path);
    const next = defaultConfig();
    next.codeMode.approvalMode = "always";
    next.execution = {
      version: 1,
      rules: [
        {
          id: "grok",
          match: "grok*",
          patch: true,
          shell: true,
          code: false,
        },
      ],
    };
    await store.save(next);
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved.execution).toEqual({
      version: 1,
      rules: [
        {
          id: "grok",
          match: "grok*",
          patch: true,
          shell: true,
          code: false,
        },
      ],
    });
    expect(saved.applyPatch).toEqual({});
    expect(saved.shellSessions).toEqual({});
    expect(saved.codeMode).toEqual({ approvalMode: "always" });
    expect(store.snapshot.config.applyPatch.enabled).toBe(false);
    expect(store.snapshot.config.shellSessions.enabled).toBe(false);
    expect(store.snapshot.config.codeMode).toEqual({
      enabled: false,
      approvalMode: "always",
    });
  });

  it("rejects a stale expected revision and leaves the file unchanged", async () => {
    const path = await configPath();
    const store = new ConfigStore(path);
    await store.save({ ...defaultConfig(), debug: true });
    const revision = store.revision;
    await writeFile(
      path,
      `${JSON.stringify({ debug: false }, null, 2)}\n`,
      "utf8",
    );
    await expect(
      store.save(
        { ...defaultConfig(), debug: true },
        { expectedRevision: revision },
      ),
    ).rejects.toEqual(
      new ConfigSaveError(
        "stale-revision",
        "Could not save: the configuration file changed; reload and review the draft.",
      ),
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ debug: false });
  });

  it("clears a leftover lock from this process and saves", async () => {
    const path = await configPath();
    await mkdir(dirname(path), { recursive: true });
    await writeLockOwner(path, { pid: process.pid });
    const store = new ConfigStore(path);
    await store.save({ ...defaultConfig(), debug: true });
    expect(JSON.parse(await readFile(path, "utf8")).debug).toBe(true);
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes same-process saves so the loser rejects stale-revision", async () => {
    const path = await storedConfig("{}\n");
    const a = new ConfigStore(path);
    const b = new ConfigStore(path);
    await Promise.all([a.load(), b.load()]);

    const results = await Promise.allSettled([
      a.save(
        { ...defaultConfig(), debug: true },
        { expectedRevision: a.revision },
      ),
      b.save(
        {
          ...defaultConfig(),
          webSearch: { ...defaultConfig().webSearch, enabled: true },
        },
        { expectedRevision: b.revision },
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toEqual(
      new ConfigSaveError(
        "stale-revision",
        "Could not save: the configuration file changed; reload and review the draft.",
      ),
    );
    // Exactly one draft won; the file holds whichever serialized save ran last.
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect((saved.debug === true) !== (saved.webSearch.enabled === true)).toBe(
      true,
    );
  });

  it("serializes saves across independently loaded module instances", async () => {
    // Pi's loader evaluates each extension load with moduleCache: false, so a
    // second module instance gets fresh module state — but the save queue and
    // the live-token registry are process-global, so a concurrent save still
    // loses to stale-revision instead of stealing the lock.
    const path = await storedConfig("{}\n");
    vi.resetModules();
    const fresh = await import("../src/config.ts");
    expect(fresh.ConfigStore).not.toBe(ConfigStore);
    const a = new ConfigStore(path);
    const b = new fresh.ConfigStore(path);
    await Promise.all([a.load(), b.load()]);

    const results = await Promise.allSettled([
      a.save(
        { ...defaultConfig(), debug: true },
        { expectedRevision: a.revision },
      ),
      b.save(
        {
          ...defaultConfig(),
          webSearch: { ...defaultConfig().webSearch, enabled: true },
        },
        { expectedRevision: b.revision },
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "stale-revision",
    });
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect((saved.debug === true) !== (saved.webSearch.enabled === true)).toBe(
      true,
    );
  });

  it("reclaims a dead process's lock without removing the lock directory", async () => {
    const path = await storedConfig("{}\n");
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => exited.on("exit", resolve));
    const deadPid = exited.pid;
    if (deadPid === undefined) throw new Error("spawned child had no pid");
    expect(() => process.kill(deadPid, 0)).toThrow();
    await writeLockOwner(path, { pid: deadPid, token: "dead-owner" });
    const store = new ConfigStore(path);
    await store.load();

    await store.save({ ...defaultConfig(), debug: true });

    expect(JSON.parse(await readFile(path, "utf8")).debug).toBe(true);
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(dirname(path))).resolves.toEqual([
      "pi-codex-toolkit.json",
    ]);
  });

  it("converts a leftover file lock from a dead writer into a directory lock", async () => {
    const path = await storedConfig("{}\n");
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => exited.on("exit", resolve));
    const deadPid = exited.pid;
    if (deadPid === undefined) throw new Error("spawned child had no pid");
    await writeFile(
      `${path}.lock`,
      `${JSON.stringify({ pid: deadPid, token: "dead-file" })}\n`,
      "utf8",
    );
    const store = new ConfigStore(path);
    await store.load();
    await store.save({ ...defaultConfig(), debug: true });
    expect(JSON.parse(await readFile(path, "utf8")).debug).toBe(true);
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the lock directory present while a live owner holds it", async () => {
    const path = await storedConfig("{}\n");
    const lockPath = await writeLockOwner(path, {
      pid: process.pid,
      token: "replacement-owner",
    });
    const key = Symbol.for("pi-codex-toolkit.config-lock-tokens");
    const scope = globalThis as Record<symbol, unknown>;
    if (!(scope[key] instanceof Set)) scope[key] = new Set<string>();
    const tokens = scope[key] as Set<string>;
    tokens.add("replacement-owner");
    try {
      const store = new ConfigStore(path);
      await store.load();
      // The stop is actionable: it names the lock directory and reports the
      // recorded owner as still running, so nothing may be removed.
      await expect(store.save(defaultConfig())).rejects.toEqual(
        new ConfigSaveError(
          "lock-held",
          `Could not save: the configuration lock ${lockPath} is held by pid ${process.pid} (running). If no other Pi process with this Toolkit is saving, remove that directory and retry.`,
        ),
      );
      expect((await stat(lockPath)).isDirectory()).toBe(true);
      await expect(readFile(join(lockPath, "owner"), "utf8")).resolves.toBe(
        `${JSON.stringify({ pid: process.pid, token: "replacement-owner" })}\n`,
      );
      await expect(readFile(path, "utf8")).resolves.toBe("{}\n");
    } finally {
      tokens.delete("replacement-owner");
    }
  });

  it("fails closed on a same-process lock whose token is registered live", async () => {
    const path = await storedConfig("{}\n");
    // The live-token registry is process-global; seed it directly because the
    // shared save queue makes this state unreachable through public saves.
    const key = Symbol.for("pi-codex-toolkit.config-lock-tokens");
    const scope = globalThis as Record<symbol, unknown>;
    if (!(scope[key] instanceof Set)) scope[key] = new Set<string>();
    const tokens = scope[key] as Set<string>;
    tokens.add("live-owner-token");
    try {
      await writeLockOwner(path, {
        pid: process.pid,
        token: "live-owner-token",
      });
      const store = new ConfigStore(path);
      await store.load();

      await expect(store.save(defaultConfig())).rejects.toEqual(
        new ConfigSaveError(
          "lock-held",
          `Could not save: the configuration lock ${path}.lock is held by pid ${process.pid} (running). If no other Pi process with this Toolkit is saving, remove that directory and retry.`,
        ),
      );
      // A live same-process owner's lock is never claimed or unlinked.
      await expect(
        readFile(join(`${path}.lock`, "owner"), "utf8"),
      ).resolves.toContain("live-owner-token");
    } finally {
      tokens.delete("live-owner-token");
    }
  });

  it("fails closed when a leftover reclaim directory still has an owner", async () => {
    const path = await storedConfig("{}\n");
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => exited.on("exit", resolve));
    const deadPid = exited.pid;
    if (deadPid === undefined) throw new Error("spawned child had no pid");
    expect(() => process.kill(deadPid, 0)).toThrow();
    const lockPath = await writeLockOwner(path, {
      pid: deadPid,
      token: "dead-owner",
    });
    await mkdir(join(lockPath, "reclaim"));
    await writeFile(
      join(lockPath, "reclaim", "owner"),
      `${JSON.stringify({ pid: deadPid, token: "dead-reclaim" })}\n`,
      "utf8",
    );
    const store = new ConfigStore(path);
    await store.load();
    // The refusal reports the recorded owner as not running, which is what
    // tells an operator this leftover may be removed deliberately.
    await expect(store.save(defaultConfig())).rejects.toEqual(
      new ConfigSaveError(
        "lock-held",
        `Could not save: the configuration lock ${lockPath} is held by pid ${deadPid} (not running). If no other Pi process with this Toolkit is saving, remove that directory and retry.`,
      ),
    );
    await expect(readFile(path, "utf8")).resolves.toBe("{}" + "\n");
    await expect(
      readFile(join(lockPath, "reclaim", "owner"), "utf8"),
    ).resolves.toBe(
      `${JSON.stringify({ pid: deadPid, token: "dead-reclaim" })}\n`,
    );
  });

  it("names the lock directory when its owner record cannot be parsed", async () => {
    const path = await storedConfig("{}\n");
    const lockPath = `${path}.lock`;
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner"), "not-json\n", "utf8");
    const store = new ConfigStore(path);
    await store.load();

    await expect(store.save(defaultConfig())).rejects.toEqual(
      new ConfigSaveError(
        "lock-held",
        `Could not save: the configuration lock ${lockPath} exists but has no readable owner record. If no other Pi process with this Toolkit is saving, remove that directory and retry.`,
      ),
    );
    // An unverifiable owner is never taken over.
    await expect(readFile(join(lockPath, "owner"), "utf8")).resolves.toBe(
      "not-json\n",
    );
    await expect(readFile(path, "utf8")).resolves.toBe("{}\n");
  });

  it("recovers after an empty leftover reclaim directory", async () => {
    const path = await storedConfig("{}\n");
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => exited.on("exit", resolve));
    const deadPid = exited.pid;
    if (deadPid === undefined) throw new Error("spawned child had no pid");
    const lockPath = await writeLockOwner(path, {
      pid: deadPid,
      token: "dead-owner",
    });
    await mkdir(join(lockPath, "reclaim"));
    const store = new ConfigStore(path);
    await store.load();
    await store.save({ ...defaultConfig(), debug: true });
    expect(JSON.parse(await readFile(path, "utf8")).debug).toBe(true);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a live foreign lock and leaves it in place", async () => {
    const path = await storedConfig("{}\n");
    // PID 1 is always alive, so this lock belongs to another live writer.
    await writeLockOwner(path, { pid: 1, token: "foreign-token" });
    const store = new ConfigStore(path);
    await store.load();

    await expect(store.save(defaultConfig())).rejects.toEqual(
      new ConfigSaveError(
        "lock-held",
        `Could not save: the configuration lock ${path}.lock is held by pid 1 (running). If no other Pi process with this Toolkit is saving, remove that directory and retry.`,
      ),
    );
    // Neither acquire nor release removed the foreign writer's lock.
    await expect(
      readFile(join(`${path}.lock`, "owner"), "utf8"),
    ).resolves.toContain('"token":"foreign-token"');
  });

  it("does not unlink the lock when its stored token changed under a save", async () => {
    const path = await configPath();
    const store = new ConfigStore(path);
    // The first readFile call inside save() is the config re-read (ENOENT); the
    // second is the release-time owner read, which reports a foreign token —
    // simulating another writer replacing our lock between acquire and
    // release. The real owner file on disk is still our own acquisition.
    vi.mocked(readFile)
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), { code: "ENOENT" }),
      )
      .mockResolvedValueOnce(
        `${JSON.stringify({ pid: process.pid, token: "stolen" })}\n`,
      );

    await store.save({ ...defaultConfig(), debug: true });

    // Token-verified release left the directory alone instead of removing it.
    await expect(
      readFile(join(`${path}.lock`, "owner"), "utf8"),
    ).resolves.toContain('"token"');
  });
});

describe("configuration read errors", () => {
  it("records an invalid-config detail without the invalid value and leaves the file untouched", async () => {
    const path = await storedConfig(INVALID_APPLY_PATCH);
    const store = new ConfigStore(path);

    await expect(store.load()).resolves.toStrictEqual({
      config: defaultConfig(),
      raw: {},
      readError: "invalid-config",
      readErrorDetail: "applyPatch.enabled must be true or false",
    });
    expect(store.hasLastKnownGood).toBe(false);
    await expect(readFile(path, "utf8")).resolves.toBe(INVALID_APPLY_PATCH);
  });

  it("records the Node error code of a failed read", async () => {
    const path = await configPath();
    await mkdir(path, { recursive: true });
    const store = new ConfigStore(path);

    await expect(store.load()).resolves.toStrictEqual({
      config: defaultConfig(),
      raw: {},
      readError: "config-read-failed",
      readErrorDetail: "EISDIR",
    });
    expect(store.hasLastKnownGood).toBe(false);
  });

  it("records no detail for invalid JSON, whose parser message quotes the file", async () => {
    const path = await storedConfig('{"debug": secret-value');
    const store = new ConfigStore(path);

    await expect(store.load()).resolves.toStrictEqual({
      config: defaultConfig(),
      raw: {},
      readError: "invalid-json",
    });
  });

  it("counts a missing file as a valid load of the all-off defaults", async () => {
    const store = new ConfigStore(await configPath());
    expect(store.hasLastKnownGood).toBe(false);

    await expect(store.load()).resolves.toStrictEqual({
      config: defaultConfig(),
      raw: {},
    });
    expect(store.hasLastKnownGood).toBe(true);
  });

  it("counts a successful save as a valid snapshot", async () => {
    const store = new ConfigStore(await configPath());
    expect(store.hasLastKnownGood).toBe(false);

    await store.save({ ...defaultConfig(), debug: true });

    expect(store.hasLastKnownGood).toBe(true);
  });

  it("does not keep an invalid-config detail when invalid JSON follows", async () => {
    const path = await storedConfig(INVALID_APPLY_PATCH);
    const store = new ConfigStore(path);
    await expect(store.load()).resolves.toMatchObject({
      readErrorDetail: "applyPatch.enabled must be true or false",
    });

    await writeFile(path, "{invalid", "utf8");

    await expect(store.load()).resolves.toStrictEqual({
      config: defaultConfig(),
      raw: {},
      readError: "invalid-json",
    });
  });

  it("does not keep an invalid-config detail when a read fails without an error code", async () => {
    const path = await storedConfig(INVALID_APPLY_PATCH);
    const store = new ConfigStore(path);
    await expect(store.load()).resolves.toMatchObject({
      readErrorDetail: "applyPatch.enabled must be true or false",
    });

    vi.mocked(readFile).mockRejectedValueOnce(new Error("unreadable"));

    await expect(store.load()).resolves.toStrictEqual({
      config: defaultConfig(),
      raw: {},
      readError: "config-read-failed",
    });
  });

  it("does not keep a read-failure code when invalid JSON follows", async () => {
    const path = await configPath();
    await mkdir(path, { recursive: true });
    const store = new ConfigStore(path);
    await expect(store.load()).resolves.toMatchObject({
      readErrorDetail: "EISDIR",
    });

    const { rm } = await import("node:fs/promises");
    await rm(path, { recursive: true });
    await writeFile(path, "{invalid", "utf8");

    await expect(store.load()).resolves.toStrictEqual({
      config: defaultConfig(),
      raw: {},
      readError: "invalid-json",
    });
  });

  it("clears the read error and its detail when a valid file follows", async () => {
    const path = await storedConfig(INVALID_APPLY_PATCH);
    const store = new ConfigStore(path);
    await expect(store.load()).resolves.toMatchObject({
      readErrorDetail: "applyPatch.enabled must be true or false",
    });

    await writeFile(path, '{"debug":true}\n', "utf8");

    await expect(store.load()).resolves.toStrictEqual({
      config: { ...defaultConfig(), debug: true },
      raw: { debug: true },
    });
    expect(store.hasLastKnownGood).toBe(true);
  });
});
