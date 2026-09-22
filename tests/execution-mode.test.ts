import { describe, expect, it } from "vitest";

import {
  firstMatchingRule,
  appendExecutionStatus,
  formatEffectiveRoutes,
  formatExecutionStatus,
  formatRequestedFlags,
  isEagerReplacement,
  isNestedOnlyName,
  matchExecutionPattern,
  previewLegacyMigration,
  requestCapabilities,
  resolveExecutionRoutes,
  resolveLegacyRoutes,
  type ExecutionAdmission,
  type ExecutionRule,
  type RequestedCapabilities,
} from "../src/execution-mode.ts";

const ALL_ADMITTED: ExecutionAdmission = {
  patchOwnedAdmitted: true,
  shellPairAdmitted: true,
  codePairAdmitted: true,
};

const NONE_ADMITTED: ExecutionAdmission = {
  patchOwnedAdmitted: false,
  shellPairAdmitted: false,
  codePairAdmitted: false,
};

function requested(
  flags: Partial<RequestedCapabilities> &
    Pick<RequestedCapabilities, "patch" | "shell" | "code">,
): RequestedCapabilities {
  return { source: "rules", ruleId: "r", ...flags };
}

describe("matchExecutionPattern", () => {
  it("matches modelId when the pattern has no slash", () => {
    expect(
      matchExecutionPattern("gpt-6-astra", {
        provider: "openai-codex",
        id: "gpt-6-astra",
      }),
    ).toBe(true);
    expect(
      matchExecutionPattern("gpt-6-astra", {
        provider: "openai-codex",
        id: "gpt-6-astra-mini",
      }),
    ).toBe(false);
  });

  it("matches provider/modelId only when the pattern contains a slash", () => {
    expect(
      matchExecutionPattern("openai-codex/gpt-6-astra", {
        provider: "openai-codex",
        id: "gpt-6-astra",
      }),
    ).toBe(true);
    expect(
      matchExecutionPattern("openai-codex/gpt-6-astra", {
        provider: "openai",
        id: "gpt-6-astra",
      }),
    ).toBe(false);
    expect(
      matchExecutionPattern("openai-codex/gpt-6-astra", {
        id: "openai-codex/gpt-6-astra",
      }),
    ).toBe(false);
  });

  it("treats * and ? as glob metacharacters and other characters as literal", () => {
    expect(
      matchExecutionPattern("grok*", { provider: "xai", id: "grok-4.6" }),
    ).toBe(true);
    expect(
      matchExecutionPattern("grok*", { provider: "cpa", id: "grok-4.6" }),
    ).toBe(true);
    expect(matchExecutionPattern("g?ok-4.6", { id: "grok-4.6" })).toBe(true);
    expect(matchExecutionPattern("grok-4.6", { id: "grok-4.6" })).toBe(true);
    expect(matchExecutionPattern("grok-4.6", { id: "Grok-4.6" })).toBe(false);
    expect(matchExecutionPattern("grok[0-9]*", { id: "grok4" })).toBe(false);
    expect(matchExecutionPattern("grok[0-9]*", { id: "grok[0-9]x" })).toBe(
      true,
    );
  });

  it("does not match a slash pattern without a provider", () => {
    expect(matchExecutionPattern("xai/grok-4.6", { id: "grok-4.6" })).toBe(
      false,
    );
  });
});

describe("firstMatchingRule", () => {
  const rules: ExecutionRule[] = [
    {
      id: "astra",
      match: "gpt-6-astra",
      patch: true,
      shell: false,
      code: true,
    },
    { id: "grok", match: "grok*", patch: true, shell: true, code: false },
    { id: "all-off", match: "*", patch: false, shell: false, code: false },
  ];

  it("returns the first match, including an all-false stopper", () => {
    expect(firstMatchingRule(rules, { id: "gpt-6-astra" })?.id).toBe("astra");
    expect(firstMatchingRule(rules, { id: "grok-4.6" })?.id).toBe("grok");
    expect(firstMatchingRule(rules, { id: "deepseek-chat" })?.id).toBe(
      "all-off",
    );
  });
});

describe("requestCapabilities", () => {
  const legacy = { patch: true, shell: true, code: false };

  it("uses legacy flags when the execution section is absent", () => {
    expect(
      requestCapabilities({
        legacy,
        model: { provider: "xai", id: "grok-4.6" },
      }),
    ).toEqual({
      patch: true,
      shell: true,
      code: false,
      source: "legacy",
    });
  });

  it("ignores legacy flags when rules are present", () => {
    expect(
      requestCapabilities({
        execution: {
          version: 1,
          rules: [
            {
              id: "astra",
              match: "gpt-6-astra",
              patch: true,
              shell: false,
              code: true,
            },
          ],
        },
        legacy,
        model: { provider: "openai-codex", id: "gpt-6-astra" },
      }),
    ).toEqual({
      patch: true,
      shell: false,
      code: true,
      source: "rules",
      ruleId: "astra",
    });
  });

  it("returns unmatched native baseline when the model is missing or no rule hits", () => {
    const execution = {
      version: 1 as const,
      rules: [
        {
          id: "astra",
          match: "gpt-6-astra",
          patch: true,
          shell: false,
          code: true,
        },
      ],
    };
    expect(requestCapabilities({ execution, legacy, model: {} })).toEqual({
      patch: false,
      shell: false,
      code: false,
      source: "unmatched",
    });
    expect(
      requestCapabilities({
        execution,
        legacy,
        model: { id: "deepseek-chat" },
      }),
    ).toEqual({
      patch: false,
      shell: false,
      code: false,
      source: "unmatched",
    });
  });
});

describe("resolveExecutionRoutes", () => {
  it.each([
    {
      name: "none",
      flags: { patch: false, shell: false, code: false },
      expected: {
        directPatch: false,
        nestedPatch: false,
        directShell: false,
        code: false,
        hideBash: false,
        hideEditWrite: false,
      },
    },
    {
      name: "P",
      flags: { patch: true, shell: false, code: false },
      expected: {
        directPatch: true,
        nestedPatch: false,
        directShell: false,
        code: false,
        hideBash: false,
        hideEditWrite: true,
      },
    },
    {
      name: "S",
      flags: { patch: false, shell: true, code: false },
      expected: {
        directPatch: false,
        nestedPatch: false,
        directShell: true,
        code: false,
        hideBash: true,
        hideEditWrite: false,
      },
    },
    {
      name: "P+S",
      flags: { patch: true, shell: true, code: false },
      expected: {
        directPatch: true,
        nestedPatch: false,
        directShell: true,
        code: false,
        hideBash: true,
        hideEditWrite: true,
      },
    },
    {
      name: "C",
      flags: { patch: false, shell: false, code: true },
      expected: {
        directPatch: false,
        nestedPatch: false,
        directShell: false,
        code: true,
        hideBash: true,
        hideEditWrite: false,
      },
    },
    {
      name: "P+C",
      flags: { patch: true, shell: false, code: true },
      expected: {
        directPatch: false,
        nestedPatch: true,
        directShell: false,
        code: true,
        hideBash: true,
        hideEditWrite: true,
      },
    },
    {
      name: "S+C",
      flags: { patch: false, shell: true, code: true },
      expected: {
        directPatch: false,
        nestedPatch: false,
        directShell: true,
        code: true,
        hideBash: true,
        hideEditWrite: false,
      },
    },
    {
      name: "P+S+C",
      flags: { patch: true, shell: true, code: true },
      expected: {
        directPatch: false,
        nestedPatch: true,
        directShell: true,
        code: true,
        hideBash: true,
        hideEditWrite: true,
      },
    },
  ] as const)("fully admitted $name", ({ flags, expected }) => {
    const routes = resolveExecutionRoutes(requested(flags), ALL_ADMITTED);
    expect(routes).toMatchObject({
      ...expected,
      needsShellBackend: expected.directShell || expected.code,
      notes: [],
    });
  });

  it("keeps direct Shell plus native editing when Patch is missing from P+S", () => {
    const routes = resolveExecutionRoutes(
      requested({ patch: true, shell: true, code: false }),
      {
        ...ALL_ADMITTED,
        patchOwnedAdmitted: false,
      },
    );
    expect(routes.directShell).toBe(true);
    expect(routes.directPatch).toBe(false);
    expect(routes.hideEditWrite).toBe(false);
    expect(routes.hideBash).toBe(true);
    expect(routes.notes).toEqual(["patch-unavailable"]);
  });

  it("keeps Code plus native editing when Patch is missing from P+C", () => {
    const routes = resolveExecutionRoutes(
      requested({ patch: true, shell: false, code: true }),
      {
        ...ALL_ADMITTED,
        patchOwnedAdmitted: false,
      },
    );
    expect(routes.code).toBe(true);
    expect(routes.nestedPatch).toBe(false);
    expect(routes.directPatch).toBe(false);
    expect(routes.hideEditWrite).toBe(false);
    expect(routes.notes).toEqual(["patch-unavailable-kept-native-editing"]);
  });

  it("does not promote Patch when requested Code is unavailable", () => {
    const routes = resolveExecutionRoutes(
      requested({ patch: true, shell: false, code: true }),
      {
        ...ALL_ADMITTED,
        codePairAdmitted: false,
      },
    );
    expect(routes.code).toBe(false);
    expect(routes.directPatch).toBe(false);
    expect(routes.nestedPatch).toBe(false);
    expect(routes.hideBash).toBe(false);
    expect(routes.hideEditWrite).toBe(false);
    expect(routes.notes).toEqual([
      "code-pair-unavailable",
      "code-unavailable-did-not-promote-patch",
    ]);
  });

  it("keeps explicitly requested direct Shell when Code is unavailable in P+S+C", () => {
    const routes = resolveExecutionRoutes(
      requested({ patch: true, shell: true, code: true }),
      {
        ...ALL_ADMITTED,
        codePairAdmitted: false,
      },
    );
    expect(routes.directShell).toBe(true);
    expect(routes.code).toBe(false);
    expect(routes.directPatch).toBe(false);
    expect(routes.hideEditWrite).toBe(false);
    expect(routes.hideBash).toBe(true);
    expect(routes.notes).toEqual([
      "code-pair-unavailable",
      "code-unavailable-did-not-promote-patch",
    ]);
  });

  it("does not turn Code-only into direct Shell", () => {
    const routes = resolveExecutionRoutes(
      requested({ patch: false, shell: false, code: true }),
      {
        ...ALL_ADMITTED,
        codePairAdmitted: false,
      },
    );
    expect(routes.directShell).toBe(false);
    expect(routes.code).toBe(false);
    expect(routes.needsShellBackend).toBe(false);
    expect(routes.notes).toEqual(["code-pair-unavailable"]);
  });

  // The two dependencies fail the same route; the note names which one is
  // missing so status does not blame the owned exec/wait pair for a missing
  // nested Shell pair.
  it("fails Code with its own note when the nested Shell pair is missing", () => {
    const routes = resolveExecutionRoutes(
      requested({ patch: false, shell: false, code: true }),
      { ...ALL_ADMITTED, shellPairAdmitted: false },
    );
    expect(routes.code).toBe(false);
    expect(routes.needsShellBackend).toBe(false);
    expect(routes.notes).toEqual(["code-shell-pair-unavailable"]);
  });

  it("reports the missing exec/wait pair even when the Shell pair is also gone", () => {
    const routes = resolveExecutionRoutes(
      requested({ patch: false, shell: false, code: true }),
      { ...ALL_ADMITTED, codePairAdmitted: false, shellPairAdmitted: false },
    );
    expect(routes.code).toBe(false);
    expect(routes.notes).toEqual(["code-pair-unavailable"]);
  });

  it("separates a requested direct Shell failure from the Code dependency", () => {
    const routes = resolveExecutionRoutes(
      requested({ patch: false, shell: true, code: true }),
      { ...ALL_ADMITTED, shellPairAdmitted: false },
    );
    expect(routes.directShell).toBe(false);
    expect(routes.code).toBe(false);
    expect(routes.notes).toEqual([
      "shell-pair-unavailable",
      "code-shell-pair-unavailable",
    ]);
  });

  it("does not invent routes from an empty admission", () => {
    const routes = resolveExecutionRoutes(
      requested({ patch: true, shell: true, code: true }),
      NONE_ADMITTED,
    );
    expect(routes.directPatch).toBe(false);
    expect(routes.nestedPatch).toBe(false);
    expect(routes.directShell).toBe(false);
    expect(routes.code).toBe(false);
    expect(routes.hideBash).toBe(false);
    expect(routes.hideEditWrite).toBe(false);
  });
});

describe("resolveLegacyRoutes", () => {
  it("keeps additive tools and does not hide natives or start nested Shell for Code-only", () => {
    const routes = resolveLegacyRoutes(
      requested({ patch: true, shell: false, code: true }),
      ALL_ADMITTED,
    );
    expect(routes.directPatch).toBe(true);
    expect(routes.nestedPatch).toBe(true);
    expect(routes.code).toBe(true);
    expect(routes.directShell).toBe(false);
    expect(routes.needsShellBackend).toBe(false);
    expect(routes.hideBash).toBe(false);
    expect(routes.hideEditWrite).toBe(false);
  });
});

describe("previewLegacyMigration", () => {
  it("emits no rules for all-off flags", () => {
    expect(
      previewLegacyMigration({ patch: false, shell: false, code: false }),
    ).toEqual([]);
  });

  it("emits a catch-all rule and shows Code-only implying nested Shell after migration", () => {
    const rules = previewLegacyMigration({
      patch: false,
      shell: false,
      code: true,
    });
    expect(rules).toEqual([
      { id: "migrated", match: "*", patch: false, shell: false, code: true },
    ]);
    const routes = resolveExecutionRoutes(
      requested({ patch: false, shell: false, code: true }),
      ALL_ADMITTED,
    );
    expect(routes.needsShellBackend).toBe(true);
    expect(routes.directShell).toBe(false);
  });
});

describe("eager replacement and nested-only names", () => {
  it("marks direct Patch and Shell/Code pairs eager while they replace natives", () => {
    const patchAndShell = resolveExecutionRoutes(
      requested({ patch: true, shell: true, code: false }),
      ALL_ADMITTED,
    );
    expect(isEagerReplacement("apply_patch", patchAndShell)).toBe(true);
    expect(isEagerReplacement("exec_command", patchAndShell)).toBe(true);
    expect(isEagerReplacement("write_stdin", patchAndShell)).toBe(true);

    const codeOnly = resolveExecutionRoutes(
      requested({ patch: false, shell: false, code: true }),
      ALL_ADMITTED,
    );
    expect(isEagerReplacement("exec", codeOnly)).toBe(true);
    expect(isEagerReplacement("wait", codeOnly)).toBe(true);
    expect(isEagerReplacement("exec_command", codeOnly)).toBe(false);
    expect(isNestedOnlyName("exec_command", codeOnly)).toBe(true);
    expect(isNestedOnlyName("write_stdin", codeOnly)).toBe(true);

    const patchAndCode = resolveExecutionRoutes(
      requested({ patch: true, shell: false, code: true }),
      ALL_ADMITTED,
    );
    expect(isNestedOnlyName("apply_patch", patchAndCode)).toBe(true);
    expect(isEagerReplacement("apply_patch", patchAndCode)).toBe(false);
  });
});

describe("format helpers", () => {
  it("renders requested flags and effective routes", () => {
    expect(
      formatRequestedFlags(
        requested({ patch: true, shell: false, code: true }),
      ),
    ).toBe("P+C");
    expect(
      formatRequestedFlags(
        requested({ patch: false, shell: false, code: false }),
      ),
    ).toBe("none");
    expect(
      formatEffectiveRoutes(
        resolveExecutionRoutes(
          requested({ patch: true, shell: false, code: false }),
          ALL_ADMITTED,
        ),
      ),
    ).toBe("directPatch");
    expect(
      formatEffectiveRoutes(
        resolveExecutionRoutes(
          requested({ patch: false, shell: true, code: false }),
          ALL_ADMITTED,
        ),
      ),
    ).toBe("directShell");
    const routes = resolveExecutionRoutes(
      requested({ patch: true, shell: false, code: true }),
      ALL_ADMITTED,
    );
    expect(formatEffectiveRoutes(routes)).toBe("nestedPatch+code");
    expect(formatExecutionStatus(routes)).toContain("requested: P+C");
    expect(
      appendExecutionStatus("Current API: openai-responses", routes),
    ).toContain("Execution rules:");
    expect(
      appendExecutionStatus("no api line", routes).startsWith("no api line\n"),
    ).toBe(true);
  });

  it("prints the requested-capability source instead of a fixed schema", () => {
    expect(
      formatExecutionStatus(
        resolveExecutionRoutes(
          requested({ patch: true, shell: false, code: true }),
          ALL_ADMITTED,
        ),
      ),
    ).toBe(
      [
        "Execution rules:",
        "  schema: rules",
        "  rule: r",
        "  requested: P+C",
        "  effective: nestedPatch+code",
        "  hide bash: yes",
        "  hide edit/write: yes",
        "  notes: ",
      ].join("\n"),
    );
    expect(
      formatExecutionStatus(
        resolveLegacyRoutes(
          { patch: true, shell: false, code: false, source: "legacy" },
          ALL_ADMITTED,
        ),
      ),
    ).toBe(
      [
        "Execution rules:",
        "  schema: legacy",
        "  rule: —",
        "  requested: P",
        "  effective: directPatch",
        "  hide bash: no",
        "  hide edit/write: no",
        "  notes: ",
      ].join("\n"),
    );
    expect(
      formatExecutionStatus(
        resolveExecutionRoutes(
          { patch: false, shell: false, code: false, source: "unmatched" },
          ALL_ADMITTED,
        ),
      ),
    ).toBe(
      [
        "Execution rules:",
        "  schema: unmatched",
        "  rule: —",
        "  requested: none",
        "  effective: native",
        "  hide bash: no",
        "  hide edit/write: no",
        "  notes: ",
      ].join("\n"),
    );
  });
});
