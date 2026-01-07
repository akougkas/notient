/**
 * Phase 3: Intelligence types
 *
 * Persisted "note intelligence memory" derived from note content.
 * Stored locally under the plugin folder (model-key scoped).
 */

export interface IntelligenceHealthBreakdown {
  freshness: number; // 0-100
  connectivity: number; // 0-100
  structure: number; // 0-100
  metadata: number; // 0-100
}

export interface IntelligenceHealth {
  score: number; // 0-100
  breakdown: IntelligenceHealthBreakdown;
  computedAt: number;
}

export interface IntelligenceSummaryStructured {
  keyPoints: string[];
  purpose: string | null;
}

export interface IntelligenceEntity {
  name: string;
  type: "person" | "project" | "tool" | "concept" | "org" | "other";
  context?: string;
}

export interface IntelligenceSuggestedTag {
  tag: string;
  confidence: number;
  reason: string;
}

export interface IntelligenceSuggestedLink {
  path: string;
  title: string;
  reason: string;
  confidence: number;
}

export interface IntelligenceTriageAction {
  type: "move" | "tag" | "status" | "metadata";
  target?: string; // e.g. folder path or tag name
  reason: string;
  confidence: number;
}

export interface IntelligenceRecord {
  noteId: string;
  path: string;
  mtimeMs: number;
  contentHash: string;
  modelKey: string;
  generatedAt: number;

  summaryShort: string | null;
  summaryStructured: IntelligenceSummaryStructured | null;

  entities: IntelligenceEntity[];
  suggestedTags: IntelligenceSuggestedTag[];
  suggestedLinks: IntelligenceSuggestedLink[];
  triageAction: IntelligenceTriageAction | null;

  health: IntelligenceHealth | null;
}

export interface IntelligenceFile {
  version: number;
  modelKey: string;
  createdAt: number;
  updatedAt: number;
  records: Record<string, IntelligenceRecord>;
}
