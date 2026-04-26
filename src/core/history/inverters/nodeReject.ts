/**
 * Inverter for `node.reject`. Re-inserts the staging node row recorded
 * in `before` so the proposal returns to the pending queue.
 */

import type { Database } from "../../db/database";
import type { Inverter } from "../types";
import type { StagingNodePayload } from "./nodeApprove";

export interface NodeRejectInverterOptions {
  db: Database;
}

function isStagingNodePayload(value: unknown): value is StagingNodePayload {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.label === "string" &&
    (candidate.note_path === null || typeof candidate.note_path === "string") &&
    (candidate.payload === null || typeof candidate.payload === "string") &&
    typeof candidate.agent === "string" &&
    typeof candidate.confidence === "number" &&
    typeof candidate.created_at === "number"
  );
}

export function makeNodeRejectInverter(options: NodeRejectInverterOptions): Inverter {
  return async (_target, before) => {
    if (!isStagingNodePayload(before)) {
      throw new Error("node.reject inverter: invalid `before` payload");
    }
    options.db.run(
      `INSERT OR REPLACE INTO staging_nodes
        (id, type, label, note_path, payload, agent, confidence, created_at, decided_at, decision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL);`,
      [
        before.id,
        before.type,
        before.label,
        before.note_path,
        before.payload,
        before.agent,
        before.confidence,
        before.created_at,
      ],
    );
    await options.db.persist();
  };
}
