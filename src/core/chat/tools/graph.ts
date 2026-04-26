import type { Database } from "../../db/database";
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
  source_id: string;
  target_id: string;
}

const DEFAULT_MAX_HOPS = 4;
const HARD_MAX_HOPS = 8;

/**
 * BFS over approved graph edges. Treats edges as undirected for path-finding
 * because relations like 'supports' and 'extends' are useful in either
 * direction when answering "how are these notes connected?". Returns an empty
 * `path` when no route exists within `maxHops`.
 */
export function makeFindPathTool(
  db: Database,
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
      const fromId = `note:${args.fromNotePath}`;
      const toId = `note:${args.toNotePath}`;
      if (fromId === toId) {
        return { path: [args.fromNotePath], hops: 0 };
      }
      const maxHops = args.maxHops ?? DEFAULT_MAX_HOPS;
      const parents = bfsApprovedEdges(db, fromId, toId, maxHops);
      if (!parents) return { path: [], hops: 0 };
      const ordered = reconstructPath(parents, fromId, toId);
      return { path: ordered, hops: ordered.length - 1 };
    },
    writeGated: false,
  };
}

function bfsApprovedEdges(
  db: Database,
  fromId: string,
  toId: string,
  maxHops: number,
): Map<string, string> | null {
  const queue: { id: string; depth: number }[] = [{ id: fromId, depth: 0 }];
  const parents = new Map<string, string>();
  const visited = new Set<string>([fromId]);
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (next.depth >= maxHops) continue;
    const reached = expandFrontier(db, next, parents, visited, toId, queue);
    if (reached) return parents;
  }
  return null;
}

function expandFrontier(
  db: Database,
  next: { id: string; depth: number },
  parents: Map<string, string>,
  visited: Set<string>,
  toId: string,
  queue: { id: string; depth: number }[],
): boolean {
  const rows = db.query<EdgeRow>(
    `SELECT source_id, target_id FROM graph_edges
     WHERE approved = 1 AND (source_id = ? OR target_id = ?);`,
    [next.id, next.id],
  );
  for (const row of rows) {
    const otherId = row.source_id === next.id ? row.target_id : row.source_id;
    if (!otherId.startsWith("note:")) continue;
    if (visited.has(otherId)) continue;
    visited.add(otherId);
    parents.set(otherId, next.id);
    if (otherId === toId) return true;
    queue.push({ id: otherId, depth: next.depth + 1 });
  }
  return false;
}

function reconstructPath(parents: Map<string, string>, fromId: string, toId: string): string[] {
  const reverse: string[] = [toId];
  let cursor: string | undefined = toId;
  while (cursor && cursor !== fromId) {
    const parent = parents.get(cursor);
    if (!parent) break;
    reverse.push(parent);
    cursor = parent;
  }
  return reverse.reverse().map((id) => id.slice("note:".length));
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
 * tool returns an empty list.
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
