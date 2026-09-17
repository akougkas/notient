import { describe, expect, test } from "bun:test";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { HistoryOperationError } from "../../../../src/core/history/errors";
import { makeNoteBodyInverter } from "../../../../src/core/history/inverters/noteBody";
import type { HistoryRow } from "../../../../src/core/history/types";

const HISTORY_ID = createUuidRecordId("history", "018f05cd-3f7b-7000-8000-000000000001").toString();

class FakeFacade {
  files = new Map<string, string>();
  writes: Array<{ path: string; content: string }> = [];
  removed: string[] = [];
  beforeConditionalWrite?: () => void;

  async read(path: string): Promise<string> {
    const body = this.files.get(path);
    if (body === undefined) throw new Error("ENOENT");
    return body;
  }

  async writeIfUnchanged(path: string, expected: string, content: string): Promise<boolean> {
    this.beforeConditionalWrite?.();
    if (this.files.get(path) !== expected) return false;
    this.files.set(path, content);
    this.writes.push({ path, content });
    return true;
  }

  async removeIfUnchanged(path: string, expected: string): Promise<boolean> {
    if (this.files.get(path) !== expected) return false;
    this.files.delete(path);
    this.removed.push(path);
    return true;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}

function makeRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: HISTORY_ID,
    kind: "notes.append",
    target: "note.md",
    before: "before",
    after: "after",
    createdAt: 1,
    clientIdentity: "human",
    proposalEdge: null,
    proposalCreatedAt: null,
    undo: null,
    ...overrides,
  };
}

async function fakeHash(input: string): Promise<string> {
  return `sha:${input}`;
}

function setup(validateTargetIdentity: (row: HistoryRow) => Promise<boolean> = async () => true): {
  facade: FakeFacade;
  shaCalls: Array<{ path: string; sha: string }>;
  inverter: ReturnType<typeof makeNoteBodyInverter>;
} {
  const facade = new FakeFacade();
  const shaCalls: Array<{ path: string; sha: string }> = [];
  const inverter = makeNoteBodyInverter({
    facade,
    hash: fakeHash,
    updateNoteSha: async (path, sha) => {
      shaCalls.push({ path, sha });
    },
    validateTargetIdentity,
  });
  return { facade, shaCalls, inverter };
}

describe("note body inverter", () => {
  test("restores before when the current body matches after", async () => {
    const { facade, shaCalls, inverter } = setup();
    facade.files.set("note.md", "after");

    await inverter(makeRow());

    expect(facade.files.get("note.md")).toBe("before");
    expect(facade.writes).toEqual([{ path: "note.md", content: "before" }]);
    expect(shaCalls).toEqual([{ path: "note.md", sha: "sha:before" }]);
  });

  test("refuses a hand edit and preserves its bytes", async () => {
    const { facade, shaCalls, inverter } = setup();
    const edited = "after\nhuman edit\n";
    facade.files.set("note.md", edited);

    let caught: unknown;
    try {
      await inverter(makeRow());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HistoryOperationError);
    expect((caught as HistoryOperationError).code).toBe("HISTORY_CONFLICT");
    expect((caught as Error).message).toBe(`note changed since ${HISTORY_ID}`);
    expect(facade.files.get("note.md")).toBe(edited);
    expect(facade.writes).toEqual([]);
    expect(shaCalls).toEqual([]);
  });

  test("refuses a save that lands after the first read but before the guarded write", async () => {
    const { facade, shaCalls, inverter } = setup();
    facade.files.set("note.md", "after");
    facade.beforeConditionalWrite = () => {
      facade.files.set("note.md", "last-moment edit");
    };

    await expect(inverter(makeRow())).rejects.toThrow(`note changed since ${HISTORY_ID}`);

    expect(facade.files.get("note.md")).toBe("last-moment edit");
    expect(facade.writes).toEqual([]);
    expect(shaCalls).toEqual([]);
  });

  test("refuses a proposal receipt whose source note no longer owns the path", async () => {
    const { facade, inverter } = setup(async () => false);
    facade.files.set("note.md", "after");

    await expect(
      inverter(
        makeRow({
          proposalEdge: "supports:abcdefghijklmnopqrst",
          proposalCreatedAt: "1970-01-01T00:00:00.001Z",
        }),
      ),
    ).rejects.toThrow(`note changed since ${HISTORY_ID}`);
    expect(facade.files.get("note.md")).toBe("after");
    expect(facade.writes).toEqual([]);
  });

  test("finishes an already-restored retry without rewriting the file", async () => {
    const { facade, shaCalls, inverter } = setup();
    facade.files.set("note.md", "before");

    await inverter(makeRow());

    expect(facade.writes).toEqual([]);
    expect(shaCalls).toEqual([{ path: "note.md", sha: "sha:before" }]);
  });

  test("treats a missing restore target as a conflict", async () => {
    const { facade, inverter } = setup();
    await expect(inverter(makeRow())).rejects.toThrow(`note changed since ${HISTORY_ID}`);
    expect(facade.writes).toEqual([]);
    expect(facade.removed).toEqual([]);
  });

  test("removes a created note only while it matches after", async () => {
    const { facade, inverter } = setup();
    facade.files.set("note.md", "created body");

    await inverter(makeRow({ kind: "notes.create", before: null, after: "created body" }));

    expect(facade.files.has("note.md")).toBe(false);
    expect(facade.removed).toEqual(["note.md"]);
  });

  test("refuses to remove an edited created note", async () => {
    const { facade, inverter } = setup();
    facade.files.set("note.md", "created body with hand edit");

    await expect(
      inverter(makeRow({ kind: "notes.create", before: null, after: "created body" })),
    ).rejects.toThrow(`note changed since ${HISTORY_ID}`);

    expect(facade.files.get("note.md")).toBe("created body with hand edit");
    expect(facade.removed).toEqual([]);
  });

  test("accepts an already-removed create retry", async () => {
    const { facade, inverter } = setup();
    await inverter(makeRow({ kind: "notes.create", before: null, after: "created body" }));
    expect(facade.removed).toEqual([]);
  });

  test("rejects invalid snapshots before touching the vault", async () => {
    const { facade, inverter } = setup();
    facade.files.set("note.md", "after");

    await expect(inverter(makeRow({ after: { body: "after" } }))).rejects.toThrow(
      "has no after body",
    );
    await expect(inverter(makeRow({ before: { body: "before" } }))).rejects.toThrow(
      "has no before body",
    );
    expect(facade.writes).toEqual([]);
    expect(facade.removed).toEqual([]);
  });
});
