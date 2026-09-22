import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  APPLY_PATCH_TOOL,
  APPLY_PATCH_TOOL_DEFINITION,
} from "../src/apply-patch.ts";
import {
  CodeModeAdapters,
  type MutationApprovalRequest,
} from "../src/code-mode/adapters.ts";
import type { CodeModeCellContext } from "../src/code-mode/manager.ts";
import {
  ShellSessionManager,
  type ShellExecutor,
  type ShellSessionResult,
} from "../src/shell/manager.ts";
import { INNER_BUDGET_MS } from "./fixtures/budgets.ts";
import { isWellFormed } from "./fixtures/well-formed.ts";

const TWO_BYTE = "é"; // one UTF-16 unit, two UTF-8 bytes
const ASTRAL = "\u{1F600}"; // one surrogate pair, four UTF-8 bytes
const PREVIEW_MARKER = "\n... (argument preview truncated)";
const PREVIEW_HEADER =
  "Code Mode cell pct-cell-preview will run apply_patch.\n\n";

const shellManagers: ShellSessionManager[] = [];

afterEach(async () => {
  await Promise.all(shellManagers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

function context(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    ...overrides,
  } as unknown as ExtensionContext;
}

function cell(
  hostContext: unknown = context(),
  cellId = "pct-cell-test",
): CodeModeCellContext {
  return { cellId, hostContext };
}

class FakeShell {
  readonly starts: Array<{
    input: Parameters<ShellExecutor["start"]>[0];
    signal?: AbortSignal;
  }> = [];
  readonly writes: Array<{
    input: Parameters<ShellExecutor["write"]>[0];
    signal?: AbortSignal;
  }> = [];
  startHandler: (
    input: Parameters<ShellExecutor["start"]>[0],
    signal?: AbortSignal,
  ) => Promise<ShellSessionResult> = async () => ({
    sessionId: "pct-shell-fake",
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    dropped: false,
  });

  async start(
    input: Parameters<ShellExecutor["start"]>[0],
    abortSignal?: AbortSignal,
  ): Promise<ShellSessionResult> {
    this.starts.push({ input, signal: abortSignal });
    return this.startHandler(input, abortSignal);
  }

  async write(
    input: Parameters<ShellExecutor["write"]>[0],
    abortSignal?: AbortSignal,
  ): Promise<ShellSessionResult> {
    this.writes.push({ input, signal: abortSignal });
    return {
      sessionId: input.sessionId,
      status: "completed",
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      dropped: false,
    };
  }
}

function fakeApplyPatch(
  execute: ToolDefinition["execute"] = (async () => ({
    content: [{ type: "text", text: "Applied patch:" }],
    details: { operations: [{ operation: "add", path: "a.txt" }] },
  })) as ToolDefinition["execute"],
): ToolDefinition {
  return {
    ...APPLY_PATCH_TOOL_DEFINITION,
    execute,
  } as ToolDefinition;
}

describe("CodeModeAdapters shell adapters", () => {
  it("forwards resolved exec_command arguments to the shared executor", async () => {
    const shell = new FakeShell();
    const adapters = new CodeModeAdapters({ shell });

    const result = await adapters.call(
      "exec_command",
      { command: "echo hi", cwd: "sub", yieldTimeMs: 50, maxOutputBytes: 2048 },
      signal(),
      cell(),
    );

    expect(result).toMatchObject({
      sessionId: "pct-shell-fake",
      status: "completed",
    });
    expect(shell.starts).toHaveLength(1);
    expect(shell.starts[0].input).toEqual({
      command: "echo hi",
      cwd: `${process.cwd()}/sub`,
      yieldTimeMs: 50,
      maxOutputBytes: 2048,
    });
  });

  it("forwards write_stdin input, close, and terminate flags", async () => {
    const shell = new FakeShell();
    const adapters = new CodeModeAdapters({ shell });

    const result = await adapters.call(
      "write_stdin",
      {
        sessionId: "pct-shell-1",
        input: "y\n",
        closeStdin: true,
        terminate: false,
      },
      signal(),
      cell(),
    );

    expect(result).toMatchObject({ sessionId: "pct-shell-1" });
    expect(shell.writes[0].input).toMatchObject({
      sessionId: "pct-shell-1",
      input: "y\n",
      closeStdin: true,
      terminate: false,
    });
  });

  it("accepts the Codex spellings and returns both result spellings", async () => {
    const shell = new FakeShell();
    const adapters = new CodeModeAdapters({ shell });

    const started = await adapters.call(
      "exec_command",
      {
        cmd: "echo hi",
        workdir: "sub",
        yield_time_ms: 50,
        max_output_tokens: 512,
      },
      signal(),
      cell(),
    );

    expect(shell.starts[0].input).toEqual({
      command: "echo hi",
      cwd: `${process.cwd()}/sub`,
      yieldTimeMs: 50,
      maxOutputBytes: 2048,
    });
    // The nested value carries the Codex spellings beside the existing ones.
    expect(started).toMatchObject({
      sessionId: "pct-shell-fake",
      session_id: "pct-shell-fake",
      exitCode: 0,
      exit_code: 0,
    });

    const continued = await adapters.call(
      "write_stdin",
      {
        session_id: "pct-shell-1",
        chars: "y\n",
        yield_time_ms: 5,
        max_output_tokens: 256,
      },
      signal(),
      cell(),
    );
    expect(shell.writes[0].input).toEqual({
      sessionId: "pct-shell-1",
      input: "y\n",
      closeStdin: undefined,
      terminate: undefined,
      yieldTimeMs: 5,
      maxOutputBytes: 1024,
    });
    expect(continued).toMatchObject({
      sessionId: "pct-shell-1",
      session_id: "pct-shell-1",
      exit_code: 0,
    });
  });

  it("rejects conflicts, unsupported fields and numeric handles before dispatch", async () => {
    const shell = new FakeShell();
    const adapters = new CodeModeAdapters({ shell });

    for (const args of [
      { cmd: "a", command: "b" },
      { cmd: "a", workdir: "x", cwd: "y" },
      { cmd: "a", yield_time_ms: 1, yieldTimeMs: 2 },
    ])
      await expect(
        adapters.call("exec_command", args, signal(), cell()),
      ).rejects.toMatchObject({
        code: "invalid-arguments",
        message: expect.stringContaining("conflicting values"),
      });
    for (const field of [
      "tty",
      "shell",
      "login",
      "sandbox_permissions",
      "justification",
      "with_escalated_permissions",
      "prefix_rule",
      "timeout_ms",
    ])
      await expect(
        adapters.call(
          "exec_command",
          { cmd: "a", [field]: true },
          signal(),
          cell(),
        ),
      ).rejects.toMatchObject({
        code: "invalid-arguments",
        message: expect.stringContaining(`does not support "${field}"`),
      });
    await expect(
      adapters.call("write_stdin", { session_id: 42 }, signal(), cell()),
    ).rejects.toMatchObject({
      code: "invalid-arguments",
      message: expect.stringContaining("not a number or an OS PID"),
    });
    await expect(
      adapters.call(
        "exec_command",
        { cmd: "a", max_output_tokens: 10 },
        signal(),
        cell(),
      ),
    ).rejects.toMatchObject({
      code: "invalid-arguments",
      message: expect.stringContaining("not provider tokenization"),
    });
    expect(shell.starts).toHaveLength(0);
    expect(shell.writes).toHaveLength(0);
  });

  it("rejects malformed shell arguments before invoking the executor", async () => {
    const shell = new FakeShell();
    const adapters = new CodeModeAdapters({ shell });

    await expect(
      adapters.call("exec_command", {}, signal(), cell()),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    await expect(
      adapters.call("exec_command", { command: "" }, signal(), cell()),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    await expect(
      adapters.call(
        "exec_command",
        { command: "x", yieldTimeMs: "soon" },
        signal(),
        cell(),
      ),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    await expect(
      adapters.call("write_stdin", {}, signal(), cell()),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    await expect(
      adapters.call(
        "write_stdin",
        { sessionId: "s", terminate: "yes" },
        signal(),
        cell(),
      ),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    expect(shell.starts).toHaveLength(0);
    expect(shell.writes).toHaveLength(0);
  });

  it("rejects an out-of-range byte budget the direct schema refuses", async () => {
    const shell = new FakeShell();
    const adapters = new CodeModeAdapters({ shell });

    // Combining budgets first would clamp this to 1024 and pass the shared
    // schema, so the nested path would run a call the direct tool rejects.
    await expect(
      adapters.call(
        "exec_command",
        {
          cmd: "echo harmless",
          maxOutputBytes: 1_000_000_000,
          max_output_tokens: 256,
        },
        signal(),
        cell(),
      ),
    ).rejects.toMatchObject({
      code: "invalid-arguments",
      message: expect.stringContaining("maxOutputBytes must be an integer"),
    });
    await expect(
      adapters.call(
        "write_stdin",
        {
          session_id: "pct-shell-1",
          maxOutputBytes: 1_000_000_000,
          max_output_tokens: 256,
        },
        signal(),
        cell(),
      ),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    expect(shell.starts).toHaveLength(0);
    expect(shell.writes).toHaveLength(0);
  });

  it("rejects unknown adapters and rechecks enabled state per dispatch", async () => {
    const shell = new FakeShell();
    let enabled = true;
    const adapters = new CodeModeAdapters({
      shell,
      shellEnabled: () => enabled,
    });

    await expect(
      adapters.call("not_adapted", {}, signal(), cell()),
    ).rejects.toMatchObject({ code: "unknown-adapter" });

    await adapters.call("exec_command", { command: "one" }, signal(), cell());
    enabled = false;
    await expect(
      adapters.call("exec_command", { command: "two" }, signal(), cell()),
    ).rejects.toMatchObject({ code: "adapter-disabled" });
    expect(shell.starts).toHaveLength(1);
  });

  it("reports configured adapter names", () => {
    const shell = new FakeShell();
    expect(new CodeModeAdapters({ shell }).allowedNames).toEqual([
      "exec_command",
      "write_stdin",
    ]);
    expect(
      new CodeModeAdapters({
        shell,
        applyPatch: { definition: fakeApplyPatch() },
      }).mutatingNames,
    ).toEqual(["apply_patch"]);
  });

  it("reuses the real ShellSessionManager as its only process backend", async () => {
    const manager = new ShellSessionManager({
      shellConfig: { shell: "/bin/sh", args: ["-c"], commandTransport: "argv" },
    });
    shellManagers.push(manager);
    const adapters = new CodeModeAdapters({ shell: manager });

    const result = (await adapters.call(
      "exec_command",
      { command: "printf 'hi\\n'", cwd: process.cwd(), yieldTimeMs: 2_000 },
      signal(),
      cell(),
    )) as ShellSessionResult;
    expect(result.stdout).toBe("hi\n");
    // The output wakes this call, and the exit can trail it past the settle grace.
    const exited =
      result.status === "completed"
        ? result
        : ((await adapters.call(
            "write_stdin",
            { sessionId: result.sessionId, yieldTimeMs: INNER_BUDGET_MS },
            signal(),
            cell(),
          )) as ShellSessionResult);

    expect(exited.status).toBe("completed");
    expect(exited.exitCode).toBe(0);

    const started = (await adapters.call(
      "exec_command",
      { command: "cat", cwd: process.cwd(), yieldTimeMs: 200 },
      signal(),
      cell(),
    )) as ShellSessionResult;
    expect(started.status).toBe("running");

    const written = (await adapters.call(
      "write_stdin",
      { sessionId: started.sessionId, input: "hello\n", yieldTimeMs: 2_000 },
      signal(),
      cell(),
    )) as ShellSessionResult;
    expect(written.stdout).toBe("hello\n");
    await adapters.call(
      "write_stdin",
      { sessionId: started.sessionId, closeStdin: true, yieldTimeMs: 2_000 },
      signal(),
      cell(),
    );
  });
});

describe("CodeModeAdapters apply_patch adapter", () => {
  it("validates arguments with TypeBox, then dispatches through the definition", async () => {
    const execute = vi.fn(
      async (_toolCallId: string, params: { patch: string }) => ({
        content: [{ type: "text" as const, text: "Applied patch:" }],
        details: { operations: [{ operation: "add", path: "a.txt" }] },
      }),
    );
    const definition = fakeApplyPatch(execute as ToolDefinition["execute"]);
    const adapters = new CodeModeAdapters({
      applyPatch: { definition },
      approvalMode: "always",
    });

    const result = await adapters.call(
      APPLY_PATCH_TOOL,
      { patch: "*** Begin Patch\n*** End Patch\n" },
      signal(),
      cell(context(), "pct-cell-42"),
    );

    expect(result).toEqual({
      operations: [{ operation: "add", path: "a.txt" }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toEqual({
      patch: "*** Begin Patch\n*** End Patch\n",
    });

    await expect(
      adapters.call(APPLY_PATCH_TOOL, {}, signal(), cell()),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    await expect(
      adapters.call(APPLY_PATCH_TOOL, { patch: 5 }, signal(), cell()),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("normalizes the freeform patch string into the validated executor input", async () => {
    const execute = vi.fn(
      async (_toolCallId: string, params: { patch: string }) => ({
        content: [{ type: "text" as const, text: "Applied patch:" }],
        details: { operations: [{ operation: "add", path: params.patch }] },
      }),
    );
    const definition = fakeApplyPatch(execute as ToolDefinition["execute"]);
    const approval = vi.fn(async (_request: MutationApprovalRequest) => true);
    const adapters = new CodeModeAdapters({
      applyPatch: { definition },
      approvalMode: "confirm",
      requestApproval: approval,
    });
    const envelope = "*** Begin Patch\n*** End Patch\n";

    const result = await adapters.call(
      APPLY_PATCH_TOOL,
      envelope,
      signal(),
      cell(context(), "pct-cell-42"),
    );

    expect(result).toEqual({
      operations: [{ operation: "add", path: envelope }],
    });
    expect(execute.mock.calls[0][1]).toEqual({ patch: envelope });
    // The confirmation preview shows the normalized arguments that will run.
    expect(approval.mock.calls[0][0]).toMatchObject({
      args: { patch: envelope },
    });

    await expect(
      adapters.call(APPLY_PATCH_TOOL, 7, signal(), cell()),
    ).rejects.toMatchObject({ code: "invalid-arguments" });
    await expect(
      adapters.call(
        APPLY_PATCH_TOOL,
        { patch: envelope, cwd: "." },
        signal(),
        cell(),
      ),
    ).rejects.toMatchObject({
      code: "invalid-arguments",
      message: expect.stringContaining('does not accept "cwd"'),
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("runs sequential adapters in submission order per cell", async () => {
    const order: string[] = [];
    const execute = vi.fn(async (_id, params: { patch: string }) => {
      order.push(params.patch);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        content: [{ type: "text" as const, text: "ok" }],
        details: { operations: [] },
      };
    });
    const adapters = new CodeModeAdapters({
      applyPatch: {
        definition: fakeApplyPatch(
          execute as unknown as ToolDefinition["execute"],
        ),
      },
      approvalMode: "always",
    });
    const shared = cell();

    await Promise.all([
      adapters.call(APPLY_PATCH_TOOL, { patch: "first" }, signal(), shared),
      adapters.call(APPLY_PATCH_TOOL, { patch: "second" }, signal(), shared),
      adapters.call(APPLY_PATCH_TOOL, { patch: "third" }, signal(), shared),
    ]);

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("keeps a failed sequential call from blocking later calls", async () => {
    let calls = 0;
    const execute = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("patch rejected");
      return {
        content: [{ type: "text" as const, text: "ok" }],
        details: { operations: [] },
      };
    });
    const adapters = new CodeModeAdapters({
      applyPatch: {
        definition: fakeApplyPatch(
          execute as unknown as ToolDefinition["execute"],
        ),
      },
      approvalMode: "always",
    });
    const shared = cell();

    const first = adapters.call(
      APPLY_PATCH_TOOL,
      { patch: "bad" },
      signal(),
      shared,
    );
    const second = adapters.call(
      APPLY_PATCH_TOOL,
      { patch: "good" },
      signal(),
      shared,
    );

    await expect(first).rejects.toThrow("patch rejected");
    await expect(second).resolves.toEqual({ operations: [] });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("blocks a disabled apply_patch adapter before invoking it", async () => {
    const execute = vi.fn();
    const adapters = new CodeModeAdapters({
      applyPatch: {
        definition: fakeApplyPatch(
          execute as unknown as ToolDefinition["execute"],
        ),
        isEnabled: () => false,
      },
      approvalMode: "always",
    });

    await expect(
      adapters.call(APPLY_PATCH_TOOL, { patch: "x" }, signal(), cell()),
    ).rejects.toMatchObject({ code: "adapter-disabled" });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("CodeModeAdapters mutation approval", () => {
  it("dispatches without asking under always", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: { operations: [] },
    }));
    const requestApproval = vi.fn(async () => true);
    const adapters = new CodeModeAdapters({
      applyPatch: {
        definition: fakeApplyPatch(
          execute as unknown as ToolDefinition["execute"],
        ),
      },
      approvalMode: "always",
      requestApproval,
    });

    await adapters.call(APPLY_PATCH_TOOL, { patch: "x" }, signal(), cell());
    expect(requestApproval).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("asks under confirm and dispatches only when approved", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: { operations: [] },
    }));
    const requests: MutationApprovalRequest[] = [];
    const requestApproval = vi.fn(async (request: MutationApprovalRequest) => {
      requests.push(request);
      return true;
    });
    const adapters = new CodeModeAdapters({
      applyPatch: {
        definition: fakeApplyPatch(
          execute as unknown as ToolDefinition["execute"],
        ),
      },
      approvalMode: "confirm",
      requestApproval,
    });

    await adapters.call(
      APPLY_PATCH_TOOL,
      { patch: "x" },
      signal(),
      cell(context(), "pct-cell-7"),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].name).toBe(APPLY_PATCH_TOOL);
    expect(requests[0].cellId).toBe("pct-cell-7");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("blocks without dispatch when approval is denied", async () => {
    const execute = vi.fn();
    const adapters = new CodeModeAdapters({
      applyPatch: {
        definition: fakeApplyPatch(
          execute as unknown as ToolDefinition["execute"],
        ),
      },
      approvalMode: "confirm",
      requestApproval: async () => false,
    });

    await expect(
      adapters.call(APPLY_PATCH_TOOL, { patch: "x" }, signal(), cell()),
    ).rejects.toMatchObject({ code: "approval-denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks without dispatch when no dialog-capable UI is available", async () => {
    const execute = vi.fn();
    const adapters = new CodeModeAdapters({
      applyPatch: {
        definition: fakeApplyPatch(
          execute as unknown as ToolDefinition["execute"],
        ),
      },
      approvalMode: "confirm",
    });

    await expect(
      adapters.call(APPLY_PATCH_TOOL, { patch: "x" }, signal(), cell()),
    ).rejects.toMatchObject({ code: "approval-unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("asks through the captured context UI when it is available", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: { operations: [] },
    }));
    const confirm = vi.fn(async () => true);
    const adapters = new CodeModeAdapters({
      applyPatch: {
        definition: fakeApplyPatch(
          execute as unknown as ToolDefinition["execute"],
        ),
      },
      approvalMode: "confirm",
    });

    await adapters.call(
      APPLY_PATCH_TOOL,
      { patch: "x" },
      signal(),
      cell(context({ hasUI: true, ui: { confirm } as never })),
    );

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  async function approvalMessage(patch: string): Promise<string> {
    const confirm = vi.fn(async (_title: string, _message: string) => true);
    const adapters = new CodeModeAdapters({
      applyPatch: { definition: fakeApplyPatch() },
      approvalMode: "confirm",
    });

    await adapters.call(
      APPLY_PATCH_TOOL,
      { patch },
      signal(),
      cell(
        context({ hasUI: true, ui: { confirm } as never }),
        "pct-cell-preview",
      ),
    );

    expect(confirm).toHaveBeenCalledTimes(1);
    return confirm.mock.calls[0][1];
  }

  it("keeps the argument preview and its marker within 800 UTF-8 bytes", async () => {
    // `{"patch":"` plus 754 bytes reaches 764, three below the 767 the marker
    // leaves: the pair costs four and is dropped whole, while a walk over UTF-16
    // units would fit its high surrogate into the last three bytes.
    const body = "a".repeat(754);
    const message = await approvalMessage(`${body}${ASTRAL}${"a".repeat(60)}`);

    const preview = `{"patch":"${body}${PREVIEW_MARKER}`;
    expect(message).toBe(`${PREVIEW_HEADER}${preview}`);
    expect(Buffer.byteLength(preview, "utf8")).toBe(797);
    expect(preview.endsWith(PREVIEW_MARKER)).toBe(true);
    expect(isWellFormed(preview)).toBe(true);
  });

  it("bounds the argument preview in UTF-8 bytes, not in UTF-16 units", async () => {
    // Every character is two bytes and one unit: a unit bound would keep 757 of
    // them, 1524 bytes of preview.
    const message = await approvalMessage(TWO_BYTE.repeat(500));

    const preview = `{"patch":"${TWO_BYTE.repeat(378)}${PREVIEW_MARKER}`;
    expect(message).toBe(`${PREVIEW_HEADER}${preview}`);
    expect(Buffer.byteLength(preview, "utf8")).toBe(799);
  });
});

describe("CodeModeAdapters concurrency and cancellation", () => {
  it("bounds concurrent adapters per cell", async () => {
    const shell = new FakeShell();
    let active = 0;
    let maxActive = 0;
    shell.startHandler = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return {
        sessionId: "pct-shell-fake",
        status: "completed",
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        truncated: false,
        dropped: false,
      };
    };
    const adapters = new CodeModeAdapters({ shell });
    const shared = cell();

    await Promise.all(
      Array.from({ length: 6 }, (_value, index) =>
        adapters.call(
          "exec_command",
          { command: `command-${index}` },
          signal(),
          shared,
        ),
      ),
    );

    expect(maxActive).toBe(4);
    expect(shell.starts).toHaveLength(6);
  });

  it("propagates an abort to an in-flight nested call", async () => {
    const shell = new FakeShell();
    shell.startHandler = (_input, abortSignal) =>
      new Promise((_resolve, reject) => {
        abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("nested call aborted")),
          { once: true },
        );
      });
    const adapters = new CodeModeAdapters({ shell });

    const controller = new AbortController();
    const pending = adapters.call(
      "exec_command",
      { command: "in-flight" },
      controller.signal,
      cell(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(pending).rejects.toThrow("nested call aborted");
  });

  it("rejects a queued nested call on abort before dispatch", async () => {
    const shell = new FakeShell();
    const resolvers: Array<() => void> = [];
    shell.startHandler = () =>
      new Promise((resolve) => {
        resolvers.push(() =>
          resolve({
            sessionId: "pct-shell-fake",
            status: "completed",
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            truncated: false,
            dropped: false,
          }),
        );
      });
    const adapters = new CodeModeAdapters({ shell });
    const shared = cell();
    const blockerSignal = new AbortController().signal;

    const blockers = Array.from({ length: 4 }, (_value, index) =>
      adapters.call(
        "exec_command",
        { command: `blocker-${index}` },
        blockerSignal,
        shared,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const queuedController = new AbortController();
    const queued = adapters.call(
      "exec_command",
      { command: "queued" },
      queuedController.signal,
      shared,
    );
    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ code: "aborted" });

    const commands = shell.starts.map((entry) => entry.input.command);
    expect(commands).toHaveLength(4);
    expect(commands).not.toContain("queued");
    for (const resolve of resolvers) resolve();
    await Promise.all(blockers);
  });
});
