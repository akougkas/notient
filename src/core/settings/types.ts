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

// Phase 4 substrate: ONLY mini. ONLY two models — nemotron-cascade for chat/reasoning,
// nomic-embed-text-v2-moe for embeddings. The mini server has VRAM for exactly these
// two models at once. `primary` and `deep` both point at the same llama-server endpoint
// using the same chat model; `embedding` points at the Ollama OpenAI-compatible
// endpoint on the same node. Agents, co-author, fast paths, and reranking all share
// the single chat model.
const MINI_LLAMA_SERVER = "http://192.168.86.141:8080/v1";
const MINI_OLLAMA = "http://192.168.86.141:11434/v1";
const MINI_CHAT_MODEL = "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M";
const MINI_EMBEDDING_MODEL = "nomic-embed-text-v2-moe";

export const DEFAULT_SETTINGS: NotientSettings = {
  primary: {
    baseUrl: MINI_LLAMA_SERVER,
    reasoningModel: MINI_CHAT_MODEL,
    embeddingModel: MINI_EMBEDDING_MODEL, // legacy; embedding endpoint reads from `embedding.*` below
    fastModel: MINI_CHAT_MODEL,
    rerankerModel: MINI_CHAT_MODEL,
  },
  deep: {
    baseUrl: MINI_LLAMA_SERVER,
    reasoningModel: MINI_CHAT_MODEL,
    embeddingModel: MINI_EMBEDDING_MODEL,
    fastModel: MINI_CHAT_MODEL,
    rerankerModel: MINI_CHAT_MODEL,
  },
  embedding: {
    baseUrl: MINI_OLLAMA,
    model: MINI_EMBEDDING_MODEL,
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
    model: MINI_CHAT_MODEL,
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
