import type { ConnectivityTier, Maturity } from "../vitals/types";

export type SearchMode = "quick" | "balanced" | "deep";

export interface SynthesisCitation {
  /** Inline wikilink token, e.g. `[[my note]]`. */
  wikilink: string;
}

export interface SynthesisBullet {
  text: string;
  citations: string[];
}

export interface SynthesisCard {
  bullets: SynthesisBullet[];
  rawText: string;
  /** Set when the synthesis call failed or returned an unusable body. */
  error?: string;
}

export interface SearchFilters {
  maturity?: Maturity[];
  agents?: string[];
  minConfidence?: number;
  folders?: string[];
  fromDate?: number;
  toDate?: number;
  connectivityTiers?: ConnectivityTier[];
  hasPendingProposals?: boolean;
}

export interface SearchQuery {
  query: string;
  mode: SearchMode;
  filters?: SearchFilters;
  limit?: number;
}

export interface SearchHit {
  notePath: string;
  chunkId: string | null;
  snippet: string;
  score: number;
  matchedText: string;
  vitalsTier?: ConnectivityTier;
  maturity?: Maturity;
  agentTags?: string[];
}

export interface SearchResult {
  query: string;
  mode: SearchMode;
  hits: SearchHit[];
  durationMs: number;
  /** Present only when Deep mode produced a grounded synthesis. */
  synthesis?: SynthesisCard | null;
}

export type SearchEvent =
  | { type: "search:retrieving"; mode: SearchMode }
  | { type: "search:hits"; hits: SearchHit[] }
  | { type: "search:expanding"; baseHitCount: number }
  | { type: "search:graph-expansion"; addedHitCount: number }
  | { type: "search:synthesizing" }
  | { type: "search:synthesis-token"; token: string }
  | { type: "search:synthesis-done"; card: SynthesisCard }
  | { type: "search:done"; result: SearchResult }
  | { type: "search:error"; message: string };
