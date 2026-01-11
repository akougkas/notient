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
  /** Trigger expert agent (shows in Agent Streams) */
  triggerAgent: (prompt: string, agentType: "note-editor" | "classifier" | "connection") => void;
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
        actionIcon: "search",
        actionCallback: () => {
          this.callbacks.triggerAgent(
            `Find notes that could be linked to "${noteVitals.title}" and explain the connections`,
            "connection",
          );
        },
        priority: "high",
      });
    } else if (noteVitals.links.backlinks > 0) {
      insights.push({
        text: `This note appears strongly related to other notes via ${noteVitals.links.backlinks} backlink${noteVitals.links.backlinks > 1 ? "s" : ""}.`,
        action: "Analyze Links",
        actionIcon: "link",
        actionCallback: () => {
          this.callbacks.triggerAgent(
            `Analyze the link structure of "${noteVitals.title}" and suggest improvements`,
            "connection",
          );
        },
        priority: "high",
      });
    }

    // Classification insight
    if (noteVitals.paraType === "inbox" || noteVitals.paraType === "unknown") {
      insights.push({
        text: `Suggested classification update: Move from #${noteVitals.paraType} to #active-projects based on recent edits.`,
        action: "Classify",
        actionIcon: "tag",
        actionPrimary: true,
        actionCallback: () => {
          this.callbacks.triggerAgent(
            `Classify "${noteVitals.title}" and suggest the best PARA category based on its content`,
            "classifier",
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
