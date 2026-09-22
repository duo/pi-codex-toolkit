// Offline public-host qualification. No private Pi imports, auth files, or services.
// Usage: node tests/fixtures/code-mode-host-turn.mjs [host-package-root]
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  unlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @import { AgentSessionRuntime, CreateAgentSessionRuntimeFactory, ExtensionAPI, ExtensionError, ToolCallEvent, ToolExecutionUpdateEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent"
 * @import { Api, AssistantMessage, JsonObject, Model, ToolCall } from "@earendil-works/pi-ai"
 * @import { CodeModeCellResult } from "../../src/code-mode/manager.ts"
 * @import { ExecutionOutputRecovery } from "../../src/execution-output.ts"
 * @import { ShellSessionResult } from "../../src/shell/manager.ts"
 */
/** @typedef {ExecutionOutputRecovery & { path: string }} PublishedRecovery */
/**
 * A cell result as this fixture reads it. Every cell whose shells or recovery
 * it reads has published them, so those fields are present there.
 * @typedef {CodeModeCellResult & {
 *   shells: NonNullable<CodeModeCellResult["shells"]>,
 *   recovery: { output: PublishedRecovery },
 * }} FixtureCell
 */
/** @typedef {FixtureCell & { result: ShellSessionResult }} ShellCell */
/**
 * @typedef {FixtureCell & {
 *   result: { shellRecovery: { stdout: PublishedRecovery } },
 * }} LaunchedCell
 */
/**
 * @typedef {object} RootIdentity
 * @property {unknown} getAgentDir
 * @property {unknown} createAssistantMessageEventStream
 * @property {unknown} Type
 */

const repository = resolve(import.meta.dirname, "../..");
const hostRoot = await realpath(
  process.argv[2] ??
    join(repository, "node_modules/@earendil-works/pi-coding-agent"),
);
const hostManifest = JSON.parse(
  await readFile(join(hostRoot, "package.json"), "utf8"),
);
const root = await mkdtemp(join(tmpdir(), "pct-host-turn-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
const previousOffline = process.env.PI_OFFLINE;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_OFFLINE = "1";
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
// The cast keeps this assignment from declaring a second global `fetch`.
/** @type {typeof globalThis} */ (globalThis).fetch = async () => {
  networkAttempts++;
  throw new Error("network forbidden in host fixture");
};
/** @type {AgentSessionRuntime | undefined} */
let runtime;
// Pi's bounded cleanup timers may be unref'ed; a CLI fixture owns its liveness.
const keepAlive = setInterval(() => {}, 1000);
try {
  // Stage an isolated package. All peers resolve to the selected host, never
  // the repository's nearer node_modules. Follow only declared root exports.
  const stage = join(root, "package");
  await cp(join(repository, "src"), join(stage, "src"), { recursive: true });
  await cp(join(repository, "package.json"), join(stage, "package.json"));
  /** @param {string} name */
  async function peerRoot(name) {
    if (name === hostManifest.name) return hostRoot;
    let directory = hostRoot;
    for (;;) {
      const candidate = join(directory, "node_modules", name);
      try {
        return await realpath(candidate);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT")
          throw error;
      }
      const parent = dirname(directory);
      if (parent === directory)
        throw new Error(`missing installed peer ${name}`);
      directory = parent;
    }
  }
  /** @type {Record<string, { version: string, root: string }>} */
  const peers = {};
  for (const name of [
    hostManifest.name,
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    const target = await peerRoot(name);
    const destination = join(stage, "node_modules", name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(target, destination, "dir");
    const manifest = JSON.parse(
      await readFile(join(target, "package.json"), "utf8"),
    );
    peers[name] = { version: manifest.version, root: target };
  }
  /** @param {string} name */
  async function publicRoot(name) {
    const directory = peers[name].root;
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const entry = manifest.exports["."];
    const target =
      typeof entry === "string" ? entry : (entry.import ?? entry.default);
    assert.equal(
      typeof target,
      "string",
      "a declared public root export is required",
    );
    return import(pathToFileURL(join(directory, target)).href);
  }
  // Typed as the repository's pinned host, which is the default selected root.
  /** @type {typeof import("@earendil-works/pi-coding-agent")} */
  const sdk = await publicRoot(hostManifest.name);
  /** @type {typeof import("@earendil-works/pi-ai")} */
  const ai = await publicRoot("@earendil-works/pi-ai");
  /** @type {typeof import("typebox")} */
  const { Type } = await publicRoot("typebox");
  const identityPath = join(stage, "identity.ts");
  await writeFile(
    identityPath,
    `import {getAgentDir} from "@earendil-works/pi-coding-agent";\nimport {createAssistantMessageEventStream} from "@earendil-works/pi-ai";\nimport {Type} from "typebox";\nexport default function(pi) {pi.on("session_start",()=>pi.events.emit("fixture-root-identity",{getAgentDir,createAssistantMessageEventStream,Type}));}\n`,
  );
  const config = {
    applyPatch: { enabled: true },
    shellSessions: { enabled: true },
    codeMode: { enabled: true },
  };
  await mkdir(join(process.env.PI_CODING_AGENT_DIR, "extensions"), {
    recursive: true,
  });
  const configPath = join(
    process.env.PI_CODING_AGENT_DIR,
    "extensions/pi-codex-toolkit.json",
  );
  await writeFile(configPath, JSON.stringify(config));
  const models = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  /** @type {Model<Api>} */
  const model = {
    id: "deterministic",
    name: "Offline fixture",
    provider: "pct-offline-fixture",
    api: "pct-offline-fixture",
    baseUrl: "https://invalid.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 4096,
  };
  const errors = /** @type {ExtensionError[]} */ ([]),
    calls = /** @type {ToolCallEvent[]} */ ([]),
    updates = /** @type {ToolExecutionUpdateEvent[]} */ ([]),
    results = /** @type {ToolResultEvent[]} */ ([]);
  let identities = 0,
    providerCalls = 0,
    deliveredPatches = 0,
    plan = /** @type {Array<ToolCall | (() => ToolCall)>} */ ([]),
    callSequence = 0;
  /**
   * @param {string} name
   * @param {JsonObject} args
   * @returns {ToolCall}
   */
  const tc = (name, args) => ({
    type: "toolCall",
    id: `fixture-${++callSequence}`,
    name,
    arguments: args,
  });
  /** @param {ExtensionAPI} pi */
  function fixtureExtension(pi) {
    pi.events.on("fixture-root-identity", (identity) => {
      assert.equal(
        /** @type {RootIdentity} */ (identity).getAgentDir,
        sdk.getAgentDir,
      );
      assert.equal(
        /** @type {RootIdentity} */ (identity)
          .createAssistantMessageEventStream,
        ai.createAssistantMessageEventStream,
      );
      assert.equal(/** @type {RootIdentity} */ (identity).Type, Type);
      identities++;
    });
    pi.on("tool_call", (event) => {
      calls.push(structuredClone(event));
      if (
        event.toolName === "exec" &&
        /** @type {string} */ (event.input.code).includes("BLOCK_THIS")
      )
        return { block: true, reason: "fixture blocked outer code" };
    });
    // Nested phases surface as ordinary updates on the outer call. They are
    // not tool_call/tool_result events for the nested call, and they carry no
    // command, patch or program text.
    pi.on("tool_execution_update", (event) => {
      updates.push(structuredClone(event));
    });
    pi.on("tool_result", (event) => {
      results.push(structuredClone(event));
      return {
        content: [
          ...event.content,
          { type: "text", text: "fixture-outer-reviewed" },
        ],
      };
    });
    pi.registerProvider(model.provider, {
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey: "offline-fixture-not-a-secret",
      models: [model],
      streamSimple: (_model, context) => {
        providerCalls++;
        if (providerCalls > 60) throw new Error("fixture turn budget exceeded");
        const last = context.messages.at(-1);
        if (
          last?.role === "toolResult" &&
          last.content.some(
            (c) => c.type === "text" && c.text === "fixture-outer-reviewed",
          )
        )
          deliveredPatches++;
        const step = plan.shift();
        const call = typeof step === "function" ? step() : step;
        /** @type {AssistantMessage & { stopReason: "stop" | "toolUse" }} */
        const message = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: call ? [call] : [{ type: "text", text: "fixture done" }],
          stopReason: call ? "toolUse" : "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          timestamp: Date.now(),
        };
        const stream = ai.createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        });
        return stream;
      },
    });
  }
  /** @type {CreateAgentSessionRuntimeFactory} */
  const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      modelRuntime: models,
      settingsManager: sdk.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      resourceLoaderOptions: {
        additionalExtensionPaths: [stage, identityPath],
        extensionFactories: [fixtureExtension],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    const result = await sdk.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      tools: [
        "read",
        "bash",
        "exec",
        "wait",
        "exec_command",
        "write_stdin",
        "apply_patch",
      ],
    });
    assert.deepEqual(result.extensionsResult.errors, []);
    await result.session.bindExtensions({
      mode: "print",
      onError: (error) => errors.push(error),
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  runtime = await sdk.createAgentSessionRuntime(factory, {
    cwd: root,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    sessionManager: sdk.SessionManager.inMemory(root),
  });
  assert.equal(identities, 1, "loader root identities match selected host");
  /** @param {string} name */
  const tool = (name) => {
    const t = /** @type {AgentSessionRuntime} */ (
      runtime
    ).session.agent.state.tools.find((t) => t.name === name);
    assert.ok(t, `active ${name}`);
    return t;
  };
  const oldExec = tool("exec");
  // This role admits every owned execution name, and the legacy configuration
  // exposes the Shell pair and Apply Patch directly as well: the nested calls
  // below reach the same admitted owned executors, not a second backend. A name
  // this host filtered out would not be admitted, and its nested adapter would
  // be outside the cell's admitted set (see tests/tool-ownership-host.test.ts).
  for (const name of ["exec_command", "write_stdin", "apply_patch"]) tool(name);
  /** @param {ToolCall} call */
  async function turn(call) {
    const count = results.length;
    plan = [call];
    await /** @type {AgentSessionRuntime} */ (runtime).session.prompt(
      "Run the offline fixture plan, no other actions.",
    );
    assert.equal(plan.length, 0);
    return results.slice(count).at(-1);
  }
  /**
   * @param {JsonObject} args
   * @returns {Promise<FixtureCell>}
   */
  async function cell(args) {
    let result = /** @type {FixtureCell | undefined} */ (
      (await turn(tc("exec", args)))?.details
    );
    assert.ok(result);
    for (let n = 0; result.status === "running" && n < 20; n++)
      result = /** @type {FixtureCell} */ (
        /** @type {ToolResultEvent} */ (
          await turn(
            tc("wait", {
              cellId: result.cellId,
              yieldTimeMs: 1000,
              maxOutputBytes: 1024,
            }),
          )
        ).details
      );
    assert.equal(result.status, "completed");
    return result;
  }
  const marker = join(root, "must-not-exist");
  const blockedCode = `/* BLOCK_THIS */ return await tools.exec_command({command:${JSON.stringify(`touch '${marker}'`)}});`;
  await turn(tc("exec", { code: blockedCode, uses: ["exec_command"] }));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.ok(
    calls.some(
      (c) =>
        c.toolName === "exec" &&
        c.input.code === blockedCode &&
        /** @type {string[]} */ (c.input.uses)[0] === "exec_command",
    ),
  );
  // Declaring apply_patch no longer refuses the whole program: the cell runs
  // and only the actual nested mutation fails, here because this print-mode
  // session has no dialog-capable UI for the extra Code Mode approval.
  const headlessPatch = /** @type {ToolResultEvent} */ (
    await turn(
      tc("exec", {
        code: 'await tools.apply_patch("*** Begin Patch\\n*** Add File: must-not-patch\\n+no\\n*** End Patch");',
        uses: ["apply_patch"],
      }),
    )
  );
  assert.equal(
    /** @type {FixtureCell} */ (headlessPatch.details).status,
    "failed",
  );
  assert.ok(
    headlessPatch.content.some(
      (c) => c.type === "text" && c.text.includes("no dialog-capable UI"),
    ),
  );
  await assert.rejects(readFile(join(root, "must-not-patch")), {
    code: "ENOENT",
  });
  const patchProgress = updates
    .map((u) => ({ toolName: u.toolName, ...u.partialResult?.details }))
    .filter((r) => r.nested === true && r.name === "apply_patch");
  assert.deepEqual(
    patchProgress.map((r) => [r.toolName, r.phase, r.ok, r.error]),
    [
      ["exec", "start", undefined, undefined],
      ["exec", "waiting-approval", undefined, undefined],
      ["exec", "end", false, "approval-unavailable"],
    ],
    "nested phases arrive in order as updates on the outer exec call",
  );
  assert.ok(
    !JSON.stringify(patchProgress).includes("must-not-patch"),
    "nested progress carries control identity only, never patch text",
  );
  // A cell that declares the mutating adapter but never calls it completes.
  assert.equal(
    (
      await cell({
        code: 'return "pure";',
        uses: ["apply_patch"],
      })
    ).result,
    "pure",
  );
  const launched = /** @type {LaunchedCell} */ (
    await cell({
      code: `const s=await tools.exec_command({command:"printf 'SHELL_BEGIN\\n'; printf '%06000d\\n' 0; read line; printf 'SHELL_DONE\\n'",maxOutputBytes:1024,yieldTimeMs:200}); print("CELL_BEGIN\\n"+"cell-line\\n".repeat(1000)); return {shellRecovery:s.recovery};`,
      uses: ["exec_command"],
      maxOutputBytes: 1024,
    })
  );
  const shellId = launched.shells[0].sessionId;
  assert.equal(launched.shells[0].status, "running");
  const cellPath = launched.recovery.output.path;
  const shellPath = launched.result.shellRecovery.stdout.path;
  /**
   * @param {string} path
   * @param {string} text
   */
  async function recover(path, text) {
    const r = /** @type {ToolResultEvent} */ (
      await turn(tc("read", { path, limit: 2 }))
    );
    assert.ok(
      r.content.some((c) => c.type === "text" && c.text.includes(text)),
    );
  }
  await recover(cellPath, "CELL_BEGIN");
  await recover(shellPath, "SHELL_BEGIN");
  // The shell's output wakes a read before its exit can arrive, so read the
  // continued session to its end inside the cell, keeping every read's stdout.
  const continued = /** @type {ShellCell} */ (
    await cell({
      code: `const id=${JSON.stringify(shellId)}; let r=await tools.write_stdin({sessionId:id,input:"ok\\n",yieldTimeMs:1000}); let stdout=r.stdout; for (let n=0; r.status==="running" && n<20; n++) { r=await tools.write_stdin({sessionId:id,yieldTimeMs:1000}); stdout+=r.stdout; } return {...r,stdout};`,
      uses: ["write_stdin"],
    })
  );
  assert.equal(continued.result.status, "completed");
  assert.ok(continued.result.stdout.includes("SHELL_DONE"));
  config.shellSessions.enabled = false;
  config.codeMode.enabled = false;
  await writeFile(configPath, JSON.stringify(config));
  const callsBeforeReload = providerCalls;
  await runtime.session.prompt("/pct reload");
  assert.equal(
    providerCalls,
    callsBeforeReload,
    "command reload does not invoke provider",
  );
  assert.ok(!runtime.session.agent.state.tools.some((t) => t.name === "exec"));
  await recover(cellPath, "CELL_BEGIN");
  await recover(shellPath, "SHELL_BEGIN");
  config.shellSessions.enabled = true;
  config.codeMode.enabled = true;
  await writeFile(configPath, JSON.stringify(config));
  await runtime.newSession();
  assert.equal(identities, 2);
  await assert.rejects(readFile(cellPath), { code: "ENOENT" });
  await assert.rejects(readFile(shellPath), { code: "ENOENT" });
  await assert.rejects(oldExec.execute("stale", { code: "return 0;" }));
  // Codex spellings through the real host: cmd is the same field as command.
  const fresh = await cell({
    code: 'const r = await tools.exec_command({cmd:"printf fresh"}); return r.stdout + ":" + (r.session_id === r.sessionId);',
    uses: ["exec_command"],
  });
  assert.equal(fresh.result, "fresh:true");
  assert.deepEqual(errors, []);
  assert.ok(results.length >= 7);
  assert.equal(
    deliveredPatches,
    results.length,
    "outer tool_result patches reach the provider context",
  );
  assert.ok(
    calls.every((c) => ["exec", "wait", "read"].includes(c.toolName)),
    "nested adapters do not masquerade as native tool hooks",
  );
  assert.ok(
    updates.every((u) => ["exec", "wait"].includes(u.toolName)),
    "nested progress stays an update on the outer call",
  );
  assert.equal(networkAttempts, 0);
  let shutdownFailure;
  if (process.argv.includes("--shutdown-failure")) {
    assert.notEqual(process.platform, "win32");
    const live = /** @type {ShellCell} */ (
      await cell({
        code: 'return await tools.exec_command({command:"echo $$; read line",yieldTimeMs:200});',
        uses: ["exec_command"],
      })
    );
    const group = Number(live.result.stdout.trim());
    assert.ok(group > 0);
    const paths = /** @type {string[]} */ (
      Object.values(
        /** @type {NonNullable<ShellSessionResult["recovery"]>} */ (
          live.result.recovery
        ),
      )
        .map((c) => c.path)
        .filter(Boolean)
    );
    const ownerDirectory = dirname(paths[0]);
    assert.ok(ownerDirectory.includes("/pct-output-"));
    const previousSession = runtime.session;
    const originalKill = process.kill;
    const kill = originalKill.bind(process);
    try {
      process.kill = (pid, signal) => {
        if (pid === -group && signal !== 0)
          throw Object.assign(new Error("fixture stop refused"), {
            code: "EPERM",
          });
        return kill(pid, signal);
      };
      await runtime.newSession();
      assert.ok(
        runtime.session === previousSession,
        "failed cleanup must cancel replacement, not orphan live controls",
      );
      assert.equal(identities, 2);
      assert.deepEqual(errors, []);
      await readFile(paths[0]);
      process.kill = originalKill;
      // A real stop's exit can outlast a 1 s yield under CPU contention; the
      // default yield still returns as soon as the exit is confirmed.
      const retried = /** @type {ShellCell} */ (
        await cell({
          code: `return await tools.write_stdin({sessionId:${JSON.stringify(live.result.sessionId)},terminate:true});`,
          uses: ["write_stdin"],
        })
      );
      assert.equal(retried.result.status, "terminated");
      assert.equal(retried.result.unknownOutcome, undefined);
      assert.throws(() => kill(-group, 0));
      await readFile(paths[0]);
      await runtime.newSession();
      assert.equal(identities, 3);
      for (const path of paths)
        await assert.rejects(readFile(path), { code: "ENOENT" });
      shutdownFailure = {
        verdict: "pass",
        failedCleanupCancelledReplacement: true,
        oldShellControlledThroughRealAgentTurn: true,
        successfulRetryRemovedFiles: true,
        cleanup:
          "public stop retry; finally rescues only the fixture's exact process group and published files",
      };
    } finally {
      process.kill = originalKill;
      try {
        kill(-group, "SIGKILL");
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
      for (const path of paths) {
        assert.equal(dirname(path), ownerDirectory);
        await unlink(path).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      }
      await rmdir(ownerDirectory).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  }
  await runtime.dispose();
  runtime = undefined;
  console.log(
    JSON.stringify(
      {
        verdict: "pass",
        ...(shutdownFailure ? { shutdownFailure } : {}),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        hostVersion: hostManifest.version,
        hostRoot,
        stage: "copied-source-with-selected-host-peer-symlinks",
        peers,
        rootIdentityChecks: identities,
        provider: "deterministic local event stream only; no external model",
        providerCalls,
        outerCalls: calls.length,
        outerUpdates: updates.length,
        deliveredPatches,
        networkAttempts,
        checks: [
          "public loader/bind",
          "host peer identity",
          "real agent tool_call block with code/uses and no effects",
          "real tool_result transformation",
          "headless extra Apply Patch approval fails at the nested call, without effects",
          "bounded nested progress on the outer call only",
          "declared-but-unused Apply Patch completes headlessly",
          "admitted shell pair reached through the nested adapters",
          "cell/shell native read recovery",
          "independent shell continuation",
          "feature-disable retained files",
          "real newSession removes files and invalidates old wrapper",
          "fresh session nested shell (cmd alias)",
          "dispose",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("HOST_FIXTURE_FAILURE", error);
  throw error;
} finally {
  try {
    await runtime?.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await rm(root, { recursive: true, force: true });
    clearInterval(keepAlive);
  }
}
