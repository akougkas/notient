import type { UndoFailureCode } from "./types";

export class HistoryOperationError extends Error {
  constructor(
    readonly code: UndoFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "HistoryOperationError";
  }
}

export function historyConflict(historyId: string): HistoryOperationError {
  return new HistoryOperationError("HISTORY_CONFLICT", `note changed since ${historyId}`);
}
