import assert from "node:assert/strict";
import test from "node:test";
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
  projectionContractCases,
  remoteCompactionContractCases,
  shellSessionsContractCases,
  toolDiscoveryContractCases,
  webSearchContractCases,
} from "./fixtures/status-contract-cases.ts";

// The same literal contracts also run in tests/status.test.ts. This entry is the
// only thing `npm run test:coverage` executes, so its floor counts just the lines
// and branches these literal expected values pin down; Vitest's project coverage
// also counts code that other tests merely run.
for (const { name, input, expected } of webSearchContractCases) {
  test(name, () =>
    assert.deepEqual(selectWebSearchBackend(...input), expected),
  );
}

for (const { name, input, expected } of computerUseContractCases) {
  test(`Computer Use: ${name}`, () =>
    assert.deepEqual(selectComputerUseStatus(...input), expected));
}
for (const { name, input, expected } of imageGenerationContractCases) {
  test(`Image Generation: ${name}`, () =>
    assert.deepEqual(selectImageGenerationStatus(...input), expected));
}
for (const { name, input, expected } of remoteCompactionContractCases) {
  test(`Remote Compaction: ${name}`, () =>
    assert.deepEqual(selectRemoteCompactionStatus(...input), expected));
}
for (const { name, input, expected } of shellSessionsContractCases) {
  test(`Shell Sessions: ${name}`, () =>
    assert.deepEqual(selectShellSessionsStatus(...input), expected));
}
for (const { name, input, expected } of codeModeContractCases) {
  test(`Code Mode: ${name}`, () =>
    assert.deepEqual(selectCodeModeStatus(...input), expected));
}
for (const { name, input, expected } of toolDiscoveryContractCases) {
  test(`Tool Discovery: ${name}`, () =>
    assert.deepEqual(selectToolDiscoveryStatus(...input), expected));
}
for (const { name, input, expected } of projectionContractCases) {
  test(`projection: ${name}`, () =>
    assert.deepEqual(projectStatus(input), expected));
}
for (const { name, input, expected } of formatContractCases) {
  test(`format: ${name}`, () => assert.equal(formatStatus(input), expected));
}

test("the shared oracle retains all 24 original combinations without duplicate rows", () => {
  const matrix = webSearchContractCases.slice(0, 24);
  assert.equal(matrix.length, 24);
  assert.equal(
    new Set(
      matrix.map(({ input: [config, present, native, sidecar] }) =>
        JSON.stringify([config.backend, present, native.ok, sidecar.ok]),
      ),
    ).size,
    24,
  );
  assert.deepEqual(
    [...new Set(matrix.map(({ input }) => input[0].backend))].sort(),
    ["auto", "native", "sidecar"],
  );
});
