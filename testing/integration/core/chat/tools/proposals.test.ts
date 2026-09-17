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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DateTime, type RecordId } from "surrealdb";
import { FsVault } from "../../../../../src/adapters/fsVault";
import { ApprovalService } from "../../../../../src/core/approvals/approvalService";
import { ApprovalGate } from "../../../../../src/core/chat/approvalGate";
import {
  makeApproveProposalTool,
  makeGetProposalTool,
  makeListProposalsTool,
  makeRejectProposalTool,
} from "../../../../../src/core/chat/tools/proposals";
import type { WritebackEdgeTable } from "../../../../../src/core/db/edgeTables";
import { applySchema } from "../../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  upsertNoteByPath,
} from "../../../../../src/core/db/surreal";
import { EventBus } from "../../../../../src/core/events/eventBus";
import { sha256Hex } from "../../../../../src/core/utils/sha256";
import { type SurrealServerHandle, startSurreal } from "../../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const TEST_CONTEXT = { clientIdentity: "human" } as const;

interface SeedEdgeInput {
  table: WritebackEdgeTable;
  fromPath: string;
  toPath: string;
  agent: "linker" | "synthesizer" | "contradictionHunter";
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
  const sql = `RELATE $from->${input.table}->$to SET source = $agent, class = 'INFERRED', confidence = $confidence, agent = $agent, approved = $approved, created_at = $createdAt RETURN id;`;
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
    "approval_intent",
    "daemon_write",
    "history",
    "chunk",
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
    const result = await tool.invoke({}, new AbortController().signal, TEST_CONTEXT);
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

  test("round-trips canonical optional evidence through the production edge writer", async () => {
    const from = await upsertNoteByPath(connection.db, {
      path: "evidence-source.md",
      sha: "sha-evidence-source",
      wordCount: 4,
    });
    const to = await upsertNoteByPath(connection.db, {
      path: "evidence-target.md",
      sha: "sha-evidence-target",
      wordCount: 4,
    });
    const [chunk] = await connection.db
      .query<[{ id: RecordId<"chunk"> } | null]>(
        "CREATE ONLY chunk CONTENT { note: $note, ord: 0, text: 'Canonical proposal evidence.', token_estimate: 4 } RETURN id;",
        { note: from },
      )
      .collect<[{ id: RecordId<"chunk"> } | null]>();
    if (chunk === null) throw new Error("proposal evidence chunk was not created");

    await relateEdge(connection.db, {
      table: "supports",
      from,
      to,
      source: "linker",
      confidenceClass: "INFERRED",
      confidence: 0.8,
      agent: "linker",
      approved: false,
      evidence: [chunk.id],
    });

    const result = await makeListProposalsTool(connection.db).invoke(
      {},
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.evidence).toEqual([chunk.id.toString()]);
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
    const result = await tool.invoke({}, new AbortController().signal, TEST_CONTEXT);
    expect(result.proposals).toEqual([]);
  });

  test("excludes a pending edge as soon as either note endpoint is tombstoned", async () => {
    const edgeId = await seedEdge(connection, {
      table: "supports",
      fromPath: "live.md",
      toPath: "deleted.md",
      agent: "linker",
      createdAtSec: 1_700_000_600,
    });
    await connection.db
      .query("UPDATE note SET tombstoned_at = time::now() WHERE path = 'deleted.md';")
      .collect();
    const list = makeListProposalsTool(connection.db);
    expect((await list.invoke({}, new AbortController().signal, TEST_CONTEXT)).proposals).toEqual(
      [],
    );
    const get = makeGetProposalTool(connection.db);
    expect(
      await get.invoke({ id: edgeId.toString() }, new AbortController().signal, TEST_CONTEXT),
    ).toEqual({ proposal: null });
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
    const result = await tool.invoke(
      { notePath: "a.md" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
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
      TEST_CONTEXT,
    );
    expect(result.proposals).toHaveLength(1);
    if (result.proposals[0].kind === "edge") {
      expect(result.proposals[0].type).toBe("contradicts");
    }
  });

  test("fails closed on schema-valid rows with corrupt proposal semantics", async () => {
    const id = await seedEdge(connection, {
      table: "supports",
      fromPath: "source.md",
      toPath: "target.md",
      agent: "linker",
      createdAtSec: 1,
    });
    const tool = makeListProposalsTool(connection.db);

    await connection.db.query("UPDATE $id SET agent = NONE;", { id }).collect();
    await expect(tool.invoke({}, new AbortController().signal, TEST_CONTEXT)).rejects.toThrow(
      "agent must exactly match",
    );

    await connection.db
      .query("UPDATE $id SET agent = 'linker', applied = false;", { id })
      .collect();
    await expect(tool.invoke({}, new AbortController().signal, TEST_CONTEXT)).rejects.toThrow(
      "pending state must be approved = false and applied = true",
    );
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
    const result = await tool.invoke(
      { id: id.toString() },
      new AbortController().signal,
      TEST_CONTEXT,
    );
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
    const missing = await tool.invoke(
      { id: "supports:abcdefghijklmnopqrst" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    const decided = await tool.invoke(
      { id: approved.toString() },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(missing.proposal).toBeNull();
    expect(decided.proposal).toBeNull();
  });

  test("rejects empty id", () => {
    const tool = makeGetProposalTool(connection.db);
    expect(() => tool.validate({ id: "" })).toThrow();
    expect(() => tool.validate({})).toThrow();
  });
});

describe.skipIf(!SMOKE_ENABLED)("[smoke] proposals.approve / proposals.reject", () => {
  let tempDir: string;
  let vaultRoot: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-proposals-write-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-proposals-write-smoke-"));
    vaultRoot = path.join(tempDir, "vault");
    await rm(vaultRoot, { recursive: true, force: true });
    await (await import("node:fs/promises")).mkdir(vaultRoot, { recursive: true });
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
    if (connection !== undefined) await connection.close().catch(() => {});
    if (handle !== undefined) await handle.stop().catch(() => {});
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
  }, 30_000);

  afterEach(async () => {
    await clearVault(connection);
  });

  function buildApprovalService(): ApprovalService {
    return new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
  }

  function buildApprovalGate(): ApprovalGate {
    return new ApprovalGate({
      recordHistoryAutoApprove: async () => {},
      perToolPolicy: () => ({}),
      sessionGrants: { claim: async () => null },
    });
  }

  test("[smoke] approve writes the wikilink and lands the edge in state 3", async () => {
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, "# Alpha\n\nbody.\n");
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const id = await seedEdge(connection, {
      table: "supports",
      fromPath: "alpha.md",
      toPath: "beta.md",
      agent: "linker",
      createdAtSec: 1,
    });
    const tool = makeApproveProposalTool({
      approvalService: buildApprovalService(),
      approvalGate: buildApprovalGate(),
      approvalMode: () => "yolo",
      generateCallId: () => "call-approve",
    });
    const result = await tool.invoke(
      { id: id.toString() },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result).toMatchObject({
      applied: true,
      id: id.toString(),
      table: "supports",
      approvedBy: "human",
    });
    if (!result.applied) throw new Error("expected proposal approval receipt");
    expect(result.historyId).toStartWith('history:u"');
    const body = await readFile(sourcePath, "utf8");
    expect(body).toContain("[[beta]]");
  });

  test("[smoke] approve on missing id returns applied:false", async () => {
    const tool = makeApproveProposalTool({
      approvalService: buildApprovalService(),
      approvalGate: buildApprovalGate(),
      approvalMode: () => "yolo",
      generateCallId: () => "call-missing",
    });
    const result = await tool.invoke(
      { id: "supports:abcdefghijklmnopqrst" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result).toEqual({
      applied: false,
      reason: "proposal not found or already applied",
    });
  });

  test("[smoke] reject deletes the edge and returns its durable audit", async () => {
    const id = await seedEdge(connection, {
      table: "supports",
      fromPath: "alpha.md",
      toPath: "beta.md",
      agent: "linker",
      createdAtSec: 1,
    });
    const tool = makeRejectProposalTool({
      approvalService: buildApprovalService(),
      approvalGate: buildApprovalGate(),
      approvalMode: () => "yolo",
      generateCallId: () => "call-reject",
    });
    const result = await tool.invoke(
      { id: id.toString(), reason: "noisy" },
      new AbortController().signal,
      { clientIdentity: "chat-operator" },
    );
    expect(result).toMatchObject({
      applied: true,
      id: id.toString(),
      table: "supports",
      reason: "noisy",
    });
    if (!result.applied) throw new Error("proposal rejection did not apply");
    expect(result.historyId).toMatch(
      /^history:u"[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/,
    );
    const [rows] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM supports WHERE id = $id;", { id })
      .collect<[Array<{ id: RecordId }>]>();
    expect(rows).toHaveLength(0);

    const [historyRows] = await connection.db
      .query<
        [
          Array<{
            id: RecordId<"history">;
            after: { data: unknown };
            client_identity: string;
          }>,
        ]
      >("SELECT id, after, client_identity FROM history WHERE kind = 'proposal.reject';")
      .collect<
        [
          Array<{
            id: RecordId<"history">;
            after: { data: unknown };
            client_identity: string;
          }>,
        ]
      >();
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]?.id.toString()).toBe(result.historyId);
    expect(historyRows[0]?.client_identity).toBe("chat-operator");
    expect(historyRows[0]?.after.data).toEqual({
      decision: "rejected",
      reason: "noisy",
    });
  });
});
