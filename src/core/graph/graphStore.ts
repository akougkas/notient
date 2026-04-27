import type { Database } from "../db/database";
import type { EdgeType, GraphEdge, GraphNode, NodeType } from "./types";

interface EdgeRow {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  confidence: number;
  agent: string;
  evidence: string;
  approved: number;
  created_at: number;
}

interface NodeRow {
  id: string;
  type: string;
  label: string;
  note_path: string | null;
  payload: string | null;
  created_at: number;
}

export class GraphStore {
  constructor(private readonly db: Database) {}

  upsertNode(node: GraphNode): void {
    this.db.run(
      `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label, payload = excluded.payload;`,
      [
        node.id,
        node.type,
        node.label,
        node.notePath,
        node.payload ? JSON.stringify(node.payload) : null,
        node.createdAt,
      ],
    );
  }

  insertEdge(edge: GraphEdge): void {
    // Idempotent on duplicate id. The indexer can produce two edges with byte-identical
    // (type, sourceId, targetId, nowMs) when the extractor returns equivalent concepts,
    // claims, or questions for the same note; re-asserting the same edge is the same edge.
    // Mirrors upsertNode's ON CONFLICT pattern so the graph-store API is fully idempotent.
    this.db.run(
      `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO NOTHING;`,
      [
        edge.id,
        edge.type,
        edge.sourceId,
        edge.targetId,
        edge.confidence,
        edge.agent,
        JSON.stringify(edge.evidence),
        edge.approved ? 1 : 0,
        edge.createdAt,
      ],
    );
  }

  approveEdge(id: string): void {
    this.db.run("UPDATE graph_edges SET approved = 1 WHERE id = ?;", [id]);
  }

  edgesFor(nodeId: string): GraphEdge[] {
    const rows = this.db.query<EdgeRow>(
      `SELECT id, type, source_id, target_id, confidence, agent, evidence, approved, created_at
       FROM graph_edges WHERE source_id = ? OR target_id = ?;`,
      [nodeId, nodeId],
    );
    return rows.map(rowToEdge);
  }

  edgesByType(type: EdgeType, approvedOnly = false): GraphEdge[] {
    const rows = this.db.query<EdgeRow>(
      approvedOnly
        ? "SELECT * FROM graph_edges WHERE type = ? AND approved = 1;"
        : "SELECT * FROM graph_edges WHERE type = ?;",
      [type],
    );
    return rows.map(rowToEdge);
  }

  nodesByType(type: NodeType): GraphNode[] {
    const rows = this.db.query<NodeRow>("SELECT * FROM graph_nodes WHERE type = ?;", [type]);
    return rows.map(rowToNode);
  }
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    type: row.type as EdgeType,
    sourceId: row.source_id,
    targetId: row.target_id,
    confidence: row.confidence,
    agent: row.agent,
    evidence: JSON.parse(row.evidence) as string[],
    approved: row.approved === 1,
    createdAt: row.created_at,
  };
}

function rowToNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    type: row.type as NodeType,
    label: row.label,
    notePath: row.note_path,
    payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null,
    createdAt: row.created_at,
  };
}
