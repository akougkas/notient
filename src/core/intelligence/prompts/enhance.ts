/**
 * Enhance Prompt
 *
 * Transforms informal captures into well-structured vault notes.
 */

import type { AgentPrompt } from "./index";

export const ENHANCE_PROMPT: AgentPrompt = {
  system: `You are a knowledge management specialist helping transform quick captures into well-structured vault notes.

TASK: Enhance informal captures with proper structure, metadata, and organization cues.

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

VAULT INTEGRATION:
- PARA folder suggestion (0-inbox, 1-projects, 2-areas, 3-resources)
- Appropriate tags from established taxonomy
- Connection opportunities with existing notes
- Next action recommendations

FRONTMATTER ENHANCEMENT:
---
created: YYYY-MM-DD
tags: [appropriate-tags]
type: capture|meeting|idea|draft
status: processed|active|reference
project: [if relevant]
area: [if relevant]
---

NOTE TYPES:
- **Meeting Notes**: Structure with attendees, decisions, actions
- **Ideas**: Develop into actionable concepts
- **Technical Notes**: Add context and connections
- **Random Captures**: Organize and categorize
- **Drafts**: Improve structure and clarity`,

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
