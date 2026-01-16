/**
 * Enhance Prompt
 *
 * Transforms informal captures into well-structured vault notes.
 * Profile-aware: adapts PARA placement and tags based on user profile.
 */

import type { UserProfile } from "../../../types/profile";
import { buildBaseIdentity } from "../../agent/identity";
import type { AgentPrompt } from "./index";

/**
 * Build a profile-aware enhance system prompt
 */
export function buildEnhancePrompt(profile?: UserProfile): string {
  const baseIdentity = buildBaseIdentity(profile);
  const domain = profile?.domain?.primary || "knowledge management";

  // Build PARA folder context from profile or use defaults
  const para = profile?.para;
  const paraFolders = para
    ? `- Projects: ${para.projects.join(", ") || "your projects folder"}
- Areas: ${para.areas.join(", ") || "your areas folder"}
- Resources: ${para.resources.join(", ") || "your resources folder"}
- Archives: ${para.archives.join(", ") || "your archives folder"}`
    : `- Projects: active work with deadlines
- Areas: ongoing responsibilities
- Resources: reference material
- Archives: completed/inactive items`;

  // Build tag suggestions from profile keywords
  const keywords = profile?.domain?.keywords || [];
  const tagSuggestions =
    keywords.length > 0
      ? keywords.map((k) => k.replace(/\s+/g, "-").toLowerCase()).join(", ")
      : "appropriate domain tags";

  return `${baseIdentity}

SPECIALIZED ROLE: Editor
You excel at transforming quick captures into well-structured vault notes.

INPUT TYPES:
- Meeting notes or quick jots
- Ideas or random thoughts
- Informal captures from conversations
- Rough drafts or sketches
- Voice-to-text transcriptions

ENHANCEMENT GOALS:
1. **Structure**: Add clear organization and flow
2. **Metadata**: Proper frontmatter and tags
3. **Context**: Fill in implied information
4. **Connections**: Link to relevant vault concepts
5. **Actionability**: Extract tasks or follow-ups
6. **Clarity**: Improve readability and comprehension

PARA FOLDER MAPPING:
${paraFolders}

TAG TAXONOMY:
- Domain tags: ${tagSuggestions}
- Content type: #capture, #meeting, #idea, #draft
- Status: #processed, #active, #reference

FRONTMATTER TEMPLATE:
---
created: YYYY-MM-DD
tags: [appropriate-tags]
type: capture|meeting|idea|draft
status: processed|active|reference
project: [if relevant]
area: [if relevant]
---

NOTE TYPES TO RECOGNIZE:
- **Meeting Notes**: Structure with attendees, decisions, actions
- **Ideas**: Develop into actionable concepts
- **Technical Notes**: Add context and connections to ${domain}
- **Random Captures**: Organize and categorize
- **Drafts**: Improve structure and clarity`;
}

export const ENHANCE_PROMPT: AgentPrompt = {
  system: buildEnhancePrompt(), // Default without profile

  userTemplate: `Note: "{{noteTitle}}"
Path: {{notePath}}
Content:
{{noteContent}}

Enhance this capture. Output ONLY valid JSON.`,

  outputSchema: {
    type: "object",
    properties: {
      content_type: {
        type: "string",
        enum: ["meeting", "idea", "technical", "random", "draft"],
      },
      enhanced_note: {
        type: "object",
        properties: {
          title: { type: "string" },
          frontmatter: {
            type: "object",
            properties: {
              created: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              type: { type: "string" },
              status: { type: "string" },
            },
          },
          content: { type: "string" },
        },
        required: ["title", "content"],
      },
      para_placement: {
        type: "object",
        properties: {
          folder: { type: "string" },
          reasoning: { type: "string" },
        },
      },
      connections: { type: "array", items: { type: "string" } },
      next_actions: { type: "array", items: { type: "string" } },
      tags_suggestion: { type: "array", items: { type: "string" } },
    },
    required: ["content_type", "enhanced_note"],
  },

  temperature: 0.3,
  maxTokens: 2000,
};
