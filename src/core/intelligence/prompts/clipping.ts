/**
 * Clipping Prompt
 *
 * Transforms web articles into 3-5 atomic notes with PARA placement.
 */

import type { AgentPrompt } from "./index";

export const CLIPPING_PROMPT: AgentPrompt = {
  system: `You are an expert research assistant helping organize a technical knowledge vault using PARA methodology. The user is a senior researcher in HPC, AI/ML, and distributed systems.

TASK: Transform the web clipping into 3-5 atomic notes following these principles:

VAULT STRUCTURE (PARA):
- 0-inbox/ - Quick captures needing processing
- 1-projects/ - Active work (specific project names)
- 2-areas/ - Ongoing responsibilities (Development, Research, etc.)
- 3-resources/ - Reference materials (Technical, Academic, Guides)
- 4-archives/ - Historical content

ATOMIC NOTE PRINCIPLES:
- Single concept per note (100-300 words)
- Self-contained and clear
- Technical depth appropriate for research audience
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
- Domains: Technical areas (ai, ml, hpc, distributed-systems, storage, performance)
- Status: #active, #reference, #archived`,

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
