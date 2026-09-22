// Test-source CLI only: node tests/fixtures/assert-default-status.mjs <status-file>
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// Deliberately independent of the runtime config/status implementation.
const expectedCapabilities = new Set([
  "Web Search",
  "Remote Compaction",
  "Image Generation",
  "Apply Patch",
  "Computer Use",
  "Shell Sessions",
  "Code Mode",
  "Tool Discovery",
]);
const maxBytes = 64 * 1024;

/**
 * The failure classes this CLI can report. Each names what kind of check
 * rejected the run, never which value, path or byte did it.
 *
 * @typedef {"usage" | "unreadable" | "encoding" | "format" | "capability-on" | "incomplete"} FailureClass
 */

class ValidationFailure extends Error {
  /** @param {FailureClass} failureClass */
  constructor(failureClass) {
    super(failureClass);
    this.failureClass = failureClass;
  }
}

/** @param {string} path */
function readBytes(path) {
  try {
    const fd = openSync(path, "r");
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes) throw new Error();
      // Cap the read itself too, even if the file grows after fstat.
      const bytes = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > maxBytes) throw new Error();
      return bytes.subarray(0, length);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new ValidationFailure("unreadable");
  }
}

/** @param {Uint8Array} bytes */
function decodeStatus(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationFailure("encoding");
  }
}

/** @param {string} text */
function assertDefaultStatus(text) {
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  /** @type {Set<string> | undefined} */
  let fields;
  for (const line of text.split(/\r?\n/u)) {
    // Inspect every state record, including records beneath global/unknown
    // headings; extra off records must not be silently ignored.
    const field = /^\s*(configured|effective)\s*:/u.exec(line);
    if (field) {
      const name = field[1];
      // Orphan record, duplicate record, or a record that is not exactly
      // `  <name>: <value>`: the shape is wrong, whatever the value says.
      if (!fields || fields.has(name)) throw new ValidationFailure("format");
      const prefix = `  ${name}: `;
      if (!line.startsWith(prefix)) throw new ValidationFailure("format");
      if (line.slice(prefix.length) !== "off") {
        throw new ValidationFailure("capability-on");
      }
      fields.add(name);
    } else if (/^\S/u.test(line)) {
      // Any top-level heading/metadata ends the preceding capability block.
      fields = undefined;
      if (line.endsWith(":")) {
        const name = line.slice(0, -1);
        if (expectedCapabilities.has(name)) {
          if (seen.has(name)) throw new ValidationFailure("format");
          fields = new Set();
          seen.set(name, fields);
        }
      }
    }
  }
  if (
    seen.size !== expectedCapabilities.size ||
    [...seen.values()].some((fields) => fields.size !== 2)
  ) {
    throw new ValidationFailure("incomplete");
  }
}

try {
  if (process.argv.length !== 3) throw new ValidationFailure("usage");
  assertDefaultStatus(decodeStatus(readBytes(process.argv[2])));
} catch (error) {
  // Never echo arbitrary status content, paths, arguments or raw I/O errors:
  // only the fixed class of the check that rejected. Every throw above carries
  // one; anything else reaching here failed while reading the file.
  const failureClass =
    error instanceof ValidationFailure ? error.failureClass : "unreadable";
  process.stderr.write(
    `Default-off status validation failed: ${failureClass}.\n`,
  );
  process.exitCode = 1;
}
