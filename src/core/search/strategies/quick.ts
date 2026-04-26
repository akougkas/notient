import type { Database } from "../../db/database";
import { buildPathFilter } from "../filters";
import type { SearchFilters, SearchHit } from "../types";

export type FuzzyScorer = (text: string, query: string) => number;

export interface QuickSearchOptions {
  db: Database;
  query: string;
  filters?: SearchFilters;
  limit: number;
  /** Scorer used to rank candidate rows. Defaults to {@link defaultFuzzyScore}. */
  scorer?: FuzzyScorer;
  /** Multiplier on `limit` for the SQL prefilter window. Defaults to 4. */
  candidateMultiplier?: number;
}

interface QuickRow {
  note_path: string;
  chunk_id: string;
  text: string;
  updated_at: number;
}

/**
 * Quick mode: keyword + fuzzy match over titles and chunk text. The SQL
 * pre-filter uses LOWER(...) LIKE for cheap candidate retrieval; the in-house
 * fuzzy scorer ranks candidates and ensures title hits beat body hits. The
 * scorer is injectable so production code can substitute Obsidian's
 * prepareFuzzySearch when running inside the host; tests rely on the
 * deterministic in-house scorer.
 */
export function quickSearch(options: QuickSearchOptions): SearchHit[] {
  const trimmed = options.query.trim();
  if (trimmed.length === 0) return [];
  if (options.limit <= 0) return [];
  const scorer = options.scorer ?? defaultFuzzyScore;
  const multiplier = options.candidateMultiplier ?? 4;
  const term = `%${trimmed.toLowerCase().replace(/[\s%_]+/g, "%")}%`;
  const fragment = buildPathFilter(options.filters);
  const rows = options.db.query<QuickRow>(
    `SELECT chunks.note_path AS note_path,
            chunks.id AS chunk_id,
            chunks.text AS text,
            notes.updated_at AS updated_at
     FROM chunks
     JOIN notes ON chunks.note_path = notes.path
     WHERE (LOWER(chunks.text) LIKE ? OR LOWER(notes.path) LIKE ?)${fragment.where}
     ORDER BY notes.updated_at DESC
     LIMIT ?;`,
    [term, term, ...fragment.params, Math.max(options.limit * multiplier, options.limit)],
  );

  const seen = new Set<string>();
  const scored: { hit: SearchHit; score: number }[] = [];
  for (const row of rows) {
    if (seen.has(row.note_path)) continue;
    const titleScore = scorer(extractTitle(row.note_path), trimmed);
    const bodyScore = scorer(row.text, trimmed);
    const score = Math.max(titleScore + 0.25, bodyScore);
    if (score <= 0) continue;
    seen.add(row.note_path);
    scored.push({
      hit: {
        notePath: row.note_path,
        chunkId: row.chunk_id,
        snippet: extractSnippet(row.text, trimmed),
        score,
        matchedText: trimmed,
      },
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, options.limit).map((entry) => entry.hit);
}

/**
 * Lightweight similarity scorer. Returns a value in [0, 1] where 1 is an
 * exact substring match; non-matches return 0. Approximates fuzzy behaviour
 * by allowing the query characters to appear in order with bounded gaps.
 */
export function defaultFuzzyScore(text: string, query: string): number {
  if (text.length === 0 || query.length === 0) return 0;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerText.includes(lowerQuery)) {
    const ratio = lowerQuery.length / Math.max(lowerText.length, lowerQuery.length);
    return 0.5 + 0.5 * ratio;
  }
  let textIndex = 0;
  let matched = 0;
  let gapPenalty = 0;
  let lastIndex = -1;
  for (const character of lowerQuery) {
    const found = lowerText.indexOf(character, textIndex);
    if (found < 0) return 0;
    if (lastIndex >= 0) gapPenalty += found - lastIndex - 1;
    lastIndex = found;
    textIndex = found + 1;
    matched += 1;
  }
  if (matched < lowerQuery.length) return 0;
  const coverage = matched / lowerQuery.length;
  const gapDamping = 1 / (1 + gapPenalty / Math.max(lowerQuery.length, 1));
  return 0.4 * coverage * gapDamping;
}

function extractTitle(notePath: string): string {
  const filename = notePath.split("/").pop() ?? notePath;
  return filename.replace(/\.[^.]+$/, "");
}

function extractSnippet(text: string, query: string): string {
  const matchIndex = text.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex < 0) return text.slice(0, 200);
  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(text.length, matchIndex + query.length + 60);
  return `${start === 0 ? "" : "…"}${text.slice(start, end)}${end === text.length ? "" : "…"}`;
}
