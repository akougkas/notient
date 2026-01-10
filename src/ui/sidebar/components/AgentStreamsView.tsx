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
import { setIcon } from "obsidian";
import { useEffect, useRef } from "preact/hooks";
import type { AgentType } from "../../../core/agent/types";

// Icon component for Lucide icons in Preact
function Icon({ name, className }: { name: string; className?: string }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, name);
    }
  }, [name]);
  return <span ref={iconRef} class={className} aria-hidden="true" />;
}

/**
 * Capability status for the 3 core agents
 */
export interface CapabilityStatus {
  agent: AgentType;
  health: "healthy" | "degraded" | "offline";
  isActive: boolean;
  lastActivity?: Date;
}

export interface ActiveAgent {
  id: string;
  type: string;
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
 * Capability Cards - Shows status of the 3 core agents
 * Per PRD: Three capability cards: Semantic Search, Context Builder, Chat Assistant
 */
const CAPABILITY_CONFIG: Record<AgentType, { icon: string; label: string; description: string }> = {
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
    { agent: "search", health: "healthy", isActive: false },
    { agent: "context", health: "healthy", isActive: false },
    { agent: "chat", health: "healthy", isActive: false },
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

function ActiveAgentCard({ agent, onPause, onStop, onViewResults, onDismiss }: ActiveAgentCardProps) {
  const isRunning = agent.status === "running";
  const isPaused = agent.status === "paused";
  const isQueued = agent.status === "queued";
  const isCompleted = agent.status === "completed";

  const elapsed = agent.startedAt ? formatElapsed(Date.now() - agent.startedAt.getTime()) : "";
  const duration = agent.resultData?.stats?.durationMs
    ? `${(agent.resultData.stats.durationMs / 1000).toFixed(1)}s`
    : "";

  const statusLabel = isRunning ? "Running" : isPaused ? "Paused" : isQueued ? "Queued" : "Completed";

  return (
    <article
      class={`nv2-agent-card nv2-agent-card--${agent.status}`}
      role="article"
      aria-label={`${formatAgentType(agent.type)} agent ${statusLabel}`}
    >
      {/* Status Indicator */}
      <div class="nv2-agent-status-indicator">
        {isRunning && <span class="nv2-agent-spinner" aria-hidden="true" />}
        {isPaused && <Icon name="pause" className="nv2-agent-paused-icon" />}
        {isQueued && <Icon name="clock" className="nv2-agent-queued-icon" />}
        {isCompleted && <Icon name="check-circle" className="nv2-agent-completed-icon" />}
      </div>

      <div class="nv2-agent-body">
        <div class="nv2-agent-header">
          <span class="nv2-agent-type">{formatAgentType(agent.type)}</span>
          {isCompleted && duration ? (
            <span class="nv2-agent-duration">{duration}</span>
          ) : elapsed ? (
            <span class="nv2-agent-elapsed">{elapsed}</span>
          ) : null}
        </div>

        <div class="nv2-agent-target" title={agent.targetNote}>
          {truncate(agent.targetNote, 28)}
        </div>

        {/* Progress bar for running agents */}
        {isRunning && agent.progress !== undefined && (
          <div class="nv2-agent-progress">
            <div class="nv2-progress-bar">
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

        {/* Insight preview for completed agents */}
        {isCompleted && agent.resultData?.insightSummary && (
          <div class="nv2-agent-insight-preview">
            {truncate(agent.resultData.insightSummary, 60)}
          </div>
        )}

        {/* Action buttons */}
        <div class="nv2-agent-actions">
          {isRunning && (
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
          )}
          {isPaused && (
            <button
              type="button"
              class="nv2-btn-sm nv2-btn-primary"
              onClick={onPause}
              aria-label="Resume agent"
            >
              Resume
            </button>
          )}
          {isQueued && (
            <button
              type="button"
              class="nv2-btn-sm"
              onClick={onStop}
              aria-label="Cancel queued agent"
            >
              Cancel
            </button>
          )}
          {isCompleted && (
            <>
              <button
                type="button"
                class="nv2-btn-sm nv2-btn-primary"
                onClick={onViewResults}
                aria-label="View agent results"
              >
                View Results
              </button>
              <button
                type="button"
                class="nv2-btn-sm"
                onClick={onDismiss}
                aria-label="Dismiss agent"
              >
                Dismiss
              </button>
            </>
          )}
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
      role="article"
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
      role="article"
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

function formatTimeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return `${str.slice(0, len)}...`;
}
