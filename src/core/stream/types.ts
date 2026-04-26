export type StreamItemKind = "edge" | "node";

export interface StreamItem {
  id: string;
  kind: StreamItemKind;
  agent: string;
  type: string;
  confidence: number;
  rationale: string | null;
  createdAt: number;
  notePaths: string[];
  evidenceChunkIds: string[];
  score: number;
}

export interface StreamSettings {
  recencyHalfLifeHours: number;
  offNoteRelevanceFloor: number;
  maxItems: number;
}
