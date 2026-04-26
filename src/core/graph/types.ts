export type NodeType = "note" | "concept" | "claim" | "question";

export type EdgeType =
  | "mentions"
  | "asserts"
  | "asks"
  | "links"
  | "supports"
  | "contradicts"
  | "extends"
  | "exemplifies"
  | "synthesizes"
  | "related_to";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  notePath: string | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

export interface GraphEdge {
  id: string;
  type: EdgeType;
  sourceId: string;
  targetId: string;
  confidence: number;
  agent: string;
  evidence: string[];
  approved: boolean;
  createdAt: number;
}
