/**
 * InsightGenerator - Generate actionable hints from note vitals
 *
 * Extracted from sidebar.ts to separate business logic from view rendering.
 *
 * NOTE: This generates VitalsHint (UI hints for Note Vitals), NOT to be confused with
 * Insight (agent output container) in src/core/agentic/types.ts.
 * - VitalsHint: UI hints displayed in Note Vitals based on note health metrics
 * - Insight: Agent output container grouping actions, suggestions, and reasoning
 */

import type { NoteVitals } from "./noteVitalsCalculator";

/**
 * VitalsHint - UI hints displayed in Note Vitals panel
 * Based on note health metrics (connections, classification, index status)
 *
 * Not to be confused with Insight (agent output container) in src/core/agentic/types.ts
 */
export interface VitalsHint {
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
   * Generate vitals hints based on note health metrics
   */
  generate(noteVitals: NoteVitals | null): VitalsHint[] {
    if (!noteVitals) return [];

    const insights: VitalsHint[] = [];

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
