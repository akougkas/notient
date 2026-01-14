import type { Skill } from "../types";

const BASES_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "bases_file",
    strict: true,
    schema: {
      type: "object",
      properties: {
        filters: {
          type: "object",
          properties: {
            and: { type: "array", items: { type: "string" } },
            or: { type: "array", items: { type: "string" } },
            not: { type: "array", items: { type: "string" } }
          },
          additionalProperties: false
        },
        formulas: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Map of formula names to expressions"
        },
        properties: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              displayName: { type: "string" }
            },
            required: ["displayName"],
            additionalProperties: false
          }
        },
        summaries: {
          type: "object",
          additionalProperties: { type: "string" }
        },
        views: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["table", "cards", "list", "map"] },
              name: { type: "string" },
              limit: { type: "integer" },
              groupBy: {
                type: "object",
                properties: {
                  property: { type: "string" },
                  direction: { type: "string", enum: ["ASC", "DESC"] }
                },
                required: ["property", "direction"],
                additionalProperties: false
              },
              filters: {
                type: "object",
                properties: {
                  and: { type: "array", items: { type: "string" } },
                  or: { type: "array", items: { type: "string" } },
                  not: { type: "array", items: { type: "string" } }
                },
                additionalProperties: false
              },
              order: { type: "array", items: { type: "string" } },
              summaries: {
                type: "object",
                additionalProperties: { type: "string" }
              }
            },
            required: ["type", "name"],
            additionalProperties: false
          }
        }
      },
      required: ["views"],
      additionalProperties: false
    }
  }
} as const;

export const obsidianBasesSkill: Skill = {
  id: "obsidian-bases",
  name: "Obsidian Bases Creator",
  description: "Create .base files for database-like views (tables, boards, lists)",
  // @ts-ignore - Schema type compatibility
  schema: BASES_SCHEMA,
  systemPrompt: `
# Obsidian Bases Skill
You are an expert at creating Obsidian Bases (.base files).
Output valid configuration for dynamic views.

Structure:
- "views": List of views (table, cards, list, map).
- "filters": Global filters (and/or/not).
- "formulas": Calculated properties using expressions.
- "properties": Display configurations.

Expressions:
- Use 'file.name', 'file.mtime', 'file.tags' for file metadata.
- Use 'note.prop' for frontmatter properties.
- Use 'if(cond, true, false)' for logic.
- Use 'date()', 'now()', 'today()' for time.

Operators: ==, !=, >, <, >=, <=, &&, ||, !
`,
  examples: [
    {
      user: "Create a table of active projects",
      assistant: JSON.stringify({
        filters: {
          and: ['file.hasTag("project")', 'status == "active"']
        },
        views: [{
          type: "table",
          name: "Active Projects",
          order: ["file.name", "status", "priority", "due_date"],
          groupBy: { property: "priority", direction: "DESC" }
        }]
      })
    }
  ]
};
