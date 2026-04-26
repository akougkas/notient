import type { Database } from "../../db/database";
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

interface StagingEdgeRow {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  confidence: number;
  agent: string;
  evidence: string;
  rationale: string | null;
  created_at: number;
}

interface StagingNodeRow {
  id: string;
  type: string;
  label: string;
  note_path: string | null;
  payload: string | null;
  agent: string;
  confidence: number;
  created_at: number;
}

/**
 * Read-only proposal listing. Joins staging_edges + staging_nodes against
 * graph_nodes so the chat agent gets a path-resolved view of pending work.
 * Filters by the focal note (matches on either side of an edge or the
 * staging node's note_path/memberPaths) and by agent.
 */
export function makeListProposalsTool(
  db: Database,
): ToolDefinition<ProposalsListArgs, ProposalsListResult> {
  return {
    name: "proposals.list_pending",
    description:
      "List pending agent proposals (edges + nodes) awaiting approval. Optionally filter by notePath or agent.",
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
      const edges = collectEdges(db, args);
      const nodes = collectNodes(db, args);
      const all: ProposalEntry[] = [...edges, ...nodes];
      all.sort((a, b) => b.createdAt - a.createdAt);
      const limited = args.limit ? all.slice(0, args.limit) : all;
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

/** Read-only single-proposal lookup. Returns null when missing or already decided. */
export function makeGetProposalTool(
  db: Database,
): ToolDefinition<ProposalsGetArgs, ProposalsGetResult> {
  return {
    name: "proposals.get",
    description: "Fetch a single pending proposal (edge or node) by id.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Staging row id." },
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
      const edge = db.query<StagingEdgeRow>(
        `SELECT id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at
         FROM staging_edges WHERE id = ? AND decision IS NULL;`,
        [args.id],
      )[0];
      if (edge) {
        return { proposal: toProposalEdge(db, edge) };
      }
      const node = db.query<StagingNodeRow>(
        `SELECT id, type, label, note_path, payload, agent, confidence, created_at
         FROM staging_nodes WHERE id = ? AND decision IS NULL;`,
        [args.id],
      )[0];
      if (node) {
        return { proposal: toProposalNode(node) };
      }
      return { proposal: null };
    },
    writeGated: false,
  };
}

function collectEdges(db: Database, args: ProposalsListArgs): ProposalEdge[] {
  const conditions: string[] = ["decision IS NULL"];
  const params: unknown[] = [];
  if (args.agent) {
    conditions.push("agent = ?");
    params.push(args.agent);
  }
  const rows = db.query<StagingEdgeRow>(
    `SELECT id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at
     FROM staging_edges WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC;`,
    params,
  );
  const proposals = rows.map((row) => toProposalEdge(db, row));
  if (!args.notePath) return proposals;
  const target = args.notePath;
  return proposals.filter(
    (proposal) => proposal.sourceNotePath === target || proposal.targetNotePath === target,
  );
}

function collectNodes(db: Database, args: ProposalsListArgs): ProposalNode[] {
  const conditions: string[] = ["decision IS NULL"];
  const params: unknown[] = [];
  if (args.agent) {
    conditions.push("agent = ?");
    params.push(args.agent);
  }
  const rows = db.query<StagingNodeRow>(
    `SELECT id, type, label, note_path, payload, agent, confidence, created_at
     FROM staging_nodes WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC;`,
    params,
  );
  const proposals = rows.map(toProposalNode);
  if (!args.notePath) return proposals;
  const target = args.notePath;
  return proposals.filter(
    (proposal) => proposal.notePath === target || proposal.memberPaths.includes(target),
  );
}

function toProposalEdge(db: Database, row: StagingEdgeRow): ProposalEdge {
  return {
    kind: "edge",
    id: row.id,
    type: row.type,
    sourceId: row.source_id,
    targetId: row.target_id,
    sourceNotePath: resolveNotePath(db, row.source_id),
    targetNotePath: resolveNotePath(db, row.target_id),
    confidence: row.confidence,
    agent: row.agent,
    evidence: parseEvidence(row.evidence),
    rationale: row.rationale,
    createdAt: row.created_at,
  };
}

function toProposalNode(row: StagingNodeRow): ProposalNode {
  const parsed = parsePayload(row.payload);
  return {
    kind: "node",
    id: row.id,
    type: row.type,
    label: row.label,
    notePath: row.note_path,
    agent: row.agent,
    confidence: row.confidence,
    body: typeof parsed.body === "string" ? parsed.body : null,
    memberPaths: Array.isArray(parsed.memberPaths)
      ? parsed.memberPaths.filter((entry): entry is string => typeof entry === "string")
      : [],
    targetPath: typeof parsed.targetPath === "string" ? parsed.targetPath : null,
    createdAt: row.created_at,
  };
}

function resolveNotePath(db: Database, nodeId: string): string | null {
  if (nodeId.startsWith("note:")) return nodeId.slice("note:".length);
  const row = db.query<{ note_path: string | null }>(
    "SELECT note_path FROM graph_nodes WHERE id = ?;",
    [nodeId],
  )[0];
  return row?.note_path ?? null;
}

function parseEvidence(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    // ignore parse failures; treat as empty evidence
  }
  return [];
}

function parsePayload(raw: string | null): {
  body?: unknown;
  memberPaths?: unknown;
  targetPath?: unknown;
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
