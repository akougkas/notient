/**
 * Clipping Prompt
 *
 * Transforms web articles into 3-5 atomic notes with PARA placement.
 * Profile-aware: adapts domain context and PARA folders based on user profile.
 */

import type { UserProfile } from "../../../types/profile";
import { buildBaseIdentity } from "../../agent/identity";
import type { AgentPrompt } from "./index";

/**
 * Build a profile-aware clipping system prompt
 */
export function buildClippingPrompt(profile?: UserProfile): string {
  const baseIdentity = buildBaseIdentity(profile);
  const domain = profile?.domain?.primary || "knowledge management";
  const keywords = profile?.domain?.keywords?.slice(0, 5) || [];

  // Build PARA folder context from profile or use defaults
  const para = profile?.para;
  const paraContext = para
    ? `VAULT STRUCTURE (from your PARA setup):
- Projects: ${para.projects.join(", ") || "Not configured"}
- Areas: ${para.areas.join(", ") || "Not configured"}
- Resources: ${para.resources.join(", ") || "Not configured"}
- Archives: ${para.archives.join(", ") || "Not configured"}`
    : `VAULT STRUCTURE (PARA methodology):
- Projects/ - Active work with deadlines
- Areas/ - Ongoing responsibilities
- Resources/ - Reference materials
- Archives/ - Completed/inactive content`;

  const domainTags =
    keywords.length > 0
      ? keywords.map((k) => `#${k.replace(/\s+/g, "-").toLowerCase()}`).join(", ")
      : "#technical, #reference";

  return `${baseIdentity}

SPECIALIZED ROLE: Content Curator
You excel at transforming web clippings into well-structured vault notes.

${paraContext}

TASK: Transform the web clipping into 3-5 atomic notes.

ATOMIC NOTE PRINCIPLES:
- Single concept per note (100-300 words)
- Self-contained and clear
- Technical depth appropriate for ${domain} audience
- Bidirectional links with context
- Clear, descriptive titles

NAMING CONVENTIONS:
- Technical concepts: descriptive-kebab-case
- Projects: CamelCase or short acronyms
- Maintain technical accuracy

FRONTMATTER TEMPLATE:
---
created: YYYY-MM-DD
tags: [relevant, technical, domain]
type: atomic|synthesis|source
source: original-url
status: processed
---

TAG TAXONOMY:
- Content: #atomic, #synthesis, #source, #clipping-processed
- Domain-specific: ${domainTags}
- Status: #active, #reference, #archived`;
}

export const CLIPPING_PROMPT: AgentPrompt = {
  system: buildClippingPrompt(), // Default without profile

  userTemplate: `Web clipping: "{{noteTitle}}"
Source URL: {{sourceUrl}}
Content:
{{noteContent}}

Transform into atomic notes. Output ONLY valid JSON.`,

  outputSchema: {
    type: "object",
    properties: {
      folder_recommendation: { type: "string" },
      atomic_concepts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            frontmatter: {
              type: "object",
              properties: {
                created: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                type: { type: "string" },
                source: { type: "string" },
              },
            },
            connections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  target: { type: "string" },
                  context: { type: "string" },
                },
              },
            },
          },
          required: ["title", "content", "frontmatter"],
        },
      },
      original_note_update: {
        type: "object",
        properties: {
          status: { type: "string" },
          created_notes: { type: "array", items: { type: "string" } },
        },
      },
    },
    required: ["folder_recommendation", "atomic_concepts"],
  },

  temperature: 0.2,
  maxTokens: 2500,
};
