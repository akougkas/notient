/**
 * Phase 5 Task 7 proposals chat-tool smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/chat/tools/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, seeds the
 * writeback-capable edge tables with `approved = false` linker proposals,
 * and exercises the listing + lookup tools end-to-end. The wire-shape
 * (`kind: "edge"`, sourceNotePath, targetNotePath, agent, confidence,
 * createdAt) round-trips unchanged from the SQLite-mirror harness.
 *
 * Drift note: the SQLite version ordered by autoincrement `id`. SurrealDB
 * orders by `created_at`, the closest monotonic equivalent in the entity
 * tables. The test seeds with explicit `created_at` values so the order is
 * deterministic.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DateTime, type RecordId } from "surrealdb";
import { type SurrealServerHandle, startSurreal } from "../../../daemon/surrealServer";
import type { WritebackEdgeTable } from "../../approvals/approvalService";
import { applySchema } from "../../db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../db/surreal";
import { makeGetProposalTool, makeListProposalsTool } from "./proposals";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

interface SeedEdgeInput {
  table: WritebackEdgeTable;
  fromPath: string;
  toPath: string;
  agent: string;
  confidence?: number;
  createdAtSec: number;
  approved?: boolean;
}

async function seedEdge(connection: SurrealConnection, input: SeedEdgeInput): Promise<RecordId> {
  const fromId = await upsertNoteByPath(connection.db, {
    path: input.fromPath,
    sha: `sha-${input.fromPath}`,
    wordCount: 10,
  });
  const toId = await upsertNoteByPath(connection.db, {
    path: input.toPath,
    sha: `sha-${input.toPath}`,
    wordCount: 10,
  });
  const sql = `RELATE $from->${input.table}->$to SET source = 'linker', class = 'INFERRED', confidence = $confidence, agent = $agent, approved = $approved, created_at = $createdAt RETURN id;`;
  const [rows] = await connection.db
    .query<[Array<{ id: RecordId }>]>(sql, {
      from: fromId,
      to: toId,
      confidence: input.confidence ?? 0.85,
      agent: input.agent,
      approved: input.approved ?? false,
      createdAt: new DateTime(new Date(input.createdAtSec * 1000)),
    })
    .collect<[Array<{ id: RecordId }>]>();
  const created = rows[0];
  if (created === undefined) {
    throw new Error(`seedEdge: no edge created for ${input.table}`);
  }
  return created.id;
}

async function clearVault(connection: SurrealConnection): Promise<void> {
  for (const table of [
    "supports",
    "contradicts",
    "extends",
    "exemplifies",
    "synthesizes",
    "related_to",
    "wikilink",
    "note",
  ]) {
    await connection.db.query(`DELETE ${table};`).collect();
  }
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] proposals.list_pending", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-proposals-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-proposals-smoke-"));
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
    await clearVault(connection);
  });

  test("returns pending edges across writeback tables ordered by created_at desc", async () => {
    const earlier = await seedEdge(connection, {
      table: "supports",
      fromPath: "a.md",
      toPath: "b.md",
      agent: "linker",
      createdAtSec: 1_700_000_500,
    });
    const later = await seedEdge(connection, {
      table: "contradicts",
      fromPath: "c.md",
      toPath: "d.md",
      agent: "linker",
      createdAtSec: 1_700_001_000,
    });
    const tool = makeListProposalsTool(connection.db);
    const result = await tool.invoke({}, new AbortController().signal);
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0].id).toBe(later.toString());
    expect(result.proposals[1].id).toBe(earlier.toString());
    expect(result.proposals[0].kind).toBe("edge");
    if (result.proposals[0].kind === "edge") {
      expect(result.proposals[0].sourceNotePath).toBe("c.md");
      expect(result.proposals[0].targetNotePath).toBe("d.md");
      expect(result.proposals[0].type).toBe("contradicts");
      expect(result.proposals[0].agent).toBe("linker");
    }
  });

  test("excludes already-approved rows", async () => {
    await seedEdge(connection, {
      table: "supports",
      fromPath: "a.md",
      toPath: "b.md",
      agent: "linker",
      createdAtSec: 1_700_000_500,
      approved: true,
    });
    const tool = makeListProposalsTool(connection.db);
    const result = await tool.invoke({}, new AbortController().signal);
    expect(result.proposals).toEqual([]);
  });

  test("filters by notePath across in/out positions", async () => {
    await seedEdge(connection, {
      table: "supports",
      fromPath: "a.md",
      toPath: "b.md",
      agent: "linker",
      createdAtSec: 1,
    });
    await seedEdge(connection, {
      table: "contradicts",
      fromPath: "c.md",
      toPath: "a.md",
      agent: "linker",
      createdAtSec: 2,
    });
    await seedEdge(connection, {
      table: "extends",
      fromPath: "x.md",
      toPath: "y.md",
      agent: "linker",
      createdAtSec: 3,
    });
    const tool = makeListProposalsTool(connection.db);
    const result = await tool.invoke({ notePath: "a.md" }, new AbortController().signal);
    expect(result.proposals).toHaveLength(2);
    const targets = result.proposals.map((entry) => (entry.kind === "edge" ? entry.type : null));
    expect(targets.sort()).toEqual(["contradicts", "supports"]);
  });

  test("filters by agent name", async () => {
    await seedEdge(connection, {
      table: "supports",
      fromPath: "a.md",
      toPath: "b.md",
      agent: "linker",
      createdAtSec: 1,
    });
    await seedEdge(connection, {
      table: "contradicts",
      fromPath: "c.md",
      toPath: "d.md",
      agent: "contradictionHunter",
      createdAtSec: 2,
    });
    const tool = makeListProposalsTool(connection.db);
    const result = await tool.invoke(
      { agent: "contradictionHunter" },
      new AbortController().signal,
    );
    expect(result.proposals).toHaveLength(1);
    if (result.proposals[0].kind === "edge") {
      expect(result.proposals[0].type).toBe("contradicts");
    }
  });

  test("validates argument shape", () => {
    const tool = makeListProposalsTool(connection.db);
    expect(() => tool.validate("nope")).toThrow();
    expect(() => tool.validate({ limit: 0 })).toThrow();
    expect(tool.validate(undefined)).toEqual({});
  });
});

describe.skipIf(!SMOKE_ENABLED)("[smoke] proposals.get", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-proposals-get-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-proposals-get-smoke-"));
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
    await clearVault(connection);
  });

  test("returns a pending edge by id", async () => {
    const id = await seedEdge(connection, {
      table: "supports",
      fromPath: "a.md",
      toPath: "b.md",
      agent: "linker",
      createdAtSec: 1,
    });
    const tool = makeGetProposalTool(connection.db);
    const result = await tool.invoke({ id: id.toString() }, new AbortController().signal);
    expect(result.proposal?.kind).toBe("edge");
    expect(result.proposal?.id).toBe(id.toString());
  });

  test("returns null when missing or already approved", async () => {
    const approved = await seedEdge(connection, {
      table: "supports",
      fromPath: "a.md",
      toPath: "b.md",
      agent: "linker",
      createdAtSec: 1,
      approved: true,
    });
    const tool = makeGetProposalTool(connection.db);
    const missing = await tool.invoke({ id: "supports:not-real" }, new AbortController().signal);
    const decided = await tool.invoke({ id: approved.toString() }, new AbortController().signal);
    expect(missing.proposal).toBeNull();
    expect(decided.proposal).toBeNull();
  });

  test("rejects empty id", () => {
    const tool = makeGetProposalTool(connection.db);
    expect(() => tool.validate({ id: "" })).toThrow();
    expect(() => tool.validate({})).toThrow();
  });
});
