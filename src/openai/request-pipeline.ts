import type { WebSearchConfig } from "../config.ts";
import type { BackendDecision } from "../status.ts";
import { injectNativeSearch } from "./native-search.ts";
import {
  replayRemoteCompaction,
  type RemoteCompactionCompatibility,
  type RemoteCompactionDetailsV1,
} from "./remote-compaction.ts";

export function transformProviderRequest(
  payload: unknown,
  config: WebSearchConfig,
  decision: BackendDecision,
  remoteCompaction?: {
    details?: RemoteCompactionDetailsV1;
    compatibility?: RemoteCompactionCompatibility;
  },
): unknown {
  const replayed = replayRemoteCompaction(
    payload,
    remoteCompaction?.details,
    remoteCompaction?.compatibility,
  );
  if (decision.effective !== "native") return replayed;
  return injectNativeSearch(replayed, config);
}
