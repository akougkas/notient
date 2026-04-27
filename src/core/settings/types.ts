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

// Notient substrate: ONLY two models. Primary host is dynamo (LM Studio at :1234)
// because it loads Nemotron-Cascade with a 1M context window split across parallel
// slots. Mini (llama-server at :8080 / Ollama at :11434) is a hot backup with the
// same model line; flip the constants below to roll back if dynamo goes down. The
// chat model serves reasoning, fast, reranker, and co-author. The embedding model
// is OpenAI-compatible on the same LM Studio endpoint, so primary.baseUrl and
// embedding.baseUrl coincide for dynamo.
const DYNAMO_LMSTUDIO = "http://192.168.86.143:1234/v1";
const DYNAMO_CHAT_MODEL = "nemotron-cascade-2-30b-a3b-i1";
const DYNAMO_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v2-moe";

export const DEFAULT_SETTINGS: NotientSettings = {
  primary: {
    baseUrl: DYNAMO_LMSTUDIO,
    reasoningModel: DYNAMO_CHAT_MODEL,
    embeddingModel: DYNAMO_EMBEDDING_MODEL, // legacy; embedding endpoint reads from `embedding.*` below
    fastModel: DYNAMO_CHAT_MODEL,
    rerankerModel: DYNAMO_CHAT_MODEL,
  },
  deep: {
    baseUrl: DYNAMO_LMSTUDIO,
    reasoningModel: DYNAMO_CHAT_MODEL,
    embeddingModel: DYNAMO_EMBEDDING_MODEL,
    fastModel: DYNAMO_CHAT_MODEL,
    rerankerModel: DYNAMO_CHAT_MODEL,
  },
  embedding: {
    baseUrl: DYNAMO_LMSTUDIO,
    model: DYNAMO_EMBEDDING_MODEL,
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
    model: DYNAMO_CHAT_MODEL,
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
  },
  history: {
    retentionMaxRows: 500,
    retentionMaxRowsPerTarget: 50,
  },
  indexer: {
    excludePaths: ["Notient/conversations", "Notient/proposals", "Notient/searches"],
  },
};
