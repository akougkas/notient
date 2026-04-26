import type { LLMProvider } from "../llm/provider";
import { RERANK_SCHEMA, buildRerankPrompt } from "./prompts/rerank";
import type { SearchHit } from "./types";

export interface RerankerOptions {
  provider: LLMProvider;
  model: string;
  /** Optional cap on input snippet length to keep the prompt small. */
  snippetMaxChars?: number;
}

interface RerankResponse {
  ranking: string[];
}

/**
 * LLM-driven reranker. Calls the provider's `chatJson` helper with a strict
 * JSON schema and reorders the input hits by the returned ranking. On any
 * failure (parse error, network, abort already encoded by provider) the
 * reranker falls back to the input order so callers always receive results.
 */
export class Reranker {
  constructor(private readonly options: RerankerOptions) {}

  async rerank(
    query: string,
    hits: SearchHit[],
    topN: number,
    signal: AbortSignal,
  ): Promise<SearchHit[]> {
    if (topN <= 0) return [];
    if (hits.length <= 1) return hits.slice(0, topN);
    const snippetCap = this.options.snippetMaxChars ?? 320;
    const candidates = hits.map((hit) => ({
      id: rerankId(hit),
      snippet: hit.snippet.slice(0, snippetCap),
    }));
    const messages = buildRerankPrompt({ query, candidates });
    try {
      const response = await this.options.provider.chatJson<RerankResponse>(
        messages,
        { model: this.options.model, signal, temperature: 0.1 },
        RERANK_SCHEMA,
      );
      const ranked = sortByRanking(hits, response.ranking);
      return ranked.slice(0, topN);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return hits.slice(0, topN);
    }
  }
}

function sortByRanking(hits: SearchHit[], ranking: string[]): SearchHit[] {
  const order = new Map<string, number>();
  for (let index = 0; index < ranking.length; index += 1) {
    if (!order.has(ranking[index])) order.set(ranking[index], index);
  }
  return [...hits].sort((a, b) => {
    const ai = order.get(rerankId(a));
    const bi = order.get(rerankId(b));
    if (ai === undefined && bi === undefined) return 0;
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });
}

function rerankId(hit: SearchHit): string {
  return hit.chunkId ?? hit.notePath;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}
