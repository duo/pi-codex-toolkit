import { describe, expect, it } from "vitest";

import { defaultConfig } from "../src/config.ts";
import {
  formatStatus,
  projectStatus,
  selectComputerUseStatus,
  selectImageGenerationStatus,
  selectRemoteCompactionStatus,
  selectWebSearchBackend,
} from "../src/status.ts";
import { model, otherModel } from "./fixtures.ts";

describe("Web Search backend selection", () => {
  const backends = ["auto", "native", "sidecar"] as const;
  for (const backend of backends) {
    for (const present of [false, true]) {
      for (const native of [false, true]) {
        for (const sidecar of [false, true]) {
          it(`${backend}: model=${present}, native=${native}, sidecar=${sidecar}`, () => {
            const config = defaultConfig().webSearch;
            config.enabled = true;
            config.backend = backend;
            const result = selectWebSearchBackend(
              config,
              present,
              { ok: native, reason: "unsupported-provider" },
              { ok: sidecar, reason: "missing-sidecar-model" },
            );

            if (!present) {
              expect(result).toEqual({
                effective: "unavailable",
                reason: "current-model-missing",
              });
            } else if (backend === "native") {
              expect(result.effective).toBe(native ? "native" : "unavailable");
            } else if (backend === "sidecar") {
              expect(result.effective).toBe(
                sidecar ? "sidecar" : "unavailable",
              );
            } else {
              expect(result.effective).toBe(
                native ? "native" : sidecar ? "sidecar" : "unavailable",
              );
            }
          });
        }
      }
    }
  }

  it("always selects off when disabled", () => {
    const config = defaultConfig().webSearch;
    expect(
      selectWebSearchBackend(config, true, { ok: true }, { ok: true }),
    ).toEqual({ effective: "off" });
  });
});

describe("status projection", () => {
  it("projects Computer Use eligibility without probing", () => {
    const config = defaultConfig().computerUse;
    const ready = {
      isMac: true,
      hasUI: true,
      currentModelPresent: true,
      modelHasImageInput: true,
      runtime: {
        ok: true as const,
        runtime: {
          codexPath: "/chatgpt/codex",
          nodeReplPath: "/chatgpt/node_repl",
          nodePath: "/chatgpt/node",
          nodeModulesPath: "/chatgpt/node_modules",
          helperPath: "/codex-home/computer-use/Codex Computer Use.app",
        },
      },
    };
    expect(selectComputerUseStatus(config, ready)).toEqual({
      effective: "off",
    });
    config.enabled = true;
    expect(selectComputerUseStatus(config, ready)).toEqual({
      effective: "active",
      transport: "node-repl",
    });
    expect(selectComputerUseStatus(config, { ...ready, isMac: false })).toEqual(
      { effective: "unavailable", reason: "unsupported-platform" },
    );
    expect(selectComputerUseStatus(config, { ...ready, hasUI: false })).toEqual(
      { effective: "unavailable", reason: "no-interactive-ui" },
    );
    expect(
      selectComputerUseStatus(config, {
        ...ready,
        currentModelPresent: false,
      }),
    ).toEqual({
      effective: "unavailable",
      reason: "current-model-missing",
    });
    expect(
      selectComputerUseStatus(config, {
        ...ready,
        modelHasImageInput: false,
      }),
    ).toEqual({
      effective: "unavailable",
      reason: "model-has-no-image-input",
    });
    expect(
      selectComputerUseStatus(config, {
        ...ready,
        runtime: {
          ok: false,
          reason: "missing-chatgpt-desktop-component",
        },
      }),
    ).toEqual({
      effective: "unavailable",
      reason: "missing-chatgpt-desktop-component",
    });
  });

  it("projects Image Generation configured and structural states", () => {
    const config = defaultConfig().imageGeneration;
    expect(
      selectImageGenerationStatus(config, true, {
        ok: true,
        backend: "api-key",
      }),
    ).toEqual({ effective: "off" });
    config.enabled = true;
    expect(
      selectImageGenerationStatus(config, false, {
        ok: true,
        backend: "api-key",
      }),
    ).toEqual({
      effective: "unavailable",
      reason: "current-model-missing",
    });
    expect(
      selectImageGenerationStatus(config, true, {
        ok: true,
        backend: "codex-oauth",
      }),
    ).toEqual({ effective: "active", backend: "codex-oauth" });
    expect(
      selectImageGenerationStatus(config, true, {
        ok: false,
        reason: "missing-openai-auth",
      }),
    ).toEqual({ effective: "unavailable", reason: "missing-openai-auth" });
  });

  it("reports Remote Compaction structural state without resolving auth", () => {
    const config = defaultConfig().remoteCompaction;
    expect(selectRemoteCompactionStatus(config, true, { ok: true })).toEqual({
      effective: "off",
      reason: "",
    });
    config.enabled = true;
    expect(selectRemoteCompactionStatus(config, true, { ok: true })).toEqual({
      effective: "active",
      reason: "",
    });
    expect(
      selectRemoteCompactionStatus(config, true, {
        ok: false,
        reason: "unsupported-provider",
      }),
    ).toEqual({ effective: "unavailable", reason: "unsupported-provider" });
  });

  it("reports effective state, conflict, config errors, and Sidecar cost", () => {
    const config = defaultConfig();
    config.webSearch.enabled = true;
    config.webSearch.backend = "sidecar";
    config.webSearch.sidecarModel = {
      provider: "openai",
      model: "gpt-5",
      thinkingLevel: "auto",
    };
    const status = projectStatus({
      config,
      configPath: "/agent/extensions/pi-codex-toolkit.json",
      configError: "invalid-json",
      currentModel: model(),
      decision: { effective: "sidecar" },
      imageGenerationDecision: { effective: "off" },
      computerUseDecision: { effective: "off" },
      remoteCompactionAvailability: {
        ok: false,
        reason: "unsupported-provider",
      },
      toolConflict: true,
      imageToolConflict: false,
      applyPatchToolConflict: false,
      computerUseToolConflict: false,
    });
    expect(status.webSearch).toMatchObject({
      configured: "on",
      effective: "unavailable",
      requestedBackend: "sidecar",
      effectiveBackend: "unavailable",
      executor: "openai/gpt-5",
      executorEffort: "auto",
      reason: "conflicting-tool-name",
    });
    const text = formatStatus(status);
    expect(text).toContain("Config error: invalid-json");
    expect(text).toContain("additional latency and cost");
    expect(text).toContain("web search executor: openai/gpt-5");
    expect(text).toContain("web search executor effort: auto");
    expect(text).toContain("Remote Compaction:");
    expect(text).toContain("Image Generation:");
    expect(text).toContain("Apply Patch:");
    expect(text).toContain("Computer Use:");
  });

  it("reports an active Codex OAuth executor and independent effort for Grok", () => {
    const config = defaultConfig();
    config.webSearch.enabled = true;
    config.webSearch.sidecarModel = {
      provider: "openai-codex",
      model: "gpt-5.4",
      thinkingLevel: "low",
    };
    const status = projectStatus({
      config,
      configPath: "/config.json",
      currentModel: otherModel({
        provider: "xai",
        id: "grok-4.6",
        name: "Grok 4.6",
        api: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      }),
      decision: { effective: "sidecar" },
      imageGenerationDecision: {
        effective: "active",
        backend: "codex-oauth",
      },
      computerUseDecision: { effective: "off" },
      remoteCompactionAvailability: {
        ok: false,
        reason: "unsupported-provider",
      },
      toolConflict: false,
      imageToolConflict: false,
      applyPatchToolConflict: false,
      computerUseToolConflict: false,
    });

    expect(status.webSearch).toMatchObject({
      effective: "active",
      effectiveBackend: "sidecar",
      executor: "openai-codex/gpt-5.4",
      executorEffort: "low",
      reason: "",
    });
  });

  it("warns about another active search path without disabling Native Search", () => {
    const config = defaultConfig();
    config.webSearch.enabled = true;
    const status = projectStatus({
      config,
      configPath: "/config.json",
      currentModel: model(),
      decision: { effective: "native" },
      imageGenerationDecision: { effective: "off" },
      computerUseDecision: { effective: "off" },
      remoteCompactionAvailability: {
        ok: false,
        reason: "unsupported-provider",
      },
      toolConflict: false,
      imageToolConflict: false,
      applyPatchToolConflict: false,
      computerUseToolConflict: false,
      searchPathConflict: true,
    });
    expect(status.webSearch).toMatchObject({
      effective: "active",
      effectiveBackend: "native",
      reason: "conflicting-tool-name",
    });
  });

  it("reports the selected image backend and an independent conflict", () => {
    const config = defaultConfig();
    config.imageGeneration.enabled = true;
    const status = projectStatus({
      config,
      configPath: "/config.json",
      currentModel: model(),
      decision: { effective: "off" },
      imageGenerationDecision: { effective: "active", backend: "api-key" },
      computerUseDecision: { effective: "off" },
      remoteCompactionAvailability: { ok: true },
      toolConflict: false,
      imageToolConflict: true,
      applyPatchToolConflict: false,
      computerUseToolConflict: false,
    });
    expect(status.imageGeneration).toEqual({
      configured: "on",
      effective: "unavailable",
      backend: "api-key",
      reason: "conflicting-tool-name",
    });
  });

  it("reports Apply Patch from only its flag and tool ownership", () => {
    const config = defaultConfig();
    config.applyPatch.enabled = true;
    const status = projectStatus({
      config,
      configPath: "/config.json",
      currentModel: otherModel(),
      decision: { effective: "off" },
      imageGenerationDecision: { effective: "off" },
      computerUseDecision: { effective: "off" },
      remoteCompactionAvailability: { ok: false },
      toolConflict: false,
      imageToolConflict: false,
      applyPatchToolConflict: true,
      computerUseToolConflict: false,
    });

    expect(status.applyPatch).toEqual({
      configured: "on",
      effective: "unavailable",
      reason: "conflicting-tool-name",
    });
  });

  it("reports the node_repl transport and whole-group conflict", () => {
    const config = defaultConfig();
    config.computerUse.enabled = true;
    const status = projectStatus({
      config,
      configPath: "/config.json",
      currentModel: model({ input: ["text", "image"] }),
      decision: { effective: "off" },
      imageGenerationDecision: { effective: "off" },
      computerUseDecision: { effective: "active", transport: "node-repl" },
      remoteCompactionAvailability: { ok: true },
      toolConflict: false,
      imageToolConflict: false,
      applyPatchToolConflict: false,
      computerUseToolConflict: true,
    });
    expect(status.computerUse).toEqual({
      configured: "on",
      effective: "unavailable",
      transport: "node-repl",
      reason: "conflicting-tool-name",
    });
  });
});
