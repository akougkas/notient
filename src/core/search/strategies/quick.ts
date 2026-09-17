import type { Surreal } from "surrealdb";
import { type SearchChunkRow, searchBm25 } from "../../db/surreal";
import { buildChunkNoteFilter, withQueryPhrases } from "../filters";
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
   * Defaults to 4 to bound the candidate window without starving dedupe.
   */
  candidateMultiplier?: number;
}

const NATURAL_QUERY_STOP_WORDS = new Set([
  "about",
  "and",
  "are",
  "did",
  "does",
  "find",
  "for",
  "from",
  "how",
  "into",
  "is",
  "me",
  "my",
  "notes",
  "of",
  "on",
  "or",
  "please",
  "show",
  "tell",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "where",
  "which",
  "who",
  "why",
  "with",
  "write",
  "wrote",
]);

const MAX_FALLBACK_TERMS = 8;

interface FallbackNote {
  bestRow: SearchChunkRow;
  bestRowScore: number;
  matchedTerms: string[];
  scoreSum: number;
  snippetTerm: string;
}

/**
 * Quick mode: SurrealDB BM25 search over `chunk.text` via the `chunk_text`
 * full-text index. Filters compose as additional WHERE predicates inside the
 * SurrealQL statements. The precise query runs first. When Surreal's
 * all-terms matching returns no rows for a natural-language question, a
 * bounded fallback searches its significant terms independently and ranks
 * notes by term coverage before BM25 strength.
 *
 * Per-note dedupe keeps the strongest chunk per note so every returned hit
 * represents a different note.
 */
export async function quickSearch(options: QuickSearchOptions): Promise<SearchHit[]> {
  const trimmed = options.query.trim();
  if (trimmed.length === 0) return [];
  assertPositiveSafeInteger(options.limit, "quick search limit");
  const multiplier = options.candidateMultiplier ?? 4;
  assertPositiveSafeInteger(multiplier, "quick search candidateMultiplier");
  const candidateWindow = options.limit * multiplier;
  if (!Number.isSafeInteger(candidateWindow)) {
    throw new Error("quick search candidate window exceeds the safe integer range");
  }
  const fragment = withQueryPhrases(trimmed, buildChunkNoteFilter(options.filters));
  const searchInput = {
    query: trimmed,
    limit: candidateWindow,
    extraWhere: fragment.where,
    extraBindings: fragment.bindings,
  };
  const rows = await searchBm25(options.db, searchInput);
  if (rows.length > 0) return rowsToHits(rows, trimmed, options.limit);

  const fallbackTerms = significantTerms(trimmed);
  if (fallbackTerms.length === 0) return [];
  const fallbackRows = await Promise.all(
    fallbackTerms.map((term) =>
      searchBm25(options.db, {
        ...searchInput,
        query: term,
      }),
    ),
  );
  return fallbackHits(fallbackRows, fallbackTerms, options.limit);
}

function rowsToHits(rows: SearchChunkRow[], matchedText: string, limit: number): SearchHit[] {
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (seen.has(row.notePath)) continue;
    seen.add(row.notePath);
    hits.push({
      notePath: row.notePath,
      chunkId: row.chunkId.toString(),
      snippet: extractSnippet(row.text, matchedText),
      score: requireBm25Score(row),
      matchedText,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export function significantTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)) {
    const term = match[0].replace(/^-+|-+$/g, "");
    if (term.length < 3 || NATURAL_QUERY_STOP_WORDS.has(term) || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= MAX_FALLBACK_TERMS) break;
  }
  return terms;
}

function fallbackHits(resultSets: SearchChunkRow[][], terms: string[], limit: number): SearchHit[] {
  const notes = new Map<string, FallbackNote>();
  for (let termIndex = 0; termIndex < resultSets.length; termIndex += 1) {
    const term = terms[termIndex];
    const bestForTerm = new Set<string>();
    for (const row of resultSets[termIndex]) {
      if (bestForTerm.has(row.notePath)) continue;
      bestForTerm.add(row.notePath);
      const score = requireBm25Score(row);
      const existing = notes.get(row.notePath);
      if (existing === undefined) {
        notes.set(row.notePath, {
          bestRow: row,
          bestRowScore: score,
          matchedTerms: [term],
          scoreSum: score,
          snippetTerm: term,
        });
        continue;
      }
      existing.matchedTerms.push(term);
      existing.scoreSum += score;
      if (score > existing.bestRowScore) {
        existing.bestRow = row;
        existing.bestRowScore = score;
        existing.snippetTerm = term;
      }
    }
  }

  return [...notes.values()]
    .sort(
      (left, right) =>
        right.matchedTerms.length - left.matchedTerms.length ||
        right.scoreSum - left.scoreSum ||
        left.bestRow.notePath.localeCompare(right.bestRow.notePath),
    )
    .slice(0, limit)
    .map((entry) => ({
      notePath: entry.bestRow.notePath,
      chunkId: entry.bestRow.chunkId.toString(),
      snippet: extractSnippet(entry.bestRow.text, entry.snippetTerm),
      score: entry.scoreSum / entry.matchedTerms.length,
      matchedText: entry.matchedTerms.join(" "),
    }));
}

function requireBm25Score(row: SearchChunkRow): number {
  if (typeof row.bm25Score !== "number" || !Number.isFinite(row.bm25Score)) {
    throw new Error("quick search storage integrity: BM25 row is missing its score");
  }
  return row.bm25Score;
}

function assertPositiveSafeInteger(raw: unknown, label: string): asserts raw is number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function extractSnippet(text: string, query: string): string {
  const matchIndex = text.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex < 0) return text.slice(0, 200);
  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(text.length, matchIndex + query.length + 60);
  return `${start === 0 ? "" : "…"}${text.slice(start, end)}${end === text.length ? "" : "…"}`;
}
