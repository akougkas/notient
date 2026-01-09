/**
 * PulseTimeline - Note Heartbeat Visualization
 *
 * A compact horizontal timeline showing the note's "life story":
 * - When it was created (diamond marker)
 * - When it was last modified (pulse dot)
 * - Visual representation of the note's age and activity
 *
 * Reinforces the "Sentient Note" philosophy - notes have a visible life.
 */

import { setIcon } from "obsidian";
import { useEffect, useRef, useMemo } from "preact/hooks";

interface PulseTimelineProps {
  /** When the note was created */
  createdAt: Date;
  /** When the note was last modified */
  modifiedAt: Date;
  /** Total links (backlinks + outlinks) for activity indicator */
  totalLinks: number;
  /** Whether the note has been indexed/enriched by AI */
  isIndexed: boolean;
  /** Health status for color theming */
  healthStatus: "healthy" | "attention" | "unhealthy";
}

/**
 * Format a date for tooltip display
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

/**
 * Format relative time (e.g., "3d ago", "2mo ago")
 */
function formatRelative(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Calculate the position percentage on the timeline
 * Uses a logarithmic scale for better visualization of recent activity
 */
function calculatePosition(date: Date, createdAt: Date): number {
  const now = Date.now();
  const created = createdAt.getTime();
  const target = date.getTime();

  // If same day as creation, place near start
  if (target - created < 1000 * 60 * 60 * 24) return 5;

  const totalSpan = now - created;
  if (totalSpan <= 0) return 95;

  // Linear position, clamped between 5% and 95%
  const linearPos = ((target - created) / totalSpan) * 90 + 5;
  return Math.min(95, Math.max(5, linearPos));
}

export function PulseTimeline({
  createdAt,
  modifiedAt,
  totalLinks,
  isIndexed,
  healthStatus,
}: PulseTimelineProps) {
  const sparkleRef = useRef<HTMLSpanElement>(null);

  // Calculate positions
  const modifiedPos = useMemo(
    () => calculatePosition(modifiedAt, createdAt),
    [modifiedAt, createdAt]
  );

  // Determine activity level for visual intensity
  const activityLevel = useMemo(() => {
    if (totalLinks > 10) return "high";
    if (totalLinks > 3) return "medium";
    return "low";
  }, [totalLinks]);

  // Calculate days since last activity
  const daysSinceModified = useMemo(() => {
    return Math.floor((Date.now() - modifiedAt.getTime()) / (1000 * 60 * 60 * 24));
  }, [modifiedAt]);

  // Set sparkle icon for AI enrichment
  useEffect(() => {
    if (sparkleRef.current && isIndexed) {
      setIcon(sparkleRef.current, "sparkles");
    }
  }, [isIndexed]);

  // Determine if note is "dormant" (no activity in 30+ days)
  const isDormant = daysSinceModified > 30;

  return (
    <div
      class={`nv2-pulse-timeline nv2-pulse-timeline--${healthStatus} ${isDormant ? "nv2-pulse-timeline--dormant" : ""}`}
      role="img"
      aria-label={`Note created ${formatRelative(createdAt)}, last edited ${formatRelative(modifiedAt)}`}
    >
      {/* Timeline track */}
      <div class="nv2-pulse-track">
        {/* Activity gradient fill based on link density */}
        <div
          class={`nv2-pulse-activity nv2-pulse-activity--${activityLevel}`}
          style={{ width: `${modifiedPos}%` }}
        />
      </div>

      {/* Creation marker (diamond) */}
      <div
        class="nv2-pulse-marker nv2-pulse-marker--created"
        style={{ left: "0%" }}
        title={`Created ${formatDate(createdAt)}`}
      >
        <span class="nv2-pulse-diamond" />
      </div>

      {/* Last modified marker (pulsing dot) */}
      <div
        class={`nv2-pulse-marker nv2-pulse-marker--modified ${isDormant ? "" : "nv2-pulse-marker--active"}`}
        style={{ left: `${modifiedPos}%` }}
        title={`Last edited ${formatDate(modifiedAt)} (${formatRelative(modifiedAt)})`}
      >
        <span class="nv2-pulse-dot" />
        {!isDormant && <span class="nv2-pulse-ring" />}
      </div>

      {/* AI enrichment sparkle (if indexed) */}
      {isIndexed && (
        <div
          class="nv2-pulse-marker nv2-pulse-marker--ai"
          style={{ left: `${Math.min(modifiedPos + 5, 92)}%` }}
          title="AI indexed"
        >
          <span ref={sparkleRef} class="nv2-pulse-sparkle" />
        </div>
      )}

      {/* Today marker */}
      <div
        class="nv2-pulse-marker nv2-pulse-marker--today"
        style={{ left: "100%" }}
        title="Today"
      >
        <span class="nv2-pulse-now" />
      </div>

      {/* Labels */}
      <div class="nv2-pulse-labels">
        <span class="nv2-pulse-label nv2-pulse-label--start">
          {formatRelative(createdAt)}
        </span>
        <span class="nv2-pulse-label nv2-pulse-label--end">now</span>
      </div>
    </div>
  );
}
