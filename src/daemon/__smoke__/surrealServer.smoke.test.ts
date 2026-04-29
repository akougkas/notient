/**
 * End-to-end smoke harness for the SurrealDB daemon.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets `NOTIENT_SMOKE=1`).
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md §16.1
 * Plan: docs/superpowers/plans/2026-04-29-vault-enrichment-phase-1.md Task 10
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type RecordId, Table } from "surrealdb";
import { EDGE_TABLES } from "../../core/db/edgeTables";
import { applySchema } from "../../core/db/schemaApplier";
import {
  type NoteRecord,
  type SurrealConnection,
  connect,
  createNote,
  relateWikilink,
  searchVector,
} from "../../core/db/surreal";
import { type SurrealServerHandle, startSurreal } from "../surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] SurrealDB end-to-end", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  let noteA: NoteRecord;

  const secret = "smoke-test-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-surreal-smoke-"));
    handle = await startSurreal({
      dataDir: path.join(tempDir, "data"),
      secret,
      portFile: path.join(tempDir, "port"),
      pidFile: path.join(tempDir, "pid"),
      logLevel: "warn",
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);

    noteA = await createNote(connection.db, {
      path: "smoke/test1.md",
      sha: "abc123",
      wordCount: 42,
    });
  });

  afterAll(async () => {
    if (connection) {
      await connection.close().catch(() => {});
    }
    if (handle) {
      await handle.stop().catch(() => {});
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("[smoke] INFO FOR DB reports all 30 expected tables", async () => {
    const [info] = await connection.db
      .query<[{ tables: Record<string, string> }]>("INFO FOR DB;")
      .collect<[{ tables: Record<string, string> }]>();

    const present = new Set(Object.keys(info.tables));

    const entityTables = ["note", "block", "chunk", "tag", "concept", "claim", "question"];
    const opsTables = [
      "daemon_write",
      "awaken_run",
      "history",
      "agent_event",
      "agent_session",
      "agent_run",
    ];
    const unresolvedTables = ["wikilink_unresolved", "embed_unresolved"];
    const expected = [...entityTables, ...EDGE_TABLES, ...unresolvedTables, ...opsTables];

    for (const name of expected) {
      expect(present.has(name)).toBe(true);
    }
    expect(expected.length).toBe(30);
  });

  test("[smoke] createNote round-trips path/sha/word_count", async () => {
    interface NoteRow {
      id: RecordId<"note">;
      path: string;
      sha: string;
      word_count: number;
    }
    const [rows] = await connection.db
      .query<[NoteRow[]]>("SELECT * FROM note WHERE path = $p", { p: "smoke/test1.md" })
      .collect<[NoteRow[]]>();

    expect(rows.length).toBe(1);
    expect(rows[0].sha).toBe("abc123");
    expect(rows[0].word_count).toBe(42);
  });

  test("[smoke] RELATE wikilink + traversal", async () => {
    const noteB = await createNote(connection.db, {
      path: "smoke/test2.md",
      sha: "def456",
      wordCount: 7,
    });

    await relateWikilink(connection.db, {
      from: noteA.id,
      to: noteB.id,
      source: "wikilink",
      confidenceClass: "EXTRACTED",
      confidence: 1.0,
      agent: "smoke-test",
    });

    interface TraversalRow {
      targets: string[];
    }
    const [rows] = await connection.db
      .query<[TraversalRow[]]>("SELECT ->wikilink->note.path AS targets FROM $a;", { a: noteA.id })
      .collect<[TraversalRow[]]>();

    expect(rows.length).toBeGreaterThan(0);
    const targets = rows[0].targets ?? [];
    expect(targets).toContain("smoke/test2.md");
  });

  test("[smoke] HNSW kNN returns the expected ID", async () => {
    const vectorA = new Array<number>(768).fill(0);
    vectorA[0] = 1;
    const vectorB = new Array<number>(768).fill(0);
    vectorB[1] = 1;

    interface ChunkRow {
      id: RecordId<"chunk">;
    }
    await connection.db.create<ChunkRow>(new Table("chunk")).content({
      note: noteA.id,
      ord: 0,
      text: "alpha",
      token_estimate: 1,
      vector: vectorA,
      embed_model: "test",
      embedded_at: new Date(),
    });
    await connection.db.create<ChunkRow>(new Table("chunk")).content({
      note: noteA.id,
      ord: 1,
      text: "beta",
      token_estimate: 1,
      vector: vectorB,
      embed_model: "test",
      embedded_at: new Date(),
    });

    const hits = await searchVector(connection.db, { vector: vectorA, k: 1, ef: 200 });
    expect(hits.length).toBe(1);
    expect(hits[0].text).toBe("alpha");
  });

  test("[smoke] schemafull rejects unknown fields", async () => {
    // Spec §16.1 calls out the SCHEMAFULL "silent-drop" footgun. SurrealDB 3.x
    // hardened this: unknown fields now produce a server error instead of being
    // silently discarded. The safety property the spec cares about (no silent
    // schema drift) holds either way; assert the rejection is observable.
    let rejected = false;
    try {
      await connection.db
        .query("UPDATE $note SET nonsense_field = 'x'", { note: noteA.id })
        .collect();
    } catch (error) {
      rejected = true;
      expect(String(error)).toContain("nonsense_field");
    }

    interface NoteRowAny {
      id: RecordId<"note">;
      path: string;
      sha: string;
      word_count: number;
      nonsense_field?: unknown;
    }
    const [rows] = await connection.db
      .query<[NoteRowAny[]]>("SELECT * FROM $note;", { note: noteA.id })
      .collect<[NoteRowAny[]]>();

    expect(rows.length).toBe(1);
    expect(rows[0].nonsense_field).toBeUndefined();
    expect(rejected).toBe(true);
  });
});
