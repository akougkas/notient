/**
 * Action History Service
 *
 * Persists applied actions with undo data across sessions.
 * Enables single-click undo for all applied actions.
 */

import * as fs from "fs";
import type { StoragePaths } from "../../services/storagePaths";
import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { EventBus } from "../events/eventBus";
import type {
  AppliedActionRecord,
  UndoPayload,
  RestoreContentUndo,
  RenameBackUndo,
} from "./types";

/** Schema version for migration support */
const SCHEMA_VERSION = 1;

/** Default retention settings */
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_AGE_DAYS = 30;
const FLUSH_DEBOUNCE_MS = 500;

/**
 * Root storage schema
 */
interface ActionStorage {
  version: number;
  records: AppliedActionRecord[];
}

/**
 * Retention configuration
 */
export interface ActionRetentionConfig {
  maxEntries: number;
  maxAgeDays: number;
}

/**
 * Undo result
 */
export interface UndoResult {
  success: boolean;
  error?: string;
}

/**
 * Manages action history with undo capability
 */
export class ActionHistory {
  private records: AppliedActionRecord[] = [];
  private dirty = false;
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  constructor(
    private storagePaths: StoragePaths,
    private obsidian: ObsidianFacade,
    private eventBus: EventBus,
    private retention: ActionRetentionConfig = {
      maxEntries: DEFAULT_MAX_ENTRIES,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    }
  ) {}

  /**
   * Load action history from disk
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    const filePath = this.storagePaths.actions;

    try {
      const exists = await this.fileExists(filePath);
      if (!exists) {
        this.loaded = true;
        return;
      }

      const content = await fs.promises.readFile(filePath, "utf-8");
      const storage: ActionStorage = JSON.parse(content);

      // Handle schema migrations here if needed
      if (storage.version !== SCHEMA_VERSION) {
        console.warn(
          `[ActionHistory] Schema migration needed from v${storage.version} to v${SCHEMA_VERSION}`
        );
        // Future: add migration logic
      }

      this.records = storage.records || [];
      this.loaded = true;
      console.log(`[ActionHistory] Loaded ${this.records.length} action records`);
    } catch (error) {
      console.error("[ActionHistory] Failed to load:", error);
      this.loaded = true; // Mark as loaded even on error to prevent retries
    }
  }

  /**
   * Flush action history to disk (debounced)
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;

    // Clear any pending debounce
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    const filePath = this.storagePaths.actions;

    try {
      const storage: ActionStorage = {
        version: SCHEMA_VERSION,
        records: this.records,
      };

      await fs.promises.writeFile(filePath, JSON.stringify(storage, null, 2), "utf-8");
      this.dirty = false;
      console.log(`[ActionHistory] Flushed ${this.records.length} action records`);
    } catch (error) {
      console.error("[ActionHistory] Failed to flush:", error);
    }
  }

  /**
   * Schedule a debounced flush
   */
  private scheduleFlush(): void {
    this.dirty = true;

    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
    }

    this.flushTimeout = setTimeout(() => {
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * Add an applied action record
   */
  addRecord(record: AppliedActionRecord): void {
    this.records.push(record);

    // Enforce max entries limit
    if (this.records.length > this.retention.maxEntries) {
      const excess = this.records.length - this.retention.maxEntries;
      this.records.splice(0, excess);
    }

    this.scheduleFlush();
    this.eventBus.emit("action:applied", { record });
    console.log(`[ActionHistory] Added record: ${record.action.title}`);
  }

  /**
   * Get a record by ID
   */
  getRecord(recordId: string): AppliedActionRecord | undefined {
    return this.records.find((r) => r.id === recordId);
  }

  /**
   * Get all records
   */
  getAllRecords(): AppliedActionRecord[] {
    return [...this.records];
  }

  /**
   * Get records for a specific note
   */
  getRecordsForNote(notePath: string): AppliedActionRecord[] {
    return this.records.filter(
      (r) => r.action.target === notePath || r.changedPaths.includes(notePath)
    );
  }

  /**
   * Get records for a specific workflow
   */
  getRecordsForWorkflow(workflowId: string): AppliedActionRecord[] {
    return this.records.filter((r) => r.workflowId === workflowId);
  }

  /**
   * Get recent records (for dashboard display)
   */
  getRecentRecords(limit = 20): AppliedActionRecord[] {
    return this.records.slice(-limit).reverse();
  }

  /**
   * Undo a specific action by record ID
   */
  async undo(recordId: string): Promise<UndoResult> {
    const recordIndex = this.records.findIndex((r) => r.id === recordId);
    if (recordIndex === -1) {
      return { success: false, error: `Record not found: ${recordId}` };
    }

    const record = this.records[recordIndex];

    try {
      const undoResult = await this.applyUndo(record.undo);

      if (undoResult.success) {
        // Remove the record after successful undo
        this.records.splice(recordIndex, 1);
        this.scheduleFlush();
        this.eventBus.emit("action:undone", { recordId });
        console.log(`[ActionHistory] Undone action: ${record.action.title}`);
      }

      return undoResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ActionHistory] Undo failed:", message);
      return { success: false, error: message };
    }
  }

  /**
   * Apply an undo payload to restore previous state
   */
  private async applyUndo(payload: UndoPayload): Promise<UndoResult> {
    switch (payload.type) {
      case "restore_content":
        return this.undoRestoreContent(payload);
      case "rename_back":
        return this.undoRenameBack(payload);
      default:
        return { success: false, error: `Unknown undo type: ${(payload as UndoPayload).type}` };
    }
  }

  /**
   * Restore file content(s) to previous state
   */
  private async undoRestoreContent(payload: RestoreContentUndo): Promise<UndoResult> {
    const errors: string[] = [];

    for (const file of payload.files) {
      const result = await this.obsidian.modifyFile(file.path, file.before);
      if (!result.success) {
        errors.push(`Failed to restore ${file.path}: ${result.error}`);
      }
    }

    if (errors.length > 0) {
      return { success: false, error: errors.join("; ") };
    }

    return { success: true };
  }

  /**
   * Rename/move a file back to original location
   */
  private async undoRenameBack(payload: RenameBackUndo): Promise<UndoResult> {
    // Create the destination folder if needed
    const parentPath = this.obsidian.getParentFolderPath(payload.to);
    if (parentPath) {
      const folderResult = await this.obsidian.createFolderIfNeeded(parentPath);
      if (!folderResult.success) {
        return {
          success: false,
          error: `Failed to create folder ${parentPath}: ${folderResult.error}`,
        };
      }
    }

    // Move the file back
    const result = await this.obsidian.renameFile(payload.from, payload.to);
    if (!result.success) {
      return {
        success: false,
        error: `Failed to move back from ${payload.from} to ${payload.to}: ${result.error}`,
      };
    }

    return { success: true };
  }

  /**
   * Check if a record can be undone
   */
  canUndo(recordId: string): boolean {
    const record = this.getRecord(recordId);
    if (!record) return false;

    // Check if the file(s) still exist
    switch (record.undo.type) {
      case "restore_content":
        return record.undo.files.every((f) => this.obsidian.getFileByPath(f.path) !== null);
      case "rename_back":
        return this.obsidian.getFileByPath(record.undo.from) !== null;
      default:
        return false;
    }
  }

  /**
   * Prune old records based on retention policy
   */
  prune(): void {
    const now = Date.now();
    const maxAge = this.retention.maxAgeDays * 24 * 60 * 60 * 1000;
    const originalLength = this.records.length;

    this.records = this.records.filter((r) => {
      const age = now - r.timestamp;
      return age <= maxAge;
    });

    const pruned = originalLength - this.records.length;
    if (pruned > 0) {
      this.scheduleFlush();
      console.log(`[ActionHistory] Pruned ${pruned} old records`);
    }
  }

  /**
   * Clear all records
   */
  clear(): void {
    this.records = [];
    this.scheduleFlush();
  }

  /**
   * Update retention configuration
   */
  updateRetention(config: Partial<ActionRetentionConfig>): void {
    if (config.maxEntries !== undefined) {
      this.retention.maxEntries = config.maxEntries;
    }
    if (config.maxAgeDays !== undefined) {
      this.retention.maxAgeDays = config.maxAgeDays;
    }
  }

  /**
   * Get record count
   */
  get count(): number {
    return this.records.length;
  }

  /**
   * Dispose - ensure final flush
   */
  async dispose(): Promise<void> {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    await this.flush();
  }

  // ============ Private Helpers ============

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
