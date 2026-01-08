/**
 * Intelligence 2.0 Prompt Registry
 *
 * Central registry for all specialized agent prompts.
 * Each prompt includes system instructions, user template, and output schema.
 */

import { ATOMIC_SPLIT_PROMPT } from "./atomic";
import { BRAND_CHECK_PROMPT } from "./brand";
import { CLIPPING_PROMPT } from "./clipping";
import { CONNECTION_PROMPT } from "./connection";
import { ENHANCE_PROMPT } from "./enhance";
import { SYNTHESIS_PROMPT } from "./synthesis";
import { TASK_EXTRACTION_PROMPT } from "./task";

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
  | "enhance";

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
 * Central registry of all specialized agent prompts
 */
export const AGENT_PROMPTS: Record<IntelligenceActionType, AgentPrompt> = {
  atomic: ATOMIC_SPLIT_PROMPT,
  synthesis: SYNTHESIS_PROMPT,
  clipping: CLIPPING_PROMPT,
  task: TASK_EXTRACTION_PROMPT,
  brand: BRAND_CHECK_PROMPT,
  connection: CONNECTION_PROMPT,
  enhance: ENHANCE_PROMPT,
};

/**
 * Get a prompt by action type
 */
export function getPrompt(actionType: IntelligenceActionType): AgentPrompt {
  const prompt = AGENT_PROMPTS[actionType];
  if (!prompt) {
    throw new Error(`Unknown action type: ${actionType}`);
  }
  return prompt;
}

// Re-export all prompts
export { ATOMIC_SPLIT_PROMPT } from "./atomic";
export { BRAND_CHECK_PROMPT } from "./brand";
export { CLIPPING_PROMPT } from "./clipping";
export { CONNECTION_PROMPT } from "./connection";
export { ENHANCE_PROMPT } from "./enhance";
export { SYNTHESIS_PROMPT } from "./synthesis";
export { TASK_EXTRACTION_PROMPT } from "./task";
