// Explicit opt-in: node tests/fixtures/computer-use-approval-runtime.mjs
// Fixture-only qualification pin; normal product discovery is NOT version-pinned.
// No installed Sky/helper/model effects: only a scratch-authored RPC service.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

/**
 * @import { ChildProcess } from "node:child_process"
 * @import { BinaryLike } from "node:crypto"
 * @import { Readable } from "node:stream"
 */
/**
 * The preflight gate, printed with the run's result.
 * @typedef {object} Gate
 * @property {string} status
 * @property {string} [reason]
 * @property {Record<string, string>} [hashes]
 * @property {number} nativeProbeStarts
 * @property {number} versionProbeStarts
 * @property {{ codex: string, node: string, nodeReplBuild: string }} [versions]
 */
/** @typedef {{ name: string, elapsedMs: number }} TimedEvent */
/** @typedef {{ event: string, app?: string, pid: number, at: number }} Effect */
/**
 * The worker's result, which the supervisor then extends.
 * @typedef {object} Outcome
 * @property {string} status
 * @property {string} [reason]
 * @property {TimedEvent[]} [events]
 * @property {Effect[]} [effects]
 * @property {Record<string, string>} [sourceHashes]
 * @property {boolean} [clientHomesCleaned]
 * @property {string} [retainedRoot]
 * @property {boolean} [ownedGroupSettled]
 * @property {number[]} [observedProducerPids]
 * @property {boolean} [observedProducersSettled]
 * @property {boolean} [scratchRemoved]
 */
/** @typedef {{ event?: string, result?: Outcome }} WorkerMessage */
/**
 * The client's private request budget, which this fixture reads and shortens.
 * @typedef {{ requestTimeoutMs: number }} ClientSeam
 */

const RESOURCES = "/Applications/ChatGPT.app/Contents/Resources";
export const QUALIFIED = {
  platform: "darwin",
  arch: "arm64",
  codexVersion: "codex-cli 0.154.0-alpha.6.2",
  nodeVersion: "v24.20.0",
  components: {
    codex: {
      bytes: 222786528,
      sha256:
        "ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb",
    },
    "cua_node/bin/node_repl": {
      bytes: 18725584,
      sha256:
        "7f4e1f710c67a56cde3dbe8632f60dc0b3ed5dfcef1f214c4ee5e801928dd16c",
    },
    "cua_node/bin/node": {
      bytes: 121909840,
      sha256:
        "b07bcf7daad5ae812af19b0a3028f3c3a282ccaa4d6e389a1763bce197060bc5",
    },
  },
  manifestSha256:
    "4e65a2031e6b0cf56b39bbbe9ec5ffbdd770acc53e3b81e99e08c6a5a3d7d18f",
  manifest: {
    platform: "darwin",
    arch: "arm64",
    target: "darwin-arm64",
    node_version: "24.20.0",
    node_archive_path: "v24.20.0/node-v24.20.0-darwin-arm64.tar.gz",
    runtime_archive_name:
      "cua-node-0.0.11-20260909002225-0b90dbee8d2e-darwin-arm64.tar.gz",
    runtime_archive_version: "0.0.11/20260909002225-0b90dbee8d2e",
    node_path: "bin/node",
    node_modules: "lib/node_modules",
    node_repl_path: "bin/node_repl",
  },
};
/** @param {BinaryLike} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exec = promisify(execFile);
/**
 * @param {string} reason
 * @returns {Gate}
 */
const blocked = (reason) => ({
  status: "blocked",
  reason,
  nativeProbeStarts: 0,
  versionProbeStarts: 0,
});

/**
 * @param {string} resources
 * @returns {Promise<Gate>}
 */
export async function preflight(resources) {
  if (
    process.platform !== QUALIFIED.platform ||
    process.arch !== QUALIFIED.arch
  )
    return blocked("unsupported-platform");
  const paths = [
    ...Object.keys(QUALIFIED.components),
    "cua_node/manifest.json",
  ];
  try {
    for (const path of paths) {
      const full = join(resources, path);
      await access(
        full,
        constants.R_OK | (path.endsWith(".json") ? 0 : constants.X_OK),
      );
      if (!(await stat(full)).isFile()) return blocked("unsafe-component");
    }
  } catch {
    return blocked("missing-component");
  }
  /** @type {Record<string, string>} */
  const hashes = {};
  try {
    for (const [path, expected] of Object.entries(QUALIFIED.components)) {
      const bytes = await readFile(join(resources, path));
      hashes[path] = sha256(bytes);
      if (bytes.length !== expected.bytes || hashes[path] !== expected.sha256)
        return blocked("component-identity-mismatch");
    }
    const bytes = await readFile(join(resources, "cua_node/manifest.json"));
    hashes["cua_node/manifest.json"] = sha256(bytes);
    assert.equal(hashes["cua_node/manifest.json"], QUALIFIED.manifestSha256);
    assert.deepEqual(JSON.parse(String(bytes)), QUALIFIED.manifest);
  } catch {
    return blocked("component-identity-mismatch");
  }
  return {
    status: "qualified-bytes",
    hashes,
    nativeProbeStarts: 0,
    versionProbeStarts: 0,
  };
}

/** @param {string} root */
function isolatedEnvironment(root) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: join(root, "home"),
    CODEX_HOME: join(root, "codex-home"),
    TMPDIR: join(root, "tmp"),
    LANG: "en_US.UTF-8",
  };
}

// This worker runs the actual source client. No replacement of client methods.
/** @param {string} root */
async function worker(root) {
  assert.equal(typeof process.send, "function");
  const ts = (await import("typescript")).default;
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
  const modules = join(root, "node_modules");
  const sky = join(modules, "@oai", "sky");
  await mkdir(sky, { recursive: true });
  await writeFile(
    join(sky, "package.json"),
    JSON.stringify({
      name: "@oai/sky",
      type: "module",
      exports: { ".": "./index.mjs", "./service": "./service.mjs" },
    }),
  );
  // A tiny test-authored replacement, not copied Sky or a native helper.
  await writeFile(
    join(sky, "index.mjs"),
    `
const setup = await nodeRepl.rpc("sky", { type: "setup" });
export const sky = { target: setup.target };
for (const method of setup.methods) sky[method] = (...args) => nodeRepl.rpc("sky", { type: "execute", method, args });
`,
  );
  await writeFile(
    join(sky, "service.mjs"),
    `
const events = [];
const record = (event, app) => events.push({ event, app, pid: process.pid, at: Date.now() });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function handleRpc(input) {
  if (input.type === "setup") { record("setup"); return { target: "mac", methods: ["list_apps", "get_app_state", "click"] }; }
  if (input.type !== "execute") throw new Error("synthetic protocol");
  const app = input.args[0]?.app;
  if (input.method === "list_apps") return events;
  if (input.method === "get_app_state") return { text: "synthetic state" };
  if (input.method !== "click" || !["invalid.r06b.long", "invalid.r06b.timeout"].includes(app)) throw new Error("synthetic boundary");
  record("call", app);
  const decision = await nodeRepl.createElicitation({ message: "Synthetic approval", meta: {
    codex_approval_kind: "mcp_tool_call", connector_id: "computer-use", connector_name: "Computer Use",
    tool_name: "click", tool_params: { app }, persist: ["session"],
  } });
  if (decision.action !== "accept") throw new Error("synthetic declined");
  return nodeRepl.withSuspendedTimeout(async () => {
    record("effect-start", app);
    if (app === "invalid.r06b.timeout") {
      // A synchronous second approval acknowledges entry into the actual
      // suspended operation; it is not a filesystem or desktop side effect.
      const started = await nodeRepl.createElicitation({ message: "Synthetic effect started", meta: {
        codex_approval_kind: "mcp_tool_call", connector_id: "computer-use",
        tool_params: { app: "invalid.r06b.timeout.effect" }, persist: ["session"],
      } });
      if (started.action !== "accept") throw new Error("synthetic declined");
    }
    await wait(app === "invalid.r06b.timeout" ? 2500 : 100);
    record("effect-end", app);
  });
}
`,
  );
  const homes = join(root, "clients");
  await mkdir(homes);
  const config = [
    'model_provider="r06b_offline"',
    'model="synthetic-no-turn"',
    'model_providers.r06b_offline.name="Offline synthetic"',
    'model_providers.r06b_offline.base_url="http://127.0.0.1:9/v1"',
    'model_providers.r06b_offline.wire_api="responses"',
    "model_providers.r06b_offline.requires_openai_auth=false",
    'cli_auth_credentials_store="file"',
    'mcp_oauth_credentials_store="file"',
    "analytics.enabled=false",
    "check_for_update_on_startup=false",
    "sandbox_read_only.network_access=false",
  ];
  const client = new ComputerUseClient({
    runtime: {
      codexPath: join(RESOURCES, "codex"),
      nodeReplPath: join(RESOURCES, "cua_node/bin/node_repl"),
      nodePath: join(RESOURCES, "cua_node/bin/node"),
      nodeModulesPath: modules,
      helperPath: join(root, "UNUSABLE-NO-NATIVE-HELPER"),
    },
    appServerArgs: [
      "app-server",
      "--stdio",
      ...config.flatMap((value) => ["-c", value]),
    ],
    environment: isolatedEnvironment(root),
    temporaryRoot: homes,
  });
  const seam = /** @type {ClientSeam} */ (/** @type {unknown} */ (client));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("message", cancel);
  /** @type {TimedEvent[]} */
  const events = [];
  const start = performance.now();
  /** @param {string} name */
  const event = (name) => {
    events.push({ name, elapsedMs: Math.round(performance.now() - start) });
    /** @type {NonNullable<typeof process.send>} */ (process.send)({
      event: name,
    });
  };
  /** @type {Outcome | undefined} */
  let outcome;
  /** @type {NodeJS.Timeout | undefined} */
  let holdTimer;
  /** @type {AbortSignal | undefined} */
  let forwardedSignal;
  try {
    event("native-probe-start");
    await client.probeTarget(controller.signal);
    await client.invoke("list_apps", {}, controller.signal);
    assert.equal(seam.requestTimeoutMs, 130_000);
    event("warmed");
    let approvals = 0;
    const result = await client.invoke(
      "click",
      { app: "invalid.r06b.long", x: 0, y: 0 },
      controller.signal,
      (_message, signal) => {
        forwardedSignal = signal;
        approvals++;
        event("long-approval");
        return new Promise((resolve) => {
          const abort = () => {
            clearTimeout(holdTimer);
            resolve(false);
          };
          signal.addEventListener("abort", abort, { once: true });
          holdTimer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            event("long-answer");
            resolve(true);
          }, 135_000);
        });
      },
    );
    assert.equal(result.details.method, "click");
    assert.equal(approvals, 1);
    assert.equal(/** @type {AbortSignal} */ (forwardedSignal).aborted, true);
    assert.ok(
      /** @type {TimedEvent} */ (
        events.find((row) => row.name === "long-answer")
      ).elapsedMs -
        /** @type {TimedEvent} */ (
          events.find((row) => row.name === "long-approval")
        ).elapsedMs >
        130_000,
    );
    event("long-success");
    const audit = await client.invoke("list_apps", {}, controller.signal);
    const rows = /** @type {Effect[]} */ (
      /** @type {unknown} */ (
        JSON.parse(
          /** @type {{ type: "text", text: string }} */ (
            audit.content.find((block) => block.type === "text")
          ).text,
        )
      )
    );
    for (const name of ["call", "effect-start", "effect-end"]) {
      assert.equal(
        rows.filter(
          (row) => row.app === "invalid.r06b.long" && row.event === name,
        ).length,
        1,
      );
    }
    // Existing post-startup timeout seam. Inner argument remains 120 seconds;
    // the service explicitly suspends it, while the outer budget still expires.
    seam.requestTimeoutMs = 500;
    const before = performance.now();
    let timeoutApprovals = 0;
    await assert.rejects(
      client.invoke(
        "click",
        { app: "invalid.r06b.timeout", x: 0, y: 0 },
        controller.signal,
        (message) => {
          assert.equal(
            message,
            timeoutApprovals++ === 0
              ? "Synthetic approval"
              : "Synthetic effect started",
          );
          event(
            timeoutApprovals === 1
              ? "timeout-approval"
              : "suspended-effect-started",
          );
          return true;
        },
      ),
      {
        category: "timeout",
        unknownDesktopOutcome: true,
      },
    );
    assert.ok(performance.now() - before < 2_000);
    event("active-timeout");
    assert.equal(timeoutApprovals, 2);
    await assert.rejects(
      client.invoke("click", { app: "invalid.r06b.timeout" }),
      { category: "inspection-required" },
    );
    outcome = {
      status: "passed",
      events,
      effects: rows,
      sourceHashes: Object.fromEntries(
        await Promise.all(
          [
            "../../src/computer-use/app-server-client.ts",
            "../../src/computer-use/tools.ts",
            "../../src/index.ts",
          ].map(async (path) => [
            path,
            sha256(await readFile(new URL(path, import.meta.url))),
          ]),
        ),
      ),
    };
  } catch (error) {
    outcome = {
      status: "failed",
      reason:
        /** @type {{ category?: string } | null | undefined} */ (error)
          ?.category ?? "assertion-or-runtime-failure",
      events,
    };
  } finally {
    clearTimeout(holdTimer);
    controller.abort();
    try {
      await client.close();
      assert.deepEqual(await readdir(homes), []);
      /** @type {Outcome} */ (outcome).clientHomesCleaned = true;
    } catch {
      /** @type {Outcome} */ (outcome).status = "failed";
      /** @type {Outcome} */ (outcome).reason = "client-cleanup-failure";
    }
    process.off("message", cancel);
  }
  /** @type {NonNullable<typeof process.send>} */ (process.send)({
    result: outcome,
  });
  process.disconnect();
  process.exitCode = outcome.status === "passed" ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--worker" && args.length === 2 && process.send)
    return worker(args[1]);
  const preflightOnly = args[0] === "--preflight-only" && args.length === 2;
  if (args.length && !preflightOnly) {
    console.log(JSON.stringify(blocked("unsafe-arguments")));
    process.exitCode = 2;
    return;
  }
  const gate = await preflight(preflightOnly ? args[1] : RESOURCES);
  if (gate.status === "blocked" || preflightOnly) {
    // A bytes-only diagnostic must never be mistaken for lane acceptance.
    console.log(
      JSON.stringify(
        gate.status === "blocked" ? gate : blocked("preflight-only"),
      ),
    );
    process.exitCode = 2;
    return;
  }
  /** @type {string | undefined} */
  let root;
  /** @type {ChildProcess | undefined} */
  let child;
  /** @type {Outcome | undefined} */
  let result;
  /** @type {NodeJS.Timeout | undefined} */
  let supervisor;
  /** @type {NodeJS.Timeout | undefined} */
  let escalation;
  /** @type {NodeJS.Timeout | undefined} */
  let hardStop;
  let closed = false;
  /** @type {Set<number>} */
  const ownedPids = new Set();
  let observations = Promise.resolve();
  const observeProducers = async () => {
    // Numeric process relationships only: no arguments, environment or user data.
    const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,pgid="], {
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    });
    const rows = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    let added;
    do {
      added = false;
      for (const [pid, ppid, pgid] of rows) {
        if (
          !ownedPids.has(pid) &&
          (ownedPids.has(ppid) ||
            pgid === /** @type {ChildProcess} */ (child).pid)
        ) {
          ownedPids.add(pid);
          added = true;
        }
      }
    } while (added);
  };
  try {
    root = await mkdtemp(join(tmpdir(), "pct-approval-runtime-"));
    for (const path of ["home", "codex-home", "tmp"])
      await mkdir(join(root, path));
    const env = isolatedEnvironment(root);
    for (const [path, expected] of [
      ["codex", QUALIFIED.codexVersion],
      ["cua_node/bin/node", QUALIFIED.nodeVersion],
    ]) {
      gate.versionProbeStarts++;
      /** @type {{ stdout: string, stderr: string }} */
      const output = await exec(join(RESOURCES, path), ["--version"], {
        cwd: root,
        env,
        timeout: 5_000,
        maxBuffer: 4096,
      });
      assert.equal(output.stdout.trim(), expected);
    }
    gate.versions = {
      codex: QUALIFIED.codexVersion,
      node: QUALIFIED.nodeVersion,
      nodeReplBuild: QUALIFIED.manifest.runtime_archive_version,
    };
    child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--worker", root],
      {
        cwd: root,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    // A spawn without a pid emits `error`, so `exit` rejects before the set is read.
    ownedPids.add(/** @type {number} */ (child.pid));
    /** @type {Readable} */ (child.stdout).resume();
    /** @type {Readable} */ (child.stderr).resume();
    child.on("message", (message) => {
      const received = /** @type {WorkerMessage} */ (
        /** @type {unknown} */ (message)
      );
      // Long-lived descendants are captured at warmup and again before reset,
      // including children that establish their own process group.
      if (received.event) observations = observations.then(observeProducers);
      void observations.catch(() => {});
      if (received.event === "native-probe-start") gate.nativeProbeStarts++;
      if (received.result) result = received.result;
    });
    // Test-only supervision, not a product human deadline. Never SIGKILL.
    supervisor = setTimeout(() => {
      result = { status: "failed", reason: "supervisor-timeout" };
      if (/** @type {ChildProcess} */ (child).connected)
        /** @type {ChildProcess} */ (child).send("cancel");
      escalation = setTimeout(() => {
        try {
          process.kill(
            -(/** @type {number} */ (/** @type {ChildProcess} */ (child).pid)),
            "SIGTERM",
          );
        } catch {
          /* already exited */
        }
      }, 10_000);
      hardStop = setTimeout(() => {
        console.log(
          JSON.stringify({
            status: "failed",
            reason: "cleanup-unconfirmed",
            retainedRoot: root,
          }),
        );
        process.exit(1); // Preserve scratch; no false cleanup or escalation.
      }, 20_000);
    }, 200_000);
    /** @type {{ code: number | null, signal: NodeJS.Signals | null }} */
    const exit = await new Promise((resolve, reject) => {
      /** @type {ChildProcess} */ (child).once("error", reject);
      /** @type {ChildProcess} */ (child).once("close", (code, signal) =>
        resolve({ code, signal }),
      );
    });
    closed = true;
    clearTimeout(supervisor);
    clearTimeout(escalation);
    clearTimeout(hardStop);
    await observations;
    result ??= { status: "failed", reason: "worker-no-result" };
    if (exit.code !== 0) result.status = "failed";
    for (const effect of result.effects ?? []) ownedPids.add(effect.pid);
    // Allow finite synthetic service completion and ordinary producer teardown.
    let alive = true;
    for (let i = 0; i < 60; i++) {
      alive = false;
      for (const pid of [-(/** @type {number} */ (child.pid)), ...ownedPids]) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH")
            alive = true;
        }
      }
      if (!alive) break;
      await sleep(100);
    }
    if (alive) {
      result = {
        ...result,
        status: "failed",
        reason: "producer-cleanup-unconfirmed",
        retainedRoot: root,
      };
    } else {
      await rm(root, { recursive: true, force: true });
      result.ownedGroupSettled = true;
      result.observedProducerPids = [...ownedPids];
      result.observedProducersSettled = true;
      result.scratchRemoved = true;
    }
    console.log(
      JSON.stringify({
        ...gate,
        ...result,
        workerExit: exit,
        fixtureSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
      }),
    );
    process.exitCode = result.status === "passed" ? 0 : 1;
  } catch {
    console.log(
      JSON.stringify({
        status: gate.nativeProbeStarts ? "failed" : "blocked",
        reason: gate.nativeProbeStarts
          ? "supervision-or-cleanup-failure"
          : "unsafe-setup-or-version",
        nativeProbeStarts: gate.nativeProbeStarts,
        versionProbeStarts: gate.versionProbeStarts,
        retainedRoot: root,
      }),
    );
    process.exitCode = gate.nativeProbeStarts ? 1 : 2;
    if (root && !child) await rm(root, { recursive: true, force: true });
  } finally {
    if (!child || closed) {
      clearTimeout(supervisor);
      clearTimeout(escalation);
      clearTimeout(hardStop);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
