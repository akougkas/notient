/**
 * Inverter for `edge.reject`. Re-inserts the staging edge row recorded
 * in `before` so the proposal returns to the pending queue.
 */

import type { Database } from "../../db/database";
import type { Inverter } from "../types";
import type { StagingEdgePayload } from "./edgeApprove";

export interface EdgeRejectInverterOptions {
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

export function makeEdgeRejectInverter(options: EdgeRejectInverterOptions): Inverter {
  return async (_target, before) => {
    if (!isStagingEdgePayload(before)) {
      throw new Error("edge.reject inverter: invalid `before` payload");
    }
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
    await options.db.persist();
  };
}
