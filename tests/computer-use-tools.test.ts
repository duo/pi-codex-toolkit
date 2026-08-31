import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildComputerUseJavaScript,
  COMPUTER_USE_TOOLS,
  convertComputerUseMcpContent,
  createComputerUseTools,
  type ComputerUseMethod,
} from "../src/computer-use/tools.ts";

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__piCodexToolkitSky;
  delete (globalThis as Record<string, unknown>).__pctInjected;
});

describe("Computer Use tools", () => {
  it("registers exactly six static sequential schemas", () => {
    const tools = createComputerUseTools(vi.fn());

    expect(tools.map((tool) => tool.name)).toEqual(COMPUTER_USE_TOOLS);
    expect(tools.every((tool) => tool.executionMode === "sequential")).toBe(
      true,
    );
    expect(tools.map((tool) => tool.parameters)).toMatchObject([
      { type: "object", additionalProperties: false },
      {
        type: "object",
        required: ["app"],
        additionalProperties: false,
        properties: { disableDiff: { type: "boolean" } },
      },
      {
        type: "object",
        required: ["app"],
        additionalProperties: false,
        properties: {
          element_index: { type: "integer" },
          x: { type: "number" },
          y: { type: "number" },
          mouse_button: {
            anyOf: [
              { const: "left" },
              { const: "right" },
              { const: "middle" },
              { const: "l" },
              { const: "r" },
              { const: "m" },
            ],
          },
          click_count: { type: "integer", minimum: 1 },
        },
      },
      { type: "object", required: ["app", "text"] },
      { type: "object", required: ["app", "key"] },
      {
        type: "object",
        required: ["app", "direction"],
        properties: {
          direction: {
            anyOf: [
              { const: "up" },
              { const: "down" },
              { const: "left" },
              { const: "right" },
              { const: "u" },
              { const: "d" },
              { const: "l" },
              { const: "r" },
            ],
          },
          pages: { type: "number", exclusiveMinimum: 0 },
        },
      },
    ]);

    const appDescription = (
      tools[1]?.parameters as {
        properties: { app: { description: string } };
      }
    ).properties.app.description;
    expect(appDescription).toContain("full .app bundle path");
    expect(appDescription).toContain(
      "PIDs and bare executable paths are unsupported",
    );
    expect(appDescription).toContain("computer_use_list_apps");
    expect(tools[0]?.description).toContain("unknown or cannot be resolved");
    expect(tools[0]?.description).toContain("use a returned identifier");
  });

  it("delegates each definition to its fixed Sky method", async () => {
    const executor = vi.fn(async (method: ComputerUseMethod) => ({
      content: [{ type: "text" as const, text: method }],
      details: { method, blockCount: 1, blockTypes: ["text" as const] },
    }));
    const tools = createComputerUseTools(executor);
    const ctx = {} as ExtensionContext;

    for (const tool of tools) {
      await tool.execute("call", { app: "Test" }, undefined, undefined, ctx);
    }

    expect(executor.mock.calls.map(([method]) => method)).toEqual([
      "list_apps",
      "get_app_state",
      "click",
      "type_text",
      "press_key",
      "scroll",
    ]);
  });

  it("keeps model arguments as data inside a fixed action source", async () => {
    const injected = '\"}); globalThis.__pctInjected = true; //';
    const typeText = vi.fn(async () => undefined);
    (globalThis as Record<string, unknown>).__piCodexToolkitSky = {
      type_text: typeText,
    };
    const code = buildComputerUseJavaScript("type_text", {
      app: "Protected App",
      text: injected,
    });
    const run = Object.getPrototypeOf(async () => undefined)
      .constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<void>;

    await new run("nodeRepl", code)({ write: vi.fn() });

    expect(typeText).toHaveBeenCalledWith({
      app: "Protected App",
      text: injected,
    });
    expect(
      (globalThis as Record<string, unknown>).__pctInjected,
    ).toBeUndefined();
    expect(code).toContain("globalThis.__piCodexToolkitSky.type_text(");
    expect(code).not.toContain("get_app_state");
  });

  it("uses one matching action and never appends a hidden observation", () => {
    for (const method of [
      "click",
      "type_text",
      "press_key",
      "scroll",
    ] as const) {
      const code = buildComputerUseJavaScript(method, { app: "Test" });
      expect(code.match(new RegExp(`\\.${method}\\(`, "g"))).toHaveLength(1);
      expect(code).not.toContain("get_app_state");
    }
  });

  it("builds the bounded list and state sources", () => {
    const list = buildComputerUseJavaScript("list_apps", {});
    const state = buildComputerUseJavaScript("get_app_state", {
      app: "Test",
      disableDiff: true,
    });

    expect(list).toContain("JSON.stringify(await");
    expect(list).toContain(".list_apps()");
    expect(state).toContain(".get_app_state(");
    expect(state).toContain("fileURLToPath(state.screenshot.url)");
    expect(state).toContain('=== "89504e470d0a1a0a"');
    expect(state).toContain('? "image/png"');
    expect(state).toContain('? "image/jpeg"');
    expect(state).toContain("Unsupported Computer Use screenshot format.");
    expect(state).toContain("nodeRepl.emitImage({ bytes, mimeType })");
  });

  it("preserves ordered native text and image blocks without payload details", () => {
    const protectedText = "PROTECTED_ACCESSIBILITY_TEXT";
    const protectedPng = Buffer.from("PROTECTED_IMAGE").toString("base64");
    const result = convertComputerUseMcpContent("get_app_state", [
      { type: "text", text: protectedText },
      { type: "image", data: protectedPng, mimeType: "image/png" },
    ]);

    expect(result.content).toEqual([
      { type: "text", text: protectedText },
      { type: "image", data: protectedPng, mimeType: "image/png" },
    ]);
    expect(result.details).toEqual({
      method: "get_app_state",
      blockCount: 2,
      blockTypes: ["text", "image"],
    });
    expect(JSON.stringify(result.details)).not.toContain(protectedText);
    expect(JSON.stringify(result.details)).not.toContain(protectedPng);
  });

  it("preserves the JPEG MIME returned by node_repl", () => {
    const protectedJpeg = Buffer.from("PROTECTED_JPEG").toString("base64");

    expect(
      convertComputerUseMcpContent("get_app_state", [
        { type: "image", data: protectedJpeg, mimeType: "image/jpeg" },
      ]).content,
    ).toEqual([{ type: "image", data: protectedJpeg, mimeType: "image/jpeg" }]);
  });

  it("rejects empty, malformed, and unsupported-image output", () => {
    expect(() => convertComputerUseMcpContent("list_apps", [])).toThrow(
      "no supported content",
    );
    expect(() =>
      convertComputerUseMcpContent("get_app_state", [
        { type: "image", data: "abc", mimeType: "image/webp" },
      ]),
    ).toThrow("unsupported content");
    expect(() =>
      convertComputerUseMcpContent("list_apps", [{ type: "resource" }]),
    ).toThrow("unsupported content");
  });
});
