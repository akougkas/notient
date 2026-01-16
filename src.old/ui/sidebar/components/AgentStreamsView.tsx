/**
 * AgentStreamsView - View showing agent activity (View 2)
 *
 * Per spec layout:
 * 0. Capability Cards - Search, Context, Chat status (per PRD)
 * 1. Active Agents - running/queued agents with progress
 * 2. Pending Review - actions awaiting approval with risk levels
 * 3. Recent Activity - completed/failed actions with undo
 */

import type { Signal } from "@preact/signals";
import { formatTimeAgo, truncate } from "../utils/formatters";
import { Icon } from "./Icon";

/**
 * UI-only capability types for display purposes.
 * These are NOT AgentType values - they're categories for the capability cards.
 */
export type CapabilityType = "search" | "context" | "chat";

/**
 * Capability status for the 3 core capability cards
 */
export interface CapabilityStatus {
  agent: CapabilityType;
  health: "healthy" | "degraded" | "offline";
  isActive: boolean;
  lastActivity?: Date;
}

export interface ActiveAgent {
  id: string;
  type: string;
  activeSkill?: string; // NEW: Track the specific skill being used (e.g. "JSON Canvas Creator")
  targetNote: string;
  status: "running" | "paused" | "queued" | "completed";
  progress?: number;
  startedAt?: Date;
  completedAt?: Date;
  /** Full result data for "View Results" modal */
  resultData?: AgentResultData;
}

/** Result data from agent execution */
export interface AgentResultData {
  /** Main content/response from agent */
  content: string;
  /** Structured data (actions, links, tags, etc.) */
  structured?: unknown;
  /** Citations/related notes */
  citations?: string[];
  /** One-liner insight to show in Vitals */
  insightSummary?: string;
  /** Statistics */
  stats?: {
    durationMs: number;
    tokensUsed?: number;
  };
}

export interface PendingAction {
  id: string;
  actionType: string;
  targetNote: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
}

export interface RecentActivity {
  id: string;
  status: "success" | "failed" | "undone";
  actionType: string;
  targetNote: string;
  summary: string;
  completedAt: Date;
  canUndo: boolean;
  error?: string;
}

interface AgentStreamsViewProps {
  activeAgents: Signal<ActiveAgent[]>;
  pendingActions: Signal<PendingAction[]>;
  recentActivity: Signal<RecentActivity[]>;
  /** Status of the 3 capability agents */
  capabilities?: Signal<CapabilityStatus[]>;
  onPauseAgent?: (id: string) => void;
  onStopAgent?: (id: string) => void;
  onApplyAction?: (id: string) => void;
  onDismissAction?: (id: string) => void;
  onUndoAction?: (id: string) => void;
  /** View results of completed agent */
  onViewResults?: (agent: ActiveAgent) => void;
  /** Dismiss completed agent from list */
  onDismissAgent?: (id: string) => void;
}

export function AgentStreamsView({
  activeAgents,
  pendingActions,
  recentActivity,
  capabilities,
  onPauseAgent,
  onStopAgent,
  onApplyAction,
  onDismissAction,
  onUndoAction,
  onViewResults,
  onDismissAgent,
}: AgentStreamsViewProps) {
  const hasActiveAgents = activeAgents.value.length > 0;
  const hasPendingActions = pendingActions.value.length > 0;
  const hasRecentActivity = recentActivity.value.length > 0;
  const isEmpty = !hasActiveAgents && !hasPendingActions && !hasRecentActivity;

  return (
    // biome-ignore lint/a11y/useSemanticElements: role="region" is valid ARIA landmark
    <div class="nv2-agent-streams" role="region" aria-label="Agent activity">
      {/* Section 0: Capability Cards (per PRD: Search, Context, Chat) */}
      <CapabilityCards capabilities={capabilities} />

      {isEmpty ? (
        <AgentEmptyState />
      ) : (
        <>
          {/* Section 1: Active Agents */}
          <section class="nv2-agent-section" aria-label="Active agents">
            <h3 class="nv2-section-title">
              <Icon name="bot" className="nv2-section-title-icon" />
              Active
              {hasActiveAgents && (
                <span class="nv2-count-badge nv2-count-badge--active">
                  {activeAgents.value.length}
                </span>
              )}
            </h3>
            {!hasActiveAgents ? (
              <div class="nv2-empty-section">All agents idle</div>
            ) : (
              <div class="nv2-agent-list">
                {activeAgents.value.map((agent) => (
                  <ActiveAgentCard
                    key={agent.id}
                    agent={agent}
                    onPause={() => onPauseAgent?.(agent.id)}
                    onStop={() => onStopAgent?.(agent.id)}
                    onViewResults={() => onViewResults?.(agent)}
                    onDismiss={() => onDismissAgent?.(agent.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Section 2: Pending Review */}
          <section class="nv2-agent-section" aria-label="Pending review">
            <h3 class="nv2-section-title">
              <Icon name="alert-circle" className="nv2-section-title-icon" />
              Pending Review
              {hasPendingActions && (
                <span class="nv2-count-badge nv2-count-badge--pending">
                  {pendingActions.value.length}
                </span>
              )}
            </h3>
            {!hasPendingActions ? (
              <div class="nv2-empty-section">No actions need review</div>
            ) : (
              <div class="nv2-pending-list">
                {pendingActions.value.map((action) => (
                  <PendingActionCard
                    key={action.id}
                    action={action}
                    onApply={() => onApplyAction?.(action.id)}
                    onDismiss={() => onDismissAction?.(action.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Section 3: Recent Activity */}
          <section class="nv2-agent-section" aria-label="Recent activity">
            <h3 class="nv2-section-title">
              <Icon name="clipboard-list" className="nv2-section-title-icon" />
              Recent
            </h3>
            {!hasRecentActivity ? (
              <div class="nv2-empty-section">No recent activity</div>
            ) : (
              <div class="nv2-activity-list">
                {recentActivity.value.slice(0, 8).map((activity) => (
                  <RecentActivityCard
                    key={activity.id}
                    activity={activity}
                    onUndo={() => onUndoAction?.(activity.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Capability Cards - Shows status of the 3 core capabilities
 * Per PRD: Three capability cards: Semantic Search, Context Builder, Chat Assistant
 */
const CAPABILITY_CONFIG: Record<
  CapabilityType,
  { icon: string; label: string; description: string }
> = {
  search: { icon: "search", label: "Search", description: "Semantic search" },
  context: { icon: "package", label: "Context", description: "Context bundler" },
  chat: { icon: "message-square", label: "Chat", description: "Chat assistant" },
};

interface CapabilityCardsProps {
  capabilities?: Signal<CapabilityStatus[]>;
}

function CapabilityCards({ capabilities }: CapabilityCardsProps) {
  // Default capabilities if not provided
  const defaultCaps: CapabilityStatus[] = [
    { agent: "search" as CapabilityType, health: "healthy", isActive: false },
    { agent: "context" as CapabilityType, health: "healthy", isActive: false },
    { agent: "chat" as CapabilityType, health: "healthy", isActive: false },
  ];

  const caps = capabilities?.value ?? defaultCaps;

  return (
    <section class="nv2-capability-section" aria-label="Agent capabilities">
      <div class="nv2-capability-cards">
        {caps.map((cap) => {
          const config = CAPABILITY_CONFIG[cap.agent];
          return (
            <div
              key={cap.agent}
              class={`nv2-capability-card nv2-capability-card--${cap.health}${cap.isActive ? " nv2-capability-card--active" : ""}`}
              title={`${config.label}: ${cap.health}${cap.isActive ? " (active)" : ""}`}
            >
              <Icon name={config.icon} className="nv2-capability-icon" />
              <span class="nv2-capability-label">{config.label}</span>
              <span
                class={`nv2-capability-dot nv2-capability-dot--${cap.health}`}
                aria-label={cap.health}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AgentEmptyState() {
  return (
    <div class="nv2-agent-empty">
      <Icon name="bot" className="nv2-agent-empty-icon" />
      <div class="nv2-agent-empty-title">No Agent Activity</div>
      <div class="nv2-agent-empty-text">Use Quick Actions or /commands to start agents</div>
    </div>
  );
}

interface ActiveAgentCardProps {
  agent: ActiveAgent;
  onPause?: () => void;
  onStop?: () => void;
  onViewResults?: () => void;
  onDismiss?: () => void;
}

function AgentStatusIndicator({ status }: { status: ActiveAgent["status"] }) {
  switch (status) {
    case "running":
      return <span class="nv2-agent-spinner" aria-hidden="true" />;
    case "paused":
      return <Icon name="pause" className="nv2-agent-paused-icon" />;
    case "queued":
      return <Icon name="clock" className="nv2-agent-queued-icon" />;
    case "completed":
      return <Icon name="check-circle" className="nv2-agent-completed-icon" />;
  }
}

interface AgentActionsProps {
  status: ActiveAgent["status"];
  onPause?: () => void;
  onStop?: () => void;
  onViewResults?: () => void;
  onDismiss?: () => void;
}

function AgentActions({ status, onPause, onStop, onViewResults, onDismiss }: AgentActionsProps) {
  switch (status) {
    case "running":
      return (
        <>
          <button type="button" class="nv2-btn-sm" onClick={onPause} aria-label="Pause agent">
            Pause
          </button>
          <button
            type="button"
            class="nv2-btn-sm nv2-btn-danger"
            onClick={onStop}
            aria-label="Stop agent"
          >
            Stop
          </button>
        </>
      );
    case "paused":
      return (
        <button
          type="button"
          class="nv2-btn-sm nv2-btn-primary"
          onClick={onPause}
          aria-label="Resume agent"
        >
          Resume
        </button>
      );
    case "queued":
      return (
        <button type="button" class="nv2-btn-sm" onClick={onStop} aria-label="Cancel queued agent">
          Cancel
        </button>
      );
    case "completed":
      return (
        <>
          <button
            type="button"
            class="nv2-btn-sm nv2-btn-primary"
            onClick={onViewResults}
            aria-label="View agent results"
          >
            View Results
          </button>
          <button type="button" class="nv2-btn-sm" onClick={onDismiss} aria-label="Dismiss agent">
            Dismiss
          </button>
        </>
      );
  }
}

function getAgentTimeDisplay(agent: ActiveAgent): { text: string; className: string } | null {
  if (agent.status === "completed" && agent.resultData?.stats?.durationMs) {
    return {
      text: `${(agent.resultData.stats.durationMs / 1000).toFixed(1)}s`,
      className: "nv2-agent-duration",
    };
  }
  if (agent.startedAt) {
    return {
      text: formatElapsed(Date.now() - agent.startedAt.getTime()),
      className: "nv2-agent-elapsed",
    };
  }
  return null;
}

function ActiveAgentCard({
  agent,
  onPause,
  onStop,
  onViewResults,
  onDismiss,
}: ActiveAgentCardProps) {
  const statusLabel = agent.status.charAt(0).toUpperCase() + agent.status.slice(1);
  const timeDisplay = getAgentTimeDisplay(agent);

  return (
    <article
      class={`nv2-agent-card nv2-agent-card--${agent.status}`}
      aria-label={`${formatAgentType(agent.type)} agent ${statusLabel}`}
    >
      <div class="nv2-agent-status-indicator">
        <AgentStatusIndicator status={agent.status} />
      </div>

      <div class="nv2-agent-body">
        <div class="nv2-agent-header">
          <span class="nv2-agent-type">{formatAgentType(agent.type)}</span>
          {agent.activeSkill && (
            <span class="nv2-agent-skill-badge" title={`Using Skill: ${agent.activeSkill}`}>
              <Icon name="zap" className="nv2-skill-icon" />
              {agent.activeSkill.length > 20
                ? `${agent.activeSkill.slice(0, 18)}...`
                : agent.activeSkill}
            </span>
          )}
          {timeDisplay && <span class={timeDisplay.className}>{timeDisplay.text}</span>}
        </div>

        <div class="nv2-agent-target" title={agent.targetNote}>
          {truncate(agent.targetNote, 28)}
        </div>

        {agent.status === "running" && agent.progress !== undefined && (
          <div class="nv2-agent-progress">
            <div class="nv2-progress-bar">
              {/* biome-ignore lint/a11y/useFocusableInteractive: progress bars are informational, not interactive */}
              <div
                class="nv2-progress-fill nv2-progress-fill--animated"
                style={{ width: `${agent.progress}%` }}
                role="progressbar"
                aria-valuenow={agent.progress}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <span class="nv2-agent-progress-text">{agent.progress}%</span>
          </div>
        )}

        {agent.status === "completed" && agent.resultData?.insightSummary && (
          <div class="nv2-agent-insight-preview">
            {truncate(agent.resultData.insightSummary, 60)}
          </div>
        )}

        <div class="nv2-agent-actions">
          <AgentActions
            status={agent.status}
            onPause={onPause}
            onStop={onStop}
            onViewResults={onViewResults}
            onDismiss={onDismiss}
          />
        </div>
      </div>
    </article>
  );
}

interface PendingActionCardProps {
  action: PendingAction;
  onApply?: () => void;
  onDismiss?: () => void;
}

const RISK_CONFIG = {
  high: { icon: "alert-triangle", label: "High Risk", className: "nv2-risk-high" },
  medium: { icon: "zap", label: "Medium Risk", className: "nv2-risk-medium" },
  low: { icon: "check", label: "Safe", className: "nv2-risk-low" },
};

function PendingActionCard({ action, onApply, onDismiss }: PendingActionCardProps) {
  const risk = RISK_CONFIG[action.riskLevel];

  return (
    <article
      class={`nv2-pending-card ${risk.className}`}
      aria-label={`${action.actionType}: ${action.summary}`}
    >
      <div class="nv2-pending-header">
        <span class="nv2-pending-risk" title={risk.label}>
          <Icon name={risk.icon} className="nv2-risk-icon" />
          <span class="nv2-risk-label">{risk.label}</span>
        </span>
      </div>

      <div class="nv2-pending-summary">{action.summary}</div>

      <div class="nv2-pending-target" title={action.targetNote}>
        <span class="nv2-pending-target-icon" aria-hidden="true">
          →
        </span>
        {truncate(action.targetNote, 30)}
      </div>

      <div class="nv2-pending-actions">
        <button
          type="button"
          class="nv2-btn-sm nv2-btn-primary"
          onClick={onApply}
          aria-label={`Apply: ${action.summary}`}
        >
          Apply
        </button>
        <button
          type="button"
          class="nv2-btn-sm"
          onClick={onDismiss}
          aria-label={`Dismiss: ${action.summary}`}
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}

interface RecentActivityCardProps {
  activity: RecentActivity;
  onUndo?: () => void;
}

const STATUS_CONFIG = {
  success: { icon: "check", label: "Completed", className: "nv2-activity--success" },
  failed: { icon: "x", label: "Failed", className: "nv2-activity--failed" },
  undone: { icon: "undo", label: "Undone", className: "nv2-activity--undone" },
};

function RecentActivityCard({ activity, onUndo }: RecentActivityCardProps) {
  const status = STATUS_CONFIG[activity.status];
  const timeAgo = formatTimeAgo(activity.completedAt);

  return (
    <article
      class={`nv2-activity-card ${status.className}`}
      aria-label={`${status.label}: ${activity.summary}`}
    >
      <div class="nv2-activity-main">
        <Icon
          name={status.icon}
          className={`nv2-activity-icon nv2-activity-icon--${activity.status}`}
        />
        <div class="nv2-activity-content">
          <span class="nv2-activity-summary">{activity.summary}</span>
          <span class="nv2-activity-meta">
            <span class="nv2-activity-target">{truncate(activity.targetNote, 20)}</span>
            <span class="nv2-activity-dot">·</span>
            <span class="nv2-activity-time">{timeAgo}</span>
          </span>
        </div>
        {activity.canUndo && activity.status === "success" && (
          <button
            type="button"
            class="nv2-btn-sm nv2-btn-undo"
            onClick={onUndo}
            aria-label={`Undo: ${activity.summary}`}
          >
            Undo
          </button>
        )}
      </div>
      {activity.error && (
        // biome-ignore lint/a11y/useSemanticElements: role="alert" is correct ARIA pattern for error messages
        <div class="nv2-activity-error" role="alert">
          {activity.error}
        </div>
      )}
    </article>
  );
}

// Helper functions
function formatAgentType(type: string): string {
  const labels: Record<string, string> = {
    enrich: "Enriching",
    link: "Linking",
    atomic: "Atomizing",
    synthesis: "Synthesizing",
    task: "Task",
    classify: "Classifying",
    chat: "Chatting",
  };
  return labels[type] || type;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}
