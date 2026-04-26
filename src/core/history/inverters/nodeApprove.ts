/**
 * Inverter for `node.approve`. Restores a staging node and removes the
 * live `graph_nodes` row that was promoted from it. When the approval
 * also created a synthesis note (Synthesizer's "promote as note" path),
 * the inverter deletes that note via the facade after marking
 * EchoGuard so the indexer ignores the self-write.
 */

import type { Database } from "../../db/database";
import type { Inverter } from "../types";

export interface StagingNodePayload {
  id: string;
  type: string;
  label: string;
  note_path: string | null;
  payload: string | null;
  agent: string;
  confidence: number;
  created_at: number;
}

export interface LiveNodePayload {
  id: string;
  createdNotePath?: string | null;
}

export interface NodeApproveInverterFacade {
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface NodeApproveInverterEchoGuard {
  mark(path: string, sha: string): void;
}

export interface NodeApproveInverterOptions {
  db: Database;
  facade: NodeApproveInverterFacade;
  echoGuard: NodeApproveInverterEchoGuard;
  hash: (content: string) => Promise<string>;
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

function isLiveNodePayload(value: unknown): value is LiveNodePayload {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string") return false;
  if (
    candidate.createdNotePath !== undefined &&
    candidate.createdNotePath !== null &&
    typeof candidate.createdNotePath !== "string"
  ) {
    return false;
  }
  return true;
}

export function makeNodeApproveInverter(options: NodeApproveInverterOptions): Inverter {
  return async (_target, before, after) => {
    if (!isLiveNodePayload(after)) {
      throw new Error("node.approve inverter: invalid `after` payload");
    }
    if (!isStagingNodePayload(before)) {
      throw new Error("node.approve inverter: invalid `before` payload");
    }
    options.db.transaction(() => {
      options.db.run("DELETE FROM graph_nodes WHERE id = ?;", [after.id]);
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
    });
    await options.db.persist();
    const createdPath = after.createdNotePath ?? null;
    if (createdPath && (await options.facade.exists(createdPath))) {
      const sha = await options.hash("");
      options.echoGuard.mark(createdPath, sha);
      await options.facade.remove(createdPath);
    }
  };
}
