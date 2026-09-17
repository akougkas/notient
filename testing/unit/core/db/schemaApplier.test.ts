import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { AGENT_ID_PATTERN } from "../../../../src/core/auth/agentIdentity";
import { EDGE_TABLES } from "../../../../src/core/db/edgeTables";
import { type ApplySchemaOptions, applySchema } from "../../../../src/core/db/schemaApplier";

interface RecordedCall {
  method: "set" | "query";
  args: unknown[];
  index: number;
}

interface FakeOptions {
  /** `tables` map returned by `INFO FOR DB`. */
  dbTables?: unknown;
  /** Rows returned by `SELECT value FROM meta WHERE key = 'embedding'`. */
  metaRows?: unknown;
  metaError?: Error;
  /** `indexes` map returned by `INFO FOR TABLE chunk`. */
  chunkIndexes?: unknown;
  chunkInfoError?: Error;
  /** Rows returned by the unidentified-vector guard. */
  orphanVectorRows?: unknown;
  orphanVectorError?: Error;
}

function createFakeSurreal(options: FakeOptions = {}): {
  db: Surreal;
  calls: RecordedCall[];
  queries: () => string[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;

  const replyOrThrow = (error: Error | undefined, value: unknown): unknown[] => {
    if (error !== undefined) throw error;
    return [value];
  };

  const replyFor = (sql: string): unknown[] => {
    if (sql.includes("SELECT id, payload FROM proposal_review")) return [[]];
    if (sql.includes("INFO FOR DB")) return [{ tables: options.dbTables ?? {} }];
    if (sql.includes("FROM meta")) return replyOrThrow(options.metaError, options.metaRows ?? []);
    if (sql.includes("FROM chunk WHERE vector != NONE"))
      return replyOrThrow(options.orphanVectorError, options.orphanVectorRows ?? []);
    if (sql.includes("INFO FOR TABLE chunk"))
      return replyOrThrow(options.chunkInfoError, { indexes: options.chunkIndexes ?? {} });
    return [];
  };

  const stub = {
    set(key: string, value: unknown): Promise<void> {
      calls.push({ method: "set", args: [key, value], index: index++ });
      return Promise.resolve();
    },
    query(sql: string, bindings?: unknown): unknown {
      calls.push({ method: "query", args: [sql, bindings], index: index++ });
      const reply = replyFor(sql);
      // The SDK returns a thenable that also exposes `collect()`. The applier
      // uses both shapes, so the fake must satisfy both.
      return Object.assign(Promise.resolve(reply), {
        collect: () => Promise.resolve(reply),
      });
    },
  };
  // Justified cast: the applier uses only `set` and `query`, so a minimal stub
  // is sufficient for behavioral tests without pulling in the full SDK shape.
  return {
    db: stub as unknown as Surreal,
    calls,
    queries: () => calls.filter((call) => call.method === "query").map((c) => c.args[0] as string),
  };
}

describe("applySchema", () => {
  test("rejects a half-resolved or invalid embedding identity before touching Surreal", async () => {
    const { db, calls } = createFakeSurreal();

    await expect(
      applySchema(db, "secret", {
        embedDim: 768,
        embedModel: null,
      } as unknown as ApplySchemaOptions),
    ).rejects.toThrow("resolved positive-width identity or null together");
    await expect(
      applySchema(db, "secret", {
        embedDim: 0,
        embedModel: "fixture-model",
      }),
    ).rejects.toThrow("resolved positive-width identity or null together");
    expect(calls).toHaveLength(0);
  });

  test("calls set with NOTIENT_AGENT_JWT_KEY before any query", async () => {
    const { db, calls } = createFakeSurreal();

    await applySchema(db, "test-secret-value", {
      embedDim: 768,
      embedModel: "fixture-model",
    });

    const setCalls = calls.filter((call) => call.method === "set");
    const queryCalls = calls.filter((call) => call.method === "query");

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.args[0]).toBe("NOTIENT_AGENT_JWT_KEY");
    expect(setCalls[0]?.args[1]).toBe("test-secret-value");
    expect(queryCalls.length).toBeGreaterThan(0);
    const firstQueryIndex = queryCalls[0]?.index ?? -1;
    expect(setCalls[0]?.index).toBeLessThan(firstQueryIndex);
  });

  test("base schema query contains the canonical DDL strings", async () => {
    const { db, queries } = createFakeSurreal();

    await applySchema(db, "secret", { embedDim: 768, embedModel: "fixture-model" });

    const combined = queries().join("\n");

    expect(combined).toContain("DEFINE NAMESPACE IF NOT EXISTS notient");
    expect(combined).toContain("DEFINE TABLE OVERWRITE note SCHEMAFULL");
    expect(combined).toContain(`string::matches($value, "${AGENT_ID_PATTERN.source}")`);
    expect(combined).not.toContain("{{AGENT_ID_PATTERN}}");
    expect(combined).toContain("$value >= 1 AND $value <= 6");
    expect(combined).toContain(
      "DEFINE FIELD OVERWRITE linker_refresh_pending ON note TYPE bool DEFAULT false",
    );
    expect(combined).toContain("DEFINE TABLE OVERWRITE wikilink TYPE RELATION");
    expect(combined).toContain(
      "DEFINE TABLE OVERWRITE mentions TYPE RELATION FROM note|block TO concept ENFORCED SCHEMAFULL",
    );
    expect(combined).toContain(
      "DEFINE TABLE OVERWRITE asserts TYPE RELATION FROM note|block TO claim ENFORCED SCHEMAFULL",
    );
    expect(combined).toContain(
      "DEFINE TABLE OVERWRITE asks TYPE RELATION FROM note|block TO question ENFORCED SCHEMAFULL",
    );
    expect(combined).toContain("DEFINE TABLE OVERWRITE meta SCHEMAFULL");
    expect(combined).toContain("DEFINE INDEX OVERWRITE meta_key ON meta FIELDS key UNIQUE");
    expect(combined).toContain(
      "DEFINE FIELD OVERWRITE kind ON concept TYPE string DEFAULT 'other'",
    );
    expect(combined).toContain(
      "DEFINE FIELD OVERWRITE source ON concept TYPE string DEFAULT 'extractor'",
    );
    expect(combined).toContain(
      "DEFINE FIELD OVERWRITE kind ON claim TYPE string DEFAULT 'assertion'",
    );
    expect(combined).not.toContain("DEFINE FIELD OVERWRITE seq ON agent_run");
    expect(combined).toContain(
      "ASSERT $value INSIDE ['chat.auto_approve','note.append_section','note.frontmatter','notes.move','notes.create','notes.append','notes.replace_section','notes.update_frontmatter','proposal.reject']",
    );
    expect(combined).toContain(
      "ASSERT $value INSIDE ['chat:usage','job:changed','swarm:contradiction_discovered','swarm:claim_advanced','swarm:link_proposed','indexer:note-indexed','indexer:tombstoned','indexer:error','indexer:warn']",
    );
    expect(combined).not.toContain("DEFINE INDEX OVERWRITE agent_run_seq");
    expect(combined).toContain("DEFINE ACCESS OVERWRITE agent_jwt");
  });

  test("repairs dangling extractor edges once before upgrading relation enforcement", async () => {
    const { db, queries } = createFakeSurreal({
      dbTables: {
        mentions:
          "DEFINE TABLE mentions TYPE RELATION IN note|block OUT concept SCHEMAFULL PERMISSIONS NONE",
        asserts:
          "DEFINE TABLE asserts TYPE RELATION IN note|block OUT claim ENFORCED SCHEMAFULL PERMISSIONS NONE",
        asks: "DEFINE TABLE asks TYPE RELATION IN note|block OUT question SCHEMAFULL PERMISSIONS NONE",
      },
    });

    await applySchema(db, "secret", { embedDim: 768, embedModel: "fixture-model" });

    const allQueries = queries();
    const repairAt = allQueries.findIndex((sql) =>
      sql.includes("DELETE mentions WHERE !record::exists(in)"),
    );
    const schemaAt = allQueries.findIndex((sql) =>
      sql.includes("DEFINE TABLE OVERWRITE mentions TYPE RELATION"),
    );
    expect(repairAt).toBeGreaterThan(-1);
    expect(repairAt).toBeLessThan(schemaAt);
    expect(allQueries[repairAt]).toContain(
      "DELETE asks WHERE !record::exists(in) OR !record::exists(out) RETURN NONE;",
    );
    expect(allQueries[repairAt]).not.toContain("DELETE asserts WHERE");
  });

  test("provenance query emits one source field per edge table", async () => {
    const { db, queries } = createFakeSurreal();

    await applySchema(db, "secret", { embedDim: 768, embedModel: "fixture-model" });

    const provenanceSql = queries().find((sql) =>
      sql.includes("DEFINE FIELD OVERWRITE source ON related_to"),
    );
    expect(provenanceSql).toBeDefined();
    expect(provenanceSql).toContain("DEFINE FIELD OVERWRITE source ON wikilink ");

    const sourceFieldMatches = (provenanceSql as string).match(
      /DEFINE FIELD OVERWRITE source ON /g,
    );
    expect(sourceFieldMatches).not.toBeNull();
    expect(sourceFieldMatches?.length).toBe(EDGE_TABLES.length);
    expect(EDGE_TABLES.length).toBe(15);
  });

  test("extractor evidence is strict while every other edge family keeps optional evidence", async () => {
    const { db, queries } = createFakeSurreal();

    await applySchema(db, "secret", {
      embedDim: 768,
      embedModel: "fixture-model",
      log: () => {},
    });

    const allQueries = queries();
    const provenanceAt = allQueries.findIndex((sql) =>
      sql.includes("DEFINE FIELD OVERWRITE source ON related_to"),
    );
    expect(provenanceAt).toBeGreaterThan(-1);
    expect(allQueries.some((sql) => sql.includes("AS note FROM mentions"))).toBe(false);

    const provenance = allQueries[provenanceAt] ?? "";
    for (const table of ["mentions", "asserts", "asks"]) {
      expect(provenance).toContain(
        `DEFINE FIELD OVERWRITE evidence ON ${table} TYPE array<record<chunk>> ASSERT array::len($value) > 0;`,
      );
    }
    expect(provenance).toContain(
      "DEFINE FIELD OVERWRITE evidence ON supports TYPE option<array<record<chunk>>>;",
    );
    expect(provenance).not.toContain(
      "DEFINE FIELD OVERWRITE evidence ON mentions TYPE option<array<record<chunk>>>;",
    );
  });

  test("substitutes the probed dimension into the vector field and HNSW index", async () => {
    const { db, queries } = createFakeSurreal();

    const result = await applySchema(db, "secret", { embedDim: 1024, embedModel: "m" });

    const combined = queries().join("\n");
    expect(combined).toContain("TYPE option<array<float, 1024>>");
    expect(combined).toContain("HNSW DIMENSION 1024");
    expect(combined).not.toContain("{{EMBED_DIM}}");
    expect(result.embedDim).toBe(1024);
    expect(result.indexesDefined).toEqual(["chunk_vec", "chunk_text"]);
  });

  test("skips the vector constraint and HNSW index when the probe failed and nothing is stored", async () => {
    const { db, queries } = createFakeSurreal();

    const result = await applySchema(db, "secret", { embedDim: null, embedModel: null });

    const combined = queries().join("\n");
    expect(combined).toContain("DEFINE FIELD OVERWRITE vector ON chunk TYPE option<array<float>>");
    expect(combined).not.toContain("HNSW DIMENSION");
    expect(result.embedDim).toBeNull();
    expect(result.indexesDefined).toEqual(["chunk_text"]);
  });

  test("falls back to the stored dimension when the probe failed", async () => {
    const { db, queries } = createFakeSurreal({
      metaRows: [{ value: { model: "old-model", dimension: 384 } }],
    });

    const result = await applySchema(db, "secret", { embedDim: null, embedModel: null });

    expect(result.embedDim).toBe(384);
    expect(queries().join("\n")).toContain("HNSW DIMENSION 384");
  });

  test("does not redefine managed indexes that already match", async () => {
    const { db, queries } = createFakeSurreal({
      metaRows: [{ value: { model: "m", dimension: 768 } }],
      chunkIndexes: {
        chunk_vec: "DEFINE INDEX chunk_vec ON chunk FIELDS vector HNSW DIMENSION 768 DIST COSINE",
        chunk_text: "DEFINE INDEX chunk_text ON chunk FIELDS text FULLTEXT",
      },
    });

    const result = await applySchema(db, "secret", { embedDim: 768, embedModel: "m" });

    expect(result.indexesDefined).toEqual([]);
    expect(result.vectorsInvalidated).toBe(false);
    expect("chunksCleared" in result).toBe(false);
    expect(queries().join("\n")).not.toContain("UPDATE chunk SET vector = NONE");
  });

  test("invalidates vectors, preserves Tier 3, and schedules linker repair after indexes", async () => {
    const logs: string[] = [];
    const { db, queries } = createFakeSurreal({
      metaRows: [{ value: { model: "old-model", dimension: 768 } }],
      chunkIndexes: {
        chunk_vec: "DEFINE INDEX chunk_vec ON chunk FIELDS vector HNSW DIMENSION 768 DIST COSINE",
        chunk_text: "DEFINE INDEX chunk_text ON chunk FIELDS text FULLTEXT",
      },
    });

    const result = await applySchema(db, "secret", {
      embedDim: 1024,
      embedModel: "new-model",
      log: (line) => logs.push(line),
    });

    expect(result.vectorsInvalidated).toBe(true);
    expect("chunksCleared" in result).toBe(false);
    expect(result.previousEmbedding).toEqual({ model: "old-model", dimension: 768 });
    const allQueries = queries();
    const combined = allQueries.join("\n");
    expect(combined).toContain("REMOVE INDEX IF EXISTS chunk_vec ON chunk");
    expect(combined).toContain(
      "UPDATE chunk SET vector = NONE, embed_model = NONE, embedded_at = NONE",
    );
    expect(combined).toContain("DELETE conversation_memory;");
    expect(combined).toContain("UPDATE note SET tier2_at = NONE;");
    expect(combined).not.toContain("tier2_at = NONE, tier3_at = NONE");
    expect(combined).not.toContain("UPDATE note SET tier3_at = NONE");
    expect(combined).not.toContain("DELETE chunk");
    expect(combined).not.toContain("DELETE concept");
    expect(combined).not.toContain("DELETE claim");
    expect(combined).not.toContain("DELETE question");
    expect(combined).toContain("UPDATE note SET linker_refresh_pending = true");
    expect(combined).toContain("UPSERT meta:embedding");
    expect(result.indexesDefined).toContain("chunk_vec");

    const invalidateAt = allQueries.findIndex((sql) => sql.includes("UPDATE chunk SET vector"));
    const schemaAt = allQueries.findIndex((sql) =>
      sql.includes("DEFINE FIELD OVERWRITE linker_refresh_pending ON note"),
    );
    const vectorIndexAt = allQueries.findIndex((sql) => sql.includes("HNSW DIMENSION 1024"));
    const scheduleAt = allQueries.findIndex((sql) =>
      sql.includes("UPDATE note SET linker_refresh_pending = true"),
    );
    expect(invalidateAt).toBeLessThan(schemaAt);
    expect(schemaAt).toBeLessThan(vectorIndexAt);
    expect(vectorIndexAt).toBeLessThan(scheduleAt);

    const schedule = allQueries[scheduleAt] ?? "";
    expect(schedule).toContain("BEGIN TRANSACTION;");
    expect(schedule).toContain("UPSERT meta:embedding");
    expect(schedule).toContain("COMMIT TRANSACTION;");

    const changeLog = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    const event = changeLog.find((entry) => entry.type === "daemon:embedding_model_changed");
    expect(event).toBeDefined();
    expect(event?.previous).toEqual({ model: "old-model", dimension: 768 });
    expect(event?.current).toEqual({ model: "new-model", dimension: 1024 });
    expect(event?.vectorsInvalidated).toBe(true);
    expect(event?.chunksCleared).toBeUndefined();
  });

  test("refuses stored vectors whose canonical embedding metadata is missing", async () => {
    const { db, queries } = createFakeSurreal({
      orphanVectorRows: [{ id: "chunk:orphan" }],
      chunkIndexes: {
        chunk_vec: "DEFINE INDEX chunk_vec ON chunk FIELDS vector HNSW DIMENSION 768 DIST COSINE",
        chunk_text: "DEFINE INDEX chunk_text ON chunk FIELDS text FULLTEXT",
      },
    });

    await expect(
      applySchema(db, "secret", {
        embedDim: 1024,
        embedModel: "new-model",
      }),
    ).rejects.toThrow("stored vectors exist without meta:embedding");

    expect(queries().join("\n")).not.toContain("UPDATE chunk SET vector = NONE");
  });

  test("refuses malformed embedding metadata instead of treating it as absent", async () => {
    const { db } = createFakeSurreal({
      metaRows: [{ value: { model: "", dimension: 0 } }],
    });

    await expect(
      applySchema(db, "secret", { embedDim: 768, embedModel: "fixture-model" }),
    ).rejects.toThrow("meta:embedding model is not canonical");
  });

  test("propagates metadata query failures that are not a missing table", async () => {
    const { db } = createFakeSurreal({ metaError: new Error("permission denied") });

    await expect(
      applySchema(db, "secret", { embedDim: 768, embedModel: "fixture-model" }),
    ).rejects.toThrow("permission denied");
  });

  test("refuses malformed chunk index information", async () => {
    const { db } = createFakeSurreal({ chunkIndexes: { chunk_vec: 42 } });

    await expect(
      applySchema(db, "secret", { embedDim: 768, embedModel: "fixture-model" }),
    ).rejects.toThrow("chunk index chunk_vec has non-string DDL");
  });

  test("does not wipe when meta:embedding is missing and no chunk carries a vector", async () => {
    const { db, queries } = createFakeSurreal();

    const result = await applySchema(db, "secret", { embedDim: 1024, embedModel: "new-model" });

    expect(result.vectorsInvalidated).toBe(false);
    expect(queries().join("\n")).not.toContain("UPDATE chunk SET vector = NONE");
  });

  test("runs the heal as one transactional query with the stamp reset before the wipe", async () => {
    const { db, queries } = createFakeSurreal({
      metaRows: [{ value: { model: "old-model", dimension: 768 } }],
    });

    await applySchema(db, "secret", { embedDim: 1024, embedModel: "new-model" });

    const heal = queries().find((sql) => sql.includes("UPDATE chunk SET vector = NONE"));
    expect(heal).toBeDefined();
    const script = heal as string;
    expect(script).toContain("BEGIN TRANSACTION;");
    expect(script).toContain("COMMIT TRANSACTION;");
    expect(script).toContain("REMOVE INDEX IF EXISTS chunk_vec ON chunk");
    expect(script).toContain("UPDATE note SET tier2_at = NONE;");
    expect(script).not.toContain("tier3_at");
    // A crash between an unbatched stamp reset and vector wipe would leave
    // vectors cleared with tier2_at still stamped, so nothing re-embeds.
    expect(script.indexOf("UPDATE note SET tier2_at = NONE")).toBeLessThan(
      script.indexOf("UPDATE chunk SET vector = NONE"),
    );
  });

  test("writes meta:embedding on a first boot with no stored record", async () => {
    const { db, queries } = createFakeSurreal();

    await applySchema(db, "secret", { embedDim: 768, embedModel: "nomic" });

    expect(queries().join("\n")).toContain("UPSERT meta:embedding");
  });
});
