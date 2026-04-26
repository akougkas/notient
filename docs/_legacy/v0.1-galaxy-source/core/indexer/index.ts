/**
 * Indexer module exports
 */

export { chunkNote, computeNoteHash } from "./chunker";
export { Indexer } from "./indexer";
export type { FileAccessor } from "./indexer";
export type {
  Chunk,
  IndexerConfig,
  IndexNoteResult,
  IndexVaultResult,
} from "./types";
export { DEFAULT_MAX_NOTE_SIZE } from "./types";
