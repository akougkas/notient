/**
 * Inverter for body-edit kinds that store the full prior body in
 * `before`. Restores the note body via the facade, then updates the
 * SurrealDB `note` row's `sha` so consumers reading the row see the
 * post-undo content hash.
 *
 * Handles `notes.append`, `notes.replace_section`, and the graph
 * bridge's `note.append_section` writeback.
 *
 * Phase 4 Task 4 replaced the SQLite `notes` write with the injected
 * `updateNoteSha` callback; production wires a closure that issues
 * `UPDATE note SET sha = $sha WHERE path = $path;` against SurrealDB.
 *
 * Phase 4 Task 6 removed the legacy self-write suppression mark; the
 * indexer now cross-references the SurrealDB `daemon_write` table
 * (Task 2) to skip daemon-authored writes without a per-call hook.
 */

import type { Inverter } from "../types";

export interface NoteAppendSectionInverterFacade {
  writeNote(path: string, content: string): Promise<void>;
}

export interface NoteAppendSectionInverterOptions {
  facade: NoteAppendSectionInverterFacade;
  hash: (content: string) => Promise<string>;
  /**
   * Updates the SurrealDB `note.sha` field for the given path. Tests
   * inject a fake; bootstrap wires a SurrealDB-backed closure.
   */
  updateNoteSha: (path: string, sha: string) => Promise<void>;
}

export function makeNoteAppendSectionInverter(options: NoteAppendSectionInverterOptions): Inverter {
  return async (target, before) => {
    if (typeof before !== "string") {
      throw new Error("note append/section inverter: `before` must be a string body");
    }
    const sha = await options.hash(before);
    await options.facade.writeNote(target, before);
    await options.updateNoteSha(target, sha);
  };
}
