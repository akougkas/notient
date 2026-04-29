/**
 * Inverter for `notes.create`. Deletes the note that was created.
 *
 * Phase 4 Task 4: removing the note leaves the SurrealDB `note` record
 * to the watcher pipeline, which deletes the row on the file-removed
 * event. The inverter does not touch SurrealDB directly because the
 * post-undo state has no body whose `sha` could be recorded.
 *
 * Phase 4 Task 6 removed the legacy self-write suppression mark; the
 * indexer now cross-references the SurrealDB `daemon_write` table
 * (Task 2) to skip daemon-authored writes without a per-call hook.
 */

import type { Inverter } from "../types";

export interface NoteCreateInverterFacade {
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface NoteCreateInverterOptions {
  facade: NoteCreateInverterFacade;
}

export function makeNoteCreateInverter(options: NoteCreateInverterOptions): Inverter {
  return async (target) => {
    if (!(await options.facade.exists(target))) return;
    await options.facade.remove(target);
  };
}
