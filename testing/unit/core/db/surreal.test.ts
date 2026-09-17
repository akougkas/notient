import { describe, expect, test } from "bun:test";
import { DateTime, RecordId, type Surreal } from "surrealdb";
import {
  type RelateEdgeInput,
  expandTypedEdgeNeighbors,
  expandWikilinkNeighbors,
  fetchChunksForTier3,
  fetchFirstChunkTextByPath,
  fetchNoteShaByPath,
  fetchNoteTierState,
  linkerNeighbors,
  relateEdge,
  replaceChunks,
  searchBm25,
  searchVector,
  searchVectorWithPath,
} from "../../../../src/core/db/surreal";
import { STRUCTURAL_INDEX_VERSION } from "../../../../src/core/markdown/types";

interface RecordedQuery {
  sql: string;
  bindings: Record<string, unknown> | undefined;
}

/**
 * Minimal `Surreal` stand-in that records the SQL each DAL call issues and
 * replays canned result slices. These tests assert query text, not server
 * behaviour, so a real SurrealDB is not needed.
 */
function makeFakeDb(resultsFor: (sql: string) => unknown[]): {
  db: Surreal;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const db = {
    query(sql: string, bindings?: Record<string, unknown>) {
      queries.push({ sql, bindings });
      const results = resultsFor(sql);
      return { collect: async () => results };
    },
  } as unknown as Surreal;
  return { db, queries };
}

describe("note indexing state integrity", () => {
  test("an older parser receipt requires structural repair while retaining inference receipts", async () => {
    const db = makeFakeDb(() => [
      [
        {
          tier1_at: new DateTime(new Date(1)),
          tier2_at: new DateTime(new Date(2)),
          tier3_at: new DateTime(new Date(3)),
          structural_version: undefined,
        },
      ],
    ]);
    expect(await fetchNoteTierState(db.db, "a.md")).toEqual({
      tier1Done: false,
      tier2Done: true,
      tier3Done: true,
    });
  });
  test("requires the existing note sha instead of treating corruption as a fresh row", async () => {
    const valid = makeFakeDb(() => [[{ sha: "fixture-sha" }]]);
    expect(await fetchNoteShaByPath(valid.db, "a.md")).toBe("fixture-sha");

    const malformed = makeFakeDb(() => [[{ sha: null }]]);
    await expect(fetchNoteShaByPath(malformed.db, "a.md")).rejects.toThrow(
      "existing note has an invalid sha",
    );
  });

  test("accepts only absent or valid datetime tier stamps", async () => {
    const valid = makeFakeDb(() => [
      [
        {
          tier1_at: new DateTime(new Date(1)),
          structural_version: STRUCTURAL_INDEX_VERSION,
          tier2_at: undefined,
          tier3_at: new DateTime("2026-08-29T00:00:00.000Z"),
        },
      ],
    ]);
    expect(await fetchNoteTierState(valid.db, "a.md")).toEqual({
      tier1Done: true,
      tier2Done: false,
      tier3Done: true,
    });

    const malformed = makeFakeDb(() => [
      [
        {
          tier1_at: false,
          tier2_at: undefined,
          tier3_at: undefined,
          structural_version: undefined,
        },
      ],
    ]);
    await expect(fetchNoteTierState(malformed.db, "a.md")).rejects.toThrow(
      "tier1_at is not a native SurrealDB datetime",
    );

    const nullAlias = makeFakeDb(() => [
      [{ tier1_at: undefined, tier2_at: null, tier3_at: undefined, structural_version: undefined }],
    ]);
    await expect(fetchNoteTierState(nullAlias.db, "a.md")).rejects.toThrow(
      "tier2_at is not a native SurrealDB datetime",
    );
  });
});

describe("linkerNeighbors query", () => {
  test("excludes block-anchored wikilinks in both directions and skips tombstoned notes", async () => {
    const { db, queries } = makeFakeDb(() => [[], [], []]);
    await linkerNeighbors(db, {
      activeNoteId: new RecordId("note", "active"),
      activeChunkVectors: [[0.1, 0.2]],
      k: 5,
    });
    const sql = queries[0].sql;
    // Tier 1 anchors wikilinks on `block` records whose `note` field points at
    // the note, so an exclusion that only walks note-to-note edges misses them.
    expect(sql).toContain("in.note = $active");
    expect(sql).toContain("in.note ?? in");
    expect(sql).toContain("tombstoned_at IS NONE");
  });

  test("rejects a non-hydrated note instead of manufacturing a blank path", async () => {
    const { db } = makeFakeDb(() => [
      [],
      [],
      [
        {
          id: new RecordId("chunk", "candidate"),
          note: new RecordId("note", "candidate"),
          d: 0.2,
        },
      ],
    ]);
    await expect(
      linkerNeighbors(db, {
        activeNoteId: new RecordId("note", "active"),
        activeChunkVectors: [[0.1, 0.2]],
        k: 5,
      }),
    ).rejects.toThrow("parent note was not hydrated");
  });
});

describe("vector search row integrity", () => {
  test("requires FETCH note to return one hydrated native note", async () => {
    const { db } = makeFakeDb(() => [
      [
        {
          id: new RecordId("chunk", "candidate"),
          note: new RecordId("note", "candidate"),
          text: "candidate text",
          d: 0.1,
        },
      ],
    ]);
    await expect(searchVector(db, { vector: [0.1, 0.2], k: 1 })).rejects.toThrow(
      "parent note was not hydrated",
    );
  });
});

describe("expandWikilinkNeighbors query", () => {
  test("has no path that admits pending or unapplied links", async () => {
    const { db, queries } = makeFakeDb(() => [[]]);
    await expandWikilinkNeighbors(db, {
      startNoteIds: [new RecordId("note", "a")],
    });
    expect(queries[0].sql).toContain("approved = true AND applied = true");
  });
});

describe("expandTypedEdgeNeighbors query", () => {
  test("uses only approved, applied edges with live endpoints", async () => {
    const { db, queries } = makeFakeDb(() => [[], [], [], [], [], []]);
    await expandTypedEdgeNeighbors(db, {
      startNoteIds: [new RecordId("note", "a")],
    });
    const sql = queries[0].sql;
    expect(sql).toContain("approved = true AND applied = true");
    expect(sql).not.toContain("approved = false");
    expect(sql).toContain("tombstoned_at IS NONE");
  });
});

describe("fetchFirstChunkTextByPath query", () => {
  test("skips chunks whose note is tombstoned", async () => {
    const { db, queries } = makeFakeDb((sql) =>
      sql.includes("FROM note") ? [[{ id: new RecordId("note", "a"), path: "a.md" }]] : [[]],
    );
    await fetchFirstChunkTextByPath(db, ["a.md"]);
    const chunkQuery = queries.find((q) => q.sql.includes("FROM chunk"));
    expect(chunkQuery).toBeDefined();
    expect(chunkQuery?.sql).toContain("tombstoned_at IS NONE");
  });
});

describe("relateEdge extractor provenance", () => {
  const note = new RecordId<"note">("note", "source");
  const concept = new RecordId<"concept">("concept", "target");
  const chunk = new RecordId<"chunk">("chunk", "evidence");

  test("the input type requires non-empty evidence for extractor relations", () => {
    // @ts-expect-error Extractor relations cannot be constructed without evidence.
    const missingEvidence: RelateEdgeInput = {
      table: "mentions",
      from: note,
      to: concept,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.9,
    };
    void missingEvidence;

    const deterministic: RelateEdgeInput = {
      table: "wikilink",
      from: note,
      to: new RecordId("note", "other"),
      source: "wikilink",
      confidenceClass: "EXTRACTED",
      confidence: 1,
    };
    expect(deterministic.evidence).toBeUndefined();
  });

  test("rejects an empty extractor evidence array before issuing a query", async () => {
    const { db, queries } = makeFakeDb(() => []);
    const input = {
      table: "mentions",
      from: note,
      to: concept,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.9,
      evidence: [],
    } as unknown as RelateEdgeInput;

    await expect(relateEdge(db, input)).rejects.toThrow("requires at least one current chunk");
    expect(queries).toHaveLength(0);
  });

  test("rejects evidence that is not a current chunk of the source note", async () => {
    const { db, queries } = makeFakeDb(() => [[]]);

    await expect(
      relateEdge(db, {
        table: "mentions",
        from: note,
        to: concept,
        source: "extractor",
        confidenceClass: "INFERRED",
        confidence: 0.9,
        evidence: [chunk],
      }),
    ).rejects.toThrow("must name current chunks from its source note");
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("FROM chunk WHERE id INSIDE $evidence AND note = $note");
  });

  test("rejects duplicate extractor evidence before querying storage", async () => {
    const { db, queries } = makeFakeDb(() => []);
    await expect(
      relateEdge(db, {
        table: "mentions",
        from: note,
        to: concept,
        source: "extractor",
        confidenceClass: "INFERRED",
        confidence: 0.9,
        evidence: [chunk, chunk],
      }),
    ).rejects.toThrow("must not contain duplicate chunks");
    expect(queries).toHaveLength(0);
  });

  test("relates an extractor edge only after its evidence is verified", async () => {
    const { db, queries } = makeFakeDb((sql) =>
      sql.startsWith("SELECT id FROM chunk") ? [[{ id: chunk }]] : [],
    );

    await relateEdge(db, {
      table: "mentions",
      from: note,
      to: concept,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.9,
      evidence: [chunk],
    });

    expect(queries).toHaveLength(2);
    expect(queries[1]?.sql).toContain("RELATE $from->mentions->$to");
    expect(queries[1]?.bindings?.evidence).toEqual([chunk]);
  });

  test("other edge families still relate without evidence", async () => {
    const { db, queries } = makeFakeDb(() => []);

    await relateEdge(db, {
      table: "supports",
      from: note,
      to: new RecordId("note", "other"),
      source: "linker",
      confidenceClass: "INFERRED",
      confidence: 0.8,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).not.toContain("evidence = $evidence");
  });

  test("optional evidence must be omitted or a non-empty native chunk set", async () => {
    const corruptions = [
      { evidence: [], message: "omitted or contain at least one chunk" },
      { evidence: [new RecordId("note", "wrong")], message: "only chunk records" },
      { evidence: [chunk, chunk], message: "must not contain duplicate chunks" },
    ];
    for (const corruption of corruptions) {
      const { db, queries } = makeFakeDb(() => []);
      const input = {
        table: "supports",
        from: note,
        to: new RecordId("note", "other"),
        source: "linker",
        confidenceClass: "INFERRED",
        confidence: 0.8,
        evidence: corruption.evidence,
      } as unknown as RelateEdgeInput;
      await expect(relateEdge(db, input)).rejects.toThrow(corruption.message);
      expect(queries).toHaveLength(0);
    }
  });

  test("persists one canonical optional evidence array unchanged", async () => {
    const { db, queries } = makeFakeDb(() => []);
    await relateEdge(db, {
      table: "supports",
      from: note,
      to: new RecordId("note", "other"),
      source: "linker",
      confidenceClass: "INFERRED",
      confidence: 0.8,
      evidence: [chunk],
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("evidence = $evidence");
    expect(queries[0]?.bindings?.evidence).toEqual([chunk]);
  });
});

describe("Tier 2 embedding identity", () => {
  const identity = { model: "fixture-space", dimension: 3 } as const;

  test("rejects a wrong-width fixture before deleting stored chunks", async () => {
    const { db, queries } = makeFakeDb(() => []);

    await expect(
      replaceChunks(db, new RecordId("note", "a"), identity, [
        { ord: 0, text: "wrong", tokenEstimate: 1, vector: [0.1, 0.2] },
      ]),
    ).rejects.toThrow("requires 3");
    expect(queries).toHaveLength(0);
  });

  test("rejects blank searchable text before deleting stored chunks", async () => {
    const { db, queries } = makeFakeDb(() => []);

    await expect(
      replaceChunks(db, new RecordId("note", "a"), identity, [
        { ord: 0, text: " \n\t ", tokenEstimate: 1, vector: [0.1, 0.2, 0.3] },
      ]),
    ).rejects.toThrow("contains no searchable text");
    expect(queries).toHaveLength(0);
  });

  test("stamps every replacement chunk from the one batch identity", async () => {
    const insertedId = new RecordId<"chunk">("chunk", "inserted");
    const { db, queries } = makeFakeDb((sql) =>
      sql.startsWith("DELETE") ? [] : [{ id: insertedId }],
    );

    await replaceChunks(db, new RecordId("note", "a"), identity, [
      { ord: 0, text: "first", tokenEstimate: 1, vector: [0.1, 0.2, 0.3] },
      { ord: 1, text: "second", tokenEstimate: 1, vector: [0.4, 0.5, 0.6] },
    ]);

    const inserts = queries.filter((query) => query.sql.startsWith("CREATE ONLY chunk"));
    expect(inserts).toHaveLength(2);
    expect(inserts.every((query) => query.bindings?.embedModel === identity.model)).toBe(true);
  });

  test("Tier 3 reads only chunks from the requested embedding space", async () => {
    const chunkId = new RecordId("chunk", "abcdefghijklmnopqrst");
    const { db, queries } = makeFakeDb(() => [
      [{ id: chunkId, ord: 0, text: "canonical text", vector: [0.1, 0.2, 0.3] }],
    ]);

    expect(await fetchChunksForTier3(db, new RecordId("note", "a"), identity)).toEqual([
      { id: chunkId, ord: 0, text: "canonical text", vector: [0.1, 0.2, 0.3] },
    ]);

    expect(queries[0].sql).toContain("embed_model = $embedModel");
    expect(queries[0].sql).toContain("array::len(vector) = $embedDimension");
    expect(queries[0].bindings).toMatchObject({
      embedModel: identity.model,
      embedDimension: identity.dimension,
    });
  });

  test.each([
    [[{ id: new RecordId("chunk", "abcdefghijklmnopqrst"), ord: 0, text: "x", vector: [0.1] }]],
    [[{ id: "chunk:abcdefghijklmnopqrst", ord: 0, text: "x", vector: [0.1, 0.2, 0.3] }]],
    [
      [
        {
          id: new RecordId("chunk", "abcdefghijklmnopqrst"),
          ord: 0,
          text: "x",
          vector: [0.1, 0.2, 0.3],
          legacy: true,
        },
      ],
    ],
  ])("rejects malformed Tier 3 chunk storage rows %#", async (rows) => {
    const { db } = makeFakeDb(() => [rows]);
    await expect(fetchChunksForTier3(db, new RecordId("note", "a"), identity)).rejects.toThrow(
      "storage integrity",
    );
  });
});

describe("search evidence text", () => {
  test("excludes blank chunks in vector and BM25 readers", async () => {
    const { db, queries } = makeFakeDb(() => [[]]);

    expect(await searchVectorWithPath(db, { vector: [0.1, 0.2], k: 3 })).toEqual([]);
    expect(await searchBm25(db, { query: "evidence", limit: 3 })).toEqual([]);

    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.sql).toContain("string::len(string::trim(text)) > 0");
    }
  });

  test.each([".private.md", "notes/cache.txt", "notes/../private.md"])(
    "rejects non-public parent path %s before returning cached chunk text",
    async (notePath) => {
      const { db } = makeFakeDb(() => [
        [
          {
            id: new RecordId("chunk", "candidate"),
            note: { id: new RecordId("note", "candidate"), path: notePath },
            text: "cached private text",
            d: 0.1,
          },
        ],
      ]);
      await expect(searchVectorWithPath(db, { vector: [0.1, 0.2], k: 1 })).rejects.toThrow(
        "parent note path is invalid",
      );
    },
  );
});
