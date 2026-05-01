import { describe, expect, test } from "bun:test";
import type { LLMProvider } from "../../../src/core/llm/provider";
import { probeVisionRoute } from "../../../src/agent/visionProbe";

function makeProviderWithVision(supports: boolean): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {},
    chatJson: async () => ({}) as never,
    embed: async () => [],
    chatVision: supports
      ? async () => ({ content: "ok", durationMs: 1 })
      : async () => {
          throw new Error("model does not support vision");
        },
  };
}

describe("probeVisionRoute", () => {
  test("returns the primary router when the primary supports vision", async () => {
    const route = await probeVisionRoute({
      primaryLLM: makeProviderWithVision(true),
      primaryModel: "qwen2.5-vl",
      visionConfig: { enabled: false, baseUrl: "", model: "" },
      makeFallback: () => makeProviderWithVision(true),
    });
    expect(route).not.toBeNull();
    const description = await route?.describe({
      path: "x.png",
      bytes: new Uint8Array().buffer,
      mediaType: "image/png",
    });
    expect(description).toBe("ok");
  });

  test("falls through to the configured endpoint when primary fails", async () => {
    const route = await probeVisionRoute({
      primaryLLM: makeProviderWithVision(false),
      primaryModel: "text-only-model",
      visionConfig: { enabled: true, baseUrl: "http://vlm.local", model: "vlm" },
      makeFallback: () => makeProviderWithVision(true),
    });
    expect(route).not.toBeNull();
  });

  test("returns null when no path works", async () => {
    const route = await probeVisionRoute({
      primaryLLM: makeProviderWithVision(false),
      primaryModel: "text-only-model",
      visionConfig: { enabled: false, baseUrl: "", model: "" },
      makeFallback: () => makeProviderWithVision(false),
    });
    expect(route).toBeNull();
  });
});
