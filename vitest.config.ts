import { defineConfig } from "vitest/config";

import { HOOK_BUDGET_MS, TEST_BUDGET_MS } from "./tests/fixtures/budgets.ts";

export default defineConfig({
  test: {
    testTimeout: TEST_BUDGET_MS,
    hookTimeout: HOOK_BUDGET_MS,
    coverage: {
      // Istanbul instruments only modules Vitest transforms. Some tests also load
      // the package through Pi's real loader, and V8 coverage merges those scripts
      // with the transformed ones under the same URLs, corrupting both.
      provider: "istanbul",
      // Naming the sources also reports a file no test loads, at 0%.
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      // Non-regression floors, each a whole percent at least one point below the
      // measured baseline. Files get their own floor only when they sit at least
      // five points below the project. Raise a floor as coverage improves; never
      // lower one to make a change pass. `npm run test:coverage` separately holds
      // `src/status.ts` to coverage by its literal contracts alone.
      thresholds: {
        lines: 94,
        statements: 92,
        functions: 96,
        branches: 87,
        "src/index.ts": { branches: 79 },
        "src/commands.ts": { lines: 88, statements: 84, branches: 81 },
        "src/openai/sidecar-search.ts": { branches: 81 },
        "src/code-mode/adapters.ts": { branches: 82 },
        "src/execution-editor.ts": { branches: 81 },
      },
    },
  },
});
