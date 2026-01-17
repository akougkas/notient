/**
 * Settings UI types for Notient
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G6)
 */

import type { LLMProviderConfig } from "../../types";

/** Provider type options for settings dropdowns */
export type ProviderType = LLMProviderConfig["type"];

/** Connection test result */
export interface ConnectionTestResult {
  success: boolean;
  error?: string;
  latencyMs?: number;
}

/** Wizard step identifiers */
export type WizardStep =
  | "reasoning-provider"
  | "embedding-provider"
  | "test-connections"
  | "index-options";

/** Wizard state for tracking progress */
export interface WizardState {
  currentStep: WizardStep;
  reasoningTested: boolean;
  embeddingTested: boolean;
  canProceed: boolean;
}
