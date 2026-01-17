/**
 * UI-specific types for Notient Sidebar
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G4)
 */

/** Available sidebar tabs */
export type SidebarTab = "vitals" | "suggestions" | "activity";

/** System connection status */
export interface SystemStatus {
  connected: boolean;
  noteCount: number;
  version: string;
}

/** Pipeline running state for Activity tab */
export interface PipelineProgress {
  noteId: string;
  stage: string;
  percent: number;
  startedAt: number;
}

/** Undo history item for Activity tab */
export interface UndoHistoryItem {
  id: string;
  summary: string;
  noteId: string;
  timestamp: number;
  canUndo: boolean;
}

/** Recent activity item */
export interface RecentActivityItem {
  id: string;
  type: "enhance" | "undo";
  noteTitle: string;
  timestamp: number;
  status: "completed" | "cancelled" | "error";
}

/** Active file info for UI display */
export interface ActiveFileInfo {
  path: string;
  name: string;
  basename: string;
}
