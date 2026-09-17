import type { Surreal } from "surrealdb";
import type { ReasoningScheduler } from "../../coordinator/reasoningScheduler";
import { type SearchChunkRow, searchVectorWithPath } from "../../db/surreal";
import { buildChunkNoteFilter, withQueryPhrases } from "../filters";
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
  scheduler: ReasoningScheduler;
  /**
   * Optional ef value forwarded to the SurrealDB HNSW search operator. When
   * omitted the shared search reader uses its bounded search default.
   */
  ef?: number;
}

/**
 * Balanced mode: SurrealDB HNSW kNN retrieval (top-K) followed by an LLM
 * rerank (top-N). When embeddings are unavailable or the vector window has no
 * candidates, Quick retrieval keeps structurally indexed notes discoverable.
 */
export async function balancedSearch(options: BalancedSearchOptions): Promise<SearchHit[]> {
  if (options.rerankTopN <= 0) return [];
  const embedding = await options.embed(options.query, options.signal);
  options.signal.throwIfAborted();
  if (!embedding) {
    return quickSearch({
      db: options.db,
      query: options.query,
      filters: options.filters,
      limit: options.rerankTopN,
    });
  }
  const fragment = withQueryPhrases(options.query, buildChunkNoteFilter(options.filters));
  const rows = await searchVectorWithPath(options.db, {
    vector: Array.from(embedding),
    k: options.topK,
    ...(options.ef !== undefined ? { ef: options.ef } : {}),
    extraWhere: fragment.where,
    extraBindings: fragment.bindings,
  });
  options.signal.throwIfAborted();
  if (rows.length === 0)
    return quickSearch({
      db: options.db,
      query: options.query,
      filters: options.filters,
      limit: options.rerankTopN,
    });
  const initial: SearchHit[] = dedupeVectorRowsByNote(rows).map((row) => ({
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
  return options.reranker.rerank(
    options.query,
    boosted,
    options.rerankTopN,
    options.signal,
    options.scheduler,
  );
}

/**
 * Keeps the closest vector-search chunk for each note, then restores global
 * distance order. Balanced search reranks notes rather than paragraphs, so a
 * long note cannot occupy several positions in the final result window.
 */
export function dedupeVectorRowsByNote(rows: SearchChunkRow[]): SearchChunkRow[] {
  const strongestByNote = new Map<string, SearchChunkRow>();
  for (const row of rows) {
    const current = strongestByNote.get(row.notePath);
    if (current === undefined || vectorDistance(row) < vectorDistance(current)) {
      strongestByNote.set(row.notePath, row);
    }
  }
  return Array.from(strongestByNote.values()).sort(
    (left, right) => vectorDistance(left) - vectorDistance(right),
  );
}

function vectorDistance(row: SearchChunkRow): number {
  return row.distance ?? Number.POSITIVE_INFINITY;
}
