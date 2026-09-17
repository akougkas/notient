import type { ChatMessage } from "../../llm/provider";

export interface RerankCandidate {
  /** 1-based index presented to the model. */
  index: number;
  snippet: string;
}

export interface RerankPromptInput {
  query: string;
  candidates: RerankCandidate[];
}

/**
 * Builds the reranker prompt.
 *
 * Candidates are presented as short 1-based integers (`[1]`, `[2]`, ...)
 * rather than opaque SurrealDB record ids. Record ids burned prompt tokens,
 * invited the model to hallucinate plausible-looking ids, and made a parse
 * failure indistinguishable from a mis-copied id. The model returns
 * `{"ranking": [2, 1, 3]}` and the caller maps the integers back to hits.
 */
export function buildRerankPrompt(input: RerankPromptInput): ChatMessage[] {
  const numbered = input.candidates
    .map((candidate) => `[${candidate.index}] ${candidate.snippet}`)
    .join("\n");
  const max = input.candidates.length;
  return [
    {
      role: "system",
      content: `You rerank search results for relevance. Each candidate is labelled with an integer in square brackets. Respond with strict JSON of the form {"ranking": [<integer>, ...]} listing every candidate integer from 1 to ${max} exactly once, best-first. Output JSON only.`,
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
        items: { type: "integer" },
      },
    },
  },
} as const;
