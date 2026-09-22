// Isolated host-crash regression: run the real client against a finite fake peer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** @import { ChildProcessWithoutNullStreams } from "node:child_process" */
/**
 * The client's private members this fixture drives.
 * @typedef {object} ClientSeam
 * @property {ChildProcessWithoutNullStreams} [child]
 * @property {(signal?: AbortSignal) => Promise<void>} ensureStarted
 */

// Load the actual source without copying it or relying on strip-only support
// for TypeScript parameter properties. Use the already installed compiler.
registerHooks({
  load(url, context, next) {
    if (!url.endsWith(".ts")) return next(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
    };
  },
});
const { ComputerUseClient } = await import(
  "../../src/computer-use/app-server-client.ts"
);
const root = process.argv[2];
const homes = join(root, "homes");
await mkdir(homes);
const client = new ComputerUseClient({
  runtime: {
    codexPath: process.execPath,
    nodeReplPath: "/fake/node_repl",
    nodePath: process.execPath,
    nodeModulesPath: "/fake/modules",
    helperPath: "/fake/helper",
  },
  appServerArgs: [
    fileURLToPath(new URL("./fake-app-server.ts", import.meta.url)),
  ],
  environment: { ...process.env, FAKE_APP_SERVER_SCENARIO: "normal" },
  temporaryRoot: homes,
  // Covers the fake app server's own start, which the first request includes.
  requestTimeoutMs: 6_000,
});
const seam = /** @type {ClientSeam} */ (/** @type {unknown} */ (client));
/** @type {unknown[]} */
const codes = [];
let submissions = 0;
let settlements = 0;
try {
  await seam.ensureStarted();
  const child = /** @type {ChildProcessWithoutNullStreams} */ (seam.child);
  // Observe without handling the error: the original emit still throws if the
  // client has no stdin error listener. No global exception/rejection handler.
  const emit = child.stdin.emit;
  child.stdin.emit = /** @type {typeof emit} */ (
    function (event, ...args) {
      if (event === "error") codes.push(args[0].code);
      return emit.call(this, event, ...args);
    }
  );
  /** @type {Promise<void>} */
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("input-close barrier")),
      2_000,
    );
    child.stdout.on("data", (chunk) => {
      if (chunk.includes('"fake/input-closed"')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  // Test control only; the failing action below still uses the real client.
  child.stdin.write(`${JSON.stringify({ method: "fake/close-input" })}\n`);
  await ready;
  // Forwards whichever overload the caller used.
  const write = /** @type {(...args: unknown[]) => boolean} */ (
    child.stdin.write
  );
  child.stdin.write = function (...args) {
    submissions++;
    return write.apply(this, args);
  };
  const outcome = await client
    .invoke("type_text", {
      app: "Fake App",
      text: "x".repeat(64 * 1024),
    })
    .then(
      () => {
        settlements++;
        return undefined;
      },
      (error) => {
        settlements++;
        return error;
      },
    );
  assert.equal(outcome?.category, "process-exit");
  assert.equal(outcome?.unknownDesktopOutcome, true);
  await assert.rejects(client.invoke("click", { app: "Fake App" }), {
    category: "inspection-required",
  });
  await client.close();
  assert.ok(codes.includes("EPIPE"), `Expected real EPIPE, got ${codes}`);
  assert.equal(submissions, 1);
  assert.equal(settlements, 1);
  assert.deepEqual(await readdir(homes), []);
  console.log(
    JSON.stringify({ codes, submissions, settlements, cleaned: true }),
  );
} finally {
  await client.close();
}
