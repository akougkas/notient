import { describe, expect, test } from "bun:test";
import { applyEnvOverrides } from "../../../../src/core/settings/envOverrides";
import { DEFAULT_SETTINGS } from "../../../../src/core/settings/types";

describe("applyEnvOverrides", () => {
  test("returns the same reference when no env keys are present", () => {
    const result = applyEnvOverrides(DEFAULT_SETTINGS, {});
    expect(result).toBe(DEFAULT_SETTINGS);
  });

  test("NOTIENT_LLM_BASE_URL overrides primary, deep, and embedding base URLs", () => {
    const result = applyEnvOverrides(DEFAULT_SETTINGS, {
      NOTIENT_LLM_BASE_URL: "http://192.168.86.143:1234/v1",
    });
    expect(result.primary.baseUrl).toBe("http://192.168.86.143:1234/v1");
    expect(result.deep.baseUrl).toBe("http://192.168.86.143:1234/v1");
    expect(result.embedding.baseUrl).toBe("http://192.168.86.143:1234/v1");
  });

  test("NOTIENT_LLM_MODEL overrides every chat-style model slot", () => {
    const result = applyEnvOverrides(DEFAULT_SETTINGS, { NOTIENT_LLM_MODEL: "test-model" });
    expect(result.primary.reasoningModel).toBe("test-model");
    expect(result.primary.fastModel).toBe("test-model");
    expect(result.primary.rerankerModel).toBe("test-model");
    expect(result.deep.reasoningModel).toBe("test-model");
    expect(result.deep.fastModel).toBe("test-model");
    expect(result.deep.rerankerModel).toBe("test-model");
    expect(result.coAuthor.model).toBe("test-model");
  });

  test("NOTIENT_EMBED_MODEL overrides embedding slots", () => {
    const result = applyEnvOverrides(DEFAULT_SETTINGS, {
      NOTIENT_EMBED_MODEL: "text-embed",
    });
    expect(result.embedding.model).toBe("text-embed");
    expect(result.primary.embeddingModel).toBe("text-embed");
    expect(result.deep.embeddingModel).toBe("text-embed");
  });

  test("NOTIENT_CONTEXT_TOKENS sets chat.modelContextTokens when a positive integer", () => {
    const result = applyEnvOverrides(DEFAULT_SETTINGS, {
      NOTIENT_CONTEXT_TOKENS: "800000",
    });
    expect(result.chat.modelContextTokens).toBe(800000);
  });

  test("NOTIENT_REASONING_SLOTS sets chat.reasoningSlots when a positive integer", () => {
    const result = applyEnvOverrides(DEFAULT_SETTINGS, {
      NOTIENT_REASONING_SLOTS: "4",
    });
    expect(result.chat.reasoningSlots).toBe(4);
  });

  test("NOTIENT_CONTEXT_TOKENS leaves the persisted value alone when not a positive integer", () => {
    const original = DEFAULT_SETTINGS.chat.modelContextTokens;
    expect(
      applyEnvOverrides(DEFAULT_SETTINGS, { NOTIENT_CONTEXT_TOKENS: "" }).chat.modelContextTokens,
    ).toBe(original);
    expect(
      applyEnvOverrides(DEFAULT_SETTINGS, { NOTIENT_CONTEXT_TOKENS: "abc" }).chat
        .modelContextTokens,
    ).toBe(original);
    expect(
      applyEnvOverrides(DEFAULT_SETTINGS, { NOTIENT_CONTEXT_TOKENS: "0" }).chat.modelContextTokens,
    ).toBe(original);
    expect(
      applyEnvOverrides(DEFAULT_SETTINGS, { NOTIENT_CONTEXT_TOKENS: "-5" }).chat.modelContextTokens,
    ).toBe(original);
  });

  test("NOTIENT_REASONING_SLOTS leaves the persisted value alone when not a positive integer", () => {
    const original = DEFAULT_SETTINGS.chat.reasoningSlots;
    expect(
      applyEnvOverrides(DEFAULT_SETTINGS, { NOTIENT_REASONING_SLOTS: "" }).chat.reasoningSlots,
    ).toBe(original);
    expect(
      applyEnvOverrides(DEFAULT_SETTINGS, { NOTIENT_REASONING_SLOTS: "abc" }).chat.reasoningSlots,
    ).toBe(original);
    expect(
      applyEnvOverrides(DEFAULT_SETTINGS, { NOTIENT_REASONING_SLOTS: "0" }).chat.reasoningSlots,
    ).toBe(original);
    expect(
      applyEnvOverrides(DEFAULT_SETTINGS, { NOTIENT_REASONING_SLOTS: "-5" }).chat.reasoningSlots,
    ).toBe(original);
  });

  test("ignores empty-string env values", () => {
    const result = applyEnvOverrides(DEFAULT_SETTINGS, {
      NOTIENT_LLM_BASE_URL: "   ",
      NOTIENT_LLM_MODEL: "",
    });
    expect(result.primary.baseUrl).toBe(DEFAULT_SETTINGS.primary.baseUrl);
    expect(result.primary.reasoningModel).toBe(DEFAULT_SETTINGS.primary.reasoningModel);
  });

  test("multiple overrides compose without losing fields", () => {
    const result = applyEnvOverrides(DEFAULT_SETTINGS, {
      NOTIENT_LLM_BASE_URL: "http://h:1/v1",
      NOTIENT_LLM_MODEL: "m1",
      NOTIENT_EMBED_MODEL: "e1",
      NOTIENT_CONTEXT_TOKENS: "12345",
      NOTIENT_REASONING_SLOTS: "3",
    });
    expect(result.primary.baseUrl).toBe("http://h:1/v1");
    expect(result.primary.reasoningModel).toBe("m1");
    expect(result.embedding.model).toBe("e1");
    expect(result.chat.modelContextTokens).toBe(12345);
    expect(result.chat.reasoningSlots).toBe(3);
    // Untouched fields survive.
    expect(result.chat.maxRoundsPerTurn).toBe(DEFAULT_SETTINGS.chat.maxRoundsPerTurn);
    expect(result.search.defaultMode).toBe(DEFAULT_SETTINGS.search.defaultMode);
  });

  test("does not mutate the input settings", () => {
    const before = JSON.stringify(DEFAULT_SETTINGS);
    applyEnvOverrides(DEFAULT_SETTINGS, { NOTIENT_LLM_MODEL: "x" });
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
  });
});
