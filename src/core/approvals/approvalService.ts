import type { Database } from "../db/database";
import type { EventBus } from "../events/eventBus";
import type {
  ApprovedLink,
  NativeGraphBridge,
  RelatedRelation,
  RelationKind,
} from "../graph/nativeGraphBridge";

export interface ApprovalServiceOptions {
  db: Database;
  bus: EventBus;
  bridge?: NativeGraphBridge;
}

export interface PendingEdge {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  confidence: number;
  agent: string;
  evidence: string[];
  rationale: string | null;
  createdAt: number;
}

const TYPED_RELATIONS: ReadonlyArray<RelationKind> = [
  "contradicts",
  "supports",
  "extends",
  "synthesizes_from",
];

function isTypedRelation(type: string): type is RelationKind {
  return (TYPED_RELATIONS as ReadonlyArray<string>).includes(type);
}

export class ApprovalService {
  constructor(private readonly opts: ApprovalServiceOptions) {}

  listPendingEdges(): PendingEdge[] {
    const rows = this.opts.db.query<{
      id: string;
      type: string;
      source_id: string;
      target_id: string;
      confidence: number;
      agent: string;
      evidence: string;
      rationale: string | null;
      created_at: number;
    }>(
      `SELECT id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at
       FROM staging_edges WHERE decision IS NULL ORDER BY created_at DESC;`,
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      sourceId: r.source_id,
      targetId: r.target_id,
      confidence: r.confidence,
      agent: r.agent,
      evidence: JSON.parse(r.evidence) as string[],
      rationale: r.rationale,
      createdAt: r.created_at,
    }));
  }

  async acceptEdge(id: string): Promise<void> {
    const row = this.opts.db.query<{
      id: string;
      type: string;
      source_id: string;
      target_id: string;
      confidence: number;
      agent: string;
      evidence: string;
    }>(
      "SELECT id, type, source_id, target_id, confidence, agent, evidence FROM staging_edges WHERE id = ? AND decision IS NULL;",
      [id],
    )[0];
    if (!row) return;
    const liveId = row.id.replace(/^staging:/, "edge:");
    this.opts.db.transaction(() => {
      this.opts.db.run(
        `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
         VALUES (?,?,?,?,?,?,?,?,?);`,
        [
          liveId,
          row.type,
          row.source_id,
          row.target_id,
          row.confidence,
          row.agent,
          row.evidence,
          1,
          Date.now(),
        ],
      );
      this.opts.db.run(
        "UPDATE staging_edges SET decision = 'accepted', decided_at = ? WHERE id = ?;",
        [Date.now(), id],
      );
    });
    await this.opts.db.persist();
    if (this.opts.bridge) {
      const sourcePath = this.resolveNotePath(row.source_id);
      const targetPath = this.resolveNotePath(row.target_id);
      if (sourcePath && targetPath) {
        if (row.type === "links_to") {
          const link: ApprovedLink = { sourcePath, targetPath, agent: row.agent };
          await this.opts.bridge.applyApprovedLink(link);
        } else if (isTypedRelation(row.type)) {
          const relation: RelatedRelation = {
            sourcePath,
            targetPath,
            relation: row.type,
            agent: row.agent,
          };
          await this.opts.bridge.applyApprovedRelation(relation);
        }
      }
    }
    this.opts.bus.emit({ type: "approval:decided", kind: "edge", id, decision: "accepted" });
  }

  async rejectEdge(id: string): Promise<void> {
    this.opts.db.run("DELETE FROM staging_edges WHERE id = ?;", [id]);
    await this.opts.db.persist();
    this.opts.bus.emit({ type: "approval:decided", kind: "edge", id, decision: "rejected" });
  }

  private resolveNotePath(nodeId: string): string | null {
    if (nodeId.startsWith("note:")) {
      return nodeId.slice("note:".length);
    }
    const rows = this.opts.db.query<{ note_path: string | null }>(
      "SELECT note_path FROM graph_nodes WHERE id = ?;",
      [nodeId],
    );
    return rows[0]?.note_path ?? null;
  }
}
