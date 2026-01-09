/**
 * AgentStreamsView - Preact component for Agent Streams tab
 *
 * Displays:
 * - Section 1: Active agents/workflows (running + queued)
 * - Section 2: Pending review items from WorkflowRunner.reviewQueue
 * - Section 3: Recent activity (applied actions)
 */

import { Notice } from "obsidian";
import { useCallback, useState } from "preact/hooks";
import type { ActionApplier } from "../../../core/agentic/actionApplier";
import type { ActionHistory } from "../../../core/agentic/actionHistory";
import type { AppliedActionRecord, ProposedAction, WorkflowRun } from "../../../core/agentic/types";
import type { WorkflowRunner } from "../../../core/agentic/workflowRunner";
import { useEventBus, useService } from "../context/KernelContext";

export function AgentStreamsView() {
  // Get services
  const workflowRunner = useService<WorkflowRunner>("workflowRunner");
  const actionApplier = useService<ActionApplier>("actionApplier");
  const actionHistory = useService<ActionHistory>("actionHistory");

  // State for workflows
  const [currentWorkflow, setCurrentWorkflow] = useState<WorkflowRun | null>(
    workflowRunner?.getCurrentWorkflow() ?? null,
  );
  const [queuedWorkflows, setQueuedWorkflows] = useState<WorkflowRun[]>(
    workflowRunner?.getQueuedWorkflows() ?? [],
  );

  // State for pending review items (aggregated from all workflows)
  const [pendingReview, setPendingReview] = useState<ProposedAction[]>(() => {
    const items: ProposedAction[] = [];
    if (workflowRunner) {
      const current = workflowRunner.getCurrentWorkflow();
      if (current) items.push(...current.reviewQueue);
      for (const wf of workflowRunner.getQueuedWorkflows()) {
        items.push(...wf.reviewQueue);
      }
    }
    return items;
  });

  // State for recent activity
  const [recentActivity, setRecentActivity] = useState<AppliedActionRecord[]>(
    () => actionHistory?.getRecentRecords(5) ?? [],
  );

  // Subscribe to workflow events
  useEventBus("workflow:started", (payload) => {
    setCurrentWorkflow(payload.workflow);
  });

  useEventBus("workflow:progress", (payload) => {
    setCurrentWorkflow({ ...payload.workflow });
    // Update pending review when progress changes
    const items: ProposedAction[] = [...payload.workflow.reviewQueue];
    for (const wf of workflowRunner?.getQueuedWorkflows() ?? []) {
      items.push(...wf.reviewQueue);
    }
    setPendingReview(items);
  });

  useEventBus("workflow:completed", (payload) => {
    setCurrentWorkflow(null);
    setQueuedWorkflows(workflowRunner?.getQueuedWorkflows() ?? []);
    // Refresh recent activity
    setRecentActivity(actionHistory?.getRecentRecords(5) ?? []);
  });

  useEventBus("workflow:cancelled", () => {
    setCurrentWorkflow(workflowRunner?.getCurrentWorkflow() ?? null);
    setQueuedWorkflows(workflowRunner?.getQueuedWorkflows() ?? []);
  });

  useEventBus("action:applied", (payload) => {
    setRecentActivity(actionHistory?.getRecentRecords(5) ?? []);
    // Remove from pending review
    setPendingReview((prev) => prev.filter((a) => a.id !== payload.record.action.id));
  });

  useEventBus("action:undone", () => {
    setRecentActivity(actionHistory?.getRecentRecords(5) ?? []);
  });

  // Handlers
  const handleCancelWorkflow = useCallback(
    (workflowId: string) => {
      if (workflowRunner?.cancel(workflowId)) {
        new Notice("Workflow cancelled");
      }
    },
    [workflowRunner],
  );

  const handleApplyAction = useCallback(
    async (action: ProposedAction) => {
      if (!actionApplier) {
        new Notice("Action applier not available");
        return;
      }
      try {
        await actionApplier.apply(action);
        new Notice(`Applied: ${action.title}`);
      } catch (error) {
        new Notice(`Failed to apply: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    },
    [actionApplier],
  );

  const handleDismissAction = useCallback(
    (actionId: string) => {
      if (workflowRunner?.dismissReviewItem(actionId)) {
        setPendingReview((prev) => prev.filter((a) => a.id !== actionId));
        new Notice("Action dismissed");
      }
    },
    [workflowRunner],
  );

  const handleUndoAction = useCallback(
    async (recordId: string) => {
      if (!actionHistory) {
        new Notice("Action history not available");
        return;
      }
      try {
        await actionHistory.undo(recordId);
        new Notice("Action undone");
      } catch (error) {
        new Notice(`Failed to undo: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    },
    [actionHistory],
  );

  return (
    <div class="nv2-agent-streams">
      {/* Section 1: Active Agents */}
      <ActiveAgentsSection
        currentWorkflow={currentWorkflow}
        queuedWorkflows={queuedWorkflows}
        onCancel={handleCancelWorkflow}
      />

      {/* Section 2: Pending Review */}
      <PendingReviewSection
        items={pendingReview}
        onApply={handleApplyAction}
        onDismiss={handleDismissAction}
      />

      {/* Section 3: Recent Activity */}
      <RecentActivitySection items={recentActivity} onUndo={handleUndoAction} />
    </div>
  );
}

// ============ Section Components ============

interface ActiveAgentsSectionProps {
  currentWorkflow: WorkflowRun | null;
  queuedWorkflows: WorkflowRun[];
  onCancel: (workflowId: string) => void;
}

function ActiveAgentsSection({
  currentWorkflow,
  queuedWorkflows,
  onCancel,
}: ActiveAgentsSectionProps) {
  const hasActivity = currentWorkflow || queuedWorkflows.length > 0;

  return (
    <div class="nv2-section">
      <div class="nv2-section-label">Active Agents</div>
      {!hasActivity ? (
        <div class="nv2-empty-state">
          <div class="nv2-empty-state-text">No active agents</div>
        </div>
      ) : (
        <div class="nv2-workflow-container">
          {currentWorkflow && (
            <WorkflowCard workflow={currentWorkflow} isActive={true} onCancel={onCancel} />
          )}
          {queuedWorkflows.map((wf) => (
            <WorkflowCard key={wf.id} workflow={wf} isActive={false} onCancel={onCancel} />
          ))}
        </div>
      )}
    </div>
  );
}

interface WorkflowCardProps {
  workflow: WorkflowRun;
  isActive: boolean;
  onCancel: (workflowId: string) => void;
}

function WorkflowCard({ workflow, isActive, onCancel }: WorkflowCardProps) {
  const progress =
    workflow.progress.total > 0
      ? Math.round((workflow.progress.completed / workflow.progress.total) * 100)
      : 0;

  const statusLabel = isActive ? "Running" : "Queued";
  const icon = isActive ? "⟳" : "⏳";

  return (
    <div class={`nv2-workflow-card ${isActive ? "nv2-workflow-card--active" : ""}`}>
      <div class="nv2-workflow-header">
        <span class="nv2-workflow-title">
          {icon} <span class="nv2-workflow-command">{workflow.spec.command}</span>
        </span>
        <span class="nv2-workflow-status">{statusLabel}</span>
      </div>

      {isActive && (
        <>
          <div class="nv2-workflow-progress-container">
            <div class="nv2-workflow-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div class="nv2-workflow-progress-text">
            {workflow.progress.completed}/{workflow.progress.total} notes
            {workflow.progress.failed > 0 && ` (${workflow.progress.failed} failed)`}
          </div>
        </>
      )}

      <div class="nv2-workflow-actions">
        {workflow.reviewQueue.length > 0 && (
          <span class="nv2-workflow-review-badge">{workflow.reviewQueue.length} pending</span>
        )}
        <button
          type="button"
          class="nv2-workflow-btn--cancel"
          onClick={() => onCancel(workflow.id)}
        >
          {isActive ? "Stop" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

interface PendingReviewSectionProps {
  items: ProposedAction[];
  onApply: (action: ProposedAction) => void;
  onDismiss: (actionId: string) => void;
}

function PendingReviewSection({ items, onApply, onDismiss }: PendingReviewSectionProps) {
  return (
    <div class="nv2-section">
      <div class="nv2-section-label">
        Pending Review
        {items.length > 0 && <span class="nv2-badge">{items.length}</span>}
      </div>
      {items.length === 0 ? (
        <div class="nv2-empty-state">
          <div class="nv2-empty-state-text">No actions pending review</div>
        </div>
      ) : (
        <div class="nv2-review-list">
          {items.map((action) => (
            <ReviewItem key={action.id} action={action} onApply={onApply} onDismiss={onDismiss} />
          ))}
        </div>
      )}
    </div>
  );
}

interface ReviewItemProps {
  action: ProposedAction;
  onApply: (action: ProposedAction) => void;
  onDismiss: (actionId: string) => void;
}

function ReviewItem({ action, onApply, onDismiss }: ReviewItemProps) {
  const riskClass =
    action.risk === "high" ? "nv2-risk--high" : action.risk === "medium" ? "nv2-risk--medium" : "";
  const riskIcon = action.risk === "high" ? "⚠️" : action.risk === "medium" ? "⚠" : "";

  return (
    <div class={`nv2-review-item ${riskClass}`}>
      <div class="nv2-review-header">
        <span class="nv2-review-title">
          {riskIcon} {action.title}
        </span>
        <span class="nv2-review-type">{action.type.replace(/_/g, " ")}</span>
      </div>
      <div class="nv2-review-target">Target: {action.target}</div>
      <div class="nv2-review-reason">{action.reason}</div>
      <div class="nv2-review-actions">
        <button type="button" class="nv2-btn nv2-btn--primary" onClick={() => onApply(action)}>
          Apply
        </button>
        <button
          type="button"
          class="nv2-btn nv2-btn--secondary"
          onClick={() => onDismiss(action.id)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

interface RecentActivitySectionProps {
  items: AppliedActionRecord[];
  onUndo: (recordId: string) => void;
}

function RecentActivitySection({ items, onUndo }: RecentActivitySectionProps) {
  return (
    <div class="nv2-section">
      <div class="nv2-section-label">Recent Activity</div>
      {items.length === 0 ? (
        <div class="nv2-empty-state">
          <div class="nv2-empty-state-text">No recent activity</div>
        </div>
      ) : (
        <div class="nv2-activity-log-list">
          {items.map((record) => (
            <ActivityItem key={record.id} record={record} onUndo={onUndo} />
          ))}
        </div>
      )}
    </div>
  );
}

interface ActivityItemProps {
  record: AppliedActionRecord;
  onUndo: (recordId: string) => void;
}

function ActivityItem({ record, onUndo }: ActivityItemProps) {
  const timeAgo = formatTimeAgo(record.timestamp);

  return (
    <div class="nv2-activity-item">
      <div class="nv2-activity-header">
        <span class="nv2-activity-agent">
          <span class="nv2-activity-icon">✓</span>
          <span class="nv2-activity-agent-name">{record.action.title}</span>
        </span>
        <span class="nv2-activity-time">{timeAgo}</span>
      </div>
      <div class="nv2-task-note">{record.action.target}</div>
      <div class="nv2-activity-actions">
        <button
          type="button"
          class="nv2-btn nv2-btn--secondary nv2-btn--small"
          onClick={() => onUndo(record.id)}
        >
          Undo
        </button>
      </div>
    </div>
  );
}

// ============ Helpers ============

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
