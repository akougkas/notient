import type { Database } from "../db/database";
import type { SearchHit } from "./types";

export interface GraphExpansionOptions {
  db: Database;
  baseHits: SearchHit[];
  /** Hop depth. `0` is a no-op. Currently only depth `1` is supported. */
  depth: number;
}

export interface ExpandedHit extends SearchHit {
  /** notePath of the base hit that linked to this expanded note. */
  viaPath: string;
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  type: string;
  agent: string;
}

/**
 * Returns notes one approved-edge hop away from the base hits. The unioned
 * neighbour set is deduplicated against the base notePaths so callers can
 * concatenate base + expanded without repeating notes. Each expanded hit
 * carries a `viaPath` field marking the base note that introduced it.
 */
export function expandViaApprovedEdges(options: GraphExpansionOptions): ExpandedHit[] {
  if (options.depth <= 0) return [];
  if (options.baseHits.length === 0) return [];
  const seenPaths = new Set(options.baseHits.map((hit) => hit.notePath));
  const baseNodeIds = options.baseHits.map((hit) => `note:${hit.notePath}`);
  const baseNodeSet = new Set(baseNodeIds);
  const placeholders = baseNodeIds.map(() => "?").join(",");
  const rows = options.db.query<EdgeRow>(
    `SELECT source_id, target_id, type, agent FROM graph_edges
     WHERE approved = 1 AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}));`,
    [...baseNodeIds, ...baseNodeIds],
  );
  const expanded: ExpandedHit[] = [];
  for (const row of rows) {
    const sourceIsBase = baseNodeSet.has(row.source_id);
    const targetIsBase = baseNodeSet.has(row.target_id);
    const otherId = sourceIsBase ? row.target_id : row.source_id;
    if (!otherId.startsWith("note:")) continue;
    const otherPath = otherId.slice("note:".length);
    if (seenPaths.has(otherPath)) continue;
    const originId = sourceIsBase ? row.source_id : row.target_id;
    if (sourceIsBase && targetIsBase) continue;
    const originPath = originId.slice("note:".length);
    seenPaths.add(otherPath);
    expanded.push({
      notePath: otherPath,
      chunkId: null,
      snippet: `via [[${originPath}]] (${row.type}, agent: ${row.agent})`,
      score: 0.5,
      matchedText: "",
      viaPath: originPath,
    });
  }
  return expanded;
}
