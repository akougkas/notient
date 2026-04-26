/**
 * Indexer Service for Notient
 * Manages note indexing, chunk storage, and change detection.
 * Source of truth: .planning/PHASE-GALAXY.md
 */

import type { ChunkType } from "../../types";
import type { Database } from "../db/database";
import type { EventBus } from "../events";
import { chunkNote, computeNoteHash } from "./chunker";
import {
  type Chunk,
  DEFAULT_MAX_NOTE_SIZE,
  type IndexNoteResult,
  type IndexVaultResult,
  type IndexerConfig,
} from "./types";

/**
 * File accessor interface for reading notes.
 * Compatible with Obsidian's Vault API.
 */
export interface FileAccessor {
  listMarkdownFiles(): { path: string }[];
  readFile(path: string): Promise<string>;
  getFileSize(path: string): number | null;
}

/**
 * Indexer Service
 *
 * Responsibilities:
 * - Index single notes (for file watcher)
 * - Index entire vault (background on startup)
 * - Store chunks in SQLite
 * - Detect changes via content hashing
 */
export class Indexer {
  private database: Database;
  private eventBus: EventBus;
  private fileAccessor: FileAccessor;
  private config: IndexerConfig;
  private abortController: AbortController | null = null;

  constructor(
    database: Database,
    eventBus: EventBus,
    fileAccessor: FileAccessor,
    config: IndexerConfig = {},
  ) {
    this.database = database;
    this.eventBus = eventBus;
    this.fileAccessor = fileAccessor;
    this.config = {
      maxNoteSize: config.maxNoteSize ?? DEFAULT_MAX_NOTE_SIZE,
      onProgress: config.onProgress,
    };
  }

  /**
   * Index a single note.
   * Skips if content hash hasn't changed.
   *
   * @param notePath - Path to the note
   * @returns Result with chunk count and any warnings
   */
  async indexNote(notePath: string): Promise<IndexNoteResult> {
    const content = await this.fileAccessor.readFile(notePath);
    const hash = computeNoteHash(content);

    // Check for existing note with same hash
    const existing = this.database.get<{ hash: string }>("SELECT hash FROM notes WHERE path = ?", [
      notePath,
    ]);

    if (existing && existing.hash === hash) {
      return { notePath, chunkCount: 0, skipped: true };
    }

    // Check file size warning
    let warning: string | undefined;
    const fileSize = this.fileAccessor.getFileSize(notePath);
    if (fileSize && fileSize > (this.config.maxNoteSize ?? DEFAULT_MAX_NOTE_SIZE)) {
      warning = `Note ${notePath} is ${Math.round(fileSize / 1024)}KB (>50KB)`;
    }

    // Delete existing chunks (cascade will handle embeddings)
    this.database.run("DELETE FROM chunks WHERE note_path = ?", [notePath]);

    // Generate chunks
    const chunks = chunkNote(notePath, content);

    // Extract title from first heading or filename
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch
      ? titleMatch[1]
      : (notePath.split("/").pop()?.replace(".md", "") ?? notePath);

    // Upsert note record
    this.database.run(
      `INSERT OR REPLACE INTO notes (path, title, hash, indexed_at, last_enhanced)
       VALUES (?, ?, ?, ?, (SELECT last_enhanced FROM notes WHERE path = ?))`,
      [notePath, title, hash, Date.now(), notePath],
    );

    // Insert chunks
    for (const chunk of chunks) {
      this.insertChunk(chunk);
    }

    return {
      notePath,
      chunkCount: chunks.length,
      skipped: false,
      warning,
    };
  }

  /**
   * Index all markdown files in the vault.
   * Runs in background, emits progress events.
   *
   * @param excludedFolders - Folders to skip
   * @returns Aggregate result
   */
  async indexVault(excludedFolders: string[] = []): Promise<IndexVaultResult> {
    const startTime = Date.now();
    this.abortController = new AbortController();

    const files = this.fileAccessor.listMarkdownFiles();
    const filteredFiles = files.filter(
      (f) => !excludedFolders.some((folder) => f.path.startsWith(`${folder}/`)),
    );

    this.eventBus.emit("index:start", { noteCount: filteredFiles.length });

    const result: IndexVaultResult = {
      totalNotes: filteredFiles.length,
      indexedNotes: 0,
      skippedNotes: 0,
      totalChunks: 0,
      duration: 0,
      warnings: [],
    };

    for (let i = 0; i < filteredFiles.length; i++) {
      // Check for abort
      if (this.abortController.signal.aborted) {
        break;
      }

      const file = filteredFiles[i];
      try {
        const noteResult = await this.indexNote(file.path);

        if (noteResult.skipped) {
          result.skippedNotes++;
        } else {
          result.indexedNotes++;
          result.totalChunks += noteResult.chunkCount;
        }

        if (noteResult.warning) {
          result.warnings.push(noteResult.warning);
        }
      } catch (error) {
        result.warnings.push(`Failed to index ${file.path}: ${String(error)}`);
      }

      // Emit progress
      this.eventBus.emit("index:progress", {
        completed: i + 1,
        total: filteredFiles.length,
      });

      this.config.onProgress?.(i + 1, filteredFiles.length);

      // Yield to event loop periodically
      if (i % 10 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    result.duration = Date.now() - startTime;

    // Save database
    await this.database.save();

    // Emit completion or error
    if (this.abortController.signal.aborted) {
      this.eventBus.emit("index:error", { error: "Indexing cancelled" });
    } else {
      this.eventBus.emit("index:complete", {
        noteCount: result.indexedNotes,
        duration: result.duration,
      });
    }

    this.abortController = null;
    return result;
  }

  /**
   * Abort ongoing vault indexing.
   */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Remove a note and its chunks from the index.
   *
   * @param notePath - Path to remove
   */
  removeNote(notePath: string): void {
    this.database.run("DELETE FROM notes WHERE path = ?", [notePath]);
  }

  /**
   * Get all chunks for a note.
   *
   * @param notePath - Note to get chunks for
   * @returns Array of chunks
   */
  getChunksForNote(notePath: string): Chunk[] {
    const rows = this.database.all<{
      id: string;
      note_path: string;
      content: string;
      chunk_type: ChunkType;
      start_line: number;
      end_line: number;
      hash: string;
    }>("SELECT * FROM chunks WHERE note_path = ? ORDER BY start_line", [notePath]);

    return rows.map((row) => ({
      id: row.id,
      notePath: row.note_path,
      content: row.content,
      type: row.chunk_type,
      startLine: row.start_line,
      endLine: row.end_line,
      hash: row.hash,
    }));
  }

  /**
   * Check if a note needs re-indexing.
   *
   * @param notePath - Note to check
   * @param content - Current content
   * @returns true if index is stale
   */
  needsReindex(notePath: string, content: string): boolean {
    const hash = computeNoteHash(content);
    const existing = this.database.get<{ hash: string }>("SELECT hash FROM notes WHERE path = ?", [
      notePath,
    ]);
    return !existing || existing.hash !== hash;
  }

  /**
   * Get indexed note count.
   */
  getIndexedNoteCount(): number {
    const result = this.database.get<{ count: number }>("SELECT COUNT(*) as count FROM notes");
    return result?.count ?? 0;
  }

  private insertChunk(chunk: Chunk): void {
    this.database.run(
      `INSERT INTO chunks (id, note_path, content, chunk_type, start_line, end_line, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        chunk.id,
        chunk.notePath,
        chunk.content,
        chunk.type,
        chunk.startLine,
        chunk.endLine,
        chunk.hash,
      ],
    );
  }
}
