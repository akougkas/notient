import type { Surreal } from "surrealdb";
import { WRITEBACK_EDGE_TABLES } from "../../approvals/approvalService";
import { type ToolDefinition, isObject, optionalPositiveInt, requireString } from "./registry";

export interface GraphFindPathArgs {
  fromNotePath: string;
  toNotePath: string;
  maxHops?: number;
}

export interface GraphFindPathResult {
  path: string[];
  hops: number;
}

interface EdgeRow {
  fromPath: string | null;
  toPath: string | null;
}

const DEFAULT_MAX_HOPS = 4;
const HARD_MAX_HOPS = 8;

/**
 * BFS over approved-and-applied graph edges. Treats edges as undirected for
 * path-finding because relations like 'supports' and 'extends' are useful in
 * either direction when answering "how are these notes connected?". Returns
 * an empty `path` when no route exists within `maxHops`.
 *
 * Phase 5 Task 7: the SQLite `graph_edges` table is gone; the SurrealDB
 * substrate scatters edges across `wikilink` (deterministic) and the six
 * writeback-capable semantic relations. The BFS unions all of them. The
 * server-side `approved = true AND applied = true` filter matches the
 * search-consumer contract: linker proposals approved but not yet written
 * back to disk are filtered out so path-finding never surfaces a path the
 * user has not yet seen.
 */
export function makeFindPathTool(
  db: Surreal,
): ToolDefinition<GraphFindPathArgs, GraphFindPathResult> {
  return {
    name: "graph.find_path",
    description:
      "Find the shortest path of approved graph edges between two notes. Returns an empty path when none exists within maxHops.",
    schema: {
      type: "object",
      properties: {
        fromNotePath: { type: "string" },
        toNotePath: { type: "string" },
        maxHops: { type: "number", description: "Hop cap. Defaults to 4. Hard max is 8." },
      },
      required: ["fromNotePath", "toNotePath"],
    },
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const fromNotePath = requireString(raw.fromNotePath, "fromNotePath");
      const toNotePath = requireString(raw.toNotePath, "toNotePath");
      const maxHopsRaw = optionalPositiveInt(raw.maxHops, "maxHops");
      const maxHops =
        maxHopsRaw === undefined ? DEFAULT_MAX_HOPS : Math.min(maxHopsRaw, HARD_MAX_HOPS);
      return { fromNotePath, toNotePath, maxHops };
    },
    invoke: async (args) => {
      if (args.fromNotePath === args.toNotePath) {
        return { path: [args.fromNotePath], hops: 0 };
      }
      const maxHops = args.maxHops ?? DEFAULT_MAX_HOPS;
      const parents = await bfsApprovedEdges(db, args.fromNotePath, args.toNotePath, maxHops);
      if (!parents) return { path: [], hops: 0 };
      const ordered = reconstructPath(parents, args.fromNotePath, args.toNotePath);
      return { path: ordered, hops: ordered.length - 1 };
    },
    writeGated: false,
  };
}

const TRAVERSED_TABLES = ["wikilink", ...WRITEBACK_EDGE_TABLES] as const;

async function bfsApprovedEdges(
  db: Surreal,
  fromPath: string,
  toPath: string,
  maxHops: number,
): Promise<Map<string, string> | null> {
  const queue: { path: string; depth: number }[] = [{ path: fromPath, depth: 0 }];
  const parents = new Map<string, string>();
  const visited = new Set<string>([fromPath]);
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (next.depth >= maxHops) continue;
    const reached = await expandFrontier(db, next, parents, visited, toPath, queue);
    if (reached) return parents;
  }
  return null;
}

async function expandFrontier(
  db: Surreal,
  next: { path: string; depth: number },
  parents: Map<string, string>,
  visited: Set<string>,
  toPath: string,
  queue: { path: string; depth: number }[],
): Promise<boolean> {
  for (const table of TRAVERSED_TABLES) {
    const rows = await fetchAdjacentEdges(db, table, next.path);
    if (recordEdges(rows, next, parents, visited, toPath, queue)) return true;
  }
  return false;
}

async function fetchAdjacentEdges(
  db: Surreal,
  table: string,
  notePath: string,
): Promise<EdgeRow[]> {
  const sql = `SELECT in.path AS fromPath, out.path AS toPath FROM ${table} WHERE approved = true AND applied = true AND (in.path = $path OR out.path = $path);`;
  const [rows] = await db.query<[EdgeRow[]]>(sql, { path: notePath }).collect<[EdgeRow[]]>();
  return rows;
}

function recordEdges(
  rows: EdgeRow[],
  next: { path: string; depth: number },
  parents: Map<string, string>,
  visited: Set<string>,
  toPath: string,
  queue: { path: string; depth: number }[],
): boolean {
  for (const row of rows) {
    const otherPath = pickOtherPath(row, next.path);
    if (otherPath === null || visited.has(otherPath)) continue;
    visited.add(otherPath);
    parents.set(otherPath, next.path);
    if (otherPath === toPath) return true;
    queue.push({ path: otherPath, depth: next.depth + 1 });
  }
  return false;
}

function pickOtherPath(row: EdgeRow, currentPath: string): string | null {
  const fromPath = row.fromPath;
  const toPath = row.toPath;
  if (fromPath === null || toPath === null) return null;
  return fromPath === currentPath ? toPath : fromPath;
}

function reconstructPath(parents: Map<string, string>, fromPath: string, toPath: string): string[] {
  const reverse: string[] = [toPath];
  let cursor: string | undefined = toPath;
  while (cursor && cursor !== fromPath) {
    const parent = parents.get(cursor);
    if (!parent) break;
    reverse.push(parent);
    cursor = parent;
  }
  return reverse.reverse();
}

export interface ClusterEntry {
  id: string;
  label: string;
  memberPaths: string[];
  /** Optional source agent or trigger; used purely for display. */
  source?: string;
}

export interface ClusterCache {
  /** Returns the most recent cluster snapshot. Implementations may return a stale copy when no recent run exists. */
  list(): ClusterEntry[];
}

/** Minimal in-memory cluster cache that the Synthesizer (or another agent) can populate. */
export class InMemoryClusterCache implements ClusterCache {
  private entries: ClusterEntry[] = [];

  set(entries: ClusterEntry[]): void {
    this.entries = entries.slice();
  }

  clear(): void {
    this.entries = [];
  }

  list(): ClusterEntry[] {
    return this.entries.slice();
  }
}

export interface GraphListClustersArgs {
  limit?: number;
}

export interface GraphListClustersResult {
  clusters: ClusterEntry[];
}

/**
 * Returns the latest synthesizer cluster snapshot. The cache is populated by
 * the Synthesizer (or a future ClusterIndex). When no cache is wired in, the
 * tool returns an empty list. Phase 5 Task 6 stripped the Synthesizer's
 * production wiring (Locked Decision 11); the cache remains injected so a
 * future task can re-introduce SurrealDB-backed cluster computation without
 * a chat-surface breaking change.
 */
export function makeListClustersTool(
  cache: ClusterCache | null,
): ToolDefinition<GraphListClustersArgs, GraphListClustersResult> {
  return {
    name: "graph.list_clusters",
    description:
      "List the most recent note clusters detected by the Synthesizer. Empty when no recent synthesis run exists.",
    schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum clusters to return." },
      },
      required: [],
    },
    validate: (raw) => {
      if (raw === undefined || raw === null) return {};
      if (!isObject(raw)) throw new Error("expected object");
      const limit = optionalPositiveInt(raw.limit, "limit");
      return { limit };
    },
    invoke: async (args) => {
      if (!cache) return { clusters: [] };
      const all = cache.list();
      const clusters = args.limit ? all.slice(0, args.limit) : all;
      return { clusters };
    },
    writeGated: false,
  };
}
