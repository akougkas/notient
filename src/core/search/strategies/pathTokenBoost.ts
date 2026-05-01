import type { SearchHit } from "../types";

// Strip a leading numeric ordering prefix like "0042-" or "2025_01-".
// Repeated digit groups separated by `-` or `_` are all consumed up to
// (and including) the final separator that introduces the slug body.
const LEADING_NUMERIC_PREFIX = /^\d+(?:[-_]\d+)*[-_]/;
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * Tokenize a free-text query into lowercased word stems. Empty tokens are
 * dropped; nothing else is changed. Pure helper exported for tests.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(NON_WORD)
    .filter((token) => token.length > 0);
}

/**
 * Tokenize a vault-relative note path into lowercased slug words. Strips
 * the directory prefix, file extension, and any leading numeric ordering
 * prefix (`0042-`, `2025_01-`, etc.) so a path like `0002-vector-search.md`
 * becomes `["vector", "search"]`.
 */
export function tokenizeNotePath(notePath: string): string[] {
  const slash = notePath.lastIndexOf("/");
  const base = slash >= 0 ? notePath.slice(slash + 1) : notePath;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const stripped = stem.replace(LEADING_NUMERIC_PREFIX, "");
  return stripped
    .toLowerCase()
    .split(NON_WORD)
    .filter((token) => token.length > 0);
}

const MAX_BOOST = 0.3;

/**
 * Compute the additive boost applied to a note's score given the query and
 * the note's tokenized path. Coverage is Jaccard similarity between the
 * query token set and the path token set; a near-perfect match earns
 * (close to) the full bonus while partial overlaps fall off cubically so
 * the canonical concept note (`vector-search.md` for query "vector search")
 * decisively outranks fillers (`fan-vector-search.md`, `filler-vector-search.md`)
 * whose chunk embeddings are otherwise neck-and-neck.
 *
 * Returns 0 when the query has no usable tokens or the path slug is empty.
 */
export function computePathTokenBoost(queryTokens: string[], pathTokens: string[]): number {
  if (queryTokens.length === 0 || pathTokens.length === 0) return 0;
  const querySet = new Set(queryTokens);
  const pathSet = new Set(pathTokens);
  let intersect = 0;
  for (const token of querySet) {
    if (pathSet.has(token)) intersect += 1;
  }
  if (intersect === 0) return 0;
  const union = querySet.size + pathSet.size - intersect;
  const jaccard = intersect / union;
  // Cubic so 100% match earns the full 0.30 lift while 67% match
  // (one extra path token) earns only ~0.09 — enough of a gap to
  // promote the canonical note past fillers when their embedding
  // scores are within ~0.10 of each other.
  return jaccard ** 3 * MAX_BOOST;
}

/**
 * Apply path-token boost to each hit's score and return a new array sorted
 * by descending boosted score. The original array is not mutated. Hits
 * with no notePath pass through unchanged.
 */
export function applyPathTokenBoost(hits: SearchHit[], query: string): SearchHit[] {
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) return [...hits];
  const boosted = hits.map((hit) => {
    if (hit.notePath.length === 0) return hit;
    const pathTokens = tokenizeNotePath(hit.notePath);
    const bonus = computePathTokenBoost(queryTokens, pathTokens);
    if (bonus === 0) return hit;
    return { ...hit, score: hit.score + bonus };
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}
