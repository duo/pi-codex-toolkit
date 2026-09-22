import { appendFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Captures the Toolkit's execution-diagnostics record inside a real child
 * session. Copied into a temporary agent directory, so it stays self-contained
 * and only appends to the receipt file named by the environment.
 */
const EVENT = "pi-codex-toolkit.execution-diagnostics";

export default function diagnosticsReceipt(pi: ExtensionAPI): void {
  pi.events.on(EVENT, (record) => {
    const receipt = process.env.PCT_RECEIPT_FILE;
    if (receipt === undefined || receipt.length === 0) {
      throw new Error("diagnostics receipt requires PCT_RECEIPT_FILE");
    }
    appendFileSync(
      receipt,
      `${JSON.stringify({ kind: "diagnostics", record })}\n`,
    );
  });
}
