import type { RetrievalHit } from "../../api/retrieval";
import { tokenizeNotePath, tokenizeQuery } from "./strategies/pathTokenBoost";

/** A short contiguous name match supplies candidates, not invented source text.
 * Quoted queries retain the existing exact body-phrase contract. */
export function matchingNoteNames(
  paths: readonly string[],
  query: string,
  limit: number,
): string[] {
  if (query.includes('"')) return [];
  const words = tokenizeQuery(query);
  if (!words.length || words.length > 8) return [];
  return paths
    .map((path) => ({ path, words: tokenizeNotePath(path) }))
    .filter((entry) =>
      entry.words.some((_, index) =>
        words.every((word, offset) => entry.words[index + offset] === word),
      ),
    )
    .sort((a, b) => a.words.length - b.words.length || a.path.localeCompare(b.path))
    .slice(0, Math.min(limit, 10))
    .map((entry) => entry.path);
}

/** Reciprocal-rank fusion preserves the body/semantic ordering and gives an
 * independently matching filename a vote. These scores are ranks, not BM25. */
export function mergeNamedHits(
  hits: readonly RetrievalHit[],
  named: readonly RetrievalHit[],
  limit: number,
): RetrievalHit[] {
  if (!named.length) return [...hits];
  const ranked = new Map<string, RetrievalHit>();
  for (const [index, hit] of hits.entries())
    ranked.set(hit.note.path, {
      ...hit,
      score: 1 / (60 + index + 1),
      scoreKind: "reciprocal-rank",
    });
  for (const [index, hit] of named.entries()) {
    const previous = ranked.get(hit.note.path);
    // Prefer an exact body-search passage when both routes found this note.
    ranked.set(hit.note.path, {
      ...(previous?.evidence && previous.note.revision === hit.note.revision ? previous : hit),
      score: (previous?.score ?? 0) + 1 / (60 + index + 1),
      scoreKind: "reciprocal-rank",
    });
  }
  return [...ranked.values()]
    .sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path))
    .slice(0, limit);
}
