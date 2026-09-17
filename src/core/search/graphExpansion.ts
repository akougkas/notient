import type { RecordId, Surreal } from "surrealdb";
import {
  expandTypedEdgeNeighbors,
  expandWikilinkNeighbors,
  fetchFirstChunkTextByPath,
  lookupNoteIdsByPaths,
} from "../db/surreal";
import type { SearchHit } from "./types";

export interface GraphExpansionOptions {
  db: Surreal;
  baseHits: SearchHit[];
}

export interface ExpandedHit extends SearchHit {
  /** notePath of the base hit that linked to this expanded note. */
  viaPath: string;
  /** Edge table that produced this neighbour (`wikilink` or a typed edge). */
  edgeType: string;
  /** Edge confidence in [0, 1]. Wikilinks are 1. */
  confidence: number;
}

const SNIPPET_MAX_CHARS = 240;

interface Candidate {
  otherPath: string;
  originPath: string;
  edgeType: string;
  agent: string | null;
  confidence: number;
  weight: number;
}

/**
 * Returns notes one hop away from the base hits, over two expansion sources:
 *
 *   1. approved-and-applied `wikilink` edges (weight 1), and
 *   2. approved-and-applied rows from the six linker edge tables at their
 *      recorded `confidence`.
 *
 * Each expanded hit carries a real score (`seed hit score * edge weight`) and
 * the target note's first chunk text as its snippet, both batched into single
 * queries. Neighbours are deduplicated against the base notePaths and against
 * each other, keeping the strongest edge per neighbour.
 */
export async function expandViaApprovedEdges(
  options: GraphExpansionOptions,
): Promise<ExpandedHit[]> {
  if (options.baseHits.length === 0) return [];
  const baseNoteIds = await resolveBaseNoteIds(options.db, options.baseHits);
  if (baseNoteIds.length === 0) return [];

  const seedScores = new Map<string, number>();
  for (const hit of options.baseHits) {
    const prior = seedScores.get(hit.notePath);
    if (prior === undefined || hit.score > prior) seedScores.set(hit.notePath, hit.score);
  }
  const seenPaths = new Set(seedScores.keys());

  const [wikilinkNeighbors, typedNeighbors] = await Promise.all([
    expandWikilinkNeighbors(options.db, {
      startNoteIds: baseNoteIds,
    }),
    expandTypedEdgeNeighbors(options.db, {
      startNoteIds: baseNoteIds,
    }),
  ]);

  const best = new Map<string, { candidate: Candidate; score: number }>();
  const consider = (candidate: Candidate | null): void => {
    if (candidate === null) return;
    const seedScore = seedScores.get(candidate.originPath) ?? 0;
    const score = seedScore * candidate.weight;
    const existing = best.get(candidate.otherPath);
    if (existing !== undefined && existing.score >= score) return;
    best.set(candidate.otherPath, { candidate, score });
  };

  for (const edge of wikilinkNeighbors) {
    consider(
      orientEdge(seenPaths, edge.fromPath, edge.toPath, {
        edgeType: edge.edgeType,
        agent: edge.agent,
        confidence: 1,
        weight: 1,
      }),
    );
  }
  for (const edge of typedNeighbors) {
    consider(
      orientEdge(seenPaths, edge.fromPath, edge.toPath, {
        edgeType: edge.edgeType,
        agent: edge.agent,
        confidence: edge.confidence,
        weight: edge.confidence,
      }),
    );
  }
  if (best.size === 0) return [];

  const snippets = await fetchFirstChunkTextByPath(options.db, Array.from(best.keys()));

  const expanded: ExpandedHit[] = [];
  for (const [notePath, entry] of best) {
    const { candidate, score } = entry;
    const chunkText = snippets.get(notePath);
    const snippet =
      chunkText !== undefined && chunkText.trim().length > 0
        ? chunkText.slice(0, SNIPPET_MAX_CHARS)
        : `via [[${candidate.originPath}]] (${candidate.edgeType}, agent: ${candidate.agent ?? "unknown"})`;
    expanded.push({
      notePath,
      chunkId: null,
      snippet,
      score,
      matchedText: "",
      viaPath: candidate.originPath,
      edgeType: candidate.edgeType,
      confidence: candidate.confidence,
    });
  }
  expanded.sort((a, b) => b.score - a.score);
  return expanded;
}

/**
 * Orients one edge relative to the base-hit set: whichever endpoint is a base
 * hit becomes the origin and the other becomes the neighbour. Edges whose
 * endpoints are both base hits (or neither) carry no new note and are
 * dropped.
 */
function orientEdge(
  basePaths: ReadonlySet<string>,
  fromPath: string,
  toPath: string,
  edge: Omit<Candidate, "otherPath" | "originPath">,
): Candidate | null {
  const sourceIsBase = basePaths.has(fromPath);
  const targetIsBase = basePaths.has(toPath);
  if (sourceIsBase && targetIsBase) return null;
  if (!sourceIsBase && !targetIsBase) return null;
  const otherPath = sourceIsBase ? toPath : fromPath;
  const originPath = sourceIsBase ? fromPath : toPath;
  return { ...edge, otherPath, originPath };
}

/**
 * One `SELECT ... WHERE path INSIDE $paths` instead of one `lookupNoteByPath`
 * round-trip per base hit.
 */
async function resolveBaseNoteIds(db: Surreal, baseHits: SearchHit[]): Promise<RecordId<"note">[]> {
  const paths = baseHits.map((hit) => hit.notePath);
  const byPath = await lookupNoteIdsByPaths(db, paths);
  const ids: RecordId<"note">[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const id = byPath.get(path);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}
