/**
 * Inverter for `note.maturity`. Restores the prior maturity column on
 * the `notes` row and the prior body via the facade. The MaturityAdvancer
 * writes both on promotion, so undoing both is required to fully revert.
 *
 * Recorded payload (Task 16 wires the producer):
 *   target = note path
 *   before = { maturity, body }
 *   after  = { maturity, body }
 */

import type { Database } from "../../db/database";
import type { Inverter } from "../types";

export interface NoteMaturityPayload {
  maturity: string;
  body: string;
}

export interface NoteMaturityInverterFacade {
  writeNote(path: string, content: string): Promise<void>;
}

export interface NoteMaturityInverterEchoGuard {
  mark(path: string, sha: string): void;
}

export interface NoteMaturityInverterOptions {
  db: Database;
  facade: NoteMaturityInverterFacade;
  echoGuard: NoteMaturityInverterEchoGuard;
  hash: (content: string) => Promise<string>;
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
    options.echoGuard.mark(target, sha);
    await options.facade.writeNote(target, before.body);
    options.db.run("UPDATE notes SET maturity = ? WHERE path = ?;", [before.maturity, target]);
    await options.db.persist();
  };
}
