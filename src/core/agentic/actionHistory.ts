/**
 * Action History Service (Phase 5)
 *
 * Persists applied actions with time-bucketed storage:
 * - Hot file: Recent 200 actions (data/actions/hot/current.json)
 * - Archives: Monthly files (data/actions/archive/{YYYY-MM}.json)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { StoragePaths } from "../../services/storagePaths";
import { atomicWriteFile } from "../../utils/atomicWrite";
import type { EventBus } from "../events/eventBus";
import { deriveRecordId } from "../ids";
import type {
  ActionsArchiveFile,
  AppliedActionRecord,
  AppliedActionStatus,
  DiffUndoPayload,
  HotActionsFile,
  ProposedAction,
  RenameBackUndo,
  RestoreContentUndo,
  UndoPayload,
} from "./types";

/** Schema version for migration support */
const ACTIONS_VERSION = 2;

/** Maximum records in hot file before archiving */
const MAX_HOT_ACTIONS = 200;

/** Number of oldest records to archive when limit exceeded */
const ARCHIVE_THRESHOLD = 150;

/** Debounce delay for flushing to disk */
const FLUSH_DEBOUNCE_MS = 500;

/** Get year-month string from timestamp (YYYY-MM format) */
function getYearMonth(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Group records by month */
function groupByMonth(records: AppliedActionRecord[]): Map<string, AppliedActionRecord[]> {
  const byMonth = new Map<string, AppliedActionRecord[]>();
  for (const record of records) {
    const yearMonth = getYearMonth(record.timestamp);
    const existing = byMonth.get(yearMonth) ?? [];
    existing.push(record);
    byMonth.set(yearMonth, existing);
  }
  return byMonth;
}

/** Retention config (kept for backward compatibility, unused with time-bucketed storage) */
export interface ActionRetentionConfig {
  maxEntries: number;
  maxAgeDays: number;
  maxSizeBytes: number;
}

/** Result of an undo operation */
export interface UndoResult {
  success: boolean;
  partial?: boolean;
  error?: string;
  restoredPaths?: string[];
  failedPaths?: string[];
}

/**
 * Manages action history with time-bucketed storage and diff-based undo
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
    // Retention config kept for backward compatibility but not used for time-bucketed storage
    _retention?: ActionRetentionConfig,
  ) {}

  /**
   * Load hot actions from disk (with migration if needed)
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    // Run migration if legacy file exists
    await this.migrateIfNeeded();

    const hotPath = this.storagePaths.actionsCurrent;

    try {
      const exists = await this.fileExists(hotPath);
      if (!exists) {
        this.loaded = true;
        return;
      }

      const content = await fs.promises.readFile(hotPath, "utf-8");
      const data: HotActionsFile = JSON.parse(content);

      this.records = data.records || [];
      this.loaded = true;
      console.log(`[ActionHistory] Loaded ${this.records.length} hot actions`);
    } catch (error) {
      console.error("[ActionHistory] Failed to load:", error);
      this.loaded = true;
    }
  }

  /**
   * Add an applied action record
   */
  addRecord(
    action: ProposedAction,
    undo: UndoPayload,
    changedPaths: string[],
    reasoning: string,
    workflowId?: string,
    taskId?: string,
  ): AppliedActionRecord {
    const record: AppliedActionRecord = {
      id: deriveRecordId(action.id),
      timestamp: Date.now(),
      workflowId,
      taskId,
      action,
      reasoning,
      undo,
      changedPaths,
      status: "applied",
    };

    this.records.push(record);
    this.dirty = true;

    // Check if we need to archive old records
    if (this.records.length > MAX_HOT_ACTIONS) {
      void this.archiveOldRecords();
    }

    this.scheduleFlush();
    this.eventBus.emit("action:applied", { record });
    console.log(`[ActionHistory] Added record: ${record.action.title}`);

    return record;
  }

  /**
   * Archive oldest records to monthly files when hot file exceeds limit
   */
  private async archiveOldRecords(): Promise<void> {
    if (this.records.length <= MAX_HOT_ACTIONS) return;

    const toArchive = this.records.slice(0, ARCHIVE_THRESHOLD);
    this.records = this.records.slice(ARCHIVE_THRESHOLD);

    for (const [yearMonth, records] of groupByMonth(toArchive)) {
      await this.appendToArchive(yearMonth, records);
    }

    this.dirty = true;
    console.log(`[ActionHistory] Archived ${toArchive.length} records`);
  }

  /**
   * Append records to monthly archive file
   */
  private async appendToArchive(
    yearMonth: string,
    newRecords: AppliedActionRecord[],
  ): Promise<void> {
    const archivePath = this.storagePaths.getActionArchivePath(yearMonth);

    let existing: AppliedActionRecord[] = [];

    try {
      const content = await fs.promises.readFile(archivePath, "utf-8");
      const data: ActionsArchiveFile = JSON.parse(content);
      existing = data.records;
    } catch {
      // File doesn't exist yet
    }

    const allRecords = [...existing, ...newRecords];

    const archive: ActionsArchiveFile = {
      version: ACTIONS_VERSION,
      yearMonth,
      records: allRecords,
      recordCount: allRecords.length,
      archivedAt: Date.now(),
    };

    // Ensure directory exists
    await fs.promises.mkdir(this.storagePaths.actionsArchive, { recursive: true });
    await atomicWriteFile(archivePath, JSON.stringify(archive, null, 2));
  }

  /**
   * Flush hot actions to disk (debounced)
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;

    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    // Ensure directory exists
    await fs.promises.mkdir(this.storagePaths.actionsHot, { recursive: true });

    const data: HotActionsFile = {
      version: ACTIONS_VERSION,
      records: this.records,
      oldestTimestamp: this.records[0]?.timestamp ?? Date.now(),
      newestTimestamp: this.records[this.records.length - 1]?.timestamp ?? Date.now(),
    };

    await atomicWriteFile(this.storagePaths.actionsCurrent, JSON.stringify(data, null, 2));
    this.dirty = false;
    console.log(`[ActionHistory] Flushed ${this.records.length} hot actions`);
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
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * Get a record by ID (hot records only)
   */
  getRecord(recordId: string): AppliedActionRecord | undefined {
    return this.records.find((r) => r.id === recordId);
  }

  /**
   * Get all hot records
   */
  getAllRecords(): AppliedActionRecord[] {
    return [...this.records];
  }

  /**
   * Get records for a specific note (hot records only)
   */
  getRecordsForNote(notePath: string): AppliedActionRecord[] {
    return this.records.filter(
      (r) => r.action.target === notePath || r.changedPaths.includes(notePath),
    );
  }

  /**
   * Get records for a specific workflow (hot records only)
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
   * Get archived actions for a specific month
   */
  async getArchivedActions(yearMonth: string): Promise<AppliedActionRecord[]> {
    const archivePath = this.storagePaths.getActionArchivePath(yearMonth);

    try {
      const content = await fs.promises.readFile(archivePath, "utf-8");
      const data: ActionsArchiveFile = JSON.parse(content);
      return data.records;
    } catch {
      return [];
    }
  }

  /**
   * List available archive months (most recent first)
   */
  async listArchiveMonths(): Promise<string[]> {
    const archiveDir = this.storagePaths.actionsArchive;

    try {
      const files = await fs.promises.readdir(archiveDir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""))
        .sort()
        .reverse();
    } catch {
      return [];
    }
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
        // Update status and remove from hot records
        record.status = "undone";
        this.records.splice(recordIndex, 1);
        this.scheduleFlush();
        this.eventBus.emit("action:undone", { recordId });
        console.log(`[ActionHistory] Undone action: ${record.action.title}`);
      } else if (undoResult.partial && record.undo.type === "restore_content") {
        // Partial success: update the record to only contain files that still need undoing
        const remainingFiles = record.undo.files.filter((f) =>
          undoResult.failedPaths?.includes(f.path),
        );

        if (remainingFiles.length > 0) {
          record.undo = {
            type: "restore_content",
            files: remainingFiles,
          };
          record.changedPaths = remainingFiles.map((f) => f.path);
          this.scheduleFlush();
        } else {
          this.records.splice(recordIndex, 1);
          this.scheduleFlush();
          this.eventBus.emit("action:undone", { recordId });
        }
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
      case "diff":
        return this.undoDiff(payload);
      default:
        return { success: false, error: `Unknown undo type: ${(payload as UndoPayload).type}` };
    }
  }

  /**
   * Restore file content(s) to previous state (legacy method)
   */
  private async undoRestoreContent(payload: RestoreContentUndo): Promise<UndoResult> {
    const errors: string[] = [];
    const restoredPaths: string[] = [];
    const failedPaths: string[] = [];

    for (const file of payload.files) {
      // Empty before content means file was created - trash it
      if (file.before === "") {
        const result = await this.obsidian.trashFile(file.path);
        if (!result.success) {
          errors.push(`Failed to delete ${file.path}: ${result.error}`);
          failedPaths.push(file.path);
        } else {
          restoredPaths.push(file.path);
        }
      } else {
        const result = await this.obsidian.modifyFile(file.path, file.before);
        if (!result.success) {
          errors.push(`Failed to restore ${file.path}: ${result.error}`);
          failedPaths.push(file.path);
        } else {
          restoredPaths.push(file.path);
        }
      }
    }

    if (errors.length > 0) {
      if (restoredPaths.length > 0) {
        return {
          success: false,
          partial: true,
          error: errors.join("; "),
          restoredPaths,
          failedPaths,
        };
      }
      return { success: false, error: errors.join("; "), failedPaths };
    }

    return { success: true, restoredPaths };
  }

  /**
   * Rename/move a file back to original location
   */
  private async undoRenameBack(payload: RenameBackUndo): Promise<UndoResult> {
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
   * Undo using diff (apply reverse patch)
   */
  private async undoDiff(payload: DiffUndoPayload): Promise<UndoResult> {
    const errors: string[] = [];
    const restoredPaths: string[] = [];
    const failedPaths: string[] = [];

    for (const patch of payload.patches) {
      try {
        const current = await this.obsidian.readFileByPath(patch.path);
        if (current === null) {
          errors.push(`File not found: ${patch.path}`);
          failedPaths.push(patch.path);
          continue;
        }

        // Apply the reverse diff
        const restored = applyReverseDiff(current, patch.diff);

        const result = await this.obsidian.modifyFile(patch.path, restored);
        if (!result.success) {
          errors.push(`Failed to restore ${patch.path}: ${result.error}`);
          failedPaths.push(patch.path);
        } else {
          restoredPaths.push(patch.path);
        }
      } catch (error) {
        errors.push(`Error restoring ${patch.path}: ${error}`);
        failedPaths.push(patch.path);
      }
    }

    if (errors.length > 0) {
      if (restoredPaths.length > 0) {
        return {
          success: false,
          partial: true,
          error: errors.join("; "),
          restoredPaths,
          failedPaths,
        };
      }
      return { success: false, error: errors.join("; "), failedPaths };
    }

    return { success: true, restoredPaths };
  }

  /**
   * Check if a record can be undone
   */
  canUndo(recordId: string): boolean {
    const record = this.getRecord(recordId);
    if (!record) return false;

    switch (record.undo.type) {
      case "restore_content":
        return record.undo.files.every((f) => {
          // Empty before = created file, must exist to delete
          // Non-empty before = modified file, must exist to restore
          return this.obsidian.getFileByPath(f.path) !== null;
        });
      case "rename_back":
        return this.obsidian.getFileByPath(record.undo.from) !== null;
      case "diff":
        return record.undo.patches.every((p) => this.obsidian.getFileByPath(p.path) !== null);
      default:
        return false;
    }
  }

  /**
   * Update the status of a record
   */
  updateStatus(recordId: string, status: AppliedActionStatus): void {
    const record = this.records.find((r) => r.id === recordId);
    if (record) {
      record.status = status;
      this.scheduleFlush();
    }
  }

  /**
   * Clear all hot records
   */
  clear(): void {
    this.records = [];
    this.scheduleFlush();
  }

  /**
   * Prune old records (no-op with time-bucketed storage - we archive instead)
   * Kept for backward compatibility
   */
  prune(): void {
    // With time-bucketed storage, old records are archived rather than pruned
    // This method is kept for backward compatibility
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

  // ============ Migration ============

  /**
   * Migrate from legacy single-file format if needed
   */
  private async migrateIfNeeded(): Promise<void> {
    const legacyPath = this.storagePaths.legacyActions;

    try {
      const exists = await this.fileExists(legacyPath);
      if (!exists) return;

      // Check if already migrated
      const hotPath = this.storagePaths.actionsCurrent;
      const hotExists = await this.fileExists(hotPath);
      if (hotExists) return;

      console.log("[ActionHistory] Migrating legacy actions...");

      // Read legacy file
      const content = await fs.promises.readFile(legacyPath, "utf-8");
      const legacy = JSON.parse(content);

      // Ensure directories exist
      await fs.promises.mkdir(this.storagePaths.actionsHot, { recursive: true });
      await fs.promises.mkdir(this.storagePaths.actionsArchive, { recursive: true });

      // Convert records (add reasoning and status fields)
      const records: AppliedActionRecord[] = (legacy.records ?? []).map(
        (r: Partial<AppliedActionRecord>) => ({
          ...r,
          reasoning: r.reasoning ?? "Legacy action - no reasoning recorded",
          status: r.status ?? "applied",
        }),
      );

      // Split into hot (last 200) and archives (older ones)
      const hot = records.slice(-MAX_HOT_ACTIONS);
      const toArchive = records.slice(0, -MAX_HOT_ACTIONS);

      // Save hot records
      this.records = hot;
      this.dirty = true;
      await this.flush();

      // Archive old records by month
      if (toArchive.length > 0) {
        for (const [yearMonth, recs] of groupByMonth(toArchive)) {
          await this.appendToArchive(yearMonth, recs);
        }
      }

      // Move legacy file to _deleted
      await fs.promises.mkdir(this.storagePaths.tempDeleted, { recursive: true });
      const deletedPath = path.join(
        this.storagePaths.tempDeleted,
        `actions-legacy-${Date.now()}.json`,
      );
      await fs.promises.rename(legacyPath, deletedPath);

      console.log(
        `[ActionHistory] Migration complete: ${hot.length} hot, ${toArchive.length} archived`,
      );
    } catch (error) {
      console.error("[ActionHistory] Migration failed:", error);
    }
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

// =============================================================================
// Diff Utilities
// =============================================================================

/**
 * Create a unified diff for undo purposes.
 * The diff is created from newContent to oldContent (reversed) so applying it restores original.
 */
export function createUnifiedDiff(
  newContent: string,
  oldContent: string,
  filePath: string,
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const output: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  // Find changed regions using simple LCS-style comparison
  const changes = findChanges(newLines, oldLines);

  if (changes.length === 0) {
    return output.join("\n");
  }

  // Group changes into hunks with context
  for (const change of changes) {
    const contextStart = Math.max(0, change.newStart - 3);
    const contextEnd = Math.min(newLines.length, change.newEnd + 3);

    const hunkOldStart = change.oldStart - (change.newStart - contextStart) + 1;
    const hunkNewStart = contextStart + 1;
    const hunkOldCount =
      change.oldEnd -
      change.oldStart +
      (contextEnd - change.newEnd) +
      (change.newStart - contextStart);
    const hunkNewCount = contextEnd - contextStart;

    output.push(`@@ -${hunkOldStart},${hunkOldCount} +${hunkNewStart},${hunkNewCount} @@`);

    // Context before
    for (let i = contextStart; i < change.newStart; i++) {
      output.push(` ${newLines[i]}`);
    }

    // Deletions (lines in new that need to be removed)
    for (let i = change.newStart; i < change.newEnd; i++) {
      output.push(`+${newLines[i]}`);
    }

    // Additions (lines from old that need to be restored)
    for (let i = change.oldStart; i < change.oldEnd; i++) {
      output.push(`-${oldLines[i]}`);
    }

    // Context after
    for (let i = change.newEnd; i < contextEnd; i++) {
      output.push(` ${newLines[i]}`);
    }
  }

  return output.join("\n");
}

interface Change {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

interface MatchResult {
  found: boolean;
  oldOffset: number;
  newOffset: number;
}

/** Check if two lines at given indices match */
function linesMatch(
  oldLines: string[],
  newLines: string[],
  oldIdx: number,
  newIdx: number,
): boolean {
  return (
    oldIdx < oldLines.length && newIdx < newLines.length && oldLines[oldIdx] === newLines[newIdx]
  );
}

/** Skip matching lines and return updated indices */
function skipMatchingLines(
  oldLines: string[],
  newLines: string[],
  startOldIdx: number,
  startNewIdx: number,
): { oldIdx: number; newIdx: number } {
  let oldIdx = startOldIdx;
  let newIdx = startNewIdx;
  while (linesMatch(oldLines, newLines, oldIdx, newIdx)) {
    oldIdx++;
    newIdx++;
  }
  return { oldIdx, newIdx };
}

/** Search for a match within lookahead window */
function searchForMatch(
  oldLines: string[],
  newLines: string[],
  oldIdx: number,
  newIdx: number,
  maxLookahead: number,
): MatchResult {
  for (let ahead = 1; ahead <= maxLookahead; ahead++) {
    const result = checkOffsetsAtDistance(oldLines, newLines, oldIdx, newIdx, ahead);
    if (result.found) {
      return result;
    }
  }
  return { found: false, oldOffset: 0, newOffset: 0 };
}

/** Check all offset combinations at a given distance */
function checkOffsetsAtDistance(
  oldLines: string[],
  newLines: string[],
  oldIdx: number,
  newIdx: number,
  distance: number,
): MatchResult {
  for (let oldOffset = 0; oldOffset <= distance; oldOffset++) {
    const newOffset = distance - oldOffset;
    if (linesMatch(oldLines, newLines, oldIdx + oldOffset, newIdx + newOffset)) {
      return { found: true, oldOffset, newOffset };
    }
  }
  return { found: false, oldOffset: 0, newOffset: 0 };
}

/** Find regions where old and new content differ */
function findChanges(newLines: string[], oldLines: string[]): Change[] {
  const changes: Change[] = [];
  let oldIdx = 0;
  let newIdx = 0;
  const maxLookahead = 20;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    const skipped = skipMatchingLines(oldLines, newLines, oldIdx, newIdx);
    oldIdx = skipped.oldIdx;
    newIdx = skipped.newIdx;

    if (oldIdx >= oldLines.length && newIdx >= newLines.length) {
      break;
    }

    const changeStart = { old: oldIdx, new: newIdx };
    const match = searchForMatch(oldLines, newLines, oldIdx, newIdx, maxLookahead);

    if (match.found) {
      oldIdx += match.oldOffset;
      newIdx += match.newOffset;
    } else {
      oldIdx = oldLines.length;
      newIdx = newLines.length;
    }

    changes.push({
      oldStart: changeStart.old,
      oldEnd: oldIdx,
      newStart: changeStart.new,
      newEnd: newIdx,
    });
  }

  return changes;
}

/** Parsed hunk from unified diff */
interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/** Result of processing hunk lines for reverse application */
interface HunkApplication {
  deleteCount: number;
  insertLines: string[];
}

/** Check if a line is a diff content line (starts with +, -, or space) */
function isDiffContentLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-") || line.startsWith(" ");
}

/** Parse a hunk header line into a DiffHunk structure */
function parseHunkHeader(line: string): DiffHunk | null {
  const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
  if (!match) {
    return null;
  }
  return {
    oldStart: Number.parseInt(match[1], 10),
    oldCount: match[2] ? Number.parseInt(match[2], 10) : 1,
    newStart: Number.parseInt(match[3], 10),
    newCount: match[4] ? Number.parseInt(match[4], 10) : 1,
    lines: [],
  };
}

/** Parse all hunks from diff lines */
function parseHunks(diffLines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;

  for (const line of diffLines) {
    if (line.startsWith("@@")) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = parseHunkHeader(line);
      continue;
    }

    if (currentHunk && isDiffContentLine(line)) {
      currentHunk.lines.push(line);
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/** Process a single diff line for reverse application */
function processReverseDiffLine(line: string): { delete: boolean; insert: string | null } {
  const content = line.slice(1);

  if (line.startsWith("+")) {
    return { delete: true, insert: null };
  }
  if (line.startsWith("-")) {
    return { delete: false, insert: content };
  }
  if (line.startsWith(" ")) {
    return { delete: true, insert: content };
  }
  return { delete: false, insert: null };
}

/** Calculate delete count and insert lines for a hunk in reverse application */
function calculateHunkApplication(hunkLines: string[]): HunkApplication {
  let deleteCount = 0;
  const insertLines: string[] = [];

  for (const line of hunkLines) {
    const result = processReverseDiffLine(line);
    if (result.delete) {
      deleteCount++;
    }
    if (result.insert !== null) {
      insertLines.push(result.insert);
    }
  }

  return { deleteCount, insertLines };
}

/** Apply a single hunk to result lines (mutates resultLines) */
function applyHunkToLines(resultLines: string[], hunk: DiffHunk): void {
  const startIdx = hunk.newStart - 1;
  const { deleteCount, insertLines } = calculateHunkApplication(hunk.lines);
  resultLines.splice(startIdx, deleteCount, ...insertLines);
}

/**
 * Apply a reverse diff to restore original content.
 * The diff was created with new→old, so + lines are additions (to remove)
 * and - lines are deletions (to add back).
 *
 * @param currentContent - Current file content
 * @param diff - Unified diff string
 * @returns Restored content
 */
export function applyReverseDiff(currentContent: string, diff: string): string {
  const diffLines = diff.split("\n");
  const resultLines = currentContent.split("\n");

  const hunks = parseHunks(diffLines);
  hunks.reverse();

  for (const hunk of hunks) {
    applyHunkToLines(resultLines, hunk);
  }

  return resultLines.join("\n");
}
