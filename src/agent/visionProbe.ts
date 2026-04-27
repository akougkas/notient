/**
 * Vision routing probe.
 *
 * Bootstrap calls `probeVisionRoute` once at startup. The probe attempts a
 * 1x1 PNG round-trip against the primary LM Studio model first. If the
 * primary lacks vision support, the probe falls through to the configured
 * `chat.vision` endpoint (when enabled). Returns null when neither path is
 * viable; chat.send then refuses image attachments with VISION_UNAVAILABLE.
 */

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
  if (typeof options.primaryLLM.chatVision === "function") {
    try {
      await options.primaryLLM.chatVision({
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
      });
      return makeRouter(options.primaryLLM, options.primaryModel);
    } catch {
      // Primary lacks vision; fall through to the configured fallback.
    }
  }
  if (options.visionConfig.enabled && options.visionConfig.baseUrl.length > 0) {
    const fallback = options.makeFallback();
    if (typeof fallback.chatVision === "function") {
      try {
        await fallback.chatVision({
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
        });
        return makeRouter(fallback, options.visionConfig.model);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function makeRouter(provider: LLMProvider, model: string): VisionRouter {
  return {
    async describe(image) {
      if (typeof provider.chatVision !== "function") {
        throw new Error("VISION_UNAVAILABLE: provider does not implement chatVision");
      }
      const dataUrl = bytesToDataUrl(image.bytes, image.mediaType);
      const result = await provider.chatVision({
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
      });
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
