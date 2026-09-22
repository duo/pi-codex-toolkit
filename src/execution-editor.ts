import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatRequestedFlags, type ExecutionRule } from "./execution-mode.ts";

function ruleLabel(rule: ExecutionRule, index: number): string {
  const flags = formatRequestedFlags({
    patch: rule.patch,
    shell: rule.shell,
    code: rule.code,
    source: "rules",
    ruleId: rule.id,
  });
  return `${index + 1}. ${rule.id}  ${rule.match}  ${flags}`;
}

async function toggleFlag(
  ctx: ExtensionCommandContext,
  title: string,
  current: boolean,
): Promise<boolean | undefined> {
  const selected = await ctx.ui.select(title, [
    current ? "on" : "off",
    current ? "off" : "on",
  ]);
  if (selected === undefined) return undefined;
  return selected === "on";
}

/**
 * Edit one rule on its own page. Only `Done` keeps the edits: Escape discards
 * this page, so adding a rule and escaping adds nothing and escaping out of an
 * existing rule leaves that rule as it was.
 */
async function editOneRule(
  ctx: ExtensionCommandContext,
  rule: ExecutionRule,
  forbiddenIds: ReadonlySet<string>,
): Promise<ExecutionRule | undefined> {
  const next = { ...rule };
  while (true) {
    const choice = await ctx.ui.select(`Rule ${next.id}`, [
      `id: ${next.id}`,
      `match: ${next.match}`,
      `Patch: ${next.patch ? "on" : "off"}`,
      `direct Shell: ${next.shell ? "on" : "off"}`,
      `Code: ${next.code ? "on" : "off"}`,
      "Done",
    ]);
    if (choice === undefined) return undefined;
    if (choice === "Done") return next;
    if (choice.startsWith("id:")) {
      // Pi 0.87's input dialog neither pre-fills nor renders the
      // placeholder, so the current value travels in the title; an empty
      // submission keeps it.
      const id = await ctx.ui.input(
        `Rule id (current: ${next.id}; leave empty to keep)`,
        next.id,
      );
      const trimmed = id?.trim();
      if (trimmed !== undefined && trimmed !== "") {
        // Reject duplicate ids at the editing boundary so a draft can never
        // reach Save with a collision the file schema would reject anyway.
        if (forbiddenIds.has(trimmed)) {
          ctx.ui.notify(
            `Rule id "${trimmed}" is already used by another rule.`,
            "error",
          );
        } else {
          next.id = trimmed;
        }
      }
    } else if (choice.startsWith("match:")) {
      const match = await ctx.ui.input(
        `Match glob (current: ${next.match}; leave empty to keep; * any run, ? one char, "/" matches provider/model)`,
        next.match,
      );
      if (match !== undefined && match.trim() !== "") next.match = match.trim();
    } else if (choice.startsWith("Patch:")) {
      const value = await toggleFlag(ctx, "Patch", next.patch);
      if (value !== undefined) next.patch = value;
    } else if (choice.startsWith("direct Shell:")) {
      const value = await toggleFlag(ctx, "direct Shell", next.shell);
      if (value !== undefined) next.shell = value;
    } else if (choice.startsWith("Code:")) {
      const value = await toggleFlag(ctx, "Code", next.code);
      if (value !== undefined) next.code = value;
    }
  }
}

function newRuleId(rules: readonly ExecutionRule[]): string {
  const used = new Set(rules.map((rule) => rule.id));
  let index = rules.length + 1;
  while (used.has(`rule-${index}`)) index += 1;
  return `rule-${index}`;
}

export function executionRulesMenuLabel(
  rules: readonly ExecutionRule[],
): string {
  if (rules.length === 0) return "Execution rules: none (native baseline)";
  return `Execution rules: ${rules.length} rule${rules.length === 1 ? "" : "s"}`;
}

/**
 * Edit the ordered rule list. `Back` returns the edited draft; Escape returns
 * `undefined`, discarding this page's changes so the caller keeps the draft it
 * had. Duplicate ids are rejected while editing, never at Save.
 */
export async function editExecutionRules(
  ctx: ExtensionCommandContext,
  draft: ExecutionRule[],
  describeExecutionPreview: (
    rules: readonly ExecutionRule[],
    ctx: ExtensionCommandContext,
  ) => string,
): Promise<ExecutionRule[] | undefined> {
  const rules = draft.map((rule) => ({ ...rule }));
  while (true) {
    const labels = [
      ...rules.map((rule, index) => ruleLabel(rule, index)),
      "Add rule",
      ...(rules.length > 0
        ? ["Delete rule", "Move rule up", "Move rule down"]
        : []),
      "Preview current model",
      "Back",
    ];
    const choice = await ctx.ui.select("Execution rules", labels);
    if (choice === undefined) return undefined;
    if (choice === "Back") return rules;

    const selectedIndex = rules.findIndex(
      (rule, index) => ruleLabel(rule, index) === choice,
    );
    if (selectedIndex >= 0) {
      const edited = await editOneRule(
        ctx,
        rules[selectedIndex]!,
        new Set(
          rules.flatMap((rule, index) =>
            index === selectedIndex ? [] : [rule.id],
          ),
        ),
      );
      if (edited) rules[selectedIndex] = edited;
      continue;
    }
    if (choice === "Add rule") {
      const created = await editOneRule(
        ctx,
        {
          id: newRuleId(rules),
          match: "*",
          patch: false,
          shell: false,
          code: false,
        },
        new Set(rules.map((rule) => rule.id)),
      );
      if (created) rules.push(created);
      continue;
    }
    if (choice === "Delete rule" && rules.length > 0) {
      const picked = await ctx.ui.select(
        "Delete rule",
        rules.map((rule, index) => ruleLabel(rule, index)),
      );
      const index = rules.findIndex((rule, i) => ruleLabel(rule, i) === picked);
      if (index >= 0) rules.splice(index, 1);
      continue;
    }
    if (choice === "Move rule up" && rules.length > 1) {
      const picked = await ctx.ui.select(
        "Move rule up",
        rules.map((rule, index) => ruleLabel(rule, index)),
      );
      const index = rules.findIndex((rule, i) => ruleLabel(rule, i) === picked);
      if (index > 0) {
        const current = rules[index]!;
        rules[index] = rules[index - 1]!;
        rules[index - 1] = current;
      }
      continue;
    }
    if (choice === "Move rule down" && rules.length > 1) {
      const picked = await ctx.ui.select(
        "Move rule down",
        rules.map((rule, index) => ruleLabel(rule, index)),
      );
      const index = rules.findIndex((rule, i) => ruleLabel(rule, i) === picked);
      if (index >= 0 && index < rules.length - 1) {
        const current = rules[index]!;
        rules[index] = rules[index + 1]!;
        rules[index + 1] = current;
      }
      continue;
    }
    if (choice === "Preview current model") {
      const model = ctx.model;
      const identity = model
        ? `${model.provider}/${model.id}`
        : "(no current model)";
      ctx.ui.notify(
        model
          ? `Current model ${identity} →\n${describeExecutionPreview(rules, ctx)}`
          : `Current model ${identity}: no model is selected, so rules cannot be matched.`,
        "info",
      );
      continue;
    }
  }
}
