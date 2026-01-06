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

  /** Advanced options */
  advanced: {
    debugLogging: boolean;
    keepAliveMs: number;
  };

  /** Setup wizard completion flag */
  setupComplete: boolean;
}

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
