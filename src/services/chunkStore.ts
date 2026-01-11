/**
 * Chunk Store
 *
 * Model-agnostic chunk content storage.
 * Stores one JSON file per note in data/chunks/notes/{noteId}.json
 *
 * Separated from VectorStore to allow switching embedding models
 * without re-chunking notes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { NoteChunkFile, StoredChunk } from "../types/indexer";
import type { StoragePaths } from "./storagePaths";
import { atomicWriteFile } from "../utils/atomicWrite";

const CHUNKER_VERSION = "tsi-v2";

/**
 * Manages chunk content storage (model-agnostic).
 * Stores one JSON file per note in data/chunks/notes/{noteId}.json
 */
export class ChunkStore {
  private chunks: Map<string, StoredChunk> = new Map();
  private noteChunks: Map<string, Set<string>> = new Map();

  constructor(private storagePaths: StoragePaths) {}

  /**
   * Load chunks for a specific note from disk
   */
  async loadNoteChunks(noteId: string): Promise<StoredChunk[]> {
    const filePath = this.storagePaths.getChunkPath(noteId);

    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const data: NoteChunkFile = JSON.parse(content);

      // Store in memory
      const chunkIds = new Set<string>();
      for (const chunk of data.chunks) {
        this.chunks.set(chunk.chunkId, chunk);
        chunkIds.add(chunk.chunkId);
      }
      this.noteChunks.set(noteId, chunkIds);

      return data.chunks;
    } catch {
      return [];
    }
  }

  /**
   * Save chunks for a specific note to disk
   */
  async saveNoteChunks(
    noteId: string,
    notePath: string,
    mtimeMs: number,
    contentHash: string,
    chunks: StoredChunk[],
  ): Promise<void> {
    const filePath = this.storagePaths.getChunkPath(noteId);

    const data: NoteChunkFile = {
      noteId,
      path: notePath,
      mtimeMs,
      contentHash,
      chunkerVersion: CHUNKER_VERSION,
      chunks,
    };

    await atomicWriteFile(filePath, JSON.stringify(data, null, 2));

    // Update in-memory state
    const chunkIds = new Set<string>();
    for (const chunk of chunks) {
      this.chunks.set(chunk.chunkId, chunk);
      chunkIds.add(chunk.chunkId);
    }
    this.noteChunks.set(noteId, chunkIds);
  }

  /**
   * Get chunk by ID (from memory)
   */
  getChunk(chunkId: string): StoredChunk | null {
    return this.chunks.get(chunkId) ?? null;
  }

  /**
   * Get all chunks for a note
   */
  getChunksForNote(noteId: string): StoredChunk[] {
    const chunkIds = this.noteChunks.get(noteId);
    if (!chunkIds) return [];

    return Array.from(chunkIds)
      .map((id) => this.chunks.get(id))
      .filter((c): c is StoredChunk => c !== undefined);
  }

  /**
   * Remove chunks for a note from memory and move file to _deleted
   */
  async removeNoteChunks(noteId: string): Promise<void> {
    const chunkIds = this.noteChunks.get(noteId);
    if (chunkIds) {
      for (const id of chunkIds) {
        this.chunks.delete(id);
      }
      this.noteChunks.delete(noteId);
    }

    // Move file to _deleted
    const filePath = this.storagePaths.getChunkPath(noteId);
    const deletedPath = path.join(
      this.storagePaths.tempDeleted,
      `chunk-${noteId}-${Date.now()}.json`,
    );

    try {
      await fs.promises.rename(filePath, deletedPath);
    } catch {
      // File might not exist
    }
  }

  /**
   * Load all chunks from disk (for startup)
   */
  async loadAll(): Promise<void> {
    const notesDir = this.storagePaths.chunksNotes;

    try {
      const files = await fs.promises.readdir(notesDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const noteId = file.replace(".json", "");
          await this.loadNoteChunks(noteId);
        }
      }
      console.log(
        `[ChunkStore] Loaded ${this.chunks.size} chunks from ${this.noteChunks.size} notes`,
      );
    } catch {
      // Directory might not exist yet
      console.log("[ChunkStore] No existing chunks directory");
    }
  }

  /**
   * Get all chunk IDs (for embedding lookup)
   */
  getAllChunkIds(): string[] {
    return Array.from(this.chunks.keys());
  }

  /**
   * Get count of notes with chunks
   */
  getNoteCount(): number {
    return this.noteChunks.size;
  }

  /**
   * Get total chunk count
   */
  getChunkCount(): number {
    return this.chunks.size;
  }

  /**
   * Check if chunks exist for a note
   */
  hasNoteChunks(noteId: string): boolean {
    return this.noteChunks.has(noteId);
  }

  /**
   * Clear all chunks from memory
   */
  clear(): void {
    this.chunks.clear();
    this.noteChunks.clear();
  }
}
