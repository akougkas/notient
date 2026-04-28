export interface LLMEndpointConfig {
  baseUrl: string;
  reasoningModel: string;
  embeddingModel: string;
  fastModel: string;
  rerankerModel: string;
}

export interface EmbeddingEndpointConfig {
  baseUrl: string;
  model: string;
}

export interface NotientSettings {
  primary: LLMEndpointConfig;
  deep: LLMEndpointConfig;
  embedding: EmbeddingEndpointConfig;
  agents: {
    linker: boolean;
    synthesizer: boolean;
    contradictionHunter: boolean;
    maturityAdvancer: boolean;
  };
  coAuthor: {
    enabled: boolean;
    minWords: number;
    debounceMs: number;
    /** Prose-friendly non-reasoning model. Reasoning models stall behind their CoT. */
    model: string;
  };
  approvals: {
    confidenceThreshold: number;
  };
  awakenedAt: number | null;

  // Phase 4 — Stream
  stream: {
    recencyHalfLifeHours: number;
    offNoteRelevanceFloor: number;
    maxItems: number;
  };

  // Phase 4 — Vitals
  vitals: {
    freshnessHalfLifeDays: number;
    healthWeights: { wordBand: number; chunkCoverage: number; hasApprovedEdges: number };
    connectivityThresholds: { sparse: number; connected: number; hub: number };
    writeToFrontmatter: boolean;
  };

  // Phase 4 — Editor decorations
  decorations: {
    enabled: boolean;
    maxPerViewport: number;
    debounceMs: number;
    minWordsToDecorate: number;
  };

  // Phase 4 — Native graph bridge
  nativeGraph: {
    writeRelatedSection: boolean;
    writeFrontmatterRelations: boolean;
    relatedSectionHeading: string;
  };

  // Phase 4 — Search
  search: {
    defaultMode: "quick" | "balanced" | "deep";
    balanced: { topK: number; rerankTopN: number };
    deep: { graphExpansionDepth: number; synthesisEnabled: boolean };
    history: { maxQueries: number };
    savedQueriesFolder: string;
    previewEnabled: boolean;
  };

  // Phase 4 — Chat
  chat: {
    enabled: boolean;
    approvalMode: "safe" | "yolo";
    persistReasoning: boolean;
    toolModeByModel: Record<string, "native" | "json-fallback" | "disabled">;
    perTool: Record<string, "auto" | "ask">;
    /**
     * Model context window in tokens. ContextManager budgets this fraction
     * (chat.contextBudgetFraction) before triggering history summarization.
     * Defaults to 200_000 for the locked Nemotron-Cascade-2-30B substrate;
     * lower for 8K/32K models (Llama 3.1 8B, Qwen2.5 7B). When the
     * configured value is too small for a given turn the loop emits
     * loop:context_overflow_warning so the operator can adjust.
     */
    modelContextTokens: number;
    history: {
      /** Maximum HistoryService rows kept globally; older rows prune on record. */
      maxEntries: number;
      /** Maximum HistoryService rows per target path; older rows prune on record. */
      maxPerTarget: number;
    };
    vision?: {
      enabled: boolean;
      baseUrl: string;
      model: string;
    };
    conversationsFolder: string;
    proposalsFolder: string;
    maxRoundsPerTurn: number;
    contextBudgetFraction: number;
    context: {
      includeUserProfile: boolean;
      includeVaultSnapshot: boolean;
      includeWorkspaceState: boolean;
      includeCrossSessionMemory: boolean;
      crossSessionTopK: number;
      crossSessionSimThreshold: number;
      pinnedNoteMaxTokens: number;
    };
  };

  // Phase 4 — Universal undo
  history: {
    retentionMaxRows: number;
    retentionMaxRowsPerTarget: number;
  };

  // Phase 4 — Indexer exclusion
  indexer: {
    excludePaths: string[];
  };
}

// DEFAULT_SETTINGS leaves every endpoint and model slot empty. The operator
// supplies real values via either <vault>/.notient/config.json (persistent)
// or <vault>/.notient/.env / process env (overlay). Bootstrap validates
// the chosen values before sealing — see assertEndpointConfigured below.
// Hardcoding any specific model name in this file is a regression: smokes,
// tests, and production all read what the operator configured.
const DEFAULT_BASE_URL = "";
const DEFAULT_CHAT_MODEL = "";
const DEFAULT_EMBEDDING_MODEL = "";

export const DEFAULT_SETTINGS: NotientSettings = {
  primary: {
    baseUrl: DEFAULT_BASE_URL,
    reasoningModel: DEFAULT_CHAT_MODEL,
    embeddingModel: DEFAULT_EMBEDDING_MODEL, // legacy; embedding endpoint reads from `embedding.*` below
    fastModel: DEFAULT_CHAT_MODEL,
    rerankerModel: DEFAULT_CHAT_MODEL,
  },
  deep: {
    baseUrl: DEFAULT_BASE_URL,
    reasoningModel: DEFAULT_CHAT_MODEL,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    fastModel: DEFAULT_CHAT_MODEL,
    rerankerModel: DEFAULT_CHAT_MODEL,
  },
  embedding: {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_EMBEDDING_MODEL,
  },
  agents: {
    linker: true,
    synthesizer: true,
    contradictionHunter: true,
    maturityAdvancer: true,
  },
  coAuthor: {
    enabled: true,
    minWords: 100,
    debounceMs: 5000,
    model: DEFAULT_CHAT_MODEL,
  },
  approvals: {
    confidenceThreshold: 0.6,
  },
  awakenedAt: null,
  stream: {
    recencyHalfLifeHours: 12,
    offNoteRelevanceFloor: 0.3,
    maxItems: 50,
  },
  vitals: {
    freshnessHalfLifeDays: 14,
    healthWeights: { wordBand: 1, chunkCoverage: 1, hasApprovedEdges: 1 },
    connectivityThresholds: { sparse: 1, connected: 4, hub: 12 },
    writeToFrontmatter: false,
  },
  decorations: {
    enabled: true,
    maxPerViewport: 5,
    debounceMs: 200,
    minWordsToDecorate: 100,
  },
  nativeGraph: {
    writeRelatedSection: true,
    writeFrontmatterRelations: true,
    relatedSectionHeading: "Related",
  },
  search: {
    defaultMode: "quick",
    balanced: { topK: 20, rerankTopN: 5 },
    deep: { graphExpansionDepth: 1, synthesisEnabled: true },
    history: { maxQueries: 50 },
    savedQueriesFolder: "Notient/searches",
    previewEnabled: true,
  },
  chat: {
    enabled: true,
    approvalMode: "safe",
    persistReasoning: false,
    toolModeByModel: {},
    perTool: {
      "vault.read_note": "auto",
      "vault.search_notes": "auto",
      "vault.list_neighbors": "auto",
      "vault.get_vitals": "auto",
      "proposals.list_pending": "auto",
      "proposals.get": "auto",
      "graph.find_path": "auto",
      "graph.list_clusters": "auto",
      "agents.contradiction_check": "auto",
      "agents.synthesize": "auto",
      "notes.create": "ask",
      "notes.append": "ask",
      "notes.replace_section": "ask",
      "notes.update_frontmatter": "ask",
      "proposals.upsert": "ask",
    },
    conversationsFolder: "Notient/conversations",
    proposalsFolder: "Notient/proposals",
    maxRoundsPerTurn: 8,
    contextBudgetFraction: 0.7,
    context: {
      includeUserProfile: true,
      includeVaultSnapshot: true,
      includeWorkspaceState: true,
      includeCrossSessionMemory: true,
      crossSessionTopK: 2,
      crossSessionSimThreshold: 0.7,
      pinnedNoteMaxTokens: 4000,
    },
    modelContextTokens: 200_000,
    history: { maxEntries: 200, maxPerTarget: 20 },
  },
  history: {
    retentionMaxRows: 500,
    retentionMaxRowsPerTarget: 50,
  },
  indexer: {
    excludePaths: ["Notient/conversations", "Notient/proposals", "Notient/searches"],
  },
};
