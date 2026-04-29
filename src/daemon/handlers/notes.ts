/**
 * notes.* RPC handlers for history, undo, and read.
 *
 * Three thin wrappers used by the TUI verbs `/history`, `/undo`, and
 * `/read`. notes.history surfaces the recent rows from the universal
 * undo journal; notes.undo runs the registered inverter for the most
 * recent row and returns that row's metadata so the TUI can display
 * "reversed: kind target"; notes.read returns the UTF-8 body of a
 * vault-relative path through the substrate VaultAdapter.
 *
 * The undo handler captures `getRecent(1)[0]` before calling
 * `undoLast()` because `undoLast` hard-deletes the row on success. The
 * substrate vault lock guarantees one daemon writer so this read-then-
 * mutate sequence is race-free.
 */

import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { HistoryService } from "../../core/history/historyService";
import type { HistoryRow } from "../../core/history/types";

export interface NotesHandlerDeps {
  historyService: Pick<HistoryService, "getRecent" | "undoLast">;
  vault: Pick<VaultAdapter, "read">;
}

export interface NotesHandlers {
  history: (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ) => Promise<{ ok: boolean; entries: HistoryRow[] }>;
  undo: (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ) => Promise<{ ok: boolean; reversed?: HistoryRow; error?: string }>;
  read: (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ) => Promise<{ ok: boolean; body: string }>;
}

export function makeNotesHandlers(deps: NotesHandlerDeps): NotesHandlers {
  return {
    history: async (params) => {
      const limit = typeof params.limit === "number" ? params.limit : 10;
      const entries = await deps.historyService.getRecent(limit);
      return { ok: true, entries };
    },
    undo: async () => {
      const recent = await deps.historyService.getRecent(1);
      const target = recent[0];
      const result = await deps.historyService.undoLast();
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true, reversed: target };
    },
    read: async (params) => {
      const path = typeof params.path === "string" ? params.path : "";
      if (path.length === 0) {
        throw new Error("INVALID_PARAMS: path is required");
      }
      const body = await deps.vault.read(path);
      return { ok: true, body };
    },
  };
}
