import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

interface Message {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

const logPath = process.env.FAKE_APP_SERVER_LOG;
const scenario = process.env.FAKE_APP_SERVER_SCENARIO ?? "normal";
const statePath = process.env.FAKE_APP_SERVER_STATE;
let readinessChecks = 0;
let heldToolCall: Message | undefined;
let elicitationToolCall: Message | undefined;
let elicitationRequestId: number | string | undefined;
let elicitationSequence = 0;
let mcpElicitationsEnabled = false;

if (scenario === "delayed-exit") {
  process.on("SIGTERM", () => {
    setTimeout(() => {
      const home = process.env.CODEX_HOME;
      if (home) {
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, "late-write"), "late", "utf8");
      }
      process.exit(0);
    }, 50);
  });
}

function log(value: unknown): void {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function toolCode(message: Message): string {
  const args = message.params?.arguments;
  return typeof args === "object" &&
    args !== null &&
    typeof (args as Record<string, unknown>).code === "string"
    ? ((args as Record<string, unknown>).code as string)
    : "";
}

function toolContent(message: Message): Array<Record<string, unknown>> {
  const code = toolCode(message);
  if (code.includes("String(globalThis.__piCodexToolkitSky.target)")) {
    return [
      {
        type: "text",
        text: scenario === "target-mismatch" ? "linux" : "mac",
      },
    ];
  }
  if (code.includes("first-app")) {
    return [{ type: "text", text: "first-result" }];
  }
  if (code.includes("second-app")) {
    return [{ type: "text", text: "second-result" }];
  }
  if (code.includes(".get_app_state(")) {
    return [
      { type: "text", text: "PROTECTED_ACCESSIBILITY_TEXT" },
      {
        type: "image",
        data: Buffer.from("PROTECTED_SCREENSHOT").toString("base64"),
        mimeType: "image/png",
      },
    ];
  }
  if (code.includes(".list_apps(")) {
    return [{ type: "text", text: '[{"name":"PROTECTED_APP"}]' }];
  }
  if (code.includes(".click(")) {
    return [{ type: "text", text: "Click completed." }];
  }
  if (code.includes(".type_text(")) {
    return [{ type: "text", text: "Text entry completed." }];
  }
  if (code.includes(".press_key(")) {
    return [{ type: "text", text: "Key press completed." }];
  }
  return [{ type: "text", text: "Scroll completed." }];
}

function replyToTool(message: Message): void {
  send({ id: message.id, result: { content: toolContent(message) } });
}

function sessionApp(message: Message): {
  id: string;
  displayName: string;
} {
  const code = toolCode(message);
  if (code.includes('"app":"App A Case Variant"')) {
    return {
      id: "com.Example.app-a",
      displayName: "App A Case Variant",
    };
  }
  if (code.includes('"app":"App B"')) {
    return { id: "com.example.app-b", displayName: "App B" };
  }
  return { id: "com.example.app-a", displayName: "App A" };
}

function requestElicitation(message: Message): void {
  const app = sessionApp(message);
  const appId =
    scenario === "session-approval" &&
    elicitationSequence === 0 &&
    app.id === "com.example.app-a"
      ? ` ${app.id} `
      : app.id;
  elicitationToolCall = message;
  elicitationRequestId =
    scenario === "elicitation-id-collision"
      ? message.id
      : scenario === "session-approval"
        ? `approval-request-${++elicitationSequence}`
        : "approval-request";
  send({ method: "fake/progress", params: { status: "waiting" } });
  send({
    id: elicitationRequestId,
    method: "mcpServer/elicitation/request",
    params: {
      threadId:
        scenario === "wrong-thread-elicitation"
          ? "thread-other"
          : "thread-test",
      turnId: null,
      serverName: scenario === "foreign-elicitation" ? "foreign" : "node_repl",
      mode: scenario === "url-elicitation" ? "url" : "openai/form",
      message:
        scenario === "malformed-elicitation"
          ? 42
          : "PROTECTED_APPROVAL_MESSAGE",
      requestedSchema: {},
      _meta: {
        connector_id:
          scenario === "other-connector-elicitation" ? "other" : "computer-use",
        connector_name: "Computer Use",
        persist: ["session", "always"],
        tool_params:
          scenario === "missing-app-elicitation"
            ? {}
            : scenario === "empty-app-elicitation"
              ? { app: "   " }
              : { app: appId },
        tool_params_display: [
          { name: "app", display_name: "App", value: app.displayName },
        ],
      },
    },
  });
}

function handleToolCall(message: Message): void {
  if (scenario === "hang") return;
  if (scenario === "exit") {
    process.stderr.write("PROTECTED_STDERR\n");
    process.exit(17);
  }
  if (scenario === "ambiguous-once" || scenario === "ambiguous-invalid-state") {
    const code = toolCode(message);
    if (code.includes(".click(") && statePath && !existsSync(statePath)) {
      writeFileSync(statePath, "failed", "utf8");
      process.stderr.write("PROTECTED_STDERR\n");
      process.exit(18);
    }
  }
  if (scenario === "ambiguous-invalid-state") {
    const code = toolCode(message);
    if (code.includes(".get_app_state(")) {
      send({ id: message.id, result: { content: [{ type: "resource" }] } });
      return;
    }
  }
  if (scenario === "mcp-error") {
    send({
      id: message.id,
      result: {
        content: [{ type: "text", text: "PROTECTED_RAW_MCP_ERROR" }],
        isError: true,
      },
    });
    return;
  }
  if (scenario === "app-server-error") {
    send({
      id: message.id,
      error: { code: -32000, message: "PROTECTED_RAW_RPC_ERROR" },
    });
    return;
  }
  if (scenario === "invalid-content") {
    send({ id: message.id, result: { content: [{ type: "resource" }] } });
    return;
  }
  if (scenario === "reorder") {
    if (!heldToolCall) {
      heldToolCall = message;
    } else {
      replyToTool(message);
      replyToTool(heldToolCall);
      heldToolCall = undefined;
    }
    return;
  }
  if (
    scenario === "elicitation" ||
    scenario === "elicitation-id-collision" ||
    scenario === "foreign-elicitation" ||
    scenario === "wrong-thread-elicitation" ||
    scenario === "url-elicitation" ||
    scenario === "other-connector-elicitation" ||
    scenario === "malformed-elicitation" ||
    scenario === "missing-app-elicitation" ||
    scenario === "empty-app-elicitation" ||
    scenario === "session-approval"
  ) {
    if (!mcpElicitationsEnabled) {
      send({
        id: message.id,
        result: {
          content: [{ type: "text", text: "PROTECTED_POLICY_DENIAL" }],
          isError: true,
        },
      });
      return;
    }
    requestElicitation(message);
    return;
  }
  replyToTool(message);
}

log({
  type: "environment",
  CODEX_HOME: process.env.CODEX_HOME,
  cwd: process.cwd(),
});

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: Message;
  try {
    message = JSON.parse(line) as Message;
  } catch {
    return;
  }
  log({ type: "input", message });

  if (message.method === "initialize") {
    if (scenario === "startup-exit") {
      process.stderr.write("PROTECTED_STARTUP_STDERR\n");
      process.exit(19);
    }
    send({ id: message.id, result: { userAgent: "fake-app-server" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    const approvalPolicy = message.params?.approvalPolicy;
    mcpElicitationsEnabled =
      typeof approvalPolicy === "object" &&
      approvalPolicy !== null &&
      typeof (approvalPolicy as Record<string, unknown>).granular ===
        "object" &&
      (
        (approvalPolicy as Record<string, unknown>).granular as Record<
          string,
          unknown
        >
      ).mcp_elicitations === true;
    send({ id: message.id, result: { thread: { id: "thread-test" } } });
    return;
  }
  if (message.method === "mcpServerStatus/list") {
    readinessChecks += 1;
    const connected = scenario !== "readiness-delay" || readinessChecks > 1;
    send({
      id: message.id,
      result: {
        data: [
          {
            name: "node_repl",
            runtimeStatus: connected ? "connected" : "starting",
            tools: connected ? { js: {} } : {},
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }
  if (message.method === "mcpServer/tool/call") {
    handleToolCall(message);
    return;
  }
  if (message.id === elicitationRequestId && elicitationToolCall) {
    const result = message.result as
      | {
          action?: unknown;
          content?: unknown;
          _meta?: { persist?: unknown } | null;
        }
      | undefined;
    const accepted =
      result?.action === "accept" &&
      typeof result.content === "object" &&
      result.content !== null &&
      !Array.isArray(result.content);
    if (scenario !== "session-approval" || accepted) {
      replyToTool(elicitationToolCall);
    } else {
      send({
        id: elicitationToolCall.id,
        result: {
          content: [{ type: "text", text: "PROTECTED_POLICY_DENIAL" }],
          isError: true,
        },
      });
    }
    elicitationToolCall = undefined;
    elicitationRequestId = undefined;
  }
});
