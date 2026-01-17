/**
 * Activity Tab - Agent activity and undo history
 * Shows running pipeline, recent activity, and undo options
 * Placeholder implementation - will be wired in G6
 */

import { signal } from "@preact/signals";
import type { PipelineProgress, RecentActivityItem, UndoHistoryItem } from "../types";

/** Placeholder state - will be wired to EventBus in G6 */
const currentPipeline = signal<PipelineProgress | null>(null);
const recentActivity = signal<RecentActivityItem[]>([]);
const undoHistory = signal<UndoHistoryItem[]>([]);

export function ActivityTab() {
  const pipeline = currentPipeline.value;
  const recent = recentActivity.value;
  const history = undoHistory.value;

  const handleCancel = () => {
    currentPipeline.value = null;
  };

  const handleUndo = (id: string) => {
    undoHistory.value = history.map((item) =>
      item.id === id ? { ...item, canUndo: false } : item,
    );
  };

  const formatTime = (timestamp: number): string => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "just now";
    if (minutes === 1) return "1 min ago";
    return `${minutes} min ago`;
  };

  return (
    <div class="nv2-tab nv2-activity-tab" role="tabpanel" aria-label="Activity">
      {/* Running Pipeline */}
      {pipeline && (
        <section class="nv2-section nv2-pipeline-section">
          <div class="nv2-pipeline-header">
            <span class="nv2-pipeline-status">Running</span>
            <span class="nv2-pipeline-note">Enhance "{pipeline.noteId}"</span>
          </div>
          <div class="nv2-pipeline-info">
            <span>Stage: {pipeline.stage}</span>
            <div class="nv2-progress-bar">
              <div
                class="nv2-progress-fill"
                style={{ width: `${pipeline.percent}%` }}
              />
            </div>
          </div>
          <button type="button" class="nv2-button nv2-button--danger" onClick={handleCancel}>
            Cancel
          </button>
        </section>
      )}

      {/* Recent Activity */}
      <section class="nv2-section">
        <h2 class="nv2-section-title">Recent</h2>
        {recent.length === 0 ? (
          <p class="nv2-section-hint">No recent activity</p>
        ) : (
          <ul class="nv2-activity-list" role="list">
            {recent.map((item) => (
              <li key={item.id} class="nv2-activity-item">
                <span class={`nv2-activity-icon nv2-activity-icon--${item.status}`}>
                  {item.status === "completed" ? "✓" : item.status === "cancelled" ? "✕" : "!"}
                </span>
                <span class="nv2-activity-text">
                  {item.type === "enhance" ? "Enhance" : "Undo"} "{item.noteTitle}"
                </span>
                <span class="nv2-activity-time">{formatTime(item.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Undo History */}
      <section class="nv2-section">
        <h2 class="nv2-section-title">Undo History</h2>
        {history.length === 0 ? (
          <p class="nv2-section-hint">No actions to undo</p>
        ) : (
          <ul class="nv2-undo-list" role="list">
            {history.map((item) => (
              <li key={item.id} class="nv2-undo-item">
                <span class="nv2-undo-icon">↩</span>
                <span class="nv2-undo-text">{item.summary}</span>
                <span class="nv2-undo-time">{formatTime(item.timestamp)}</span>
                {item.canUndo && (
                  <button
                    type="button"
                    class="nv2-button nv2-button--small"
                    onClick={() => handleUndo(item.id)}
                  >
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
