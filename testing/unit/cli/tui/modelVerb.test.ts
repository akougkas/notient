import { describe, expect, test } from "bun:test";
import {
  buildModelView,
  formatModelList,
  formatModelView,
} from "../../../../src/cli/tui/modelVerb";
import { resolveSettings } from "../../../../src/core/settings/envOverrides";
import { DEFAULT_NOTIENT_CONFIG } from "../../../../src/core/settings/types";

const SETTINGS = resolveSettings(DEFAULT_NOTIENT_CONFIG, {});

describe("buildModelView", () => {
  test("projects the relevant slots out of resolved boot settings", () => {
    const view = buildModelView(SETTINGS);
    expect(view.endpoint).toBe(SETTINGS.primary.baseUrl);
    expect(view.chatModel).toBe(SETTINGS.primary.reasoningModel);
    expect(view.embedModel).toBe(SETTINGS.embedding.model);
    expect(view.contextTokens).toBe(SETTINGS.chat.modelContextTokens);
    expect(view.reasoningSlots).toBe(SETTINGS.chat.reasoningSlots);
    expect(view.requestedTotalContextTokens).toBe(
      SETTINGS.chat.modelContextTokens * SETTINGS.chat.reasoningSlots,
    );
  });
});

describe("formatModelView", () => {
  test("formats the four lines in a stable order", () => {
    const text = formatModelView({
      endpoint: "http://h:1/v1",
      chatModel: "m",
      embedModel: "e",
      contextTokens: 200000,
      reasoningSlots: 4,
      requestedTotalContextTokens: 800000,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("model:    m");
    expect(lines[1]).toBe("embed:    e");
    expect(lines[2]).toBe("endpoint: http://h:1/v1");
    expect(lines[3]).toBe("context:  200,000 tok");
    expect(lines[4]).toBe("slots:    4 (800,000 tok total)");
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

  test("orders unknown load state between loaded and unavailable models", () => {
    const text = formatModelList([
      { id: "cold", type: "llm", state: "not-loaded" },
      { id: "opaque", type: "unknown", state: "unknown" },
      { id: "hot", type: "llm", state: "loaded", loadedContextLength: 8192 },
    ]);
    const lines = text.split("\n");
    expect(lines[2]).toContain("hot");
    expect(lines[3]).toContain("opaque");
    expect(lines[4]).toContain("cold");
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
