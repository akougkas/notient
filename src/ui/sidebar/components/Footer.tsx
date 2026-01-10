/**
 * Footer Component - Locked Chrome with 3 Status Zones
 *
 * Per spec layout:
 * ┌─────────────────────┬─────────────────────┬─────────────────────┐
 * │ PROVIDERS           │ INDEX               │ AGENTS              │
 * ├─────────────────────┼─────────────────────┼─────────────────────┤
 * │ LM● Ollama●         │ 1,247 notes         │ 2 running           │
 * │ Qwen 2.5 32B        │ ● Synced 2m ago     │ 3 pending review    │
 * └─────────────────────┴─────────────────────┴─────────────────────┘
 */

import type { Signal } from "@preact/signals";
import type { SidebarView } from "./Header";

export interface ProviderStatus {
  lmstudio: { connected: boolean; model: string | null };
  ollama: { connected: boolean; model: string | null };
}

export interface IndexStatus {
  noteCount: number;
  lastSyncedAt: Date | null;
  isIndexing: boolean;
  indexingProgress?: number;
}

export interface AgentStatus {
  runningCount: number;
  pendingReviewCount: number;
}

interface FooterProps {
  providers: Signal<ProviderStatus>;
  index: Signal<IndexStatus>;
  agents: Signal<AgentStatus>;
  activeView: Signal<SidebarView>;
  isReady: boolean;
  onSettingsClick?: () => void;
}

export function Footer({ providers, index, agents, activeView, isReady, onSettingsClick }: FooterProps) {
  const { lmstudio, ollama } = providers.value;
  const { noteCount, isIndexing, indexingProgress, lastSyncedAt } = index.value;
  const { runningCount, pendingReviewCount } = agents.value;

  if (!isReady) {
    return (
      <footer class="nv2-footer" role="contentinfo">
        <div class="nv2-footer-initializing">
          <span class="nv2-footer-init-dot" />
          <span>Connecting to services...</span>
        </div>
      </footer>
    );
  }

  return (
    <footer class="nv2-footer nv2-footer--zones" role="contentinfo">
      {/* Zone 1: Providers */}
      <div
        class="nv2-footer-zone nv2-footer-zone--providers"
        role="status"
        aria-label="AI provider status"
      >
        <ProviderIndicator name="LM" connected={lmstudio.connected} model={lmstudio.model} />
        <ProviderIndicator name="Ollama" connected={ollama.connected} model={ollama.model} />
      </div>

      {/* Zone 2: Index */}
      <div class="nv2-footer-zone nv2-footer-zone--index" role="status" aria-label="Index status">
        {isIndexing ? (
          <div class="nv2-index-indexing">
            <span class="nv2-index-label">Indexing...</span>
            {indexingProgress !== undefined && (
              <div class="nv2-index-progress">
                <div class="nv2-progress-bar">
                  <div
                    class="nv2-progress-fill nv2-progress-fill--animated"
                    style={{ width: `${indexingProgress}%` }}
                  />
                </div>
                <span class="nv2-index-percent">{indexingProgress}%</span>
              </div>
            )}
          </div>
        ) : (
          <div class="nv2-index-ready">
            <span class="nv2-index-count">{formatNumber(noteCount)} notes</span>
            {lastSyncedAt && (
              <span class="nv2-index-sync">
                <span class="nv2-status-dot nv2-status-dot--healthy" />
                {formatTimeAgo(lastSyncedAt)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Zone 3: Agents */}
      <div class="nv2-footer-zone nv2-footer-zone--agents" role="status" aria-label="Agent status">
        <AgentIndicator
          running={runningCount}
          pending={pendingReviewCount}
          onPendingClick={() => (activeView.value = "agents")}
        />
      </div>

      {/* Zone 4: Settings */}
      {onSettingsClick && (
        <button
          type="button"
          class="nv2-footer-settings-btn"
          onClick={onSettingsClick}
          aria-label="Open Notient settings"
          title="Settings"
        >
          <SettingsIcon />
        </button>
      )}
    </footer>
  );
}

function SettingsIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

interface ProviderIndicatorProps {
  name: string;
  connected: boolean;
  model: string | null;
}

function ProviderIndicator({ name, connected, model }: ProviderIndicatorProps) {
  const statusClass = connected ? "nv2-status-dot--healthy" : "nv2-status-dot--error";
  const title = connected
    ? `${name}: Connected${model ? ` (${model})` : ""}`
    : `${name}: Disconnected`;

  return (
    <div class="nv2-provider-indicator" title={title}>
      <span class={`nv2-status-dot ${statusClass}`} />
      <span class="nv2-provider-name">{name}</span>
    </div>
  );
}

interface AgentIndicatorProps {
  running: number;
  pending: number;
  onPendingClick: () => void;
}

function AgentIndicator({ running, pending, onPendingClick }: AgentIndicatorProps) {
  const isActive = running > 0 || pending > 0;

  if (!isActive) {
    return <span class="nv2-agent-idle">Idle</span>;
  }

  return (
    <div class="nv2-agent-indicator">
      {running > 0 && (
        <span class="nv2-agent-running">
          <span class="nv2-agent-pulse" />
          {running} active
        </span>
      )}
      {pending > 0 && (
        <button
          type="button"
          class="nv2-agent-pending"
          onClick={onPendingClick}
          aria-label={`${pending} actions pending review`}
        >
          {pending} pending
        </button>
      )}
    </div>
  );
}

// Helper functions
function formatNumber(num: number): string {
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}k`;
  }
  return String(num);
}

function formatTimeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
