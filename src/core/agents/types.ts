export interface StagingEdgeRow {
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

export interface StagingNodeRow {
  id: string;
  type: "claim" | "concept" | "question" | "synthesis";
  label: string;
  notePath: string | null;
  payload: Record<string, unknown> | null;
  agent: string;
  confidence: number;
  createdAt: number;
}
