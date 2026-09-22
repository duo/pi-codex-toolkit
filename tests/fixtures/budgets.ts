// Timeouts nest: a test or hook budget contains the bounds it passes down to a
// child process or a product wait. When a test relies on such a bound to fail
// with its own diagnostic, the bound must end before the test budget does, or
// the run reports a bare timeout instead. Keep at least this margin between them.
export const BUDGET_MARGIN_MS = 5_000;

export function outerBudget(innerMs: number): number {
  return innerMs + BUDGET_MARGIN_MS;
}

// Budgets are about three times the slowest run observed with four copies of the
// suite sharing eight CPUs, in whole 10 s steps. This default covers ordinary
// tests; real processes and hosts pass explicit budgets derived the same way.
export const TEST_BUDGET_MS = 20_000;

/** The longest inner wait a test may pass down under the default budget. */
export const INNER_BUDGET_MS = TEST_BUDGET_MS - BUDGET_MARGIN_MS;

// Hooks close Shell and Code Mode managers. Default Shell cleanup can wait its
// termination grace plus two confirmation windows (15 s) before it reports an
// incomplete cleanup, and the hook must outlive that report.
export const HOOK_BUDGET_MS = outerBudget(15_000);

// Output wakes a Code Mode or Shell observer early, after which it waits only the
// settle grace (50 ms by default) for the program to finish. A test asserting
// that one call reports a terminal state extends the grace rather than racing
// it; the call still returns as soon as the program finishes. Shell does not cap
// the grace by the yield, so only use it where every output-producing read in
// the test ends with the process exiting.
export const TERMINAL_SETTLE_GRACE_MS = INNER_BUDGET_MS;
