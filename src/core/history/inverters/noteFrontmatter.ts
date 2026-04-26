/**
 * Inverter for frontmatter writes that store the full prior body in
 * `before`. Restores the note body verbatim, which carries the prior
 * frontmatter back into place. EchoGuard is marked first so the
 * indexer skips the self-write.
 *
 * Handles `notes.update_frontmatter` (chat tool) and `note.frontmatter`
 * (graph bridge writeback for typed relations).
 */

import type { Inverter } from "../types";

export interface NoteFrontmatterInverterFacade {
  writeNote(path: string, content: string): Promise<void>;
}

export interface NoteFrontmatterInverterEchoGuard {
  mark(path: string, sha: string): void;
}

export interface NoteFrontmatterInverterOptions {
  facade: NoteFrontmatterInverterFacade;
  echoGuard: NoteFrontmatterInverterEchoGuard;
  hash: (content: string) => Promise<string>;
}

export function makeNoteFrontmatterInverter(options: NoteFrontmatterInverterOptions): Inverter {
  return async (target, before) => {
    if (typeof before !== "string") {
      throw new Error("note frontmatter inverter: `before` must be a string body");
    }
    const sha = await options.hash(before);
    options.echoGuard.mark(target, sha);
    await options.facade.writeNote(target, before);
  };
}
