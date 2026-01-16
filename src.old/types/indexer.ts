/**
 * Indexer types for the indexing pipeline
 */

/**
 * Chunk tier in the Tiered Semantic Index (TSI v2)
 */
export type ChunkTier = "note" | "section" | "block";

/**
 * Chunk kind (structural/semantic block type)
 */
export type ChunkKind =
  | "note"
  | "section"
  | "heading"
  | "paragraph"
  | "list"
  | "taskList"
  | "callout"
  | "quote"
  | "code"
  | "table"
  | "hr"
  | "embed"
  | "blank"
  | "other";

/** Index state for a single note */
export interface NoteIndexState {
  /** Normalized vault path */
  path: string;
  /** File modification time */
  mtimeMs: number;
  /** File size in bytes */
  sizeBytes: number;
  /** Content hash for change detection */
  contentHash: string;
  /** Number of chunks created */
  chunkCount: number;
  /** When the note was last embedded */
  lastEmbeddedAt: number;
  /** Model key used for embedding */
  modelKey: string;
  /** Current status */
  status: NoteIndexStatus;
  /** Last error if any */
  lastError: string | null;
}

export type NoteIndexStatus = "pending" | "processing" | "indexed" | "error";

/** Indexing progress information */
export interface IndexProgress {
  /** Total notes to process */
  total: number;
  /** Notes completed */
  completed: number;
  /** Currently processing note */
  current: string | null;
  /** Current phase */
  phase: IndexPhase;
  /** Start time */
  startedAt: number;
  /** Estimated time remaining (ms) */
  estimatedRemainingMs: number | null;
}

export type IndexPhase = "scanning" | "chunking" | "embedding" | "storing" | "complete" | "idle";

/** Chunk representation */
export interface NoteChunk {
  /** Stable chunk ID */
  chunkId: string;
  /** Parent note ID */
  noteId: string;
  /** Note path */
  path: string;
  /** Note title (from filename or frontmatter) */
  title: string;
  /** Heading hierarchy */
  headingPath: string[];
  /** Tier (note/section/block) */
  tier: ChunkTier;
  /** Block/section kind */
  kind: ChunkKind;
  /** Parent chunk ID (block -> section, section -> note) */
  parentChunkId: string | null;
  /** Obsidian block reference (e.g. ^abc123) if present */
  blockRef: string | null;
  /** Start line in the note (1-based) */
  startLine: number | null;
  /** End line in the note (1-based) */
  endLine: number | null;
  /** Deterministic token estimate (proxy) */
  tokenEstimate: number;
  /** Optional heuristic importance used for weighting */
  importance?: number;
  /** Chunk index within note */
  chunkIndex: number;
  /** Raw text content */
  text: string;
  /** File mtime */
  mtimeMs: number;
  /** Content hash */
  contentHash: string;
  /** Tags from frontmatter */
  tags: string[];
  /** Frontmatter data */
  frontmatter: Record<string, unknown>;
}

/** Chunk with embedding vector */
export interface EmbeddedChunk extends NoteChunk {
  /** Embedding vector */
  embedding: number[];
  /** Model key used */
  modelKey: string;
}

// ============================================================================
// Phase 2: Chunk/Embedding Separation Types
// ============================================================================

/**
 * Stored chunk content without embedding (model-agnostic).
 * Derived from NoteChunk, excluding runtime fields (mtimeMs, contentHash).
 */
export type StoredChunk = Omit<NoteChunk, "mtimeMs" | "contentHash">;

/**
 * Per-note chunk file structure.
 */
export interface NoteChunkFile {
  noteId: string;
  path: string;
  mtimeMs: number;
  contentHash: string;
  chunkerVersion: string;
  chunks: StoredChunk[];
}

/**
 * Chunks meta file structure.
 */
export interface ChunksMeta {
  version: number;
  chunkerVersion: string;
  noteCount: number;
  chunkCount: number;
  lastUpdated: number;
}
