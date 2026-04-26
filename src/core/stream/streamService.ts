import { type Signal, signal } from "@preact/signals";
import type { Database } from "../db/database";
import type { EventBus } from "../events/eventBus";
import { computeScore } from "./ranking";
import type { StreamItem, StreamSettings } from "./types";

export interface StreamServiceOptions {
  db: Database;
  bus: EventBus;
  now: () => number;
  getActivePath: () => string | null;
  settings: () => StreamSettings;
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
  agent: string;
  confidence: number;
  created_at: number;
}

interface NodePathRow {
  id: string;
  note_path: string | null;
}

export class StreamService {
  readonly items: Signal<StreamItem[]> = signal<StreamItem[]>([]);
  private offRunFinished: (() => void) | null = null;
  private offApproval: (() => void) | null = null;
  private offLeafChange: (() => void) | null = null;

  constructor(private readonly options: StreamServiceOptions) {}

  start(): void {
    this.offRunFinished = this.options.bus.on("agent:run-finished", () => this.refresh());
    this.offApproval = this.options.bus.on("approval:decided", () => this.refresh());
    this.offLeafChange = this.options.bus.on("active-leaf-change", () => this.refresh());
    this.refresh();
  }

  stop(): void {
    this.offRunFinished?.();
    this.offApproval?.();
    this.offLeafChange?.();
    this.offRunFinished = null;
    this.offApproval = null;
    this.offLeafChange = null;
  }

  refresh(): void {
    const settings = this.options.settings();
    const now = this.options.now();
    const activePath = this.options.getActivePath();
    const edges = this.options.db.query<StagingEdgeRow>(
      `SELECT id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at
       FROM staging_edges WHERE decision IS NULL;`,
    );
    const nodes = this.options.db.query<StagingNodeRow>(
      `SELECT id, type, label, note_path, agent, confidence, created_at
       FROM staging_nodes WHERE decision IS NULL;`,
    );
    const referencedNodeIds = new Set<string>();
    for (const edge of edges) {
      referencedNodeIds.add(edge.source_id);
      referencedNodeIds.add(edge.target_id);
    }
    const pathByNodeId = this.lookupNotePaths(Array.from(referencedNodeIds));
    const items: StreamItem[] = [];
    for (const edge of edges) {
      const sourcePath = pathByNodeId.get(edge.source_id) ?? null;
      const targetPath = pathByNodeId.get(edge.target_id) ?? null;
      const notePaths = [sourcePath, targetPath].filter((path): path is string => path !== null);
      const related = activePath !== null && notePaths.includes(activePath);
      const ageHours = Math.max(0, (now - edge.created_at) / 3_600_000);
      const score = computeScore({
        confidence: edge.confidence,
        ageHours,
        relatedToActiveNote: related,
        settings,
      });
      items.push({
        id: edge.id,
        kind: "edge",
        agent: edge.agent,
        type: edge.type,
        confidence: edge.confidence,
        rationale: edge.rationale,
        createdAt: edge.created_at,
        notePaths,
        evidenceChunkIds: parseEvidence(edge.evidence),
        score,
      });
    }
    for (const node of nodes) {
      const notePaths = node.note_path ? [node.note_path] : [];
      const related = activePath !== null && notePaths.includes(activePath);
      const ageHours = Math.max(0, (now - node.created_at) / 3_600_000);
      const score = computeScore({
        confidence: node.confidence,
        ageHours,
        relatedToActiveNote: related,
        settings,
      });
      items.push({
        id: node.id,
        kind: "node",
        agent: node.agent,
        type: node.type,
        confidence: node.confidence,
        rationale: null,
        createdAt: node.created_at,
        notePaths,
        evidenceChunkIds: [],
        score,
      });
    }
    items.sort((a, b) => b.score - a.score);
    this.items.value = items.slice(0, settings.maxItems);
  }

  private lookupNotePaths(ids: string[]): Map<string, string | null> {
    const result = new Map<string, string | null>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.options.db.query<NodePathRow>(
      `SELECT id, note_path FROM graph_nodes WHERE id IN (${placeholders});`,
      ids,
    );
    for (const row of rows) result.set(row.id, row.note_path);
    return result;
  }
}

function parseEvidence(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}
