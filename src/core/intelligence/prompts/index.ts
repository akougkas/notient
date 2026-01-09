/**
 * Intelligence 2.0 Prompt Registry
 *
 * Central registry for all specialized agent prompts.
 * Each prompt includes system instructions, user template, and output schema.
 *
 * Prompts are now profile-aware: they use the base identity layer
 * and can adapt to user's domain expertise.
 */

import type { UserProfile } from "../../../types/profile";
import { buildBaseIdentity } from "../../agent/identity";
import { ATOMIC_SPLIT_PROMPT, buildAtomicSplitPrompt } from "./atomic";
import { BRAND_CHECK_PROMPT, buildBrandCheckPrompt } from "./brand";
import { CLIPPING_PROMPT, buildClippingPrompt } from "./clipping";
import { CONNECTION_PROMPT, buildConnectionPrompt } from "./connection";
import { ENHANCE_PROMPT, buildEnhancePrompt } from "./enhance";
import { SYNTHESIS_PROMPT, buildSynthesisPrompt } from "./synthesis";
import { TASK_EXTRACTION_PROMPT, buildTaskExtractionPrompt } from "./task";
import { ANTAGONIST_PROMPT, buildAntagonistPrompt } from "./antagonist";

/**
 * Intelligence 2.0 action types
 */
export type IntelligenceActionType =
  | "atomic"
  | "synthesis"
  | "clipping"
  | "task"
  | "brand"
  | "connection"
  | "enhance"
  | "antagonist";

/**
 * Structure for agent prompts
 */
export interface AgentPrompt {
  /** System prompt for the LLM */
  system: string;
  /** User prompt template (with placeholders) */
  userTemplate: string;
  /** Expected output schema (for validation) */
  outputSchema: object;
  /** Example outputs (few-shot) */
  examples?: Array<{
    input: string;
    output: string;
  }>;
  /** Temperature override */
  temperature?: number;
  /** Max tokens override */
  maxTokens?: number;
}

/**
 * Central registry of all specialized agent prompts (static versions)
 */
export const AGENT_PROMPTS: Record<IntelligenceActionType, AgentPrompt> = {
  atomic: ATOMIC_SPLIT_PROMPT,
  synthesis: SYNTHESIS_PROMPT,
  clipping: CLIPPING_PROMPT,
  task: TASK_EXTRACTION_PROMPT,
  brand: BRAND_CHECK_PROMPT,
  connection: CONNECTION_PROMPT,
  enhance: ENHANCE_PROMPT,
  antagonist: ANTAGONIST_PROMPT,
};

/**
 * Get a prompt by action type (static version, for backward compatibility)
 */
export function getPrompt(actionType: IntelligenceActionType): AgentPrompt {
  const prompt = AGENT_PROMPTS[actionType];
  if (!prompt) {
    throw new Error(`Unknown action type: ${actionType}`);
  }
  return prompt;
}

/**
 * Get a profile-aware prompt by action type
 * This is the preferred method for getting prompts with the identity system
 *
 * @param actionType - The type of intelligence action
 * @param profile - Optional user profile for domain adaptation
 * @returns AgentPrompt with profile-adapted system prompt
 */
export function getProfileAwarePrompt(
  actionType: IntelligenceActionType,
  profile?: UserProfile,
): AgentPrompt {
  const basePrompt = AGENT_PROMPTS[actionType];
  if (!basePrompt) {
    throw new Error(`Unknown action type: ${actionType}`);
  }

  // Get the profile-aware system prompt
  const systemPrompt = buildProfileAwareSystemPrompt(actionType, profile);

  return {
    ...basePrompt,
    system: systemPrompt,
  };
}

/**
 * Build a profile-aware system prompt for the given action type
 */
function buildProfileAwareSystemPrompt(
  actionType: IntelligenceActionType,
  profile?: UserProfile,
): string {
  switch (actionType) {
    case "atomic":
      return buildAtomicSplitPrompt(profile);
    case "synthesis":
      return buildSynthesisPrompt(profile);
    case "clipping":
      return buildClippingPrompt(profile);
    case "task":
      return buildTaskExtractionPrompt(profile);
    case "brand":
      return buildBrandCheckPrompt(profile);
    case "connection":
      return buildConnectionPrompt(profile);
    case "enhance":
      return buildEnhancePrompt(profile);
    case "antagonist":
      return buildAntagonistPrompt(profile);
  }
  // TypeScript exhaustiveness check - this should never be reached
  const _exhaustiveCheck: never = actionType;
  return "";
}

// Re-export all prompts and builders
export { ATOMIC_SPLIT_PROMPT, buildAtomicSplitPrompt } from "./atomic";
export { BRAND_CHECK_PROMPT, buildBrandCheckPrompt } from "./brand";
export { CLIPPING_PROMPT, buildClippingPrompt } from "./clipping";
export { CONNECTION_PROMPT, buildConnectionPrompt } from "./connection";
export { ENHANCE_PROMPT, buildEnhancePrompt } from "./enhance";
export { SYNTHESIS_PROMPT, buildSynthesisPrompt } from "./synthesis";
export { TASK_EXTRACTION_PROMPT, buildTaskExtractionPrompt } from "./task";

// Export utility for building base identity (for custom prompts)
export { buildBaseIdentity };
