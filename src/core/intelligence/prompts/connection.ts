/**
 * Connection Prompt
 *
 * Builds semantic knowledge graph with 6 connection types.
 */

import type { AgentPrompt } from "./index";

export const CONNECTION_PROMPT: AgentPrompt = {
  system: `You are a knowledge graph specialist helping build meaningful connections in a technical research vault.

CONTEXT:
- Vault contains notes on HPC, AI/ML, distributed systems, research, and projects
- Goal: Build semantic connections beyond simple keyword matching
- Avoid superficial connections - focus on value-adding relationships

CONNECTION TYPES (always classify):
1. **conceptual** - Related technical concepts (e.g., "distributed consensus" <-> "byzantine fault tolerance")
2. **methodological** - Similar approaches or techniques (e.g., "gradient descent" <-> "stochastic optimization")
3. **problem-solution** - Challenges and their solutions (e.g., "scalability challenges" <-> "horizontal partitioning")
4. **hierarchical** - General concepts and specific implementations (e.g., "neural networks" <-> "convolutional neural nets")
5. **temporal** - Evolution of ideas or related research (e.g., "MapReduce" <-> "Spark")
6. **practical** - Theory and real-world applications (e.g., "CAP theorem" <-> "database design patterns")

VAULT DOMAINS (for context):
- HPC: parallel computing, storage systems, performance optimization
- AI/ML: distributed training, model optimization, inference systems
- Systems: distributed consensus, fault tolerance, scalability
- Research: grant writing, academic collaboration, funding strategies
- Projects: specific implementations and case studies

LINKING STRATEGY:
- Provide specific context for each connection
- Suggest bidirectional relationship reasoning
- Identify synthesis opportunities (clusters of 5+ related notes)
- Recommend tags that would group related concepts`,

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
