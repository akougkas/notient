/**
 * Orama Vector Store Implementation
 *
 * Pure JavaScript vector store using Orama.
 * Bundled with the plugin - no native dependencies.
 */

import {
  create,
  insert,
  remove,
  search,
  count,
  type Orama,
  type Results,
  type SearchParams,
} from "@orama/orama";
import { persist, restore } from "@orama/plugin-data-persistence";
import type { VectorStore } from "./vectorStore";
import type { Kernel } from "../core/kernel";
import type { EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, SearchOptions } from "../types/search";
import { ParaDetector } from "../core/para/detector";

/** Schema for Orama - we store serialized arrays/objects as strings */
interface OramaDoc {
  chunkId: string;
  noteId: string;
  path: string;
  title: string;
  headingPath: string; // JSON serialized
  chunkIndex: number;
  text: string;
  embedding: number[];
  mtimeMs: number;
  contentHash: string;
  tags: string; // JSON serialized
  frontmatter: string; // JSON serialized
  modelKey: string;
}

type OramaSchema = {
  chunkId: "string";
  noteId: "string";
  path: "string";
  title: "string";
  headingPath: "string";
  chunkIndex: "number";
  text: "string";
  embedding: `vector[${number}]`;
  mtimeMs: "number";
  contentHash: "string";
  tags: "string";
  frontmatter: "string";
  modelKey: "string";
};

/**
 * Orama implementation of VectorStore
 */
export class OramaStore implements VectorStore {
  private db: Orama<OramaSchema> | null = null;
  private modelKey: string = "";
  private dimension: number = 0;
  private disposed = false;
  private paraDetector: ParaDetector;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private kernel: Kernel) {
    this.paraDetector = new ParaDetector(kernel.settings);
  }

  /**
   * Initialize the vector store
   */
  async initialize(): Promise<void> {
    if (this.disposed) return;

    const ollamaService = this.kernel.getService<{
      getModelKey(): string;
      getDimension(): Promise<number>;
    }>("ollama");

    if (!ollamaService) {
      throw new Error("Ollama service not available");
    }

    this.modelKey = ollamaService.getModelKey();
    this.dimension = await ollamaService.getDimension();

    // Try to restore from disk
    const restored = await this.tryRestore();
    if (!restored) {
      await this.createFreshDb();
    }
  }

  /**
   * Try to restore database from disk
   */
  private async tryRestore(): Promise<boolean> {
    try {
      const dbPath = this.getDbPath();
      const vault = this.kernel.obsidian.vault;

      if (await vault.adapter.exists(dbPath)) {
        const data = await vault.adapter.read(dbPath);
        const parsed = JSON.parse(data);

        // Verify model key matches
        if (parsed.modelKey !== this.modelKey) {
          console.log(
            "[OramaStore] Model key mismatch, creating fresh database"
          );
          return false;
        }

        this.db = (await restore("json", parsed.data)) as Orama<OramaSchema>;
        console.log("[OramaStore] Restored database from disk");
        return true;
      }
    } catch (error) {
      console.warn("[OramaStore] Failed to restore, creating fresh:", error);
    }
    return false;
  }

  /**
   * Create a fresh database
   */
  private async createFreshDb(): Promise<void> {
    const schema: OramaSchema = {
      chunkId: "string",
      noteId: "string",
      path: "string",
      title: "string",
      headingPath: "string",
      chunkIndex: "number",
      text: "string",
      embedding: `vector[${this.dimension}]`,
      mtimeMs: "number",
      contentHash: "string",
      tags: "string",
      frontmatter: "string",
      modelKey: "string",
    };

    this.db = await create({ schema });
    console.log(
      `[OramaStore] Created fresh database with ${this.dimension}-dim vectors`
    );
  }

  /**
   * Get the database file path (relative to vault root for Obsidian adapter)
   */
  private getDbPath(): string {
    // Use relative path from vault root for Obsidian's adapter
    const vaultRoot = this.kernel.storagePaths.vaultRoot;
    const pluginRoot = this.kernel.storagePaths.pluginRoot;
    // Get relative path from vault
    const relativePath = pluginRoot.replace(vaultRoot, "").replace(/^[/\\]/, "");
    return `${relativePath}/orama-${this.modelKey}.json`;
  }

  /**
   * Save database to disk (debounced)
   */
  private scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    this.saveDebounceTimer = setTimeout(() => {
      this.saveToDisk();
    }, 5000); // Save 5 seconds after last write
  }

  /**
   * Immediately save to disk
   */
  private async saveToDisk(): Promise<void> {
    if (!this.db || this.disposed) return;

    try {
      const data = await persist(this.db, "json");
      const wrapper = {
        modelKey: this.modelKey,
        dimension: this.dimension,
        savedAt: Date.now(),
        data,
      };

      const dbPath = this.getDbPath();
      const vault = this.kernel.obsidian.vault;
      await vault.adapter.write(dbPath, JSON.stringify(wrapper));
    } catch (error) {
      console.error("[OramaStore] Failed to save:", error);
    }
  }

  /**
   * Upsert chunks into the store
   */
  async upsertChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (!this.db || this.disposed) {
      throw new Error("Store not initialized");
    }

    if (chunks.length === 0) return;

    // Delete existing chunks for these notes first
    const noteIds = [...new Set(chunks.map((c) => c.noteId))];
    for (const noteId of noteIds) {
      await this.deleteByNoteId(noteId);
    }

    // Insert new chunks
    for (const chunk of chunks) {
      const doc: OramaDoc = {
        chunkId: chunk.chunkId,
        noteId: chunk.noteId,
        path: chunk.path,
        title: chunk.title,
        headingPath: JSON.stringify(chunk.headingPath),
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        embedding: chunk.embedding,
        mtimeMs: chunk.mtimeMs,
        contentHash: chunk.contentHash,
        tags: JSON.stringify(chunk.tags),
        frontmatter: JSON.stringify(chunk.frontmatter),
        modelKey: chunk.modelKey,
      };

      await insert(this.db, doc);
    }

    this.scheduleSave();
  }

  /**
   * Delete chunks by note ID
   */
  async deleteByNoteId(noteId: string): Promise<void> {
    if (!this.db || this.disposed) return;

    // Find all chunks for this note
    const results = await search(this.db, {
      term: noteId,
      properties: ["noteId"],
      limit: 10000,
    });

    for (const hit of results.hits) {
      if ((hit.document as OramaDoc).noteId === noteId) {
        await remove(this.db, hit.id);
      }
    }

    this.scheduleSave();
  }

  /**
   * Delete chunks by path prefix
   */
  async deleteByPathPrefix(prefix: string): Promise<void> {
    if (!this.db || this.disposed) return;

    // Find all chunks with matching path prefix
    const results = await search(this.db, {
      term: prefix,
      properties: ["path"],
      limit: 10000,
    });

    for (const hit of results.hits) {
      const doc = hit.document as OramaDoc;
      if (doc.path.startsWith(prefix)) {
        await remove(this.db, hit.id);
      }
    }

    this.scheduleSave();
  }

  /**
   * Search for similar chunks
   */
  async search(
    embedding: number[],
    options: SearchOptions
  ): Promise<ChunkSearchResult[]> {
    if (!this.db || this.disposed) {
      return [];
    }

    try {
      const searchParams: SearchParams<Orama<OramaSchema>, OramaDoc> = {
        mode: "vector",
        vector: {
          value: embedding,
          property: "embedding",
        },
        similarity: options.minScore,
        limit: options.topK * 2, // Get more to filter
        includeVectors: false,
      };

      const results = await search(this.db, searchParams);

      const chunks: ChunkSearchResult[] = [];

      for (const hit of results.hits) {
        const doc = hit.document as OramaDoc;
        const score = hit.score;

        // Skip low scores
        if (score < options.minScore) continue;

        const paraType = this.paraDetector.detectType(doc.path);

        // Filter by PARA type if specified
        if (options.paraType && paraType !== options.paraType) continue;

        // Filter by folder paths if specified
        if (options.folderPaths && options.folderPaths.length > 0) {
          const matches = options.folderPaths.some((p) =>
            doc.path.startsWith(p)
          );
          if (!matches) continue;
        }

        // Filter by tags if specified
        if (options.tags && options.tags.length > 0) {
          const chunkTags = JSON.parse(doc.tags) as string[];
          const hasTag = options.tags.some((t) => chunkTags.includes(t));
          if (!hasTag) continue;
        }

        chunks.push({
          chunkId: doc.chunkId,
          noteId: doc.noteId,
          path: doc.path,
          title: doc.title,
          headingPath: JSON.parse(doc.headingPath),
          text: options.includeContent ? doc.text : "",
          score,
          paraType,
        });

        if (chunks.length >= options.topK) break;
      }

      return chunks;
    } catch (error) {
      console.error("[OramaStore] Search failed:", error);
      return [];
    }
  }

  /**
   * Get all chunks for a note
   */
  async getChunksByNoteId(noteId: string): Promise<NoteChunk[]> {
    if (!this.db || this.disposed) {
      return [];
    }

    try {
      const results = await search(this.db, {
        term: noteId,
        properties: ["noteId"],
        limit: 10000,
      });

      return results.hits
        .filter((hit) => (hit.document as OramaDoc).noteId === noteId)
        .map((hit) => {
          const doc = hit.document as OramaDoc;
          return {
            chunkId: doc.chunkId,
            noteId: doc.noteId,
            path: doc.path,
            title: doc.title,
            headingPath: JSON.parse(doc.headingPath),
            chunkIndex: doc.chunkIndex,
            text: doc.text,
            mtimeMs: doc.mtimeMs,
            contentHash: doc.contentHash,
            tags: JSON.parse(doc.tags),
            frontmatter: JSON.parse(doc.frontmatter),
          };
        });
    } catch (error) {
      console.error("[OramaStore] getChunksByNoteId failed:", error);
      return [];
    }
  }

  /**
   * Count total chunks
   */
  async countChunks(): Promise<number> {
    if (!this.db || this.disposed) return 0;

    try {
      return await count(this.db);
    } catch {
      return 0;
    }
  }

  /**
   * Count notes (distinct noteIds)
   */
  async countNotes(): Promise<number> {
    if (!this.db || this.disposed) return 0;

    try {
      // Get all documents and count unique noteIds
      const results = await search(this.db, {
        term: "",
        limit: 100000,
      });

      const noteIds = new Set(
        results.hits.map((hit) => (hit.document as OramaDoc).noteId)
      );
      return noteIds.size;
    } catch {
      return 0;
    }
  }

  /**
   * Check if the store is ready
   */
  isReady(): boolean {
    return !this.disposed && this.db !== null;
  }

  /**
   * Dispose of the store
   */
  async dispose(): Promise<void> {
    // Cancel pending save
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    // Final save
    await this.saveToDisk();

    this.disposed = true;
    this.db = null;
  }
}
