import type { ComputerUseApprovalMode } from "../config.ts";
import {
  ComputerUseClient,
  ComputerUseClientError,
  type ComputerUseRuntime,
} from "./app-server-client.ts";

/** Owns Computer Use clients and fences; shared session authority stays outside. */
export class ComputerUseLifecycle {
  private runtimeClient: ComputerUseClient | undefined;
  private runtimeApprovalMode: ComputerUseApprovalMode | undefined;
  // Dedicated probes and failed disposals outlive their original callers.
  private readonly ownedClients = new Map<
    ComputerUseClient,
    "live" | "disposing"
  >();
  private currentEpoch = 0;
  private preflights = 0;
  private readonly isSessionStopped: () => boolean;

  constructor(isSessionStopped: () => boolean) {
    this.isSessionStopped = isSessionStopped;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  invalidate(): void {
    this.currentEpoch++;
  }

  assertLifetime(epoch: number): void {
    if (
      this.isSessionStopped() ||
      this.preflights > 0 ||
      epoch !== this.currentEpoch
    ) {
      throw new ComputerUseClientError("closed");
    }
  }

  /** Release exactly once, after the caller's whole cleanup aggregate settles. */
  enterPreflight(): () => void {
    this.currentEpoch++;
    this.preflights++;
    return () => {
      this.preflights--;
    };
  }

  approvalModeChanged(mode: ComputerUseApprovalMode): boolean {
    return (
      this.runtimeClient !== undefined && this.runtimeApprovalMode !== mode
    );
  }

  getOrCreateRuntime(
    runtime: ComputerUseRuntime,
    mode: ComputerUseApprovalMode,
  ): ComputerUseClient {
    // Closed is not absent: failed cleanup must retain the exact runtime slot.
    if (!this.runtimeClient) {
      this.runtimeClient = new ComputerUseClient({ runtime });
      this.ownedClients.set(this.runtimeClient, "live");
      this.runtimeApprovalMode = mode;
    }
    return this.runtimeClient;
  }

  createProbe(runtime: ComputerUseRuntime): ComputerUseClient {
    const probe = new ComputerUseClient({ runtime });
    this.ownedClients.set(probe, "live");
    return probe;
  }

  async dispose(client: ComputerUseClient): Promise<void> {
    this.ownedClients.set(client, "disposing");
    await client.close();
    this.ownedClients.delete(client);
    if (this.runtimeClient === client) {
      this.runtimeClient = undefined;
      this.runtimeApprovalMode = undefined;
    }
  }

  async cleanup(pendingOnly = false): Promise<void> {
    const clients = [...this.ownedClients].filter(
      ([client, state]) =>
        !pendingOnly ||
        state === "disposing" ||
        client.isClosed ||
        client.hasCleanupError,
    );
    const results = await Promise.allSettled(
      clients.map(([client, state]) =>
        pendingOnly &&
        client === this.runtimeClient &&
        state === "live" &&
        !client.isClosed
          ? client.retryCleanup()
          : this.dispose(client),
      ),
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
  }
}
