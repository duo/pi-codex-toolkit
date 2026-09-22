import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerCommands } from "../src/commands.ts";
import {
  ConfigStore,
  ConfigValidationError,
  defaultConfig,
} from "../src/config.ts";
import {
  EXECUTION_SCHEMA_VERSION,
  formatExecutionStatus,
} from "../src/execution-mode.ts";
import {
  inspectExecutionAdmission,
  resolveToolkitRoutes,
} from "../src/index.ts";
import { codexModel, model } from "./fixtures.ts";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<ConfigStore> {
  const directory = await mkdtemp(join(tmpdir(), "pct-commands-"));
  temporaryDirectories.push(directory);
  const store = new ConfigStore(join(directory, "pi-codex-toolkit.json"));
  await store.load();
  return store;
}

/** A store over the given file contents that has not loaded anything yet. */
async function coldStore(contents: string): Promise<ConfigStore> {
  const directory = await mkdtemp(join(tmpdir(), "pct-commands-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "pi-codex-toolkit.json");
  await writeFile(path, contents, "utf8");
  return new ConfigStore(path);
}

const INVALID_APPLY_PATCH =
  '{"webSearch":{"enabled":true},"applyPatch":{"enabled":"yes"}}\n';
const INVALID_APPLY_PATCH_ERROR =
  "Pi Codex Toolkit config error: invalid-config (applyPatch.enabled must be true or false);";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PREVIEW_SOURCE = "/extension/src/index.ts";
const OWNED_PREVIEW_TOOLS = [
  "apply_patch",
  "exec_command",
  "write_stdin",
  "exec",
  "wait",
].map((name) => ({
  name,
  description: `${name} tool`,
  parameters: { type: "object" },
  sourceInfo: {
    path: PREVIEW_SOURCE,
    source: "test",
    scope: "user" as const,
    origin: "package" as const,
  },
}));

function commandHarness(input: {
  store: ConfigStore;
  choices?: Array<string | undefined>;
  hasUI?: boolean;
  syncError?: Error;
  availableModels?: Model<any>[];
  scopedModels?: Array<{ model: Model<any>; thinkingLevel?: string }>;
  /** Tools projected in `getAllTools()` for the execution-rule preview. */
  previewTools?: typeof OWNED_PREVIEW_TOOLS;
}) {
  let handler: RegisteredCommand["handler"] | undefined;
  const notify = vi.fn();
  const select = vi.fn(async () => input.choices?.shift());
  const stderr = vi.fn();
  const sync = vi.fn(async () => {
    if (input.syncError) throw input.syncError;
  });
  registerCommands(
    {
      registerCommand: (_name, options) => {
        handler = options.handler;
      },
    },
    {
      store: input.store,
      sync,
      status: () => "status projection",
      // Same pipeline as production: draft rules resolve through the real
      // route resolver against the supplied admission state.
      describeExecutionPreview: (rules, ctx) =>
        formatExecutionStatus(
          resolveToolkitRoutes(
            {
              ...input.store.snapshot.config,
              execution: {
                version: EXECUTION_SCHEMA_VERSION,
                rules: rules.map((rule) => ({ ...rule })),
              },
            },
            ctx.model,
            inspectExecutionAdmission(
              input.previewTools ?? OWNED_PREVIEW_TOOLS,
              PREVIEW_SOURCE,
            ),
          ),
        ),
      stderr,
    },
  );
  const ctx = {
    hasUI: input.hasUI ?? true,
    model: { provider: "openai-codex", id: "gpt-6-astra" },
    ui: { notify, select, input: select },
    scopedModels: input.scopedModels ?? [],
    modelRegistry: {
      getAvailable: () => input.availableModels ?? [],
      isUsingOAuth: (candidate: Model<any>) =>
        candidate.provider === "openai-codex",
    },
  } as unknown as ExtensionCommandContext;
  if (!handler) throw new Error("pct command was not registered");
  return { handler, ctx, notify, select, stderr, sync };
}

describe("/pct commands", () => {
  it("uses a small selection loop, saves, and synchronizes", async () => {
    const store = await createStore();
    const harness = commandHarness({
      store,
      choices: [
        "Web Search: off",
        "Remote Compaction: off",
        "Image Generation: off",
        "Computer Use: off",
        "Computer Use approval: Confirm",
        "Always",
        "Debug metadata: off",
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(store.snapshot.config.webSearch.enabled).toBe(true);
    expect(store.snapshot.config.remoteCompaction.enabled).toBe(true);
    expect(store.snapshot.config.imageGeneration.enabled).toBe(true);
    expect(store.snapshot.config.computerUse.enabled).toBe(true);
    expect(store.snapshot.config.computerUse.approvalMode).toBe("always");
    expect(store.snapshot.config.debug).toBe(true);
    expect(harness.select).toHaveBeenCalledWith("Computer Use approval", [
      "Confirm",
      "Always",
    ]);
    expect(harness.sync).toHaveBeenCalledOnce();
    expect(harness.notify).toHaveBeenCalledWith(
      "Pi Codex Toolkit configuration saved.",
      "info",
    );
    const saved = JSON.parse(await readFile(store.path, "utf8"));
    expect(saved.webSearch.enabled).toBe(true);
    expect(saved.remoteCompaction.enabled).toBe(true);
    expect(saved.imageGeneration.enabled).toBe(true);
    expect(saved.computerUse.enabled).toBe(true);
    expect(saved.computerUse.approvalMode).toBe("always");
  });

  it("keeps Code Mode nested Apply Patch confirmation without a Code enable switch", async () => {
    const store = await createStore();
    const harness = commandHarness({
      store,
      choices: [
        "Code Mode nested Apply Patch confirmation: Confirm",
        "Always",
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(store.snapshot.config.codeMode.approvalMode).toBe("always");
    expect(harness.select).toHaveBeenCalledWith(
      "Pi Codex Toolkit",
      expect.arrayContaining([
        "Execution rules: none (native baseline)",
        "Code Mode nested Apply Patch confirmation: Confirm",
      ]),
    );
    expect(harness.select).toHaveBeenCalledWith(
      "Code Mode nested Apply Patch confirmation",
      ["Confirm", "Always"],
    );
    expect(harness.sync).toHaveBeenCalledOnce();
    const saved = JSON.parse(await readFile(store.path, "utf8"));
    expect(saved.codeMode).toMatchObject({
      enabled: false,
      approvalMode: "always",
    });
  });

  it("migrates empty legacy flags to an empty rule list on save", async () => {
    const store = await createStore();
    const harness = commandHarness({
      store,
      choices: ["Execution rules: none (native baseline)", "Back", "Save"],
    });

    await harness.handler("config", harness.ctx);

    expect(store.snapshot.config.execution).toEqual({ version: 1, rules: [] });
    expect(harness.notify).toHaveBeenCalledWith(
      "Save will store an empty rule list (native baseline) and remove the legacy Apply Patch / Shell / Code switches.",
      "info",
    );
    const saved = JSON.parse(await readFile(store.path, "utf8"));
    expect(saved.execution).toEqual({ version: 1, rules: [] });
    expect(saved.applyPatch).toEqual({});
  });

  it("adds, previews, and saves a Code rule", async () => {
    const store = await createStore();
    const harness = commandHarness({
      store,
      choices: [
        "Execution rules: none (native baseline)",
        "Add rule",
        "match: *",
        "gpt-6-astra",
        "Patch: off",
        "on",
        "Code: off",
        "on",
        "Done",
        "Preview current model",
        "Back",
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(store.snapshot.config.execution).toEqual({
      version: 1,
      rules: [
        {
          id: "rule-1",
          match: "gpt-6-astra",
          patch: true,
          shell: false,
          code: true,
        },
      ],
    });
    // The preview resolves the draft through the real route resolver, so the
    // winning rule, requested flags, and effective routes are all visible.
    expect(harness.notify).toHaveBeenCalledWith(
      "Current model openai-codex/gpt-6-astra →\n" +
        "Execution rules:\n" +
        "  schema: rules\n" +
        "  rule: rule-1\n" +
        "  requested: P+C\n" +
        "  effective: nestedPatch+code\n" +
        "  hide bash: yes\n" +
        "  hide edit/write: yes\n" +
        "  notes: ",
      "info",
    );
  });

  it("reorders and deletes rules on a saved schema", async () => {
    const store = await createStore();
    await store.save({
      ...defaultConfig(),
      execution: {
        version: 1,
        rules: [
          { id: "a", match: "a*", patch: true, shell: false, code: false },
          { id: "b", match: "b*", patch: false, shell: true, code: false },
        ],
      },
    });
    const harness = commandHarness({
      store,
      choices: [
        "Execution rules: 2 rules",
        "Move rule down",
        "1. a  a*  P",
        "Delete rule",
        "1. b  b*  S",
        "Back",
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(store.snapshot.config.execution?.rules).toEqual([
      { id: "a", match: "a*", patch: true, shell: false, code: false },
    ]);
  });

  it("keeps the draft when a stale save is rejected", async () => {
    const store = await createStore();
    const harness = commandHarness({
      store,
      choices: ["Debug metadata: off", "Save", "Cancel"],
    });
    await writeFile(
      store.path,
      `${JSON.stringify({ debug: false }, null, 2)}\n`,
      "utf8",
    );

    await harness.handler("config", harness.ctx);

    expect(harness.notify).toHaveBeenCalledWith(
      "Could not save: the configuration file changed; reload and review the draft.",
      "error",
    );
    expect(harness.sync).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual({
      debug: false,
    });
  });

  // Starting from a saved Always, the Confirm choice must write confirm rather
  // than leave the stored value in place.
  it.each([
    ["Computer Use approval", "computerUse"],
    ["Code Mode nested Apply Patch confirmation", "codeMode"],
  ] as const)(
    "saves Confirm from the %s menu over a saved Always",
    async (menu, section) => {
      const store = await createStore();
      const config = defaultConfig();
      config[section].approvalMode = "always";
      await store.save(config);
      expect(store.snapshot.config[section].approvalMode).toBe("always");
      const harness = commandHarness({
        store,
        choices: [`${menu}: Always`, "Confirm", "Save"],
      });

      await harness.handler("config", harness.ctx);

      expect(store.snapshot.config[section]).toEqual({
        enabled: false,
        approvalMode: "confirm",
      });
      const saved = JSON.parse(await readFile(store.path, "utf8"));
      expect(saved[section]).toEqual({
        enabled: false,
        approvalMode: "confirm",
      });
    },
  );

  it("toggles Tool Discovery from the config menu and keeps the deferred list file-level", async () => {
    const store = await createStore();
    const harness = commandHarness({
      store,
      choices: ["Tool Discovery: off", "Save"],
    });

    await harness.handler("config", harness.ctx);

    expect(store.snapshot.config.toolDiscovery.enabled).toBe(true);
    // The menu exposes only the switch; the deferred set stays a file-level
    // setting.
    expect(store.snapshot.config.toolDiscovery.deferred).toEqual([
      "openai_generate_image",
      "computer_use_list_apps",
      "computer_use_get_app_state",
      "computer_use_click",
      "computer_use_type_text",
      "computer_use_press_key",
      "computer_use_scroll",
    ]);
    expect(harness.select).toHaveBeenCalledWith(
      "Pi Codex Toolkit",
      expect.arrayContaining(["Tool Discovery: off"]),
    );
    expect(harness.sync).toHaveBeenCalledOnce();
    const saved = JSON.parse(await readFile(store.path, "utf8"));
    expect(saved.toolDiscovery).toMatchObject({
      enabled: true,
      deferred: expect.arrayContaining(["openai_generate_image"]),
    });
  });

  it("does not save a cancelled Computer Use approval change", async () => {
    const store = await createStore();
    const harness = commandHarness({
      store,
      choices: ["Computer Use approval: Confirm", "Always", "Cancel"],
    });

    await harness.handler("config", harness.ctx);

    expect(store.snapshot.config.computerUse.approvalMode).toBe("confirm");
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it("configures a scoped Codex OAuth Web Search model and independent effort", async () => {
    const store = await createStore();
    const oauth = codexModel({
      id: "gpt-5.4",
      thinkingLevelMap: { minimal: "low", xhigh: null, max: null },
    });
    const apiKey = model();
    const harness = commandHarness({
      store,
      availableModels: [apiKey, oauth],
      scopedModels: [{ model: oauth, thinkingLevel: "high" }],
      choices: [
        "Web Search executor: none",
        "openai-codex/gpt-5.4",
        "Web Search executor effort: auto",
        "low",
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(store.snapshot.config.webSearch.sidecarModel).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
      thinkingLevel: "low",
    });
    expect(harness.select).toHaveBeenCalledWith("Web Search executor", [
      "None",
      "openai-codex/gpt-5.4",
    ]);
    expect(harness.select).toHaveBeenCalledWith("Web Search executor effort", [
      "auto",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("omits a scoped executor that is no longer available", async () => {
    const store = await createStore();
    const oauth = codexModel({ id: "gpt-5.4" });
    const harness = commandHarness({
      store,
      availableModels: [],
      scopedModels: [{ model: oauth }],
      choices: ["Web Search executor: none", undefined],
    });

    await harness.handler("config", harness.ctx);

    expect(harness.select).toHaveBeenCalledWith("Web Search executor", [
      "None",
    ]);
  });

  it("offers only automatic effort for an API-key executor", async () => {
    const store = await createStore();
    const apiKey = model();
    const harness = commandHarness({
      store,
      availableModels: [apiKey],
      choices: [
        "Web Search executor: none",
        "openai/gpt-5",
        "Web Search executor effort: auto",
        "auto",
        "Cancel",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(harness.select).toHaveBeenCalledWith("Web Search executor effort", [
      "auto",
    ]);
  });

  it("does not claim a successful save left the file untouched when synchronization fails", async () => {
    const store = await createStore();
    const harness = commandHarness({
      store,
      choices: ["Web Search: off", "Save"],
      syncError: new Error("sync failed"),
    });

    await expect(harness.handler("config", harness.ctx)).rejects.toThrow(
      "sync failed",
    );

    const saved = JSON.parse(await readFile(store.path, "utf8"));
    expect(saved.webSearch.enabled).toBe(true);
    expect(harness.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("left untouched"),
      "error",
    );
  });

  it("does not prompt or write in noninteractive config mode", async () => {
    const store = await createStore();
    const harness = commandHarness({ store, hasUI: false });
    await harness.handler("config", harness.ctx);
    expect(harness.select).not.toHaveBeenCalled();
    expect(harness.sync).not.toHaveBeenCalled();
    expect(harness.stderr).toHaveBeenCalledWith(
      `Pi Codex Toolkit config: ${store.path}`,
    );
  });

  it("prints status without synchronizing tools", async () => {
    const store = await createStore();
    const harness = commandHarness({ store, hasUI: false });
    await harness.handler("status", harness.ctx);
    expect(harness.stderr).toHaveBeenCalledWith("status projection");
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it("reloads last-known-good settings and reports an invalid edit", async () => {
    const store = await createStore();
    const config = defaultConfig();
    config.debug = true;
    await store.save(config);
    await mkdir(dirname(store.path), { recursive: true });
    await writeFile(store.path, "{invalid", "utf8");
    const harness = commandHarness({ store });

    await harness.handler("reload", harness.ctx);

    expect(store.snapshot.config.debug).toBe(true);
    expect(store.snapshot.readError).toBe("invalid-json");
    expect(harness.sync).toHaveBeenCalledOnce();
    expect(harness.notify).toHaveBeenCalledWith(
      "Pi Codex Toolkit config error: invalid-json; using last known good settings.",
      "warning",
    );
  });

  it("reports a cold invalid start with its detail and the all-off defaults", async () => {
    const store = await coldStore(INVALID_APPLY_PATCH);
    const harness = commandHarness({ store });

    await harness.handler("reload", harness.ctx);

    expect(store.snapshot.config).toEqual(defaultConfig());
    expect(harness.sync).toHaveBeenCalledOnce();
    expect(harness.notify.mock.calls).toEqual([
      [`${INVALID_APPLY_PATCH_ERROR} using all-off defaults.`, "warning"],
    ]);
    expect(harness.stderr).not.toHaveBeenCalled();
    await expect(readFile(store.path, "utf8")).resolves.toBe(
      INVALID_APPLY_PATCH,
    );
  });

  it("reports an invalid edit after a valid load with the last known good settings", async () => {
    const store = await coldStore('{"debug":true}\n');
    const harness = commandHarness({ store });
    await harness.handler("reload", harness.ctx);
    await writeFile(store.path, INVALID_APPLY_PATCH, "utf8");

    await harness.handler("reload", harness.ctx);

    expect(store.snapshot.config).toEqual({ ...defaultConfig(), debug: true });
    expect(harness.notify.mock.calls).toEqual([
      ["Pi Codex Toolkit configuration reloaded.", "info"],
      [
        `${INVALID_APPLY_PATCH_ERROR} using last known good settings.`,
        "warning",
      ],
    ]);
  });

  it("counts a missing file as a valid load when reporting an invalid edit", async () => {
    const store = await createStore();
    await writeFile(store.path, INVALID_APPLY_PATCH, "utf8");
    const harness = commandHarness({ store });

    await harness.handler("reload", harness.ctx);

    expect(store.snapshot.config).toEqual(defaultConfig());
    expect(harness.notify.mock.calls).toEqual([
      [
        `${INVALID_APPLY_PATCH_ERROR} using last known good settings.`,
        "warning",
      ],
    ]);
  });

  it("writes a cold read failure with its error code to stderr without a UI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pct-commands-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "pi-codex-toolkit.json");
    await mkdir(path);
    const harness = commandHarness({
      store: new ConfigStore(path),
      hasUI: false,
    });

    await harness.handler("reload", harness.ctx);

    expect(harness.stderr.mock.calls).toEqual([
      [
        "Pi Codex Toolkit config error: config-read-failed (EISDIR); using all-off defaults.",
      ],
    ]);
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("migrates enabled legacy flags to a catch-all rule", async () => {
    const store = await createStore();
    const config = defaultConfig();
    config.applyPatch.enabled = true;
    config.shellSessions.enabled = true;
    config.codeMode.enabled = true;
    await store.save(config);
    const harness = commandHarness({
      store,
      choices: [
        "Execution rules: legacy flags (open to migrate)",
        "Back",
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(store.snapshot.config.execution).toEqual({
      version: 1,
      rules: [
        {
          id: "migrated",
          match: "*",
          patch: true,
          shell: true,
          code: true,
        },
      ],
    });
    expect(harness.notify).toHaveBeenCalledWith(
      "Save will store one catch-all rule migrated (P+S+C) and remove the legacy enabled flags. Code-only also starts the nested Shell backend.",
      "info",
    );
  });

  // The preview is a draft, not a decision already taken: escaping the page
  // leaves the legacy flags — and the native tools they do not hide — in the
  // file, even when the menu is saved afterwards.
  it("keeps legacy flags when the seeded migration page is escaped", async () => {
    const store = await createStore();
    const config = defaultConfig();
    config.applyPatch.enabled = true;
    config.codeMode.enabled = true;
    await store.save(config);
    const harness = commandHarness({
      store,
      choices: [
        "Execution rules: legacy flags (open to migrate)",
        undefined,
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(harness.notify).toHaveBeenCalledWith(
      "Save will store one catch-all rule migrated (P+C) and remove the legacy enabled flags. Code-only also starts the nested Shell backend.",
      "info",
    );
    expect(store.snapshot.config.execution).toBeUndefined();
    expect(store.snapshot.config.applyPatch.enabled).toBe(true);
    expect(store.snapshot.config.codeMode.enabled).toBe(true);
    const saved = JSON.parse(await readFile(store.path, "utf8"));
    expect(saved.execution).toBeUndefined();
    expect(saved.applyPatch.enabled).toBe(true);
    expect(saved.codeMode.enabled).toBe(true);
  });

  it("moves a rule up and edits its id", async () => {
    const store = await createStore();
    await store.save({
      ...defaultConfig(),
      execution: {
        version: 1,
        rules: [
          { id: "a", match: "a*", patch: true, shell: false, code: false },
          { id: "b", match: "b*", patch: false, shell: true, code: false },
        ],
      },
    });
    const harness = commandHarness({
      store,
      choices: [
        "Execution rules: 2 rules",
        "Move rule up",
        "2. b  b*  S",
        "1. b  b*  S",
        "id: b",
        "grok",
        "Done",
        "Preview current model",
        "Back",
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(
      store.snapshot.config.execution?.rules.map((rule) => rule.id),
    ).toEqual(["grok", "a"]);
    expect(harness.notify).toHaveBeenCalledWith(
      "Current model openai-codex/gpt-6-astra →\n" +
        "Execution rules:\n" +
        "  schema: unmatched\n" +
        "  rule: —\n" +
        "  requested: none\n" +
        "  effective: native\n" +
        "  hide bash: no\n" +
        "  hide edit/write: no\n" +
        "  notes: ",
      "info",
    );
  });

  it("rejects a duplicate rule id at the editing boundary and keeps the draft", async () => {
    const store = await createStore();
    await store.save({
      ...defaultConfig(),
      execution: {
        version: 1,
        rules: [
          { id: "a", match: "a*", patch: true, shell: false, code: false },
          { id: "b", match: "b*", patch: false, shell: true, code: false },
        ],
      },
    });
    const harness = commandHarness({
      store,
      choices: [
        "Execution rules: 2 rules",
        "1. a  a*  P",
        "id: a",
        "b",
        "Done",
        "Back",
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(harness.notify).toHaveBeenCalledWith(
      'Rule id "b" is already used by another rule.',
      "error",
    );
    expect(
      store.snapshot.config.execution?.rules.map((rule) => rule.id),
    ).toEqual(["a", "b"]);
    const saved = JSON.parse(await readFile(store.path, "utf8"));
    expect(
      saved.execution.rules.map((rule: { id: string }) => rule.id),
    ).toEqual(["a", "b"]);
  });

  // Escape cancels the page it is pressed on: only Done keeps a rule's edits
  // and only Back keeps the rule list's changes.
  it("adds no rule when the new rule's page is escaped", async () => {
    const store = await createStore();
    await store.save({
      ...defaultConfig(),
      execution: {
        version: 1,
        rules: [
          { id: "a", match: "a*", patch: true, shell: false, code: false },
        ],
      },
    });
    const harness = commandHarness({
      store,
      choices: [
        "Execution rules: 1 rule",
        "Add rule",
        "Patch: off",
        "on",
        undefined,
        "Back",
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(store.snapshot.config.execution?.rules).toEqual([
      { id: "a", match: "a*", patch: true, shell: false, code: false },
    ]);
    const saved = JSON.parse(await readFile(store.path, "utf8"));
    expect(saved.execution.rules).toHaveLength(1);
  });

  it("discards one rule's edits when that rule's page is escaped", async () => {
    const store = await createStore();
    await store.save({
      ...defaultConfig(),
      execution: {
        version: 1,
        rules: [
          { id: "a", match: "a*", patch: true, shell: false, code: false },
        ],
      },
    });
    const harness = commandHarness({
      store,
      choices: [
        "Execution rules: 1 rule",
        "1. a  a*  P",
        "match: a*",
        "b*",
        "Code: off",
        "on",
        undefined,
        "Back",
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(store.snapshot.config.execution?.rules).toEqual([
      { id: "a", match: "a*", patch: true, shell: false, code: false },
    ]);
  });

  it("keeps the previous draft when the rule page itself is escaped", async () => {
    const store = await createStore();
    await store.save({
      ...defaultConfig(),
      execution: {
        version: 1,
        rules: [
          { id: "a", match: "a*", patch: true, shell: false, code: false },
          { id: "b", match: "b*", patch: false, shell: true, code: false },
        ],
      },
    });
    const harness = commandHarness({
      store,
      choices: [
        "Execution rules: 2 rules",
        "Delete rule",
        "1. a  a*  P",
        undefined,
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(
      store.snapshot.config.execution?.rules.map((rule) => rule.id),
    ).toEqual(["a", "b"]);
  });

  it("keeps the rule page's changes when it is left with Back", async () => {
    const store = await createStore();
    await store.save({
      ...defaultConfig(),
      execution: {
        version: 1,
        rules: [
          { id: "a", match: "a*", patch: true, shell: false, code: false },
          { id: "b", match: "b*", patch: false, shell: true, code: false },
        ],
      },
    });
    const harness = commandHarness({
      store,
      choices: [
        "Execution rules: 2 rules",
        "Delete rule",
        "1. a  a*  P",
        "Back",
        "Save",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(
      store.snapshot.config.execution?.rules.map((rule) => rule.id),
    ).toEqual(["b"]);
  });

  it("keeps the editor open with the validation message when a save is rejected", async () => {
    const store = await createStore();
    const harness = commandHarness({
      store,
      choices: ["Debug metadata: off", "Save", "Cancel"],
    });
    const save = vi
      .spyOn(store, "save")
      .mockRejectedValueOnce(
        new ConfigValidationError("execution.rules[1].id", "be unique"),
      );

    await harness.handler("config", harness.ctx);

    expect(harness.notify).toHaveBeenCalledWith(
      "execution.rules[1].id must be unique",
      "error",
    );
    expect(harness.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("left untouched"),
      "error",
    );
    // The draft survived: Cancel left the loop without saving, and no sync ran.
    expect(harness.sync).not.toHaveBeenCalled();
    save.mockRestore();
  });

  it("previews effective routes and admission notes for the current model", async () => {
    const store = await createStore();
    // exec_command is foreign-owned: a requested direct Shell route fails
    // admission, which the preview must show instead of the flags alone.
    const harness = commandHarness({
      store,
      previewTools: OWNED_PREVIEW_TOOLS.map((tool) =>
        tool.name === "exec_command"
          ? {
              ...tool,
              sourceInfo: {
                ...tool.sourceInfo,
                path: "/other/shell.ts",
              },
            }
          : tool,
      ),
      choices: [
        "Execution rules: none (native baseline)",
        "Add rule",
        "match: *",
        "gpt-6-astra",
        "Patch: off",
        "on",
        "direct Shell: off",
        "on",
        "Done",
        "Preview current model",
        "Back",
        "Cancel",
      ],
    });

    await harness.handler("config", harness.ctx);

    expect(harness.notify).toHaveBeenCalledWith(
      "Current model openai-codex/gpt-6-astra →\n" +
        "Execution rules:\n" +
        "  schema: rules\n" +
        "  rule: rule-1\n" +
        "  requested: P+S\n" +
        "  effective: directPatch\n" +
        "  hide bash: no\n" +
        "  hide edit/write: yes\n" +
        "  notes: shell-pair-unavailable",
      "info",
    );
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it("reports unknown subcommands", async () => {
    const store = await createStore();
    const harness = commandHarness({ store });
    await harness.handler("doctor", harness.ctx);
    expect(harness.notify).toHaveBeenCalledWith(
      "Usage: /pct [config|status|reload]",
      "warning",
    );
  });

  it("writes unknown subcommand usage to stderr without a UI", async () => {
    const store = await createStore();
    const harness = commandHarness({ store, hasUI: false });
    await harness.handler("doctor", harness.ctx);
    expect(harness.stderr).toHaveBeenCalledWith(
      "Usage: /pct [config|status|reload]",
    );
    expect(harness.notify).not.toHaveBeenCalled();
  });
});
