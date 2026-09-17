export type ConceptKind =
  | "proper_noun"
  | "system"
  | "technique"
  | "metric"
  | "quantity"
  | "event"
  | "other";

export type ConceptSource = "extractor" | "user" | "linker";

export type ClaimKind = "definition" | "assertion" | "datum" | "speculation";

export interface Chunk {
  id: string;
  notePath: string;
  ord: number;
  text: string;
  sha: string;
  tokenEstimate: number;
}

/**
 * Per-item chunk evidence, keyed by the item's own text (entity label, claim
 * text, question text) and valued with the ids of the chunks that support it.
 * Populated by the windowed extractor from the model's `chunkRefs`; the
 * persistence layer turns the ids into `record<chunk>` links on the
 * `mentions` / `asserts` / `asks` edges.
 */
export type EvidenceMap = Record<string, string[]>;

export interface ExtractionStats {
  /** Structured-output calls issued for this note. */
  llmCalls: number;
  /** Windows the note's chunks were packed into. */
  windows: number;
}

export interface Extraction {
  entities: string[];
  claims: string[];
  questions: string[];
  entityKinds?: Record<string, ConceptKind>;
  claimKinds?: Record<string, ClaimKind>;
  entityEvidence?: EvidenceMap;
  claimEvidence?: EvidenceMap;
  questionEvidence?: EvidenceMap;
  stats?: ExtractionStats;
}

export interface IndexResult {
  notePath: string;
  noteSha: string;
  chunkCount: number;
  embedCount: number;
  durationMs: number;
  /** Tier 3 structured-output calls issued for this note (0 when Tier 3 did not run). */
  llmCalls: number;
  /** Tier 3 extraction windows the note's chunks were packed into. */
  extractionWindows: number;
}
