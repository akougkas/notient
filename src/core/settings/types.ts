import type { InferenceBudgetLimits } from "../llm/executionBudget";
/**
 * Product behaviour persisted in `<vault>/.notient/config.json`.
 *
 * Deployment belongs to `<vault>/.notient/.env` (with process environment as
 * a fallback), so endpoint URLs, model ids, model context, and reasoning-slot
 * capacity intentionally do not appear here.
 */

import { type BackgroundSettings, defaultBackgroundSettings } from "../../api/background";

export type ApprovalMode = "safe" | "yolo";
export type SearchMode = "quick" | "balanced" | "deep";
export type ToolApprovalPolicy = "auto" | "ask";
export type SurrealLogLevel = "trace" | "debug" | "info" | "warn" | "error";

export const TOOL_POLICY_NAMES = [
  "vault.read_note",
  "vault.search_notes",
  "vault.list_neighbors",
  "vault.get_vitals",
  "proposals.list_pending",
  "proposals.get",
  "proposals.approve",
  "proposals.reject",
  "graph.find_path",
  "notes.create",
  "notes.append",
  "notes.replace_section",
  "notes.update_frontmatter",
] as const;

export type ToolPolicyName = (typeof TOOL_POLICY_NAMES)[number];
export type ToolPolicySettings = Record<ToolPolicyName, ToolApprovalPolicy>;

export interface VitalsSettings {
  freshnessHalfLifeDays: number;
  healthWeights: { wordBand: number; chunkCoverage: number; hasApprovedEdges: number };
  connectivityThresholds: { sparse: number; connected: number; hub: number };
  writeToFrontmatter: boolean;
}

export interface SearchSettings {
  defaultMode: SearchMode;
  balanced: { topK: number; rerankTopN: number };
  deep: { synthesisEnabled: boolean };
}

export interface ChatContextSettings {
  includeVaultSnapshot: boolean;
  includeCrossSessionMemory: boolean;
  crossSessionTopK: number;
  crossSessionSimThreshold: number;
  pinnedNoteMaxTokens: number;
}

export const DEFAULT_CHAT_BUDGET = {
  modelCalls: 12,
  tokens: 160000,
  durationMs: 180000,
  generationTokens: 16384,
} satisfies InferenceBudgetLimits;

export interface ChatProductSettings {
  budget: typeof DEFAULT_CHAT_BUDGET;
  approvalMode: ApprovalMode;
  persistReasoning: boolean;
  perTool: ToolPolicySettings;
  history: {
    /** Maximum HistoryService rows kept globally; older rows prune on record. */
    maxEntries: number;
    /** Maximum HistoryService rows per target path; older rows prune on record. */
    maxPerTarget: number;
  };
  maxRoundsPerTurn: number;
  contextBudgetFraction: number;
  context: ChatContextSettings;
}

export interface IndexerSettings {
  excludePaths: string[];
  /**
   * Filename patterns skipped by the vault listing on top of
   * `excludePaths`. Only the glob subset implemented by
   * `src/core/indexer/excludePaths.ts` is supported.
   */
  excludeGlobs: string[];
  debounceMs: number;
  concurrency: { embed: number; extract: number };
  chunk: { targetTokens: number; maxTokens: number };
}

export interface NotientConfig {
  background: BackgroundSettings;
  vitals: VitalsSettings;
  search: SearchSettings;
  chat: ChatProductSettings;
  indexer: IndexerSettings;
  surrealdb: {
    hnswCacheMib: number;
    logLevel: SurrealLogLevel;
  };
  agentEvents: {
    /** Maximum retained rows in the internal agent-event ledger. */
    maxRows: number;
  };
}

export interface PrimaryEndpointConfig {
  baseUrl: string;
  reasoningModel: string;
}

export interface DeepEndpointConfig {
  baseUrl: string;
  reasoningModel: string;
  rerankerModel: string;
}

export interface EmbeddingEndpointConfig {
  baseUrl: string;
  model: string;
}

/**
 * Fully resolved, process-local boot settings. This is constructed exactly
 * once from a validated NotientConfig plus the deployment environment and is
 * deep-frozen before any service receives it.
 */
export interface NotientSettings extends Omit<NotientConfig, "chat"> {
  primary: PrimaryEndpointConfig;
  deep: DeepEndpointConfig;
  embedding: EmbeddingEndpointConfig;
  chat: ChatProductSettings & {
    /** Per-request context budget. Deployment authority: NOTIENT_CONTEXT_TOKENS. */
    modelContextTokens: number;
    /** Concurrent reasoning capacity. Deployment authority: NOTIENT_REASONING_SLOTS. */
    reasoningSlots: number;
  };
}

export const DEFAULT_NOTIENT_CONFIG: NotientConfig = {
  background: defaultBackgroundSettings(),
  vitals: {
    freshnessHalfLifeDays: 14,
    healthWeights: { wordBand: 1, chunkCoverage: 1, hasApprovedEdges: 1 },
    connectivityThresholds: { sparse: 1, connected: 4, hub: 12 },
    writeToFrontmatter: false,
  },
  search: {
    defaultMode: "quick",
    balanced: { topK: 20, rerankTopN: 5 },
    deep: { synthesisEnabled: true },
  },
  chat: {
    budget: { ...DEFAULT_CHAT_BUDGET },
    approvalMode: "safe",
    persistReasoning: false,
    perTool: {
      "vault.read_note": "auto",
      "vault.search_notes": "auto",
      "vault.list_neighbors": "auto",
      "vault.get_vitals": "auto",
      "proposals.list_pending": "auto",
      "proposals.get": "auto",
      "proposals.approve": "ask",
      "proposals.reject": "ask",
      "graph.find_path": "auto",
      "notes.create": "ask",
      "notes.append": "ask",
      "notes.replace_section": "ask",
      "notes.update_frontmatter": "ask",
    },
    history: { maxEntries: 200, maxPerTarget: 20 },
    maxRoundsPerTurn: 8,
    contextBudgetFraction: 0.7,
    context: {
      includeVaultSnapshot: true,
      includeCrossSessionMemory: true,
      crossSessionTopK: 2,
      crossSessionSimThreshold: 0.7,
      pinnedNoteMaxTokens: 4_000,
    },
  },
  indexer: {
    excludePaths: ["Notient/conversations", "Notient/proposals"],
    excludeGlobs: ["**/*.excalidraw.md"],
    debounceMs: 500,
    concurrency: { embed: 4, extract: 2 },
    chunk: { targetTokens: 320, maxTokens: 480 },
  },
  surrealdb: {
    hnswCacheMib: 512,
    logLevel: "warn",
  },
  agentEvents: {
    maxRows: 50_000,
  },
};

export const DEFAULT_CONTEXT_TOKENS = 32_768;
export const DEFAULT_REASONING_SLOTS = 4;
