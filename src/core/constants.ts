/**
 * Global constants for Notient
 */

/** Plugin identifier */
export const PLUGIN_ID = "notient";

/** View type identifiers */
export const VIEW_TYPE_SIDEBAR = "notient-sidebar";
export const VIEW_TYPE_DASHBOARD = "notient-dashboard";

/** Storage path segments - combined by StoragePaths class */
const DATA = "data";
const OP = `${DATA}/_operational`;

export const STORAGE_PATHS = {
  DATA,
  DB_FILE: `${DATA}/notient.db`,

  // Chunks (model-agnostic)
  CHUNKS: `${DATA}/chunks`,
  CHUNKS_META: `${DATA}/chunks/meta.json`,
  CHUNKS_NOTES: `${DATA}/chunks/notes`,

  // Embeddings (model-scoped)
  EMBEDDINGS: `${DATA}/embeddings`,
  EMBEDDINGS_ACTIVE: `${DATA}/embeddings/active`,
  EMBEDDINGS_REBUILDING: `${DATA}/embeddings/_rebuilding`,
  EMBEDDINGS_ARCHIVED: `${DATA}/embeddings/_archived`,

  // Intelligence (tag-keyed)
  INTELLIGENCE: `${DATA}/intelligence`,
  INTELLIGENCE_META: `${DATA}/intelligence/meta.json`,
  INTELLIGENCE_TOPICS: `${DATA}/intelligence/topics`,

  // Conversations (per-note)
  CONVERSATIONS: `${DATA}/conversations`,
  CONVERSATIONS_NOTES: `${DATA}/conversations/notes`,
  CONVERSATIONS_ROLLUPS: `${DATA}/conversations/rollups`,
  CONVERSATIONS_ROOT: `${DATA}/conversations/_root.json`,

  // Actions (time-bucketed)
  ACTIONS: `${DATA}/actions`,
  ACTIONS_HOT: `${DATA}/actions/hot`,
  ACTIONS_CURRENT: `${DATA}/actions/hot/current.json`,
  ACTIONS_ARCHIVE: `${DATA}/actions/archive`,

  // Profile
  PROFILE: `${DATA}/profile`,
  PROFILE_FILE: `${DATA}/profile/profile.json`,

  // Operational (volatile)
  OPERATIONAL: OP,
  LOCKS: `${OP}/locks`,
  CACHE: `${OP}/cache`,
  TEMP: `${OP}/temp`,
  TEMP_INCOMPLETE: `${OP}/temp/_incomplete`,
  TEMP_INVALID: `${OP}/temp/_invalid`,
  TEMP_DELETED: `${OP}/temp/_deleted`,
  LOGS: `${OP}/logs`,

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

/** Chat service limits */
export const CHAT_LIMITS = {
  /** Maximum content length for note context in chat prompts */
  MAX_CONTENT_LENGTH: 4000,
  /** Maximum chat history messages to retain */
  MAX_HISTORY_LENGTH: 100,
  /** Default context window size for chat */
  DEFAULT_CONTEXT_WINDOW_MAX: 8192,
} as const;

/** Search pipeline limits */
export const SEARCH_LIMITS = {
  /** Character limit for query text in findRelated */
  FIND_RELATED_QUERY_CHARS: 1000,
  /** Candidate multiplier for reranking (k * multiplier) */
  RERANK_CANDIDATE_K: 120,
  /** Candidate multiplier when reranking disabled */
  NO_RERANK_MULTIPLIER: 60,
} as const;

/** UI limits */
export const UI_LIMITS = {
  /** Maximum recent activity items to display */
  MAX_RECENT_ACTIVITY_COUNT: 9,
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
