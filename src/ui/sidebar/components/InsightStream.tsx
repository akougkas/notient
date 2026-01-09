/**
 * InsightStream - Preact component for dynamic insights
 *
 * Displays contextual insights about the current note with actions.
 */

import { setIcon } from "obsidian";
import { useCallback, useEffect, useRef } from "preact/hooks";
import type { Insight } from "../../../services/insightGenerator";

interface InsightStreamProps {
  insights: Insight[];
  onOpenFile: (path: string) => void;
}

export function InsightStream({ insights, onOpenFile }: InsightStreamProps) {
  return (
    <div class="nv2-section">
      <div class="nv2-section-label">Insight Stream</div>
      <div class="nv2-insight-stream">
        {insights.length === 0 ? (
          <EmptyState />
        ) : (
          insights.map((insight, index) => (
            <InsightItem key={index} insight={insight} onOpenFile={onOpenFile} />
          ))
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div class="nv2-empty-state">
      <div class="nv2-empty-state-text">Open a note to see insights.</div>
    </div>
  );
}

interface InsightItemProps {
  insight: Insight;
  onOpenFile: (path: string) => void;
}

function InsightItem({ insight, onOpenFile }: InsightItemProps) {
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

  return (
    <div class="nv2-insight">
      <div
        class={`nv2-insight-dot ${insight.priority === "low" ? "nv2-insight-dot--secondary" : ""}`}
      />
      <div class="nv2-insight-content">
        <InsightText
          text={insight.text}
          linkText={insight.linkText}
          onLinkClick={handleLinkClick}
        />
        {insight.action && (
          <InsightAction
            action={insight.action}
            icon={insight.actionIcon}
            primary={insight.actionPrimary}
            onClick={handleActionClick}
          />
        )}
      </div>
    </div>
  );
}

interface InsightTextProps {
  text: string;
  linkText?: string;
  onLinkClick: () => void;
}

function InsightText({ text, linkText, onLinkClick }: InsightTextProps) {
  if (!linkText) {
    return <div class="nv2-insight-text">{text}</div>;
  }

  const parts = text.split(linkText);
  return (
    <div class="nv2-insight-text">
      <span>{parts[0]}</span>
      <a onClick={onLinkClick}>{linkText}</a>
      {parts[1] && <span>{parts[1]}</span>}
    </div>
  );
}

interface InsightActionProps {
  action: string;
  icon?: string;
  primary?: boolean;
  onClick: () => void;
}

function InsightAction({ action, icon, primary, onClick }: InsightActionProps) {
  const iconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (iconRef.current && icon) {
      setIcon(iconRef.current, icon);
    }
  }, [icon]);

  return (
    <div
      class={`nv2-insight-action ${primary ? "nv2-insight-action--primary" : ""}`}
      onClick={onClick}
    >
      {icon && <span class="nv2-insight-action-icon" ref={iconRef} />}
      <span>{action}</span>
    </div>
  );
}
