/**
 * Inverter for `note.maturity`. Restores the prior body via the facade
 * and refreshes the SurrealDB `note.sha` field. The MaturityAdvancer
 * writes a body change on promotion; undoing the body is sufficient to
 * revert the user-visible state.
 *
 * Phase 4 Task 4 dropped the SQLite `notes.maturity` column update
 * because the SurrealDB `note` schema has no `maturity` field; the
 * concept lives in the markdown frontmatter and is restored by the
 * facade write of the prior body. The `sha` refresh keeps the SurrealDB
 * row in step with the post-undo body.
 *
 * Phase 4 Task 6 removed the legacy self-write suppression mark; the
 * indexer now cross-references the SurrealDB `daemon_write` table
 * (Task 2) to skip daemon-authored writes without a per-call hook.
 *
 * Recorded payload (Task 16 wires the producer):
 *   target = note path
 *   before = { maturity, body }
 *   after  = { maturity, body }
 */

import type { Inverter } from "../types";

export interface NoteMaturityPayload {
  maturity: string;
  body: string;
}

export interface NoteMaturityInverterFacade {
  writeNote(path: string, content: string): Promise<void>;
}

export interface NoteMaturityInverterOptions {
  facade: NoteMaturityInverterFacade;
  hash: (content: string) => Promise<string>;
  /**
   * Updates the SurrealDB `note.sha` field for the given path. Tests
   * inject a fake; bootstrap wires a SurrealDB-backed closure.
   */
  updateNoteSha: (path: string, sha: string) => Promise<void>;
}

function isNoteMaturityPayload(value: unknown): value is NoteMaturityPayload {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.maturity === "string" && typeof candidate.body === "string";
}

export function makeNoteMaturityInverter(options: NoteMaturityInverterOptions): Inverter {
  return async (target, before) => {
    if (!isNoteMaturityPayload(before)) {
      throw new Error("note.maturity inverter: invalid `before` payload");
    }
    const sha = await options.hash(before.body);
    await options.facade.writeNote(target, before.body);
    await options.updateNoteSha(target, sha);
  };
}
