import type { Surreal } from "surrealdb";
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
  db: Surreal;
  now: () => number;
  settings: () => VitalsSettings;
  facade: VitalsFacade;
}

interface NoteRow {
  word_count: number;
  maturity: Maturity | null;
  updated_at: number | null;
}

// Health is a weighted average: sum(signal * weight) / sum(weights). With the default
// weights (1, 1, 1) this is a clean arithmetic mean of the three signals.
export class VitalsService {
  constructor(private readonly options: VitalsServiceOptions) {}

  async computeSnapshot(notePath: string): Promise<VitalsSnapshot | null> {
    const row = await this.fetchNoteRow(notePath);
    if (row === null) return null;
    const settings = this.options.settings();
    const now = this.options.now();
    const fresh = freshness({
      updatedAt: row.updated_at ?? now,
      now,
      halfLifeDays: settings.freshnessHalfLifeDays,
    });
    const chunkCount = await this.fetchChunkCount(notePath);
    const edgeCount = await this.fetchEdgeCount(notePath);
    const wordBand = saturating(row.word_count, 600);
    const chunkCoverage = chunkCount > 0 ? 1 : 0;
    const hasApprovedEdges = edgeCount > 0 ? 1 : 0;
    const totalWeight =
      settings.healthWeights.wordBand +
      settings.healthWeights.chunkCoverage +
      settings.healthWeights.hasApprovedEdges;
    const health =
      (wordBand * settings.healthWeights.wordBand +
        chunkCoverage * settings.healthWeights.chunkCoverage +
        hasApprovedEdges * settings.healthWeights.hasApprovedEdges) /
      Math.max(1, totalWeight);
    const tier = bucket(edgeCount, settings.connectivityThresholds);
    return {
      notePath,
      freshness: fresh,
      health,
      connectivityCount: edgeCount,
      connectivityTier: tier,
      maturity: row.maturity ?? "raw",
      wordCount: row.word_count,
      computedAt: now,
    };
  }

  async persistSnapshot(notePath: string): Promise<void> {
    const snapshot = await this.computeSnapshot(notePath);
    if (snapshot === null) return;
    await this.options.db
      .query("UPDATE note SET health = $health, freshness = $freshness WHERE path = $path;", {
        health: snapshot.health,
        freshness: snapshot.freshness,
        path: notePath,
      })
      .collect();
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

  private async fetchNoteRow(notePath: string): Promise<NoteRow | null> {
    interface Row {
      word_count: number;
      maturity: Maturity | null;
      last_user_edit_at: { toDate?: () => Date } | string | null;
    }
    const [rows] = await this.options.db
      .query<[Row[]]>(
        "SELECT word_count, maturity, last_user_edit_at FROM note WHERE path = $path LIMIT 1;",
        { path: notePath },
      )
      .collect<[Row[]]>();
    const row = rows[0];
    if (row === undefined) return null;
    return {
      word_count: row.word_count,
      maturity: row.maturity,
      updated_at: extractEpochMs(row.last_user_edit_at),
    };
  }

  private async fetchChunkCount(notePath: string): Promise<number> {
    interface CountRow {
      count: number;
    }
    const [rows] = await this.options.db
      .query<[CountRow[]]>("SELECT count() FROM chunk WHERE note.path = $path GROUP ALL;", {
        path: notePath,
      })
      .collect<[CountRow[]]>();
    return rows[0]?.count ?? 0;
  }

  private async fetchEdgeCount(notePath: string): Promise<number> {
    // Edges anchor on `note|block` records via `in` and `out`. Block-anchored
    // rows expose the host note as `.note`, so the WHERE union covers both
    // forms. Filter on `approved AND applied` per the Phase 4 PENDING-STATE
    // contract: edges in the writeback-in-flight state are excluded.
    interface CountRow {
      count: number;
    }
    const [rows] = await this.options.db
      .query<[CountRow[]]>(
        `SELECT count() FROM wikilink
         WHERE approved = true AND applied = true
           AND (in.path = $path OR in.note.path = $path
                OR out.path = $path OR out.note.path = $path)
         GROUP ALL;`,
        { path: notePath },
      )
      .collect<[CountRow[]]>();
    return rows[0]?.count ?? 0;
  }
}

function extractEpochMs(value: { toDate?: () => Date } | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }
  return null;
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
