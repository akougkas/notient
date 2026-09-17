import { describe, expect, test } from "bun:test";
import { probeVisionRoute } from "../../../src/agent/visionProbe";
import { ReasoningScheduler } from "../../../src/core/coordinator/reasoningScheduler";
import type { ChatVisionRequest, LLMProvider } from "../../../src/core/llm/provider";

function makeProviderWithVision(
  supports: boolean,
  onVision?: (request: ChatVisionRequest) => void,
): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {},
    chatJson: async () => ({}) as never,
    embed: async () => [],
    chatVision: supports
      ? async (request) => {
          onVision?.(request);
          return { content: "ok", durationMs: 1 };
        }
      : async () => {
          throw new Error("model does not support vision");
        },
  };
}

describe("probeVisionRoute", () => {
  test("returns the primary router when the primary supports vision", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const labels: Array<string | null> = [];
    const signals: Array<AbortSignal | undefined> = [];
    const route = await probeVisionRoute({
      primaryLLM: makeProviderWithVision(true, (request) => {
        labels.push(scheduler.currentLabel());
        signals.push(request.signal);
      }),
      primaryModel: "qwen2.5-vl",
      visionConfig: { enabled: false, baseUrl: "", model: "" },
      scheduler,
      makeFallback: () => makeProviderWithVision(true),
    });
    expect(route).not.toBeNull();
    const description = await route?.describe({
      path: "x.png",
      bytes: new Uint8Array().buffer,
      mediaType: "image/png",
    });
    expect(description).toBe("ok");
    expect(labels).toEqual(["vision:probe", "vision:describe"]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(scheduler.isBusy()).toBe(false);
  });

  test("falls through to the configured endpoint when primary fails", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const route = await probeVisionRoute({
      primaryLLM: makeProviderWithVision(false),
      primaryModel: "text-only-model",
      visionConfig: { enabled: true, baseUrl: "http://vlm.local", model: "vlm" },
      scheduler,
      makeFallback: () => makeProviderWithVision(true),
    });
    expect(route).not.toBeNull();
  });

  test("returns null when no path works", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const route = await probeVisionRoute({
      primaryLLM: makeProviderWithVision(false),
      primaryModel: "text-only-model",
      visionConfig: { enabled: false, baseUrl: "", model: "" },
      scheduler,
      makeFallback: () => makeProviderWithVision(false),
    });
    expect(route).toBeNull();
  });
});
