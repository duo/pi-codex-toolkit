import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, it } from "vitest";

import { outerBudget } from "./fixtures/budgets.ts";

// Each probe is a real Pi process running offline agent turns, so its duration
// scales with CPU contention far beyond the idle figure.
const PROBE_TIMEOUT_MS = 150_000;

async function probe(args: string[] = []) {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      resolve("tests/fixtures/code-mode-host-turn.mjs"),
      resolve("node_modules/@earendil-works/pi-coding-agent"),
      ...args,
    ],
    {
      env: { ...process.env, PI_OFFLINE: "1" },
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 128 * 1024,
    },
  );
  expect(stderr.trim()).toBe("Pi Codex Toolkit configuration reloaded.");
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

it(
  "qualifies real offline agent turns through the repository Pi public loader",
  async () => {
    const report = await probe();
    expect(report).toMatchObject({
      verdict: "pass",
      rootIdentityChecks: 2,
      networkAttempts: 0,
    });
    expect(report.deliveredPatches).toBeGreaterThanOrEqual(8);
  },
  outerBudget(PROBE_TIMEOUT_MS),
);

// A real Pi process importing the public SDK for one offline turn. Its slowest
// run in three contention checks (36 runs) took 8.3 s.
const BATCH_PROBE_TIMEOUT_MS = 30_000;

// Shell and Code Mode leave `executionMode` absent, and cancelling one direct
// observer alone is treated as unreachable, because Pi gives every call in one
// batch the same run signal. Pin that host assumption, not Toolkit behaviour.
it(
  "pins the host assumption that one Pi batch shares one AbortSignal across its calls",
  async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        resolve("tests/fixtures/pi-batch-signal.mjs"),
        resolve("node_modules/@earendil-works/pi-coding-agent"),
      ],
      {
        env: { ...process.env, PI_OFFLINE: "1" },
        timeout: BATCH_PROBE_TIMEOUT_MS,
        maxBuffer: 128 * 1024,
      },
    );
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      verdict: "pass",
      calls: 2,
      abortSignals: true,
      sameSignal: true,
      overlapping: true,
      endedByRunAbort: 2,
      providerCalls: 1,
      extensionErrors: 0,
      networkAttempts: 0,
      hostVersion: JSON.parse(
        readFileSync(
          resolve("node_modules/@earendil-works/pi-coding-agent/package.json"),
          "utf8",
        ),
      ).version,
      node: process.version,
    });
  },
  outerBudget(BATCH_PROBE_TIMEOUT_MS),
);

it.skipIf(process.platform === "win32")(
  "cancels real session replacement after failed cleanup and keeps controls usable",
  async () => {
    const report = await probe(["--shutdown-failure"]);
    expect(report).toMatchObject({
      verdict: "pass",
      rootIdentityChecks: 3,
      networkAttempts: 0,
      shutdownFailure: {
        verdict: "pass",
        failedCleanupCancelledReplacement: true,
        oldShellControlledThroughRealAgentTurn: true,
        successfulRetryRemovedFiles: true,
      },
    });
  },
  outerBudget(PROBE_TIMEOUT_MS),
);
