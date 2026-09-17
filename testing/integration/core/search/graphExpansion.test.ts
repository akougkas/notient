/**
 * Graph-expansion smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/search/`.
 *
 * Boots a real SurrealDB, applies the schema, seeds notes plus wikilink edges
 * with varying approved/applied state, and exercises one-hop expansion over
 * committed relationships.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { WRITEBACK_EDGE_TABLES } from "../../../../src/core/db/edgeTables";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { expandViaApprovedEdges } from "../../../../src/core/search/graphExpansion";
import type { SearchHit } from "../../../../src/core/search/types";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

function makeHit(notePath: string): SearchHit {
  return {
    notePath,
    chunkId: `chunk-${notePath}`,
    snippet: `snippet for ${notePath}`,
    score: 1,
    matchedText: "x",
  };
}

interface EdgeSeed {
  fromPath: string;
  toPath: string;
  agent?: string;
  approved?: boolean;
  applied?: boolean;
}

async function seedEdge(
  connection: SurrealConnection,
  noteIds: Map<string, RecordId<"note">>,
  seed: EdgeSeed,
): Promise<void> {
  const fromId = noteIds.get(seed.fromPath);
  const toId = noteIds.get(seed.toPath);
  if (fromId === undefined || toId === undefined) {
    throw new Error(`seedEdge: missing note id for ${seed.fromPath} or ${seed.toPath}`);
  }
  await relateEdge(connection.db, {
    table: "wikilink",
    from: fromId,
    to: toId,
    source: "wikilink",
    confidenceClass: "EXTRACTED",
    confidence: 1,
    agent: seed.agent ?? "linker",
    approved: seed.approved ?? true,
  });
  if (seed.applied !== undefined) {
    await connection.db
      .query("UPDATE wikilink SET applied = $applied WHERE in = $in AND out = $out;", {
        applied: seed.applied,
        in: fromId,
        out: toId,
      })
      .collect();
  }
}

async function seedNotes(
  connection: SurrealConnection,
  paths: string[],
): Promise<Map<string, RecordId<"note">>> {
  const out = new Map<string, RecordId<"note">>();
  for (const notePath of paths) {
    const id = await upsertNoteByPath(connection.db, {
      path: notePath,
      sha: `sha-${notePath}`,
      wordCount: 1,
    });
    out.set(notePath, id);
  }
  return out;
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] expandViaApprovedEdges", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-graph-expansion-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-graph-expansion-smoke-"));
    handle = await startSurreal({
      dataDir: path.join(tempDir, "data"),
      secret,
      portFile: path.join(tempDir, "port"),
      pidFile: path.join(tempDir, "pid"),
      logLevel: "warn",
      hnswCacheMib: 64,
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret, { embedDim: 768, embedModel: "fixture-embedding" });
  }, 30_000);

  afterAll(async () => {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
    if (handle !== undefined) {
      await handle.stop().catch(() => {});
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  afterEach(async () => {
    await connection.db.query("DELETE wikilink;").collect();
    for (const table of WRITEBACK_EDGE_TABLES) {
      await connection.db.query(`DELETE ${table};`).collect();
    }
    await connection.db.query("DELETE chunk;").collect();
    await connection.db.query("DELETE note;").collect();
  });

  test("returns empty list when there are no base hits", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md"]);
    await seedEdge(connection, notes, { fromPath: "notes/a.md", toPath: "notes/b.md" });
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [],
    });
    expect(expanded).toEqual([]);
  });

  test("adds direct approved-edge neighbours of base hits", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md", "notes/c.md"]);
    await seedEdge(connection, notes, {
      fromPath: "notes/a.md",
      toPath: "notes/b.md",
      agent: "linker",
    });
    await seedEdge(connection, notes, {
      fromPath: "notes/c.md",
      toPath: "notes/a.md",
      agent: "linker",
    });
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [makeHit("notes/a.md")],
    });
    const paths = expanded.map((hit) => hit.notePath).sort();
    expect(paths).toEqual(["notes/b.md", "notes/c.md"]);
    const linkToB = expanded.find((hit) => hit.notePath === "notes/b.md");
    expect(linkToB?.viaPath).toBe("notes/a.md");
    expect(linkToB?.snippet).toContain("wikilink");
    expect(linkToB?.snippet).toContain("agent: linker");
    expect(linkToB?.chunkId).toBeNull();
  });

  test("ignores edges that are not approved", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md"]);
    await seedEdge(connection, notes, {
      fromPath: "notes/a.md",
      toPath: "notes/b.md",
      approved: false,
    });
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [makeHit("notes/a.md")],
    });
    expect(expanded).toEqual([]);
  });

  test("ignores edges that are approved but not applied", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md"]);
    await seedEdge(connection, notes, {
      fromPath: "notes/a.md",
      toPath: "notes/b.md",
      approved: true,
      applied: false,
    });
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [makeHit("notes/a.md")],
    });
    expect(expanded).toEqual([]);
  });

  test("deduplicates expansion against the base notePath set", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md"]);
    await seedEdge(connection, notes, { fromPath: "notes/a.md", toPath: "notes/b.md" });
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [makeHit("notes/a.md"), makeHit("notes/b.md")],
    });
    expect(expanded).toEqual([]);
  });

  test("expands approved linker edges with type, confidence and a real score", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md"]);
    await relateEdge(connection.db, {
      table: "supports",
      from: notes.get("notes/a.md") as RecordId<"note">,
      to: notes.get("notes/b.md") as RecordId<"note">,
      source: "linker",
      confidenceClass: "INFERRED",
      confidence: 0.8,
      agent: "linker",
      approved: true,
    });
    const seed = makeHit("notes/a.md");
    seed.score = 0.5;
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [seed],
    });
    expect(expanded).toHaveLength(1);
    expect(expanded[0].notePath).toBe("notes/b.md");
    expect(expanded[0].edgeType).toBe("supports");
    expect(expanded[0].confidence).toBeCloseTo(0.8, 5);
    expect(expanded[0].score).toBeCloseTo(0.5 * 0.8, 5);
  });

  test("excludes pending linker proposals from trusted retrieval", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md"]);
    await relateEdge(connection.db, {
      table: "contradicts",
      from: notes.get("notes/a.md") as RecordId<"note">,
      to: notes.get("notes/b.md") as RecordId<"note">,
      source: "linker",
      confidenceClass: "INFERRED",
      confidence: 0.6,
      agent: "linker",
      approved: false,
    });
    const seed = makeHit("notes/a.md");
    seed.score = 1;
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [seed],
    });
    expect(expanded).toEqual([]);
  });

  test("uses the target note's first chunk as the snippet", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md"]);
    await connection.db
      .query("CREATE chunk CONTENT { note: $note, ord: 0, text: $text, token_estimate: 5 };", {
        note: notes.get("notes/b.md") as RecordId<"note">,
        text: "the real body of note b",
      })
      .collect();
    await seedEdge(connection, notes, { fromPath: "notes/a.md", toPath: "notes/b.md" });
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [makeHit("notes/a.md")],
    });
    expect(expanded).toHaveLength(1);
    expect(expanded[0].snippet).toBe("the real body of note b");
  });

  test("collapses parallel edges to the same neighbour", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md"]);
    await seedEdge(connection, notes, {
      fromPath: "notes/a.md",
      toPath: "notes/b.md",
      agent: "linker",
    });
    await seedEdge(connection, notes, {
      fromPath: "notes/a.md",
      toPath: "notes/b.md",
      agent: "extractor",
    });
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [makeHit("notes/a.md")],
    });
    expect(expanded.length).toBe(1);
    expect(expanded[0].notePath).toBe("notes/b.md");
  });
});
