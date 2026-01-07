/**
 * InsightGenerator - Generate actionable insights from note vitals
 *
 * Extracted from sidebar.ts to separate business logic from view rendering.
 */

import type { NoteVitals } from "./noteVitalsCalculator";

export interface Insight {
  text: string;
  linkText?: string;
  linkPath?: string;
  action?: string;
  actionIcon?: string;
  actionPrimary?: boolean;
  actionCallback?: () => void;
  priority: "high" | "low";
}

export interface InsightGeneratorCallbacks {
  prefillChatAndSwitch: (prompt: string) => void;
  onMetricClick: (metric: "health" | "links" | "freshness") => void;
  showNotice: (message: string) => void;
}

export class InsightGenerator {
  constructor(private callbacks: InsightGeneratorCallbacks) {}

  /**
   * Generate insights based on note vitals
   */
  generate(noteVitals: NoteVitals | null): Insight[] {
    if (!noteVitals) return [];

    const insights: Insight[] = [];

    // Insight about connections
    if (noteVitals.links.backlinks === 0 && noteVitals.links.outlinks === 0) {
      insights.push({
        text: "This note has no connections. Consider linking it to related notes.",
        action: "Find Connections",
        actionIcon: "eye",
        actionCallback: () => {
          this.callbacks.prefillChatAndSwitch(
            `Find notes that could be linked to "${noteVitals.title}"`,
          );
        },
        priority: "high",
      });
    } else if (noteVitals.links.backlinks > 0) {
      insights.push({
        text: `This note appears strongly related to other notes via ${noteVitals.links.backlinks} backlink${noteVitals.links.backlinks > 1 ? "s" : ""}.`,
        action: "Review Links",
        actionIcon: "eye",
        actionCallback: () => this.callbacks.onMetricClick("links"),
        priority: "high",
      });
    }

    // Classification insight
    if (noteVitals.paraType === "inbox" || noteVitals.paraType === "unknown") {
      insights.push({
        text: `Suggested classification update: Move from #${noteVitals.paraType} to #active-projects based on recent edits.`,
        action: "Apply Change",
        actionIcon: "check",
        actionPrimary: true,
        actionCallback: () => {
          this.callbacks.prefillChatAndSwitch(
            `Suggest the best PARA category for "${noteVitals.title}" and help me organize it`,
          );
        },
        priority: "low",
      });
    }

    // Index status insight
    if (!noteVitals.isIndexed) {
      insights.push({
        text: "This note is not yet indexed for semantic search.",
        action: "Index Now",
        actionIcon: "database",
        actionCallback: () => {
          this.callbacks.showNotice("Indexing will happen on next sync");
        },
        priority: "low",
      });
    }

    return insights;
  }
}
