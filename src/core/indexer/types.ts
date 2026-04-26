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
