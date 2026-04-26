import type { ChatMessage } from "../../llm/provider";

export interface RerankCandidate {
  id: string;
  snippet: string;
}

export interface RerankPromptInput {
  query: string;
  candidates: RerankCandidate[];
}

/**
 * Builds the reranker prompt. The model must respond with strict JSON of the
 * shape `{ "ranking": [<id>, ...] }` where ids are listed best-first.
 */
export function buildRerankPrompt(input: RerankPromptInput): ChatMessage[] {
  const numbered = input.candidates
    .map((candidate, index) => `${index + 1}. (${candidate.id}) ${candidate.snippet}`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        'You rerank search results for relevance. Respond with strict JSON of the form {"ranking": [<id>, ...]} where ids are listed best-first. Output JSON only.',
    },
    {
      role: "user",
      content: `Query: ${input.query}\n\nCandidates:\n${numbered}\n\nReturn the ranking JSON.`,
    },
  ];
}

export const RERANK_SCHEMA = {
  name: "search_rerank",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ranking"],
    properties: {
      ranking: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
} as const;
