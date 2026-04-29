import type { Database } from "../db/database";
import { freshness } from "./freshness";
import type {
  ConnectivityTier,
  Maturity,
  VitalsConnectivityThresholds,
  VitalsSettings,
  VitalsSnapshot,
} from "./types";

export interface VitalsFacade {
  updateFrontmatter(path: string, patch: Record<string, unknown>): Promise<void>;
}

export interface VitalsServiceOptions {
  db: Database;
  now: () => number;
  settings: () => VitalsSettings;
  facade: VitalsFacade;
}

interface NoteRow {
  word_count: number;
  maturity: Maturity;
  updated_at: number;
}

interface CountRow {
  count: number;
}

// Health is a weighted average: sum(signal * weight) / sum(weights). With the default
// weights (1, 1, 1) this is a clean arithmetic mean of the three signals.
export class VitalsService {
  constructor(private readonly options: VitalsServiceOptions) {}

  computeSnapshot(notePath: string): VitalsSnapshot | null {
    const row = this.options.db.query<NoteRow>(
      "SELECT word_count, maturity, updated_at FROM notes WHERE path = ?;",
      [notePath],
    )[0];
    if (!row) return null;
    const settings = this.options.settings();
    const now = this.options.now();
    const fresh = freshness({
      updatedAt: row.updated_at,
      now,
      halfLifeDays: settings.freshnessHalfLifeDays,
    });
    const chunkRow = this.options.db.query<CountRow>(
      "SELECT COUNT(*) as count FROM chunks WHERE note_path = ?;",
      [notePath],
    )[0];
    const edgeRow = this.options.db.query<CountRow>(
      `SELECT COUNT(*) as count FROM graph_edges
       WHERE approved = 1 AND (source_id = ? OR target_id = ?);`,
      [`note:${notePath}`, `note:${notePath}`],
    )[0];
    const wordBand = saturating(row.word_count, 600);
    const chunkCoverage = chunkRow.count > 0 ? 1 : 0;
    const hasApprovedEdges = edgeRow.count > 0 ? 1 : 0;
    const totalWeight =
      settings.healthWeights.wordBand +
      settings.healthWeights.chunkCoverage +
      settings.healthWeights.hasApprovedEdges;
    const health =
      (wordBand * settings.healthWeights.wordBand +
        chunkCoverage * settings.healthWeights.chunkCoverage +
        hasApprovedEdges * settings.healthWeights.hasApprovedEdges) /
      Math.max(1, totalWeight);
    const tier = bucket(edgeRow.count, settings.connectivityThresholds);
    return {
      notePath,
      freshness: fresh,
      health,
      connectivityCount: edgeRow.count,
      connectivityTier: tier,
      maturity: row.maturity,
      wordCount: row.word_count,
      computedAt: now,
    };
  }

  async persistSnapshot(notePath: string): Promise<void> {
    const snapshot = this.computeSnapshot(notePath);
    if (!snapshot) return;
    this.options.db.run("UPDATE notes SET health = ?, freshness = ? WHERE path = ?;", [
      snapshot.health,
      snapshot.freshness,
      notePath,
    ]);
    await this.options.db.persist();
    if (this.options.settings().writeToFrontmatter) {
      await this.options.facade.updateFrontmatter(notePath, {
        notient: {
          health: round(snapshot.health, 3),
          freshness: round(snapshot.freshness, 3),
          connectivity: snapshot.connectivityCount,
          connectivityTier: snapshot.connectivityTier,
          maturity: snapshot.maturity,
        },
      });
    }
  }
}

// Smooth saturation curve: returns 0 at zero words, approaches 1 as words grow,
// crosses ~0.63 at the peak. Provides a non-binary word-count signal.
function saturating(words: number, peakAt: number): number {
  return 1 - Math.exp(-Math.max(0, words) / peakAt);
}

function bucket(count: number, thresholds: VitalsConnectivityThresholds): ConnectivityTier {
  if (count >= thresholds.hub) return "hub";
  if (count >= thresholds.connected) return "connected";
  if (count >= thresholds.sparse) return "sparse";
  return "isolated";
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
