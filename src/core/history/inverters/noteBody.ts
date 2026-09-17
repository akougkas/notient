import { HistoryOperationError, historyConflict } from "../errors";
import type { HistoryRow, Inverter, InverterContext } from "../types";

export interface NoteBodyInverterFacade {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  writeIfUnchanged(
    path: string,
    expected: string,
    content: string,
    beforeEffect?: () => Promise<void>,
  ): Promise<boolean>;
  removeIfUnchanged(
    path: string,
    expected: string,
    beforeEffect?: () => Promise<void>,
  ): Promise<boolean>;
}

export interface NoteBodyInverterOptions {
  facade: NoteBodyInverterFacade;
  hash: (content: string) => Promise<string>;
  updateNoteSha: (path: string, sha: string) => Promise<void>;
  validateTargetIdentity: (row: HistoryRow) => Promise<boolean>;
}

/** Restore a recorded note body only while its after-image remains current. */
export function makeNoteBodyInverter(options: NoteBodyInverterOptions): Inverter {
  return async (row, context) => {
    const after = requireBody(row.after, "after", row);
    if (!(await options.validateTargetIdentity(row))) throw historyConflict(row.id);
    const exists = await options.facade.exists(row.target);
    if (!exists) {
      if (row.before === null) return;
      throw historyConflict(row.id);
    }

    const current = await options.facade.read(row.target);
    if (row.before === null) {
      await removeCreatedNote(options, row, current, after, context);
      return;
    }
    const before = requireBody(row.before, "before", row);
    await restorePriorBody(options, row, current, before, after, context);
  };
}

async function removeCreatedNote(
  options: NoteBodyInverterOptions,
  row: HistoryRow,
  current: string,
  after: string,
  context?: InverterContext,
): Promise<void> {
  if (current !== after) throw historyConflict(row.id);
  if (!(await options.facade.removeIfUnchanged(row.target, after, context?.authorize)))
    throw historyConflict(row.id);
}

async function restorePriorBody(
  options: NoteBodyInverterOptions,
  row: HistoryRow,
  current: string,
  before: string,
  after: string,
  context?: InverterContext,
): Promise<void> {
  const beforeSha = await options.hash(before);
  if (current !== before && current !== after) throw historyConflict(row.id);
  if (
    current === after &&
    !(await options.facade.writeIfUnchanged(row.target, after, before, context?.authorize))
  ) {
    throw historyConflict(row.id);
  }
  await options.updateNoteSha(row.target, beforeSha);
}

function requireBody(value: unknown, field: "before" | "after", row: HistoryRow): string {
  if (typeof value === "string") return value;
  throw new HistoryOperationError(
    "HISTORY_INVALID_PAYLOAD",
    `${row.kind} history row ${row.id} has no ${field} body`,
  );
}
