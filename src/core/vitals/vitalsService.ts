import { DateTime, type Surreal } from "surrealdb";
import { readAggregateCount } from "../db/queryResult";
import { isCanonicalPublicNotePath } from "../vault/publicPath";
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
  constructor(private readonly options: VitalsServiceOptions) {
    if (typeof options.now !== "function" || typeof options.settings !== "function") {
      throw new Error("VitalsService requires clock and settings providers");
    }
    assertVitalsSettings(options.settings());
  }

  async computeSnapshot(notePath: string): Promise<VitalsSnapshot | null> {
    if (!isCanonicalPublicNotePath(notePath)) {
      throw new Error("vitals note path must be an exact public vault-relative Markdown path");
    }
    const row = await this.fetchNoteRow(notePath);
    if (row === null) return null;
    const settings = this.options.settings();
    assertVitalsSettings(settings);
    const now = this.options.now();
    assertNonNegativeSafeInteger(now, "vitals clock");
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
      totalWeight;
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
      .query(
        "UPDATE note SET health = $health, freshness = $freshness WHERE path = $path AND tombstoned_at = NONE;",
        {
          health: snapshot.health,
          freshness: snapshot.freshness,
          path: notePath,
        },
      )
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
    const result: unknown = await this.options.db
      .query(
        "SELECT word_count, maturity, last_user_edit_at FROM note WHERE path = $path AND tombstoned_at = NONE LIMIT 1;",
        { path: notePath },
      )
      .collect();
    const rows = readSingleStatementRows(result, "vitals note");
    if (rows.length > 1) {
      throw new Error(`vitals storage integrity: note query returned ${rows.length} rows`);
    }
    const row = rows[0];
    if (row === undefined) return null;
    if (!isRecord(row)) throw new Error("vitals storage integrity: note row is not an object");
    assertNonNegativeSafeInteger(row.word_count, "vitals stored word_count");
    return {
      word_count: row.word_count,
      maturity: parseStoredMaturity(row.maturity),
      updated_at: parseStoredEditTime(row.last_user_edit_at),
    };
  }

  private async fetchChunkCount(notePath: string): Promise<number> {
    const result: unknown = await this.options.db
      .query(
        "SELECT count() FROM chunk WHERE note.path = $path AND note.tombstoned_at IS NONE GROUP ALL;",
        {
          path: notePath,
        },
      )
      .collect();
    return readAggregateCount(result, "vitals chunk count");
  }

  private async fetchEdgeCount(notePath: string): Promise<number> {
    // Edges anchor on `note|block` records via `in` and `out`. Block-anchored
    // rows expose the host note as `.note`, so the WHERE union covers both
    // forms. Both the direct-note and block-host tombstone checks are needed:
    // one side is NONE for each endpoint shape. `approved AND applied`
    // excludes pending proposals and edges whose writeback is still in flight.
    const result: unknown = await this.options.db
      .query(
        `SELECT count() FROM wikilink
         WHERE approved = true AND applied = true
           AND in.tombstoned_at IS NONE AND in.note.tombstoned_at IS NONE
           AND out.tombstoned_at IS NONE AND out.note.tombstoned_at IS NONE
           AND (in.path = $path OR in.note.path = $path
                OR out.path = $path OR out.note.path = $path)
         GROUP ALL;`,
        { path: notePath },
      )
      .collect();
    return readAggregateCount(result, "vitals edge count");
  }
}

function parseStoredMaturity(raw: unknown): Maturity | null {
  if (raw === undefined) return null;
  if (raw === null) {
    throw new Error("vitals storage integrity: maturity uses null instead of NONE");
  }
  if (raw === "raw" || raw === "adolescent" || raw === "mature" || raw === "synthesis-ready") {
    return raw;
  }
  throw new Error("vitals storage integrity: maturity is invalid");
}

function parseStoredEditTime(raw: unknown): number | null {
  if (raw === undefined) return null;
  if (raw === null) {
    throw new Error("vitals storage integrity: last_user_edit_at uses null instead of NONE");
  }
  if (!(raw instanceof DateTime)) {
    throw new Error("vitals storage integrity: last_user_edit_at is not a native datetime");
  }
  const milliseconds = raw.toDate().getTime();
  assertNonNegativeSafeInteger(milliseconds, "vitals stored last_user_edit_at");
  return milliseconds;
}

function readSingleStatementRows(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(`vitals storage integrity: ${label} returned an invalid statement envelope`);
  }
  return raw[0];
}

function assertVitalsSettings(raw: unknown): asserts raw is VitalsSettings {
  if (!isRecord(raw)) throw new Error("VitalsService settings must be an object");
  const weights = raw.healthWeights;
  const thresholds = raw.connectivityThresholds;
  if (
    typeof raw.freshnessHalfLifeDays !== "number" ||
    !Number.isFinite(raw.freshnessHalfLifeDays) ||
    raw.freshnessHalfLifeDays <= 0 ||
    typeof raw.writeToFrontmatter !== "boolean" ||
    !isRecord(weights) ||
    !isRecord(thresholds)
  ) {
    throw new Error("VitalsService settings are invalid");
  }
  const weightValues = [weights.wordBand, weights.chunkCoverage, weights.hasApprovedEdges];
  if (
    weightValues.some(
      (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0,
    ) ||
    (weightValues as number[]).reduce((sum, value) => sum + value, 0) <= 0
  ) {
    throw new Error("VitalsService health weights are invalid");
  }
  const thresholdValues = [thresholds.sparse, thresholds.connected, thresholds.hub];
  if (
    thresholdValues.some(
      (value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
    ) ||
    (thresholds.sparse as number) > (thresholds.connected as number) ||
    (thresholds.connected as number) > (thresholds.hub as number)
  ) {
    throw new Error("VitalsService connectivity thresholds are invalid");
  }
}

function assertNonNegativeSafeInteger(raw: unknown, label: string): asserts raw is number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function parseNonBlankString(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${label} must be a non-blank string`);
  }
  return raw;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
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
