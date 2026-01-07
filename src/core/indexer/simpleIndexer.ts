/**
 * Simple Indexer
 *
 * Streamlined indexing pipeline without JobQueue complexity.
 * Processes notes in batches with UI yielding for responsiveness.
 *
 * Features:
 * - Incremental indexing (only changed notes)
 * - Batch processing with UI yields
 * - Progress reporting
 * - File watcher integration
 */

import type { EventRef, TFile } from "obsidian";
import type { IndexManager } from "../../services/indexManager";
import type { OllamaService } from "../../services/ollama";
import type { EmbeddedChunk, IndexProgress, NoteChunk } from "../../types/indexer";
import type { EventBus } from "../events/eventBus";
import type { Kernel } from "../kernel";
import { generateContentHash, generateNoteId } from "./simpleChunker";
import { chunkNoteTiered } from "./tieredSemanticChunker";

/** Batch size for embedding requests */
const EMBED_BATCH_SIZE = 4;

/** Notes to process before yielding to UI */
const PROCESS_BATCH_SIZE = 5;

/** Yield duration to let UI breathe */
const YIELD_MS = 10;

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  added: number;
  updated: number;
  removed: number;
  errors: number;
  durationMs: number;
}

/**
 * Simple Indexer - orchestrates the indexing pipeline
 */
export class SimpleIndexer {
  private eventRefs: EventRef[] = [];
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private disposed = false;
  private aborted = false;
  private progress: IndexProgress = {
    total: 0,
    completed: 0,
    current: null,
    phase: "idle",
    startedAt: 0,
    estimatedRemainingMs: null,
  };

  constructor(
    private kernel: Kernel,
    private eventBus: EventBus,
    private indexManager: IndexManager,
    private ollama: OllamaService,
  ) {}

  async initialize(): Promise<void> {
    console.log("[SimpleIndexer] Initializing...");
    this.subscribeToVaultEvents();
    console.log("[SimpleIndexer] Initialized");
  }

  /**
   * Sync the entire vault - only indexes changed notes
   */
  async syncVault(): Promise<IndexResult> {
    if (this.disposed) {
      return { added: 0, updated: 0, removed: 0, errors: 0, durationMs: 0 };
    }

    if (!this.kernel.hasWriteLock) {
      console.warn("[SimpleIndexer] Cannot index without write lock");
      return { added: 0, updated: 0, removed: 0, errors: 0, durationMs: 0 };
    }

    const startTime = Date.now();
    this.aborted = false;

    console.log("[SimpleIndexer] Starting vault sync...");

    // Scan vault
    this.updateProgress({ phase: "scanning", startedAt: startTime });
    const changes = await this.scanForChanges();
    await this.yieldToUI();

    if (changes.toIndex.length === 0 && changes.toRemove.length === 0) {
      console.log("[SimpleIndexer] No changes detected");
      this.updateProgress({ phase: "complete" });
      return { added: 0, updated: 0, removed: 0, errors: 0, durationMs: Date.now() - startTime };
    }

    console.log(
      `[SimpleIndexer] Found ${changes.toIndex.length} to index, ${changes.toRemove.length} to remove`,
    );

    // Remove deleted notes
    for (const path of changes.toRemove) {
      const noteId = generateNoteId(path);
      await this.indexManager.removeNote(path, noteId);
    }

    // Index new/changed notes
    this.updateProgress({ total: changes.toIndex.length, completed: 0 });
    this.indexManager.beginBulkUpdate();

    let added = 0;
    let updated = 0;
    let errors = 0;

    try {
      for (let i = 0; i < changes.toIndex.length; i += PROCESS_BATCH_SIZE) {
        if (this.disposed || this.aborted) break;

        const batch = changes.toIndex.slice(i, i + PROCESS_BATCH_SIZE);
        const results = await this.processBatch(batch);

        added += results.added;
        updated += results.updated;
        errors += results.errors;

        this.updateProgress({ completed: Math.min(i + batch.length, changes.toIndex.length) });
        await this.yieldToUI();
      }
    } finally {
      await this.indexManager.endBulkUpdate();
    }

    this.indexManager.recordFullIndex();
    this.updateProgress({ phase: "complete", current: null });

    const durationMs = Date.now() - startTime;
    console.log(
      `[SimpleIndexer] Sync complete: ${added} added, ${updated} updated, ${changes.toRemove.length} removed, ${errors} errors in ${durationMs}ms`,
    );

    this.eventBus.emit("index:complete", {
      totalIndexed: added + updated,
      durationMs,
    });

    return {
      added,
      updated,
      removed: changes.toRemove.length,
      errors,
      durationMs,
    };
  }

  /**
   * Full reindex - clears everything and rebuilds
   */
  async fullReindex(): Promise<IndexResult> {
    if (this.disposed || !this.kernel.hasWriteLock) {
      return { added: 0, updated: 0, removed: 0, errors: 0, durationMs: 0 };
    }

    console.log("[SimpleIndexer] Starting full reindex - clearing existing index...");
    await this.indexManager.clearAll();
    console.log("[SimpleIndexer] Index cleared, starting fresh sync...");
    return this.syncVault();
  }

  /**
   * Index a single note
   */
  async indexNote(path: string): Promise<void> {
    if (this.disposed) return;

    const content = await this.kernel.obsidian.readFileByPath(path);
    if (content === null) return;

    const file = this.kernel.obsidian.getFileByPath(path);
    if (!file) return;

    const mtimeMs = file.stat.mtime;
    await this.processNote(path, content, mtimeMs);
    await this.indexManager.save();
  }

  /**
   * Abort current indexing operation
   */
  abort(): void {
    this.aborted = true;
  }

  /**
   * Get current progress
   */
  getProgress(): IndexProgress {
    return { ...this.progress };
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.disposed = true;
    this.aborted = true;

    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Unsubscribe from events
    for (const ref of this.eventRefs) {
      this.kernel.obsidian.offEvent(ref);
    }
    this.eventRefs = [];
  }

  // ============ Private Methods ============

  private subscribeToVaultEvents(): void {
    const obs = this.kernel.obsidian;
    const debounceMs = this.kernel.settings.indexing.debounceMs;

    this.eventRefs.push(obs.onFileCreate((file) => this.onFileChange(file, debounceMs)));
    this.eventRefs.push(obs.onFileModify((file) => this.onFileChange(file, debounceMs)));
    this.eventRefs.push(obs.onFileRename((file, oldPath) => this.onFileRename(file, oldPath)));
    this.eventRefs.push(obs.onFileDelete((file) => this.onFileDelete(file)));
  }

  private onFileChange(file: TFile, debounceMs: number): void {
    if (this.disposed || !this.shouldIndex(file.path)) return;

    const existing = this.debounceTimers.get(file.path);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      file.path,
      setTimeout(() => {
        this.debounceTimers.delete(file.path);
        void this.indexNote(file.path);
      }, debounceMs),
    );
  }

  private async onFileRename(file: TFile, oldPath: string): Promise<void> {
    if (this.disposed) return;

    // Remove old
    const oldNoteId = generateNoteId(oldPath);
    await this.indexManager.removeNote(oldPath, oldNoteId);

    // Index new if it should be indexed
    if (this.shouldIndex(file.path)) {
      await this.indexNote(file.path);
    }
  }

  private async onFileDelete(file: TFile): Promise<void> {
    if (this.disposed) return;

    const noteId = generateNoteId(file.path);
    await this.indexManager.removeNote(file.path, noteId);
    await this.indexManager.save();
  }

  private shouldIndex(path: string): boolean {
    if (!path.endsWith(".md")) return false;

    const excluded = this.kernel.settings.indexing.excludedFolders;
    for (const folder of excluded) {
      if (path.startsWith(`${folder}/`) || path === folder) {
        return false;
      }
    }

    return true;
  }

  private async scanForChanges(): Promise<{
    toIndex: string[];
    toRemove: string[];
  }> {
    const files = this.kernel.obsidian.getMarkdownFiles();
    const currentPaths = new Set<string>();
    const toIndex: string[] = [];

    for (const file of files) {
      if (!this.shouldIndex(file.path)) continue;

      currentPaths.add(file.path);

      // Read content to compute hash
      const content = await this.kernel.obsidian.readFileByPath(file.path);
      if (content === null) continue;

      const contentHash = generateContentHash(content);
      const mtimeMs = file.stat.mtime;

      if (this.indexManager.needsReindex(file.path, mtimeMs, contentHash)) {
        toIndex.push(file.path);
      }
    }

    // Find removed notes
    const indexedPaths = this.indexManager.getIndexedPaths();
    const toRemove = indexedPaths.filter((p) => !currentPaths.has(p));

    return { toIndex, toRemove };
  }

  private async processBatch(
    paths: string[],
  ): Promise<{ added: number; updated: number; errors: number }> {
    let added = 0;
    let updated = 0;
    let errors = 0;

    for (const path of paths) {
      if (this.disposed || this.aborted) break;

      try {
        this.updateProgress({ current: path, phase: "chunking" });

        const content = await this.kernel.obsidian.readFileByPath(path);
        if (content === null) {
          errors++;
          continue;
        }

        const file = this.kernel.obsidian.getFileByPath(path);
        if (!file) {
          errors++;
          continue;
        }

        const wasIndexed = this.indexManager.getNoteState(path) !== null;
        await this.processNote(path, content, file.stat.mtime);

        if (wasIndexed) {
          updated++;
        } else {
          added++;
        }
      } catch (error) {
        console.error(`[SimpleIndexer] Error processing ${path}:`, error);
        errors++;
      }

      await this.yieldToUI();
    }

    return { added, updated, errors };
  }

  private async processNote(path: string, content: string, mtimeMs: number): Promise<void> {
    // Chunk the note (TSI v2: tiered semantic chunking)
    const metadata = this.kernel.obsidian.getMetadataByPath(path);
    const chunkSize = this.kernel.settings.indexing.chunkSize;
    const chunks = chunkNoteTiered(path, content, mtimeMs, metadata, {
      // Use the existing "chunkSize" slider as a base signal.
      // Tier 2 is slightly smaller; Tier 1 + note sketch are larger.
      blockMaxChars: Math.min(2400, Math.max(600, Math.round(chunkSize * 0.8))),
      sectionMaxChars: Math.min(6000, Math.max(1200, Math.round(chunkSize * 1.6))),
      noteSketchMaxChars: Math.min(8000, Math.max(2000, Math.round(chunkSize * 2.2))),
    });
    if (chunks.length === 0) return;

    // Embed chunks
    this.updateProgress({ phase: "embedding" });
    const embeddedChunks = await this.embedChunks(chunks);

    // Remove existing chunks for this note
    const noteId = generateNoteId(path);
    await this.indexManager.removeNote(path, noteId);

    // Store new chunks
    this.updateProgress({ phase: "storing" });
    await this.indexManager.addChunks(embeddedChunks);

    // Update state
    const contentHash = generateContentHash(content);
    this.indexManager.setNoteState(path, {
      path,
      mtimeMs,
      contentHash,
      chunkCount: chunks.length,
      embeddedAt: Date.now(),
    });
  }

  private async embedChunks(chunks: NoteChunk[]): Promise<EmbeddedChunk[]> {
    const embedded: EmbeddedChunk[] = [];
    const modelKey = this.ollama.getModelKey();

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      if (this.disposed || this.aborted) break;

      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map((c) => c.text);

      await this.yieldToUI();

      const { embeddings } = await this.ollama.embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const embedding = embeddings[j];
        if (!embedding || embedding.length === 0) continue;

        const chunk = batch[j];
        embedded.push({
          ...chunk,
          embedding,
          modelKey,
        });
      }

      await this.yieldToUI();
    }

    return embedded;
  }

  private updateProgress(update: Partial<IndexProgress>): void {
    Object.assign(this.progress, update);

    // Calculate ETA
    if (
      this.progress.total > 0 &&
      this.progress.completed > 0 &&
      this.progress.phase !== "complete" &&
      this.progress.phase !== "idle"
    ) {
      const elapsed = Date.now() - this.progress.startedAt;
      const rate = this.progress.completed / elapsed;
      const remaining = this.progress.total - this.progress.completed;
      this.progress.estimatedRemainingMs = Math.round(remaining / rate);
    }

    this.eventBus.emit("index:progress", { progress: this.progress });
  }

  private yieldToUI(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, YIELD_MS));
  }
}
