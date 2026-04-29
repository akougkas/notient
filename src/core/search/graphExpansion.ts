import type { RecordId, Surreal } from "surrealdb";
import { expandWikilinkNeighbors, lookupNoteByPath } from "../db/surreal";
import type { SearchHit } from "./types";

export interface GraphExpansionOptions {
  db: Surreal;
  baseHits: SearchHit[];
  /**
   * Hop depth. `0` is a no-op. Phase 4 only exercises depth 1; the SurrealQL
   * recursive-traversal helper accepts higher depths but the expansion call
   * site filters everything except direct neighbours of the base hits.
   */
  depth: number;
}

export interface ExpandedHit extends SearchHit {
  /** notePath of the base hit that linked to this expanded note. */
  viaPath: string;
}

/**
 * Returns notes one approved-and-applied wikilink hop away from the base hits.
 * The unioned neighbour set is deduplicated against the base notePaths so
 * callers can concatenate base + expanded without repeating notes. Each
 * expanded hit carries a `viaPath` field marking the base note that introduced
 * it.
 *
 * `approved = true AND applied = true` is enforced server-side by
 * `expandWikilinkNeighbors`. Linker proposals approved but not yet written
 * back to disk are filtered out so graph expansion never surfaces a path
 * the user has not yet seen.
 */
export async function expandViaApprovedEdges(
  options: GraphExpansionOptions,
): Promise<ExpandedHit[]> {
  if (options.depth <= 0) return [];
  if (options.baseHits.length === 0) return [];
  const baseNoteIds = await resolveBaseNoteIds(options.db, options.baseHits);
  if (baseNoteIds.length === 0) return [];
  const seenPaths = new Set(options.baseHits.map((hit) => hit.notePath));
  const neighbors = await expandWikilinkNeighbors(options.db, {
    startNoteIds: baseNoteIds,
    depth: options.depth,
  });
  const expanded: ExpandedHit[] = [];
  for (const edge of neighbors) {
    const sourceIsBase = seenPaths.has(edge.fromPath);
    const targetIsBase = seenPaths.has(edge.toPath);
    if (sourceIsBase && targetIsBase) continue;
    const otherPath = sourceIsBase ? edge.toPath : edge.fromPath;
    if (seenPaths.has(otherPath)) continue;
    const originPath = sourceIsBase ? edge.fromPath : edge.toPath;
    seenPaths.add(otherPath);
    const agentLabel = edge.agent ?? "unknown";
    expanded.push({
      notePath: otherPath,
      chunkId: null,
      snippet: `via [[${originPath}]] (${edge.edgeType}, agent: ${agentLabel})`,
      score: 0.5,
      matchedText: "",
      viaPath: originPath,
    });
  }
  return expanded;
}

async function resolveBaseNoteIds(db: Surreal, baseHits: SearchHit[]): Promise<RecordId<"note">[]> {
  const ids: RecordId<"note">[] = [];
  const seen = new Set<string>();
  for (const hit of baseHits) {
    if (seen.has(hit.notePath)) continue;
    seen.add(hit.notePath);
    const id = await lookupNoteByPath(db, hit.notePath);
    if (id !== null) ids.push(id);
  }
  return ids;
}
