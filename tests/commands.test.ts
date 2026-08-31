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
import { ConfigStore, defaultConfig } from "../src/config.ts";
import { codexModel, model } from "./fixtures.ts";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<ConfigStore> {
  const directory = await mkdtemp(join(tmpdir(), "pct-commands-"));
  temporaryDirectories.push(directory);
  const store = new ConfigStore(join(directory, "pi-codex-toolkit.json"));
  await store.load();
  return store;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function commandHarness(input: {
  store: ConfigStore;
  choices?: Array<string | undefined>;
  hasUI?: boolean;
  syncError?: Error;
  availableModels?: Model<any>[];
  scopedModels?: Array<{ model: Model<any>; thinkingLevel?: string }>;
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
      stderr,
    },
  );
  const ctx = {
    hasUI: input.hasUI ?? true,
    ui: { notify, select },
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
        "Apply Patch: off",
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
    expect(store.snapshot.config.applyPatch.enabled).toBe(true);
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
    expect(saved.applyPatch.enabled).toBe(true);
    expect(saved.computerUse.enabled).toBe(true);
    expect(saved.computerUse.approvalMode).toBe("always");
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
      expect.stringContaining("using last known good"),
      "warning",
    );
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
});
