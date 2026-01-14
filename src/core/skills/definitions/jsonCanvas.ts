import type { Skill } from "../types";

const CANVAS_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "canvas_file",
    strict: true,
    schema: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique 16-character hex string" },
              type: { type: "string", enum: ["text", "file", "link", "group"] },
              x: { type: "integer" },
              y: { type: "integer" },
              width: { type: "integer" },
              height: { type: "integer" },
              text: { type: "string", description: "For text nodes: Markdown content" },
              file: { type: "string", description: "For file nodes: Path to file" },
              subpath: { type: "string", description: "For file nodes: Link to heading/block" },
              url: { type: "string", description: "For link nodes: External URL" },
              label: { type: "string", description: "For group nodes: Label text" },
              color: { type: "string", description: "Preset '1'-'6' or hex code" },
              background: { type: "string", description: "For group nodes: Background image path" },
              backgroundStyle: { type: "string", enum: ["cover", "ratio", "repeat"] },
            },
            required: ["id", "type", "x", "y", "width", "height"],
            additionalProperties: false,
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique 16-character hex string" },
              fromNode: { type: "string" },
              fromSide: { type: "string", enum: ["top", "right", "bottom", "left"] },
              fromEnd: { type: "string", enum: ["none", "arrow"] },
              toNode: { type: "string" },
              toSide: { type: "string", enum: ["top", "right", "bottom", "left"] },
              toEnd: { type: "string", enum: ["none", "arrow"] },
              color: { type: "string" },
              label: { type: "string" },
            },
            required: ["id", "fromNode", "toNode"],
            additionalProperties: false,
          },
        },
      },
      required: ["nodes", "edges"],
      additionalProperties: false,
    },
  },
} as const;

export const jsonCanvasSkill: Skill = {
  id: "json-canvas",
  name: "JSON Canvas Creator",
  description: "Create and edit .canvas files for diagrams and mind maps",
  // @ts-ignore - Schema type compatibility is tricky with 'as const' but valid at runtime
  schema: CANVAS_SCHEMA,
  systemPrompt: `
# JSON Canvas Skill
You are an expert at creating Obsidian Canvas files. 
Output valid JSON following the JSON Canvas Spec 1.0.

Structure:
- "nodes": Array of objects (text, file, link, group)
- "edges": Array of connections between nodes

Rules:
1. IDs must be unique 16-char hex strings (lowercase).
2. Position (x,y) and dimensions (width,height) are integers.
3. Colors can be presets "1"-"6" or hex codes.
4. Edges connect 'fromNode' to 'toNode'.
5. Z-Index is determined by array order (last = top).
`,
  examples: [
    {
      user: "Create a canvas with a main idea and two details",
      assistant: JSON.stringify({
        nodes: [
          {
            id: "n1a2b3c4d5e6f7a8",
            type: "text",
            x: 0,
            y: 0,
            width: 400,
            height: 200,
            text: "# Main Idea",
          },
          {
            id: "n2b3c4d5e6f7a8b9",
            type: "text",
            x: 500,
            y: -100,
            width: 300,
            height: 150,
            text: "Detail 1",
          },
          {
            id: "n3c4d5e6f7a8b9c0",
            type: "text",
            x: 500,
            y: 100,
            width: 300,
            height: 150,
            text: "Detail 2",
          },
        ],
        edges: [
          {
            id: "e1d2e3f4a5b6c7d8",
            fromNode: "n1a2b3c4d5e6f7a8",
            fromSide: "right",
            toNode: "n2b3c4d5e6f7a8b9",
            toSide: "left",
          },
          {
            id: "e2e3f4a5b6c7d8e9",
            fromNode: "n1a2b3c4d5e6f7a8",
            fromSide: "right",
            toNode: "n3c4d5e6f7a8b9c0",
            toSide: "left",
          },
        ],
      }),
    },
  ],
};
