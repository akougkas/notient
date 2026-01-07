/**
 * Plugin settings schema with versioning support
 */

export const SETTINGS_VERSION = 1;

export interface NotientSettings {
  /** Schema version for migrations */
  version: number;

  /** Ollama configuration */
  ollama: {
    host: string;
    embeddingModel: string;
    enabled: boolean;
  };

  /** LM Studio configuration */
  lmstudio: {
    host: string;
    reasoningModel: string;
    enabled: boolean;
  };

  /** Indexing configuration */
  indexing: {
    /** Maximum chunk size in characters */
    chunkSize: number;
    /** Debounce delay for vault events (ms) */
    debounceMs: number;
    /** Batch size for embedding requests */
    batchSize: number;
    /** Excluded folders (relative paths) */
    excludedFolders: string[];
  };

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
}

export type SearchPreset = 'quick' | 'balanced' | 'thorough' | 'custom';

export interface SearchSettings {
  preset: SearchPreset;
  custom: {
    topK: number;
    enableReranking: boolean;
    minScore: number;
  };
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
    embeddingModel: "nomic-embed-text",
    enabled: true,
  },
  lmstudio: {
    host: "http://127.0.0.1:1234",
    reasoningModel: "",
    enabled: true,
  },
  indexing: {
    chunkSize: 1500,
    debounceMs: 5000,
    batchSize: 4,
    excludedFolders: [".obsidian", ".trash"],
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
    preset: 'balanced',
    custom: { topK: 10, enableReranking: true, minScore: 0.3 }
  },
  advanced: {
    debugLogging: false,
    keepAliveMs: 300000, // 5 minutes
  },
  setupComplete: false,
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
