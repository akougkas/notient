export type AppEvent =
  | { type: "settings:changed"; key: string }
  | { type: "llm:health"; endpoint: string; ok: boolean; latencyMs?: number }
  | { type: "vault:note-saved"; path: string; sha: string }
  | { type: "indexer:progress"; processed: number; total: number }
  | { type: "indexer:complete"; total: number }
  | { type: "indexer:error"; message: string }
  | {
      type: "indexer:node-added";
      nodeId: string;
      nodeType: "note" | "concept" | "claim" | "question";
      label: string;
      notePath: string | null;
    }
  | {
      type: "indexer:edge-added";
      edgeId: string;
      edgeType: string;
      sourceId: string;
      targetId: string;
    }
  | { type: "indexer:note-indexed"; path: string; result: IndexerNoteResult }
  | { type: "user:active" }
  | { type: "user:idle"; level: "30s" | "5m" | "30m" };

export interface IndexerNoteResult {
  chunkCount: number;
  embedCount: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
}

export type EventType = AppEvent["type"];
export type EventOf<T extends EventType> = Extract<AppEvent, { type: T }>;
export type EventHandler<T extends EventType> = (event: EventOf<T>) => void;
