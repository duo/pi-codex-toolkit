import { expect, it } from "vitest";

import {
  CODE_MODE_SETTLE_GRACE_MS,
  CODE_MODE_TERMINATION_WAIT_MS,
  CODE_MODE_YIELD_DEFAULT_MS,
} from "../src/code-mode/manager.ts";
import {
  SHELL_TERMINATION_CONFIRM_MS,
  SHELL_TERMINATION_GRACE_MS,
  SHELL_YIELD_DEFAULT_MS,
} from "../src/shell/manager.ts";
import {
  HOOK_BUDGET_MS,
  INNER_BUDGET_MS,
  TERMINAL_SETTLE_GRACE_MS,
  TEST_BUDGET_MS,
  outerBudget,
} from "./fixtures/budgets.ts";

it("runs under the configured default budget, not vitest's 5 s", ({ task }) => {
  expect(task.timeout).toBe(TEST_BUDGET_MS);
});

it("keeps default product waits inside the default test and hook budgets", () => {
  expect(outerBudget(INNER_BUDGET_MS)).toBe(TEST_BUDGET_MS);
  expect(CODE_MODE_YIELD_DEFAULT_MS).toBeLessThanOrEqual(INNER_BUDGET_MS);
  expect(SHELL_YIELD_DEFAULT_MS).toBeLessThanOrEqual(INNER_BUDGET_MS);
  expect(2 * CODE_MODE_TERMINATION_WAIT_MS).toBeLessThanOrEqual(
    INNER_BUDGET_MS,
  );
  const shellCleanup =
    SHELL_TERMINATION_GRACE_MS + 2 * SHELL_TERMINATION_CONFIRM_MS;
  expect(shellCleanup).toBeLessThanOrEqual(INNER_BUDGET_MS);
  expect(outerBudget(shellCleanup)).toBeLessThanOrEqual(HOOK_BUDGET_MS);
  expect(TERMINAL_SETTLE_GRACE_MS).toBeGreaterThan(CODE_MODE_SETTLE_GRACE_MS);
});
