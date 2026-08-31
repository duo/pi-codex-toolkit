import type { PathLike } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsFault = vi.hoisted(() => ({
  abortController: undefined as AbortController | undefined,
  abortAfterStageWrites: undefined as number | undefined,
  stageWrites: 0,
  failRenameTarget: undefined as string | undefined,
  failedRenameAttempts: 0,
}));

vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFile: async (...args: unknown[]) => {
      const result = await (
        actual.writeFile as (...values: unknown[]) => Promise<void>
      )(...args);
      if (String(args[0]).includes(".pct-apply-patch-")) {
        fsFault.stageWrites += 1;
        if (fsFault.stageWrites === fsFault.abortAfterStageWrites) {
          fsFault.abortController?.abort();
        }
      }
      return result;
    },
    rename: async (oldPath: PathLike, newPath: PathLike) => {
      if (String(newPath) === fsFault.failRenameTarget) {
        fsFault.failedRenameAttempts += 1;
        throw Object.assign(new Error("simulated commit failure"), {
          code: "EIO",
        });
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import {
  APPLY_PATCH_LARK_GRAMMAR,
  APPLY_PATCH_TOOL,
  APPLY_PATCH_TOOL_DEFINITION,
} from "../src/apply-patch.ts";

const workspaces: string[] = [];

async function workspace(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `pct-apply-${name}-`));
  workspaces.push(path);
  return path;
}

async function put(root: string, path: string, contents: string | Buffer) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  return absolute;
}

function patch(lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

async function execute(cwd: string, input: string, signal?: AbortSignal) {
  return APPLY_PATCH_TOOL_DEFINITION.execute(
    "apply-patch-test",
    { patch: input },
    signal,
    undefined,
    { cwd } as ExtensionContext,
  );
}

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectNoStages(root: string): Promise<void> {
  const entries = await readdir(root, { recursive: true });
  expect(
    entries.filter((entry) => entry.includes(".pct-apply-patch-")),
  ).toEqual([]);
}

beforeEach(() => {
  fsFault.abortController = undefined;
  fsFault.abortAfterStageWrites = undefined;
  fsFault.stageWrites = 0;
  fsFault.failRenameTarget = undefined;
  fsFault.failedRenameAttempts = 0;
});

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("apply_patch tool contract", () => {
  it("exposes one exact JSON property with the Codex grammar and sequential execution", () => {
    expect(APPLY_PATCH_TOOL_DEFINITION.name).toBe(APPLY_PATCH_TOOL);
    expect(APPLY_PATCH_TOOL_DEFINITION.parameters).toMatchObject({
      type: "object",
      required: ["patch"],
      additionalProperties: false,
      properties: { patch: { type: "string" } },
    });
    expect(
      Object.keys(APPLY_PATCH_TOOL_DEFINITION.parameters.properties),
    ).toEqual(["patch"]);
    expect(APPLY_PATCH_TOOL_DEFINITION.constrainedSampling).toEqual({
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
    });
    expect(APPLY_PATCH_LARK_GRAMMAR).toContain('add_line: "+" /(.*)/ LF');
    expect(APPLY_PATCH_TOOL_DEFINITION.executionMode).toBe("sequential");
  });

  it("applies Add, Update, Delete, move-only, multi-file, locator, and EOF changes", async () => {
    const root = await workspace("operations");
    await put(
      root,
      "src/app.ts",
      [
        "function one() {",
        "  return 1;",
        "}",
        "function two() {",
        "  return 2;",
        "}",
        "tail",
        "",
      ].join("\n"),
    );
    await put(root, "old.txt", "move me\n");
    await put(root, "delete.txt", "delete me\n");

    const result = await execute(
      root,
      patch([
        "*** Add File: new/blank.txt",
        "+",
        "+hello",
        "*** Update File: src/app.ts",
        "@@ function one() {",
        "-  return 1;",
        "+  return 10;",
        "@@ function two() {",
        "-  return 2;",
        "+  return 20;",
        "@@",
        "+after-tail",
        "*** End of File",
        "*** Update File: old.txt",
        "*** Move to: moved/nested.txt",
        "*** Delete File: delete.txt",
      ]),
    );

    await expect(readFile(join(root, "new/blank.txt"), "utf8")).resolves.toBe(
      "\nhello\n",
    );
    await expect(readFile(join(root, "src/app.ts"), "utf8")).resolves.toBe(
      [
        "function one() {",
        "  return 10;",
        "}",
        "function two() {",
        "  return 20;",
        "}",
        "tail",
        "after-tail",
        "",
      ].join("\n"),
    );
    await expect(
      readFile(join(root, "moved/nested.txt"), "utf8"),
    ).resolves.toBe("move me\n");
    await expectMissing(join(root, "old.txt"));
    await expectMissing(join(root, "delete.txt"));
    expect(result.details).toEqual({
      operations: [
        { operation: "add", path: "new/blank.txt" },
        { operation: "update", path: "src/app.ts" },
        { operation: "move", path: "moved/nested.txt", from: "old.txt" },
        { operation: "delete", path: "delete.txt" },
      ],
    });
  });

  it("uses the first unique exact, trailing-whitespace, or surrounding-whitespace tier", async () => {
    const root = await workspace("matching");
    await put(
      root,
      "tiers.txt",
      "exact\nalpha   \n  context  \nold\n    beta\n",
    );

    await execute(
      root,
      patch([
        "*** Update File: tiers.txt",
        "@@",
        "-exact",
        "+EXACT",
        "@@",
        "-alpha",
        "+ALPHA",
        "@@",
        " context",
        "-old",
        "+NEW",
        "@@",
        "-beta",
        "+BETA",
      ]),
    );

    await expect(readFile(join(root, "tiers.txt"), "utf8")).resolves.toBe(
      "EXACT\nALPHA\n  context  \nNEW\nBETA\n",
    );
  });

  it("deletes the only source line without leaving a blank line", async () => {
    const root = await workspace("delete-only-line");
    const target = await put(root, "target.txt", "only\n");

    await execute(root, patch(["*** Update File: target.txt", "@@", "-only"]));

    await expect(readFile(target, "utf8")).resolves.toBe("");
  });

  it.each([
    ["case-folded", "Case.txt", "case.txt"],
    ["Unicode-normalized", "é.txt", "e\u0301.txt"],
  ])(
    "rejects %s target aliases before mutation",
    async (_name, first, second) => {
      const root = await workspace("path-alias");

      await expect(
        execute(
          root,
          patch([
            `*** Add File: ${first}`,
            "+first",
            `*** Add File: ${second}`,
            "+second",
          ]),
        ),
      ).rejects.toThrow(/conflicting patch paths/);
      await expectMissing(join(root, first));
      await expectMissing(join(root, second));
    },
  );

  it("rejects predictable syntax, context, conflict, destination, and path failures without changes", async () => {
    const cases: Array<{
      name: string;
      files?: Record<string, string>;
      directories?: string[];
      input(root: string): string;
      error: RegExp;
    }> = [
      {
        name: "malformed",
        files: { "target.txt": "old\n" },
        input: () => "*** Begin Patch\n*** Delete File: target.txt",
        error: /last line/,
      },
      {
        name: "missing-context",
        files: { "target.txt": "old\n" },
        input: () =>
          patch(["*** Update File: target.txt", "@@", "-missing", "+new"]),
        error: /context mismatch/,
      },
      {
        name: "ambiguous-context",
        files: { "target.txt": "same\nsame\n" },
        input: () =>
          patch(["*** Update File: target.txt", "@@", "-same", "+new"]),
        error: /ambiguous context/,
      },
      {
        name: "conflicting-target",
        files: { "target.txt": "old\n" },
        input: () =>
          patch([
            "*** Update File: target.txt",
            "@@",
            "-old",
            "+new",
            "*** Delete File: target.txt",
          ]),
        error: /conflicting patch paths/,
      },
      {
        name: "existing-add",
        files: { "target.txt": "old\n" },
        input: () => patch(["*** Add File: target.txt", "+new"]),
        error: /destination already exists/,
      },
      {
        name: "existing-move",
        files: { "source.txt": "source\n", "target.txt": "target\n" },
        input: () =>
          patch(["*** Update File: source.txt", "*** Move to: target.txt"]),
        error: /destination already exists/,
      },
      {
        name: "traversal",
        files: { "target.txt": "old\n" },
        input: () => patch(["*** Add File: ../outside.txt", "+escape"]),
        error: /traversal/,
      },
      {
        name: "absolute",
        files: { "target.txt": "old\n" },
        input: (root) =>
          patch([`*** Add File: ${join(root, "outside.txt")}`, "+escape"]),
        error: /relative workspace files/,
      },
      {
        name: "drive-relative-segment",
        files: { "target.txt": "old\n" },
        input: () => patch(["*** Add File: safe/C:evil", "+escape"]),
        error: /relative workspace files/,
      },
      {
        name: "directory-target",
        files: { "target.txt": "old\n" },
        directories: ["folder"],
        input: () => patch(["*** Delete File: folder"]),
        error: /regular file/,
      },
      {
        name: "unanchored-pure-addition",
        files: { "target.txt": "old\n" },
        input: () =>
          patch(["*** Update File: target.txt", "@@", "+unanchored"]),
        error: /unique locator or End of File/,
      },
    ];

    for (const testCase of cases) {
      const root = await workspace(testCase.name);
      for (const directory of testCase.directories ?? []) {
        await mkdir(join(root, directory), { recursive: true });
      }
      for (const [path, contents] of Object.entries(testCase.files ?? {})) {
        await put(root, path, contents);
      }
      const before = new Map<string, Buffer>();
      for (const path of Object.keys(testCase.files ?? {})) {
        before.set(path, await readFile(join(root, path)));
      }

      await expect(execute(root, testCase.input(root))).rejects.toThrow(
        testCase.error,
      );
      for (const [path, contents] of before) {
        await expect(readFile(join(root, path))).resolves.toEqual(contents);
      }
      await expectNoStages(root);
    }
  });

  it("preserves BOM, LF/CRLF, trailing-newline state, and executable mode", async () => {
    const root = await workspace("formats");
    const crlf = await put(
      root,
      "script.sh",
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("#!/bin/sh\r\necho old\r\n", "utf8"),
      ]),
    );
    await chmod(crlf, 0o755);
    await put(root, "plain.txt", "first\nlast");

    await execute(
      root,
      patch([
        "*** Update File: script.sh",
        "@@",
        "-echo old",
        "+echo new",
        "*** Update File: plain.txt",
        "@@",
        "-last",
        "+changed",
      ]),
    );

    await expect(readFile(crlf)).resolves.toEqual(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("#!/bin/sh\r\necho new\r\n", "utf8"),
      ]),
    );
    expect((await stat(crlf)).mode & 0o777).toBe(0o755);
    await expect(readFile(join(root, "plain.txt"), "utf8")).resolves.toBe(
      "first\nchanged",
    );
  });

  it.each([
    ["non-UTF-8", Buffer.from([0xff, 0xfe, 0x00]), /non-UTF-8/],
    ["mixed EOL", Buffer.from("one\r\ntwo\n"), /mixed line endings/],
    ["bare CR", Buffer.from("one\rtwo"), /bare CR/],
  ] as const)(
    "rejects %s sources rather than deleting them",
    async (_name, bytes, error) => {
      const root = await workspace("invalid-text");
      const target = await put(root, "target.txt", bytes);

      await expect(
        execute(root, patch(["*** Delete File: target.txt"])),
      ).rejects.toThrow(error);
      await expect(readFile(target)).resolves.toEqual(bytes);
    },
  );

  it("rejects a real path plus visible symlink alias before queue acquisition", async () => {
    const root = await workspace("symlink-alias");
    await put(root, "real.txt", "old\n");
    await symlink("real.txt", join(root, "alias.txt"));

    await expect(
      execute(
        root,
        patch([
          "*** Update File: real.txt",
          "@@",
          "-old",
          "+new",
          "*** Delete File: alias.txt",
        ]),
      ),
    ).rejects.toThrow(/visible symlink/);
    await expect(readFile(join(root, "real.txt"), "utf8")).resolves.toBe(
      "old\n",
    );
  });

  it("waits on Pi's public mutation queue for the target", async () => {
    const root = await workspace("queue");
    const target = await put(root, "target.txt", "old\n");
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      enter = resolveEntered;
    });
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const holder = withFileMutationQueue(target, async () => {
      enter();
      await gate;
    });
    await entered;

    let settled = false;
    const running = execute(
      root,
      patch(["*** Update File: target.txt", "@@", "-old", "+new"]),
    ).finally(() => {
      settled = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(settled).toBe(false);
    release();
    await holder;
    await running;
    await expect(readFile(target, "utf8")).resolves.toBe("new\n");
  });

  it("cancels after the final stage without changing targets", async () => {
    const root = await workspace("abort");
    const controller = new AbortController();
    fsFault.abortController = controller;
    fsFault.abortAfterStageWrites = 2;

    await expect(
      execute(
        root,
        patch([
          "*** Add File: nested/one.txt",
          "+one",
          "*** Add File: nested/two.txt",
          "+two",
        ]),
        controller.signal,
      ),
    ).rejects.toThrow(/no-change.*aborted/);
    expect(fsFault.stageWrites).toBe(2);
    await expectMissing(join(root, "nested"));
    await expectNoStages(root);
  });

  it("reports a later commit failure as partial and unknown without truncation or retry", async () => {
    const root = await workspace("commit-failure");
    const first = await put(root, "first.txt", "old one\n");
    const second = await put(root, "second.txt", "old two\n");
    fsFault.failRenameTarget = await realpath(second);

    await expect(
      execute(
        root,
        patch([
          "*** Update File: first.txt",
          "@@",
          "-old one",
          "+new one",
          "*** Update File: second.txt",
          "@@",
          "-old two",
          "+new two",
        ]),
      ),
    ).rejects.toThrow(/partial; unknown.*first\.txt.*second\.txt.*EIO/);
    await expect(readFile(first, "utf8")).resolves.toBe("new one\n");
    await expect(readFile(second, "utf8")).resolves.toBe("old two\n");
    expect(fsFault.failedRenameAttempts).toBe(1);
    await expectNoStages(root);
  });
});
