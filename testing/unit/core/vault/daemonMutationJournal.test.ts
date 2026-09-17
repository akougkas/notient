import { describe, expect, test } from "bun:test";
import { DaemonMutationJournal } from "../../../../src/core/vault/daemonMutationJournal";

describe("DaemonMutationJournal", () => {
  test("attributes writes by exact path and content hash", () => {
    let now = 100;
    const journal = new DaemonMutationJournal(() => now, 50);
    journal.record({ kind: "write", path: "note.md", sha: "sha-a" });

    expect(journal.matchesWrite("note.md", "sha-a")).toBe(true);
    expect(journal.matchesWrite("note.md", "sha-b")).toBe(false);
    expect(journal.matchesWrite("other.md", "sha-a")).toBe(false);
    now = 150;
    expect(journal.matchesWrite("note.md", "sha-a")).toBe(false);
  });

  test("attributes both filesystem events from a daemon rename", () => {
    const journal = new DaemonMutationJournal();
    journal.record({ kind: "rename", fromPath: "old.md", toPath: "new.md" });
    expect(journal.matchesRemoval("old.md")).toBe(true);
    expect(journal.matchesWrite("new.md", "any-current-sha")).toBe(true);
  });

  test("cancels a reservation when the guarded filesystem mutation does not publish", () => {
    const journal = new DaemonMutationJournal();
    const cancel = journal.reserve({ kind: "write", path: "note.md", sha: "candidate" });
    expect(journal.matchesWrite("note.md", "candidate")).toBe(true);

    cancel();
    expect(journal.matchesWrite("note.md", "candidate")).toBe(false);
  });
});
