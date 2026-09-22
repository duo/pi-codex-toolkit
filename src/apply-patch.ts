/*
 * Portions of this file are adapted from OpenAI Codex apply_patch at commit
 * b8c86376a258e55efc8e5ecfbabc21c16c07d814. The TypeScript implementation is
 * modified for Pi's tool API and the static-containment contract documented by
 * this project. The relevant upstream inputs are apply_patch.lark, parser.rs,
 * streaming_parser.rs, and the first three matching tiers in seek_sequence.rs.
 * See
 * docs/third-party/openai-codex-apply-patch-NOTICE.txt and
 * docs/third-party/Apache-2.0.txt.
 */

import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  defineTool,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  resolveInvocation,
  type ExecutionInvocationHooks,
} from "./execution-invocation.ts";

export const APPLY_PATCH_TOOL = "apply_patch";

// Narrowed from codex-rs/core/assets/tools/apply_patch.lark at the pinned
// revision above. Keep /(.*)/ so blank added lines remain representable.
export const APPLY_PATCH_LARK_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

type PatchOperation = AddOperation | DeleteOperation | UpdateOperation;

interface AddOperation {
  kind: "add";
  path: PatchPath;
  contents: string;
}

interface DeleteOperation {
  kind: "delete";
  path: PatchPath;
}

interface UpdateOperation {
  kind: "update";
  path: PatchPath;
  movePath?: PatchPath;
  chunks: UpdateChunk[];
}

interface UpdateChunk {
  locator?: string;
  oldLines: string[];
  newLines: string[];
  contextLineIndices: Array<[number, number]>;
  endOfFile: boolean;
}

interface PatchPath {
  display: string;
  absolute: string;
  segments: string[];
}

interface TextFile {
  bom: boolean;
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
  lines: string[];
  mode: number;
}

interface PathWalk {
  exists: boolean;
  finalIsFile: boolean;
  nearestExistingDirectory: string;
}

interface PreparedOperation {
  operation: PatchOperation;
  source?: TextFile;
  output?: Buffer;
  stageDirectory?: string;
  stagePath?: string;
}

export interface ApplyPatchDetail {
  operation: "add" | "update" | "delete" | "move";
  path: string;
  from?: string;
}

class PatchValidationError extends Error {}

class PatchCommitError extends Error {
  constructor(
    readonly committed: string[],
    readonly unknown: string[],
    code?: string,
  ) {
    const labels = [
      ...(committed.length > 0 ? ["partial"] : []),
      ...(unknown.length > 0 ? ["unknown"] : []),
    ];
    const parts = [
      `apply_patch failed (${labels.join("; ") || "unknown"})`,
      ...(committed.length > 0 ? [`committed: ${committed.join(", ")}`] : []),
      ...(unknown.length > 0 ? [`reread: ${unknown.join(", ")}`] : []),
      `filesystem commit failed${code ? ` (${code})` : ""}`,
    ];
    super(parts.join("; "));
  }
}

function parsePatch(patch: string, cwd: string): PatchOperation[] {
  if (patch.includes("\r")) {
    throw new PatchValidationError("patch syntax must use LF line endings");
  }

  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "*** Begin Patch") {
    throw new PatchValidationError("the first line must be '*** Begin Patch'");
  }
  if (lines.at(-1) !== "*** End Patch") {
    throw new PatchValidationError("the last line must be '*** End Patch'");
  }

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (line.startsWith("*** Add File: ")) {
      const path = resolvePatchPath(cwd, line.slice("*** Add File: ".length));
      index += 1;
      const added: string[] = [];
      while (index < lines.length - 1 && !isOperationHeader(lines[index])) {
        if (!lines[index].startsWith("+")) {
          throw new PatchValidationError(
            `invalid Add File line for '${path.display}'`,
          );
        }
        added.push(lines[index].slice(1));
        index += 1;
      }
      if (added.length === 0) {
        throw new PatchValidationError(
          `Add File for '${path.display}' must contain at least one line`,
        );
      }
      operations.push({
        kind: "add",
        path,
        contents: `${added.join("\n")}\n`,
      });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      operations.push({
        kind: "delete",
        path: resolvePatchPath(cwd, line.slice("*** Delete File: ".length)),
      });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const path = resolvePatchPath(
        cwd,
        line.slice("*** Update File: ".length),
      );
      index += 1;
      let movePath: PatchPath | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        movePath = resolvePatchPath(
          cwd,
          lines[index].slice("*** Move to: ".length),
        );
        index += 1;
      }

      const chunks: UpdateChunk[] = [];
      let current: UpdateChunk | undefined;
      let sawEndOfFile = false;
      const flush = (): void => {
        if (!current) return;
        const chunk = current;
        if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
          throw new PatchValidationError(
            `empty Update File hunk for '${path.display}'`,
          );
        }
        if (
          chunk.oldLines.length === chunk.newLines.length &&
          chunk.oldLines.every(
            (line, lineIndex) => line === chunk.newLines[lineIndex],
          )
        ) {
          throw new PatchValidationError(
            `no-op Update File hunk for '${path.display}'`,
          );
        }
        if (
          chunk.oldLines.length === 0 &&
          chunk.locator === undefined &&
          !chunk.endOfFile
        ) {
          throw new PatchValidationError(
            `pure addition in '${path.display}' needs a unique locator or End of File`,
          );
        }
        chunks.push(chunk);
        current = undefined;
      };

      while (index < lines.length - 1 && !isOperationHeader(lines[index])) {
        const changeLine = lines[index];
        if (sawEndOfFile) {
          throw new PatchValidationError(
            `End of File must finish the Update File hunk for '${path.display}'`,
          );
        }
        if (changeLine === "@@" || changeLine.startsWith("@@ ")) {
          flush();
          const locator = changeLine === "@@" ? undefined : changeLine.slice(3);
          if (locator !== undefined && locator.length === 0) {
            throw new PatchValidationError(
              `empty locator in '${path.display}'`,
            );
          }
          current = {
            locator,
            oldLines: [],
            newLines: [],
            contextLineIndices: [],
            endOfFile: false,
          };
          index += 1;
          continue;
        }
        if (changeLine === "*** End of File") {
          if (!current) {
            throw new PatchValidationError(
              `End of File has no Update File hunk in '${path.display}'`,
            );
          }
          current.endOfFile = true;
          sawEndOfFile = true;
          index += 1;
          continue;
        }
        // Codex reads a bare empty line inside an Update hunk as an empty
        // context line (streaming_parser.rs:307-315 at the pinned commit). Add
        // File above stays strict, as it is upstream.
        const marker = changeLine === "" ? " " : changeLine[0];
        if (marker !== "+" && marker !== "-" && marker !== " ") {
          throw new PatchValidationError(
            `invalid Update File line for '${path.display}'`,
          );
        }
        current ??= {
          oldLines: [],
          newLines: [],
          contextLineIndices: [],
          endOfFile: false,
        };
        const contents = changeLine.slice(1);
        if (marker === " ") {
          current.contextLineIndices.push([
            current.oldLines.length,
            current.newLines.length,
          ]);
        }
        if (marker === " " || marker === "-") current.oldLines.push(contents);
        if (marker === " " || marker === "+") current.newLines.push(contents);
        index += 1;
      }
      flush();
      if (!movePath && chunks.length === 0) {
        throw new PatchValidationError(
          `Update File for '${path.display}' is empty`,
        );
      }
      operations.push({ kind: "update", path, movePath, chunks });
      continue;
    }

    throw new PatchValidationError(`unknown patch marker at line ${index + 1}`);
  }

  if (operations.length === 0) {
    throw new PatchValidationError("patch must contain at least one operation");
  }
  assertNoLexicalConflicts(operations);
  return operations;
}

function isOperationHeader(line: string): boolean {
  return (
    line === "*** End Patch" ||
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Update File: ")
  );
}

function resolvePatchPath(cwd: string, rawPath: string): PatchPath {
  const rawSegments = rawPath.split(/[\\/]+/);
  if (
    rawPath.trim() === "" ||
    rawPath.includes("\0") ||
    isAbsolute(rawPath) ||
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\") ||
    rawSegments.some((segment) => /^[A-Za-z]:/.test(segment))
  ) {
    throw new PatchValidationError(
      "patch paths must be relative workspace files",
    );
  }
  if (rawSegments.includes("..")) {
    throw new PatchValidationError(
      `path traversal is not allowed: '${rawPath}'`,
    );
  }
  const segments = rawSegments.filter(
    (segment) => segment !== "." && segment !== "",
  );
  if (segments.length === 0) {
    throw new PatchValidationError(
      "patch paths cannot resolve to the workspace root",
    );
  }
  const absolute = resolve(cwd, ...segments);
  const fromRoot = relative(cwd, absolute);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new PatchValidationError(`path escapes the workspace: '${rawPath}'`);
  }
  return { display: segments.join("/"), absolute, segments };
}

function operationPaths(operation: PatchOperation): PatchPath[] {
  return operation.kind === "update" && operation.movePath
    ? [operation.path, operation.movePath]
    : [operation.path];
}

function assertNoLexicalConflicts(operations: PatchOperation[]): void {
  const paths = operations.flatMap(operationPaths);
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      const a = paths[left];
      const b = paths[right];
      // Case/Unicode-equivalent spellings can collapse on common volumes.
      const aFolded = a.absolute.normalize("NFC").toLowerCase();
      const bFolded = b.absolute.normalize("NFC").toLowerCase();
      const same = aFolded === bFolded;
      const ancestor =
        aFolded.startsWith(`${bFolded}${sep}`) ||
        bFolded.startsWith(`${aFolded}${sep}`);
      if (same || ancestor) {
        throw new PatchValidationError(
          `conflicting patch paths: '${a.display}' and '${b.display}'`,
        );
      }
    }
  }
}

function missingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function walkPath(root: string, path: PatchPath): Promise<PathWalk> {
  let current = root;
  let nearestExistingDirectory = root;
  for (let index = 0; index < path.segments.length; index += 1) {
    current = resolve(current, path.segments[index]);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (missingPath(error)) {
        return {
          exists: false,
          finalIsFile: false,
          nearestExistingDirectory,
        };
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new PatchValidationError(
        `visible symlink components are not allowed: '${path.display}'`,
      );
    }
    const final = index === path.segments.length - 1;
    if (!final && !stats.isDirectory()) {
      throw new PatchValidationError(
        `non-directory path component in '${path.display}'`,
      );
    }
    if (stats.isDirectory()) nearestExistingDirectory = current;
    if (final) {
      return {
        exists: true,
        finalIsFile: stats.isFile(),
        nearestExistingDirectory,
      };
    }
  }
  throw new PatchValidationError(`invalid path '${path.display}'`);
}

async function queueIdentities(
  root: string,
  operations: PatchOperation[],
): Promise<string[]> {
  const identities = new Map<string, string>();
  for (const path of operations.flatMap(operationPaths)) {
    await walkPath(root, path);
    let identity: string;
    try {
      identity = await realpath(path.absolute);
    } catch (error) {
      if (!missingPath(error)) throw error;
      identity = resolve(path.absolute);
    }
    const previous = identities.get(identity);
    if (previous !== undefined) {
      throw new PatchValidationError(
        `conflicting path aliases: '${previous}' and '${path.display}'`,
      );
    }
    identities.set(identity, path.display);
  }
  return [...identities.keys()].sort();
}

async function withMutationQueues<T>(
  identities: string[],
  index: number,
  callback: () => Promise<T>,
): Promise<T> {
  if (index === identities.length) return callback();
  return withFileMutationQueue(identities[index], () =>
    withMutationQueues(identities, index + 1, callback),
  );
}

function decodeTextFile(
  bytes: Buffer,
  mode: number,
  display: string,
): TextFile {
  const bom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bom ? bytes.subarray(3) : bytes,
    );
  } catch {
    throw new PatchValidationError(`non-UTF-8 source: '${display}'`);
  }

  let sawLf = false;
  let sawCrLf = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r") {
      if (text[index + 1] !== "\n") {
        throw new PatchValidationError(`bare CR line ending in '${display}'`);
      }
      sawCrLf = true;
      index += 1;
    } else if (text[index] === "\n") {
      sawLf = true;
    }
  }
  if (sawLf && sawCrLf) {
    throw new PatchValidationError(`mixed line endings in '${display}'`);
  }

  const eol = sawCrLf ? "\r\n" : "\n";
  const normalized = sawCrLf ? text.replaceAll("\r\n", "\n") : text;
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized === "" ? [] : normalized.split("\n");
  if (trailingNewline) lines.pop();
  return { bom, eol, trailingNewline, lines, mode: mode & 0o777 };
}

function encodeTextFile(file: TextFile, lines: string[]): Buffer {
  // An empty source has no final-newline state to preserve: like Add File,
  // terminate its new content.
  const terminate = file.trailingNewline || file.lines.length === 0;
  const text =
    lines.length === 0
      ? ""
      : `${lines.join(file.eol)}${terminate ? file.eol : ""}`;
  const encoded = Buffer.from(text, "utf8");
  return file.bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded])
    : encoded;
}

type MatchTier = (left: string, right: string) => boolean;

const MATCH_TIERS: MatchTier[] = [
  (left, right) => left === right,
  (left, right) => left.trimEnd() === right.trimEnd(),
  (left, right) => left.trim() === right.trim(),
];

/**
 * The single location the first productive tier identifies, or `undefined` when
 * no tier produced a candidate.
 *
 * Several candidates in a tier are still the ambiguity failure; only "no
 * candidate anywhere" is reported to the caller, so a caller that has another
 * pattern to try can tell the two apart.
 */
function findSequenceIndex(
  lines: string[],
  pattern: string[],
  start: number,
  endOfFile: boolean,
  label: string,
): number | undefined {
  if (pattern.length > lines.length) return undefined;
  for (const matches of MATCH_TIERS) {
    const candidates: number[] = [];
    if (endOfFile) {
      const candidate = lines.length - pattern.length;
      if (
        candidate >= start &&
        pattern.every((line, offset) =>
          matches(lines[candidate + offset], line),
        )
      ) {
        candidates.push(candidate);
      }
    } else {
      for (
        let candidate = start;
        candidate <= lines.length - pattern.length;
        candidate += 1
      ) {
        if (
          pattern.every((line, offset) =>
            matches(lines[candidate + offset], line),
          )
        ) {
          candidates.push(candidate);
        }
      }
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw new PatchValidationError(`ambiguous context in '${label}'`);
    }
  }
  return undefined;
}

function uniqueSequenceIndex(
  lines: string[],
  pattern: string[],
  start: number,
  endOfFile: boolean,
  label: string,
): number {
  const index = findSequenceIndex(lines, pattern, start, endOfFile, label);
  if (index === undefined) {
    throw new PatchValidationError(`context mismatch in '${label}'`);
  }
  return index;
}

function applyChunks(
  source: TextFile,
  chunks: UpdateChunk[],
  display: string,
): Buffer {
  const lines = [...source.lines];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.locator !== undefined) {
      const locator = uniqueSequenceIndex(
        lines,
        [chunk.locator],
        cursor,
        false,
        display,
      );
      cursor = locator + 1;
    }

    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let contextLineIndices = chunk.contextLineIndices;
    let changeIndex: number;
    if (oldLines.length === 0) {
      changeIndex = chunk.endOfFile ? lines.length : cursor;
    } else {
      let found = findSequenceIndex(
        lines,
        oldLines,
        cursor,
        chunk.endOfFile,
        display,
      );
      // Codex retries a chunk whose old lines end with an empty element without
      // that element (file_update.rs:155-168 at the pinned commit), because a
      // model often ends a hunk with a blank line the source does not have.
      if (
        found === undefined &&
        oldLines.length > 1 &&
        oldLines.at(-1) === ""
      ) {
        // Upstream drops the new side's final element only when it too is empty
        // (:159-161); a hunk that removes an empty last line keeps its added
        // lines whole. Unlike upstream, never retry down to an empty pattern:
        // that would insert at the cursor and bypass the parser's rule that a
        // pure addition needs a locator or End of File.
        const shortenedOld = oldLines.slice(0, -1);
        const shortenedNew =
          newLines.at(-1) === "" ? newLines.slice(0, -1) : newLines;
        oldLines = shortenedOld;
        newLines = shortenedNew;
        contextLineIndices = contextLineIndices.filter(
          ([oldIndex, newIndex]) =>
            oldIndex < shortenedOld.length && newIndex < shortenedNew.length,
        );
        found = findSequenceIndex(
          lines,
          oldLines,
          cursor,
          chunk.endOfFile,
          display,
        );
      }
      if (found === undefined) {
        throw new PatchValidationError(`context mismatch in '${display}'`);
      }
      changeIndex = found;
    }
    const replacement = [...newLines];
    for (const [oldIndex, newIndex] of contextLineIndices) {
      replacement[newIndex] = lines[changeIndex + oldIndex];
    }
    lines.splice(changeIndex, oldLines.length, ...replacement);
    cursor = changeIndex + replacement.length;
  }
  return encodeTextFile(source, lines);
}

async function requireMissingDestination(
  root: string,
  path: PatchPath,
): Promise<PathWalk> {
  const walk = await walkPath(root, path);
  if (walk.exists) {
    throw new PatchValidationError(
      `destination already exists: '${path.display}'`,
    );
  }
  return walk;
}

async function prepareOperations(
  root: string,
  operations: PatchOperation[],
): Promise<PreparedOperation[]> {
  const prepared: PreparedOperation[] = [];
  for (const operation of operations) {
    if (operation.kind === "add") {
      const destination = await requireMissingDestination(root, operation.path);
      prepared.push({
        operation,
        output: Buffer.from(operation.contents, "utf8"),
        stageDirectory: destination.nearestExistingDirectory,
      });
      continue;
    }

    const sourceWalk = await walkPath(root, operation.path);
    if (!sourceWalk.exists) {
      throw new PatchValidationError(
        `source does not exist: '${operation.path.display}'`,
      );
    }
    if (!sourceWalk.finalIsFile) {
      throw new PatchValidationError(
        `source is not a regular file: '${operation.path.display}'`,
      );
    }
    const stats = await lstat(operation.path.absolute);
    const source = decodeTextFile(
      await readFile(operation.path.absolute),
      stats.mode,
      operation.path.display,
    );
    if (operation.kind === "delete") {
      prepared.push({ operation, source });
      continue;
    }

    const output = applyChunks(
      source,
      operation.chunks,
      operation.path.display,
    );
    if (operation.movePath) {
      const destination = await requireMissingDestination(
        root,
        operation.movePath,
      );
      prepared.push({
        operation,
        source,
        output,
        stageDirectory: destination.nearestExistingDirectory,
      });
    } else {
      prepared.push({
        operation,
        source,
        output,
        stageDirectory: dirname(operation.path.absolute),
      });
    }
  }
  return prepared;
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new PatchValidationError("aborted");
  }
}

async function stageOperations(
  prepared: PreparedOperation[],
): Promise<Set<string>> {
  const stages = new Set<string>();
  try {
    for (const item of prepared) {
      if (!item.output || !item.stageDirectory) continue;
      const stagePath = resolve(
        item.stageDirectory,
        `.pct-apply-patch-${process.pid}-${randomUUID()}.tmp`,
      );
      try {
        // Create with the source's own mode: the replacement content must never
        // be readable to more principals than the file it replaces, not even
        // between this write and the chmod below.
        await writeFile(stagePath, item.output, {
          flag: "wx",
          mode: item.source ? item.source.mode : 0o666,
        });
      } catch (error) {
        await unlink(stagePath).catch(() => undefined);
        throw error;
      }
      stages.add(stagePath);
      // Creation applies the umask, so bits it strips still need the chmod.
      if (item.source) await chmod(stagePath, item.source.mode);
      item.stagePath = stagePath;
    }
    return stages;
  } catch (error) {
    await cleanupStages(stages);
    throw error;
  }
}

async function cleanupStages(stages: Set<string>): Promise<void> {
  await Promise.all(
    [...stages].map((stage) => unlink(stage).catch(() => undefined)),
  );
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function displayTree(root: string, path: string): string {
  const value = relative(root, path);
  return value === "" ? "." : value.split(sep).join("/");
}

async function commitPrepared(
  root: string,
  prepared: PreparedOperation[],
  stages: Set<string>,
): Promise<ApplyPatchDetail[]> {
  const committed: string[] = [];
  const details: ApplyPatchDetail[] = [];
  let unknown: string[] = [];

  const ensureParent = async (path: PatchPath): Promise<void> => {
    const parent = dirname(path.absolute);
    unknown = [`directory tree '${displayTree(root, parent)}'`];
    let firstCreated: string | undefined;
    try {
      firstCreated = await mkdir(parent, { recursive: true });
    } catch (error) {
      throw new PatchCommitError(committed, unknown, errorCode(error));
    }
    unknown = [];
    if (firstCreated) {
      committed.push(`created directory '${displayTree(root, firstCreated)}'`);
    }
  };

  try {
    for (const item of prepared) {
      const operation = item.operation;
      if (operation.kind === "add") {
        await ensureParent(operation.path);
        unknown = [`'${operation.path.display}'`];
        try {
          await rename(item.stagePath!, operation.path.absolute);
        } catch (error) {
          throw new PatchCommitError(committed, unknown, errorCode(error));
        }
        stages.delete(item.stagePath!);
        unknown = [];
        committed.push(`added '${operation.path.display}'`);
        details.push({ operation: "add", path: operation.path.display });
        continue;
      }

      if (operation.kind === "delete") {
        unknown = [`'${operation.path.display}'`];
        try {
          await unlink(operation.path.absolute);
        } catch (error) {
          throw new PatchCommitError(committed, unknown, errorCode(error));
        }
        unknown = [];
        committed.push(`deleted '${operation.path.display}'`);
        details.push({ operation: "delete", path: operation.path.display });
        continue;
      }

      if (!operation.movePath) {
        unknown = [`'${operation.path.display}'`];
        try {
          await rename(item.stagePath!, operation.path.absolute);
        } catch (error) {
          throw new PatchCommitError(committed, unknown, errorCode(error));
        }
        stages.delete(item.stagePath!);
        unknown = [];
        committed.push(`updated '${operation.path.display}'`);
        details.push({ operation: "update", path: operation.path.display });
        continue;
      }

      await ensureParent(operation.movePath);
      unknown = [`'${operation.movePath.display}'`];
      try {
        await rename(item.stagePath!, operation.movePath.absolute);
      } catch (error) {
        throw new PatchCommitError(committed, unknown, errorCode(error));
      }
      stages.delete(item.stagePath!);
      unknown = [];
      committed.push(`moved destination '${operation.movePath.display}'`);
      unknown = [`'${operation.path.display}'`];
      try {
        await unlink(operation.path.absolute);
      } catch (error) {
        throw new PatchCommitError(committed, unknown, errorCode(error));
      }
      unknown = [];
      committed.push(`removed move source '${operation.path.display}'`);
      details.push({
        operation: "move",
        path: operation.movePath.display,
        from: operation.path.display,
      });
    }
    return details;
  } finally {
    await cleanupStages(stages);
  }
}

function noChangeError(error: unknown): Error {
  if (error instanceof PatchCommitError) return error;
  const reason =
    error instanceof PatchValidationError
      ? error.message
      : `filesystem preflight failed${errorCode(error) ? ` (${errorCode(error)})` : ""}`;
  return new Error(`apply_patch failed (no-change): ${reason}`);
}

async function executePatch(
  patch: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ApplyPatchDetail[]> {
  try {
    const root = await realpath(cwd);
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory()) {
      throw new PatchValidationError("the invocation cwd is not a directory");
    }
    const operations = parsePatch(patch, root);
    const identities = await queueIdentities(root, operations);
    return await withMutationQueues(identities, 0, async () => {
      const prepared = await prepareOperations(root, operations);
      abortIfRequested(signal);
      const stages = await stageOperations(prepared);
      try {
        abortIfRequested(signal);
      } catch (error) {
        await cleanupStages(stages);
        throw error;
      }
      return commitPrepared(root, prepared, stages);
    });
  } catch (error) {
    throw noChangeError(error);
  }
}

/**
 * Build the tool definition behind an enablement gate.
 *
 * The gate is injected rather than read from configuration so this module stays
 * a leaf: it owns patch parsing and the commit path, and never imports the
 * config store.
 */
function defineApplyPatchTool(
  isEnabled: () => boolean,
  invocationHooks?: ExecutionInvocationHooks,
) {
  return defineTool({
    name: APPLY_PATCH_TOOL,
    label: "Apply Patch",
    // The literal example matters for providers without grammar transport,
    // which send this envelope as a JSON string: a live run produced
    // "*** Begin Patch ***" twice and was rejected before any change.
    description: `Apply one Codex-format Begin Patch/End Patch text patch to files under the current workspace. A complete minimal envelope is exactly these four lines:
*** Begin Patch
*** Add File: notes/todo.md
+first line
*** End Patch
Send that text verbatim as the patch argument, with real newline characters (never the two characters backslash and n), no markdown fence and no surrounding quotes. Parsing is strict: the first line is exactly "*** Begin Patch" and the last is exactly "*** End Patch", with no trailing marker such as "*** Begin Patch ***"; every other line belongs to a "*** Add File: path", "*** Delete File: path" or "*** Update File: path" hunk; and a carriage return anywhere in the envelope is rejected. Existing source files, including Delete File targets, must be valid UTF-8 text with consistent LF or CRLF; non-UTF-8, bare CR and mixed line endings are rejected before mutation. Binary deletion is unsupported. A rejected envelope changes nothing.`,
    parameters: Type.Object(
      {
        patch: Type.String({
          description:
            'The complete Codex-format patch envelope, starting with the line "*** Begin Patch" and ending with the line "*** End Patch"; see the tool description for a minimal example.',
        }),
      },
      { additionalProperties: false },
    ),
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
    },
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      // Refuse before parsing or any filesystem access. Pi activates every
      // registered extension tool when it builds a session and the Toolkit only
      // removes disabled names on its own sync, so a dispatch can arrive while
      // the feature is off. Every sibling capability rechecks here for the same
      // reason; this one also mutates the workspace.
      if (!isEnabled()) throw new Error("Apply Patch is not enabled.");
      // The shared invocation seam, identical to the nested adapter's: the
      // applicable policy decides before parsing or any filesystem access.
      // This adds no new feature-local confirmation to direct Apply Patch.
      await resolveInvocation(invocationHooks, {
        tool: APPLY_PATCH_TOOL,
        path: "direct",
        cwd: ctx.cwd,
      });
      // Recheck after the awaited seam and before the first filesystem
      // access, exactly where the nested adapter rechecks `eligible()`: a
      // capability disabled or fenced while the hook was pending must not be
      // overtaken by a call that passed the entry check. Nothing has run.
      if (!isEnabled()) throw new Error("Apply Patch is not enabled.");
      const operations = await executePatch(params.patch, ctx.cwd, signal);
      const text = [
        "Applied patch:",
        ...operations.map((operation) =>
          operation.operation === "move"
            ? `- move ${operation.from} -> ${operation.path}`
            : `- ${operation.operation} ${operation.path}`,
        ),
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { operations },
      };
    },
  });
}

/**
 * Ungated definition, kept for the nested Code Mode adapter, which applies its
 * own enablement and ownership checks at dispatch time (see `src/index.ts`).
 * Do not register this with Pi directly — use {@link createApplyPatchTool}.
 */
export const APPLY_PATCH_TOOL_DEFINITION = defineApplyPatchTool(() => true);

/** Gated definition for direct Pi dispatch. */
export function createApplyPatchTool(
  isEnabled: () => boolean,
  invocationHooks?: ExecutionInvocationHooks,
) {
  return defineApplyPatchTool(isEnabled, invocationHooks);
}
