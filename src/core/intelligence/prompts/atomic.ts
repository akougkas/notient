/**
 * Atomic Split Prompt
 *
 * Breaks down complex notes into atomic concepts (100-300 words each).
 * Profile-aware: adapts domain context based on user profile.
 */

import type { UserProfile } from "../../../types/profile";
import { buildBaseIdentity } from "../../agent/identity";
import type { AgentPrompt } from "./index";

/**
 * Build a profile-aware atomic split system prompt
 */
export function buildAtomicSplitPrompt(profile?: UserProfile): string {
  const baseIdentity = buildBaseIdentity(profile);
  const domain = profile?.domain?.primary || "knowledge management";
  const keywords =
    profile?.domain?.keywords?.slice(0, 5).join(", ") || "concepts, techniques, patterns";

  return `${baseIdentity}

SPECIALIZED ROLE: Knowledge Architect
You excel at breaking down complex technical content into atomic concepts.

ATOMIC PRINCIPLES:
- One core concept per note
- 100-300 words maximum
- Self-contained and independently valuable
- Technical depth maintained
- Clear conceptual boundaries

EXTRACTION CRITERIA:
1. **Distinct Concepts**: Identify separate ideas that can stand alone
2. **Technical Depth**: Maintain research-level detail
3. **Interconnections**: Map relationships between concepts
4. **Practical Value**: Ensure each concept has independent utility

DOMAIN-SPECIFIC GUIDANCE:
For ${domain} content, look for:
- Individual algorithms or techniques
- Core concepts and definitions
- Implementation patterns
- Theoretical foundations
- Common examples: ${keywords}

NAMING CONVENTION:
- Use descriptive, technical terms
- Kebab-case for multi-word concepts
- Avoid acronyms unless widely recognized
- Example: "distributed-consensus-algorithms" not "DCA-stuff"`;
}

export const ATOMIC_SPLIT_PROMPT: AgentPrompt = {
  system: buildAtomicSplitPrompt(), // Default without profile

  userTemplate: `Current note: "{{noteTitle}}"
Path: {{notePath}}
Content:
{{noteContent}}

Analyze and extract atomic concepts. Output ONLY valid JSON.`,

  outputSchema: {
    type: "object",
    properties: {
      analysis: { type: "string" },
      proposed_atomic_notes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            core_concept: { type: "string" },
            content_outline: { type: "array", items: { type: "string" } },
            connections: { type: "array", items: { type: "string" } },
            priority: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["title", "core_concept", "content_outline", "priority"],
        },
      },
      original_note_restructure: { type: "string" },
      implementation_order: { type: "array", items: { type: "string" } },
    },
    required: [
      "analysis",
      "proposed_atomic_notes",
      "original_note_restructure",
      "implementation_order",
    ],
  },

  temperature: 0.2, // More deterministic for structural tasks
  maxTokens: 2000, // Larger for batch operations
};
