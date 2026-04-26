/**
 * Connection Prompt
 *
 * Builds semantic knowledge graph with 6 connection types.
 * Profile-aware: adapts domain context based on user profile.
 */

import type { UserProfile } from "../../../types/profile";
import { buildBaseIdentity } from "../../agent/identity";
import type { AgentPrompt } from "./index";

/**
 * Build a profile-aware connection system prompt
 */
export function buildConnectionPrompt(profile?: UserProfile): string {
  const baseIdentity = buildBaseIdentity(profile);
  const domain = profile?.domain?.primary || "knowledge management";
  const secondary = profile?.domain?.secondary || [];
  const keywords = profile?.domain?.keywords || [];

  // Build domain examples for connection types
  const domainExamples =
    keywords.length > 0
      ? `Examples from your domain (${keywords.slice(0, 3).join(", ")})`
      : "Technical examples";

  return `${baseIdentity}

SPECIALIZED ROLE: Knowledge Graph Engineer
You excel at building meaningful semantic connections between notes.

CONTEXT:
- Vault focuses on: ${domain}
- Related areas: ${secondary.join(", ") || "various topics"}
- Goal: Build semantic connections beyond simple keyword matching
- Avoid superficial connections - focus on value-adding relationships

CONNECTION TYPES (always classify):
1. **conceptual** - Related concepts within ${domain}
2. **methodological** - Similar approaches or techniques
3. **problem-solution** - Challenges and their solutions
4. **hierarchical** - General concepts and specific implementations
5. **temporal** - Evolution of ideas or related developments
6. **practical** - Theory and real-world applications

${domainExamples}:
- conceptual: core concepts ↔ related theories
- methodological: different approaches to similar problems
- problem-solution: challenges ↔ solutions or patterns
- hierarchical: general framework ↔ specific implementation
- temporal: earlier work ↔ current developments
- practical: theoretical foundation ↔ applied example

LINKING STRATEGY:
- Provide specific context for each connection
- Suggest bidirectional relationship reasoning
- Identify synthesis opportunities (clusters of 5+ related notes)
- Recommend tags that would group related concepts`;
}

export const CONNECTION_PROMPT: AgentPrompt = {
  system: buildConnectionPrompt(), // Default without profile

  userTemplate: `Current note: "{{noteTitle}}"
Path: {{notePath}}
Content:
{{noteContent}}

Related notes in vault:
{{relatedNotes}}

Suggest connections. Output ONLY valid JSON.`,

  outputSchema: {
    type: "object",
    properties: {
      current_note_summary: { type: "string" },
      suggested_connections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            target: { type: "string" },
            type: {
              type: "string",
              enum: [
                "conceptual",
                "methodological",
                "problem-solution",
                "hierarchical",
                "temporal",
                "practical",
              ],
            },
            context: { type: "string" },
            bidirectional_value: { type: "string" },
            link_text: { type: "string" },
            score: { type: "number" },
          },
          required: ["target", "type", "context", "score"],
        },
      },
      synthesis_opportunities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            theme: { type: "string" },
            related_notes: { type: "array", items: { type: "string" } },
            synthesis_value: { type: "string" },
          },
        },
      },
      tag_recommendations: { type: "array", items: { type: "string" } },
      missing_connections: { type: "array", items: { type: "string" } },
    },
    required: ["current_note_summary", "suggested_connections"],
  },

  temperature: 0.3,
  maxTokens: 2000,
};
