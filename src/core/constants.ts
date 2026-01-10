/**
 * Global constants for Notient
 */

/** Plugin identifier */
export const PLUGIN_ID = "notient";

/** View type identifiers */
export const VIEW_TYPE_SIDEBAR = "notient-sidebar";
export const VIEW_TYPE_DASHBOARD = "notient-dashboard";

/** Storage paths relative to plugin folder */
export const STORAGE_PATHS = {
  // Root data folder
  DATA: "data",

  // Chunks (model-agnostic)
  CHUNKS: "data/chunks",
  CHUNKS_META: "data/chunks/meta.json",
  CHUNKS_NOTES: "data/chunks/notes",

  // Embeddings (model-scoped)
  EMBEDDINGS: "data/embeddings",
  EMBEDDINGS_ACTIVE: "data/embeddings/active",
  EMBEDDINGS_REBUILDING: "data/embeddings/_rebuilding",
  EMBEDDINGS_ARCHIVED: "data/embeddings/_archived",

  // Intelligence (tag-keyed)
  INTELLIGENCE: "data/intelligence",
  INTELLIGENCE_META: "data/intelligence/meta.json",
  INTELLIGENCE_TOPICS: "data/intelligence/topics",

  // Conversations (per-note)
  CONVERSATIONS: "data/conversations",
  CONVERSATIONS_NOTES: "data/conversations/notes",
  CONVERSATIONS_ROLLUPS: "data/conversations/rollups",
  CONVERSATIONS_ROOT: "data/conversations/_root.json",

  // Actions (time-bucketed)
  ACTIONS: "data/actions",
  ACTIONS_HOT: "data/actions/hot",
  ACTIONS_CURRENT: "data/actions/hot/current.json",
  ACTIONS_ARCHIVE: "data/actions/archive",

  // Profile
  PROFILE: "data/profile",
  PROFILE_FILE: "data/profile/profile.json",

  // Operational (volatile)
  OPERATIONAL: "data/_operational",
  LOCKS: "data/_operational/locks",
  CACHE: "data/_operational/cache",
  TEMP: "data/_operational/temp",
  TEMP_INCOMPLETE: "data/_operational/temp/_incomplete",
  TEMP_INVALID: "data/_operational/temp/_invalid",
  TEMP_DELETED: "data/_operational/temp/_deleted",
  LOGS: "data/_operational/logs",

  // Legacy paths (for migration detection)
  LEGACY_INDEX_STATE: "index-state.json",
  LEGACY_CONVERSATIONS: "conversations.json",
  LEGACY_ACTIONS: "actions.json",
  LEGACY_PROFILE: "profile.json",
  LEGACY_CACHE: "cache",
  LEGACY_LOCKS: "locks",
  LEGACY_LOGS: "logs",
} as const;

/** Lock file names */
export const LOCK_FILES = {
  WRITER: "writer.lock",
} as const;

/** Cache settings */
export const CACHE_CONFIG = {
  /** Max query embedding cache entries */
  MAX_QUERY_CACHE_SIZE: 100,
  /** Max search result cache entries */
  MAX_SEARCH_CACHE_SIZE: 50,
  /** Search cache TTL in ms (5 minutes) */
  SEARCH_CACHE_TTL_MS: 5 * 60 * 1000,
} as const;

/** Performance targets */
export const PERFORMANCE = {
  /** Target cached search latency (ms) */
  SEARCH_LATENCY_CACHED_MS: 100,
  /** Target uncached search latency (ms) */
  SEARCH_LATENCY_UNCACHED_MS: 500,
  /** Health check interval (ms) */
  HEALTH_CHECK_INTERVAL_MS: 30000,
} as const;

/** Default model configurations */
export const MODEL_DEFAULTS = {
  /**
   * Conservative fallback values used ONLY when runtime discovery fails.
   * Actual capabilities are discovered via Ollama's /api/show endpoint.
   */
  FALLBACK_CONTEXT_TOKENS: 512,
  FALLBACK_EMBEDDING_DIMENSION: 384,
  /** Average chars per token for truncation calculation */
  CHARS_PER_TOKEN: 4,
} as const;

/** Shared LLM prompts */
export const LLM_PROMPTS = {
  /** System prompt for reranking search results */
  RERANK_SYSTEM: `You rank search results by relevance. Output ONLY valid JSON.

Example output:
{"rankings":[{"index":0,"score":90,"reason":"exact match"},{"index":2,"score":70,"reason":"related"}]}

Rules:
- score: 0-100
- index: candidate number
- reason: brief (under 30 chars)
- Only include relevant results (score >= 30)`,
} as const;
