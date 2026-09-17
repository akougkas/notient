/**
 * Vision routing probe.
 *
 * Bootstrap calls `probeVisionRoute` once at startup. The probe attempts a
 * 1x1 PNG round-trip against the primary LM Studio model first. If the
 * primary lacks vision support, an optional caller-supplied fallback may be
 * probed. Production bootstrap has one deployment authority and disables that
 * fallback. Returns null when no route is viable; chat.send then refuses image
 * attachments with VISION_UNAVAILABLE.
 */

import type { ReasoningScheduler } from "../core/coordinator/reasoningScheduler";
import type { LLMProvider } from "../core/llm/provider";

export interface VisionImage {
  path: string;
  bytes: ArrayBuffer;
  mediaType: string;
}

export interface VisionRouter {
  describe(image: VisionImage): Promise<string>;
}

export interface VisionConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
}

export interface ProbeVisionRouteOptions {
  primaryLLM: LLMProvider;
  primaryModel: string;
  visionConfig: VisionConfig;
  scheduler: ReasoningScheduler;
  /**
   * Factory for the fallback provider. Bootstrap supplies a closure that
   * constructs a fresh LMStudioProvider against `visionConfig.baseUrl`.
   * Threaded as a callback so this module does not depend on
   * LMStudioProvider directly (keeps the agent module decoupled from
   * concrete providers).
   */
  makeFallback: () => LLMProvider;
}

const PROBE_IMAGE = makeProbeDataUrl();

export async function probeVisionRoute(
  options: ProbeVisionRouteOptions,
): Promise<VisionRouter | null> {
  const primaryChatVision = options.primaryLLM.chatVision;
  if (typeof primaryChatVision === "function") {
    try {
      await options.scheduler.run("vision:probe", (signal) =>
        primaryChatVision.call(options.primaryLLM, {
          model: options.primaryModel,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "respond with the single word: ok" },
                { type: "image_url", image_url: { url: PROBE_IMAGE } },
              ],
            },
          ],
          maxTokens: 8,
          signal,
        }),
      );
      return makeRouter(options.primaryLLM, options.primaryModel, options.scheduler);
    } catch {
      // Primary lacks vision; fall through to the configured fallback.
    }
  }
  if (options.visionConfig.enabled && options.visionConfig.baseUrl.length > 0) {
    const fallback = options.makeFallback();
    const fallbackChatVision = fallback.chatVision;
    if (typeof fallbackChatVision === "function") {
      try {
        await options.scheduler.run("vision:probe", (signal) =>
          fallbackChatVision.call(fallback, {
            model: options.visionConfig.model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "respond with the single word: ok" },
                  { type: "image_url", image_url: { url: PROBE_IMAGE } },
                ],
              },
            ],
            maxTokens: 8,
            signal,
          }),
        );
        return makeRouter(fallback, options.visionConfig.model, options.scheduler);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function makeRouter(
  provider: LLMProvider,
  model: string,
  scheduler: ReasoningScheduler,
): VisionRouter {
  const chatVision = provider.chatVision;
  if (typeof chatVision !== "function") {
    throw new Error("makeRouter requires a vision-capable provider");
  }
  return {
    async describe(image) {
      const dataUrl = bytesToDataUrl(image.bytes, image.mediaType);
      const result = await scheduler.run("vision:describe", (signal) =>
        chatVision.call(provider, {
          model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Describe the image at ${image.path} in 2-3 sentences. Be concrete; avoid value judgements.`,
                },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
          maxTokens: 256,
          signal,
        }),
      );
      return result.content;
    },
  };
}

function bytesToDataUrl(bytes: ArrayBuffer, mediaType: string): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index++) {
    binary += String.fromCharCode(view[index]);
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
}

function makeProbeDataUrl(): string {
  // 1x1 transparent PNG. Smallest legal probe.
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
}
