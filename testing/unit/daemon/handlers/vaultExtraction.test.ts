import { describe, expect, test } from "bun:test";
import { RecordId, type Surreal } from "surrealdb";
import {
  collectExtraction,
  makeVaultExtractionHandler,
} from "../../../../src/daemon/handlers/vaultExtraction";
import { rpcRequest } from "../../../rpcRequest";

type Responder = (sql: string, bindings: Record<string, unknown>) => unknown[];

function makeFakeDb(respond: Responder): { db: Surreal; queries: string[] } {
  const queries: string[] = [];
  const db = {
    query: (sql: string, bindings: Record<string, unknown> = {}) => {
      queries.push(sql);
      return { collect: async () => [respond(sql, bindings)] };
    },
  } as unknown as Surreal;
  return { db, queries };
}

const NOTE_ID = new RecordId("note", "one");
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NOTE_ROW = [{ id: NOTE_ID, sha: EMPTY_SHA }];
const CHUNK_ONE = new RecordId("chunk", "one");
const CHUNK_TWO = new RecordId("chunk", "two");
const CHUNK_THREE = new RecordId("chunk", "three");
const PRESENT_VAULT = { exists: async () => true, read: async () => "" };

describe("collectExtraction", () => {
  test("an unindexed note returns three empty groups rather than throwing", async () => {
    const { db } = makeFakeDb((sql) => (sql.includes("FROM note") ? [] : []));
    const result = await collectExtraction({ db, vault: PRESENT_VAULT }, "missing.md");
    expect(result).toEqual({
      ok: true,
      notePath: "missing.md",
      concepts: [],
      claims: [],
      questions: [],
    });
  });

  test("reads concepts from mentions, claims from asserts, questions from asks", async () => {
    const { db, queries } = makeFakeDb((sql) => {
      if (sql.includes("FROM note")) return NOTE_ROW;
      if (sql.includes("FROM mentions")) {
        return [
          {
            target: new RecordId("concept", "one"),
            text: "vector search",
            kind: "topic",
            confidence: 0.9,
            evidence: [CHUNK_ONE],
          },
        ];
      }
      if (sql.includes("FROM asserts")) {
        return [
          {
            target: new RecordId("claim", "one"),
            text: "HNSW is fast",
            kind: null,
            confidence: 0.7,
            evidence: [CHUNK_ONE],
          },
        ];
      }
      if (sql.includes("FROM asks")) {
        return [
          {
            target: new RecordId("question", "one"),
            text: "why?",
            kind: null,
            confidence: 0.4,
            evidence: [CHUNK_ONE],
          },
        ];
      }
      if (sql.includes("FROM chunk")) return [{ text: "evidence", notePath: "a.md" }];
      return [];
    });
    const result = await collectExtraction({ db, vault: PRESENT_VAULT }, "a.md");
    expect(result.concepts[0]?.text).toBe("vector search");
    expect(result.claims[0]?.text).toBe("HNSW is fast");
    expect(result.questions[0]?.text).toBe("why?");
    expect(queries.some((sql) => sql.includes("out.label AS text"))).toBe(true);
    expect(queries.filter((sql) => sql.includes("out.text AS text"))).toHaveLength(2);
  });

  test("one query covers rows anchored on the note and on its blocks", async () => {
    const { db, queries } = makeFakeDb((sql) => (sql.includes("FROM note") ? NOTE_ROW : []));
    await collectExtraction({ db, vault: PRESENT_VAULT }, "a.md");
    expect(queries.some((sql) => sql.includes("in = $note OR in.note = $note"))).toBe(true);
    expect(queries.some((sql) => sql.includes("tombstoned_at"))).toBe(true);
  });

  test("items are sorted strongest first", async () => {
    const { db } = makeFakeDb((sql) => {
      if (sql.includes("FROM note")) return NOTE_ROW;
      if (sql.includes("FROM mentions")) {
        return [
          {
            target: new RecordId("concept", "weak"),
            text: "weak",
            kind: null,
            confidence: 0.2,
            evidence: [CHUNK_ONE],
          },
          {
            target: new RecordId("concept", "strong"),
            text: "strong",
            kind: null,
            confidence: 0.95,
            evidence: [CHUNK_ONE],
          },
        ];
      }
      if (sql.includes("FROM chunk")) return [{ text: "evidence", notePath: "a.md" }];
      return [];
    });
    const result = await collectExtraction({ db, vault: PRESENT_VAULT }, "a.md");
    expect(result.concepts.map((item) => item.text)).toEqual(["strong", "weak"]);
  });

  test("the same target reached through two blocks appears once", async () => {
    const { db } = makeFakeDb((sql) => {
      if (sql.includes("FROM note")) return NOTE_ROW;
      if (sql.includes("FROM mentions")) {
        return [
          {
            target: new RecordId("concept", "one"),
            text: "dup",
            kind: null,
            confidence: 0.5,
            evidence: [CHUNK_ONE],
          },
          {
            target: new RecordId("concept", "one"),
            text: "dup",
            kind: null,
            confidence: 0.5,
            evidence: [CHUNK_ONE],
          },
        ];
      }
      if (sql.includes("FROM chunk")) return [{ text: "evidence", notePath: "a.md" }];
      return [];
    });
    expect((await collectExtraction({ db, vault: PRESENT_VAULT }, "a.md")).concepts).toHaveLength(
      1,
    );
  });

  test("evidence resolves to chunk text and is capped at two snippets", async () => {
    const { db } = makeFakeDb((sql, bindings) => {
      if (sql.includes("FROM note")) return NOTE_ROW;
      if (sql.includes("FROM mentions")) {
        return [
          {
            target: new RecordId("concept", "one"),
            text: "c",
            kind: null,
            confidence: 0.5,
            evidence: [CHUNK_ONE, CHUNK_TWO, CHUNK_THREE],
          },
        ];
      }
      if (sql.includes("FROM chunk")) {
        return [{ text: `body ${String(bindings.id)}`, notePath: "a.md" }];
      }
      return [];
    });
    const result = await collectExtraction({ db, vault: PRESENT_VAULT }, "a.md");
    expect(result.concepts[0]?.evidence).toHaveLength(2);
    expect(result.concepts[0]?.evidence[1]?.chunkId).toBe(CHUNK_TWO.toString());
  });

  test("malformed confidence and ids fail closed", async () => {
    const { db } = makeFakeDb((sql) => {
      if (sql.includes("FROM note")) return NOTE_ROW;
      if (sql.includes("FROM asserts")) {
        return [
          {
            target: new RecordId("claim", "one"),
            text: "x",
            kind: null,
            confidence: null,
            evidence: [CHUNK_ONE],
          },
        ];
      }
      return [];
    });
    await expect(collectExtraction({ db, vault: PRESENT_VAULT }, "a.md")).rejects.toThrow(
      "asserts extraction confidence is invalid",
    );

    const { db: malformedNoteDb } = makeFakeDb((sql) =>
      sql.includes("FROM note") ? [{ id: "note:one" }] : [],
    );
    await expect(
      collectExtraction({ db: malformedNoteDb, vault: PRESENT_VAULT }, "a.md"),
    ).rejects.toThrow("note lookup returned an invalid current note row");
  });

  test("binds extraction reads to the current on-disk note digest", async () => {
    const bindingsSeen: Array<Record<string, unknown>> = [];
    const { db, queries } = makeFakeDb((sql, bindings) => {
      bindingsSeen.push(bindings);
      if (sql.includes("FROM note")) return [];
      throw new Error("stale note state must not reach extraction rows");
    });
    const result = await collectExtraction(
      { db, vault: { exists: async () => true, read: async () => "changed body" } },
      "a.md",
    );
    expect(result.concepts).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("sha = $sha");
    expect(queries[0]).toContain("tombstoned_at IS NONE");
    expect(bindingsSeen[0]?.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(bindingsSeen[0]?.sha).not.toBe(EMPTY_SHA);
  });
});

describe("vault.extraction handler", () => {
  test("requires an exact ordinary public notePath", async () => {
    const { db } = makeFakeDb(() => []);
    const handler = makeVaultExtractionHandler({ db, vault: PRESENT_VAULT });
    await expect(handler(rpcRequest())).rejects.toThrow(
      "exact ordinary public vault-relative Markdown note path",
    );
    await expect(handler(rpcRequest({ notePath: "   " }))).rejects.toThrow(
      "exact ordinary public vault-relative Markdown note path",
    );
  });

  test("rejects alternate path spellings before querying", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const db = {
      query: (_sql: string, bindings: Record<string, unknown> = {}) => {
        captured.push(bindings);
        return { collect: async () => [[]] };
      },
    } as unknown as Surreal;
    const handler = makeVaultExtractionHandler({ db, vault: PRESENT_VAULT });
    await expect(handler(rpcRequest({ notePath: " a.md " }))).rejects.toThrow(
      "exact ordinary public vault-relative Markdown note path",
    );
    expect(captured).toHaveLength(0);
  });

  test("rejects Notient-owned artifacts before touching the vault or database", async () => {
    const vaultCalls: string[] = [];
    const { db, queries } = makeFakeDb(() => {
      throw new Error("database must not be queried");
    });
    const handler = makeVaultExtractionHandler({
      db,
      vault: {
        exists: async (path) => {
          vaultCalls.push(path);
          return true;
        },
        read: async (path) => {
          vaultCalls.push(path);
          return "private";
        },
      },
    });

    for (const notePath of ["Notient/conversations/private.md", "Notient/proposals/pending.md"]) {
      await expect(handler(rpcRequest({ notePath }))).rejects.toThrow(
        "exact ordinary public vault-relative Markdown note path",
      );
      await expect(collectExtraction({ db, vault: PRESENT_VAULT }, notePath)).rejects.toThrow(
        "exact ordinary public vault-relative Markdown note path",
      );
    }
    expect(vaultCalls).toEqual([]);
    expect(queries).toEqual([]);
  });

  test("does not query cached extraction state when the public note is absent", async () => {
    const { db, queries } = makeFakeDb(() => {
      throw new Error("database must not be queried");
    });
    const result = await collectExtraction(
      {
        db,
        vault: {
          exists: async () => false,
          read: async () => {
            throw new Error("absent note must not be read");
          },
        },
      },
      "gone.md",
    );
    expect(result).toEqual({
      ok: true,
      notePath: "gone.md",
      concepts: [],
      claims: [],
      questions: [],
    });
    expect(queries).toHaveLength(0);
  });

  test("requires evidence to belong to an ordinary public source note", async () => {
    for (const projectedPath of [
      ".hidden.md",
      "Notient/conversations/private.md",
      "Notient/proposals/pending.md",
    ]) {
      const { db } = makeFakeDb((sql) => {
        if (sql.includes("FROM note")) return NOTE_ROW;
        if (sql.includes("FROM mentions")) {
          return [
            {
              target: new RecordId("concept", "one"),
              text: "private evidence",
              kind: null,
              confidence: 0.8,
              evidence: [CHUNK_ONE],
            },
          ];
        }
        if (sql.includes("FROM chunk")) return [{ text: "cached", notePath: projectedPath }];
        return [];
      });
      await expect(collectExtraction({ db, vault: PRESENT_VAULT }, "a.md")).rejects.toThrow(
        "did not return one text row",
      );
    }
  });
});
