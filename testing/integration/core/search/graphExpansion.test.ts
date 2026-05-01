/**
 * Phase 4 Task 11 graphExpansion smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/search/`.
 *
 * Boots a real SurrealDB, applies the schema, seeds notes plus wikilink edges
 * with varying approved/applied state, and exercises the SurrealDB-backed
 * graph expansion that replaces the legacy SQLite recursive-CTE.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, relateEdge, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { expandViaApprovedEdges } from "../../../../src/core/search/graphExpansion";
import type { SearchHit } from "../../../../src/core/search/types";

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
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);
  });

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
  });

  afterEach(async () => {
    await connection.db.query("DELETE wikilink;").collect();
    await connection.db.query("DELETE note;").collect();
  });

  test("depth=0 returns no expansion regardless of edges present", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md"]);
    await seedEdge(connection, notes, { fromPath: "notes/a.md", toPath: "notes/b.md" });
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [makeHit("notes/a.md")],
      depth: 0,
    });
    expect(expanded).toEqual([]);
  });

  test("returns empty list when there are no base hits", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md"]);
    await seedEdge(connection, notes, { fromPath: "notes/a.md", toPath: "notes/b.md" });
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [],
      depth: 1,
    });
    expect(expanded).toEqual([]);
  });

  test("adds approved-edge neighbours of base hits at depth=1", async () => {
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
      depth: 1,
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
      depth: 1,
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
      depth: 1,
    });
    expect(expanded).toEqual([]);
  });

  test("deduplicates expansion against the base notePath set", async () => {
    const notes = await seedNotes(connection, ["notes/a.md", "notes/b.md"]);
    await seedEdge(connection, notes, { fromPath: "notes/a.md", toPath: "notes/b.md" });
    const expanded = await expandViaApprovedEdges({
      db: connection.db,
      baseHits: [makeHit("notes/a.md"), makeHit("notes/b.md")],
      depth: 1,
    });
    expect(expanded).toEqual([]);
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
      depth: 1,
    });
    expect(expanded.length).toBe(1);
    expect(expanded[0].notePath).toBe("notes/b.md");
  });
});
