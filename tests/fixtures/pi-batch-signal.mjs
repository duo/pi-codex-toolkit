// Offline host-assumption probe through Pi's public SDK. No Toolkit, auth files,
// services or private Pi imports. Shell and Code Mode keep `executionMode` absent
// because Pi hands every tool call of one assistant message the same run
// AbortSignal, runs non-sequential calls in that batch concurrently, and a run
// abort therefore cancels them together. This fixture reports those facts.
// Usage: node tests/fixtures/pi-batch-signal.mjs [host-package-root]
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @import { AgentSessionRuntime, CreateAgentSessionRuntimeFactory, ExtensionAPI, ExtensionError } from "@earendil-works/pi-coding-agent"
 * @import { Api, AssistantMessage, Model } from "@earendil-works/pi-ai"
 */

const repository = resolve(import.meta.dirname, "../..");
const hostRoot = await realpath(
  process.argv[2] ??
    join(repository, "node_modules/@earendil-works/pi-coding-agent"),
);
const hostManifest = JSON.parse(
  await readFile(join(hostRoot, "package.json"), "utf8"),
);
const root = await mkdtemp(join(tmpdir(), "pct-batch-signal-"));
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
  // Peers resolve from the selected host, never from a nearer node_modules.
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
  // Follow only a declared root export.
  /** @param {string} name */
  async function publicRoot(name) {
    const directory = await peerRoot(name);
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const entry = manifest.exports["."];
    const target =
      typeof entry === "string" ? entry : (entry.import ?? entry.default);
    if (typeof target !== "string")
      throw new Error(`${name} declares no public root export`);
    return import(pathToFileURL(join(directory, target)).href);
  }
  // Typed as the repository's pinned host, which is the default selected root.
  /** @type {typeof import("@earendil-works/pi-coding-agent")} */
  const sdk = await publicRoot(hostManifest.name);
  /** @type {typeof import("@earendil-works/pi-ai")} */
  const ai = await publicRoot("@earendil-works/pi-ai");
  /** @type {typeof import("typebox")} */
  const { Type } = await publicRoot("typebox");
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
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
    provider: "pct-batch-fixture",
    api: "pct-batch-fixture",
    baseUrl: "https://invalid.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 4096,
  };
  const PROBE_TOOL = "pct_batch_probe";
  /** @type {ExtensionError[]} */
  const errors = [];
  /** @type {Array<AbortSignal | undefined>} */
  const signals = [];
  let providerCalls = 0;
  let active = 0;
  let maxActive = 0;
  let endedByRunAbort = 0;
  /** @type {() => void} */
  let bothStarted;
  /** @type {Promise<void>} */
  const started = new Promise((resolve) => {
    bothStarted = resolve;
  });
  /** @param {ExtensionAPI} pi */
  function probeExtension(pi) {
    pi.registerProvider(model.provider, {
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey: "offline-fixture-not-a-secret",
      models: [model],
      streamSimple: () => {
        providerCalls++;
        if (providerCalls > 4) throw new Error("fixture turn budget exceeded");
        // One assistant message with two calls to one non-sequential tool.
        /** @type {AssistantMessage["content"]} */
        const content =
          providerCalls === 1
            ? [0, 1].map((index) => ({
                type: "toolCall",
                id: `fixture-batch-${index}`,
                name: PROBE_TOOL,
                arguments: { index },
              }))
            : [{ type: "text", text: "fixture done" }];
        /** @type {AssistantMessage & { stopReason: "stop" | "toolUse" }} */
        const message = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content,
          stopReason: providerCalls === 1 ? "toolUse" : "stop",
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
    pi.registerTool({
      name: PROBE_TOOL,
      label: "Batch signal probe",
      description: "Fixture tool that records the AbortSignal Pi passes it.",
      parameters: Type.Object(
        { index: Type.Integer() },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params, signal) {
        signals.push(signal);
        active++;
        maxActive = Math.max(maxActive, active);
        if (signals.length === 2) bothStarted();
        // A concurrent sibling starts before this continuation runs.
        await Promise.resolve();
        // Both calls in flight: each ends only when the run is aborted.
        if (maxActive === 2 && signal instanceof AbortSignal) {
          await /** @type {Promise<void | Event>} */ (
            new Promise((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", resolve, { once: true });
            })
          );
          endedByRunAbort++;
        }
        active--;
        return {
          content: [{ type: "text", text: `probe ${params.index} ended` }],
          details: { index: params.index },
        };
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
        extensionFactories: [probeExtension],
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
      tools: [PROBE_TOOL],
    });
    if (result.extensionsResult.errors.length)
      throw new Error("fixture extension failed to load");
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
  const turn = runtime.session.prompt("Run the offline fixture batch.");
  const first = await Promise.race([
    started.then(() => "started"),
    turn.then(() => "turn-ended"),
  ]);
  if (first === "started") await runtime.session.abort();
  await turn;
  const report = {
    calls: signals.length,
    abortSignals: signals.every((signal) => signal instanceof AbortSignal),
    sameSignal: signals.length === 2 && signals[0] === signals[1],
    overlapping: maxActive === 2,
    endedByRunAbort,
    providerCalls,
    extensionErrors: errors.length,
    networkAttempts,
  };
  await runtime.dispose();
  runtime = undefined;
  const pass =
    report.calls === 2 &&
    report.abortSignals &&
    report.sameSignal &&
    report.overlapping &&
    report.endedByRunAbort === 2 &&
    report.extensionErrors === 0 &&
    report.networkAttempts === 0;
  console.log(
    JSON.stringify(
      {
        verdict: pass ? "pass" : "fail",
        ...report,
        hostVersion: hostManifest.version,
        node: process.version,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("HOST_FIXTURE_FAILURE", error);
  process.exitCode = 1;
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
