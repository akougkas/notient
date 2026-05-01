import { describe, expect, test } from "bun:test";
import type { HistoryRow } from "../../../../src/core/history/types";
import { makeNotesHandlers } from "../../../../src/daemon/handlers/notes";

const sampleRow: HistoryRow = {
  id: "history:fake1",
  kind: "notes.create",
  target: "notes/x.md",
  before: null,
  after: "hello",
  createdAt: 1700000000000,
  clientIdentity: "human",
};

describe("notes.history + notes.undo + notes.read", () => {
  test("history returns the rows from getRecent", async () => {
    const handlers = makeNotesHandlers({
      historyService: {
        getRecent: async () => [sampleRow],
        undoLast: async () => ({ ok: true }),
      },
      vault: { read: async () => "body" },
    });
    const result = await handlers.history({ limit: 10 }, () => undefined, "envelope-1");
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].id).toBe("history:fake1");
  });

  test("undo calls undoLast and returns the reversed row metadata", async () => {
    let called = false;
    const handlers = makeNotesHandlers({
      historyService: {
        getRecent: async () => [sampleRow],
        undoLast: async () => {
          called = true;
          return { ok: true };
        },
      },
      vault: { read: async () => "body" },
    });
    const result = await handlers.undo({}, () => undefined, "envelope-2");
    expect(called).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reversed?.id).toBe("history:fake1");
  });

  test("undo surfaces the inverter error when undoLast returns ok:false", async () => {
    const handlers = makeNotesHandlers({
      historyService: {
        getRecent: async () => [],
        undoLast: async () => ({ ok: false, error: "no history" }),
      },
      vault: { read: async () => "body" },
    });
    const result = await handlers.undo({}, () => undefined, "envelope-3");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no history");
  });

  test("read returns the file body from vault.read", async () => {
    const handlers = makeNotesHandlers({
      historyService: {
        getRecent: async () => [],
        undoLast: async () => ({ ok: false, error: "x" }),
      },
      vault: { read: async (path: string) => `# ${path}\n\nbody` },
    });
    const result = await handlers.read({ path: "notes/x.md" }, () => undefined, "envelope-4");
    expect(result.ok).toBe(true);
    expect(result.body).toBe("# notes/x.md\n\nbody");
  });

  test("read rejects without a path", async () => {
    const handlers = makeNotesHandlers({
      historyService: {
        getRecent: async () => [],
        undoLast: async () => ({ ok: false, error: "x" }),
      },
      vault: { read: async () => "" },
    });
    await expect(handlers.read({}, () => undefined, "env-5")).rejects.toThrow(/INVALID_PARAMS/);
  });
});
