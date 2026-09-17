import type { ConnectivityTier } from "../vitals/types";
import type { SearchFilters } from "./types";

export interface SurrealFilterFragment {
  /**
   * SurrealQL WHERE fragment that always begins with ` AND ` when non-empty.
   * Callers append it to the kNN/BM25 predicate inside a single statement so
   * filters compose as server-side WHERE clauses rather than as a Node-side
   * filter pass over hits.
   */
  where: string;
  /**
   * Bindings keyed by the `$param` names embedded in `where`. Names are
   * prefixed `f_` to avoid colliding with the strategy-level `$q` / `$bm25`
   * bindings.
   */
  bindings: Record<string, unknown>;
}

/** Explicit quoted subjects constrain every retrieval path, including fallback. */
export function withQueryPhrases(
  query: string,
  filter: SurrealFilterFragment,
): SurrealFilterFragment {
  const phrases = [...query.matchAll(/"([^"\r\n]+)"/g)].map((match) => match[1].toLowerCase());
  if (phrases.length > 8) throw new Error("Search supports at most eight quoted phrases.");
  const bindings = { ...filter.bindings };
  const clauses = phrases.map((phrase, index) => {
    bindings[`f_phrase_${index}`] = phrase;
    return ` AND string::contains(string::lowercase(text), $f_phrase_${index})`;
  });
  return { where: filter.where + clauses.join(""), bindings };
}

/**
 * Build a SurrealQL WHERE fragment for the path/maturity/date filters that can
 * be pushed down into the chunk → note join. Always returns a fragment that
 * begins with `AND` when non-empty so callers can append it after a base
 * predicate; an empty fragment is `{ where: "", bindings: {} }`.
 *
 * `note.path`, `note.maturity`, and `note.last_user_edit_at` use dotted-field
 * access, which SurrealDB resolves through the `record<note>` link on
 * `chunk.note`.
 */
export function buildChunkNoteFilter(filters: SearchFilters | undefined): SurrealFilterFragment {
  if (!filters) return { where: "", bindings: {} };
  const clauses: string[] = [];
  const bindings: Record<string, unknown> = {};
  if (filters.folders && filters.folders.length > 0) {
    const ors: string[] = [];
    filters.folders.forEach((folder, index) => {
      const key = `f_folder_${index}`;
      ors.push(`string::starts_with(note.path, $${key})`);
      bindings[key] = `${folder.replace(/\/$/, "")}/`;
    });
    clauses.push(`(${ors.join(" OR ")})`);
  }
  if (filters.maturity && filters.maturity.length > 0) {
    bindings.f_maturity = filters.maturity;
    clauses.push("note.maturity INSIDE $f_maturity");
  }
  if (typeof filters.fromDate === "number") {
    bindings.f_from = new Date(filters.fromDate);
    clauses.push("note.last_user_edit_at >= $f_from");
  }
  if (typeof filters.toDate === "number") {
    bindings.f_to = new Date(filters.toDate);
    clauses.push("note.last_user_edit_at <= $f_to");
  }
  return {
    where: clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`,
    bindings,
  };
}

export interface PostFilterContext {
  approvedEdgeCountByPath: Map<string, number>;
  pendingByPath: Map<string, number>;
  thresholds: { sparse: number; connected: number; hub: number };
}

/**
 * Applies post-query filters that depend on supporting tables which are not
 * cheap to join inline (graph_edges, staging_edges). Caller pre-loads the
 * counts; this function is pure.
 */
export function applyPostFilters<T extends { notePath: string }>(
  hits: T[],
  filters: SearchFilters | undefined,
  context: PostFilterContext,
): T[] {
  if (!filters) return hits;
  const tierWanted = filters.connectivityTiers && filters.connectivityTiers.length > 0;
  const wantsPending = filters.hasPendingProposals === true;
  if (!tierWanted && !wantsPending) return hits;
  return hits.filter((hit) => {
    if (tierWanted) {
      const count = context.approvedEdgeCountByPath.get(hit.notePath) ?? 0;
      const tier = bucketTier(count, context.thresholds);
      if (!filters.connectivityTiers?.includes(tier)) return false;
    }
    if (wantsPending) {
      const pending = context.pendingByPath.get(hit.notePath) ?? 0;
      if (pending === 0) return false;
    }
    return true;
  });
}

function bucketTier(
  count: number,
  thresholds: { sparse: number; connected: number; hub: number },
): ConnectivityTier {
  if (count >= thresholds.hub) return "hub";
  if (count >= thresholds.connected) return "connected";
  if (count >= thresholds.sparse) return "sparse";
  return "isolated";
}
