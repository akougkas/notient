export type ConceptKind =
  | "proper_noun"
  | "system"
  | "technique"
  | "metric"
  | "quantity"
  | "event"
  | "other";

export type ConceptSource = "extractor" | "user" | "linker";

export type ClaimKind = "definition" | "assertion" | "datum" | "speculation";

export interface Chunk {
  id: string;
  notePath: string;
  ord: number;
  text: string;
  sha: string;
  tokenEstimate: number;
}

export interface Extraction {
  entities: string[];
  claims: string[];
  questions: string[];
  entityKinds?: Record<string, ConceptKind>;
  claimKinds?: Record<string, ClaimKind>;
}

export interface IndexResult {
  notePath: string;
  noteSha: string;
  chunkCount: number;
  embedCount: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
}
