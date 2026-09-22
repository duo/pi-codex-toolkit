import { expect, vi } from "vitest";

import {
  CODE_MODE_TERMINATION_WAIT_MS,
  type CodeModeCellManager,
} from "../../src/code-mode/manager.ts";
import { INNER_BUDGET_MS } from "./budgets.ts";

// Tests shorten a manager's stop-confirmation window so that deliberately refused
// stops stay fast. A real worker exit can outlast such a window under CPU
// contention, so a stop whose confirmation a test asserts gets the product's own
// window back first. Instance seam only; close and wait run intact.
export function restoreStopConfirmationWindow(
  manager: CodeModeCellManager,
): void {
  (manager as unknown as { terminationWaitMs: number }).terminationWaitMs =
    CODE_MODE_TERMINATION_WAIT_MS;
}

// A stop issued under a short window may be confirmed only after the call that
// issued it returned. Wait until the manager has recorded the exit (terminal),
// without observing, delivering or stopping the cell.
export async function exitRecorded(
  manager: CodeModeCellManager,
  cellId: string,
): Promise<void> {
  const cells = (
    manager as unknown as { cells: Map<string, { terminal: boolean }> }
  ).cells;
  await vi.waitFor(() => expect(cells.get(cellId)?.terminal).toBe(true), {
    timeout: INNER_BUDGET_MS,
    interval: 5,
  });
}
