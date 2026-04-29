import type { Surreal } from "surrealdb";
import { searchBm25 } from "../../db/surreal";
import { buildChunkNoteFilter } from "../filters";
import type { SearchFilters, SearchHit } from "../types";

export interface QuickSearchOptions {
  db: Surreal;
  query: string;
  filters?: SearchFilters;
  limit: number;
  /**
   * Multiplier on `limit` for the SurrealDB BM25 candidate window. The BM25
   * engine's score density already collapses near-duplicates, so the
   * multiplier just leaves headroom for the per-note dedupe pass below.
   * Defaults to 4 to match the legacy candidate window.
   */
  candidateMultiplier?: number;
}

/**
 * Quick mode: SurrealDB BM25 search over `chunk.text` via the `chunk_text`
 * full-text index. Filters compose as additional WHERE predicates inside the
 * single SurrealQL statement; there is no Node-side fuzzy scorer because the
 * BM25 analyzer (lowercase + ascii + snowball English) already approximates
 * the legacy fuzzy behaviour while remaining server-side and indexed.
 *
 * Per-note dedupe keeps the strongest chunk per note, mirroring the legacy
 * contract that each note appears at most once in the returned hits.
 */
export async function quickSearch(options: QuickSearchOptions): Promise<SearchHit[]> {
  const trimmed = options.query.trim();
  if (trimmed.length === 0) return [];
  if (options.limit <= 0) return [];
  const multiplier = options.candidateMultiplier ?? 4;
  const candidateWindow = Math.max(options.limit * multiplier, options.limit);
  const fragment = buildChunkNoteFilter(options.filters);
  const rows = await searchBm25(options.db, {
    query: trimmed,
    limit: candidateWindow,
    extraWhere: fragment.where,
    extraBindings: fragment.bindings,
  });

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (seen.has(row.notePath)) continue;
    seen.add(row.notePath);
    hits.push({
      notePath: row.notePath,
      chunkId: row.chunkId.toString(),
      snippet: extractSnippet(row.text, trimmed),
      score: row.bm25Score ?? 0,
      matchedText: trimmed,
    });
    if (hits.length >= options.limit) break;
  }
  return hits;
}

function extractSnippet(text: string, query: string): string {
  const matchIndex = text.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex < 0) return text.slice(0, 200);
  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(text.length, matchIndex + query.length + 60);
  return `${start === 0 ? "" : "…"}${text.slice(start, end)}${end === text.length ? "" : "…"}`;
}
