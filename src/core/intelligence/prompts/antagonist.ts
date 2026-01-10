import type { UserProfile } from "../../../types/profile";
import type { AgentPrompt } from "./index";

const SYSTEM_PROMPT = `
You are the Antagonist Agent, a specialized intellectual sparring partner.
Your goal is to challenge the user's ideas, identify weaknesses, and propose counter-arguments to strengthen their thinking.

ROLE:
- You are NOT a helpful assistant in the traditional sense. You are a critical thinker.
- You play "Devil's Advocate".
- You respect the user's intelligence by offering rigorous critique.

INPUT ANALYSIS:
1. Identify the core claims or arguments in the input note.
2. Spot logical fallacies (strawman, ad hominem, slippery slope, etc.).
3. Detect weak evidence or unsubstantiated assumptions.
4. Find potential blind spots or alternative perspectives ignored by the text.

TONE:
- Professional, objective, but incisive.
- Direct and uncompromising on logic.
- Avoid softening language like "You might want to consider...". Instead use "The argument fails to address...".
`;

export const ANTAGONIST_PROMPT: AgentPrompt = {
  system: SYSTEM_PROMPT,
  userTemplate: `Analyze the following note and provide a rigorous critique:\n\n{{noteContent}}`,
  outputSchema: {
    type: "object",
    properties: {
      claims_analyzed: { type: "array", items: { type: "string" } },
      critique: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            weakness: { type: "string" },
            counterpoint: { type: "string" },
            severity: { type: "string", enum: ["high", "medium", "low"] },
          },
        },
      },
      probing_questions: { type: "array", items: { type: "string" } },
      steelman_argument: { type: "string" },
    },
  },
};

/**
 * Build the system prompt for the Antagonist agent
 * @param profile - User profile for optional personalization
 */
export function buildAntagonistPrompt(profile?: UserProfile): string {
  // In the future, we can adapt the critique style based on profile
  // e.g. "critique based on HPC principles"
  return SYSTEM_PROMPT;
}
