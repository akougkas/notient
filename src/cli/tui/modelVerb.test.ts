import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../core/settings/types";
import {
  buildEndpointPatch,
  buildModelView,
  buildUseEmbedPatch,
  buildUseModelPatch,
  formatModelList,
  formatModelView,
} from "./modelVerb";

describe("buildModelView", () => {
  test("projects the relevant slots out of the persisted settings", () => {
    const view = buildModelView(DEFAULT_SETTINGS);
    expect(view.endpoint).toBe(DEFAULT_SETTINGS.primary.baseUrl);
    expect(view.chatModel).toBe(DEFAULT_SETTINGS.primary.reasoningModel);
    expect(view.embedModel).toBe(DEFAULT_SETTINGS.embedding.model);
    expect(view.contextTokens).toBe(DEFAULT_SETTINGS.chat.modelContextTokens);
  });
});

describe("formatModelView", () => {
  test("formats the four lines in a stable order", () => {
    const text = formatModelView({
      endpoint: "http://h:1/v1",
      chatModel: "m",
      embedModel: "e",
      contextTokens: 200000,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("model:    m");
    expect(lines[1]).toBe("embed:    e");
    expect(lines[2]).toBe("endpoint: http://h:1/v1");
    expect(lines[3]).toBe("context:  200,000 tok");
  });
});

describe("buildUseModelPatch", () => {
  test("touches every reasoning slot and the co-author model", () => {
    const patch = buildUseModelPatch("omni");
    expect(patch.primary).toEqual({
      reasoningModel: "omni",
      fastModel: "omni",
      rerankerModel: "omni",
    } as never);
    expect(patch.deep).toEqual({
      reasoningModel: "omni",
      fastModel: "omni",
      rerankerModel: "omni",
    } as never);
    expect(patch.coAuthor).toEqual({ model: "omni" } as never);
  });

  test("does not touch endpoint or embedding", () => {
    const patch = buildUseModelPatch("omni");
    expect(patch.embedding).toBeUndefined();
    expect((patch.primary as Record<string, unknown> | undefined)?.baseUrl).toBeUndefined();
  });
});

describe("buildUseEmbedPatch", () => {
  test("sets the embed model in all three blocks", () => {
    const patch = buildUseEmbedPatch("text-e1");
    expect((patch.primary as Record<string, unknown> | undefined)?.embeddingModel).toBe("text-e1");
    expect((patch.deep as Record<string, unknown> | undefined)?.embeddingModel).toBe("text-e1");
    expect(patch.embedding).toEqual({ model: "text-e1" } as never);
  });
});

describe("buildEndpointPatch", () => {
  test("sets baseUrl on primary, deep, and embedding", () => {
    const patch = buildEndpointPatch("http://new:1/v1");
    expect((patch.primary as Record<string, unknown> | undefined)?.baseUrl).toBe("http://new:1/v1");
    expect((patch.deep as Record<string, unknown> | undefined)?.baseUrl).toBe("http://new:1/v1");
    expect((patch.embedding as Record<string, unknown> | undefined)?.baseUrl).toBe(
      "http://new:1/v1",
    );
  });
});

describe("formatModelList", () => {
  test("returns a friendly string when no models reported", () => {
    expect(formatModelList([])).toBe("no models reported by endpoint.");
  });

  test("pins loaded models to the top regardless of id sort order", () => {
    const text = formatModelList([
      { id: "z-not-loaded", type: "llm", state: "not-loaded" },
      { id: "a-loaded", type: "llm", state: "loaded", loadedContextLength: 100000 },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toContain("id");
    expect(lines[2]).toContain("a-loaded");
    expect(lines[3]).toContain("z-not-loaded");
  });

  test("renders loaded context as humanized k-tokens", () => {
    const text = formatModelList([
      { id: "x", type: "llm", state: "loaded", loadedContextLength: 800000 },
    ]);
    expect(text).toContain("800K");
  });

  test("renders the M suffix at the million mark", () => {
    const text = formatModelList([
      { id: "x", type: "llm", state: "loaded", loadedContextLength: 1_048_576 },
    ]);
    expect(text).toContain("1.0M");
  });

  test("falls back to '<n> max' for not-loaded models that report a max", () => {
    const text = formatModelList([
      { id: "x", type: "llm", state: "not-loaded", maxContextLength: 262144 },
    ]);
    expect(text).toContain("262K max");
  });

  test("renders '-' when neither loaded nor max context is known", () => {
    const text = formatModelList([{ id: "x", type: "llm", state: "not-loaded" }]);
    expect(text).toContain(" - ");
  });
});
