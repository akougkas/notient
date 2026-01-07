/**
 * LM Studio Provider
 *
 * Thin wrapper over OpenAI-compatible provider for LM Studio specifics.
 * Contains ONLY configuration and LM Studio-specific quirks, no Notient logic.
 */

import { OpenAICompatibleProvider } from "./openai-compatible";

/**
 * LM Studio specific provider
 *
 * Currently just sets the provider name, but can be extended if
 * LM Studio introduces API differences from standard OpenAI format.
 */
export class LMStudioProvider extends OpenAICompatibleProvider {
  constructor(host: string, model: string) {
    super(host, model, "lmstudio");
  }

  // Override methods here if LM Studio introduces quirks
}
