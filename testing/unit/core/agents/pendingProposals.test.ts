import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { deletePendingProposals } from "../../../../src/core/agents/pendingProposals";

interface RecordedQuery {
  sql: string;
  bindings: Record<string, unknown>;
}

function makeFakeDb(): { db: Surreal; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const db = {
    query: (sql: string, bindings: Record<string, unknown>) => {
      queries.push({ sql, bindings });
      return { collect: async () => [[]] };
    },
  } as unknown as Surreal;
  return { db, queries };
}

describe("deletePendingProposals", () => {
  test("issues one scoped delete per table", async () => {
    const { db, queries } = makeFakeDb();
    const noteId = { toString: () => "note:abc" } as never;
    await deletePendingProposals(db, {
      tables: ["supports", "contradicts"],
      agent: "linker",
      noteId,
    });
    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toContain("DELETE supports");
    expect(queries[1].sql).toContain("DELETE contradicts");
  });

  test("never touches approved edges", async () => {
    const { db, queries } = makeFakeDb();
    await deletePendingProposals(db, { tables: ["synthesizes"], agent: "synthesizer" });
    expect(queries[0].sql).toContain("approved = false");
  });

  test("scopes to the agent so agents cannot clobber each other", async () => {
    const { db, queries } = makeFakeDb();
    await deletePendingProposals(db, { tables: ["synthesizes"], agent: "synthesizer" });
    expect(queries[0].sql).toContain("source = $agent");
    expect(queries[0].sql).toContain("agent = $agent");
    expect(queries[0].sql).not.toContain(" OR ");
    expect(queries[0].bindings.agent).toBe("synthesizer");
  });

  test("cannot delete a user proposal whose client identity matches an agent name", async () => {
    const { db, queries } = makeFakeDb();
    await deletePendingProposals(db, { tables: ["supports"], agent: "linker" });
    expect(queries[0].sql).toContain("source = $agent AND agent = $agent");
    expect(queries[0].sql).not.toContain("agent = $agent OR");
  });

  test("omits the note filter when no note is given", async () => {
    const { db, queries } = makeFakeDb();
    await deletePendingProposals(db, { tables: ["contradicts"], agent: "contradictionHunter" });
    expect(queries[0].sql).not.toContain("in = $note");
    expect(queries[0].bindings.note).toBeUndefined();
  });

  test("adds the note filter when a note is given", async () => {
    const { db, queries } = makeFakeDb();
    const noteId = { toString: () => "note:abc" } as never;
    await deletePendingProposals(db, { tables: ["supports"], agent: "linker", noteId });
    expect(queries[0].sql).toContain("(in = $note OR out = $note)");
    expect(queries[0].bindings.note).toBe(noteId);
  });
});
