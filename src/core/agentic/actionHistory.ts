/**
 * Action History Service (SQLite-backed)
 *
 * Persists applied actions using SQLite actions table.
 * Supports undo operations via stored undo payloads.
 */

import type { Kysely } from "kysely";
import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { Database } from "../db/schema";
import type { EventBus } from "../events/eventBus";
import { deriveRecordId } from "../ids";
import type {
  AppliedActionRecord,
  AppliedActionStatus,
  DiffUndoPayload,
  ProposedAction,
  RenameBackUndo,
  RestoreContentUndo,
  UndoPayload,
} from "./types";

/** Debounce delay for flushing to disk (for dirty tracking) */
const FLUSH_DEBOUNCE_MS = 500;

/** Retention config (kept for backward compatibility) */
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
 * Manages action history with SQLite storage and diff-based undo
 */
export class ActionHistory {
  private records: AppliedActionRecord[] = [];
  private dirty = false;
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  constructor(
    private db: Kysely<Database>,
    private obsidian: ObsidianFacade,
    private eventBus: EventBus,
    _retention?: ActionRetentionConfig,
  ) {}

  /**
   * Load actions from SQLite
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      const rows = await this.db
        .selectFrom("actions")
        .selectAll()
        .orderBy("created_at", "asc")
        .execute();

      this.records = rows.map((row) => this.rowToRecord(row));
      this.loaded = true;
      console.log(`[ActionHistory] Loaded ${this.records.length} actions`);
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
    this.scheduleFlush();
    this.eventBus.emit("action:applied", { record });
    console.log(`[ActionHistory] Added record: ${record.action.title}`);

    return record;
  }

  /**
   * Flush records to SQLite
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;

    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    // Sync all records to SQLite
    for (const record of this.records) {
      await this.upsertRecord(record);
    }

    this.dirty = false;
    console.log(`[ActionHistory] Flushed ${this.records.length} actions`);
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
      (r) => r.action.target === notePath || r.changedPaths.includes(notePath),
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
        record.status = "undone";
        this.scheduleFlush();
        this.eventBus.emit("action:undone", { recordId });
        console.log(`[ActionHistory] Undone action: ${record.action.title}`);
      } else if (undoResult.partial && record.undo.type === "restore_content") {
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
          record.status = "undone";
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
   * Restore file content(s) to previous state
   */
  private async undoRestoreContent(payload: RestoreContentUndo): Promise<UndoResult> {
    const errors: string[] = [];
    const restoredPaths: string[] = [];
    const failedPaths: string[] = [];

    for (const file of payload.files) {
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
   * Clear all records
   */
  clear(): void {
    this.records = [];
    this.scheduleFlush();
    void this.db.deleteFrom("actions").execute();
  }

  /**
   * Prune old records (kept for backward compatibility)
   */
  prune(): void {
    // No-op - SQLite handles storage efficiently
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

  /**
   * Convert a database row to AppliedActionRecord
   */
  private rowToRecord(row: {
    id: string;
    task_id: string | null;
    workflow_id: string | null;
    type: string;
    risk: string;
    note_path: string | null;
    title: string;
    reason: string;
    reasoning: string;
    created_at: number;
    applied_at: number | null;
    undone_at: number | null;
    status: string;
    payload: string;
    undo_payload: string;
    changed_paths: string;
  }): AppliedActionRecord {
    const payload = JSON.parse(row.payload);
    const action: ProposedAction = {
      id: row.id,
      type: row.type as ProposedAction["type"],
      risk: row.risk as ProposedAction["risk"],
      title: row.title,
      reason: row.reason,
      target: row.note_path ?? "",
      requiresWriteLock: true,
      payload,
    } as ProposedAction;

    return {
      id: row.id,
      timestamp: row.created_at,
      workflowId: row.workflow_id ?? undefined,
      taskId: row.task_id ?? undefined,
      action,
      reasoning: row.reasoning,
      undo: JSON.parse(row.undo_payload),
      changedPaths: JSON.parse(row.changed_paths),
      status: row.status as AppliedActionStatus,
    };
  }

  /**
   * Upsert a record to SQLite
   */
  private async upsertRecord(record: AppliedActionRecord): Promise<void> {
    const row = {
      id: record.id,
      task_id: record.taskId ?? null,
      workflow_id: record.workflowId ?? null,
      type: record.action.type,
      risk: record.action.risk,
      note_path: record.action.target ?? null,
      title: record.action.title,
      reason: record.action.reason,
      reasoning: record.reasoning,
      created_at: record.timestamp,
      applied_at: record.status === "applied" ? record.timestamp : null,
      undone_at: record.status === "undone" ? Date.now() : null,
      status: record.status,
      payload: JSON.stringify("payload" in record.action ? record.action.payload : {}),
      undo_payload: JSON.stringify(record.undo),
      changed_paths: JSON.stringify(record.changedPaths),
    };

    await this.db
      .insertInto("actions")
      .values(row)
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          status: row.status,
          undone_at: row.undone_at,
          undo_payload: row.undo_payload,
          changed_paths: row.changed_paths,
        }),
      )
      .execute();
  }
}

// =============================================================================
// Diff Utilities
// =============================================================================

/**
 * Create a unified diff for undo purposes.
 */
export function createUnifiedDiff(
  newContent: string,
  oldContent: string,
  filePath: string,
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const output: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  const changes = findChanges(newLines, oldLines);

  if (changes.length === 0) {
    return output.join("\n");
  }

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

    for (let i = contextStart; i < change.newStart; i++) {
      output.push(` ${newLines[i]}`);
    }

    for (let i = change.newStart; i < change.newEnd; i++) {
      output.push(`+${newLines[i]}`);
    }

    for (let i = change.oldStart; i < change.oldEnd; i++) {
      output.push(`-${oldLines[i]}`);
    }

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

interface MatchResult {
  found: boolean;
  oldOffset: number;
  newOffset: number;
}

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

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function isDiffContentLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-") || line.startsWith(" ");
}

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

interface HunkApplication {
  deleteCount: number;
  insertLines: string[];
}

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

function applyHunkToLines(resultLines: string[], hunk: DiffHunk): void {
  const startIdx = hunk.newStart - 1;
  const { deleteCount, insertLines } = calculateHunkApplication(hunk.lines);
  resultLines.splice(startIdx, deleteCount, ...insertLines);
}

/**
 * Apply a reverse diff to restore original content.
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
