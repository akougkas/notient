import type { HistoryDetail, HistoryEntry } from "../src/api/history";
import { contentRevision } from "../src/api/notes";
export const HISTORY_FIXTURE_ID = 'history:u"018f05cd-3f7b-7000-8000-000000000001"';
export function historyEntryFixture(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: HISTORY_FIXTURE_ID,
    kind: "notes.append",
    target: "note.md",
    createdAt: 1,
    clientIdentity: "human",
    undo: null,
    reversible: true,
    ...overrides,
  };
}
export function historyDetailFixture(entry = historyEntryFixture()): HistoryDetail {
  return {
    ok: true,
    entry,
    before: "before",
    after: "after",
    destination: null,
    sources: [{ path: entry.target, revision: contentRevision("after") }],
  };
}
export function historyListFixture(entries = [historyEntryFixture()]) {
  return {
    ok: true as const,
    entries,
    snapshot: contentRevision(JSON.stringify(entries)),
    nextCursor: null as string | null,
  };
}
export function historyUndoFixture(entry = historyEntryFixture()) {
  return {
    ok: true as const,
    entry: { ...entry, undo: { startedAt: 2, completedAt: 3, clientIdentity: "human" } },
  };
}
