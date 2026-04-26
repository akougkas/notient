/**
 * Inverter for `notes.create`. Deletes the note that was created.
 * EchoGuard is marked with a sha of the prior body (empty since the
 * note did not exist before) so the indexer ignores the deletion echo.
 */

import type { Inverter } from "../types";

export interface NoteCreateInverterFacade {
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface NoteCreateInverterEchoGuard {
  mark(path: string, sha: string): void;
}

export interface NoteCreateInverterOptions {
  facade: NoteCreateInverterFacade;
  echoGuard: NoteCreateInverterEchoGuard;
  hash: (content: string) => Promise<string>;
}

export function makeNoteCreateInverter(options: NoteCreateInverterOptions): Inverter {
  return async (target) => {
    if (!(await options.facade.exists(target))) return;
    const sha = await options.hash("");
    options.echoGuard.mark(target, sha);
    await options.facade.remove(target);
  };
}
