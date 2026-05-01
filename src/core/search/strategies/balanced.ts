import type { Surreal } from "surrealdb";
import { searchVectorWithPath } from "../../db/surreal";
import { buildChunkNoteFilter } from "../filters";
import type { Reranker } from "../reranker";
import type { SearchFilters, SearchHit } from "../types";
import { applyPathTokenBoost } from "./pathTokenBoost";
import { quickSearch } from "./quick";

export interface BalancedSearchOptions {
  db: Surreal;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  reranker: Reranker;
  query: string;
  filters?: SearchFilters;
  topK: number;
  rerankTopN: number;
  signal: AbortSignal;
  /**
   * Optional ef value forwarded to the SurrealDB HNSW search operator. When
   * omitted the helper drops the parameter and SurrealDB picks an internal
   * default. The linker uses a tuned ef of 40; balanced search leaves it
   * unset to keep retrieval breadth high.
   */
  ef?: number;
}

/**
 * Balanced mode: SurrealDB HNSW kNN retrieval (top-K) followed by an LLM
 * rerank (top-N). When the embedder returns null (typically because the
 * embedding service is unreachable) the strategy falls back to Quick mode
 * (BM25) so the user still gets results.
 */
export async function balancedSearch(options: BalancedSearchOptions): Promise<SearchHit[]> {
  if (options.rerankTopN <= 0) return [];
  const embedding = await options.embed(options.query, options.signal);
  if (!embedding) {
    return quickSearch({
      db: options.db,
      query: options.query,
      filters: options.filters,
      limit: options.rerankTopN,
    });
  }
  const fragment = buildChunkNoteFilter(options.filters);
  const rows = await searchVectorWithPath(options.db, {
    vector: Array.from(embedding),
    k: options.topK,
    ...(options.ef !== undefined ? { ef: options.ef } : {}),
    extraWhere: fragment.where,
    extraBindings: fragment.bindings,
  });
  if (rows.length === 0) return [];
  const initial: SearchHit[] = rows.map((row) => ({
    notePath: row.notePath,
    chunkId: row.chunkId.toString(),
    snippet: row.text.slice(0, 240),
    score: row.distance === null ? 0 : 1 - row.distance,
    matchedText: options.query,
  }));
  // Promote notes whose filename slug carries the query terms verbatim
  // (e.g. "vector-search.md" wins over "fan-vector-search.md") before the
  // LLM rerank. Without this nudge, fillers that simply mention the term
  // outrank a canonical concept note that uses the unhyphenated phrase.
  const boosted = applyPathTokenBoost(initial, options.query);
  return options.reranker.rerank(options.query, boosted, options.rerankTopN, options.signal);
}
