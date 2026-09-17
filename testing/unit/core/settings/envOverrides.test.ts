import { describe, expect, test } from "bun:test";
import {
  mergeEnvSources,
  resolveProviderCredentials,
  resolveSettings,
} from "../../../../src/core/settings/envOverrides";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_NOTIENT_CONFIG,
  DEFAULT_REASONING_SLOTS,
} from "../../../../src/core/settings/types";

describe("deployment environment authority", () => {
  test("resolves every deployment field from env without persisted overlap", () => {
    const result = resolveSettings(DEFAULT_NOTIENT_CONFIG, {
      NOTIENT_LLM_BASE_URL: "http://reasoning:1234/v1",
      NOTIENT_EMBED_BASE_URL: "http://embedding:8080/v1",
      NOTIENT_LLM_MODEL: "reasoning-model",
      NOTIENT_EMBED_MODEL: "embedding-model",
      NOTIENT_CONTEXT_TOKENS: "800000",
      NOTIENT_REASONING_SLOTS: "3",
    });

    expect(result.primary).toEqual({
      baseUrl: "http://reasoning:1234/v1",
      reasoningModel: "reasoning-model",
    });
    expect(result.deep).toEqual({
      baseUrl: "http://reasoning:1234/v1",
      reasoningModel: "reasoning-model",
      rerankerModel: "reasoning-model",
    });
    expect(result.embedding).toEqual({
      baseUrl: "http://embedding:8080/v1",
      model: "embedding-model",
    });
    expect(result.chat.modelContextTokens).toBe(800000);
    expect(result.chat.reasoningSlots).toBe(3);
  });

  test("embedding endpoint falls back to the reasoning endpoint", () => {
    const result = resolveSettings(DEFAULT_NOTIENT_CONFIG, {
      NOTIENT_LLM_BASE_URL: "http://one-endpoint/v1",
    });
    expect(result.embedding.baseUrl).toBe("http://one-endpoint/v1");
  });

  test("context and slot capacity use canonical deployment defaults when absent", () => {
    const result = resolveSettings(DEFAULT_NOTIENT_CONFIG, {});
    expect(result.chat.modelContextTokens).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(result.chat.reasoningSlots).toBe(DEFAULT_REASONING_SLOTS);
  });

  test("resolves private chat and embedding bearer credentials outside public settings", () => {
    const env = {
      NOTIENT_LLM_BASE_URL: "https://compatible.example/v1",
      NOTIENT_LLM_API_KEY: "sk-chat_123",
      NOTIENT_EMBED_API_KEY: "embed-token_456",
    };
    expect(resolveProviderCredentials(env)).toEqual({
      chatApiKey: "sk-chat_123",
      embeddingApiKey: "embed-token_456",
    });
    expect(JSON.stringify(resolveSettings(DEFAULT_NOTIENT_CONFIG, env))).not.toContain("sk-chat");
    expect(JSON.stringify(resolveSettings(DEFAULT_NOTIENT_CONFIG, env))).not.toContain(
      "embed-token",
    );
  });

  test("embedding auth inherits chat auth only when its own key is absent", () => {
    expect(resolveProviderCredentials({ NOTIENT_LLM_API_KEY: "shared-token" })).toEqual({
      chatApiKey: "shared-token",
      embeddingApiKey: "shared-token",
    });
    expect(
      resolveProviderCredentials({
        NOTIENT_LLM_API_KEY: "cloud-token",
        NOTIENT_EMBED_API_KEY: "",
      }),
    ).toEqual({ chatApiKey: "cloud-token" });
  });

  test("rejects malformed bearer credentials without echoing the secret", () => {
    const malformed = "secret with spaces";
    let thrown: unknown;
    try {
      resolveProviderCredentials({ NOTIENT_LLM_API_KEY: malformed });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("NOTIENT_LLM_API_KEY");
    expect((thrown as Error).message).not.toContain(malformed);
  });

  test("vault file values win and process env fills only absent keys", () => {
    const result = mergeEnvSources(
      {
        NOTIENT_LLM_BASE_URL: "http://vault/v1",
        NOTIENT_LLM_MODEL: "vault-model",
      },
      {
        NOTIENT_LLM_BASE_URL: "http://process/v1",
        NOTIENT_LLM_MODEL: "process-model",
        NOTIENT_EMBED_MODEL: "process-embed",
      },
    );
    expect(result).toEqual({
      NOTIENT_LLM_BASE_URL: "http://vault/v1",
      NOTIENT_LLM_MODEL: "vault-model",
      NOTIENT_EMBED_MODEL: "process-embed",
    });
  });

  test("an explicit empty vault value masks ambient process configuration", () => {
    const result = mergeEnvSources(
      { NOTIENT_LLM_MODEL: "" },
      { NOTIENT_LLM_MODEL: "ambient-model", NOTIENT_EMBED_MODEL: "ambient-embed" },
    );
    expect(result.NOTIENT_LLM_MODEL).toBeUndefined();
    expect(result.NOTIENT_EMBED_MODEL).toBe("ambient-embed");
  });

  test("an explicit empty vault embedding key masks ambient auth and disables inheritance", () => {
    const result = mergeEnvSources(
      { NOTIENT_EMBED_API_KEY: "" },
      {
        NOTIENT_LLM_API_KEY: "chat-token",
        NOTIENT_EMBED_API_KEY: "ambient-embed-token",
      },
    );
    expect(result.NOTIENT_EMBED_API_KEY).toBe("");
    expect(resolveProviderCredentials(result)).toEqual({
      chatApiKey: "chat-token",
    });
  });

  test.each(["4junk", "4.5", "+4", "04", "0", "-5", "NaN"])(
    "rejects non-canonical NOTIENT_REASONING_SLOTS value %s",
    (value) => {
      expect(() =>
        resolveSettings(DEFAULT_NOTIENT_CONFIG, { NOTIENT_REASONING_SLOTS: value }),
      ).toThrow("NOTIENT_REASONING_SLOTS");
    },
  );

  test.each(["800000junk", "1.25", "0", "-1", "10000001"])(
    "rejects invalid NOTIENT_CONTEXT_TOKENS value %s",
    (value) => {
      expect(() =>
        resolveSettings(DEFAULT_NOTIENT_CONFIG, { NOTIENT_CONTEXT_TOKENS: value }),
      ).toThrow("NOTIENT_CONTEXT_TOKENS");
    },
  );

  test("does not mutate validated product config", () => {
    const before = JSON.stringify(DEFAULT_NOTIENT_CONFIG);
    resolveSettings(DEFAULT_NOTIENT_CONFIG, { NOTIENT_LLM_MODEL: "x" });
    expect(JSON.stringify(DEFAULT_NOTIENT_CONFIG)).toBe(before);
  });
});
