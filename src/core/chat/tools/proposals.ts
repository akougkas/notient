import { type RecordId, StringRecordId, type Surreal } from "surrealdb";
import { WRITEBACK_EDGE_TABLES, type WritebackEdgeTable } from "../../approvals/approvalService";
import { type ToolDefinition, isObject, optionalPositiveInt, optionalString } from "./registry";

export interface ProposalEdge {
  kind: "edge";
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  sourceNotePath: string | null;
  targetNotePath: string | null;
  confidence: number;
  agent: string;
  evidence: string[];
  rationale: string | null;
  createdAt: number;
}

/**
 * Phase 5 Task 7: the staging-node concept retired in Phase 4. Surrealdb
 * proposals are exclusively edge rows in the writeback-capable tables. The
 * `ProposalNode` shape is preserved as a type alias so the tool result
 * union still matches the SQLite-era LLM contract; production callers will
 * never see a `kind: "node"` entry.
 */
export interface ProposalNode {
  kind: "node";
  id: string;
  type: string;
  label: string;
  notePath: string | null;
  agent: string;
  confidence: number;
  body: string | null;
  memberPaths: string[];
  targetPath: string | null;
  createdAt: number;
}

export type ProposalEntry = ProposalEdge | ProposalNode;

export interface ProposalsListArgs {
  notePath?: string;
  agent?: string;
  limit?: number;
}

export interface ProposalsListResult {
  proposals: ProposalEntry[];
}

interface EdgeRow {
  id: RecordId;
  fromPath: string | null;
  toPath: string | null;
  fromId: RecordId<"note">;
  toId: RecordId<"note">;
  agent: string | null;
  confidence: number;
  /** SurrealDB datetime; SDK delivers it as `Date` or an ISO string. */
  created_at: Date | string;
}

/**
 * Read-only proposal listing. After Phase 4 the staging tables are gone;
 * proposals are rows in the six writeback-capable edge tables with
 * `approved = false`. Filters by the focal note (matches on either side of
 * an edge's resolved `note.path`) and by the linker `agent` field.
 *
 * Drift note: the SQLite version ordered by autoincrement `id`. SurrealDB
 * ordering uses `created_at` (the closest monotonic equivalent). The chat
 * agent reads only `proposals[*].id` and `proposals[*].createdAt`, so the
 * wire shape is unchanged.
 */
export function makeListProposalsTool(
  db: Surreal,
): ToolDefinition<ProposalsListArgs, ProposalsListResult> {
  return {
    name: "proposals.list_pending",
    description:
      "List pending agent proposals (edges) awaiting approval. Optionally filter by notePath or agent.",
    schema: {
      type: "object",
      properties: {
        notePath: { type: "string", description: "Filter to proposals touching this note." },
        agent: { type: "string", description: "Filter to a single agent name." },
        limit: { type: "number", description: "Maximum proposals to return per kind." },
      },
      required: [],
    },
    validate: (raw) => {
      if (raw === undefined || raw === null) return {};
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = optionalString(raw.notePath, "notePath");
      const agent = optionalString(raw.agent, "agent");
      const limit = optionalPositiveInt(raw.limit, "limit");
      return { notePath, agent, limit };
    },
    invoke: async (args) => {
      const edges = await collectEdges(db, args);
      edges.sort((a, b) => b.createdAt - a.createdAt);
      const limited = args.limit ? edges.slice(0, args.limit) : edges;
      return { proposals: limited };
    },
    writeGated: false,
  };
}

export interface ProposalsGetArgs {
  id: string;
}

export interface ProposalsGetResult {
  proposal: ProposalEntry | null;
}

/**
 * Read-only single-proposal lookup. Returns null when the row is missing or
 * has already been approved. The id may be a SurrealDB record id string
 * (e.g. `supports:abc123`) — the lookup walks the six writeback tables and
 * returns the first match. The chat surface never receives a node-kind id
 * post-Phase 4.
 */
export function makeGetProposalTool(
  db: Surreal,
): ToolDefinition<ProposalsGetArgs, ProposalsGetResult> {
  return {
    name: "proposals.get",
    description: "Fetch a single pending proposal (edge) by id.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "SurrealDB edge record id." },
      },
      required: ["id"],
    },
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
      if (!id) throw new Error("id must be a non-empty string");
      return { id };
    },
    invoke: async (args) => {
      for (const table of WRITEBACK_EDGE_TABLES) {
        const row = await selectEdgeById(db, table, args.id);
        if (row !== null) {
          return { proposal: toProposalEdge(table, row) };
        }
      }
      return { proposal: null };
    },
    writeGated: false,
  };
}

async function collectEdges(db: Surreal, args: ProposalsListArgs): Promise<ProposalEdge[]> {
  const proposals: ProposalEdge[] = [];
  for (const table of WRITEBACK_EDGE_TABLES) {
    const conditions: string[] = ["approved = false"];
    const bindings: Record<string, unknown> = {};
    if (args.agent !== undefined) {
      conditions.push("agent = $agent");
      bindings.agent = args.agent;
    }
    if (args.notePath !== undefined) {
      conditions.push("(in.path = $path OR out.path = $path)");
      bindings.path = args.notePath;
    }
    // SurrealDB 3.x requires every ORDER BY field to appear in the projection.
    const sql = `SELECT id, in AS fromId, out AS toId, in.path AS fromPath, out.path AS toPath, agent, confidence, created_at FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC;`;
    const [rows] = await db.query<[EdgeRow[]]>(sql, bindings).collect<[EdgeRow[]]>();
    for (const row of rows) {
      proposals.push(toProposalEdge(table, row));
    }
  }
  return proposals;
}

async function selectEdgeById(
  db: Surreal,
  table: WritebackEdgeTable,
  id: string,
): Promise<EdgeRow | null> {
  // The chat agent passes a stringified SurrealDB record id (e.g.
  // `supports:⟨abc-uuid⟩`). Reject ids that target a different table; for
  // the matching table we hand the SDK a `StringRecordId` so the WHERE
  // clause does an indexed exact match.
  if (!id.startsWith(`${table}:`)) return null;
  let recordId: StringRecordId;
  try {
    recordId = new StringRecordId(id);
  } catch {
    return null;
  }
  try {
    const sql = `SELECT id, in AS fromId, out AS toId, in.path AS fromPath, out.path AS toPath, agent, confidence, created_at FROM ${table} WHERE id = $id AND approved = false LIMIT 1;`;
    const [rows] = await db.query<[EdgeRow[]]>(sql, { id: recordId }).collect<[EdgeRow[]]>();
    return rows[0] ?? null;
  } catch {
    // Malformed record-id strings are not the caller's mistake; treat as a
    // miss and let the next table try.
    return null;
  }
}

function toProposalEdge(table: WritebackEdgeTable, row: EdgeRow): ProposalEdge {
  return {
    kind: "edge",
    id: row.id.toString(),
    type: table,
    sourceId: row.fromId.toString(),
    targetId: row.toId.toString(),
    sourceNotePath: row.fromPath,
    targetNotePath: row.toPath,
    confidence: row.confidence,
    agent: row.agent ?? "unknown",
    // The Phase 4 schema stores evidence as `option<array<record<chunk>>>`;
    // chat tools surface it as a string array (chunk record ids stringified)
    // so the LLM contract is untouched. Today the linker writes no evidence;
    // the field is reserved for future extractor-emitted edges.
    evidence: [],
    rationale: null,
    createdAt: parseDateTime(row.created_at),
  };
}

function parseDateTime(value: Date | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
