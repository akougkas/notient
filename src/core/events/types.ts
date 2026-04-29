export type AppEvent =
  | { type: "settings:changed"; key: string }
  | { type: "llm:health"; endpoint: string; ok: boolean; latencyMs?: number }
  | { type: "vault:note-saved"; path: string; sha: string }
  | { type: "indexer:progress"; processed: number; total: number }
  | { type: "indexer:complete"; total: number; durationMs?: number }
  | { type: "indexer:error"; message: string; phase?: string }
  | { type: "indexer:warn"; message: string; phase?: string }
  | { type: "indexer:tier1-done"; path: string; bodySha: string }
  | { type: "indexer:tombstoned"; path: string }
  | { type: "indexer:renamed"; fromPath: string; toPath: string }
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
  | { type: "bridge:down"; error?: string }
  | {
      type: "swarm:contradiction_discovered";
      pair: [string, string];
      severity: number;
      notePaths: [string, string];
      runId: number;
    }
  | {
      type: "swarm:cluster_emerged";
      clusterId: string;
      memberNodeIds: string[];
      centroidLabel: string;
      runId: number;
    }
  | {
      type: "swarm:claim_advanced";
      claimId: string;
      notePath: string;
      fromMaturity: string;
      toMaturity: string;
      runId: number;
    }
  | {
      type: "swarm:link_proposed";
      edgeId: string;
      sourceId: string;
      targetId: string;
      edgeType: string;
      confidence: number;
      runId: number;
    }
  | ({ type: "loop:context_summarized" } & ContextSummarizedEvent)
  | ({ type: "loop:context_overflow_warning" } & ContextOverflowWarningEvent)
  | ({ type: "loop:tool_mode_probed" } & ToolModeProbedEvent)
  | ({ type: "daemon:startup_probe" } & StartupProbeEvent);

export interface IndexerNoteResult {
  chunkCount: number;
  embedCount: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
}

export interface ContextSummarizedEvent {
  conversationId: string;
  model: string;
  originalTokens: number;
  summarizedTokens: number;
}

export interface ContextOverflowWarningEvent {
  conversationId: string;
  model: string;
  configuredTokens: number;
  estimatedTokens: number;
}

export interface ToolModeProbedEvent {
  model: string;
  mode: "native" | "json-fallback" | "disabled";
  attempts: number;
}

export type StartupProbeStatus =
  | "ok"
  | "loaded-too-small"
  | "model-not-loaded"
  | "endpoint-unreachable";

export interface StartupProbeEvent {
  endpoint: string;
  modelId: string;
  configuredContextTokens: number;
  loadedContextLength: number | null;
  status: StartupProbeStatus;
  message: string;
}

export type EventType = AppEvent["type"];
export type EventOf<T extends EventType> = Extract<AppEvent, { type: T }>;
export type EventHandler<T extends EventType> = (event: EventOf<T>) => void;
