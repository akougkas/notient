import type { Database } from "../../db/database";
import type { VectorIndex } from "../../indexer/vectorIndex";
import { buildPathFilter } from "../filters";
import type { Reranker } from "../reranker";
import type { SearchFilters, SearchHit } from "../types";
import { quickSearch } from "./quick";

export interface BalancedSearchOptions {
  db: Database;
  vectorIndex: VectorIndex;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  reranker: Reranker;
  query: string;
  filters?: SearchFilters;
  topK: number;
  rerankTopN: number;
  signal: AbortSignal;
}

interface ChunkRow {
  id: string;
  note_path: string;
  text: string;
}

/**
 * Balanced mode: HNSW vector retrieval (top-K) followed by an LLM rerank
 * (top-N). When the embedder returns null (typically because the embedding
 * service is unreachable) the strategy falls back to Quick mode so the user
 * still gets results.
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
  const candidates = options.vectorIndex.search(embedding, options.topK);
  if (candidates.length === 0) return [];

  const placeholders = candidates.map(() => "?").join(",");
  const fragment = buildPathFilter(options.filters);
  const rows = options.db.query<ChunkRow>(
    `SELECT chunks.id AS id, chunks.note_path AS note_path, chunks.text AS text
     FROM chunks
     JOIN notes ON chunks.note_path = notes.path
     WHERE chunks.id IN (${placeholders})${fragment.where};`,
    [...candidates.map((candidate) => candidate.id), ...fragment.params],
  );
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const initial: SearchHit[] = [];
  for (const candidate of candidates) {
    const row = byId.get(candidate.id);
    if (!row) continue;
    initial.push({
      notePath: row.note_path,
      chunkId: candidate.id,
      snippet: row.text.slice(0, 240),
      score: candidate.score,
      matchedText: options.query,
    });
  }
  if (initial.length === 0) return [];
  return options.reranker.rerank(options.query, initial, options.rerankTopN, options.signal);
}
