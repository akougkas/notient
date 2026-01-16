/**
 * InsightStream - AI Insights section (Section 4 of Note Vitals)
 *
 * Per spec: Rolling stream of AI-generated observations and suggestions
 * with priority levels (high, medium, low) and inline actions.
 *
 * Displays both:
 * - Heuristic hints (VitalsHint[] from InsightGenerator)
 * - Agentic insights (from insight:created events)
 */

import { useCallback, useMemo, useState } from "preact/hooks";
import type { Insight } from "../../../core/agentic/types";
import type { VitalsHint } from "../../../services/insightGenerator";
import { useEventBus } from "../context/KernelContext";
import { activeView } from "../state";
import { Icon } from "./Icon";

interface InsightStreamProps {
  insights: VitalsHint[];
  onOpenFile: (path: string) => void;
}

/** Extended priority type for display - includes medium for agentic insights */
type DisplayPriority = "high" | "medium" | "low";

/** Display insight format - extends VitalsHint with agentic flag and medium priority */
interface DisplayInsight {
  text: string;
  linkText?: string;
  linkPath?: string;
  action?: string;
  actionIcon?: string;
  actionPrimary?: boolean;
  actionCallback?: () => void;
  priority: DisplayPriority;
  isAgentic: boolean;
}

/** Agentic insight converted to display format */
interface AgenticInsight {
  id: string;
  text: string;
  priority: DisplayPriority;
  agentType: string;
  actionCount: number;
  suggestionCount: number;
  timestamp: number;
}

// Priority icons and labels
const PRIORITY_CONFIG = {
  high: { icon: "●", label: "High Priority", className: "nv2-insight--high" },
  medium: { icon: "◐", label: "Suggestion", className: "nv2-insight--medium" },
  low: { icon: "○", label: "Info", className: "nv2-insight--low" },
};

/** Maximum agentic insights to keep in stream */
const MAX_AGENTIC_INSIGHTS = 10;

export function InsightStream({ insights, onOpenFile }: InsightStreamProps) {
  // Local state for agentic insights from insight:created events
  const [agenticInsights, setAgenticInsights] = useState<AgenticInsight[]>([]);

  // Subscribe to insight:created events
  useEventBus(
    "insight:created",
    useCallback((data: { insight: Insight; source: string }) => {
      const { insight } = data;

      // Convert Insight to display format
      const agenticInsight: AgenticInsight = {
        id: insight.id,
        text: insight.summary,
        priority: insight.actions.length > 0 ? "high" : "medium",
        agentType: insight.agentType,
        actionCount: insight.actions.length,
        suggestionCount: insight.suggestions.length,
        timestamp: insight.timestamp,
      };

      setAgenticInsights((prev) => {
        // Avoid duplicates
        if (prev.some((i) => i.id === agenticInsight.id)) {
          return prev;
        }
        // Keep most recent at top, limit total
        return [agenticInsight, ...prev].slice(0, MAX_AGENTIC_INSIGHTS);
      });
    }, []),
  );

  // Merge heuristic hints with agentic insights for display
  const allInsights = useMemo((): DisplayInsight[] => {
    // Convert agentic insights to DisplayInsight format
    const agenticHints: DisplayInsight[] = agenticInsights.map((ai) => ({
      text: ai.text,
      priority: ai.priority,
      action:
        ai.actionCount > 0
          ? `Review ${ai.actionCount} action${ai.actionCount > 1 ? "s" : ""}`
          : undefined,
      actionIcon: "bot",
      actionCallback:
        ai.actionCount > 0
          ? () => {
              activeView.value = "agents";
            }
          : undefined,
      isAgentic: true,
    }));

    // Heuristic hints converted to DisplayInsight format
    const heuristicHints: DisplayInsight[] = insights.map((h) => ({
      ...h,
      priority: h.priority as DisplayPriority, // VitalsHint only has high/low, safe cast
      isAgentic: false,
    }));

    // Combine: agentic first (they're more recent/actionable), then heuristic
    return [...agenticHints, ...heuristicHints];
  }, [agenticInsights, insights]);

  // Sort by priority
  const sortedInsights = useMemo(() => {
    return [...allInsights].sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.priority] || 2) - (order[b.priority] || 2);
    });
  }, [allInsights]);

  const highPriorityCount = allInsights.filter((i) => i.priority === "high").length;
  const agenticCount = agenticInsights.length;

  return (
    <section class="nv2-insight-section" aria-label="AI Insights">
      <h3 class="nv2-section-label">
        AI Insights
        {highPriorityCount > 0 && <span class="nv2-insight-badge">{highPriorityCount}</span>}
        {agenticCount > 0 && (
          <span class="nv2-insight-badge nv2-insight-badge--agentic" title="From agents">
            {agenticCount}
          </span>
        )}
      </h3>
      {/* biome-ignore lint/a11y/useSemanticElements: role="feed" is correct ARIA pattern for dynamic content streams */}
      <div class="nv2-insight-stream" role="feed" aria-busy="false">
        {sortedInsights.length === 0 ? (
          <InsightEmptyState />
        ) : (
          sortedInsights.map((insight, index) => (
            <InsightItem
              key={`insight-${insight.text.slice(0, 20)}-${index}`}
              insight={insight}
              onOpenFile={onOpenFile}
              isFirst={index === 0}
            />
          ))
        )}
      </div>
    </section>
  );
}

function InsightEmptyState() {
  return (
    <div class="nv2-insight-empty">
      <Icon name="lightbulb" className="nv2-insight-empty-icon" />
      <span class="nv2-insight-empty-text">
        AI insights will appear here as Notient analyzes your note.
      </span>
    </div>
  );
}

interface InsightItemProps {
  insight: DisplayInsight;
  onOpenFile: (path: string) => void;
  isFirst?: boolean;
}

function InsightItem({ insight, onOpenFile, isFirst }: InsightItemProps) {
  const priority = insight.priority || "low";
  const config = PRIORITY_CONFIG[priority];
  const isAgentic = insight.isAgentic;

  const handleLinkClick = useCallback(() => {
    if (insight.linkPath) {
      onOpenFile(insight.linkPath);
    }
  }, [insight.linkPath, onOpenFile]);

  const handleActionClick = useCallback(() => {
    if (insight.actionCallback) {
      insight.actionCallback();
    }
  }, [insight.actionCallback]);

  const classNames = [
    "nv2-insight",
    config.className,
    isFirst ? "nv2-insight--featured" : "",
    isAgentic ? "nv2-insight--agentic" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      class={classNames}
      aria-label={`${isAgentic ? "Agent: " : ""}${config.label}: ${insight.text}`}
    >
      <div class="nv2-insight-indicator" title={isAgentic ? "Agent insight" : config.label}>
        <span class="nv2-insight-dot" aria-hidden="true">
          {isAgentic ? "◆" : config.icon}
        </span>
      </div>
      <div class="nv2-insight-body">
        <InsightText
          text={insight.text}
          linkText={insight.linkText}
          onLinkClick={handleLinkClick}
        />
        {insight.action && (
          <InsightAction
            action={insight.action}
            icon={insight.actionIcon}
            primary={insight.actionPrimary || priority === "high"}
            onClick={handleActionClick}
          />
        )}
      </div>
    </article>
  );
}

interface InsightTextProps {
  text: string;
  linkText?: string;
  onLinkClick: () => void;
}

function InsightText({ text, linkText, onLinkClick }: InsightTextProps) {
  if (!linkText) {
    return <p class="nv2-insight-text">{text}</p>;
  }

  const parts = text.split(linkText);
  return (
    <p class="nv2-insight-text">
      {parts[0]}
      <button type="button" class="nv2-insight-link" onClick={onLinkClick}>
        {linkText}
      </button>
      {parts[1]}
    </p>
  );
}

interface InsightActionProps {
  action: string;
  icon?: string;
  primary?: boolean;
  onClick: () => void;
}

function InsightAction({ action, icon, primary, onClick }: InsightActionProps) {
  return (
    <button
      type="button"
      class={`nv2-insight-action ${primary ? "nv2-insight-action--primary" : ""}`}
      onClick={onClick}
      aria-label={action}
    >
      {icon && <Icon name={icon} className="nv2-insight-action-icon" />}
      <span>{action}</span>
    </button>
  );
}
