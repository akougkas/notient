import type { Database } from "../../db/database";
import type { SearchPipeline } from "../../search/searchPipeline";
import type { SearchFilters, SearchHit, SearchResult } from "../../search/types";
import type { VitalsSnapshot } from "../../vitals/types";
import type { VitalsService } from "../../vitals/vitalsService";
import { type ToolDefinition, isObject, optionalPositiveInt, requireString } from "./registry";

export interface VaultFacade {
  /** Returns the markdown body of a note. Throws if the path does not exist. */
  readNote(path: string): Promise<string>;
}

export interface VaultSearchArgs {
  query: string;
  mode: "quick" | "balanced";
  limit?: number;
  filters?: SearchFilters;
}

export interface VaultSearchResult {
  hits: SearchHit[];
  durationMs: number;
}

/**
 * Vault search tool. Routes through the existing SearchPipeline so the chat
 * agent gets the same ranking and filters as the Search tab. Restricted to
 * Quick + Balanced because Deep is reserved for explicit user-driven search.
 */
export function makeVaultSearchTool(
  pipeline: SearchPipeline,
): ToolDefinition<VaultSearchArgs, VaultSearchResult> {
  return {
    name: "vault.search_notes",
    description:
      "Search the vault by keyword (mode='quick') or semantic similarity (mode='balanced'). Returns ranked hits.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        mode: {
          type: "string",
          enum: ["quick", "balanced"],
          description: "'quick' = keyword/fuzzy. 'balanced' = embedding + reranker.",
        },
        limit: { type: "number", description: "Maximum number of hits to return." },
        filters: { type: "object", description: "Optional SearchFilters payload." },
      },
      required: ["query", "mode"],
    },
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const query = requireString(raw.query, "query");
      const mode = raw.mode === "quick" || raw.mode === "balanced" ? raw.mode : null;
      if (!mode) throw new Error("mode must be 'quick' or 'balanced'");
      const limit = optionalPositiveInt(raw.limit, "limit");
      const filters = isObject(raw.filters) ? (raw.filters as SearchFilters) : undefined;
      return { query, mode, limit, filters };
    },
    invoke: async (args, signal) => {
      let result: SearchResult | null = null;
      let errorMessage: string | null = null;
      for await (const event of pipeline.run(
        { query: args.query, mode: args.mode, filters: args.filters, limit: args.limit },
        signal,
      )) {
        if (event.type === "search:done") {
          result = event.result;
        } else if (event.type === "search:error") {
          errorMessage = event.message;
        }
      }
      if (errorMessage) throw new Error(`vault.search_notes failed: ${errorMessage}`);
      if (!result) throw new Error("vault.search_notes produced no result");
      return { hits: result.hits, durationMs: result.durationMs };
    },
    writeGated: false,
  };
}

export interface VaultReadArgs {
  notePath: string;
  lineRange?: { start: number; end: number };
}

export interface VaultReadResult {
  notePath: string;
  body: string;
  totalLines: number;
  lineRange?: { start: number; end: number };
}

/**
 * Read a note (optionally a line range). 1-based, inclusive line numbers.
 */
export function makeReadNoteTool(
  facade: VaultFacade,
): ToolDefinition<VaultReadArgs, VaultReadResult> {
  return {
    name: "vault.read_note",
    description:
      "Read a note's body. Provide an optional 1-based inclusive lineRange to fetch a slice.",
    schema: {
      type: "object",
      properties: {
        notePath: { type: "string", description: "Vault-relative path to the note." },
        lineRange: {
          type: "object",
          properties: {
            start: { type: "number" },
            end: { type: "number" },
          },
          required: ["start", "end"],
        },
      },
      required: ["notePath"],
    },
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = requireString(raw.notePath, "notePath");
      let lineRange: { start: number; end: number } | undefined;
      if (raw.lineRange !== undefined) {
        if (!isObject(raw.lineRange)) throw new Error("lineRange must be an object");
        const start = raw.lineRange.start;
        const end = raw.lineRange.end;
        if (typeof start !== "number" || typeof end !== "number") {
          throw new Error("lineRange.start and lineRange.end must be numbers");
        }
        if (start < 1 || end < start) {
          throw new Error("lineRange.start must be >= 1 and end must be >= start");
        }
        lineRange = { start: Math.floor(start), end: Math.floor(end) };
      }
      return { notePath, lineRange };
    },
    invoke: async (args) => {
      const body = await facade.readNote(args.notePath);
      const lines = body.split("\n");
      if (!args.lineRange) {
        return { notePath: args.notePath, body, totalLines: lines.length };
      }
      const start = Math.min(args.lineRange.start, lines.length);
      const end = Math.min(args.lineRange.end, lines.length);
      const slice = lines.slice(start - 1, end).join("\n");
      return {
        notePath: args.notePath,
        body: slice,
        totalLines: lines.length,
        lineRange: { start, end },
      };
    },
    writeGated: false,
  };
}

export interface VaultListNeighborsArgs {
  notePath: string;
}

export interface VaultNeighbor {
  notePath: string;
  type: string;
  agent: string;
  confidence: number;
  direction: "outgoing" | "incoming";
}

export interface VaultListNeighborsResult {
  notePath: string;
  neighbors: VaultNeighbor[];
}

interface NeighborRow {
  source_id: string;
  target_id: string;
  type: string;
  agent: string;
  confidence: number;
}

/**
 * Lists notes that share an approved graph edge with the given note. Reads
 * `graph_edges` directly because edges are pre-resolved to `note:` ids by
 * the indexer/approval pipeline.
 */
export function makeListNeighborsTool(
  db: Database,
): ToolDefinition<VaultListNeighborsArgs, VaultListNeighborsResult> {
  return {
    name: "vault.list_neighbors",
    description: "List notes connected to the given note via approved graph edges.",
    schema: {
      type: "object",
      properties: {
        notePath: { type: "string", description: "Vault-relative path of the source note." },
      },
      required: ["notePath"],
    },
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = requireString(raw.notePath, "notePath");
      return { notePath };
    },
    invoke: async (args) => {
      const nodeId = `note:${args.notePath}`;
      const rows = db.query<NeighborRow>(
        `SELECT source_id, target_id, type, agent, confidence FROM graph_edges
         WHERE approved = 1 AND (source_id = ? OR target_id = ?);`,
        [nodeId, nodeId],
      );
      const neighbors: VaultNeighbor[] = [];
      for (const row of rows) {
        const outgoing = row.source_id === nodeId;
        const otherId = outgoing ? row.target_id : row.source_id;
        if (!otherId.startsWith("note:")) continue;
        neighbors.push({
          notePath: otherId.slice("note:".length),
          type: row.type,
          agent: row.agent,
          confidence: row.confidence,
          direction: outgoing ? "outgoing" : "incoming",
        });
      }
      return { notePath: args.notePath, neighbors };
    },
    writeGated: false,
  };
}

export interface VaultGetVitalsArgs {
  notePath: string;
}

export interface VaultGetVitalsResult {
  snapshot: VitalsSnapshot | null;
}

/**
 * Computes the vitals snapshot for the given note. Returns `{snapshot: null}`
 * when the note is not indexed.
 */
export function makeGetVitalsTool(
  vitals: VitalsService,
): ToolDefinition<VaultGetVitalsArgs, VaultGetVitalsResult> {
  return {
    name: "vault.get_vitals",
    description: "Compute the freshness/health/connectivity snapshot for a note.",
    schema: {
      type: "object",
      properties: {
        notePath: { type: "string", description: "Vault-relative path of the note." },
      },
      required: ["notePath"],
    },
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = requireString(raw.notePath, "notePath");
      return { notePath };
    },
    invoke: async (args) => {
      const snapshot = vitals.computeSnapshot(args.notePath);
      return { snapshot };
    },
    writeGated: false,
  };
}
