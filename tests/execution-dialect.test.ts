import type { Tool } from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import {
  CODE_MODE_EXEC_TOOL,
  createCodeModeTools,
  EXEC_LARK_GRAMMAR,
} from "../src/code-mode/tools.ts";
import {
  DIALECT_BYTES_PER_TOKEN,
  DIALECT_TOKENS_MAX,
  DIALECT_TOKENS_MIN,
  ExecutionDialectError,
  normalizeExecArgs,
  normalizeNestedPatchArgs,
  normalizeShellContinuationArgs,
  normalizeShellStartArgs,
  normalizeWaitArgs,
  parseExecPragma,
  tokensToByteBudget,
  withShellDialectFields,
} from "../src/execution-dialect.ts";
import {
  SHELL_MAX_BYTES_MAX,
  SHELL_MAX_BYTES_MIN,
  type ShellSessionResult,
} from "../src/shell/manager.ts";
import { EXEC_COMMAND_SCHEMA } from "../src/shell/tools.ts";

/** Every dialect rejection carries the nested invalid-arguments code. */
function rejects(run: () => unknown, ...fragments: string[]): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ExecutionDialectError);
  expect((thrown as ExecutionDialectError).code).toBe("invalid-arguments");
  for (const fragment of fragments)
    expect((thrown as Error).message).toContain(fragment);
}

const UNSUPPORTED = [
  "tty",
  "shell",
  "login",
  "sandbox_permissions",
  "justification",
  "with_escalated_permissions",
  "prefix_rule",
  "timeout_ms",
] as const;

describe("shell start dialect", () => {
  it("accepts the Codex spellings and the existing ones", () => {
    expect(
      normalizeShellStartArgs({
        cmd: "echo hi",
        workdir: "sub",
        yield_time_ms: 250,
        max_output_tokens: 512,
      }),
    ).toEqual({
      command: "echo hi",
      cwd: "sub",
      yieldTimeMs: 250,
      maxOutputBytes: 512 * DIALECT_BYTES_PER_TOKEN,
    });
    expect(
      normalizeShellStartArgs({
        command: "echo hi",
        cwd: "sub",
        yieldTimeMs: 250,
        maxOutputBytes: 2048,
      }),
    ).toEqual({
      command: "echo hi",
      cwd: "sub",
      yieldTimeMs: 250,
      maxOutputBytes: 2048,
    });
  });

  it("passes identical duplicates and rejects conflicting ones", () => {
    expect(
      normalizeShellStartArgs({
        cmd: "echo hi",
        command: "echo hi",
        workdir: "sub",
        cwd: "sub",
        yield_time_ms: 10,
        yieldTimeMs: 10,
      }),
    ).toEqual({
      command: "echo hi",
      cwd: "sub",
      yieldTimeMs: 10,
    });
    rejects(
      () => normalizeShellStartArgs({ cmd: "a", command: "b" }),
      "conflicting values",
      '"cmd"',
      '"command"',
    );
    rejects(
      () => normalizeShellStartArgs({ cmd: "a", workdir: "x", cwd: "y" }),
      "conflicting values",
    );
    rejects(
      () =>
        normalizeShellStartArgs({ cmd: "a", yield_time_ms: 1, yieldTimeMs: 2 }),
      "conflicting values",
    );
  });

  it("rejects unsupported Codex fields by name", () => {
    for (const field of UNSUPPORTED)
      rejects(
        () => normalizeShellStartArgs({ cmd: "a", [field]: true }),
        `does not support "${field}"`,
        "never applied silently",
      );
    rejects(
      () => normalizeShellStartArgs({ cmd: "a", bogus: 1 }),
      'does not accept "bogus"',
    );
  });

  it("requires exactly one command spelling and rejects wrong types", () => {
    rejects(() => normalizeShellStartArgs({}), "cmd", "command");
    rejects(() => normalizeShellStartArgs("echo hi"), "single JSON object");
    rejects(() => normalizeShellStartArgs([]), "single JSON object");
    rejects(() => normalizeShellStartArgs({ cmd: "" }), "non-empty string");
    rejects(() => normalizeShellStartArgs({ cmd: 7 }), "must be a string");
    rejects(
      () => normalizeShellStartArgs({ cmd: "a", yieldTimeMs: 1.5 }),
      "must be an integer",
    );
  });
});

describe("shell continuation dialect", () => {
  it("accepts both spellings and keeps the existing controls", () => {
    expect(
      normalizeShellContinuationArgs({
        session_id: "pct-shell-1",
        chars: "y\n",
        closeStdin: true,
        terminate: false,
        yield_time_ms: 0,
      }),
    ).toEqual({
      sessionId: "pct-shell-1",
      input: "y\n",
      closeStdin: true,
      terminate: false,
      yieldTimeMs: 0,
    });
    expect(
      normalizeShellContinuationArgs({
        sessionId: "pct-shell-1",
        input: "",
      }),
    ).toEqual({ sessionId: "pct-shell-1", input: "" });
  });

  it("never coerces a numeric handle into the opaque string", () => {
    rejects(
      () => normalizeShellContinuationArgs({ session_id: 4321 }),
      "opaque session handle string",
      "not a number or an OS PID",
    );
    rejects(
      () => normalizeShellContinuationArgs({ sessionId: 4321 }),
      "opaque session handle string",
    );
    rejects(
      () => normalizeShellContinuationArgs({}),
      '"session_id"',
      "opaque handle string",
    );
    rejects(
      () =>
        normalizeShellContinuationArgs({
          session_id: "a",
          sessionId: "b",
        }),
      "conflicting values",
    );
    rejects(
      () => normalizeShellContinuationArgs({ session_id: "a", chars: 1 }),
      "must be a string",
    );
    rejects(
      () =>
        normalizeShellContinuationArgs({ session_id: "a", terminate: "yes" }),
      "must be a boolean",
    );
    rejects(
      () => normalizeShellContinuationArgs({ session_id: "a", closeStdin: 1 }),
      "must be a boolean",
    );
  });
});

describe("output budgets", () => {
  it("maps tokens onto the documented byte proxy inside existing caps", () => {
    expect(
      tokensToByteBudget(DIALECT_TOKENS_MIN, {
        min: SHELL_MAX_BYTES_MIN,
        max: SHELL_MAX_BYTES_MAX,
      }),
    ).toBe(SHELL_MAX_BYTES_MIN);
    expect(
      tokensToByteBudget(DIALECT_TOKENS_MAX, {
        min: SHELL_MAX_BYTES_MIN,
        max: SHELL_MAX_BYTES_MAX,
      }),
    ).toBe(SHELL_MAX_BYTES_MAX);
    expect(
      tokensToByteBudget(1000, { min: SHELL_MAX_BYTES_MIN, max: 2048 }),
    ).toBe(2048);
  });

  it("applies both budgets when tokens and bytes are supplied", () => {
    expect(
      normalizeShellStartArgs({
        cmd: "a",
        max_output_tokens: 1000,
        maxOutputBytes: 2048,
      }).maxOutputBytes,
    ).toBe(2048);
    expect(
      normalizeShellStartArgs({
        cmd: "a",
        max_output_tokens: 300,
        maxOutputBytes: 9000,
      }).maxOutputBytes,
    ).toBe(1200);
  });

  it("rejects a token budget outside the documented range", () => {
    rejects(
      () => normalizeShellStartArgs({ cmd: "a", max_output_tokens: 255 }),
      `between ${DIALECT_TOKENS_MIN} and ${DIALECT_TOKENS_MAX}`,
      "not provider tokenization",
    );
    rejects(
      () => normalizeShellStartArgs({ cmd: "a", max_output_tokens: 65537 }),
      "not provider tokenization",
    );
  });

  it("validates each budget before combining them", () => {
    // Combining first would reduce an out-of-range byte budget to an
    // in-range one, so the nested path would accept what the direct schema
    // rejects. Each budget is checked against its own bounds instead.
    for (const args of [
      { cmd: "a", maxOutputBytes: 1_000_000_000, max_output_tokens: 256 },
      { cmd: "a", maxOutputBytes: 1_000_000_000 },
      { cmd: "a", maxOutputBytes: 1023, max_output_tokens: 65_536 },
    ]) {
      expect(Value.Check(EXEC_COMMAND_SCHEMA, args)).toBe(false);
      rejects(
        () => normalizeShellStartArgs(args),
        `exec_command.maxOutputBytes must be an integer between ${SHELL_MAX_BYTES_MIN} and ${SHELL_MAX_BYTES_MAX} bytes.`,
      );
    }
    rejects(
      () =>
        normalizeWaitArgs({
          cell_id: "pct-cell-1",
          maxOutputBytes: 1_000_000_000,
          max_tokens: 256,
        }),
      "wait.maxOutputBytes must be an integer between",
    );
    rejects(
      () =>
        normalizeExecArgs({
          code: "return 1;",
          maxOutputBytes: 1_000_000_000,
          max_output_tokens: 256,
        }),
      "exec.maxOutputBytes must be an integer between",
    );
    // The documented in-range combination still keeps the smaller ceiling.
    expect(
      normalizeShellStartArgs({
        cmd: "a",
        maxOutputBytes: SHELL_MAX_BYTES_MAX,
        max_output_tokens: 256,
      }).maxOutputBytes,
    ).toBe(1024);
  });
});

describe("wait dialect", () => {
  it("accepts cell_id plus both token spellings", () => {
    expect(
      normalizeWaitArgs({
        cell_id: "pct-cell-1",
        terminate: true,
        yield_time_ms: 5,
        max_tokens: 256,
      }),
    ).toEqual({
      cellId: "pct-cell-1",
      terminate: true,
      yieldTimeMs: 5,
      maxOutputBytes: 1024,
    });
    expect(
      normalizeWaitArgs({
        cellId: "pct-cell-1",
        max_tokens: 512,
        max_output_tokens: 512,
      }),
    ).toEqual({ cellId: "pct-cell-1", maxOutputBytes: 2048 });
    expect(
      normalizeWaitArgs({ cellId: "pct-cell-1", maxOutputBytes: 1024 }),
    ).toEqual({ cellId: "pct-cell-1", maxOutputBytes: 1024 });
  });

  it("rejects conflicting budgets, numeric handles and unknown fields", () => {
    rejects(
      () =>
        normalizeWaitArgs({
          cell_id: "pct-cell-1",
          max_tokens: 256,
          max_output_tokens: 512,
        }),
      "conflicting values",
    );
    rejects(
      () => normalizeWaitArgs({ cell_id: 12 }),
      "opaque cell handle string",
      "never interchanged",
    );
    rejects(() => normalizeWaitArgs({}), '"cell_id"');
    rejects(
      () => normalizeWaitArgs({ cell_id: "pct-cell-1", sessionId: "x" }),
      'does not accept "sessionId"',
    );
  });
});

describe("exec dialect and pragma", () => {
  it("keeps source line numbers when a pragma is present", () => {
    const pragma = parseExecPragma(
      '// @exec: {"yield_time_ms": 20, "max_output_tokens": 300}\nprint("a");\nprint("b");',
    );
    expect(pragma.present).toBe(true);
    expect(pragma.yieldTimeMs).toBe(20);
    expect(pragma.maxOutputTokens).toBe(300);
    expect(pragma.source).toBe('\nprint("a");\nprint("b");');
    expect(pragma.source.split("\n")).toHaveLength(3);
    const plain = parseExecPragma('print("a");');
    expect(plain).toEqual({ present: false, source: 'print("a");' });
  });

  it("keeps a CRLF program's line numbers and reads its pragma", () => {
    const code =
      '// @exec: {"yield_time_ms": 20}\r\nprint("a");\r\nprint("b");';
    const pragma = parseExecPragma(code);
    expect(pragma).toEqual({
      present: true,
      source: '\r\nprint("a");\r\nprint("b");',
      yieldTimeMs: 20,
    });
    // The CRLF that ended the pragma line is retained, so every later line
    // keeps its number and its original ending.
    expect(pragma.source.split("\r\n")).toHaveLength(3);
    expect(code.split("\r\n")).toHaveLength(3);
  });

  it("blanks a pragma-only program into an empty source", () => {
    // The upstream grammar requires a newline and a program after the pragma.
    // Nothing is invented here: the empty source reaches the cell manager,
    // which rejects it as a missing program before any worker starts.
    expect(parseExecPragma("// @exec: {}")).toEqual({
      present: true,
      source: "",
    });
    expect(normalizeExecArgs({ code: "// @exec: {}" })).toEqual({ code: "" });
  });

  it("only reads a pragma on the first line", () => {
    const code = 'print("a");\n// @exec: {"yield_time_ms": 5}';
    expect(parseExecPragma(code)).toEqual({ present: false, source: code });
    expect(parseExecPragma("\t// @exec: {}").present).toBe(true);
    expect(parseExecPragma(' // @exec:{"yield_time_ms":0}').yieldTimeMs).toBe(
      0,
    );
  });

  it("rejects malformed, non-object and unknown pragma options", () => {
    rejects(() => parseExecPragma("// @exec: {oops}\n1;"), "not valid JSON");
    rejects(
      () => parseExecPragma("// @exec: [1]\n1;"),
      "must be a JSON object",
    );
    rejects(() => parseExecPragma("// @exec: 4\n1;"), "must be a JSON object");
    rejects(
      () => parseExecPragma('// @exec: {"store": true}\n1;'),
      'does not accept "store"',
    );
    rejects(
      () => parseExecPragma('// @exec: {"yield_time_ms": -1}\n1;'),
      "non-negative integer",
    );
    rejects(
      () => parseExecPragma('// @exec: {"max_output_tokens": 1.5}\n1;'),
      "non-negative integer",
    );
  });

  it("merges pragma options with arguments and rejects real conflicts", () => {
    expect(
      normalizeExecArgs({
        code: '// @exec: {"yield_time_ms": 30, "max_output_tokens": 1000}\nreturn 1;',
      }),
    ).toEqual({
      code: "\nreturn 1;",
      yieldTimeMs: 30,
      maxOutputBytes: 4000,
    });
    expect(
      normalizeExecArgs({
        code: '// @exec: {"yield_time_ms": 30}\nreturn 1;',
        yieldTimeMs: 30,
      }).yieldTimeMs,
    ).toBe(30);
    // A repeated token budget is the same option, in either spelling.
    expect(
      normalizeExecArgs({
        code: '// @exec: {"max_output_tokens": 300}\nreturn 1;',
        max_output_tokens: 300,
      }),
    ).toEqual({ code: "\nreturn 1;", maxOutputBytes: 1200 });
    rejects(
      () =>
        normalizeExecArgs({
          code: '// @exec: {"yield_time_ms": 30}\nreturn 1;',
          yield_time_ms: 40,
        }),
      "pragma sets yield_time_ms to 30",
      "conflict",
    );
    rejects(
      () =>
        normalizeExecArgs({
          code: '// @exec: {"max_output_tokens": 300}\nreturn 1;',
          max_output_tokens: 400,
        }),
      "conflict",
    );
  });

  it("passes uses through for the manager and rejects a non-array", () => {
    expect(normalizeExecArgs({ code: "return 1;" })).toEqual({
      code: "return 1;",
    });
    expect(
      normalizeExecArgs({ code: "return 1;", uses: ["exec_command"] }).uses,
    ).toEqual(["exec_command"]);
    expect(normalizeExecArgs({ code: "return 1;", uses: [] }).uses).toEqual([]);
    rejects(
      () => normalizeExecArgs({ code: "return 1;", uses: "exec_command" }),
      "must be an array",
    );
    rejects(() => normalizeExecArgs({}), '"code"');
    rejects(() => normalizeExecArgs({ code: 1 }), "must be a string");
    rejects(
      () => normalizeExecArgs({ code: "return 1;", cell_id: "x" }),
      'does not accept "cell_id"',
    );
  });
});

describe("nested patch dialect", () => {
  const envelope = "*** Begin Patch\n*** End Patch\n";

  it("accepts the envelope string and the existing object", () => {
    expect(normalizeNestedPatchArgs(envelope)).toEqual({ patch: envelope });
    expect(normalizeNestedPatchArgs({ patch: envelope })).toEqual({
      patch: envelope,
    });
  });

  it("rejects missing, mistyped and unknown fields", () => {
    rejects(() => normalizeNestedPatchArgs({}), "*** Begin Patch");
    rejects(() => normalizeNestedPatchArgs({ patch: 5 }), "must be a string");
    rejects(
      () => normalizeNestedPatchArgs({ patch: envelope, cwd: "." }),
      'does not accept "cwd"',
    );
    rejects(() => normalizeNestedPatchArgs(7), "single JSON object");
  });
});

describe("nested shell result fields", () => {
  it("adds the Codex spellings beside the existing ones", () => {
    const result: ShellSessionResult = {
      sessionId: "pct-shell-1",
      status: "completed",
      exitCode: 0,
      signal: null,
      stdout: "out",
      stderr: "",
      truncated: false,
      dropped: false,
    };
    expect(withShellDialectFields(result)).toEqual({
      ...result,
      session_id: "pct-shell-1",
      exit_code: 0,
    });
    expect(
      withShellDialectFields({ ...result, status: "running", exitCode: null }),
    ).toMatchObject({ exit_code: null, session_id: "pct-shell-1" });
  });
});

describe("exec grammar transport", () => {
  const execTool = (): Tool => {
    const tools = createCodeModeTools({
      getManager: () => undefined,
      isExecEnabled: () => true,
      isWaitEnabled: () => true,
    });
    const exec = tools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL);
    if (!exec) throw new Error("exec was not defined");
    return {
      name: exec.name,
      description: exec.description ?? "",
      parameters: exec.parameters,
      constrainedSampling: exec.constrainedSampling,
    };
  };

  it("carries the pinned upstream freeform grammar", () => {
    expect(execTool().constrainedSampling).toEqual({
      type: "grammar",
      variants: { openai_lark: EXEC_LARK_GRAMMAR },
    });
    // Verbatim CODE_MODE_FREEFORM_GRAMMAR, including the optional pragma line.
    expect(EXEC_LARK_GRAMMAR).toBe(
      "\nstart: pragma_source | plain_source\n" +
        "pragma_source: PRAGMA_LINE NEWLINE SOURCE\n" +
        "plain_source: SOURCE\n\n" +
        "PRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/\n" +
        "NEWLINE: /\\r?\\n/\n" +
        "SOURCE: /[\\s\\S]+/\n",
    );
  });

  it("converts to a custom tool and decodes into code, with a JSON fallback", () => {
    const tool = execTool();
    // Grammar inference requires exactly one required string property.
    expect((tool.parameters as { required?: string[] }).required).toEqual([
      "code",
    ]);

    const [custom] = convertResponsesTools([tool], {
      supportsOpenAIGrammarTools: true,
    });
    expect(custom).toMatchObject({
      type: "custom",
      name: CODE_MODE_EXEC_TOOL,
      format: {
        type: "grammar",
        syntax: "lark",
        definition: EXEC_LARK_GRAMMAR,
      },
    });
    expect(
      createGrammarToolInputProperties([tool], true).get(CODE_MODE_EXEC_TOOL),
    ).toBe("code");

    const [fallback] = convertResponsesTools([tool], {
      supportsOpenAIGrammarTools: false,
    });
    expect(fallback).toMatchObject({
      type: "function",
      name: CODE_MODE_EXEC_TOOL,
      parameters: { type: "object", required: ["code"] },
    });
    expect(
      createGrammarToolInputProperties([tool], false).has(CODE_MODE_EXEC_TOOL),
    ).toBe(false);
  });

  it("normalizes decoded raw source exactly like the JSON form", () => {
    const source = '// @exec: {"yield_time_ms": 20}\nreturn 1;';
    // What Pi hands the executor after decoding a custom tool call.
    expect(normalizeExecArgs({ code: source })).toEqual({
      code: "\nreturn 1;",
      yieldTimeMs: 20,
    });
  });
});
