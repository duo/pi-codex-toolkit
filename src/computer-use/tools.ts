import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const COMPUTER_USE_TOOLS = [
  "computer_use_list_apps",
  "computer_use_get_app_state",
  "computer_use_click",
  "computer_use_type_text",
  "computer_use_press_key",
  "computer_use_scroll",
] as const;

export type ComputerUseToolName = (typeof COMPUTER_USE_TOOLS)[number];

export type ComputerUseMethod =
  | "list_apps"
  | "get_app_state"
  | "click"
  | "type_text"
  | "press_key"
  | "scroll";

export interface ComputerUseToolDetails {
  method: ComputerUseMethod;
  blockCount: number;
  blockTypes: Array<"text" | "image">;
}

export interface ComputerUseToolResult {
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        data: string;
        mimeType: "image/png" | "image/jpeg";
      }
  >;
  details: ComputerUseToolDetails;
}

export type ComputerUseExecutor = (
  method: ComputerUseMethod,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) => Promise<ComputerUseToolResult>;

const app = Type.String({
  minLength: 1,
  description:
    "App display name, full .app bundle path, or unambiguous bundle identifier. PIDs and bare executable paths are unsupported; prefer an identifier returned by computer_use_list_apps.",
});

const elementIndex = Type.Optional(
  Type.Integer({ description: "Element index from the latest app state." }),
);

const coordinate = Type.Optional(
  Type.Number({ description: "Screen coordinate for fallback targeting." }),
);

const listAppsParameters = Type.Object({}, { additionalProperties: false });

const getAppStateParameters = Type.Object(
  {
    app,
    disableDiff: Type.Optional(
      Type.Boolean({
        description: "Return a full accessibility tree instead of a diff.",
      }),
    ),
  },
  { additionalProperties: false },
);

const clickParameters = Type.Object(
  {
    app,
    element_index: elementIndex,
    x: coordinate,
    y: coordinate,
    mouse_button: Type.Optional(
      Type.Union(
        ["left", "right", "middle", "l", "r", "m"].map((value) =>
          Type.Literal(value),
        ),
      ),
    ),
    click_count: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const typeTextParameters = Type.Object(
  {
    app,
    text: Type.String({
      minLength: 1,
      description: "Text to type into the active control in the app.",
    }),
  },
  { additionalProperties: false },
);

const pressKeyParameters = Type.Object(
  {
    app,
    key: Type.String({
      minLength: 1,
      description: "xdotool-style key or key combination.",
    }),
  },
  { additionalProperties: false },
);

const scrollParameters = Type.Object(
  {
    app,
    element_index: elementIndex,
    x: coordinate,
    y: coordinate,
    direction: Type.Union(
      ["up", "down", "left", "right", "u", "d", "l", "r"].map((value) =>
        Type.Literal(value),
      ),
    ),
    pages: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { additionalProperties: false },
);

const SKY_GLOBAL = "globalThis.__piCodexToolkitSky";

function bootstrapSky(): string {
  return `${SKY_GLOBAL} ??= (await import("@oai/sky")).sky;`;
}

function dataLiteral(args: Record<string, unknown>): string {
  return JSON.stringify(args);
}

export function buildComputerUseJavaScript(
  method: ComputerUseMethod,
  args: Record<string, unknown>,
): string {
  const bootstrap = bootstrapSky();
  switch (method) {
    case "list_apps":
      return `${bootstrap}\nnodeRepl.write(JSON.stringify(await ${SKY_GLOBAL}.list_apps()));`;
    case "get_app_state":
      return `${bootstrap}\nawait (async () => {\n  const state = await ${SKY_GLOBAL}.get_app_state(${dataLiteral(args)});\n  nodeRepl.write(state.text);\n  if (state.screenshot) {\n    const fs = await import("node:fs/promises");\n    const { fileURLToPath } = await import("node:url");\n    const bytes = await fs.readFile(fileURLToPath(state.screenshot.url));\n    const mimeType = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"\n      ? "image/png"\n      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff\n        ? "image/jpeg"\n        : undefined;\n    if (!mimeType) throw new Error("Unsupported Computer Use screenshot format.");\n    await nodeRepl.emitImage({ bytes, mimeType });\n  }\n})();`;
    case "click":
      return `${bootstrap}\nawait ${SKY_GLOBAL}.click(${dataLiteral(args)});\nnodeRepl.write("Click completed.");`;
    case "type_text":
      return `${bootstrap}\nawait ${SKY_GLOBAL}.type_text(${dataLiteral(args)});\nnodeRepl.write("Text entry completed.");`;
    case "press_key":
      return `${bootstrap}\nawait ${SKY_GLOBAL}.press_key(${dataLiteral(args)});\nnodeRepl.write("Key press completed.");`;
    case "scroll":
      return `${bootstrap}\nawait ${SKY_GLOBAL}.scroll(${dataLiteral(args)});\nnodeRepl.write("Scroll completed.");`;
  }
}

export function isComputerUseAction(method: ComputerUseMethod): boolean {
  return (
    method === "click" ||
    method === "type_text" ||
    method === "press_key" ||
    method === "scroll"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function convertComputerUseMcpContent(
  method: ComputerUseMethod,
  blocks: unknown,
): ComputerUseToolResult {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error("Computer Use returned no supported content.");
  }

  const content: ComputerUseToolResult["content"] = [];
  for (const block of blocks) {
    if (!isRecord(block)) {
      throw new Error("Computer Use returned unsupported content.");
    }
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      block.data.length > 0 &&
      (block.mimeType === "image/png" || block.mimeType === "image/jpeg")
    ) {
      content.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
      continue;
    }
    throw new Error("Computer Use returned unsupported content.");
  }

  return {
    content,
    details: {
      method,
      blockCount: content.length,
      blockTypes: content.map((block) => block.type),
    },
  };
}

function execute(
  executor: ComputerUseExecutor,
  method: ComputerUseMethod,
): ToolDefinition["execute"] {
  return async (_toolCallId, params, signal, _onUpdate, ctx) =>
    executor(method, params as Record<string, unknown>, signal, ctx);
}

export function createComputerUseTools(
  executor: ComputerUseExecutor,
): ToolDefinition[] {
  return [
    {
      name: "computer_use_list_apps",
      label: "Computer Use: List Apps",
      description:
        "List macOS apps available to Computer Use. Use this when the target app is unknown or cannot be resolved, then use a returned identifier.",
      parameters: listAppsParameters,
      executionMode: "sequential",
      execute: execute(executor, "list_apps"),
    },
    {
      name: "computer_use_get_app_state",
      label: "Computer Use: Get App State",
      description:
        "Read the current accessibility state and screenshot for one macOS app.",
      parameters: getAppStateParameters,
      executionMode: "sequential",
      execute: execute(executor, "get_app_state"),
    },
    {
      name: "computer_use_click",
      label: "Computer Use: Click",
      description:
        "Click an element from the latest app state, or use explicit coordinates as a fallback.",
      parameters: clickParameters,
      executionMode: "sequential",
      execute: execute(executor, "click"),
    },
    {
      name: "computer_use_type_text",
      label: "Computer Use: Type Text",
      description: "Type text into the active control of one macOS app.",
      parameters: typeTextParameters,
      executionMode: "sequential",
      execute: execute(executor, "type_text"),
    },
    {
      name: "computer_use_press_key",
      label: "Computer Use: Press Key",
      description: "Press a key or key combination in one macOS app.",
      parameters: pressKeyParameters,
      executionMode: "sequential",
      execute: execute(executor, "press_key"),
    },
    {
      name: "computer_use_scroll",
      label: "Computer Use: Scroll",
      description:
        "Scroll one macOS app at an element or explicit coordinates.",
      parameters: scrollParameters,
      executionMode: "sequential",
      execute: execute(executor, "scroll"),
    },
  ];
}
