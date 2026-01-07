/**
 * InsightStream - Renders dynamic insights about current note
 *
 * Extracted from sidebar.ts for modularity.
 */

import { setIcon } from "obsidian";
import type { Insight } from "../../../services/insightGenerator";

export class InsightStream {
  constructor(
    private insights: Insight[],
    private openFile: (path: string) => void,
  ) {}

  render(container: HTMLElement): HTMLElement {
    const section = container.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Insight Stream" });

    const stream = section.createDiv({ cls: "nv2-insight-stream" });

    if (this.insights.length === 0) {
      this.renderEmptyState(stream);
      return section;
    }

    for (const insight of this.insights) {
      this.renderInsight(stream, insight);
    }

    return section;
  }

  private renderEmptyState(stream: HTMLElement): void {
    const empty = stream.createDiv({ cls: "nv2-empty-state" });
    empty.createDiv({
      cls: "nv2-empty-state-text",
      text: "Open a note to see insights.",
    });
  }

  private renderInsight(stream: HTMLElement, insight: Insight): void {
    const item = stream.createDiv({ cls: "nv2-insight" });
    item.createDiv({
      cls: `nv2-insight-dot ${insight.priority === "low" ? "nv2-insight-dot--secondary" : ""}`,
    });

    const content = item.createDiv({ cls: "nv2-insight-content" });

    // Parse text for links
    const textEl = content.createDiv({ cls: "nv2-insight-text" });
    if (insight.linkText) {
      const parts = insight.text.split(insight.linkText);
      textEl.createSpan({ text: parts[0] });
      const link = textEl.createEl("a", { text: insight.linkText });
      link.addEventListener("click", () => {
        if (insight.linkPath) this.openFile(insight.linkPath);
      });
      if (parts[1]) textEl.createSpan({ text: parts[1] });
    } else {
      textEl.setText(insight.text);
    }

    // Action button
    if (insight.action) {
      const actionBtn = content.createDiv({
        cls: `nv2-insight-action ${insight.actionPrimary ? "nv2-insight-action--primary" : ""}`,
      });
      if (insight.actionIcon) {
        const actionIcon = actionBtn.createSpan({ cls: "nv2-insight-action-icon" });
        setIcon(actionIcon, insight.actionIcon);
      }
      actionBtn.createSpan({ text: insight.action });
      actionBtn.addEventListener("click", () => {
        if (insight.actionCallback) insight.actionCallback();
      });
    }
  }
}
