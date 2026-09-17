/**
 * Integration coverage for the parametric-dimension schema applier against a
 * real SurrealDB. Skipped by default; run with `bun run test:smoke` or
 * `NOTIENT_SMOKE=1 bun test testing/integration/core/db`.
 *
 * Covers the three behaviors that only a live server can prove: the
 * `{{EMBED_DIM}}` substitution actually produces valid DDL at a non-768
 * width, `INFO FOR TABLE chunk` reports the managed indexes in the shape the
 * applier parses, and an embedding-model swap invalidates stored vectors,
 * rebuilds the HNSW index at the new width, and preserves the Tier 3 graph.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const secret = "schema-applier-smoke-secret";

interface Fixture {
  tempDir: string;
  handle: SurrealServerHandle;
  connection: SurrealConnection;
}

let active: Fixture | null = null;

async function startFixture(): Promise<Fixture> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-schema-applier-smoke-"));
  const handle = await startSurreal({
    dataDir: path.join(tempDir, "data"),
    secret,
    portFile: path.join(tempDir, "port"),
    pidFile: path.join(tempDir, "pid"),
    logLevel: "warn",
    hnswCacheMib: 64,
  });
  const connection = await connect({
    url: handle.url,
    user: "root",
    pass: secret,
    namespace: "notient",
    database: "vault",
  });
  const fixture = { tempDir, handle, connection };
  active = fixture;
  return fixture;
}

afterEach(async () => {
  if (active === null) return;
  const { tempDir, handle, connection } = active;
  active = null;
  await connection.close();
  await handle.stop();
  await rm(tempDir, { recursive: true, force: true });
}, 30_000);

async function chunkIndexes(connection: SurrealConnection): Promise<Record<string, string>> {
  const [info] = await connection.db
    .query<[{ indexes: Record<string, string> }]>("INFO FOR TABLE chunk;")
    .collect<[{ indexes: Record<string, string> }]>();
  return info.indexes;
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] applySchema dimension handling", () => {
  test("[smoke] block heading levels accept H6 and reject impossible depths", async () => {
    const { connection } = await startFixture();
    await applySchema(connection.db, secret, { embedDim: 4, embedModel: "probe-model-a" });
    const note = await upsertNoteByPath(connection.db, {
      path: "deep.md",
      sha: "deep-sha",
      wordCount: 1,
    });

    await connection.db
      .query(
        "CREATE ONLY block:h6 CONTENT { note: $note, heading_path: ['Deep'], heading_slug: 'deep', heading_level: 6, ord: 0, start_line: 1, end_line: 2, text: 'truth' };",
        { note },
      )
      .collect();
    const [rows] = await connection.db
      .query<[Array<{ heading_level: number }>]>(
        "SELECT heading_level FROM block WHERE id = block:h6;",
      )
      .collect<[Array<{ heading_level: number }>]>();
    expect(rows[0]?.heading_level).toBe(6);

    await expect(
      connection.db
        .query(
          "CREATE ONLY block:h7 CONTENT { note: $note, heading_path: ['Impossible'], heading_slug: 'impossible', heading_level: 7, ord: 1, start_line: 3, end_line: 4, text: 'invalid' };",
          { note },
        )
        .collect(),
    ).rejects.toThrow();
  }, 30_000);

  test("[smoke] applies at a non-768 dimension and records meta:embedding", async () => {
    const { connection } = await startFixture();

    const result = await applySchema(connection.db, secret, {
      embedDim: 1024,
      embedModel: "probe-model-a",
    });

    expect(result.embedDim).toBe(1024);
    expect(result.previousEmbedding).toBeNull();
    expect(result.indexesDefined.sort()).toEqual(["chunk_text", "chunk_vec"]);

    const indexes = await chunkIndexes(connection);
    expect(indexes.chunk_vec).toContain("DIMENSION 1024");

    const [meta] = await connection.db
      .query<[Array<{ value: { model: string; dimension: number } }>]>(
        // `SELECT *`, not `SELECT value`: `value` is a SurrealQL keyword.
        "SELECT * FROM meta WHERE key = 'embedding';",
      )
      .collect<[Array<{ value: { model: string; dimension: number } }>]>();
    expect(meta[0]?.value).toEqual({ model: "probe-model-a", dimension: 1024 });
  }, 30_000);

  test("[smoke] a second boot with the same model redefines nothing", async () => {
    const { connection } = await startFixture();

    await applySchema(connection.db, secret, { embedDim: 512, embedModel: "probe-model-a" });
    const second = await applySchema(connection.db, secret, {
      embedDim: 512,
      embedModel: "probe-model-a",
    });

    expect(second.indexesDefined).toEqual([]);
    expect(second.vectorsInvalidated).toBe(false);
    expect("chunksCleared" in second).toBe(false);
    expect(second.previousEmbedding).toEqual({ model: "probe-model-a", dimension: 512 });
  }, 30_000);

  test("[smoke] a model swap preserves Tier 3 graph while scheduling linker repair", async () => {
    const { connection } = await startFixture();
    const logs: string[] = [];

    await applySchema(connection.db, secret, { embedDim: 4, embedModel: "probe-model-a" });

    const noteId = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 3,
    });
    await connection.db
      .query(
        [
          "BEGIN TRANSACTION;",
          "CREATE ONLY chunk:preserved CONTENT { note: $note, ord: 0, text: 'hello', token_estimate: 1, vector: [0.1, 0.2, 0.3, 0.4], embed_model: 'probe-model-a', embedded_at: time::now(), embed_error: 'preserve-me' };",
          "CREATE ONLY concept:preserved CONTENT { label: 'Preserved concept', norm_label: 'preserved concept', kind: 'system', source: 'extractor' };",
          "CREATE ONLY claim:preserved CONTENT { text: 'Preserved claim', sha: 'claim-sha', kind: 'assertion' };",
          "CREATE ONLY question:preserved CONTENT { text: 'Preserved question?', sha: 'question-sha' };",
          "RELATE $note->mentions->concept:preserved CONTENT { source: 'extractor', class: 'INFERRED', confidence: 0.9, evidence: [chunk:preserved], agent: 'extractor', approved: true, applied: true, created_at: time::now() };",
          "RELATE $note->asserts->claim:preserved CONTENT { source: 'extractor', class: 'INFERRED', confidence: 0.8, evidence: [chunk:preserved], agent: 'extractor', approved: true, applied: true, created_at: time::now() };",
          "RELATE $note->asks->question:preserved CONTENT { source: 'extractor', class: 'INFERRED', confidence: 0.7, evidence: [chunk:preserved], agent: 'extractor', approved: true, applied: true, created_at: time::now() };",
          "UPDATE $note SET tier1_at = time::now(), tier2_at = time::now(), tier3_at = time::now();",
          "COMMIT TRANSACTION;",
        ].join("\n"),
        { note: noteId },
      )
      .collect();

    const swapped = await applySchema(connection.db, secret, {
      embedDim: 8,
      embedModel: "probe-model-b",
      log: (line) => logs.push(line),
    });

    expect(swapped.vectorsInvalidated).toBe(true);
    expect("chunksCleared" in swapped).toBe(false);
    expect(swapped.previousEmbedding).toEqual({ model: "probe-model-a", dimension: 4 });
    expect(swapped.indexesDefined).toContain("chunk_vec");

    const event = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.type === "daemon:embedding_model_changed");
    expect(event).toBeDefined();
    expect(event?.vectorsInvalidated).toBe(true);
    expect(event?.chunksCleared).toBeUndefined();

    // A normal subsequent boot reapplies the field DDL but must not erase the
    // durable schedule before bootstrap's linker-only continuation runs.
    const resumed = await applySchema(connection.db, secret, {
      embedDim: 8,
      embedModel: "probe-model-b",
      log: () => {},
    });
    expect(resumed.vectorsInvalidated).toBe(false);

    const [chunks] = await connection.db
      .query<
        [
          Array<{
            text: string;
            vector: number[] | null;
            embed_model: string | null;
            embedded_at: unknown;
            embed_error: string | null;
          }>,
        ]
      >("SELECT text, vector, embed_model, embedded_at, embed_error FROM chunk;")
      .collect<
        [
          Array<{
            text: string;
            vector: number[] | null;
            embed_model: string | null;
            embedded_at: unknown;
            embed_error: string | null;
          }>,
        ]
      >();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("hello");
    expect(chunks[0]?.vector ?? null).toBeNull();
    expect(chunks[0]?.embed_model ?? null).toBeNull();
    expect(chunks[0]?.embedded_at ?? null).toBeNull();
    expect(chunks[0]?.embed_error).toBe("preserve-me");

    const [notes] = await connection.db
      .query<
        [
          Array<{
            tier2_at: unknown;
            tier3_at: unknown;
            linker_refresh_pending: boolean;
          }>,
        ]
      >("SELECT tier2_at, tier3_at, linker_refresh_pending FROM note;")
      .collect<
        [
          Array<{
            tier2_at: unknown;
            tier3_at: unknown;
            linker_refresh_pending: boolean;
          }>,
        ]
      >();
    expect(notes[0]?.tier2_at ?? null).toBeNull();
    expect(notes[0]?.tier3_at ?? null).not.toBeNull();
    expect(notes[0]?.linker_refresh_pending).toBe(true);

    const [concepts, claims, questions, mentions, asserts, asks] = await connection.db
      .query<
        [
          Array<{ id: unknown }>,
          Array<{ id: unknown }>,
          Array<{ id: unknown }>,
          Array<{ evidence: unknown[] }>,
          Array<{ evidence: unknown[] }>,
          Array<{ evidence: unknown[] }>,
        ]
      >(
        [
          "SELECT id FROM concept WHERE id = concept:preserved;",
          "SELECT id FROM claim WHERE id = claim:preserved;",
          "SELECT id FROM question WHERE id = question:preserved;",
          "SELECT evidence FROM mentions WHERE in = $note;",
          "SELECT evidence FROM asserts WHERE in = $note;",
          "SELECT evidence FROM asks WHERE in = $note;",
        ].join("\n"),
        { note: noteId },
      )
      .collect<
        [
          Array<{ id: unknown }>,
          Array<{ id: unknown }>,
          Array<{ id: unknown }>,
          Array<{ evidence: unknown[] }>,
          Array<{ evidence: unknown[] }>,
          Array<{ evidence: unknown[] }>,
        ]
      >();
    expect(concepts).toHaveLength(1);
    expect(claims).toHaveLength(1);
    expect(questions).toHaveLength(1);
    expect(mentions[0]?.evidence).toHaveLength(1);
    expect(asserts[0]?.evidence).toHaveLength(1);
    expect(asks[0]?.evidence).toHaveLength(1);

    const indexes = await chunkIndexes(connection);
    expect(indexes.chunk_vec).toContain("DIMENSION 8");
  }, 30_000);

  test("[smoke] fresh schema rejects evidence-less extractor relations", async () => {
    const { connection } = await startFixture();
    await applySchema(connection.db, secret, { embedDim: 4, embedModel: "probe-model-a" });
    const source = await upsertNoteByPath(connection.db, {
      path: "source.md",
      sha: "source-sha",
      wordCount: 2,
    });
    const target = await upsertNoteByPath(connection.db, {
      path: "target.md",
      sha: "target-sha",
      wordCount: 2,
    });
    await connection.db
      .query(
        "CREATE ONLY concept:grounded CONTENT { label: 'Grounded', norm_label: 'grounded', kind: 'other', source: 'extractor' };",
      )
      .collect();

    await expect(
      connection.db
        .query(
          "RELATE $source->mentions->concept:grounded SET source = 'extractor', class = 'INFERRED', confidence = 0.5;",
          { source },
        )
        .collect(),
    ).rejects.toThrow();
    await expect(
      connection.db
        .query(
          "RELATE $source->mentions->concept:grounded SET source = 'extractor', class = 'INFERRED', confidence = 0.5, evidence = [];",
          { source },
        )
        .collect(),
    ).rejects.toThrow();

    await connection.db
      .query(
        "RELATE $source->supports->$target SET source = 'linker', class = 'INFERRED', confidence = 0.5;",
        { source, target },
      )
      .collect();
    const [supports] = await connection.db
      .query<[Array<{ id: unknown }>]>("SELECT id FROM supports;")
      .collect<[Array<{ id: unknown }>]>();
    expect(supports).toHaveLength(1);
  }, 30_000);

  test("[smoke] upgrades extractor relations by repairing dangling rows before enforcement", async () => {
    const { connection } = await startFixture();
    await connection.db
      .query(
        [
          "DEFINE TABLE note SCHEMALESS;",
          "DEFINE TABLE concept SCHEMALESS;",
          "DEFINE TABLE mentions TYPE RELATION FROM note TO concept SCHEMALESS;",
          "CREATE ONLY note:legacy CONTENT { path: 'legacy.md', sha: 'legacy-sha', word_count: 1 };",
          "RELATE note:legacy->mentions->concept:missing;",
        ].join("\n"),
      )
      .collect();
    const [before] = await connection.db
      .query<[Array<{ id: unknown }>]>("SELECT id FROM mentions;")
      .collect<[Array<{ id: unknown }>]>();
    expect(before).toHaveLength(1);

    await applySchema(connection.db, secret, { embedDim: 4, embedModel: "probe-model-a" });

    const [after] = await connection.db
      .query<[Array<{ id: unknown }>]>("SELECT id FROM mentions;")
      .collect<[Array<{ id: unknown }>]>();
    expect(after).toEqual([]);

    const [databaseInfo] = await connection.db
      .query<[{ tables: Record<string, string> }]>("INFO FOR DB;")
      .collect<[{ tables: Record<string, string> }]>();
    expect(databaseInfo.tables.mentions).toContain("ENFORCED");

    await connection.db
      .query(
        "CREATE ONLY chunk:legacy CONTENT { note: note:legacy, ord: 0, text: 'legacy', token_estimate: 1 };",
      )
      .collect();
    await expect(
      connection.db
        .query(
          "RELATE note:legacy->mentions->concept:still_missing SET source = 'extractor', class = 'INFERRED', confidence = 0.7, evidence = [chunk:legacy];",
        )
        .collect(),
    ).rejects.toThrow("does not exist");
  }, 30_000);

  test("[smoke] a failed probe with no stored meta skips the vector constraint", async () => {
    const { connection } = await startFixture();

    const result = await applySchema(connection.db, secret, {
      embedDim: null,
      embedModel: null,
      log: () => {},
    });

    expect(result.embedDim).toBeNull();
    const indexes = await chunkIndexes(connection);
    expect(indexes.chunk_vec).toBeUndefined();
    expect(indexes.chunk_text).toBeDefined();

    // An unconstrained vector column accepts any width, so a stale row from a
    // previous model cannot block writes while the endpoint is down.
    const noteId = await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: "sha-beta",
      wordCount: 1,
    });
    await connection.db
      .query(
        "CREATE ONLY chunk CONTENT { note: $note, ord: 0, text: 'x', token_estimate: 1, vector: [0.1, 0.2, 0.3] };",
        { note: noteId },
      )
      .collect();
  }, 30_000);

  test("[smoke] a failed probe reuses the dimension recorded in meta", async () => {
    const { connection } = await startFixture();

    await applySchema(connection.db, secret, { embedDim: 16, embedModel: "probe-model-a" });
    const result = await applySchema(connection.db, secret, {
      embedDim: null,
      embedModel: null,
      log: () => {},
    });

    expect(result.embedDim).toBe(16);
    const indexes = await chunkIndexes(connection);
    expect(indexes.chunk_vec).toContain("DIMENSION 16");
  }, 30_000);
});
