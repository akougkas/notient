/**
 * Activity Trail
 *
 * Shows a breadcrumb trail of actions during chat response generation.
 * Displays phases: Building context → Thinking → Generating → Complete
 */

import { useEffect, useRef } from "preact/hooks";
import type { ActivityPhase } from "../../../../core/chat/types";
import { Icon } from "../Icon";

export interface ActivityItem {
  id: string;
  message: string;
  phase: ActivityPhase;
  timestamp: Date;
}

interface ActivityTrailProps {
  /** Activity items to display */
  activities: ActivityItem[];
  /** Whether currently streaming */
  isStreaming?: boolean;
  /** Maximum items to show */
  maxItems?: number;
}

/**
 * Get icon for activity phase
 */
function getPhaseIcon(phase: ActivityPhase): string {
  switch (phase) {
    case "context":
      return "file-search";
    case "thinking":
      return "brain";
    case "generating":
      return "pencil";
    case "delegation":
      return "git-branch";
    case "complete":
      return "check";
    default:
      return "activity";
  }
}

/**
 * Get CSS class for phase
 */
function getPhaseClass(phase: ActivityPhase): string {
  return `nv2-activity-item--${phase}`;
}

export function ActivityTrail({
  activities,
  isStreaming = false,
  maxItems = 4,
}: ActivityTrailProps) {
  const trailRef = useRef<HTMLOutputElement>(null);

  // Auto-scroll to latest activity
  // biome-ignore lint/correctness/useExhaustiveDependencies: activities triggers scroll when changed
  useEffect(() => {
    if (trailRef.current) {
      trailRef.current.scrollLeft = trailRef.current.scrollWidth;
    }
  }, [activities.length]);

  if (activities.length === 0) return null;

  // Show only recent activities
  const visibleActivities = activities.slice(-maxItems);

  return (
    <output class="nv2-activity-trail" ref={trailRef} aria-live="polite">
      {visibleActivities.map((activity, index) => {
        const isLast = index === visibleActivities.length - 1;
        const isActive = isLast && isStreaming && activity.phase !== "complete";

        return (
          <div
            key={activity.id}
            class={`nv2-activity-item ${getPhaseClass(activity.phase)} ${isActive ? "nv2-activity-item--active" : ""}`}
          >
            <span class="nv2-activity-icon-wrapper">
              {isActive ? (
                <span class="nv2-activity-spinner" />
              ) : (
                <Icon name={getPhaseIcon(activity.phase)} className="nv2-activity-icon" />
              )}
            </span>
            <span class="nv2-activity-message">{activity.message}</span>
            {index < visibleActivities.length - 1 && (
              <Icon name="chevron-right" className="nv2-activity-separator" />
            )}
          </div>
        );
      })}
    </output>
  );
}

/**
 * Compact activity indicator for inline use
 */
export function ActivityIndicator({ message, phase }: { message: string; phase: ActivityPhase }) {
  return (
    <div class={`nv2-activity-indicator ${getPhaseClass(phase)}`}>
      <span class="nv2-activity-spinner" />
      <span class="nv2-activity-text">{message}</span>
    </div>
  );
}

/**
 * Create activity item helper
 */
export function createActivityItem(message: string, phase: ActivityPhase): ActivityItem {
  return {
    id: crypto.randomUUID(),
    message,
    phase,
    timestamp: new Date(),
  };
}
