/**
 * Inverter for `edge.approve`. Restores the staging row recorded in
 * `before` and removes the live `graph_edges` row identified by `after`.
 *
 * Recorded payloads (Task 16 wires the producer in `approvalService.ts`):
 *   target = staging row id
 *   before = StagingEdgePayload (the full row prior to acceptance)
 *   after  = LiveEdgePayload    (the row that landed in graph_edges)
 */

import type { Database } from "../../db/database";
import type { Inverter } from "../types";

export interface StagingEdgePayload {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  confidence: number;
  agent: string;
  evidence: string;
  rationale: string | null;
  created_at: number;
}

export interface LiveEdgePayload {
  id: string;
}

export interface EdgeApproveInverterOptions {
  db: Database;
}

function isStagingEdgePayload(value: unknown): value is StagingEdgePayload {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.source_id === "string" &&
    typeof candidate.target_id === "string" &&
    typeof candidate.confidence === "number" &&
    typeof candidate.agent === "string" &&
    typeof candidate.evidence === "string" &&
    (candidate.rationale === null || typeof candidate.rationale === "string") &&
    typeof candidate.created_at === "number"
  );
}

function isLiveEdgePayload(value: unknown): value is LiveEdgePayload {
  if (value === null || typeof value !== "object") return false;
  return typeof (value as Record<string, unknown>).id === "string";
}

export function makeEdgeApproveInverter(options: EdgeApproveInverterOptions): Inverter {
  return async (_target, before, after) => {
    if (!isLiveEdgePayload(after)) {
      throw new Error("edge.approve inverter: invalid `after` payload");
    }
    if (!isStagingEdgePayload(before)) {
      throw new Error("edge.approve inverter: invalid `before` payload");
    }
    const existing = options.db.query<{ id: string }>("SELECT id FROM graph_edges WHERE id = ?;", [
      after.id,
    ]);
    if (existing.length === 0) {
      throw new Error(
        `edge.approve inverter: live edge ${after.id} no longer exists (deleted outside undo)`,
      );
    }
    options.db.transaction(() => {
      options.db.run("DELETE FROM graph_edges WHERE id = ?;", [after.id]);
      options.db.run(
        `INSERT OR REPLACE INTO staging_edges
          (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at, decided_at, decision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL);`,
        [
          before.id,
          before.type,
          before.source_id,
          before.target_id,
          before.confidence,
          before.agent,
          before.evidence,
          before.rationale,
          before.created_at,
        ],
      );
    });
    await options.db.persist();
  };
}
