import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ComputerUseClient as Client,
  ComputerUseRuntime,
} from "../src/computer-use/app-server-client.ts";

const state = vi.hoisted(() => ({
  clients: [] as Client[],
  homes: "",
  log: "",
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
vi.mock("../src/computer-use/app-server-client.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/computer-use/app-server-client.ts")
    >();
  // Only launch inputs are substituted. Startup, RPC, transport failure and
  // close (including the real child and temporary home) are the real ones the
  // owner under test disposes, retries and joins.
  class ComputerUseClient extends actual.ComputerUseClient {
    constructor(
      options: ConstructorParameters<typeof actual.ComputerUseClient>[0],
    ) {
      super({
        ...options,
        appServerArgs: [
          fileURLToPath(
            new URL("./fixtures/fake-app-server.ts", import.meta.url),
          ),
        ],
        temporaryRoot: state.homes,
        environment: { ...process.env, FAKE_APP_SERVER_LOG: state.log },
        pollIntervalMs: 5,
      });
      state.clients.push(this);
    }
  }
  return { ...actual, ComputerUseClient };
});

import { ComputerUseClientError } from "../src/computer-use/app-server-client.ts";
import { ComputerUseLifecycle } from "../src/computer-use/lifecycle.ts";

// Read-only test seam capturing the exact owned resources; no replacement close.
function resources(client: Client) {
  return client as unknown as {
    child: ChildProcessWithoutNullStreams;
    temporaryHome: string;
    resetting?: Promise<void>;
  };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const runtime: ComputerUseRuntime = {
  codexPath: process.execPath,
  nodeReplPath: "/chatgpt/cua_node/bin/node_repl",
  nodePath: "/chatgpt/cua_node/bin/node",
  nodeModulesPath: "/chatgpt/cua_node/lib/node_modules",
  helperPath: "/real-codex-home/computer-use/Codex Computer Use.app",
};
let root: string | undefined;

// The owner is constructed directly: today's index.ts callers cannot reach a
// retained failed disposal, a dedicated probe with a cleanup error, or a
// pending-only cleanup that meets a disposal in flight.
async function harness(): Promise<ComputerUseLifecycle> {
  root = await mkdtemp(join(tmpdir(), "pct-cua-lifecycle-owner-"));
  state.homes = join(root, "homes");
  state.log = join(root, "server.jsonl");
  await mkdir(state.homes);
  return new ComputerUseLifecycle(() => false);
}

async function failRemoval(home: string) {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let enabled = true;
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (typeof path === "string" && path === home && enabled) {
      throw new Error("PROTECTED_REMOVAL");
    }
    return actual.rm(path, options);
  });
  return {
    restore: () => {
      enabled = false;
    },
  };
}

async function blockRemoval(home: string) {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const entered = barrier();
  const released = barrier();
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (typeof path === "string" && path === home) {
      entered.resolve();
      await released.promise;
    }
    return actual.rm(path, options);
  });
  return { entered: entered.promise, release: released.resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rm).mockImplementation(actual.rm);
  try {
    // Rescue is owned before assertions, restores the injected fault, and awaits
    // every client before deleting only this fixture's root.
    const results = await Promise.allSettled(
      state.clients.map((client) => client.close()),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        "owned lifecycle fixture cleanup failed",
      );
    if (root) await actual.rm(root, { recursive: true, force: true });
  } finally {
    state.clients.length = 0;
    root = undefined;
  }
});

describe("Computer Use lifecycle owner", () => {
  it("keeps the exact runtime client whose disposal failed", async () => {
    const lifecycle = await harness();
    const client = lifecycle.getOrCreateRuntime(runtime, "confirm");
    await client.invoke("list_apps", {});
    const home = resources(client).temporaryHome;
    const removal = await failRemoval(home);

    await expect(lifecycle.dispose(client)).rejects.toStrictEqual(
      new ComputerUseClientError("process-exit"),
    );
    expect(client.isClosed).toBe(true);
    expect(client.hasCleanupError).toBe(true);
    await expect(access(home)).resolves.toBeUndefined();

    // Closed is not absent: the slot keeps the exact owner of the failed home,
    // so a later caller retries that cleanup instead of starting beside it.
    expect(lifecycle.getOrCreateRuntime(runtime, "confirm")).toBe(client);
    expect(state.clients).toEqual([client]);

    removal.restore();
    await expect(lifecycle.cleanup(true)).resolves.toBeUndefined();
    expect(client.hasCleanupError).toBe(false);
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
    // Only the confirmed disposal releases the slot.
    const replacement = lifecycle.getOrCreateRuntime(runtime, "confirm");
    expect(replacement).not.toBe(client);
    expect(state.clients).toEqual([client, replacement]);
  });

  it("disposes, rather than retries, a dedicated probe with a cleanup error", async () => {
    const lifecycle = await harness();
    const probe = lifecycle.createProbe(runtime);
    await probe.probeTarget();
    const { child, temporaryHome: home } = resources(probe);
    const removal = await failRemoval(home);

    // A real transport failure whose reset cannot remove the home: the probe
    // stays live and owned, with its cleanup error recorded.
    child.stdout.emit("data", "invalid-json\n");
    await expect(resources(probe).resetting).rejects.toStrictEqual(
      new ComputerUseClientError("process-exit"),
    );
    expect(probe.isClosed).toBe(false);
    expect(probe.hasCleanupError).toBe(true);
    await expect(access(home)).resolves.toBeUndefined();

    removal.restore();
    await expect(lifecycle.cleanup(true)).resolves.toBeUndefined();
    // Retrying cleanup preserves a live client; only the reusable runtime
    // client earns that. A dedicated probe has no second caller: dispose it.
    expect(probe.isClosed).toBe(true);
    expect(probe.hasCleanupError).toBe(false);
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("joins a disposal that is still removing its home", async () => {
    const lifecycle = await harness();
    const probe = lifecycle.createProbe(runtime);
    await probe.probeTarget();
    const home = resources(probe).temporaryHome;
    const removal = await blockRemoval(home);

    const disposal = lifecycle.dispose(probe);
    // Observe settlement immediately even if an assertion fails before awaiting.
    const disposed = disposal.catch((error: unknown) => error);
    await removal.entered;
    let settled = false;
    const joined = lifecycle.cleanup(true).then(() => {
      settled = true;
    });
    const pending = joined.catch((error: unknown) => error);
    try {
      // A cleanup that skipped the disposal settles within microtasks; one
      // macrotask turn drains them all. The removal stays blocked meanwhile.
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      await expect(access(home)).resolves.toBeUndefined();
    } finally {
      removal.release();
    }

    expect(await disposed).toBeUndefined();
    expect(await pending).toBeUndefined();
    expect(settled).toBe(true);
    expect(probe.isClosed).toBe(true);
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
