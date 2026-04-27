export type AppEvent =
  | { type: "settings:changed"; key: string }
  | { type: "llm:health"; endpoint: string; ok: boolean; latencyMs?: number }
  | { type: "vault:note-saved"; path: string; sha: string }
  | { type: "indexer:progress"; processed: number; total: number }
  | { type: "indexer:complete"; total: number; durationMs?: number }
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
  | { type: "user:idle"; level: "30s" | "5m" | "30m" }
  | {
      type: "agent:run-started";
      agent: string;
      trigger: string;
      notePath: string | null;
      runId: number;
    }
  | {
      type: "agent:run-finished";
      agent: string;
      ok: boolean;
      proposals: number;
      durationMs: number;
      error?: string;
      runId: number;
    }
  | { type: "user:action"; kind: "deepen"; notePath: string }
  | { type: "active-leaf-change"; notePath: string | null; wordCount: number }
  | {
      type: "coAuthor:section";
      notePath: string;
      section: "summary" | "implies" | "connects";
      delta: string;
    }
  | { type: "coAuthor:done"; notePath: string; ok: boolean; durationMs: number; error?: string }
  | { type: "coAuthor:cancelled"; notePath: string }
  | {
      type: "approval:decided";
      kind: "edge" | "node";
      id: string;
      decision: "accepted" | "rejected";
    }
  | { type: "bridge:up"; version?: string }
  | { type: "bridge:down"; error?: string };

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
