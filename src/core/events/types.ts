import type { InferenceAttempt } from "../llm/executionBudget";
export type AppEvent =
  | {
      type: "job:changed";
      jobId: string;
      pipeline: string;
      state: string;
      revision: string;
      stage: string;
    }
  | { type: "llm:health"; endpoint: string; ok: boolean; latencyMs?: number }
  | { type: "vault:note-saved"; path: string; sha: string }
  | { type: "indexer:progress"; processed: number; total: number }
  | { type: "indexer:complete"; total: number; durationMs?: number }
  | {
      type: "indexer:error";
      path: string;
      message: string;
      phase?: string;
      sourceRevision?: string;
    }
  | { type: "indexer:warn"; message: string; phase?: string }
  | { type: "indexer:tier1-done"; path: string; bodySha: string }
  | { type: "indexer:tier1-reused"; path: string; bodySha: string }
  | { type: "indexer:tier2-done"; path: string; chunkCount: number }
  | { type: "indexer:tier3-done"; path: string }
  | { type: "indexer:tombstoned"; path: string }
  | { type: "indexer:renamed"; fromPath: string; toPath: string }
  | { type: "indexer:note-indexed"; path: string; result: IndexerNoteResult }
  | {
      type: "sentience:activity";
      epoch: number;
      source:
        | "vault:add"
        | "vault:change"
        | "vault:rename"
        | "vault:delete"
        | "chat"
        | "search"
        | "approval"
        | "note-focus";
      activeNotePath: string | null;
    }
  | {
      type: "sentience:idle";
      epoch: number;
      rung: "link" | "synthesize" | "mature";
      idleForMs: number;
      activeNotePath: string | null;
    }
  | {
      type: "sentience:rung-skipped";
      epoch: number;
      rung: "link" | "synthesize";
      reason: "no-active-note" | "stale-epoch";
    }
  | {
      type: "agent:run-started";
      agent: string;
      trigger: string;
      notePath: string | null;
      runId: string;
    }
  | {
      type: "agent:run-finished";
      agent: string;
      ok: boolean;
      proposals: number;
      durationMs: number;
      error?: string;
      runId: string;
    }
  | {
      type: "approval:decided";
      kind: "edge" | "node";
      id: string;
      decision: "accepted";
      decidedBy: string;
      historyId: string;
    }
  | {
      type: "approval:decided";
      kind: "edge" | "node";
      id: string;
      decision: "rejected";
      reason: string | null;
      decidedBy: string;
      historyId: string;
    }
  | {
      type: "swarm:contradiction_discovered";
      pair: [string, string];
      severity: number;
      notePaths: [string, string];
      runId: string;
    }
  | {
      type: "swarm:claim_advanced";
      claimId: string;
      notePath: string;
      fromMaturity: string;
      toMaturity: string;
      runId: string;
    }
  | {
      type: "swarm:link_proposed";
      edgeId: string;
      sourceId: string;
      targetId: string;
      /** Vault-relative note paths, for humans reading the ledger. */
      sourcePath?: string;
      targetPath?: string;
      edgeType: string;
      confidence: number;
      runId: string;
    }
  | {
      type: "chat:usage";
      runId: string;
      phase: "answer" | "memory";
      state: "complete" | "incomplete";
      attempts: InferenceAttempt[];
      durationMs: number;
    }
  | { type: "search:rerank_failed"; query: string; candidates: number; message: string }
  | ({ type: "loop:context_summarized" } & ContextSummarizedEvent)
  | ({ type: "loop:context_overflow_warning" } & ContextOverflowWarningEvent)
  | ({ type: "loop:tool_mode_probed" } & ToolModeProbedEvent);

export interface IndexerNoteResult {
  chunkCount: number;
  embedCount: number;
  durationMs: number;
  /** Tier 3 structured-output calls issued for this note. */
  llmCalls: number;
  /** Tier 3 extraction windows containing this note's chunks. */
  extractionWindows: number;
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
  mode: "native" | "disabled";
  attempts: number;
}

export type EventType = AppEvent["type"];
export type EventOf<T extends EventType> = Extract<AppEvent, { type: T }>;
export type EventHandler<T extends EventType> = (event: EventOf<T>) => void;
