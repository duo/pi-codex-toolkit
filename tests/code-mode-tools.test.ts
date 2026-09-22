import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  CODE_MODE_EXEC_TOOL,
  CODE_MODE_TOOLS,
  CODE_MODE_WAIT_TOOL,
  CODE_MODE_ADAPTER_HELP,
  CODE_MODE_RENDER_MAX_BYTES,
  createCodeModeTools,
  formatCodeModeResult,
} from "../src/code-mode/tools.ts";
import {
  CodeModeCellManager,
  CodeModeError,
  type CellDispatcher,
  type CodeModeCellResult,
  type NestedProgressRecord,
} from "../src/code-mode/manager.ts";
import { TERMINAL_SETTLE_GRACE_MS } from "./fixtures/budgets.ts";

import { EXEC_COMMAND_SCHEMA, WRITE_STDIN_SCHEMA } from "../src/shell/tools.ts";
import { APPLY_PATCH_TOOL_DEFINITION } from "../src/apply-patch.ts";

import { isWellFormed } from "./fixtures/well-formed.ts";

// ASCII, CJK and emoji in one 9-byte repetition; 1024 is not a multiple
// of it, so a correct byte budget clips on a code-point boundary.
const MIXED_UNIT = "aa\u59cb\u{1F642}";

const managers: CodeModeCellManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
});

function context(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    ...overrides,
  } as unknown as ExtensionContext;
}

function createHarness(options: {
  isEnabled?: () => boolean;
  dispatcher?: CellDispatcher;
  settleGraceMs?: number;
}): {
  tools: Map<string, ToolDefinition<any, any, any>>;
  dispatcher: CellDispatcher;
} {
  const dispatcher: CellDispatcher = options.dispatcher ?? {
    allowedNames: ["echo", "apply_patch"],
    mutatingNames: ["apply_patch"],
    call: async (name, args) =>
      name === "echo" ? { echo: args } : { operations: [] },
  };
  const manager = new CodeModeCellManager({
    dispatcher,
    settleGraceMs: options.settleGraceMs,
  });
  managers.push(manager);
  const definitions = createCodeModeTools({
    getManager: () => manager,
    isExecEnabled: options.isEnabled ?? (() => true),
    isWaitEnabled: options.isEnabled ?? (() => true),
  });
  return {
    dispatcher,
    tools: new Map(
      definitions.map((tool) => [
        tool.name,
        tool as ToolDefinition<any, any, any>,
      ]),
    ),
  };
}

function toolText(result: { content: Array<{ type: string }> }): string {
  const first = result.content[0] as { type: "text"; text: string };
  return first.text;
}

/** Description plus parameter schema; semantic clauses may live in either. */
function definitionText(tool: ToolDefinition<any, any, any>): string {
  return `${tool.description ?? ""}\n${JSON.stringify(tool.parameters)}`;
}

describe("Code Mode tool definitions", () => {
  it("exposes exactly the exec and wait tools", () => {
    expect(CODE_MODE_TOOLS).toEqual([CODE_MODE_EXEC_TOOL, CODE_MODE_WAIT_TOOL]);
    const { tools } = createHarness({});
    expect([...tools.keys()]).toEqual([
      CODE_MODE_EXEC_TOOL,
      CODE_MODE_WAIT_TOOL,
    ]);
  });

  it("declares the finalized exec schema", () => {
    const { tools } = createHarness({});
    const exec = tools.get(CODE_MODE_EXEC_TOOL);
    if (!exec) throw new Error("exec was not defined");
    expect(exec.parameters).toMatchObject({
      type: "object",
      required: ["code"],
      additionalProperties: false,
      properties: {
        code: { type: "string", minLength: 1 },
        uses: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        yieldTimeMs: { type: "integer", minimum: 0, maximum: 60000 },
        maxOutputBytes: { type: "integer", minimum: 1024, maximum: 262144 },
      },
    });
    const execText = definitionText(exec);
    expect(execText).toContain("never replayed");
    expect(execText).toContain("uses");
    expect(execText).toContain("not the nested calls");
    expect(execText).toContain("permission interceptors");
    expect(execText).toContain("gated by Code Mode approval");
    expect(execText).toContain("exec_command, write_stdin, and apply_patch");
    expect(execText).toContain("mirror those direct tools' JSON arguments");
    const usesSchema = (
      exec.parameters as {
        properties: { uses: { description: string } };
      }
    ).properties.uses;
    expect(usesSchema.description).toContain(
      "exec_command, write_stdin, and apply_patch",
    );
    expect(usesSchema.description).toContain(
      "mirror those direct tools' JSON arguments",
    );
  });

  it("describes trusted execution rather than a security sandbox", () => {
    const { tools } = createHarness({});
    const description = tools.get(CODE_MODE_EXEC_TOOL)!.description;
    expect(description).toContain("trusted JavaScript");
    expect(description).toContain("current user's authority");
    expect(description).toContain("fresh per-call worker");
    expect(description).toContain("not a security sandbox");
    expect(description).toContain(
      "uses validates adapter dispatch, not hostile-code containment",
    );
    expect(description).not.toContain("isolated cell");
  });

  it("keeps callable help complete even without discovery/direct schemas", () => {
    const { tools } = createHarness({});
    const description = tools.get("exec")!.description;
    expect(description).toContain(CODE_MODE_ADAPTER_HELP);
    for (const schema of [
      EXEC_COMMAND_SCHEMA,
      WRITE_STDIN_SCHEMA,
      APPLY_PATCH_TOOL_DEFINITION.parameters,
    ])
      for (const key of Object.keys(schema.properties))
        expect(description).toContain(key);
    for (const clause of [
      "unknown fields",
      "relative cwd",
      "inherited environment",
      "not a TTY",
      "no newline or EOF",
      "Command-transport stdin",
      "0..60000 (default 10000)",
      "1024..262144 (default 51200)",
      "262144 UTF-8 bytes/16 calls",
      "*** Begin Patch",
      "*** End of File",
      "including Delete File targets",
      "valid UTF-8 text",
      "consistent LF or CRLF",
      "non-UTF-8, bare CR and mixed line endings are rejected before mutation",
      "Binary deletion is unsupported",
      "only this adapter requires extra",
      "Shell retains direct-shell authority",
      "new exec declaring it",
      "Pi session shutdown",
    ])
      expect(description).toContain(clause);
  });
  it("advertises the adapters as possible, not as the admitted set", () => {
    // Pi fixes the description at registration, before any rule resolves, so
    // the text must not claim every listed adapter is callable: a Code-only
    // or Patch-excluded route admits fewer.
    const { tools } = createHarness({});
    const description = tools.get(CODE_MODE_EXEC_TOOL)!.description;
    expect(description).toContain("Adapters this build can expose");
    expect(description).toContain(
      "/pct status reports the admitted set for the current model",
    );
    expect(description).toContain(
      "fails that one call at dispatch without running anything",
    );
    expect(description).toContain(
      "admitted only while the current rule routes Patch through Code",
    );
    expect(description).not.toContain("Callable adapters (");
  });

  it("describes the supported dialect and no unsupported helper", () => {
    const { tools } = createHarness({});
    const exec = definitionText(tools.get(CODE_MODE_EXEC_TOOL)!);
    const wait = definitionText(tools.get(CODE_MODE_WAIT_TOOL)!);
    for (const clause of [
      "raw JavaScript source text, not JSON",
      'first-line pragma, for example // @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}',
      "pragma line is blanked so source line numbers do not shift",
      "not admitted when the nested call dispatches fails that call alone",
      "nested apply_patch call needs a dialog-capable UI at that moment",
      "Script running with cell ID <cell_id>",
      'tools.apply_patch("*** Begin Patch',
      "tools.apply_patch({patch: nonempty string})",
      "text(value) appends a string literally",
      "Admission and approval are rechecked when the nested call actually dispatches",
      "fails as approval-unavailable and nothing is changed",
    ])
      expect(exec).toContain(clause);
    for (const clause of [
      "max_tokens (the same field as max_output_tokens)",
      "terminate: true stops the cell",
    ])
      expect(wait).toContain(clause);
    // Codex helpers this runtime does not implement stay unadvertised: the
    // only place their names may appear is the sentence that denies them.
    const denial =
      "There is no store, load, notify, yield_control, ALL_TOOLS, image, audio, exit, timer, import or persistent state.";
    expect(exec).toContain(denial);
    const advertised = `${exec}\n${wait}`.replace(denial, "");
    for (const helper of [
      /\bstore\(/,
      /\bload\(/,
      /\bnotify\(/,
      /yield_control/,
      /ALL_TOOLS/,
      /\bimage\(/,
      /\baudio\(/,
      /generatedImage/,
      /exit\(\)/,
      /setTimeout/,
    ])
      expect(advertised).not.toMatch(helper);
  });

  it("bounds final text while keeping control/recovery ahead of clipped payload", () => {
    const text = formatCodeModeResult({
      cellId: "pct-cell-fixture",
      status: "terminated",
      output: "🙂".repeat(100000),
      truncated: true,
      dropped: false,
      unknownOutcome: true,
      shells: [
        {
          sessionId: "pct-shell-control",
          status: "terminated",
          unknownOutcome: true,
        },
      ],
      recovery: {
        output: {
          state: "partial",
          path: "/tmp/owned-fixture",
          reason: "source-error",
          bytes: 400000,
          capturedBytes: 300000,
        },
      },
    });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      CODE_MODE_RENDER_MAX_BYTES,
    );
    expect(text).toContain("pct-shell-control");
    expect(text).toContain("/tmp/owned-fixture");
    expect(text).toContain("unknown");
    expect(text).not.toContain("�");
    expect(text).toContain("rendered payload clipped");
  });
  it("declares the finalized wait schema", () => {
    const { tools } = createHarness({});
    const wait = tools.get(CODE_MODE_WAIT_TOOL);
    if (!wait) throw new Error("wait was not defined");
    expect(wait.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        cell_id: { type: "string", minLength: 1 },
        cellId: { type: "string", minLength: 1 },
        terminate: { type: "boolean" },
        yield_time_ms: { type: "integer", minimum: 0, maximum: 60000 },
        yieldTimeMs: { type: "integer", minimum: 0, maximum: 60000 },
        max_tokens: { type: "integer", minimum: 256, maximum: 65536 },
        max_output_tokens: { type: "integer", minimum: 256, maximum: 65536 },
        maxOutputBytes: { type: "integer", minimum: 1024, maximum: 262144 },
      },
    });
    // cell_id and cellId are one field, so neither is schema-required; the
    // dialect normalizer requires exactly one spelling.
    expect(
      (wait.parameters as { required?: string[] }).required,
    ).toBeUndefined();
    const waitText = definitionText(wait);
    expect(waitText).toContain("never re-runs the program");
    expect(waitText).toContain("output produced since the previous read");
    expect(waitText).toContain(
      "reading a terminal state returns it and releases the handle",
    );
    expect(waitText).toContain("not undone or retried");
    expect(waitText).toContain("outcome is reported as unknown");
  });

  it("runs a program and renders output plus result", async () => {
    const { tools } = createHarness({
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });
    const exec = tools.get(CODE_MODE_EXEC_TOOL)!;

    const result = await exec.execute(
      "call-1",
      { code: 'print("hi"); return 5;' },
      undefined,
      undefined,
      context(),
    );
    const details = result.details as CodeModeCellResult;

    expect(details.status).toBe("completed");
    expect(details.result).toBe(5);
    const text = toolText(result);
    expect(text).toContain("cell_id pct-cell-");
    expect(text).toContain("[output]\nhi\n");
    expect(text).toContain("[result]\n5");
  });

  it("emits text() literally and keeps print's formatting", async () => {
    const { tools } = createHarness({
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });
    const exec = tools.get(CODE_MODE_EXEC_TOOL)!;

    const result = await exec.execute(
      "call-1",
      {
        code: 'text("a"); text("b"); text(7); text({ n: 1 }); text(undefined); print("p"); return "done";',
      },
      undefined,
      undefined,
      context(),
    );
    const details = result.details as CodeModeCellResult;

    expect(details.status).toBe("completed");
    // Strings are appended exactly, non-strings use JSON.stringify when it
    // yields a string, and anything else falls back to print's formatter.
    expect(details.output).toBe('ab7{"n":1}undefined\np\n');
  });

  it("keeps text() from failing the cell on unserializable values", async () => {
    const { tools } = createHarness({
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });
    const exec = tools.get(CODE_MODE_EXEC_TOOL)!;

    // Every value here makes JSON.stringify throw or return undefined. The
    // helper must fall back to print's formatter, not reject the program.
    const result = await exec.execute(
      "call-1",
      {
        code: [
          "const cyclic = { a: 1 }; cyclic.self = cyclic;",
          "text(cyclic);",
          "text(10n);",
          "text(Symbol('s'));",
          "return 'after';",
        ].join("\n"),
      },
      undefined,
      undefined,
      context(),
    );
    const details = result.details as CodeModeCellResult;

    expect(details.status).toBe("completed");
    expect(details.result).toBe("after");
    expect(details.error).toBeUndefined();
    expect(details.output).toBe(
      "<ref *1> { a: 1, self: [Circular *1] }\n10n\nSymbol(s)\n",
    );
  });

  it("accepts the first-line pragma and the Codex argument spellings", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<string>((resolve) => {
      release = () => resolve("released");
    });
    const { tools } = createHarness({
      dispatcher: { allowedNames: ["hold"], call: () => gate },
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });
    const exec = tools.get(CODE_MODE_EXEC_TOOL)!;
    const wait = tools.get(CODE_MODE_WAIT_TOOL)!;

    try {
      const started = await exec.execute(
        "call-1",
        {
          code: '// @exec: {"yield_time_ms": 0}\nprint("first"); await tools.hold({}); return 1;',
          uses: ["hold"],
        },
        undefined,
        undefined,
        context(),
      );
      const details = started.details as CodeModeCellResult;
      expect(details.status).toBe("running");
      // The yielded cell reports the upstream continuation phrase first.
      expect(toolText(started).startsWith("Script running with cell ID ")).toBe(
        true,
      );
      expect(toolText(started)).toContain(`cell ID ${details.cellId}.`);
      expect(toolText(started)).toContain("Continue with wait cell_id");

      // wait accepts cell_id, yield_time_ms and the Codex token budget.
      const polled = await wait.execute(
        "call-2",
        { cell_id: details.cellId, yield_time_ms: 0, max_tokens: 256 },
        undefined,
        undefined,
        context(),
      );
      expect((polled.details as CodeModeCellResult).status).toBe("running");

      await expect(
        exec.execute(
          "call-3",
          {
            code: '// @exec: {"yield_time_ms": 10}\nreturn 1;',
            yield_time_ms: 20,
          },
          undefined,
          undefined,
          context(),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("they conflict"),
      });
      await expect(
        exec.execute(
          "call-4",
          { code: "return 1;", cellId: "pct-cell-1" },
          undefined,
          undefined,
          context(),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('does not accept "cellId"'),
      });
      await expect(
        wait.execute(
          "call-5",
          { cell_id: 12 },
          undefined,
          undefined,
          context(),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("opaque cell handle string"),
      });
    } finally {
      release();
    }
  });

  it("declares the current admission snapshot when uses is omitted", async () => {
    let admitted = ["echo", "apply_patch"];
    const calls: string[] = [];
    const dispatcher: CellDispatcher = {
      allowedNames: ["echo", "apply_patch"],
      mutatingNames: ["apply_patch"],
      admittedNames: () => admitted,
      call: async (name) => {
        calls.push(name);
        return { ok: name };
      },
    };
    const { tools } = createHarness({
      dispatcher,
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });
    const exec = tools.get(CODE_MODE_EXEC_TOOL)!;

    const both = await exec.execute(
      "call-1",
      { code: "return await tools.echo({ n: 1 });" },
      undefined,
      undefined,
      context(),
    );
    expect((both.details as CodeModeCellResult).result).toEqual({ ok: "echo" });
    expect(calls).toEqual(["echo"]);

    // An explicit empty list declares nothing, even though echo is admitted.
    const none = await exec.execute(
      "call-2",
      {
        code: 'try { await tools.echo({}); return "dispatched"; } catch (error) { return error.message; }',
        uses: [],
      },
      undefined,
      undefined,
      context(),
    );
    expect(String((none.details as CodeModeCellResult).result)).toContain(
      'was not declared in "uses" for this cell',
    );

    // A known adapter the host does not currently admit cannot be declared,
    // and an omitted `uses` does not reopen it.
    admitted = ["echo"];
    await expect(
      exec.execute(
        "call-3",
        { code: "return 1;", uses: ["apply_patch"] },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toMatchObject({
      code: "invalid-uses",
      message: expect.stringContaining("not currently available"),
    });
    const narrowed = await exec.execute(
      "call-4",
      {
        code: 'try { await tools.apply_patch({ patch: "x" }); return "dispatched"; } catch (error) { return error.message; }',
      },
      undefined,
      undefined,
      context(),
    );
    expect(String((narrowed.details as CodeModeCellResult).result)).toContain(
      'was not declared in "uses" for this cell',
    );
    expect(calls).toEqual(["echo"]);

    // An unknown name stays a different rejection from an unavailable one.
    await expect(
      exec.execute(
        "call-5",
        { code: "return 1;", uses: ["not_adapted"] },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toMatchObject({
      code: "invalid-uses",
      message: expect.stringContaining("not an adapted Code Mode tool"),
    });
  });

  it("clips cell output to a token budget without failing the program", async () => {
    const { tools } = createHarness({
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });
    const exec = tools.get(CODE_MODE_EXEC_TOOL)!;

    const result = await exec.execute(
      "call-1",
      {
        code: `print(${JSON.stringify(MIXED_UNIT)}.repeat(400)); return "done";`,
        max_output_tokens: 256,
      },
      undefined,
      undefined,
      context(),
    );
    const details = result.details as CodeModeCellResult;

    expect(details.status).toBe("completed");
    expect(details.result).toBe("done");
    expect(details.clipping?.output).toBe(true);
    expect(Buffer.byteLength(details.output)).toBeLessThanOrEqual(1024);
    expect(isWellFormed(details.output)).toBe(true);
    expect(details.output).not.toContain("\uFFFD");
    expect(details.output.startsWith(MIXED_UNIT)).toBe(true);
    // Clipping is a preview budget: the full text stays recoverable.
    expect(details.recovery?.output?.state).toBe("complete");
  });

  it("continues a yielded cell through wait", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<string>((resolve) => {
      release = () => resolve("released");
    });
    const { tools } = createHarness({
      dispatcher: {
        allowedNames: ["hold"],
        call: () => gate,
      },
      settleGraceMs: TERMINAL_SETTLE_GRACE_MS,
    });
    const exec = tools.get(CODE_MODE_EXEC_TOOL)!;
    const wait = tools.get(CODE_MODE_WAIT_TOOL)!;

    const first = await exec.execute(
      "call-1",
      {
        code: 'print("first"); const value = await tools.hold({}); return value;',
        uses: ["hold"],
        yieldTimeMs: 0,
      },
      undefined,
      undefined,
      context(),
    );
    const firstDetails = first.details as CodeModeCellResult;
    expect(firstDetails.status).toBe("running");
    expect(toolText(first)).toContain("(no new output)");

    const pending = wait.execute(
      "call-2",
      { cellId: firstDetails.cellId, yieldTimeMs: 5_000 },
      undefined,
      undefined,
      context(),
    );
    release();
    const second = await pending;
    const secondDetails = second.details as CodeModeCellResult;

    expect(secondDetails.status).toBe("completed");
    expect(secondDetails.result).toBe("released");
    expect(toolText(second)).toContain("[result]\nreleased");
  });

  it("captures the outer context for nested adapters", async () => {
    const seen: unknown[] = [];
    const dispatcher: CellDispatcher = {
      allowedNames: ["inspect"],
      call: async (_name, _args, _signal, cell) => {
        seen.push(cell.hostContext);
        return "ok";
      },
    };
    const { tools } = createHarness({ dispatcher });
    const exec = tools.get(CODE_MODE_EXEC_TOOL)!;
    const ctx = context();

    const result = await exec.execute(
      "call-1",
      { code: "return await tools.inspect({});", uses: ["inspect"] },
      undefined,
      undefined,
      ctx,
    );

    expect((result.details as CodeModeCellResult).result).toBe("ok");
    expect(seen).toEqual([ctx]);
  });

  it("rejects stale cell IDs, invalid uses, and disabled Code Mode", async () => {
    const { tools } = createHarness({});
    const exec = tools.get(CODE_MODE_EXEC_TOOL)!;
    const wait = tools.get(CODE_MODE_WAIT_TOOL)!;

    await expect(
      wait.execute(
        "call-1",
        { cellId: "pct-cell-missing" },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toMatchObject({ code: "stale-cell" });
    await expect(
      exec.execute(
        "call-2",
        { code: "return 1;", uses: ["not_adapted"] },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid-uses" });

    const disabled = createHarness({ isEnabled: () => false });
    await expect(
      disabled.tools
        .get(CODE_MODE_EXEC_TOOL)!
        .execute(
          "call-3",
          { code: "return 1;" },
          undefined,
          undefined,
          context(),
        ),
    ).rejects.toThrow("Code Mode is not enabled.");
  });

  it("starts a headless cell that declares a mutating adapter and fails only that call", async () => {
    // The pre-worker rejection is gone: approval belongs to the actual nested
    // dispatch, so declaring apply_patch no longer refuses the whole program.
    const dispatched: string[] = [];
    const { tools } = createHarness({
      dispatcher: {
        allowedNames: ["echo", "apply_patch"],
        mutatingNames: ["apply_patch"],
        call: async (name) => {
          dispatched.push(name);
          if (name !== "apply_patch") return { ok: true };
          throw new CodeModeError(
            "approval-unavailable",
            "Code Mode needs UI confirmation before running nested apply_patch, but no dialog-capable UI is available.",
          );
        },
      },
    });
    const exec = tools.get(CODE_MODE_EXEC_TOOL)!;

    const declaredButUnused = await exec.execute(
      "call-1",
      { code: "return 1;", uses: ["apply_patch"] },
      undefined,
      undefined,
      context(),
    );
    expect((declaredButUnused.details as CodeModeCellResult).status).toBe(
      "completed",
    );
    expect(dispatched).toEqual([]);

    const attempted = await exec.execute(
      "call-2",
      {
        code: 'await tools.apply_patch({patch:"*** Begin Patch\\n*** End Patch"});',
        uses: ["apply_patch"],
      },
      undefined,
      undefined,
      context(),
    );
    const failed = attempted.details as CodeModeCellResult;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("no dialog-capable UI is available");
    expect(dispatched).toEqual(["apply_patch"]);

    // The dialect still runs first, so a malformed call is refused on its own
    // terms and never starts a cell.
    await expect(
      exec.execute(
        "call-3",
        {
          code: '// @exec: {"store": true}\nreturn 1;',
          uses: ["apply_patch"],
        },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toMatchObject({
      code: "invalid-arguments",
      message: expect.stringContaining('does not accept "store"'),
    });

    // An omitted `uses` is the whole available set, not a declaration.
    const implicit = await exec.execute(
      "call-4",
      { code: "return 1;" },
      undefined,
      undefined,
      context(),
    );
    expect((implicit.details as CodeModeCellResult).status).toBe("completed");
  });

  it("forwards bounded nested progress through the outer call update", async () => {
    const { tools } = createHarness({
      dispatcher: {
        allowedNames: ["echo", "apply_patch"],
        mutatingNames: ["apply_patch"],
        call: async (name, _args, _signal, cell) => {
          if (name === "apply_patch") {
            cell.reportProgress?.({ phase: "waiting-approval", name });
            throw new CodeModeError("approval-denied", "not approved");
          }
          return { sessionId: "pct-shell-progress" };
        },
      },
    });
    const exec = tools.get(CODE_MODE_EXEC_TOOL)!;
    const updates: NestedProgressRecord[] = [];

    const result = await exec.execute(
      "call-1",
      {
        code: "await tools.echo({});\ntry { await tools.apply_patch('x'); } catch {}\nreturn 1;",
        uses: ["echo", "apply_patch"],
      },
      undefined,
      (partial) => updates.push(partial.details as NestedProgressRecord),
      context(),
    );

    expect((result.details as CodeModeCellResult).status).toBe("completed");
    expect(updates).toEqual([
      {
        nested: true,
        phase: "start",
        name: "echo",
        cell_id: updates[0]?.cell_id,
      },
      {
        nested: true,
        phase: "end",
        name: "echo",
        cell_id: updates[0]?.cell_id,
        session_id: "pct-shell-progress",
        ok: true,
      },
      {
        nested: true,
        phase: "start",
        name: "apply_patch",
        cell_id: updates[0]?.cell_id,
      },
      {
        nested: true,
        phase: "waiting-approval",
        name: "apply_patch",
        cell_id: updates[0]?.cell_id,
      },
      {
        nested: true,
        phase: "end",
        name: "apply_patch",
        cell_id: updates[0]?.cell_id,
        ok: false,
        error: "approval-denied",
      },
    ]);
    expect(updates[0]?.cell_id).toMatch(/^pct-cell-/);
  });
});

describe("formatCodeModeResult", () => {
  it("renders running, terminal, truncation, and unknown-outcome evidence", () => {
    expect(
      formatCodeModeResult({
        cellId: "pct-cell-1",
        status: "running",
        output: "",
        truncated: false,
        dropped: false,
      }),
    ).toContain("(no new output)");

    const dropped = formatCodeModeResult({
      cellId: "pct-cell-2",
      status: "failed",
      output: "partial",
      error: "boom",
      truncated: true,
      dropped: true,
    });
    expect(dropped).toContain("[output]\npartial");
    expect(dropped).toContain("[error]\nboom");
    expect(dropped).toContain("buffered output was dropped");

    const unknown = formatCodeModeResult({
      cellId: "pct-cell-3",
      status: "terminated",
      output: "",
      error: "Cell terminated by request.",
      truncated: false,
      dropped: false,
      unknownOutcome: true,
    });
    expect(unknown).toContain("outcome is unknown");

    const result = formatCodeModeResult({
      cellId: "pct-cell-4",
      status: "completed",
      output: "",
      result: { a: 1 },
      truncated: false,
      dropped: false,
    });
    expect(result).toContain('[result]\n{"a":1}');
    expect(result).not.toContain("(no output)");
  });
});
