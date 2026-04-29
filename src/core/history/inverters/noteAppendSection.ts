/**
 * Inverter for body-edit kinds that store the full prior body in
 * `before`. Restores the note body via the facade after marking
 * EchoGuard so the indexer ignores the self-write, then updates the
 * SurrealDB `note` row's `sha` so consumers reading the row see the
 * post-undo content hash.
 *
 * Handles `notes.append`, `notes.replace_section`, and the graph
 * bridge's `note.append_section` writeback.
 *
 * Phase 4 Task 4 replaced the SQLite `notes` write with the injected
 * `updateNoteSha` callback; production wires a closure that issues
 * `UPDATE note SET sha = $sha WHERE path = $path;` against SurrealDB.
 */

import type { Inverter } from "../types";

export interface NoteAppendSectionInverterFacade {
  writeNote(path: string, content: string): Promise<void>;
}

export interface NoteAppendSectionInverterEchoGuard {
  mark(path: string, sha: string): void;
}

export interface NoteAppendSectionInverterOptions {
  facade: NoteAppendSectionInverterFacade;
  echoGuard: NoteAppendSectionInverterEchoGuard;
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
    options.echoGuard.mark(target, sha);
    await options.facade.writeNote(target, before);
    await options.updateNoteSha(target, sha);
  };
}
