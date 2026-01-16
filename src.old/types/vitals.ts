/**
 * Vault Vitals types for health monitoring
 */

/** Main vault vitals data structure */
export interface VaultVitalsData {
  /** When vitals were computed */
  computedAt: number;

  /** Basic counts */
  counts: VaultCounts;

  /** Connectivity metrics */
  connectivity: ConnectivityMetrics;

  /** Processing status */
  processing: ProcessingStatus;

  /** PARA distribution */
  paraDistribution: ParaDistribution;
}

/** Basic vault counts */
export interface VaultCounts {
  /** Total markdown files */
  totalNotes: number;
  /** Notes in inbox */
  inboxSize: number;
  /** Notes without any links */
  orphanCount: number;
  /** Notes with most links (hubs) */
  hubCount: number;
  /** Total tags used */
  totalTags: number;
  /** Total internal links */
  totalLinks: number;
}

/** Connectivity metrics */
export interface ConnectivityMetrics {
  /** Average links per note */
  averageLinksPerNote: number;
  /** Notes with no incoming links */
  noIncomingLinks: number;
  /** Notes with no outgoing links */
  noOutgoingLinks: number;
  /** Most connected notes (top 5) */
  topConnectedNotes: ConnectedNote[];
}

export interface ConnectedNote {
  path: string;
  title: string;
  linkCount: number;
}

/** Processing status */
export interface ProcessingStatus {
  /** Notes fully indexed */
  indexedCount: number;
  /** Notes pending indexing */
  pendingCount: number;
  /** Notes with errors */
  errorCount: number;
  /** Last full index time */
  lastFullIndexAt: number | null;
  /** Index freshness percentage */
  freshness: number;
}

/** PARA distribution */
export interface ParaDistribution {
  inbox: number;
  projects: number;
  areas: number;
  resources: number;
  archive: number;
  unknown: number;
}

/** Health score components */
export interface HealthScore {
  /** Overall score 0-100 */
  overall: number;
  /** Connectivity score */
  connectivity: number;
  /** Freshness score */
  freshness: number;
  /** Organization score */
  organization: number;
  /** Processing score */
  processing: number;
}
