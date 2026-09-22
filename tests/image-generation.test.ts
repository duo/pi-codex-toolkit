import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Message } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildImageGenerationRequest,
  generateImage,
  ImageGenerationError,
  type ImageGenerationResult,
} from "../src/openai/image-generation.ts";
import {
  resolveOfficialRoute,
  type AuthenticatedOfficialRoute,
} from "../src/openai/route.ts";
import { codexModel, model } from "./fixtures.ts";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

function jwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `e30.${payload}.signature`;
}

function route(
  kind: "api-key" | "codex-oauth" = "api-key",
): AuthenticatedOfficialRoute {
  return {
    model:
      kind === "api-key"
        ? model({
            headers: {
              "x-model-header": "model-value",
              "openai-beta": "responses=experimental",
              "x-openai-beta": "responses=v2",
              "chatgpt-account-id": "stale-account",
            },
          })
        : codexModel({ headers: { "x-model-header": "model-value" } }),
    route: {
      kind,
      endpoint: new URL(
        kind === "api-key"
          ? "https://api.openai.com/v1/responses"
          : "https://chatgpt.com/backend-api/codex/responses",
      ),
    },
    token: kind === "api-key" ? "SECRET_API_KEY" : jwt("SECRET_ACCOUNT"),
    headers: {
      "x-refreshed-header": "refreshed-value",
      authorization: "Bearer stale",
      "x-codex-beta-features": "remote_compaction_v2",
    },
  };
}

function imageResponse(
  data: string = PNG.toString("base64"),
  init?: ResponseInit,
): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: data }] }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "req-1" },
    ...init,
  });
}

async function useTemporaryAgentDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pct-images-"));
  temporaryDirectories.push(directory);
  process.env.PI_CODING_AGENT_DIR = directory;
  return directory;
}

async function successfulGeneration(
  fetchImpl: typeof fetch,
  routeValue = route(),
): Promise<ImageGenerationResult> {
  return generateImage(
    {
      prompt: "draw a compact blue square",
      toolCallId: "tool-call-1",
      route: routeValue,
    },
    fetchImpl,
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalAgentDirectory === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OpenAI image generation protocol", () => {
  it("builds the fixed one-image request", () => {
    expect(
      buildImageGenerationRequest({
        prompt: " verbatim prompt ",
        size: "1536x1024",
        quality: "high",
      }),
    ).toEqual({
      prompt: " verbatim prompt ",
      model: "gpt-image-2",
      background: "auto",
      quality: "high",
      size: "1536x1024",
    });
    expect(buildImageGenerationRequest({ prompt: "prompt" })).toEqual({
      prompt: "prompt",
      model: "gpt-image-2",
      background: "auto",
      quality: "auto",
      size: "auto",
    });
  });

  it("sends one API-key request and persists the original PNG", async () => {
    const directory = await useTemporaryAgentDirectory();
    const fetchMock = vi.fn(async () =>
      imageResponse(`\n${PNG.toString("base64")}  `),
    );
    const result = await generateImage(
      {
        prompt: " VERBATIM_PROMPT ",
        size: "1024x1536",
        quality: "medium",
        toolCallId: "image-turn-1",
        route: route(),
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.href).toBe("https://api.openai.com/v1/images/generations");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: " VERBATIM_PROMPT ",
      model: "gpt-image-2",
      background: "auto",
      quality: "medium",
      size: "1024x1536",
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("n");

    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer SECRET_API_KEY");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("originator")).toBe("pi");
    expect(headers.get("x-codex-image-turn-id")).toBe("image-turn-1");
    expect(headers.get("x-model-header")).toBe("model-value");
    expect(headers.get("x-refreshed-header")).toBe("refreshed-value");
    expect(headers.has("chatgpt-account-id")).toBe(false);
    expect(headers.has("openai-beta")).toBe(false);
    expect(headers.has("x-openai-beta")).toBe(false);
    expect(headers.has("x-codex-beta-features")).toBe(false);

    expect(result.path).toMatch(
      new RegExp(
        `^${directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/artifacts/pi-codex-toolkit/[0-9a-f-]+\\.png$`,
      ),
    );
    expect(result).toMatchObject({
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });
    await expect(readFile(result.path)).resolves.toEqual(PNG);
  });

  it("uses the exact Codex OAuth endpoint and account header", async () => {
    await useTemporaryAgentDirectory();
    const fetchMock = vi.fn(async () => imageResponse());
    await successfulGeneration(
      fetchMock as unknown as typeof fetch,
      route("codex-oauth"),
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.href).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("chatgpt-account-id")).toBe("SECRET_ACCOUNT");
    expect(headers.get("authorization")).toMatch(/^Bearer e30\./);
  });

  it.each(["api-key", "codex-oauth"] as const)(
    "applies nullable refreshed headers before mandatory %s image headers",
    async (kind) => {
      await useTemporaryAgentDirectory();
      const original = route(kind);
      original.model.headers = {
        "X-Optional": "old",
        "X-Replaced": "old",
        "X-Kept": "kept",
        "OpenAI-Beta": "old-beta",
      };
      const authHeaders = {
        "x-optional": null,
        "x-replaced": "new",
        "X-Absent": null,
        Authorization: null,
        "ChatGPT-Account-ID": null,
        "Content-Type": null,
        Accept: null,
        Originator: null,
        "X-Codex-Image-Turn-ID": null,
        "x-openai-beta": "remove-me",
        "x-codex-beta-features": "remove-me",
      };
      const resolved = await resolveOfficialRoute(
        {
          getApiKeyAndHeaders: async () => ({
            ok: true,
            apiKey: original.token,
            headers: authHeaders,
          }),
          isUsingOAuth: () => kind === "codex-oauth",
        },
        original.model,
      );
      if (!resolved.ok) throw new Error("test route unavailable");
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.has("X-Optional")).toBe(false);
        expect(headers.has("x-absent")).toBe(false);
        expect(headers.get("x-replaced")).toBe("new");
        expect(headers.get("x-kept")).toBe("kept");
        expect(headers.get("authorization")).toBe(`Bearer ${original.token}`);
        expect(headers.get("chatgpt-account-id")).toBe(
          kind === "codex-oauth" ? "SECRET_ACCOUNT" : null,
        );
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("accept")).toBe("application/json");
        expect(headers.get("originator")).toBe("pi");
        expect(headers.get("x-codex-image-turn-id")).toBe("tool-call-1");
        for (const key of [
          "openai-beta",
          "x-openai-beta",
          "x-codex-beta-features",
        ]) {
          expect(headers.has(key)).toBe(false);
        }
        headers.forEach((value) => expect(value).not.toBe("null"));
        return imageResponse();
      });
      await successfulGeneration(fetchMock, resolved.value);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(original.model.headers["X-Optional"]).toBe("old");
      expect(authHeaders["x-optional"]).toBeNull();
    },
  );

  it("creates unique files without changing the first artifact", async () => {
    await useTemporaryAgentDirectory();
    const fetchMock = vi.fn(async () => imageResponse());
    const first = await successfulGeneration(
      fetchMock as unknown as typeof fetch,
    );
    const second = await successfulGeneration(
      fetchMock as unknown as typeof fetch,
    );

    expect(first.path).not.toBe(second.path);
    await expect(readFile(first.path)).resolves.toEqual(PNG);
    await expect(readFile(second.path)).resolves.toEqual(PNG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing OAuth account before dispatch", async () => {
    await useTemporaryAgentDirectory();
    const oauth = route("codex-oauth");
    oauth.token = "e30.e30.signature";
    const fetchMock = vi.fn();
    await expect(
      successfulGeneration(fetchMock as unknown as typeof fetch, oauth),
    ).rejects.toMatchObject({
      category: "missing-account-claim",
      unknownResult: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose invalid registry headers before dispatch", async () => {
    await useTemporaryAgentDirectory();
    const invalidRoute = route();
    invalidRoute.headers["x-invalid"] = "SECRET_HEADER\nvalue";
    const fetchMock = vi.fn();

    const error = await successfulGeneration(
      fetchMock as unknown as typeof fetch,
      invalidRoute,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      category: "network-error",
      unknownResult: false,
    });
    expect(String(error)).not.toContain("SECRET_HEADER");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["http-error", () => imageResponse(undefined, { status: 302 })],
    ["invalid-json", () => new Response("not-json")],
    ["missing-image", () => new Response(JSON.stringify({ data: [] }))],
    [
      "missing-image",
      () => new Response(JSON.stringify({ data: [{ b64_json: "" }] })),
    ],
    [
      "invalid-image",
      () => imageResponse(Buffer.from("not-png").toString("base64")),
    ],
  ] as const)("fails once with %s", async (category, response) => {
    await useTemporaryAgentDirectory();
    const fetchMock = vi.fn(async () => response());
    await expect(
      successfulGeneration(fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ category, unknownResult: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (category === "http-error") {
      const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
      expect(init).toMatchObject({ redirect: "manual" });
    }
  });

  it("does not dispatch when already aborted", async () => {
    await useTemporaryAgentDirectory();
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    await expect(
      generateImage(
        {
          prompt: "prompt",
          toolCallId: "call",
          route: route(),
          signal: controller.signal,
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ category: "aborted", unknownResult: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports post-dispatch abort, timeout, and network failures without retry", async () => {
    await useTemporaryAgentDirectory();

    const caller = new AbortController();
    const abortedFetch = vi.fn(async () => {
      caller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      generateImage(
        {
          prompt: "prompt",
          toolCallId: "call",
          route: route(),
          signal: caller.signal,
        },
        abortedFetch as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ category: "aborted", unknownResult: true });
    expect(abortedFetch).toHaveBeenCalledTimes(1);

    const timeout = new AbortController();
    timeout.abort();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const timedOutFetch = vi.fn(async () => {
      throw new DOMException("timeout", "TimeoutError");
    });
    await expect(
      successfulGeneration(timedOutFetch as unknown as typeof fetch),
    ).rejects.toMatchObject({ category: "timeout", unknownResult: true });
    expect(timedOutFetch).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
    const networkFetch = vi.fn(async () => {
      throw new TypeError("offline SECRET_RESPONSE_BODY");
    });
    await expect(
      successfulGeneration(networkFetch as unknown as typeof fetch),
    ).rejects.toMatchObject({
      category: "network-error",
      unknownResult: true,
    });
    expect(networkFetch).toHaveBeenCalledTimes(1);
  });

  it("preserves abort and timeout categories while reading JSON", async () => {
    await useTemporaryAgentDirectory();
    for (const category of ["aborted", "timeout"] as const) {
      const caller = new AbortController();
      const timeout = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      const fetchMock = vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => {
            if (category === "aborted") caller.abort();
            else timeout.abort();
            throw new DOMException(category, "AbortError");
          },
        } as unknown as Response;
      });
      await expect(
        generateImage(
          {
            prompt: "prompt",
            toolCallId: "call",
            route: route(),
            ...(category === "aborted" ? { signal: caller.signal } : {}),
          },
          fetchMock as unknown as typeof fetch,
        ),
      ).rejects.toMatchObject({ category, unknownResult: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });

  it("reports artifact failure without a second hosted request", async () => {
    const directory = await useTemporaryAgentDirectory();
    const blockedPath = join(directory, "not-a-directory");
    await writeFile(blockedPath, "blocked", "utf8");
    process.env.PI_CODING_AGENT_DIR = blockedPath;
    const fetchMock = vi.fn(async () => imageResponse());

    await expect(
      successfulGeneration(fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({
      category: "artifact-write-error",
      unknownResult: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("emits only allowlisted metadata", async () => {
    await useTemporaryAgentDirectory();
    const sensitiveRoute = route("codex-oauth");
    sensitiveRoute.headers["x-secret-header"] = "SECRET_HEADER";
    const debugOutput = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ b64_json: PNG.toString("base64") }],
            private_payload: "SECRET_RESPONSE_BODY",
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );

    await generateImage(
      {
        prompt: "SECRET_PROMPT",
        toolCallId: "SECRET_TOOL_CALL",
        route: sensitiveRoute,
        debug: true,
      },
      fetchMock as unknown as typeof fetch,
      debugOutput,
    );

    const output = debugOutput.mock.calls.flat().join("\n");
    expect(output).toContain("image-generation");
    expect(output).toContain("chatgpt.com");
    for (const secret of [
      "SECRET_PROMPT",
      "SECRET_TOOL_CALL",
      "SECRET_ACCOUNT",
      "SECRET_HEADER",
      "SECRET_RESPONSE_BODY",
      sensitiveRoute.token,
      PNG.toString("base64"),
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it("uses fixed metadata-only errors", () => {
    const error = new ImageGenerationError("network-error", true);
    expect(error.message).toBe(
      "Image Generation failed: network-error. The hosted generation result may be unknown.",
    );
  });
});

describe("Pi 0.87 image result conversion", () => {
  it("preserves vision images and uses Pi's text-only omission marker", () => {
    const message: Message = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "openai_generate_image",
      content: [
        { type: "text", text: "Generated image saved to /tmp/image.png." },
        { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
      ],
      details: { path: "/tmp/image.png", mimeType: "image/png" },
      isError: false,
      timestamp: 1,
    };

    const vision = transformMessages(
      [message],
      model({ input: ["text", "image"] }),
    );
    expect(vision[0]).toEqual(message);

    const textOnly = transformMessages([message], model({ input: ["text"] }));
    expect(textOnly[0]).toMatchObject({
      role: "toolResult",
      content: [
        { type: "text", text: "Generated image saved to /tmp/image.png." },
        {
          type: "text",
          text: "(tool image omitted: model does not support images)",
        },
      ],
      details: { path: "/tmp/image.png", mimeType: "image/png" },
    });
  });
});
