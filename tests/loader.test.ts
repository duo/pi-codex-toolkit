import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Pi extension loading", () => {
  it("loads the package manifest through Pi 0.87 without network access", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pct-resource-loader-"));
    temporaryDirectories.push(agentDir);
    const packageRoot = resolve(".");
    const entrypoint = resolve("src/index.ts");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network disabled in loader test"));
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      additionalExtensionPaths: [packageRoot],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();

    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    const extension = result.extensions.find(
      (candidate) => candidate.resolvedPath === entrypoint,
    );
    expect(extension).toBeDefined();
    expect([...extension!.tools.keys()]).toEqual([
      "openai_web_search",
      "openai_generate_image",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "exec",
      "wait",
      "computer_use_list_apps",
      "computer_use_get_app_state",
      "computer_use_click",
      "computer_use_type_text",
      "computer_use_press_key",
      "computer_use_scroll",
      "find_tools",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
