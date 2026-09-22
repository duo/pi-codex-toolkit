// Separate file: the whole module mock below records every staging file's mode
// at the moment its content is written, and the umask is process-global.
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const staging = vi.hoisted(() => ({
  observed: [] as Array<{ mode: number; size: number }>,
}));

vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // The staging file's own creation mode is the contract: observe it after the
    // content is there and before apply_patch can chmod it.
    writeFile: (async (...args: unknown[]) => {
      const result = await (
        actual.writeFile as (...values: unknown[]) => Promise<void>
      )(...args);
      const path = String(args[0]);
      if (path.includes(".pct-apply-patch-")) {
        const info = await actual.stat(path);
        staging.observed.push({ mode: info.mode & 0o777, size: info.size });
      }
      return result;
    }) as typeof actual.writeFile,
  };
});

import { APPLY_PATCH_TOOL_DEFINITION } from "../src/apply-patch.ts";

const workspaces: string[] = [];
let previousUmask = 0;

async function workspace(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `pct-apply-${name}-`));
  workspaces.push(path);
  return path;
}

function patch(lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

async function execute(cwd: string, input: string) {
  return APPLY_PATCH_TOOL_DEFINITION.execute(
    "apply-patch-staging-mode",
    { patch: input },
    undefined,
    undefined,
    { cwd } as ExtensionContext,
  );
}

beforeEach(() => {
  staging.observed.length = 0;
  // A fixed umask makes both the creation mode and what it strips exact.
  previousUmask = process.umask(0o022);
});

afterEach(async () => {
  process.umask(previousUmask);
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("apply_patch staging file mode", () => {
  it("creates the staging file with the source's mode, never wider", async () => {
    const root = await workspace("staging-private");
    // The reported window: a private file inside a traversable directory.
    await chmod(root, 0o755);
    const secret = join(root, "secret.txt");
    await writeFile(secret, "old secret\n");
    await chmod(secret, 0o600);

    await execute(
      root,
      patch([
        "*** Update File: secret.txt",
        "@@",
        "-old secret",
        "+new secret",
      ]),
    );

    // The replacement content never sits at 0644 while it holds the new bytes.
    expect(staging.observed).toEqual([{ mode: 0o600, size: 11 }]);
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    await expect(readFile(secret, "utf8")).resolves.toBe("new secret\n");
  });

  it("restores source mode bits the umask strips at creation", async () => {
    const root = await workspace("staging-umask");
    const shared = join(root, "shared.txt");
    await writeFile(shared, "old\n");
    await chmod(shared, 0o666);

    await execute(
      root,
      patch(["*** Update File: shared.txt", "@@", "-old", "+new"]),
    );

    // Creation applies the umask, so 0666 arrives as 0644; the chmod restores it.
    expect(staging.observed).toEqual([{ mode: 0o644, size: 4 }]);
    expect((await stat(shared)).mode & 0o777).toBe(0o666);
    await expect(readFile(shared, "utf8")).resolves.toBe("new\n");
  });
});
