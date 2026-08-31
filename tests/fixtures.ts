import type { Model } from "@earendil-works/pi-ai";

export function model(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    id: "gpt-5",
    name: "GPT-5",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

export function codexModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return model({
    id: "gpt-5-codex",
    name: "GPT-5 Codex",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    ...overrides,
  });
}

export function otherModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return model({
    id: "claude",
    name: "Claude",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    ...overrides,
  });
}
