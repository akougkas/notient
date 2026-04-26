export type ConnectivityTier = "isolated" | "sparse" | "connected" | "hub";

export type Maturity = "raw" | "draft" | "review" | "mature";

export interface VitalsSnapshot {
  notePath: string;
  freshness: number;
  health: number;
  connectivityCount: number;
  connectivityTier: ConnectivityTier;
  maturity: Maturity;
  wordCount: number;
  computedAt: number;
}

export interface VitalsHealthWeights {
  wordBand: number;
  chunkCoverage: number;
  hasApprovedEdges: number;
}

export interface VitalsConnectivityThresholds {
  sparse: number;
  connected: number;
  hub: number;
}

export interface VitalsSettings {
  freshnessHalfLifeDays: number;
  healthWeights: VitalsHealthWeights;
  connectivityThresholds: VitalsConnectivityThresholds;
  writeToFrontmatter: boolean;
}
