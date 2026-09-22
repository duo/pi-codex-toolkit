import { describe, expect, it, vi } from "vitest";

import {
  codexAccountIdFromToken,
  emitProviderRouteResolutionDebug,
  imageGenerationEndpoint,
  inspectImageExecutor,
  inspectOfficialRoute,
  inspectRemoteCompactionRoute,
  inspectSidecarExecutor,
  resolveOfficialRoute,
  resolveSidecarRoute,
} from "../src/openai/route.ts";
import { codexModel, model, otherModel } from "./fixtures.ts";

function jwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `e30.${payload}.signature`;
}

describe("official OpenAI route boundary", () => {
  it("emits only fixed provider-route metadata to an injected output", () => {
    const output = vi.fn();
    const record = {
      provider: "openai",
      api: "openai-responses",
      model: "gpt-test",
      feature: "PROTECTED_FEATURE",
      errorCategory: "PROTECTED_CATEGORY",
      error: new Error("PROTECTED_ERROR"),
      token: "PROTECTED_TOKEN",
      headers: { authorization: "PROTECTED_HEADER" },
      accountId: "PROTECTED_ACCOUNT",
      fingerprint: "PROTECTED_FINGERPRINT",
      payload: "PROTECTED_PAYLOAD",
    };
    emitProviderRouteResolutionDebug(record, output);
    expect(output).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        feature: "provider-request",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-test",
        errorCategory: "route-resolution-failed",
      }),
    );
    expect(output.mock.calls[0]![0]).not.toContain("PROTECTED");
  });
  it("accepts canonical API-key and Codex OAuth routes", () => {
    expect(inspectOfficialRoute(model())).toMatchObject({
      ok: true,
      route: { kind: "api-key" },
    });
    expect(inspectOfficialRoute(codexModel())).toMatchObject({
      ok: true,
      route: { kind: "codex-oauth" },
    });
  });

  it("projects only the two exact Images endpoints", () => {
    expect(imageGenerationEndpoint("api-key").href).toBe(
      "https://api.openai.com/v1/images/generations",
    );
    expect(imageGenerationEndpoint("codex-oauth").href).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations",
    );
  });

  it("selects current, then Codex OAuth, then OpenAI API key", () => {
    const apiKey = model();
    const oauth = codexModel();
    const registry = {
      getAvailable: () => [apiKey, oauth],
      isUsingOAuth: (candidate: typeof apiKey) =>
        candidate.provider === "openai-codex",
    };

    expect(inspectImageExecutor(apiKey, registry)).toMatchObject({
      ok: true,
      model: apiKey,
      route: { kind: "api-key" },
    });
    expect(inspectImageExecutor(otherModel(), registry)).toMatchObject({
      ok: true,
      model: oauth,
      route: { kind: "codex-oauth" },
    });
    expect(
      inspectImageExecutor(otherModel(), {
        getAvailable: () => [apiKey],
        isUsingOAuth: () => false,
      }),
    ).toMatchObject({ ok: true, model: apiKey, route: { kind: "api-key" } });
  });

  it("rejects unavailable and mismatched image executors", () => {
    expect(
      inspectImageExecutor(otherModel(), {
        getAvailable: () => [],
        isUsingOAuth: () => false,
      }),
    ).toEqual({ ok: false, reason: "missing-openai-auth" });
    expect(
      inspectImageExecutor(codexModel(), {
        getAvailable: () => [codexModel()],
        isUsingOAuth: () => false,
      }),
    ).toEqual({ ok: false, reason: "credential-mismatch" });
  });

  it("extracts only the refreshed Codex account claim", () => {
    expect(codexAccountIdFromToken(jwt("account-1"))).toBe("account-1");
    expect(codexAccountIdFromToken("not-a-jwt")).toBeUndefined();
    expect(codexAccountIdFromToken("e30.e30.signature")).toBeUndefined();
  });

  it("makes Remote Compaction structurally available only for Codex OAuth", () => {
    expect(
      inspectRemoteCompactionRoute(codexModel(), {
        isUsingOAuth: () => true,
      }),
    ).toMatchObject({ ok: true, route: { kind: "codex-oauth" } });
    expect(
      inspectRemoteCompactionRoute(model(), { isUsingOAuth: () => false }),
    ).toEqual({ ok: false, reason: "unsupported-provider" });
    expect(
      inspectRemoteCompactionRoute(codexModel(), {
        isUsingOAuth: () => false,
      }),
    ).toEqual({ ok: false, reason: "credential-mismatch" });
  });

  it.each([
    ["scheme", "http://api.openai.com/v1"],
    ["look-alike host", "https://api.openai.com.evil.test/v1"],
    ["userinfo", "https://user@api.openai.com/v1"],
    ["port", "https://api.openai.com:8443/v1"],
    ["path", "https://api.openai.com/other"],
    ["query", "https://api.openai.com/v1?redirect=1"],
    ["hash", "https://api.openai.com/v1#fragment"],
  ])("rejects an invalid %s", (_name, baseUrl) => {
    expect(inspectOfficialRoute(model({ baseUrl }))).toEqual({
      ok: false,
      reason: "unofficial-endpoint",
    });
  });

  it.each([
    ["API", { api: "openai-completions" }, "unsupported-api"],
    ["provider", { provider: "openrouter" }, "unsupported-provider"],
  ])("rejects an invalid %s", (_name, overrides, reason) => {
    expect(inspectOfficialRoute(model(overrides))).toEqual({
      ok: false,
      reason,
    });
  });

  // Each official provider accepts only its own Responses API. The check comes
  // before credential resolution, so a cross-paired model never receives a token.
  it.each([
    ["an API-key", model({ api: "openai-codex-responses" })],
    ["a Codex OAuth", codexModel({ api: "openai-responses" })],
  ])(
    "rejects %s model on the other provider's API before resolving credentials",
    async (_name, current) => {
      expect(inspectOfficialRoute(current)).toEqual({
        ok: false,
        reason: "unsupported-api",
      });
      const getApiKeyAndHeaders = vi.fn(async () => ({
        ok: true as const,
        apiKey: "credential",
      }));
      await expect(
        resolveOfficialRoute(
          {
            getApiKeyAndHeaders,
            isUsingOAuth: (candidate) => candidate.provider === "openai-codex",
          },
          current,
        ),
      ).resolves.toEqual({ ok: false, reason: "unsupported-api" });
      expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["scheme", "http://chatgpt.com/backend-api/codex"],
    ["look-alike host", "https://chatgpt.com.evil.test/backend-api/codex"],
    ["userinfo", "https://user@chatgpt.com/backend-api/codex"],
    ["port", "https://chatgpt.com:8443/backend-api/codex"],
    ["path", "https://chatgpt.com/backend-api/other"],
    ["query", "https://chatgpt.com/backend-api/codex?redirect=1"],
    ["hash", "https://chatgpt.com/backend-api/codex#fragment"],
  ])("rejects an invalid Codex OAuth %s", (_name, baseUrl) => {
    expect(inspectOfficialRoute(codexModel({ baseUrl }))).toEqual({
      ok: false,
      reason: "unofficial-endpoint",
    });
  });

  it("resolves refreshed API-key authentication", async () => {
    const current = model();
    const registry = {
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "test-key",
        headers: { "x-safe": "value", removed: null },
      })),
      isUsingOAuth: () => false,
    };
    const resolved = await resolveOfficialRoute(registry, current);
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        token: "test-key",
        headers: { "x-safe": "value", removed: null },
        route: { kind: "api-key" },
      },
    });
  });

  it("resolves a structurally valid Codex OAuth Sidecar route", async () => {
    const current = codexModel();
    const registry = {
      find: () => current,
      getAvailable: () => [current],
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "oauth-token",
      })),
      isUsingOAuth: () => true,
    };
    await expect(
      resolveOfficialRoute(registry, current),
    ).resolves.toMatchObject({
      ok: true,
      value: { route: { kind: "codex-oauth" } },
    });
    await expect(
      resolveSidecarRoute(registry, {
        provider: "openai-codex",
        model: current.id,
        thinkingLevel: "auto",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { route: { kind: "codex-oauth" } },
    });
  });

  it("rechecks Sidecar availability before refreshing authentication", async () => {
    const current = codexModel();
    const getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true as const,
      apiKey: "oauth-token",
    }));

    await expect(
      resolveSidecarRoute(
        {
          find: () => current,
          getAvailable: () => [],
          getApiKeyAndHeaders,
          isUsingOAuth: () => true,
        },
        {
          provider: "openai-codex",
          model: current.id,
          thinkingLevel: "auto",
        },
      ),
    ).resolves.toEqual({ ok: false, reason: "missing-openai-auth" });
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it.each([
    [model(), true],
    [codexModel(), false],
  ])(
    "rejects provider and credential-kind mismatches",
    async (current, oauth) => {
      const registry = {
        getApiKeyAndHeaders: async () => ({
          ok: true as const,
          apiKey: "credential",
        }),
        isUsingOAuth: () => oauth,
      };
      await expect(resolveOfficialRoute(registry, current)).resolves.toEqual({
        ok: false,
        reason: "credential-mismatch",
      });
    },
  );

  it("rejects an authentication base-URL override before dispatch", async () => {
    const registry = {
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: "credential",
        baseUrl: "https://gateway.example/v1",
      }),
      isUsingOAuth: () => false,
    };
    await expect(resolveOfficialRoute(registry, model())).resolves.toEqual({
      ok: false,
      reason: "unofficial-endpoint",
    });
  });

  it("requires an explicit present, authenticated Sidecar executor", () => {
    const current = model();
    const registry = {
      find: vi.fn(() => current),
      getAvailable: vi.fn(() => [current]).mockReturnValueOnce([]),
      isUsingOAuth: () => false,
    };
    expect(inspectSidecarExecutor(null, registry)).toEqual({
      ok: false,
      reason: "missing-sidecar-model",
    });
    expect(
      inspectSidecarExecutor(
        { provider: "openai", model: current.id, thinkingLevel: "auto" },
        registry,
      ),
    ).toEqual({ ok: false, reason: "missing-openai-auth" });
    expect(
      inspectSidecarExecutor(
        { provider: "openai", model: current.id, thinkingLevel: "auto" },
        registry,
      ),
    ).toMatchObject({ ok: true, model: current });
  });

  it("accepts only supported Codex executor effort", () => {
    const current = codexModel({
      id: "gpt-5.4",
      thinkingLevelMap: { xhigh: null, max: null },
    });
    const registry = {
      find: () => current,
      getAvailable: () => [current],
      isUsingOAuth: () => true,
    };
    expect(
      inspectSidecarExecutor(
        {
          provider: "openai-codex",
          model: current.id,
          thinkingLevel: "low",
        },
        registry,
      ),
    ).toMatchObject({
      ok: true,
      model: current,
      route: { kind: "codex-oauth" },
    });
    expect(
      inspectSidecarExecutor(
        {
          provider: "openai-codex",
          model: current.id,
          thinkingLevel: "xhigh",
        },
        registry,
      ),
    ).toEqual({ ok: false, reason: "unsupported-sidecar-effort" });
  });
});
