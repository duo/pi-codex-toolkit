import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore, defaultConfig, parseConfig } from "../src/config.ts";

const temporaryDirectories: string[] = [];

async function configPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pct-config-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "pi-codex-toolkit.json");
}

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

  it.each([
    null,
    [],
    { debug: "yes" },
    { webSearch: false },
    { remoteCompaction: false },
    { remoteCompaction: { enabled: "yes" } },
    { imageGeneration: false },
    { imageGeneration: { enabled: "yes" } },
    { applyPatch: false },
    { applyPatch: { enabled: "yes" } },
    { computerUse: false },
    { computerUse: { enabled: "yes" } },
    { computerUse: { approvalMode: "sometimes" } },
    { webSearch: { backend: "fallback" } },
    { webSearch: { sidecarModel: { provider: "other", model: "x" } } },
    {
      webSearch: {
        sidecarModel: {
          provider: "openai-codex",
          model: "gpt-5.4",
          thinkingLevel: "extreme",
        },
      },
    },
    {
      webSearch: {
        sidecarModel: {
          provider: "openai",
          model: "gpt-5",
          thinkingLevel: "low",
        },
      },
    },
  ])("rejects invalid known configuration %#", (value) => {
    expect(() => parseConfig(value)).toThrow();
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
    expect(
      (await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
