import type { ConnectivityTier } from "../vitals/types";
import type { SearchFilters } from "./types";

export interface SqlFragment {
  where: string;
  params: unknown[];
}

/**
 * Builds SQL WHERE fragment for the path/maturity/date filters that can be
 * pushed down into the chunks/notes join. Always returns a fragment that
 * begins with `AND` when non-empty so callers can append it after a base
 * predicate; empty fragment is the empty string.
 */
export function buildPathFilter(filters: SearchFilters | undefined): SqlFragment {
  if (!filters) return { where: "", params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.folders && filters.folders.length > 0) {
    const ors = filters.folders.map(() => "notes.path LIKE ?");
    clauses.push(`(${ors.join(" OR ")})`);
    for (const folder of filters.folders) {
      params.push(`${folder.replace(/\/$/, "")}/%`);
    }
  }
  if (filters.maturity && filters.maturity.length > 0) {
    const placeholders = filters.maturity.map(() => "?").join(",");
    clauses.push(`notes.maturity IN (${placeholders})`);
    params.push(...filters.maturity);
  }
  if (typeof filters.fromDate === "number") {
    clauses.push("notes.updated_at >= ?");
    params.push(filters.fromDate);
  }
  if (typeof filters.toDate === "number") {
    clauses.push("notes.updated_at <= ?");
    params.push(filters.toDate);
  }
  return {
    where: clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`,
    params,
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
