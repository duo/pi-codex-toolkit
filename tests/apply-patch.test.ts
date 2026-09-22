import type { PathLike } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsFault = vi.hoisted(() => ({
  abortController: undefined as AbortController | undefined,
  abortAfterStageWrites: undefined as number | undefined,
  stageWrites: 0,
  failRenameTarget: undefined as string | undefined,
  failedRenameAttempts: 0,
  failUnlinkTarget: undefined as string | undefined,
  failedUnlinkAttempts: 0,
  failMkdirTarget: undefined as string | undefined,
  failedMkdirAttempts: 0,
}));

vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();
  const commitFailure = () =>
    Object.assign(new Error("simulated commit failure"), { code: "EIO" });
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
        throw commitFailure();
      }
      return actual.rename(oldPath, newPath);
    },
    unlink: async (path: PathLike) => {
      if (String(path) === fsFault.failUnlinkTarget) {
        fsFault.failedUnlinkAttempts += 1;
        throw commitFailure();
      }
      return actual.unlink(path);
    },
    mkdir: (async (...args: unknown[]) => {
      if (String(args[0]) === fsFault.failMkdirTarget) {
        fsFault.failedMkdirAttempts += 1;
        throw commitFailure();
      }
      return (
        actual.mkdir as (...values: unknown[]) => Promise<string | undefined>
      )(...args);
    }) as typeof actual.mkdir,
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
  createApplyPatchTool,
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
  fsFault.failUnlinkTarget = undefined;
  fsFault.failedUnlinkAttempts = 0;
  fsFault.failMkdirTarget = undefined;
  fsFault.failedMkdirAttempts = 0;
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

  it("describes Delete File source validation before mutation", () => {
    const description = APPLY_PATCH_TOOL_DEFINITION.description;
    for (const clause of [
      "including Delete File targets",
      "valid UTF-8 text",
      "consistent LF or CRLF",
      "non-UTF-8, bare CR and mixed line endings are rejected before mutation",
      "Binary deletion is unsupported",
    ])
      expect(description).toContain(clause);
  });

  it("shows a literal minimal envelope that this parser accepts", async () => {
    const description = APPLY_PATCH_TOOL_DEFINITION.description;
    const example = description.slice(
      description.indexOf("*** Begin Patch\n"),
      description.indexOf("*** End Patch\n") + "*** End Patch".length,
    );
    expect(example).toBe(
      "*** Begin Patch\n*** Add File: notes/todo.md\n+first line\n*** End Patch",
    );
    // The example is not decoration: the strict parser accepts it verbatim.
    const root = await workspace("description-example");
    const result = await APPLY_PATCH_TOOL_DEFINITION.execute(
      "example-1",
      { patch: example },
      undefined,
      undefined,
      { cwd: root } as unknown as ExtensionContext,
    );
    expect(result.details).toEqual({
      operations: [{ operation: "add", path: "notes/todo.md" }],
    });
    expect(await readFile(join(root, "notes/todo.md"), "utf8")).toBe(
      "first line\n",
    );
    // The envelope a live run produced instead is still rejected.
    expect(description).toContain(
      'no trailing marker such as "*** Begin Patch',
    );
    await expect(
      APPLY_PATCH_TOOL_DEFINITION.execute(
        "example-2",
        {
          patch:
            "*** Begin Patch ***\n*** Add File: notes/other.md\n+first line\n*** End Patch ***",
        },
        undefined,
        undefined,
        { cwd: root } as unknown as ExtensionContext,
      ),
    ).rejects.toThrow("apply_patch failed (no-change)");
    // The carriage-return sentence is the parser's rule, not decoration.
    expect(description).toContain(
      "a carriage return anywhere in the envelope is rejected",
    );
    await expect(
      APPLY_PATCH_TOOL_DEFINITION.execute(
        "example-3",
        { patch: example.replaceAll("\n", "\r\n") },
        undefined,
        undefined,
        { cwd: root } as unknown as ExtensionContext,
      ),
    ).rejects.toThrow("patch syntax must use LF line endings");
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

  // Codex ends every non-empty Update output with a newline; the Toolkit keeps
  // a non-empty source's missing one on purpose.
  it.each([
    ["deleting the last line", [" a", "-b"], "a"],
    ["appending at End of File", [" b", "+c", "*** End of File"], "a\nb\nc"],
    ["changing an earlier line", ["-a", "+z", " b"], "z\nb"],
  ])(
    "keeps the missing final newline of a non-empty source when %s",
    async (_name, hunk, expected) => {
      const root = await workspace("unterminated-source");
      const target = await put(root, "ab.txt", "a\nb");

      await execute(root, patch(["*** Update File: ab.txt", "@@", ...hunk]));

      await expect(readFile(target, "utf8")).resolves.toBe(expected);
    },
  );

  // A 0-byte source has no final-newline state to keep.
  it("ends content added to a 0-byte source with a newline", async () => {
    const root = await workspace("empty-source");
    const target = await put(root, "empty.ts", "");

    await execute(
      root,
      patch([
        "*** Update File: empty.ts",
        "@@",
        "+export const x = 2;",
        "*** End of File",
      ]),
    );

    await expect(readFile(target, "utf8")).resolves.toBe(
      "export const x = 2;\n",
    );
  });

  it("does not carry a missing final newline past a file the patch emptied", async () => {
    const root = await workspace("emptied-source");
    const target = await put(root, "sticky.ts", "export const x = 1;\n");

    await execute(
      root,
      patch(["*** Update File: sticky.ts", "@@", "-export const x = 1;"]),
    );
    await expect(readFile(target, "utf8")).resolves.toBe("");
    await execute(
      root,
      patch([
        "*** Update File: sticky.ts",
        "@@",
        "+export const x = 2;",
        "*** End of File",
      ]),
    );
    await expect(readFile(target, "utf8")).resolves.toBe(
      "export const x = 2;\n",
    );
    await execute(
      root,
      patch([
        "*** Update File: sticky.ts",
        "@@",
        "+export const y = 3;",
        "*** End of File",
      ]),
    );
    await expect(readFile(target, "utf8")).resolves.toBe(
      "export const x = 2;\nexport const y = 3;\n",
    );
  });

  it.each([
    ["one line", ["export const x = 2;"], "export const x = 2;\n"],
    [
      "several lines",
      ["", "export const x = 2;", "", "export const y = 3;"],
      "\nexport const x = 2;\n\nexport const y = 3;\n",
    ],
    ["one blank line", [""], "\n"],
  ])(
    "writes the same bytes through Add File and an Update of a 0-byte source (%s)",
    async (_name, lines, expected) => {
      const root = await workspace("empty-source-parity");
      const updated = await put(root, "updated.ts", "");
      const added = lines.map((line) => `+${line}`);

      await execute(
        root,
        patch([
          "*** Add File: added.ts",
          ...added,
          "*** Update File: updated.ts",
          "@@",
          ...added,
          "*** End of File",
        ]),
      );

      const bytes = Buffer.from(expected, "utf8");
      await expect(readFile(join(root, "added.ts"))).resolves.toEqual(bytes);
      await expect(readFile(updated)).resolves.toEqual(bytes);
    },
  );

  it("keeps the BOM of a BOM-only source and ends its added content with a newline", async () => {
    const root = await workspace("bom-only-source");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const target = await put(root, "bom.txt", bom);

    await execute(
      root,
      patch(["*** Update File: bom.txt", "@@", "+line", "*** End of File"]),
    );

    await expect(readFile(target)).resolves.toEqual(
      Buffer.concat([bom, Buffer.from("line\n", "utf8")]),
    );
  });

  it("moves a 0-byte source without adding a newline", async () => {
    const root = await workspace("empty-move");
    await put(root, "empty.txt", "");

    await execute(
      root,
      patch(["*** Update File: empty.txt", "*** Move to: moved.txt"]),
    );

    await expect(readFile(join(root, "moved.txt"))).resolves.toEqual(
      Buffer.alloc(0),
    );
    await expectMissing(join(root, "empty.txt"));
  });

  it.each([
    ["LF", "你好\ncafé\n"],
    ["CRLF", "你好\r\ncafé\r\n"],
  ])(
    "deletes valid non-ASCII UTF-8 text with %s endings",
    async (_name, text) => {
      const root = await workspace("valid-delete-text");
      const target = await put(root, "target.txt", text);

      const result = await execute(
        root,
        patch(["*** Delete File: target.txt"]),
      );

      expect(result.details).toEqual({
        operations: [{ operation: "delete", path: "target.txt" }],
      });
      await expectMissing(target);
      await expectNoStages(root);
    },
  );

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

  // Every commit step names its path for reread before the call that can fail.
  // The reset after a success has no observable effect: the next step that can
  // fail names its own path first.
  it("add in-flight: reports the added path as unknown after one failed rename", async () => {
    const root = await workspace("add-in-flight");
    fsFault.failRenameTarget = join(await realpath(root), "added.txt");

    await expect(
      execute(root, patch(["*** Add File: added.txt", "+added"])),
    ).rejects.toMatchObject({
      message:
        "apply_patch failed (unknown); reread: 'added.txt'; filesystem commit failed (EIO)",
      committed: [],
      unknown: ["'added.txt'"],
    });
    expect(fsFault.failedRenameAttempts).toBe(1);
    await expectMissing(join(root, "added.txt"));
    await expectNoStages(root);
  });

  it("delete in-flight: reports the deleted path as unknown after one failed unlink", async () => {
    const root = await workspace("delete-in-flight");
    const target = await put(root, "target.txt", "old\n");
    fsFault.failUnlinkTarget = await realpath(target);

    await expect(
      execute(root, patch(["*** Delete File: target.txt"])),
    ).rejects.toMatchObject({
      message:
        "apply_patch failed (unknown); reread: 'target.txt'; filesystem commit failed (EIO)",
      committed: [],
      unknown: ["'target.txt'"],
    });
    expect(fsFault.failedUnlinkAttempts).toBe(1);
    await expect(readFile(target, "utf8")).resolves.toBe("old\n");
    await expectNoStages(root);
  });

  it("move destination in-flight: reports the destination as unknown after one failed rename", async () => {
    const root = await workspace("move-destination-in-flight");
    const source = await put(root, "source.txt", "source\n");
    fsFault.failRenameTarget = join(await realpath(root), "moved.txt");

    await expect(
      execute(
        root,
        patch([
          "*** Update File: source.txt",
          "*** Move to: moved.txt",
          "@@",
          "-source",
          "+moved",
        ]),
      ),
    ).rejects.toMatchObject({
      message:
        "apply_patch failed (unknown); reread: 'moved.txt'; filesystem commit failed (EIO)",
      committed: [],
      unknown: ["'moved.txt'"],
    });
    expect(fsFault.failedRenameAttempts).toBe(1);
    await expect(readFile(source, "utf8")).resolves.toBe("source\n");
    await expectMissing(join(root, "moved.txt"));
    await expectNoStages(root);
  });

  it("move source in-flight: reports the committed destination and the source as unknown after one failed unlink", async () => {
    const root = await workspace("move-source-in-flight");
    const source = await put(root, "source.txt", "source\n");
    fsFault.failUnlinkTarget = await realpath(source);

    await expect(
      execute(
        root,
        patch([
          "*** Update File: source.txt",
          "*** Move to: moved.txt",
          "@@",
          "-source",
          "+moved",
        ]),
      ),
    ).rejects.toMatchObject({
      message:
        "apply_patch failed (partial; unknown); committed: moved destination 'moved.txt'; reread: 'source.txt'; filesystem commit failed (EIO)",
      committed: ["moved destination 'moved.txt'"],
      unknown: ["'source.txt'"],
    });
    expect(fsFault.failedUnlinkAttempts).toBe(1);
    await expect(readFile(join(root, "moved.txt"), "utf8")).resolves.toBe(
      "moved\n",
    );
    await expect(readFile(source, "utf8")).resolves.toBe("source\n");
    await expectNoStages(root);
  });

  it("parent directory in-flight: reports the directory tree as unknown after one failed mkdir", async () => {
    const root = await workspace("parent-directory-in-flight");
    fsFault.failMkdirTarget = join(await realpath(root), "nested");

    await expect(
      execute(root, patch(["*** Add File: nested/added.txt", "+added"])),
    ).rejects.toMatchObject({
      message:
        "apply_patch failed (unknown); reread: directory tree 'nested'; filesystem commit failed (EIO)",
      committed: [],
      unknown: ["directory tree 'nested'"],
    });
    expect(fsFault.failedMkdirAttempts).toBe(1);
    await expectMissing(join(root, "nested"));
    await expectNoStages(root);
  });
});

// Codex at the pinned commit reads a bare empty line inside an Update hunk as an
// empty context line (streaming_parser.rs:307-315) and, when such a chunk does
// not match, searches again without that trailing empty line
// (file_update.rs:155-168). The B1-B4 cases assert the bytes Codex CLI 0.154.0
// produces for the same four patches.
describe("apply_patch bare empty hunk lines", () => {
  it("B1: reads a bare empty Update line as an empty context line", async () => {
    const root = await workspace("blank-b1");
    await put(root, "upd.txt", "context before\n\ncontext after\nold\n");

    await execute(
      root,
      patch([
        "*** Update File: upd.txt",
        "@@",
        " context before",
        "",
        " context after",
        "-old",
        "+new",
      ]),
    );

    await expect(readFile(join(root, "upd.txt"), "utf8")).resolves.toBe(
      "context before\n\ncontext after\nnew\n",
    );
    await expectNoStages(root);
  });

  it("B2: rejects a bare empty line inside an Add File hunk", async () => {
    const root = await workspace("blank-b2");

    await expect(
      execute(root, patch(["*** Add File: add.txt", "+first", "", "+third"])),
    ).rejects.toMatchObject({
      message:
        "apply_patch failed (no-change): invalid Add File line for 'add.txt'",
    });
    await expectMissing(join(root, "add.txt"));
    await expectNoStages(root);
  });

  it("B3: matches a hunk whose context ends with an empty line without it", async () => {
    const root = await workspace("blank-b3");
    await put(root, "upd2.txt", "keep\n");

    await execute(
      root,
      patch(["*** Update File: upd2.txt", "@@", " keep", "+added", ""]),
    );

    await expect(readFile(join(root, "upd2.txt"), "utf8")).resolves.toBe(
      "keep\nadded\n",
    );
    await expectNoStages(root);
  });

  it("B4: applies both files when a later Update carries a bare empty context line", async () => {
    const root = await workspace("blank-b4");
    await put(root, "upd3.txt", "alpha\n\nbeta\n");

    await execute(
      root,
      patch([
        "*** Add File: multi.txt",
        "+ok",
        "*** Update File: upd3.txt",
        "@@",
        " alpha",
        "",
        "-beta",
        "+gamma",
      ]),
    );

    await expect(readFile(join(root, "multi.txt"), "utf8")).resolves.toBe(
      "ok\n",
    );
    await expect(readFile(join(root, "upd3.txt"), "utf8")).resolves.toBe(
      "alpha\n\ngamma\n",
    );
    await expectNoStages(root);
  });

  it("matches an empty context line that exists in the source, without the retry", async () => {
    const root = await workspace("blank-direct");
    await put(root, "target.txt", "one\n\ntwo\n");

    await execute(
      root,
      patch(["*** Update File: target.txt", "@@", " one", "", "+inserted"]),
    );

    // The retry would drop the trailing empty context line and leave the
    // source's own empty line behind the insertion: "one\n\ninserted\n\ntwo\n".
    await expect(readFile(join(root, "target.txt"), "utf8")).resolves.toBe(
      "one\n\ninserted\ntwo\n",
    );
    await expectNoStages(root);
  });

  it("keeps a non-empty final new line when the retry drops a removed empty old line", async () => {
    const root = await workspace("blank-removed-old");
    await put(root, "target.txt", "keep\n");

    await execute(
      root,
      patch(["*** Update File: target.txt", "@@", " keep", "+added", "-"]),
    );

    await expect(readFile(join(root, "target.txt"), "utf8")).resolves.toBe(
      "keep\nadded\n",
    );
    await expectNoStages(root);
  });

  it("rejects a chunk whose only old line is empty as a context mismatch", async () => {
    const root = await workspace("blank-only-old");
    await put(root, "target.txt", "keep\n");

    await expect(
      execute(root, patch(["*** Update File: target.txt", "@@", "+added", ""])),
    ).rejects.toMatchObject({
      message:
        "apply_patch failed (no-change): context mismatch in 'target.txt'",
    });
    await expect(readFile(join(root, "target.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
    await expectNoStages(root);
  });

  it.each([
    [
      "without a trailing empty line",
      "same\nsame\n",
      ["*** Update File: target.txt", "@@", "-same", "+new"],
    ],
    [
      "with a trailing empty line that matches twice",
      "same\n\nsame\n\n",
      ["*** Update File: target.txt", "@@", " same", "", "+added"],
    ],
    [
      "with a trailing empty line that only the retry can drop",
      "same\nsame\n",
      ["*** Update File: target.txt", "@@", " same", "+added", ""],
    ],
  ])("reports ambiguous context %s", async (_name, contents, body) => {
    const root = await workspace("blank-ambiguous");
    await put(root, "target.txt", contents);

    await expect(execute(root, patch(body))).rejects.toMatchObject({
      message:
        "apply_patch failed (no-change): ambiguous context in 'target.txt'",
    });
    await expect(readFile(join(root, "target.txt"), "utf8")).resolves.toBe(
      contents,
    );
    await expectNoStages(root);
  });
});

describe("apply_patch enablement gate", () => {
  async function gated(cwd: string, enabled: boolean, patchText: string) {
    return createApplyPatchTool(() => enabled).execute(
      "apply-patch-gate",
      { patch: patchText },
      undefined,
      undefined,
      { cwd } as ExtensionContext,
    );
  }

  it("refuses to run when the feature is disabled", async () => {
    const root = await workspace("gate-off");
    const target = await put(root, "target.txt", "old\n");

    await expect(
      gated(
        root,
        false,
        patch(["*** Update File: target.txt", "@@", "-old", "+new"]),
      ),
    ).rejects.toThrow("Apply Patch is not enabled.");

    await expect(readFile(target, "utf8")).resolves.toBe("old\n");
    await expectNoStages(root);
  });

  it("applies normally when the feature is enabled", async () => {
    const root = await workspace("gate-on");
    const target = await put(root, "target.txt", "old\n");

    const result = await gated(
      root,
      true,
      patch(["*** Update File: target.txt", "@@", "-old", "+new"]),
    );

    expect(result.details).toMatchObject({
      operations: [{ operation: "update", path: "target.txt" }],
    });
    await expect(readFile(target, "utf8")).resolves.toBe("new\n");
    await expectNoStages(root);
  });

  it("refuses before parsing the patch or touching the filesystem", async () => {
    const root = await workspace("gate-order");

    // A malformed envelope: an enabled tool rejects this while parsing. A
    // disabled tool must never get that far, so the enablement error is what
    // proves the check precedes every other step.
    const malformed = "*** Begin Patch\n*** Nonsense Marker\n*** End Patch";

    await expect(gated(root, true, malformed)).rejects.toThrow(/apply_patch/);
    await expect(gated(root, false, malformed)).rejects.toThrow(
      "Apply Patch is not enabled.",
    );
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("leaves the ungated definition available for nested dispatch", async () => {
    // src/index.ts registers the gated tool with Pi but hands the ungated
    // definition to the Code Mode adapter, which applies its own enablement
    // and ownership checks. Both must keep working independently.
    const root = await workspace("gate-nested");
    await put(root, "target.txt", "old\n");

    const result = await execute(
      root,
      patch(["*** Update File: target.txt", "@@", "-old", "+new"]),
    );

    expect(result.details).toMatchObject({
      operations: [{ operation: "update", path: "target.txt" }],
    });
    expect(createApplyPatchTool(() => true).name).toBe(
      APPLY_PATCH_TOOL_DEFINITION.name,
    );
  });
});
