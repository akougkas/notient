/**
 * Indexing Pipeline
 *
 * Orchestrates note discovery, chunking, embedding, and storage.
 * NON-BLOCKING: Uses yielding to keep UI responsive.
 */

import type { TFile, EventRef } from "obsidian";
import type { Kernel } from "../kernel";
import type { EventBus } from "../events/eventBus";
import type { JobQueue } from "../queue/jobQueue";
import type { OllamaService } from "../../services/ollama";
import type { VectorStore } from "../../services/vectorStore";
import type {
  IndexProgress,
  NoteChunk,
  EmbeddedChunk,
} from "../../types/indexer";
import type { IndexJobPayload } from "../../types/queue";
import { IndexStateStore } from "./indexState";
import { chunkNote, generateNoteId, generateContentHash } from "./chunker";

/** Yield to UI every N milliseconds */
const YIELD_INTERVAL_MS = 100;
/** Files to process before yielding during scan */
const SCAN_BATCH_SIZE = 5;

/**
 * Helper to yield control back to the event loop
 */
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Main indexing pipeline
 */
export class IndexPipeline {
  private stateStore: IndexStateStore;
  private eventRefs: EventRef[] = [];
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private disposed = false;
  private indexingAborted = false;
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
    private jobQueue: JobQueue,
    private ollamaService: OllamaService,
    private vectorStore: VectorStore
  ) {
    this.stateStore = new IndexStateStore(kernel.storagePaths);
  }

  /**
   * Initialize the pipeline
   */
  async initialize(): Promise<void> {
    console.log("[IndexPipeline] Initializing...");

    // Initialize state store with current model key
    const modelKey = this.ollamaService.getModelKey();
    await this.stateStore.initialize(modelKey);

    // Register job processor
    this.jobQueue.registerProcessor<"index", IndexJobPayload>(
      "index",
      async (job) => {
        await this.processIndexJob(job.payload);
      }
    );

    // Subscribe to vault events
    this.subscribeToVaultEvents();

    console.log("[IndexPipeline] Initialized");
  }

  /**
   * Subscribe to vault file events
   */
  private subscribeToVaultEvents(): void {
    const obsidian = this.kernel.obsidian;

    this.eventRefs.push(
      obsidian.onFileCreate((file) => {
        this.onFileChange(file, "create");
      })
    );

    this.eventRefs.push(
      obsidian.onFileModify((file) => {
        this.onFileChange(file, "modify");
      })
    );

    this.eventRefs.push(
      obsidian.onFileRename((file, oldPath) => {
        this.onFileRename(file, oldPath);
      })
    );

    this.eventRefs.push(
      obsidian.onFileDelete((file) => {
        this.onFileDelete(file);
      })
    );
  }

  /**
   * Handle file creation or modification
   */
  private onFileChange(file: TFile, reason: "create" | "modify"): void {
    if (this.disposed) return;
    if (!this.shouldIndex(file.path)) return;

    // Debounce changes
    const debounceMs = this.kernel.settings.indexing.debounceMs;
    const existing = this.debounceTimers.get(file.path);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(
      file.path,
      setTimeout(() => {
        this.debounceTimers.delete(file.path);
        this.enqueueIndex(file.path, reason);
      }, debounceMs)
    );
  }

  /**
   * Handle file rename
   */
  private async onFileRename(file: TFile, oldPath: string): Promise<void> {
    if (this.disposed) return;

    // Remove old path from index
    const oldNoteId = generateNoteId(oldPath);
    await this.vectorStore.deleteByNoteId(oldNoteId);
    this.stateStore.remove(oldPath);

    // Index new path
    if (this.shouldIndex(file.path)) {
      this.enqueueIndex(file.path, "modify");
    }
  }

  /**
   * Handle file deletion
   */
  private async onFileDelete(file: TFile): Promise<void> {
    if (this.disposed) return;

    const noteId = generateNoteId(file.path);
    await this.vectorStore.deleteByNoteId(noteId);
    this.stateStore.remove(file.path);
  }

  /**
   * Check if a file should be indexed
   */
  private shouldIndex(path: string): boolean {
    const excluded = this.kernel.settings.indexing.excludedFolders;
    for (const folder of excluded) {
      if (path.startsWith(folder + "/") || path.startsWith(folder)) {
        return false;
      }
    }
    return path.endsWith(".md");
  }

  /**
   * Enqueue a file for indexing
   */
  private async enqueueIndex(
    path: string,
    reason: "create" | "modify" | "startup" | "manual"
  ): Promise<void> {
    await this.jobQueue.enqueue<"index", IndexJobPayload>("index", {
      path,
      reason,
    });
  }

  /**
   * Start a full vault index - NON-BLOCKING with yielding
   */
  async startFullIndex(): Promise<void> {
    if (this.disposed) return;
    if (!this.kernel.hasWriteLock) {
      console.warn("[IndexPipeline] Cannot index without write lock");
      return;
    }

    console.log("[IndexPipeline] Starting full index...");
    this.indexingAborted = false;

    const files = this.kernel.obsidian.getMarkdownFiles();
    const toIndex: string[] = [];

    this.updateProgress({
      phase: "scanning",
      total: files.length,
      completed: 0,
      startedAt: Date.now(),
    });

    let lastYield = Date.now();
    let scannedCount = 0;

    // Check which files need indexing - with yielding
    for (const file of files) {
      if (this.disposed || this.indexingAborted) {
        console.log("[IndexPipeline] Indexing aborted during scan");
        return;
      }

      if (!this.shouldIndex(file.path)) continue;

      try {
        // Read file content
        const content = await this.kernel.obsidian.readFile(file);
        const contentHash = generateContentHash(content);

        if (
          this.stateStore.needsIndex(file.path, file.stat.mtime, contentHash)
        ) {
          toIndex.push(file.path);
        }

        scannedCount++;

        // Yield to UI periodically
        if (
          scannedCount % SCAN_BATCH_SIZE === 0 ||
          Date.now() - lastYield > YIELD_INTERVAL_MS
        ) {
          this.updateProgress({
            current: `Scanning: ${scannedCount}/${files.length}`,
          });
          await yieldToUI();
          lastYield = Date.now();
        }
      } catch (error) {
        console.warn(
          `[IndexPipeline] Failed to read ${file.path}:`,
          error
        );
        // Continue with next file
      }
    }

    console.log(
      `[IndexPipeline] Scan complete. ${toIndex.length} files need indexing.`
    );
    this.updateProgress({ total: toIndex.length, current: null });

    // Enqueue files in batches to avoid blocking
    if (toIndex.length > 0) {
      const ENQUEUE_BATCH = 20;
      for (let i = 0; i < toIndex.length; i += ENQUEUE_BATCH) {
        if (this.disposed || this.indexingAborted) return;

        const batch = toIndex.slice(i, i + ENQUEUE_BATCH);
        await this.jobQueue.enqueueBatch<"index", IndexJobPayload>(
          "index",
          batch.map((path) => ({ path, reason: "startup" }))
        );

        // Yield after each batch
        await yieldToUI();
      }
    }

    if (toIndex.length === 0) {
      this.updateProgress({ phase: "complete", completed: 0, total: 0 });
      this.eventBus.emit("index:complete", {
        totalIndexed: 0,
        durationMs: Date.now() - this.progress.startedAt,
      });
    }
  }

  /**
   * Abort current indexing
   */
  abortIndexing(): void {
    this.indexingAborted = true;
    this.jobQueue.pause();
  }

  /**
   * Process a single index job - with yielding
   */
  private async processIndexJob(payload: IndexJobPayload): Promise<void> {
    const { path } = payload;

    if (this.disposed) return;

    console.log(`[IndexPipeline] Processing: ${path}`);
    this.updateProgress({ current: path, phase: "chunking" });
    this.stateStore.setStatus(path, "processing");

    try {
      // Read file content
      const content = await this.kernel.obsidian.readFileByPath(path);
      if (content === null) {
        throw new Error("File not found");
      }

      const file = this.kernel.obsidian.getFileByPath(path);
      if (!file) {
        throw new Error("File not found");
      }

      const mtimeMs = file.stat.mtime;
      const contentHash = generateContentHash(content);

      // Check if already up to date (race condition protection)
      if (!this.stateStore.needsIndex(path, mtimeMs, contentHash)) {
        this.progress.completed++;
        this.emitProgress();
        return;
      }

      // Yield before chunking
      await yieldToUI();

      // Chunk the content
      const chunks = chunkNote(path, content, mtimeMs, {
        chunkSize: this.kernel.settings.indexing.chunkSize,
        chunkOverlap: this.kernel.settings.indexing.chunkOverlap,
        preserveStructure: true,
      });

      // Yield before embedding
      await yieldToUI();

      // Embed chunks
      this.updateProgress({ phase: "embedding" });
      const embeddedChunks = await this.embedChunks(chunks);

      // Yield before storing
      await yieldToUI();

      // Store in vector DB
      this.updateProgress({ phase: "storing" });
      await this.vectorStore.upsertChunks(embeddedChunks);

      // Update state
      this.stateStore.set(path, {
        mtimeMs,
        sizeBytes: content.length,
        contentHash,
        chunkCount: chunks.length,
        lastEmbeddedAt: Date.now(),
        modelKey: this.ollamaService.getModelKey(),
        status: "indexed",
        lastError: null,
      });

      this.progress.completed++;
      console.log(
        `[IndexPipeline] Completed ${this.progress.completed}/${this.progress.total}: ${path}`
      );
      this.emitProgress();

      // Check if full index complete
      if (this.progress.completed >= this.progress.total) {
        this.stateStore.recordFullIndex();
        this.updateProgress({ phase: "complete", current: null });
        this.eventBus.emit("index:complete", {
          totalIndexed: this.progress.total,
          durationMs: Date.now() - this.progress.startedAt,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[IndexPipeline] Error indexing ${path}:`, message);
      this.stateStore.setStatus(path, "error", message);
      this.eventBus.emit("index:error", { path, error: message });
      // Don't throw - continue with next file
      this.progress.completed++;
      this.emitProgress();
    }
  }

  /**
   * Embed chunks using Ollama - ONE AT A TIME with yield after each
   * This keeps the UI responsive during long embedding operations
   */
  private async embedChunks(chunks: NoteChunk[]): Promise<EmbeddedChunk[]> {
    const embeddedChunks: EmbeddedChunk[] = [];
    const modelKey = this.ollamaService.getModelKey();

    // Process ONE chunk at a time for maximum UI responsiveness
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      try {
        // Embed single chunk
        const { embeddings } = await this.ollamaService.embedBatch([chunk.text]);

        embeddedChunks.push({
          ...chunk,
          embedding: embeddings[0],
          modelKey,
        });

        // Update progress for each chunk
        this.updateProgress({
          current: `Embedding chunk ${i + 1}/${chunks.length}`,
        });
      } catch (error) {
        console.error(`[IndexPipeline] Embedding chunk ${i} failed:`, error);
        throw error;
      }

      // Yield after EVERY chunk to keep UI responsive
      await yieldToUI();
    }

    return embeddedChunks;
  }

  /**
   * Get current progress
   */
  getProgress(): IndexProgress {
    return { ...this.progress };
  }

  /**
   * Get index state store
   */
  getStateStore(): IndexStateStore {
    return this.stateStore;
  }

  /**
   * Update and emit progress
   */
  private updateProgress(update: Partial<IndexProgress>): void {
    Object.assign(this.progress, update);

    // Calculate estimated time
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

    this.emitProgress();
  }

  private emitProgress(): void {
    this.eventBus.emit("index:progress", { progress: this.progress });
  }

  /**
   * Dispose of the pipeline
   */
  dispose(): void {
    this.disposed = true;
    this.indexingAborted = true;

    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Unsubscribe from vault events
    for (const ref of this.eventRefs) {
      this.kernel.obsidian.offEvent(ref);
    }
    this.eventRefs = [];

    // Flush state
    this.stateStore.dispose();
  }
}
