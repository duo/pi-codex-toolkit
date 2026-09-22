import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../src/config.ts";
import { formatStatus, projectStatus } from "../src/status.ts";
import { outerBudget } from "./fixtures/budgets.ts";

const helper = fileURLToPath(
  new URL("./fixtures/assert-default-status.mjs", import.meta.url),
);
const defaultStatus = formatStatus(
  projectStatus({
    config: defaultConfig(),
    configPath: "extensions/pi-codex-toolkit.json",
    decision: { effective: "off" },
    imageGenerationDecision: { effective: "off" },
    computerUseDecision: { effective: "off" },
    remoteCompactionAvailability: { ok: false },
    toolConflict: false,
    imageToolConflict: false,
    applyPatchToolConflict: false,
    computerUseToolConflict: false,
  }),
);
const sections = defaultStatus
  .slice(defaultStatus.indexOf("Web Search:"))
  .split(/\n(?=\S)/u);
/** The fixed classes the gate reports; nothing else may reach stderr. */
type FailureClass =
  | "usage"
  | "unreadable"
  | "encoding"
  | "format"
  | "capability-on"
  | "incomplete";
const failure = (failureClass: FailureClass) =>
  `Default-off status validation failed: ${failureClass}.\n`;
// Each helper run is a blocking child with its own timeout, so a test's budget
// must outlive all of its runs in sequence, not just one. A single run fits the
// default test budget.
const HELPER_TIMEOUT_MS = 10_000;
const PI_PRINT_TIMEOUT_MS = 40_000;
const helperBudget = (runs: number) => outerBudget(runs * HELPER_TIMEOUT_MS);

let directory: string;
let statusFile: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pct-release-status-"));
  statusFile = join(directory, "status.txt");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function run(args = [statusFile]) {
  return spawnSync(process.execPath, [helper, ...args], {
    encoding: "utf8",
    timeout: HELPER_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
}

/** `true` accepts; a class asserts exactly that rejection reason. */
function assertStatus(text: string | Buffer, expected: true | FailureClass) {
  writeFileSync(statusFile, text);
  const result = run();
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(expected === true ? 0 : 1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(expected === true ? "" : failure(expected));
}

describe("release default-off status CLI", () => {
  it("accepts actual pure default status without a model or enabled features", () => {
    assertStatus(defaultStatus, true);
  });

  it("preserves global headings, unrelated metadata, CRLF and trailing newline", () => {
    assertStatus(
      `${defaultStatus}\nDiagnostics:\n  note: unrelated metadata\n`.replaceAll(
        "\n",
        "\r\n",
      ),
      true,
    );
  });

  it("does not require capability ordering", () => {
    assertStatus([...sections].reverse().join("\n"), true);
  });

  it.each([
    {
      label: "historic five blocks",
      text: sections.slice(0, 5).join("\n"),
      failureClass: "incomplete",
    },
    {
      label: "missing capability",
      text: sections.slice(1).join("\n"),
      failureClass: "incomplete",
    },
    {
      label: "duplicated capability",
      text: `${defaultStatus}\n${sections[0]}`,
      failureClass: "format",
    },
    {
      label: "duplicated empty capability",
      text: `${defaultStatus}\nWeb Search:`,
      failureClass: "format",
    },
    {
      label: "unknown extra capability",
      text: `${defaultStatus}\nUnknown Capability:\n  configured: off\n  effective: off`,
      failureClass: "format",
    },
    {
      label: "unknown replacement with unchanged totals",
      text: defaultStatus.replace("Web Search:", "Unknown Capability:"),
      failureClass: "format",
    },
    { label: "empty output", text: "", failureClass: "incomplete" },
  ] as const)("rejects $label as $failureClass", ({ text, failureClass }) => {
    assertStatus(text, failureClass);
  });

  for (const field of ["configured", "effective"]) {
    it.each([
      {
        label: "missing",
        text: defaultStatus.replace(`  ${field}: off\n`, ""),
        failureClass: "incomplete",
      },
      {
        label: "duplicate",
        text: defaultStatus.replace(
          `  ${field}: off`,
          `  ${field}: off\n  ${field}: off`,
        ),
        failureClass: "format",
      },
      {
        label: "duplicate with alternate whitespace",
        text: `${defaultStatus}\n\t${field} : off`,
        failureClass: "format",
      },
      {
        label: "duplicate with embedded carriage return",
        text: `${defaultStatus}\n  ${field}: on\rPRIVATE_STATUS`,
        failureClass: "format",
      },
      {
        // Well formed enough to read, but not the exact two-space record.
        label: "misindented first record",
        text: defaultStatus.replace(`  ${field}: off`, `   ${field}: off`),
        failureClass: "format",
      },
    ] as const)(
      `rejects $label ${field} field as $failureClass`,
      ({ text, failureClass }) => {
        assertStatus(text, failureClass);
      },
    );

    for (const state of ["on", "active", "unavailable", "", "PRIVATE_STATUS"]) {
      it(
        `rejects ${field}=${state || "empty"} in every capability`,
        () => {
          for (let index = 0; index < sections.length; index += 1) {
            const modified = [...sections];
            modified[index] = modified[index]!.replace(
              `  ${field}: off`,
              `  ${field}: ${state}`,
            );
            assertStatus(modified.join("\n"), "capability-on");
          }
        },
        helperBudget(sections.length),
      );
    }

    it.each([
      "Pi Codex Toolkit",
      "Config:",
      "Current model:",
      "Current API:",
      "Config error: PRIVATE_METADATA",
    ])(
      `rejects extra ${field} under global heading %s as format`,
      (heading) => {
        assertStatus(`${defaultStatus}\n${heading}\n  ${field}: off`, "format");
      },
    );
  }

  it("rejects orphan state records before the first capability as format", () => {
    assertStatus(`  configured: off\n${defaultStatus}`, "format");
  });

  it(
    "accepts at most 64 KiB and rejects oversized input",
    () => {
      const prefix = Buffer.from(`${defaultStatus}\n  note: `);
      const bounded = Buffer.concat([
        prefix,
        Buffer.alloc(64 * 1024 - prefix.length, "x"),
      ]);
      assertStatus(bounded, true);
      assertStatus(Buffer.concat([bounded, Buffer.from("x")]), "unreadable");
    },
    helperBudget(2),
  );

  it("rejects invalid UTF-8 as encoding, without echoing input", () => {
    assertStatus(
      Buffer.concat([Buffer.from(defaultStatus), Buffer.from([0xff])]),
      "encoding",
    );
  });

  it(
    "separates unreadable input from invalid arguments, echoing neither",
    () => {
      const cases: Array<{ args: string[]; failureClass: FailureClass }> = [
        { args: [join(directory, "PRIVATE_PATH")], failureClass: "unreadable" },
        { args: [directory], failureClass: "unreadable" },
        { args: [], failureClass: "usage" },
        {
          args: [statusFile, "PRIVATE_ARGUMENT"],
          failureClass: "usage",
        },
      ];
      writeFileSync(statusFile, defaultStatus);
      for (const { args, failureClass } of cases) {
        const result = run(args);
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(failure(failureClass));
      }
    },
    helperBudget(4),
  );

  it(
    "captures real Pi 0.87.0 print status from stderr, not stdout",
    () => {
      const hostManifest = fileURLToPath(
        new URL(
          "../node_modules/@earendil-works/pi-coding-agent/package.json",
          import.meta.url,
        ),
      );
      const host = JSON.parse(readFileSync(hostManifest, "utf8"));
      expect(host.version).toBe("0.87.0");
      // Execute the installed package's declared public bin, not an SDK mock.
      const cli = join(dirname(hostManifest), host.bin.pi);
      const agentDirectory = join(directory, "agent");
      mkdirSync(agentDirectory);
      const args = [
        cli,
        "--no-extensions",
        "--extension",
        fileURLToPath(new URL("../", import.meta.url)),
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--approve",
        "--no-session",
        "--print",
        "/pct status",
      ];
      const options = {
        cwd: directory,
        // Do not inherit credentials, user settings or NODE_OPTIONS from the harness.
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: directory,
          USERPROFILE: directory,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
          PI_CODING_AGENT_DIR: agentDirectory,
          PI_OFFLINE: "1",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        timeout: PI_PRINT_TIMEOUT_MS,
        killSignal: "SIGKILL" as const,
        maxBuffer: 64 * 1024,
        encoding: "utf8" as const,
      };
      const stdoutOnly = spawnSync(process.execPath, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(stdoutOnly.error).toBeUndefined();
      expect(stdoutOnly.signal).toBeNull();
      expect(stdoutOnly.status).toBe(0);
      expect(stdoutOnly.stdout).toBe("");
      expect(stdoutOnly.stderr).toContain("Current model: unknown/unknown\n");
      // Nothing on stdout: no capability block at all.
      assertStatus(stdoutOnly.stdout, "incomplete");
      assertStatus(stdoutOnly.stderr, true);
      expect(
        existsSync(join(agentDirectory, "extensions/pi-codex-toolkit.json")),
      ).toBe(false);
      expect(
        existsSync(join(agentDirectory, "artifacts/pi-codex-toolkit")),
      ).toBe(false);

      // Same file descriptor for both streams is the workflow's > file 2>&1.
      const fd = openSync(statusFile, "w");
      try {
        const combined = spawnSync(process.execPath, args, {
          ...options,
          stdio: ["ignore", fd, fd],
        });
        expect(combined.error).toBeUndefined();
        expect(combined.signal).toBeNull();
        expect(combined.status).toBe(0);
      } finally {
        closeSync(fd);
      }
      assertStatus(readFileSync(statusFile), true);
      expect(
        existsSync(join(agentDirectory, "extensions/pi-codex-toolkit.json")),
      ).toBe(false);
      expect(
        existsSync(join(agentDirectory, "artifacts/pi-codex-toolkit")),
      ).toBe(false);
    },
    // Two real Pi print runs, then three helper runs over what they wrote.
    outerBudget(2 * PI_PRINT_TIMEOUT_MS + 3 * HELPER_TIMEOUT_MS),
  );

  it("wires the same test-source CLI inside the existing two-run workflow loop", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/npm-stage.yml", import.meta.url),
      "utf8",
    );
    const smoke = workflow
      .split("      - name: Verify exact tarball with Pi 0.87.0\n")[1]
      ?.split("\n      - name:")[0];
    expect(smoke).toContain("working-directory: test-source");
    const loop = smoke
      ?.split("for attempt in 1 2; do\n")[1]
      ?.split("\n          done")[0];
    expect(loop).toContain(
      'node tests/fixtures/assert-default-status.mjs "$status_file"',
    );
    expect(loop).toContain(
      `--approve --no-session --print '/pct status' > "$status_file" 2>&1\n`,
    );
    expect(workflow).not.toContain("grep -c '^  configured: off$'");
    expect(workflow).not.toContain("grep -c '^  effective: off$'");
  });
});
