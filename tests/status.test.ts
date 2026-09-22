import { describe, expect, it } from "vitest";

import type { ExecutionNote } from "../src/execution-mode.ts";
import {
  formatStatus,
  projectStatus,
  selectCodeModeStatus,
  selectComputerUseStatus,
  selectImageGenerationStatus,
  selectRemoteCompactionStatus,
  selectShellSessionsStatus,
  selectToolDiscoveryStatus,
  selectWebSearchBackend,
} from "../src/status.ts";
import {
  codeModeContractCases,
  computerUseContractCases,
  formatContractCases,
  imageGenerationContractCases,
  projectionBase,
  projectionContractCases,
  remoteCompactionContractCases,
  shellSessionsContractCases,
  toolDiscoveryContractCases,
  webSearchContractCases,
} from "./fixtures/status-contract-cases.ts";

describe("Web Search backend selection", () => {
  it.each(webSearchContractCases)("$name", ({ input, expected }) => {
    expect(selectWebSearchBackend(...input)).toEqual(expected);
  });
});

describe("Computer Use eligibility without probing", () => {
  it.each(computerUseContractCases)("$name", ({ input, expected }) => {
    expect(selectComputerUseStatus(...input)).toEqual(expected);
  });
});

describe("Image Generation structural state", () => {
  it.each(imageGenerationContractCases)("$name", ({ input, expected }) => {
    expect(selectImageGenerationStatus(...input)).toEqual(expected);
  });
});

describe("Remote Compaction structural state without resolving auth", () => {
  it.each(remoteCompactionContractCases)("$name", ({ input, expected }) => {
    expect(selectRemoteCompactionStatus(...input)).toEqual(expected);
  });
});

describe("Shell Sessions availability and ownership", () => {
  it.each(shellSessionsContractCases)("$name", ({ input, expected }) => {
    expect(selectShellSessionsStatus(...input)).toEqual(expected);
  });
});

describe("Code Mode ownership", () => {
  it.each(codeModeContractCases)("$name", ({ input, expected }) => {
    expect(selectCodeModeStatus(...input)).toEqual(expected);
  });
});

describe("Tool Discovery ownership", () => {
  it.each(toolDiscoveryContractCases)("$name", ({ input, expected }) => {
    expect(selectToolDiscoveryStatus(...input)).toEqual(expected);
  });
});

describe("complete status projection", () => {
  it.each(projectionContractCases)("$name", ({ input, expected }) => {
    expect(projectStatus(input)).toEqual(expected);
  });
});

describe("complete status formatting", () => {
  it.each(formatContractCases)("$name", ({ input, expected }) => {
    expect(formatStatus(input)).toBe(expected);
  });
});

type CapabilityRow = "applyPatch" | "shellSessions" | "codeMode";
const CAPABILITY_ROWS: readonly CapabilityRow[] = [
  "applyPatch",
  "shellSessions",
  "codeMode",
];

/**
 * Closed union across the two layers: a new `ExecutionNote` fails to compile
 * until it names the row that reports it, and each entry is then checked
 * through the real projection.
 */
const ROUTE_NOTE_ROWS: Record<ExecutionNote, CapabilityRow> = {
  "patch-unavailable": "applyPatch",
  "patch-unavailable-kept-native-editing": "applyPatch",
  "code-unavailable-did-not-promote-patch": "applyPatch",
  "shell-pair-unavailable": "shellSessions",
  "code-pair-unavailable": "codeMode",
  "code-shell-pair-unavailable": "codeMode",
};

describe("route notes reach exactly one capability row", () => {
  it.each(
    Object.entries(ROUTE_NOTE_ROWS) as Array<[ExecutionNote, CapabilityRow]>,
  )("%s is reported by the %s row alone", (note, row) => {
    const status = projectStatus({
      ...projectionBase,
      config: {
        ...projectionBase.config,
        execution: {
          version: 1,
          rules: [
            { id: "r", match: "*", patch: true, shell: true, code: true },
          ],
        },
      },
      executionRoutes: {
        requested: {
          patch: true,
          shell: true,
          code: true,
          source: "rules",
          ruleId: "r",
        },
        directPatch: false,
        nestedPatch: false,
        directShell: false,
        code: false,
        needsShellBackend: false,
        hideBash: false,
        hideEditWrite: false,
        notes: [note],
      },
    });

    expect(CAPABILITY_ROWS.map((name) => status[name].reason)).toEqual(
      CAPABILITY_ROWS.map((name) => (name === row ? note : "")),
    );
  });
});
