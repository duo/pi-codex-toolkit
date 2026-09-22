import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { outerBudget } from "./fixtures/budgets.ts";
import {
  diagnostics,
  runJsonChild,
  stageChildWorkspace,
  startRpcSession,
  turns,
  type ChildWorkspace,
} from "./fixtures/child-host.ts";

/**
 * Child compatibility against real Pi JSON and RPC processes.
 *
 * Every lane runs a real Pi process with the exact packed Toolkit staged in a
 * temporary agent directory and a deterministic offline provider. No lane
 * patches the installed host, depends on a role file, or reaches the network.
 */

// One real child start plus its scripted turns. With four copies of the suite
// on eight CPUs (12 runs), the slowest single-child lane took 5.6 s; this is at
// least three times that, in whole 10 s steps. It bounds a hung child, never a
// wait: every lane returns as soon as its child exits.
const CHILD_BUDGET_MS = 30_000;
const LANE_BUDGET_MS = outerBudget(CHILD_BUDGET_MS);
/** `npm pack`, extraction and the staged agent directory, under contention. */
const STAGE_BUDGET_MS = 30_000;
/** How long a scripted cell may observe itself before yielding a cell id. */
const CELL_YIELD_MS = 20_000;

const TOOLKIT_EXECUTION_NAMES = [
  "apply_patch",
  "exec_command",
  "write_stdin",
  "exec",
  "wait",
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("Pi child compatibility", () => {
  let workspace: ChildWorkspace;
  let configBefore: string;

  beforeAll(async () => {
    workspace = await stageChildWorkspace("pct-child-compat-");
    await workspace.writeRules(
      [
        {
          id: "astra",
          match: "gpt-6-astra",
          patch: true,
          shell: false,
          code: true,
        },
        { id: "grok", match: "grok*", patch: true, shell: true, code: false },
      ],
      // The approval mode a lane must never change on its own.
      { codeMode: { approvalMode: "confirm" } },
    );
    configBefore = await readFile(workspace.configPath, "utf8");
  }, STAGE_BUDGET_MS);

  afterAll(async () => {
    await workspace?.cleanup();
  });

  it(
    "projects the parent's own rules and asks for each nested mutation",
    async () => {
      // No role allowlist here: the same rules file that leaves a child native
      // gives this parent the Code route, and its RPC UI can confirm.
      const lane = await workspace.lane("parent-rpc", [
        {
          tool: { name: "exec", arguments: { code: patchProgram("approve") } },
        },
        { text: "approve turn done" },
        { tool: { name: "exec", arguments: { code: patchProgram("deny") } } },
        { text: "deny turn done" },
        { tool: { name: "exec", arguments: { code: patchProgram("cancel") } } },
        { text: "cancel turn done" },
      ]);
      const session = await startRpcSession({
        workspace,
        env: lane.env,
        model: "pct-offline/gpt-6-astra",
        budgetMs: CHILD_BUDGET_MS,
      });
      let run;
      try {
        for (const answer of ["approve", "deny", "cancel"] as const) {
          session.answerConfirm(answer);
          await session.prompt(`Run the ${answer} program.`);
        }
      } finally {
        run = await session.close();
      }
      expect(run.code).toBe(0);

      const receipts = await lane.read();
      const records = diagnostics(receipts);
      expect(records[0]).toMatchObject({
        model: { provider: "pct-offline", id: "gpt-6-astra" },
        source: "rules",
        ruleId: "astra",
        requested: { patch: true, shell: false, code: true },
        effective: {
          directPatch: false,
          nestedPatch: true,
          directShell: false,
          code: true,
        },
        admittedNames: [...TOOLKIT_EXECUTION_NAMES],
        // Code is the only top-level route; its backends stay nested-only.
        visibleNames: ["exec", "wait"],
        nestedNames: ["apply_patch", "exec_command", "write_stdin"],
        hiddenNatives: ["bash", "edit", "write"],
        notes: [],
        approvalTransport: "dialog",
        cleanupPending: false,
      });
      const scripted = turns(receipts);
      // Three prompts, each one cell and one closing turn: no cell ran twice.
      expect(scripted).toHaveLength(6);
      expect(scripted[0]?.tools).toContain("exec");
      expect(scripted[0]?.tools).toContain("wait");
      expect(scripted[0]?.tools).not.toContain("bash");
      expect(scripted[0]?.tools).not.toContain("apply_patch");
      // An active Code route documents its nested entries inside `exec`.
      expect(scripted[0]?.guidance).toEqual([
        "apply_patch",
        "exec_command",
        "write_stdin",
      ]);

      // One confirmation per actual nested mutation, and only the approved
      // one changed the working tree.
      expect(session.confirmations).toHaveLength(3);
      expect(
        await readFile(join(workspace.project, "approve.txt"), "utf8"),
      ).toBe("approved\n");
      expect(await exists(join(workspace.project, "deny.txt"))).toBe(false);
      expect(await exists(join(workspace.project, "cancel.txt"))).toBe(false);
      expect(scripted[1]?.result?.text).toContain("approve.txt");
      expect(scripted[3]?.result?.text).toContain("not approved");
      expect(scripted[5]?.result?.text).toContain("not approved");

      // No lane rewrites the saved approval mode to skip the dialog.
      expect(await readFile(workspace.configPath, "utf8")).toBe(configBefore);
    },
    LANE_BUDGET_MS,
  );

  it(
    "reports an unavailable approval transport in a headless child",
    async () => {
      const lane = await workspace.lane("headless-json", [
        {
          tool: { name: "exec", arguments: { code: patchProgram("headless") } },
        },
        { text: "headless turn done" },
      ]);
      const run = await runJsonChild({
        workspace,
        env: lane.env,
        model: "pct-offline/gpt-6-astra",
        prompt: "Run the headless program.",
        budgetMs: CHILD_BUDGET_MS,
      });
      expect(run.code).toBe(0);

      const receipts = await lane.read();
      expect(diagnostics(receipts)[0]).toMatchObject({
        effective: { nestedPatch: true, code: true },
        visibleNames: ["exec", "wait"],
        // Same routes as the RPC parent; only the approval path differs.
        approvalTransport: "unavailable",
      });
      const scripted = turns(receipts);
      expect(scripted).toHaveLength(2);
      expect(scripted[1]?.result?.toolName).toBe("exec");
      // The cell itself ran: it reports its own id and one nested call refused
      // before dispatch, not a pre-dispatch refusal of the whole program.
      expect(scripted[1]?.result?.text).toMatch(/^cell_id \S+: failed/u);
      expect(scripted[1]?.result?.text).toContain(
        "1 cancelled before dispatch",
      );
      expect(scripted[1]?.result?.text).toContain("no dialog-capable UI");
      // The mutation never ran and was never retried through another route.
      expect(await exists(join(workspace.project, "headless.txt"))).toBe(false);
      expect(await readFile(workspace.configPath, "utf8")).toBe(configBefore);
    },
    LANE_BUDGET_MS,
  );

  it(
    "gives a Grok parent the direct Shell and Patch entries instead",
    async () => {
      // The same rules file, a different model: direct routes need no dialog,
      // so this headless parent runs both without an extra approval.
      const lane = await workspace.lane("parent-grok", [
        {
          tool: {
            name: "exec_command",
            // Codex spellings, and a zero yield so the start establishes the
            // spawn and the continuation below does the observing.
            arguments: {
              cmd: "printf pct-direct-shell-ok",
              yield_time_ms: 0,
            },
          },
        },
        // A first observation may end before the job settles; the model is
        // told to continue with write_stdin, and this lane does.
        { pollShell: true },
        {
          tool: {
            name: "apply_patch",
            arguments: { patch: patchEnvelope("grok") },
          },
        },
        { text: "grok parent done" },
      ]);
      const run = await runJsonChild({
        workspace,
        env: lane.env,
        model: "pct-offline/grok-4.6",
        prompt: "Run one command, then apply one patch.",
        budgetMs: CHILD_BUDGET_MS,
      });
      expect(run.code).toBe(0);

      const receipts = await lane.read();
      expect(diagnostics(receipts)[0]).toMatchObject({
        model: { provider: "pct-offline", id: "grok-4.6" },
        ruleId: "grok",
        requested: { patch: true, shell: true, code: false },
        effective: {
          directPatch: true,
          nestedPatch: false,
          directShell: true,
          code: false,
        },
        visibleNames: ["apply_patch", "exec_command", "write_stdin"],
        nestedNames: [],
        hiddenNatives: ["bash", "edit", "write"],
        notes: [],
        approvalTransport: "unavailable",
      });
      const scripted = turns(receipts);
      expect(scripted[0]?.tools).toEqual([
        "apply_patch",
        "exec_command",
        "read",
        "write_stdin",
      ]);
      // The command really ran. The zero yield normally splits this across the
      // start and one continuation; a job that settles during spawn
      // establishment reports everything at once, and the script's poll entry
      // is skipped. Either way the last observation is the terminal one.
      const shellResults = scripted
        .map((entry) => entry.result)
        .filter(
          (result) =>
            result?.toolName === "exec_command" ||
            result?.toolName === "write_stdin",
        );
      expect(shellResults.length).toBeGreaterThanOrEqual(1);
      expect(shellResults.some((result) => result?.isError)).toBe(false);
      expect(shellResults.map((result) => result?.text).join("\n")).toContain(
        "pct-direct-shell-ok",
      );
      expect(shellResults.at(-1)?.text).toContain("exit_code: 0");
      const patched = scripted.find(
        (entry) => entry.result?.toolName === "apply_patch",
      );
      expect(patched?.result?.isError).toBe(false);
      expect(await readFile(join(workspace.project, "grok.txt"), "utf8")).toBe(
        "grok\n",
      );
    },
    LANE_BUDGET_MS,
  );
});

/** The Codex envelope adding `<name>.txt` with one line of content. */
function patchEnvelope(name: string): string {
  return [
    "*** Begin Patch",
    `*** Add File: ${name}.txt`,
    `+${name === "approve" ? "approved" : name}`,
    "*** End Patch",
  ].join("\n");
}

/**
 * A cell whose only effect is one nested Apply Patch adding `<name>.txt`. The
 * first-line pragma widens this observation so a loaded machine reports the
 * cell's outcome in the same call instead of yielding a cell id; it bounds the
 * observation, not the program.
 */
function patchProgram(name: string): string {
  return [
    `// @exec: {"yield_time_ms": ${CELL_YIELD_MS}}`,
    `return await tools.apply_patch(${JSON.stringify(patchEnvelope(name))});`,
  ].join("\n");
}
