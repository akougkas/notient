/**
 * Inverter for body-edit kinds that store the full prior body in
 * `before`. Restores the note body via the facade after marking
 * EchoGuard so the indexer ignores the self-write.
 *
 * Handles `notes.append`, `notes.replace_section`, and the graph
 * bridge's `note.append_section` writeback.
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
}

export function makeNoteAppendSectionInverter(options: NoteAppendSectionInverterOptions): Inverter {
  return async (target, before) => {
    if (typeof before !== "string") {
      throw new Error("note append/section inverter: `before` must be a string body");
    }
    const sha = await options.hash(before);
    options.echoGuard.mark(target, sha);
    await options.facade.writeNote(target, before);
  };
}
