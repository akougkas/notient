/**
 * Indexer types for the indexing pipeline
 */

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

export type IndexPhase =
  | "scanning"
  | "chunking"
  | "embedding"
  | "storing"
  | "complete"
  | "idle";

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

