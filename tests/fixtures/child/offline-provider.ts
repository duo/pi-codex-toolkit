import { appendFileSync, readFileSync } from "node:fs";

import type {
  AssistantMessage,
  JsonObject,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Deterministic offline provider for the child-compatibility lanes. It is
 * copied into a temporary agent directory and loaded by a real Pi process, so
 * it must stay self-contained: the turn script and the receipt are files named
 * by the environment, and nothing ever reaches the network.
 *
 * `tests/fixtures/child-host.ts` owns the same two shapes on the
 * reading side; keep them in step.
 */
interface ScriptedTurn {
  tool?: { name: string; arguments: JsonObject };
  text?: string;
  /**
   * Poll the shell the previous result yielded, the way the tool tells a model
   * to: a first observation may end before the job settles, reporting
   * `session_id <id>: running`. The entry repeats while that holds and is
   * skipped once the job is terminal, so the script after it is unchanged.
   */
  pollShell?: boolean;
}

const PROVIDER = "pct-offline";
const MODEL_IDS = ["gpt-6-astra", "grok-4.6"] as const;
/**
 * Bounded evidence of the previous tool result; never the whole transcript.
 * A shell result prints control and recovery metadata before its output, so a
 * shorter cap would hide the very bytes a lane asserts on.
 */
const RESULT_PREVIEW_CHARS = 4_000;
/** A stuck poll must end the turn script instead of looping forever. */
const MAX_SHELL_POLLS = 10;
const RUNNING_SESSION = /session_id (\S+): running/u;
/**
 * Unambiguous Toolkit execution identifiers a lane looks for in the offered
 * tool descriptions. Pi's system prompt never names a tool, so the descriptions
 * are where "this session was told how to call Toolkit execution" actually
 * shows: an active Code route documents the nested spellings inside `exec`,
 * and a direct Shell/Patch route offers them as tools. `exec` and `wait` are
 * ordinary English words and are deliberately left out.
 */
const GUIDANCE_NAMES = ["apply_patch", "exec_command", "write_stdin"] as const;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`offline provider requires ${name}`);
  }
  return value;
}

function record(entry: Record<string, unknown>): void {
  appendFileSync(required("PCT_RECEIPT_FILE"), `${JSON.stringify(entry)}\n`);
}

export default function offlineProvider(pi: ExtensionAPI): void {
  let turn = 0;
  let step = 0;
  let polls = 0;
  const models: Array<Model<"pct-offline">> = MODEL_IDS.map((id) => ({
    id,
    name: id,
    provider: PROVIDER,
    api: "pct-offline" as never,
    baseUrl: "https://invalid.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  }));
  pi.registerProvider(PROVIDER, {
    api: "pct-offline" as never,
    baseUrl: "https://invalid.invalid",
    apiKey: "offline-fixture-not-a-secret",
    models,
    streamSimple: (model, context) => {
      turn += 1;
      const script = JSON.parse(
        readFileSync(required("PCT_SCRIPT_FILE"), "utf8"),
      ) as ScriptedTurn[];
      const prompt = getCurrentSystemPrompt(context.messages);
      const last = context.messages.at(-1);
      const previous =
        last?.role === "toolResult"
          ? last.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("")
          : "";
      let entry: ScriptedTurn = script[step] ?? {};
      let polling = false;
      while (entry.pollShell === true) {
        const running = RUNNING_SESSION.exec(previous);
        if (running && polls < MAX_SHELL_POLLS) {
          polls += 1;
          polling = true;
          entry = {
            tool: {
              name: "write_stdin",
              arguments: { session_id: running[1] as string },
            },
          };
          break;
        }
        step += 1;
        entry = script[step] ?? {};
      }
      // A poll repeats until its job is terminal; every other entry is used once.
      if (!polling) step += 1;
      const offered = getCurrentTools(context.messages);
      record({
        kind: "turn",
        turn,
        model: model.id,
        tools: offered.map((tool) => tool.name).sort(),
        prompt: {
          bash: /\bbash\b/.test(prompt),
          exec: /\bexec\b/.test(prompt),
          execCommand: prompt.includes("exec_command"),
          applyPatch: prompt.includes("apply_patch"),
        },
        guidance: GUIDANCE_NAMES.filter((name) =>
          offered.some((tool) => tool.description.includes(name)),
        ),
        ...(last?.role === "toolResult"
          ? {
              result: {
                toolName: last.toolName,
                isError: last.isError === true,
                text: previous.slice(0, RESULT_PREVIEW_CHARS),
              },
            }
          : {}),
      });
      const call: ToolCall | undefined = entry.tool
        ? {
            type: "toolCall",
            id: `pct-offline-${turn}`,
            name: entry.tool.name,
            arguments: entry.tool.arguments,
          }
        : undefined;
      const message: AssistantMessage & { stopReason: "stop" | "toolUse" } = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: call
          ? [call]
          : [{ type: "text", text: entry.text ?? `offline turn ${turn}` }],
        stopReason: call ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
