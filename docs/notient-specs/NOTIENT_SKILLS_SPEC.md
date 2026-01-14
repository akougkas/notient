# Notient Skills Specification (AI Context)

> **Context for AI Coding Agents**
> Use this specification when implementing or modifying Skills in Notient.

## The Skill Interface

All skills must adhere to the `Skill` interface defined in `src/core/skills/types.ts`.

```typescript
export interface Skill {
  id: string;          // Unique key (e.g. "json-canvas")
  name: string;        // Display name
  description: string; // For routing logic
  systemPrompt: string;// Injected into LLM context
  examples?: Array<{ user: string; assistant: string }>;
  schema?: JsonSchemaFormat; // Optional: Enforced JSON structure
}
```

## Creating Schema-Backed Skills

Local LLMs (Llama 3, Mistral) struggle to generate complex JSON without strict constraints.
**ALWAYS** provide a `JsonSchemaFormat` for skills that generate structural files (Canvas, Bases, Excalidraw).

### Schema Rules
1.  **Strict Mode:** Set `strict: true`.
2.  **No Optional Top-Level:** All top-level properties must be required.
3.  **No `additionalProperties`:** Set `additionalProperties: false` on all objects.
4.  **Enums:** Use `enum` for finite sets (colors, types, shapes) to prevent hallucinated values.

### Example Schema (Canvas)

```typescript
const CANVAS_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "canvas_file",
    strict: true,
    schema: {
      type: "object",
      properties: {
        nodes: { type: "array", ... },
        edges: { type: "array", ... }
      },
      required: ["nodes", "edges"],
      additionalProperties: false
    }
  }
} as const;
```

## Integration Points

### 1. Registry (`src/core/skills/registry.ts`)
Must register the skill in the constructor and add routing logic in `identifyRelevantSkills`.

### 2. Note Editor Agent (`src/core/agents/noteEditorAgent.ts`)
The agent handles the "Mode Switch".
- **Standard Mode:** Outputs `ProposedAction[]`.
- **Skill Mode:** Outputs raw JSON matching the Skill Schema, then wraps it in a specific action (e.g., `create_canvas`).

### 3. Action Types (`src/core/agentic/types.ts`)
If the skill creates a new file type, add a corresponding `ProposedActionType` (e.g., `create_canvas`).

### 4. Obsidian Facade (`src/adapters/obsidianFacade.ts`)
Ensure the file extension is in `SUPPORTED_EXTENSIONS`.

## Best Practices

*   **Prompt Efficiency:** Keep `systemPrompt` concise. The Schema does 80% of the work.
*   **Safety:** The `ObsidianFacade` handles atomic writes. The Skill only generates content.
*   **Validation:** The `NoteEditorAgent` attempts `JSON.parse()` before proposing the action to ensure validity.
