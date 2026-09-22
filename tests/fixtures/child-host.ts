import { spawn, type ChildProcess } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExecutionRule } from "../../src/execution-mode.ts";

/**
 * Real-process child-compatibility harness. It stages the exact packed Toolkit
 * in a temporary agent directory beside a deterministic offline provider, then
 * runs real Pi processes without patching the host. Callers own any additional
 * launcher-specific setup, and no lane may reach the network.
 *
 * `tests/fixtures/child/offline-provider.ts` owns the writing side of the two
 * shapes below; keep them in step.
 */
export interface ScriptedTurn {
  tool?: { name: string; arguments: Record<string, unknown> };
  text?: string;
  /**
   * Continue the shell the previous result yielded. A first `exec_command`
   * observation may end before the job settles — the tool then answers
   * `session_id <id>: running` and tells the model to continue with
   * `write_stdin` — so this entry repeats while that holds and is skipped once
   * the job is terminal. It keeps a lane's evidence independent of how fast a
   * loaded machine drains the pipes.
   */
  pollShell?: boolean;
}

export interface TurnReceipt {
  kind: "turn";
  turn: number;
  model: string;
  tools: string[];
  /**
   * What Pi's rendered system prompt says. Only `bash` discriminates: the
   * prompt names no Toolkit entry in any configuration, so the other three are
   * a record of that fact, not evidence that a route is inactive. `guidance`
   * carries that evidence.
   */
  prompt: {
    bash: boolean;
    exec: boolean;
    execCommand: boolean;
    applyPatch: boolean;
  };
  /**
   * Toolkit execution identifiers the offered tool *descriptions* name, sorted.
   * Empty for a native-only child; an active Code route lists the nested
   * spellings from inside `exec`, and direct routes list their own names.
   */
  guidance: string[];
  result?: { toolName: string; isError: boolean; text: string };
}

export interface DiagnosticsReceipt {
  kind: "diagnostics";
  record: {
    version: number;
    model?: { provider: string; id: string };
    source: string;
    ruleId?: string;
    requested: { patch: boolean; shell: boolean; code: boolean };
    effective: {
      directPatch: boolean;
      nestedPatch: boolean;
      directShell: boolean;
      code: boolean;
    };
    admittedNames: string[];
    visibleNames: string[];
    nestedNames: string[];
    hiddenNatives: string[];
    notes: string[];
    approvalTransport: string;
    cleanupPending: boolean;
    configRevision: string;
    toolkit: { name: string; version: string };
  };
}

export type ChildReceipt = TurnReceipt | DiagnosticsReceipt;

export function turns(receipts: ChildReceipt[]): TurnReceipt[] {
  return receipts.filter(
    (entry): entry is TurnReceipt => entry.kind === "turn",
  );
}

export function diagnostics(
  receipts: ChildReceipt[],
): DiagnosticsReceipt["record"][] {
  return receipts
    .filter(
      (entry): entry is DiagnosticsReceipt => entry.kind === "diagnostics",
    )
    .map((entry) => entry.record);
}

export interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const repository = resolve(fileURLToPath(import.meta.url), "../../..");
/** Peers a staged package resolves from the agent directory, as an install does. */
const PEER_NAMES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "typebox",
] as const;

export interface ChildWorkspace {
  root: string;
  agentDir: string;
  /** Empty project cwd, ready for files a lane explicitly stages. */
  project: string;
  /** The real Pi CLI the launcher and the direct lanes both run. */
  cliPath: string;
  hostVersion: string;
  /** Identity of the packed Toolkit under test. */
  tarball: { filename: string; shasum: string };
  /** The shared rules file every process in this workspace reads. */
  configPath: string;
  writeRules(
    rules: ExecutionRule[],
    extra?: Record<string, unknown>,
  ): Promise<void>;
  writeProjectFile(relativePath: string, contents: string): Promise<void>;
  /** Per-lane receipt and turn script; the lane names them in the child env. */
  lane(
    name: string,
    turns: ScriptedTurn[],
  ): Promise<{
    receiptPath: string;
    scriptPath: string;
    env: Record<string, string>;
    read(): Promise<ChildReceipt[]>;
  }>;
  cleanup(): Promise<void>;
}

async function exec(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return { code, stdout, stderr };
}

/** Resolve an installed peer by walking up from the selected host. */
async function peerRoot(hostRoot: string, name: string): Promise<string> {
  if (name === "@earendil-works/pi-coding-agent") return hostRoot;
  let directory = hostRoot;
  for (;;) {
    try {
      return await realpath(join(directory, "node_modules", name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`missing installed peer ${name}`);
    directory = parent;
  }
}

/**
 * Stage the workspace. `npm pack` produces the exact package a user installs,
 * so the children load the packed sources rather than the working tree.
 */
export async function stageChildWorkspace(
  prefix: string,
): Promise<ChildWorkspace> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await stageWorkspaceAt(root);
  } catch (error) {
    // A staging failure (for example `npm pack`) must not leave the temp root
    // behind: `afterAll` only cleans a workspace that was returned.
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function stageWorkspaceAt(root: string): Promise<ChildWorkspace> {
  const agentDir = join(root, "agent");
  const extensions = join(agentDir, "extensions");
  const project = join(root, "project");
  const hostRoot = await realpath(
    join(repository, "node_modules/@earendil-works/pi-coding-agent"),
  );
  const hostVersion = (
    JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  await mkdir(extensions, { recursive: true });
  await mkdir(project, { recursive: true });

  const packDir = join(root, "pack");
  await mkdir(packDir, { recursive: true });
  const packed = await exec(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--cache",
      join(root, "npm-cache"),
      "--pack-destination",
      packDir,
    ],
    { cwd: repository },
  );
  if (packed.code !== 0) {
    throw new Error(`npm pack failed (${packed.code}): ${packed.stderr}`);
  }
  const [manifest] = JSON.parse(packed.stdout) as Array<{
    filename: string;
    shasum: string;
  }>;
  if (!manifest) throw new Error("npm pack reported no tarball");
  const extracted = await exec(
    "tar",
    ["-xzf", join(packDir, manifest.filename), "-C", packDir],
    { cwd: packDir },
  );
  if (extracted.code !== 0) {
    throw new Error(`tar failed (${extracted.code}): ${extracted.stderr}`);
  }
  await cp(join(packDir, "package"), join(extensions, "pi-codex-toolkit"), {
    recursive: true,
  });
  // One peer tree beside the staged package, exactly like an agent-dir
  // install. Pi's extension discovery skips `node_modules`, so it stays out
  // of the loaded set while every bare import still resolves to the host.
  for (const name of PEER_NAMES) {
    const destination = join(extensions, "node_modules", name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(await peerRoot(hostRoot, name), destination, "dir");
  }
  for (const name of ["offline-provider", "diagnostics-receipt"] as const) {
    await cp(
      join(repository, "tests", "fixtures", "child", `${name}.ts`),
      join(extensions, `${name}.ts`),
    );
  }

  const configPath = join(extensions, "pi-codex-toolkit.json");
  return {
    root,
    agentDir,
    project,
    cliPath: join(hostRoot, "dist", "cli.js"),
    hostVersion,
    tarball: { filename: manifest.filename, shasum: manifest.shasum },
    configPath,
    writeRules: (rules, extra) =>
      writeFile(
        configPath,
        JSON.stringify({ ...extra, execution: { version: 1, rules } }, null, 2),
        "utf8",
      ),
    writeProjectFile: (relativePath, contents) =>
      writeFile(join(project, relativePath), contents, "utf8"),
    lane: async (name, turns) => {
      const receiptPath = join(root, `${name}.receipt.jsonl`);
      const scriptPath = join(root, `${name}.script.json`);
      await writeFile(receiptPath, "", "utf8");
      await writeFile(scriptPath, JSON.stringify(turns), "utf8");
      return {
        receiptPath,
        scriptPath,
        env: {
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PCT_RECEIPT_FILE: receiptPath,
          PCT_SCRIPT_FILE: scriptPath,
        },
        read: async () =>
          (await readFile(receiptPath, "utf8"))
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as ChildReceipt),
      };
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Kill a child that outlived its lane, then wait for the real exit. */
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit) => child.once("close", resolveExit));
}

export interface DirectChildOptions {
  workspace: ChildWorkspace;
  env: Record<string, string>;
  model: string;
  prompt: string;
  /** Extra CLI arguments; the role allowlist is never added implicitly. */
  args?: string[];
  budgetMs: number;
}

/** One real `--mode json -p` Pi process. No launcher, no UI. */
export async function runJsonChild(
  options: DirectChildOptions,
): Promise<ChildRun> {
  const child = spawn(
    process.execPath,
    [
      options.workspace.cliPath,
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--offline",
      "--model",
      options.model,
      ...(options.args ?? []),
    ],
    {
      cwd: options.workspace.project,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(options.prompt);
  // Watchdog: a child that outlives its budget is killed here, and the awaited
  // exit below reports the real outcome. A failing kill leaves that await to
  // the test's own budget rather than replacing its diagnostic.
  const timer = setTimeout(() => {
    terminate(child).catch(() => undefined);
  }, options.budgetMs);
  try {
    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    return { ...exit, stdout, stderr };
  } finally {
    clearTimeout(timer);
    await terminate(child);
  }
}

export type ConfirmAnswer = "approve" | "deny" | "cancel";

export interface RpcSession {
  /** Send one prompt and wait for the turn it starts to end. */
  prompt(message: string): Promise<void>;
  /** How the next confirmation dialogs are answered. */
  answerConfirm(answer: ConfirmAnswer): void;
  confirmations: Array<{ title: string }>;
  close(): Promise<ChildRun>;
}

/**
 * One real `--mode rpc` Pi process. This is the only lane with a
 * dialog-capable UI, so it is where nested Apply Patch confirmation exists.
 */
export async function startRpcSession(options: {
  workspace: ChildWorkspace;
  env: Record<string, string>;
  model: string;
  budgetMs: number;
  args?: string[];
}): Promise<RpcSession> {
  const child = spawn(
    process.execPath,
    [
      options.workspace.cliPath,
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--model",
      options.model,
      ...(options.args ?? []),
    ],
    {
      cwd: options.workspace.project,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let buffer = "";
  let serial = 0;
  let answer: ConfirmAnswer = "approve";
  const confirmations: Array<{ title: string }> = [];
  const pending = new Map<string, (value: unknown) => void>();
  // `prompt` answers as soon as the turn is accepted, so a lane that needs the
  // turn's effects waits for the session's own `agent_end` event instead.
  const turnEnded = new Set<() => void>();
  const send = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    buffer += chunk.toString();
    for (
      let index = buffer.indexOf("\n");
      index >= 0;
      index = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let event: {
        type?: string;
        id?: string;
        method?: string;
        title?: string;
        willRetry?: boolean;
      };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (event.type === "response" && event.id !== undefined) {
        pending.get(event.id)?.(event);
        pending.delete(event.id);
      }
      if (event.type === "agent_end" && event.willRetry !== true) {
        for (const waiter of [...turnEnded]) waiter();
      }
      if (event.type === "extension_ui_request" && event.method === "confirm") {
        confirmations.push({ title: event.title ?? "" });
        send({
          type: "extension_ui_response",
          id: event.id,
          ...(answer === "cancel"
            ? { cancelled: true }
            : { confirmed: answer === "approve" }),
        });
      }
    }
  });
  const request = async (
    type: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const id = `pct-${++serial}`;
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<unknown>((resolveResponse, reject) => {
        pending.set(id, resolveResponse);
        timer = setTimeout(
          () => reject(new Error(`RPC ${type} exceeded its budget: ${stderr}`)),
          options.budgetMs,
        );
        send({ id, type, ...extra });
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  /** Send one prompt and wait for the agent turn it starts to end. */
  const prompt = async (message: string): Promise<void> => {
    let waiter!: () => void;
    let timer: NodeJS.Timeout | undefined;
    const ended = new Promise<void>((resolveTurn, reject) => {
      waiter = resolveTurn;
      timer = setTimeout(
        () => reject(new Error(`RPC turn exceeded its budget: ${stderr}`)),
        options.budgetMs,
      );
    });
    // Register before sending: the turn can end before the response arrives.
    turnEnded.add(waiter);
    try {
      await request("prompt", { message });
      await ended;
    } finally {
      clearTimeout(timer);
      turnEnded.delete(waiter);
    }
  };
  try {
    await request("get_state");
  } catch (error) {
    await terminate(child);
    throw error;
  }
  return {
    confirmations,
    answerConfirm: (next) => {
      answer = next;
    },
    prompt,
    close: async () => {
      child.stdin.end();
      const exit = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveExit) => {
        const timer = setTimeout(() => {
          terminate(child).catch(() => undefined);
        }, options.budgetMs);
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolveExit({ code, signal });
        });
      });
      return { ...exit, stdout, stderr };
    },
  };
}
