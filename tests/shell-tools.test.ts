import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../src/config.ts";
import {
  EXEC_COMMAND_TOOL,
  syncOwnedTool,
  WRITE_STDIN_TOOL,
} from "../src/index.ts";
import {
  createShellTools,
  EXEC_COMMAND_SCHEMA,
  WRITE_STDIN_SCHEMA,
  formatShellResult,
  SHELL_TOOLS,
} from "../src/shell/tools.ts";
import {
  SHELL_MAX_BYTES_DEFAULT,
  ShellSessionManager,
  type ShellExecutor,
  type ShellSessionResult,
} from "../src/shell/manager.ts";
import { projectStatus, selectShellSessionsStatus } from "../src/status.ts";
import { model } from "./fixtures.ts";
import { isWellFormed } from "./fixtures/well-formed.ts";
import { TERMINAL_SETTLE_GRACE_MS } from "./fixtures/budgets.ts";

// ASCII, CJK and emoji in one 9-byte repetition: 1024 is not a multiple of
// it, so a correct byte budget must clip on a code-point boundary.
const MIXED_UNIT = "aa\u59cb\u{1F642}";

const managers: ShellSessionManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
});

function toolsWithManager(
  options: ConstructorParameters<typeof ShellSessionManager>[0] = {},
): { manager: ShellSessionManager; tools: Map<string, ToolDefinition> } {
  const manager = new ShellSessionManager(options);
  managers.push(manager);
  const definitions = createShellTools(manager, {
    isStartEnabled: () => true,
    isContinueEnabled: () => true,
  });
  return {
    manager,
    tools: new Map(definitions.map((tool) => [tool.name, tool])),
  };
}

function tools(
  options: ConstructorParameters<typeof ShellSessionManager>[0] = {},
): Map<string, ToolDefinition> {
  return toolsWithManager(options).tools;
}

function context(cwd = process.cwd()): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

/** Description plus parameter schema; semantic clauses may live in either. */
function definitionText(tool: ToolDefinition): string {
  return `${tool.description ?? ""}\n${JSON.stringify(tool.parameters)}`;
}

function registry() {
  return {
    find: () => undefined,
    getAvailable: () => [],
    isUsingOAuth: () => false,
  };
}

describe("shell tool definitions", () => {
  it("exposes exactly the two ordinary shell tools", () => {
    expect(SHELL_TOOLS).toEqual([EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL]);
  });

  it("declares the probe-finalized exec_command schema", () => {
    const exec = tools().get(EXEC_COMMAND_TOOL);
    if (!exec) throw new Error("exec_command was not defined");
    expect(exec.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        cmd: { type: "string", minLength: 1 },
        command: { type: "string", minLength: 1 },
        workdir: { type: "string", minLength: 1 },
        cwd: { type: "string", minLength: 1 },
        yield_time_ms: { type: "integer", minimum: 0, maximum: 60000 },
        yieldTimeMs: { type: "integer", minimum: 0, maximum: 60000 },
        max_output_tokens: { type: "integer", minimum: 256, maximum: 65536 },
        maxOutputBytes: {
          type: "integer",
          minimum: 1024,
          maximum: 262144,
        },
      },
    });
    // Each pair is one field, so neither spelling can be schema-required; the
    // shared dialect normalizer enforces exactly one of them per call.
    expect(
      (exec.parameters as { required?: string[] }).required,
    ).toBeUndefined();
    const text = definitionText(exec);
    expect(text).toContain("launched exactly once");
    expect(text).toContain("never relaunched or replayed");
    expect(text).toContain("pipes, not a TTY");
    expect(text).toContain("Only new output is returned");
    expect(text).toContain("session_id to continue with write_stdin");
    expect(text).toContain("bounds the call, not the command's runtime");
    expect(text).toContain("clipped at a UTF-8 code-point boundary");
    expect(text).toContain("Same field as cmd");
    expect(text).toContain("Same field as workdir");
    expect(text).toContain("not provider tokenization");
    expect(text).toContain("rejected rather than ignored");
    expect(text).toContain(
      "tools.exec_command({cmd|command, workdir|cwd, yield_time_ms, max_output_tokens}) takes the same fields and spellings",
    );
  });

  it("declares the probe-finalized write_stdin schema and stdin semantics", () => {
    const write = tools().get(WRITE_STDIN_TOOL);
    if (!write) throw new Error("write_stdin was not defined");
    expect(write.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: { type: "string", minLength: 1 },
        sessionId: { type: "string", minLength: 1 },
        chars: { type: "string" },
        input: { type: "string" },
        closeStdin: { type: "boolean" },
        terminate: { type: "boolean" },
        yield_time_ms: { type: "integer", minimum: 0, maximum: 60000 },
        yieldTimeMs: { type: "integer", minimum: 0, maximum: 60000 },
        max_output_tokens: { type: "integer", minimum: 256, maximum: 65536 },
        maxOutputBytes: {
          type: "integer",
          minimum: 1024,
          maximum: 262144,
        },
      },
    });
    expect(
      (write.parameters as { required?: string[] }).required,
    ).toBeUndefined();
    const text = definitionText(write);
    expect(text).toContain("Same field as session_id");
    expect(text).toContain("Same field as chars");
    expect(text).toContain("never a number or OS PID");
    expect(text).toContain("forwarded verbatim");
    expect(text).toContain("No newline is appended");
    expect(text).toContain("stdin is not closed implicitly");
    expect(text).toContain(
      "real newline character (U+000A, an actual line-break byte)",
    );
    expect(text).toContain("never the two characters backslash and n");
    expect(text).toContain("JSON escaping");
    expect(text).toContain("never restarts or replays");
    expect(text).toContain("expire once their final result has been read");
    expect(text).toContain(
      "bounded termination of the process and its process group",
    );
    expect(text).toContain(
      "tools.write_stdin({session_id|sessionId, chars|input, ...}) takes the same fields and spellings",
    );
  });

  it("runs a command through the tool and continues it with write_stdin", async () => {
    const definitions = tools();
    const exec = definitions.get(EXEC_COMMAND_TOOL);
    const write = definitions.get(WRITE_STDIN_TOOL);
    if (!exec || !write) throw new Error("shell tools were not defined");
    const ctx = context();

    const first = await exec.execute(
      "call-1",
      {
        command: "printf 'ready\\n'; read line; printf 'got:%s\\n' \"$line\"",
        yieldTimeMs: 2000,
      },
      undefined,
      undefined,
      ctx,
    );
    const firstDetails = first.details as ShellSessionResult;
    expect(firstDetails.status).toBe("running");
    expect(firstDetails.stdout).toBe("ready\n");
    expect(first.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("[stdout]\nready\n"),
    });
    expect(first.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(firstDetails.sessionId),
    });

    const second = await write.execute(
      "call-2",
      {
        sessionId: firstDetails.sessionId,
        input: "hello\n",
        yieldTimeMs: 2000,
      },
      undefined,
      undefined,
      ctx,
    );
    let details = second.details as ShellSessionResult;
    let stdout = details.stdout;
    while (details.status === "running") {
      const next = await write.execute(
        "call-3",
        { sessionId: firstDetails.sessionId, yieldTimeMs: 2000 },
        undefined,
        undefined,
        ctx,
      );
      details = next.details as ShellSessionResult;
      stdout += details.stdout;
    }
    expect(stdout).toBe("got:hello\n");
    expect(details.status).toBe("completed");
  });

  it("runs the Codex spellings through the same direct path", async () => {
    const definitions = tools({ settleGraceMs: TERMINAL_SETTLE_GRACE_MS });
    const exec = definitions.get(EXEC_COMMAND_TOOL);
    if (!exec) throw new Error("exec_command was not defined");

    const result = await exec.execute(
      "call-1",
      {
        cmd: "pwd",
        workdir: "src",
        yield_time_ms: 2000,
        max_output_tokens: 256,
      },
      undefined,
      undefined,
      context(),
    );
    const details = result.details as ShellSessionResult;
    expect(details.status).toBe("completed");
    expect(details.stdout.trim()).toBe(join(process.cwd(), "src"));
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(`session_id ${details.sessionId}`),
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("exit_code: 0"),
    });
  });

  it("rejects conflicting spellings, unsupported fields and numeric handles before spawning", async () => {
    const { manager, tools: definitions } = toolsWithManager();
    const exec = definitions.get(EXEC_COMMAND_TOOL);
    const write = definitions.get(WRITE_STDIN_TOOL);
    if (!exec || !write) throw new Error("shell tools were not defined");
    const ctx = context();

    await expect(
      exec.execute(
        "call-1",
        { cmd: "printf must-not-run", command: "printf other" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "invalid-arguments",
      message: expect.stringContaining("conflicting values"),
    });
    await expect(
      exec.execute(
        "call-2",
        { cmd: "printf must-not-run", tty: true },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('does not support "tty"'),
    });
    await expect(
      exec.execute(
        "call-3",
        { cmd: "printf must-not-run", timeout_ms: 10 },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('does not support "timeout_ms"'),
    });
    await expect(
      write.execute("call-4", { session_id: 17 }, undefined, undefined, ctx),
    ).rejects.toMatchObject({
      message: expect.stringContaining("not a number or an OS PID"),
    });
    // A cell handle is never resolved as a shell session either.
    await expect(
      write.execute(
        "call-5",
        { session_id: "pct-cell-1" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "stale-session" });
    expect(manager.sessionCount).toBe(0);
  });

  it("clips a token budget at a code-point boundary without failing the command", async () => {
    const definitions = tools({ settleGraceMs: TERMINAL_SETTLE_GRACE_MS });
    const exec = definitions.get(EXEC_COMMAND_TOOL);
    const write = definitions.get(WRITE_STDIN_TOOL);
    if (!exec || !write) throw new Error("shell tools were not defined");
    const ctx = context();

    // 9 bytes per repetition (ASCII, CJK, emoji) does not divide the 1024-byte
    // ceiling, so a correct clip must back off to a code-point boundary.
    const first = await exec.execute(
      "call-1",
      {
        cmd: `i=0; while [ $i -lt 400 ]; do printf '${MIXED_UNIT}'; i=$((i+1)); done`,
        max_output_tokens: 256,
        yield_time_ms: 2000,
      },
      undefined,
      undefined,
      ctx,
    );
    let details = first.details as ShellSessionResult;
    expect(details.truncated).toBe(true);
    expect(Buffer.byteLength(details.stdout)).toBeLessThanOrEqual(1024);
    expect(isWellFormed(details.stdout)).toBe(true);
    expect(details.stdout).not.toContain("\uFFFD");
    expect(details.stdout.startsWith(MIXED_UNIT)).toBe(true);
    // Clipping is a preview budget, not a failed effect: the command still
    // completes with its own exit status and the rest stays readable.
    while (details.status === "running") {
      const next = await write.execute(
        "call-2",
        {
          session_id: details.sessionId,
          yield_time_ms: 2000,
          max_output_tokens: 256,
        },
        undefined,
        undefined,
        ctx,
      );
      details = next.details as ShellSessionResult;
      expect(isWellFormed(details.stdout)).toBe(true);
    }
    expect(details.status).toBe("completed");
    expect(details.exitCode).toBe(0);
  });

  it("resolves a relative cwd against the session working directory", async () => {
    const definitions = tools({ settleGraceMs: TERMINAL_SETTLE_GRACE_MS });
    const exec = definitions.get(EXEC_COMMAND_TOOL);
    if (!exec) throw new Error("exec_command was not defined");

    const result = await exec.execute(
      "call-1",
      { command: "pwd", cwd: "src", yieldTimeMs: 2000 },
      undefined,
      undefined,
      context(),
    );
    const details = result.details as ShellSessionResult;
    expect(details.status).toBe("completed");
    if (details.status !== "running") {
      expect(details.stdout.trim()).toBe(process.cwd() + "/src");
    }
  });

  it("refuses to run when the feature is disabled", async () => {
    const manager = new ShellSessionManager();
    managers.push(manager);
    const [exec] = createShellTools(manager, {
      isStartEnabled: () => false,
      isContinueEnabled: () => false,
    });
    await expect(
      exec.execute(
        "call-1",
        { command: "true", yieldTimeMs: 0 },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("Shell Sessions are not enabled.");
    expect(manager.sessionCount).toBe(0);
  });

  it("renders running, terminal, and truncation states", () => {
    const base: ShellSessionResult = {
      sessionId: "pct-shell-1",
      status: "running",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      dropped: false,
    };
    expect(formatShellResult(base)).toBe(
      [
        "session_id pct-shell-1: running",
        "job still running; continue with write_stdin, not wait",
        "(no new output)",
      ].join("\n"),
    );
    expect(
      formatShellResult({
        ...base,
        stdout: "out\n",
      }),
    ).toBe(
      [
        "session_id pct-shell-1: running",
        "job still running; continue with write_stdin, not wait",
        "[stdout]",
        "out\n",
      ].join("\n"),
    );
    expect(
      formatShellResult({
        ...base,
        status: "completed",
        exitCode: 7,
        stdout: "out\n",
        stderr: "err\n",
      }),
    ).toBe(
      "session_id pct-shell-1: completed\nexit_code: 7\n[stdout]\nout\n\n[stderr]\nerr\n",
    );
    expect(
      formatShellResult({ ...base, truncated: true, stdout: "x" }),
    ).toContain("clipped to the per-read byte budget");
    expect(
      formatShellResult({ ...base, truncated: true, dropped: true }),
    ).toContain("buffered bytes were dropped");
    expect(
      formatShellResult({
        ...base,
        status: "terminated",
        unknownOutcome: true,
      }),
    ).toBe(
      [
        "session_id pct-shell-1: terminated",
        "exit_code: unknown",
        "termination dispatched; exit not confirmed for the whole managed job; continue with write_stdin (not cell wait)",
        "(no output)",
      ].join("\n"),
    );
  });

  it("exports the exact direct schemas for nested validation reuse", () => {
    const definitions = tools();
    expect(definitions.get(EXEC_COMMAND_TOOL)?.parameters).toEqual(
      EXEC_COMMAND_SCHEMA,
    );
    expect(definitions.get(WRITE_STDIN_TOOL)?.parameters).toEqual(
      WRITE_STDIN_SCHEMA,
    );
    const text = definitionText(definitions.get(WRITE_STDIN_TOOL)!);
    expect(text).toContain("262144 UTF-8 bytes and 16 calls");
    expect(text).toContain("Do not combine with nonempty input");
    expect(text).toContain("Use recovery files after handle release");
  });

  it("keeps recovery, pending input and uncertain control before bounded literal output", () => {
    const result: ShellSessionResult = {
      sessionId: "pct-shell-routing",
      status: "terminated",
      exitCode: null,
      signal: null,
      stdout: "literal-line\n".repeat(100),
      stderr: "diagnostic\n",
      truncated: true,
      dropped: true,
      unknownOutcome: true,
      inputDelivery: "unknown",
      stdin: { state: "broken", pendingBytes: 10, pendingCalls: 1 },
      recovery: {
        stdout: {
          state: "partial",
          path: "/private/output/one.txt",
          bytes: 1300,
          capturedBytes: 20,
          reason: "io-error",
        },
        stderr: {
          state: "unavailable",
          bytes: 11,
          capturedBytes: 0,
          reason: "missing",
        },
      },
    };
    const text = formatShellResult(result);
    expect(text.indexOf("/private/output/one.txt")).toBeLessThan(
      text.indexOf("[stdout]"),
    );
    expect(text.indexOf("continue with write_stdin")).toBeLessThan(
      text.indexOf("[stdout]"),
    );
    expect(text).toContain("stdout recovery: partial (io-error)");
    expect(text).toContain("stderr recovery: unavailable (missing)");
    expect(text).toContain("earlier pending delivery may be partial");
    expect(text).toContain("literal-line\nliteral-line");
    expect(text).not.toContain("literal-line\\nliteral-line");
    expect(text).toContain("Never rerun for recovery");
    expect(text).toContain("may contain secrets");
  });

  it("uses the default byte budget when none is provided", () => {
    expect(SHELL_MAX_BYTES_DEFAULT).toBe(51_200);
  });
});

describe("shell executor adapter contract", () => {
  it("drives both tools through a fake executor and renders its result", async () => {
    const result: ShellSessionResult = {
      sessionId: "pct-shell-fake",
      status: "completed",
      exitCode: 0,
      signal: null,
      stdout: "hello\n",
      stderr: "",
      truncated: false,
      dropped: false,
    };
    const start = vi.fn(async () => result);
    const write = vi.fn(async () => result);
    const close = vi.fn(async () => undefined);
    const executor: ShellExecutor = { start, write, close };
    const definitions = createShellTools(executor, {
      isStartEnabled: () => true,
      isContinueEnabled: () => true,
    });
    const exec = definitions.find((tool) => tool.name === EXEC_COMMAND_TOOL);
    const writeTool = definitions.find(
      (tool) => tool.name === WRITE_STDIN_TOOL,
    );
    if (!exec || !writeTool) throw new Error("shell tools were not defined");

    const execResult = await exec.execute(
      "call-1",
      {
        command: "echo hello",
        cwd: "sub",
        yieldTimeMs: 123,
        maxOutputBytes: 4096,
      },
      undefined,
      undefined,
      context(),
    );
    expect(start).toHaveBeenCalledWith(
      {
        command: "echo hello",
        cwd: join(process.cwd(), "sub"),
        yieldTimeMs: 123,
        maxOutputBytes: 4096,
      },
      undefined,
    );
    expect(execResult).toEqual({
      content: [{ type: "text", text: formatShellResult(result) }],
      details: result,
    });

    const writeResult = await writeTool.execute(
      "call-2",
      {
        sessionId: "pct-shell-fake",
        input: "x\n",
        closeStdin: true,
        terminate: true,
        yieldTimeMs: 5,
        maxOutputBytes: 2048,
      },
      undefined,
      undefined,
      context(),
    );
    expect(write).toHaveBeenCalledWith(
      {
        sessionId: "pct-shell-fake",
        input: "x\n",
        closeStdin: true,
        terminate: true,
        yieldTimeMs: 5,
        maxOutputBytes: 2048,
      },
      undefined,
    );
    expect(writeResult).toEqual({
      content: [{ type: "text", text: formatShellResult(result) }],
      details: result,
    });
    expect(close).not.toHaveBeenCalled();
  });
});

describe("shell owned-tool synchronization", () => {
  const sourcePath = "/extension/src/index.ts";

  function piWithShellTools(conflictingName?: string) {
    let active = ["read", "third_party"];
    const setActiveTools = vi.fn((names: string[]) => {
      active = names;
    });
    const pi = {
      getActiveTools: () => active,
      setActiveTools,
      getAllTools: () =>
        SHELL_TOOLS.map((name) => ({
          name,
          sourceInfo: {
            path: name === conflictingName ? "/other/shell.ts" : sourcePath,
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        })),
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    return {
      pi,
      setActiveTools,
      active: () => active,
    };
  }

  it("activates both owned shell names when enabled and unconflicted", () => {
    const config = defaultConfig();
    config.shellSessions.enabled = true;
    const harness = piWithShellTools();
    const state = syncOwnedTool(
      harness.pi,
      config,
      { model: model(), modelRegistry: registry() } as unknown as Pick<
        ExtensionContext,
        "model" | "modelRegistry"
      >,
      sourcePath,
    );
    expect(state.shellConflict).toBe(false);
    expect(harness.active()).toEqual(["read", "third_party", ...SHELL_TOOLS]);
  });

  it("deactivates both owned names when either is conflicted", () => {
    const config = defaultConfig();
    config.shellSessions.enabled = true;
    // Seed an active list that already contains both Toolkit names.
    const conflictingName = WRITE_STDIN_TOOL;
    let active = ["read", EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL];
    const setActiveTools = vi.fn((names: string[]) => {
      active = names;
    });
    const pi = {
      getActiveTools: () => active,
      setActiveTools,
      getAllTools: () =>
        SHELL_TOOLS.map((name) => ({
          name,
          sourceInfo: {
            path: name === conflictingName ? "/other/shell.ts" : sourcePath,
            source: "test",
            scope: "user" as const,
            origin: "package" as const,
          },
        })),
    } as unknown as Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools"
    >;
    const state = syncOwnedTool(
      pi,
      config,
      { model: model(), modelRegistry: registry() } as unknown as Pick<
        ExtensionContext,
        "model" | "modelRegistry"
      >,
      sourcePath,
    );
    expect(state.shellConflict).toBe(true);
    // The winning third-party name is preserved; the sibling Toolkit name is removed.
    expect(active).toEqual(["read", WRITE_STDIN_TOOL]);
  });

  it("removes both owned names when disabled", () => {
    const harness = piWithShellTools();
    const active = harness.active();
    active.push(...SHELL_TOOLS);
    syncOwnedTool(
      harness.pi,
      defaultConfig(),
      { model: model(), modelRegistry: registry() } as unknown as Pick<
        ExtensionContext,
        "model" | "modelRegistry"
      >,
      sourcePath,
    );
    expect(harness.active()).toEqual(["read", "third_party"]);
  });
});

describe("shell status projection", () => {
  it("reports configured, effective, and reason states", () => {
    const disabled = defaultConfig().shellSessions;
    expect(selectShellSessionsStatus(disabled, true, false)).toEqual({
      effective: "off",
      reason: "",
    });

    const enabled = { enabled: true };
    expect(selectShellSessionsStatus(enabled, true, false)).toEqual({
      effective: "active",
      reason: "",
    });
    expect(selectShellSessionsStatus(enabled, true, true)).toEqual({
      effective: "unavailable",
      reason: "conflicting-tool-name",
    });
    expect(selectShellSessionsStatus(enabled, false, false)).toEqual({
      effective: "unavailable",
      reason: "shell-unavailable",
    });
  });

  it("projects configured and effective Shell Sessions status", () => {
    const config = defaultConfig();
    config.shellSessions.enabled = true;
    const status = projectStatus({
      config,
      configPath: "/config.json",
      currentModel: model(),
      decision: { effective: "off" },
      imageGenerationDecision: { effective: "off" },
      computerUseDecision: { effective: "off" },
      remoteCompactionAvailability: { ok: true },
      toolConflict: false,
      imageToolConflict: false,
      applyPatchToolConflict: false,
      computerUseToolConflict: false,
      shellConflict: true,
    });
    expect(status.shellSessions).toEqual({
      configured: "on",
      effective: "unavailable",
      reason: "conflicting-tool-name",
    });
  });
});
