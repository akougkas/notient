/**
 * LLM Health Check
 * Verifies connectivity to LLM providers
 * Source of truth: .planning/PHASE-GALAXY.md (Phase D4)
 */

import type { NotientSettings } from "../../types";
import { LMStudioProvider } from "./lmstudio";
import { OllamaProvider } from "./ollama";

/**
 * Health check result for LLM providers.
 */
export interface LLMHealthStatus {
  /** Reasoning provider (LM Studio) is reachable */
  reasoning: boolean;
  /** Embedding provider (Ollama) is reachable */
  embedding: boolean;
}

/**
 * Check connectivity to configured LLM providers.
 *
 * @param settings - Notient settings with provider configs
 * @returns Health status for each provider
 */
export async function checkLLMHealth(settings: NotientSettings): Promise<LLMHealthStatus> {
  const reasoningProvider = new LMStudioProvider(settings.reasoningProvider);
  const embeddingProvider = new OllamaProvider(settings.embeddingProvider);

  const [reasoning, embedding] = await Promise.all([
    reasoningProvider.isAvailable(),
    embeddingProvider.isAvailable(),
  ]);

  return { reasoning, embedding };
}
