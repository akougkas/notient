/**
 * Plugin settings schema with versioning support
 */

export const SETTINGS_VERSION = 2;

export interface NotientSettings {
  /** Schema version for migrations */
  version: number;

  /** Ollama configuration */
  ollama: {
    host: string;
    embeddingModel: string;
    /** Dedicated reranker model (default: B-A-M-N/Qwen3-Reranker-4B) */
    rerankModel: string;
    enabled: boolean;
  };

  /** LM Studio configuration */
  lmstudio: {
    host: string;
    reasoningModel: string;
    enabled: boolean;
  };

  /** Indexing configuration */
  indexing: IndexingSettings;

  /** PARA folder mappings */
  para: {
    inbox: string[];
    projects: string[];
    areas: string[];
    resources: string[];
    archive: string[];
  };

  /** UI preferences */
  ui: {
    showVitalsOnStartup: boolean;
    sidebarPosition: "left" | "right";
  };

  /** Search configuration */
  search: SearchSettings;

  /** Advanced options */
  advanced: {
    debugLogging: boolean;
    keepAliveMs: number;
  };

  /** Setup wizard completion flag */
  setupComplete: boolean;

  /** Agent settings (trust, history, bulk operations) */
  agent: AgentSettings;

  /** Chat retention settings */
  chatRetention: ChatRetention;
}

// =============================================================================
// Phase 2: Agent Settings
// =============================================================================

/**
 * Trust policy for agent actions
 */
export interface TrustPolicy {
  /** Auto-apply low-risk actions without confirmation (default: false) */
  autoApplyLowRisk: boolean;
  /** Require confirmation for medium-risk actions (always true in Phase 2) */
  requireConfirmMediumRisk: boolean;
  /** Require explicit confirmation for high-risk actions (always true) */
  requireConfirmHighRisk: boolean;
}

/**
 * Agent settings for agentic operations
 */
export interface AgentSettings {
  /** Trust level configuration */
  trustPolicy: TrustPolicy;
  /** Action history settings */
  history: {
    /** Maximum action records to retain (default: 200) */
    maxEntries: number;
    /** Maximum age in days for action records (default: 30) */
    maxAgeDays: number;
  };
  /** Bulk workflow settings */
  bulk: {
    /** Maximum notes per workflow (default: 100) */
    maxNotesPerWorkflow: number;
    /** Delay between tasks in milliseconds (default: 500) */
    delayBetweenTasksMs: number;
  };
}

/**
 * Chat retention configuration
 */
export interface ChatRetention {
  /** Maximum messages per note conversation (default: 50) */
  maxMessagesPerNote: number;
  /** Maximum age in days for conversations (default: 30) */
  maxAgeDays: number;
}

export type SearchPreset = "quick" | "balanced" | "thorough" | "custom";

/**
 * Progressive search configuration
 */
export interface ProgressiveSearchSettings {
  /** Enable progressive search vs legacy (default: true) */
  enabled: boolean;
  /** Display AI scores in results (default: false) */
  showScores: boolean;
  /** Auto-trigger deep search for complex queries (default: false) */
  autoDeep: boolean;
}

export interface SearchSettings {
  preset: SearchPreset;
  custom: {
    topK: number;
    enableReranking: boolean;
    minScore: number;
  };
  progressive: ProgressiveSearchSettings;
}

export interface IndexingSettings {
  /** Maximum chunk size in characters */
  chunkSize: number;
  /** Debounce delay for vault events (ms) */
  debounceMs: number;
  /** Batch size for embedding requests */
  batchSize: number;
  /** Excluded folders (relative paths) */
  excludedFolders: string[];
  /** Path to the currently active index file (null = use default plugin index) */
  activeIndexPath: string | null;
  /** Cached metadata from the active index (derived on load, not user-editable) */
  activeIndexMeta: {
    modelKey: string;
    dimension: number;
    /** True if this is a user-provided external index (read-only, from system/index/) */
    isUserProvided: boolean;
  } | null;
}

export const SEARCH_PRESETS = {
  quick: { topK: 5, enableReranking: false, minScore: 0.5 },
  balanced: { topK: 10, enableReranking: true, minScore: 0.3 },
  thorough: { topK: 25, enableReranking: true, minScore: 0.2 },
};

export const DEFAULT_SETTINGS: NotientSettings = {
  version: SETTINGS_VERSION,
  ollama: {
    host: "http://127.0.0.1:11434",
    embeddingModel: "qwen3-embedding:0.6b", // Best accuracy (100%), 1024d, 32k ctx
    rerankModel: "B-A-M-N/Qwen3-Reranker-4B", // Dedicated reranker (100% precision, 80% F1)
    enabled: true,
  },
  lmstudio: {
    host: "http://127.0.0.1:1234",
    reasoningModel: "falcon-h1r-7b", // Default chat/reasoning model
    enabled: true,
  },
  indexing: {
    chunkSize: 1500,
    debounceMs: 5000,
    batchSize: 4,
    excludedFolders: [".obsidian", ".trash"],
    activeIndexPath: null,
    activeIndexMeta: null,
  },
  para: {
    inbox: ["0-inbox", "inbox", "daily"],
    projects: ["1-projects", "projects"],
    areas: ["2-areas", "areas"],
    resources: ["2-knowledge", "3-resources", "resources", "reference"],
    archive: ["4-archive", "archive"],
  },
  ui: {
    showVitalsOnStartup: true,
    sidebarPosition: "right",
  },
  search: {
    preset: "balanced",
    custom: { topK: 10, enableReranking: true, minScore: 0.3 },
    progressive: { enabled: true, showScores: false, autoDeep: false },
  },
  advanced: {
    debugLogging: false,
    keepAliveMs: 300000, // 5 minutes
  },
  setupComplete: false,
  agent: {
    trustPolicy: {
      autoApplyLowRisk: false,
      requireConfirmMediumRisk: true,
      requireConfirmHighRisk: true,
    },
    history: {
      maxEntries: 200,
      maxAgeDays: 30,
    },
    bulk: {
      maxNotesPerWorkflow: 100,
      delayBetweenTasksMs: 500,
    },
  },
  chatRetention: {
    maxMessagesPerNote: 50,
    maxAgeDays: 30,
  },
};

/** Validation result for settings */
export interface SettingsValidation {
  valid: boolean;
  errors: SettingsError[];
  warnings: SettingsWarning[];
}

export interface SettingsError {
  field: string;
  message: string;
}

export interface SettingsWarning {
  field: string;
  message: string;
}
