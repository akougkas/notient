/**
 * Task Extraction Prompt
 *
 * Extracts actionable items, decisions, and deadlines from notes.
 */

import type { AgentPrompt } from "./index";

export const TASK_EXTRACTION_PROMPT: AgentPrompt = {
  system: `You are a project management specialist helping extract actionable items from research and project notes.

CONTEXT:
- Active projects: Technical research, software development, grant proposals, academic work
- Areas: Development, Research, Funding-Management
- Focus: Technical research, grant writing, academic collaboration

EXTRACTION TARGETS:
1. **Action Items**: Clear, actionable tasks with ownership
2. **Decisions**: Choices made that affect project direction
3. **Deadlines**: Time-sensitive commitments (extract from natural language)
4. **Dependencies**: Blocked items waiting on external factors
5. **Research Tasks**: Investigation or analysis needed
6. **Technical TODOs**: Implementation or development work

TASK CATEGORIES:
- **immediate** (next 1-2 weeks): Ready to execute now
- **planned** (next month): Scheduled or prepared
- **backlog** (future): Important but not urgent
- **blocked**: Waiting on external dependencies
- **research**: Investigation or analysis needed

DEADLINE DETECTION:
Extract deadlines from phrases like:
- "by Friday", "due next week", "before the end of Q1"
- "submit by January 15", "deadline: 2026-01-10"
- "needs to be done before the conference"
Convert to YYYY-MM-DD format when possible, or "YYYY-MM" for month-level, or natural language if ambiguous.

PROJECT CONTEXT MAPPING:
- Technical tasks -> Development area
- Grant/funding items -> Funding-Management area
- Academic work -> Research projects
- Administrative -> Appropriate area`,

  userTemplate: `Note: "{{noteTitle}}"
Content:
{{noteContent}}

Extract tasks, decisions, and deadlines. Output ONLY valid JSON.`,

  outputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            category: {
              type: "string",
              enum: ["immediate", "planned", "backlog", "blocked", "research"],
            },
            owner: { type: "string", enum: ["self", "external", "collaborative"] },
            deadline: { type: ["string", "null"] },
            project_area: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } },
            context: { type: "string" },
          },
          required: ["text", "category"],
        },
      },
      decisions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            decision: { type: "string" },
            rationale: { type: "string" },
            impact: { type: "string" },
            date: { type: ["string", "null"] },
          },
          required: ["decision"],
        },
      },
      next_actions: { type: "array", items: { type: "string" } },
      organization_suggestions: { type: "string" },
    },
    required: ["summary", "tasks"],
  },

  temperature: 0.2,
  maxTokens: 2000,
};
