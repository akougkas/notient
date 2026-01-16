/**
 * Synthesis Prompt
 *
 * Creates synthesis notes from concept clusters (500-800 words).
 * Profile-aware: adapts domain context based on user profile.
 */

import type { UserProfile } from "../../../types/profile";
import { buildBaseIdentity } from "../../agent/identity";
import type { AgentPrompt } from "./index";

/**
 * Build a profile-aware synthesis system prompt
 */
export function buildSynthesisPrompt(profile?: UserProfile): string {
  const baseIdentity = buildBaseIdentity(profile);
  const domain = profile?.domain?.primary || "research";
  const secondary = profile?.domain?.secondary?.join(", ") || "related fields";

  return `${baseIdentity}

SPECIALIZED ROLE: Research Synthesis Specialist
You excel at creating comprehensive overview notes from related concept clusters.

SYNTHESIS PRINCIPLES:
1. **Pattern Recognition**: Identify common themes and relationships
2. **Narrative Construction**: Create coherent story from separate concepts
3. **Value Addition**: Generate new insights from combinations
4. **Research Depth**: Maintain technical rigor throughout
5. **Practical Application**: Connect to real-world use cases

DOMAIN CONTEXT:
- Primary focus: ${domain}
- Related areas: ${secondary}
- Connect concepts across these domains when relevant

SYNTHESIS TYPES:
- **Thematic**: Group concepts by common themes
- **Methodological**: Compare different approaches
- **Historical**: Trace evolution of ideas
- **Practical**: Theory to implementation connections
- **Interdisciplinary**: Bridge different domains

STRUCTURE TEMPLATE:
1. **Overview**: High-level summary of the synthesis
2. **Key Concepts**: Core ideas being connected
3. **Relationships**: How concepts interact and influence each other
4. **Patterns**: Common themes or recurring elements
5. **Applications**: Practical implications and use cases
6. **Gaps**: Missing pieces or areas for future exploration
7. **Further Reading**: Related concepts and next steps

OUTPUT GUIDELINES:
- 500-800 words for the synthesis content
- Connect to ongoing projects when relevant
- Maintain academic rigor and technical accuracy
- Suggest research directions or applications`;
}

export const SYNTHESIS_PROMPT: AgentPrompt = {
  system: buildSynthesisPrompt(), // Default without profile

  userTemplate: `Related notes to synthesize:
{{relatedNotes}}

Build a synthesis note. Output ONLY valid JSON.`,

  outputSchema: {
    type: "object",
    properties: {
      synthesis_overview: { type: "string" },
      synthesis_note: {
        type: "object",
        properties: {
          title: { type: "string" },
          frontmatter: {
            type: "object",
            properties: {
              created: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              type: { type: "string" },
              synthesis_type: { type: "string" },
            },
          },
          content: { type: "string" },
          key_insights: { type: "array", items: { type: "string" } },
          connections_map: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source_note: { type: "string" },
                relationship: { type: "string" },
              },
            },
          },
        },
        required: ["title", "content", "key_insights"],
      },
      related_concepts: { type: "array", items: { type: "string" } },
      application_opportunities: { type: "string" },
      research_directions: { type: "array", items: { type: "string" } },
      meta_analysis: { type: "string" },
    },
    required: ["synthesis_overview", "synthesis_note"],
  },

  temperature: 0.3,
  maxTokens: 3000,
};
