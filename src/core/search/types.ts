import type { ConnectivityTier, Maturity } from "../vitals/types";

export type SearchMode = "quick" | "balanced" | "deep";

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
}

export type SearchEvent =
  | { type: "search:retrieving"; mode: SearchMode }
  | { type: "search:hits"; hits: SearchHit[] }
  | { type: "search:expanding"; baseHitCount: number }
  | { type: "search:synthesizing" }
  | { type: "search:done"; result: SearchResult }
  | { type: "search:error"; message: string };
