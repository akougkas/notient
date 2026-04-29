/**
 * Inverter for frontmatter writes that store the full prior body in
 * `before`. Restores the note body verbatim, which carries the prior
 * frontmatter back into place, then refreshes the SurrealDB `note.sha`
 * so consumers see the post-undo content hash.
 *
 * Handles `notes.update_frontmatter` (chat tool) and `note.frontmatter`
 * (approval-service writeback for typed relations).
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

export interface NoteFrontmatterInverterFacade {
  writeNote(path: string, content: string): Promise<void>;
}

export interface NoteFrontmatterInverterOptions {
  facade: NoteFrontmatterInverterFacade;
  hash: (content: string) => Promise<string>;
  /**
   * Updates the SurrealDB `note.sha` field for the given path. Tests
   * inject a fake; bootstrap wires a SurrealDB-backed closure.
   */
  updateNoteSha: (path: string, sha: string) => Promise<void>;
}

export function makeNoteFrontmatterInverter(options: NoteFrontmatterInverterOptions): Inverter {
  return async (target, before) => {
    if (typeof before !== "string") {
      throw new Error("note frontmatter inverter: `before` must be a string body");
    }
    const sha = await options.hash(before);
    await options.facade.writeNote(target, before);
    await options.updateNoteSha(target, sha);
  };
}
