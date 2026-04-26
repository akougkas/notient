/**
 * LLM Module Barrel Export
 * Source of truth: .planning/PHASE-GALAXY.md (Phase D4)
 */

export type { CompletionOptions, LLMProvider } from "./provider";
export { LMStudioProvider } from "./lmstudio";
export { OllamaProvider } from "./ollama";
export { checkLLMHealth } from "./healthCheck";
export type { LLMHealthStatus } from "./healthCheck";
