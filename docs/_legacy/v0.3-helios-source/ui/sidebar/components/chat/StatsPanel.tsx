/**
 * Stats Panel
 *
 * Full developer mode statistics panel for chat responses.
 * Shows response time, token counts, tokens/sec, context usage, and model info.
 */

import { useState } from "preact/hooks";
import type { ChatStatistics } from "../../../../core/chat/types";
import { Icon } from "../Icon";

interface StatsPanelProps {
  /** Statistics data */
  statistics: ChatStatistics;
  /** Whether panel is visible */
  visible?: boolean;
  /** Position: inline after message or floating */
  position?: "inline" | "floating";
}

/**
 * Format milliseconds to human readable
 */
function formatTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Format number with K/M suffix
 */
function formatNumber(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
}

/**
 * Calculate context usage percentage
 */
function getContextUsagePercent(used: number, max: number): number {
  if (max === 0) return 0;
  return Math.round((used / max) * 100);
}

export function StatsPanel({ statistics, visible = true, position = "inline" }: StatsPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!visible) return null;

  const contextPercent = getContextUsagePercent(
    statistics.contextWindowUsed,
    statistics.contextWindowMax,
  );

  const compactView = (
    <button
      type="button"
      class="nv2-stats-compact"
      onClick={() => setIsExpanded(!isExpanded)}
      aria-expanded={isExpanded}
      title="Click for detailed statistics"
    >
      <span class="nv2-stats-item">
        <Icon name="clock" className="nv2-stats-icon" />
        {formatTime(statistics.responseTimeMs)}
      </span>
      <span class="nv2-stats-separator">•</span>
      <span class="nv2-stats-item">
        <Icon name="hash" className="nv2-stats-icon" />
        {formatNumber(statistics.tokenCount)} tok
      </span>
      <span class="nv2-stats-separator">•</span>
      <span class="nv2-stats-item">
        <Icon name="zap" className="nv2-stats-icon" />
        {statistics.tokensPerSecond.toFixed(1)} t/s
      </span>
      <Icon name={isExpanded ? "chevron-up" : "chevron-down"} className="nv2-stats-expand-icon" />
    </button>
  );

  const expandedView = isExpanded && (
    <div class="nv2-stats-expanded">
      <div class="nv2-stats-grid">
        {/* Timing Section */}
        <div class="nv2-stats-section">
          <div class="nv2-stats-section-title">Timing</div>
          <div class="nv2-stats-row">
            <span class="nv2-stats-label">Total Response</span>
            <span class="nv2-stats-value">{formatTime(statistics.responseTimeMs)}</span>
          </div>
          {statistics.thinkingTimeMs > 0 && (
            <div class="nv2-stats-row">
              <span class="nv2-stats-label">Thinking</span>
              <span class="nv2-stats-value">{formatTime(statistics.thinkingTimeMs)}</span>
            </div>
          )}
          <div class="nv2-stats-row">
            <span class="nv2-stats-label">Generation</span>
            <span class="nv2-stats-value">{formatTime(statistics.generationTimeMs)}</span>
          </div>
        </div>

        {/* Tokens Section */}
        <div class="nv2-stats-section">
          <div class="nv2-stats-section-title">Tokens</div>
          <div class="nv2-stats-row">
            <span class="nv2-stats-label">Total Output</span>
            <span class="nv2-stats-value">{formatNumber(statistics.tokenCount)}</span>
          </div>
          {statistics.thinkingTokenCount > 0 && (
            <div class="nv2-stats-row">
              <span class="nv2-stats-label">Thinking Tokens</span>
              <span class="nv2-stats-value">{formatNumber(statistics.thinkingTokenCount)}</span>
            </div>
          )}
          <div class="nv2-stats-row">
            <span class="nv2-stats-label">Speed</span>
            <span class="nv2-stats-value">{statistics.tokensPerSecond.toFixed(1)} tok/s</span>
          </div>
        </div>

        {/* Context Section */}
        <div class="nv2-stats-section">
          <div class="nv2-stats-section-title">Context Window</div>
          <div class="nv2-stats-row">
            <span class="nv2-stats-label">Used</span>
            <span class="nv2-stats-value">{formatNumber(statistics.contextWindowUsed)} chars</span>
          </div>
          <div class="nv2-stats-row">
            <span class="nv2-stats-label">Max</span>
            <span class="nv2-stats-value">{formatNumber(statistics.contextWindowMax)}</span>
          </div>
          <div class="nv2-stats-row">
            <span class="nv2-stats-label">Usage</span>
            <div class="nv2-stats-progress-container">
              <div
                class={`nv2-stats-progress-bar ${contextPercent > 80 ? "nv2-stats-progress-bar--warning" : ""}`}
                style={{ width: `${Math.min(contextPercent, 100)}%` }}
              />
              <span class="nv2-stats-progress-label">{contextPercent}%</span>
            </div>
          </div>
        </div>

        {/* Model Section */}
        <div class="nv2-stats-section">
          <div class="nv2-stats-section-title">Model</div>
          <div class="nv2-stats-row">
            <span class="nv2-stats-label">Name</span>
            <span
              class="nv2-stats-value nv2-stats-model-name"
              title={String(statistics.modelName || "Unknown")}
            >
              {truncateModelName(statistics.modelName)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div class={`nv2-stats-panel nv2-stats-panel--${position}`}>
      {compactView}
      {expandedView}
    </div>
  );
}

/**
 * Truncate long model names for display
 */
function truncateModelName(name: unknown): string {
  // Defensive: handle non-string values
  if (typeof name !== "string" || !name) return "Unknown";
  if (name.length <= 24) return name;
  // Try to show the model name part, not the path
  const parts = name.split("/");
  const modelPart = parts[parts.length - 1];
  if (modelPart.length <= 24) return modelPart;
  return `${modelPart.slice(0, 21)}...`;
}

/**
 * Mini stats for inline display (just time and tokens)
 */
export function MiniStats({ statistics }: { statistics: ChatStatistics }) {
  return (
    <span class="nv2-stats-mini">
      <span class="nv2-stats-mini-item">{formatTime(statistics.responseTimeMs)}</span>
      <span class="nv2-stats-mini-separator">•</span>
      <span class="nv2-stats-mini-item">{formatNumber(statistics.tokenCount)} tokens</span>
    </span>
  );
}
