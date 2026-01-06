/**
 * Index State Management
 * 
 * Tracks which notes have been indexed and when.
 * Persists to disk for crash recovery.
 */

import * as fs from "fs";
import type { NoteIndexState, NoteIndexStatus } from "../../types/indexer";
import type { StoragePaths } from "../../services/storagePaths";

interface IndexStateData {
  version: number;
  modelKey: string;
  notes: Record<string, NoteIndexState>;
  lastFullIndexAt: number | null;
}

/**
 * Index state store
 */
export class IndexStateStore {
  private state: IndexStateData;
  private dirty = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private storagePaths: StoragePaths) {
    this.state = {
      version: 1,
      modelKey: "",
      notes: {},
      lastFullIndexAt: null,
    };
  }

  /**
   * Initialize state, loading from disk if available
   */
  async initialize(modelKey: string): Promise<void> {
    this.state.modelKey = modelKey;
    
    try {
      const content = await fs.promises.readFile(
        this.storagePaths.indexState,
        "utf-8"
      );
      const loaded: IndexStateData = JSON.parse(content);
      
      // Only load if model key matches
      if (loaded.modelKey === modelKey) {
        this.state = loaded;
      } else {
        // Model changed, start fresh
        console.log("[IndexState] Model changed, starting fresh index");
        this.state = {
          version: 1,
          modelKey,
          notes: {},
          lastFullIndexAt: null,
        };
      }
    } catch {
      // No existing state, start fresh
    }
  }

  /**
   * Get state for a note
   */
  get(path: string): NoteIndexState | null {
    return this.state.notes[path] ?? null;
  }

  /**
   * Get all note states
   */
  getAll(): NoteIndexState[] {
    return Object.values(this.state.notes);
  }

  /**
   * Update state for a note
   */
  set(path: string, state: Partial<NoteIndexState>): void {
    const existing = this.state.notes[path];
    this.state.notes[path] = {
      path,
      mtimeMs: state.mtimeMs ?? existing?.mtimeMs ?? 0,
      sizeBytes: state.sizeBytes ?? existing?.sizeBytes ?? 0,
      contentHash: state.contentHash ?? existing?.contentHash ?? "",
      chunkCount: state.chunkCount ?? existing?.chunkCount ?? 0,
      lastEmbeddedAt: state.lastEmbeddedAt ?? existing?.lastEmbeddedAt ?? 0,
      modelKey: state.modelKey ?? existing?.modelKey ?? this.state.modelKey,
      status: state.status ?? existing?.status ?? "pending",
      lastError: state.lastError ?? existing?.lastError ?? null,
    };
    this.scheduleSave();
  }

  /**
   * Update status for a note
   */
  setStatus(path: string, status: NoteIndexStatus, error?: string): void {
    const existing = this.state.notes[path];
    if (existing) {
      existing.status = status;
      existing.lastError = error ?? null;
      this.scheduleSave();
    }
  }

  /**
   * Remove state for a note
   */
  remove(path: string): void {
    delete this.state.notes[path];
    this.scheduleSave();
  }

  /**
   * Check if a note needs reindexing
   */
  needsIndex(path: string, mtimeMs: number, contentHash: string): boolean {
    const state = this.state.notes[path];
    if (!state) return true;
    
    // Check if content changed
    if (state.contentHash !== contentHash) return true;
    
    // Check if mtime is newer (even if hash same, could indicate file touch)
    if (mtimeMs > state.lastEmbeddedAt) return true;
    
    // Check if model changed
    if (state.modelKey !== this.state.modelKey) return true;
    
    // Check if in error state
    if (state.status === "error") return true;
    
    return false;
  }

  /**
   * Get notes by status
   */
  getByStatus(status: NoteIndexStatus): NoteIndexState[] {
    return Object.values(this.state.notes).filter((n) => n.status === status);
  }

  /**
   * Get counts by status
   */
  getCounts(): Record<NoteIndexStatus, number> {
    const counts: Record<NoteIndexStatus, number> = {
      pending: 0,
      processing: 0,
      indexed: 0,
      error: 0,
    };

    for (const state of Object.values(this.state.notes)) {
      counts[state.status]++;
    }

    return counts;
  }

  /**
   * Record full index completion
   */
  recordFullIndex(): void {
    this.state.lastFullIndexAt = Date.now();
    this.scheduleSave();
  }

  /**
   * Get last full index timestamp
   */
  getLastFullIndexAt(): number | null {
    return this.state.lastFullIndexAt;
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.state.notes = {};
    this.state.lastFullIndexAt = null;
    this.scheduleSave();
  }

  /**
   * Force save to disk
   */
  async flush(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.save();
  }

  /**
   * Schedule a debounced save
   */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimeout) return;
    
    this.saveTimeout = setTimeout(async () => {
      this.saveTimeout = null;
      await this.save();
    }, 1000);
  }

  /**
   * Save state to disk
   */
  private async save(): Promise<void> {
    if (!this.dirty) return;
    
    try {
      await fs.promises.writeFile(
        this.storagePaths.indexState,
        JSON.stringify(this.state, null, 2)
      );
      this.dirty = false;
    } catch (error) {
      console.error("[IndexState] Failed to save:", error);
    }
  }

  /**
   * Dispose and flush
   */
  dispose(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    // Sync save on dispose
    try {
      fs.writeFileSync(
        this.storagePaths.indexState,
        JSON.stringify(this.state, null, 2)
      );
    } catch {
      // Best effort
    }
  }
}
