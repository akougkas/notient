import {
  assertToolApproval,
  assertToolTarget,
  toolApproval,
} from "../../../../src/core/chat/toolAuthority";
import { EffectAuthorityRevoked } from "../../../../src/core/history/effectAuthority";
/**
 * ApprovalService smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/approvals/`.
 *
 * Boots a real SurrealDB, applies the current schema, and exercises the
 * pending-state approve-and-write contract end-to-end. Recovery tests fail
 * real dependencies at durable boundaries, then construct a fresh service
 * and call `reconcilePendingApplications` to verify recovery.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { FsVault } from "../../../../src/adapters/fsVault";
import { VaultMutationBlockedError } from "../../../../src/adapters/vaultAdapter";
import { contentRevision } from "../../../../src/api/notes";
import {
  ApprovalService,
  renderApprovedRelation,
} from "../../../../src/core/approvals/approvalService";
import { proposalAcceptanceHistoryId } from "../../../../src/core/approvals/proposalIdentity";
import {
  backfillReviewPreviews,
  readReview,
  saveReview,
} from "../../../../src/core/approvals/reviewStorage";
import type { WritebackEdgeTable } from "../../../../src/core/db/edgeTables";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  lookupNoteByPath,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { HistoryService } from "../../../../src/core/history/historyService";
import { makeNoteBodyInverter } from "../../../../src/core/history/inverters/noteBody";
import { purgeNoteGraph, tombstoneNoteById } from "../../../../src/core/indexer/purgeNote";
import { applyApprovedRelation } from "../../../../src/core/markdown/writeback";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

async function sha256Hex(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface SeedResult {
  edgeId: RecordId;
  sourceNoteId: RecordId<"note">;
  targetNoteId: RecordId<"note">;
}

async function seedProposal(
  connection: SurrealConnection,
  table: WritebackEdgeTable,
): Promise<SeedResult> {
  const sourceNoteId = await upsertNoteByPath(connection.db, {
    path: "alpha.md",
    sha: "sha-alpha",
    wordCount: 5,
  });
  const targetNoteId = await upsertNoteByPath(connection.db, {
    path: "beta.md",
    sha: "sha-beta",
    wordCount: 3,
  });
  // RELATE returns the created edge; we capture its id via the response so
  // the test can address the row by id later.
  const sql = `RELATE $from->${table}->$to SET source = 'linker', class = 'INFERRED', confidence = 0.8, agent = 'linker', approved = false RETURN id;`;
  const [rows] = await connection.db
    .query<[Array<{ id: RecordId }>]>(sql, { from: sourceNoteId, to: targetNoteId })
    .collect<[Array<{ id: RecordId }>]>();
  const created = rows[0];
  if (created === undefined) {
    throw new Error(`seedProposal: no edge created for ${table}`);
  }
  return { edgeId: created.id, sourceNoteId, targetNoteId };
}

async function clearAllRows(connection: SurrealConnection): Promise<void> {
  const tables = [
    "proposal_review",
    "supports",
    "contradicts",
    "extends",
    "exemplifies",
    "synthesizes",
    "related_to",
    "wikilink",
    "embed",
    "frontmatter_ref",
    "tagged",
    "contained_in",
    "under_heading",
    "mentions",
    "asserts",
    "asks",
    "approval_intent",
    "history",
    "daemon_write",
    "chunk",
    "block",
    "note",
  ];
  for (const table of tables) {
    await connection.db.query(`DELETE ${table};`).collect();
  }
}

type ApprovalArtifactTable = "approval_intent" | "history" | "daemon_write";

async function countApprovalArtifacts(
  connection: SurrealConnection,
  table: ApprovalArtifactTable,
): Promise<number> {
  const [rows] = await connection.db
    .query<[Array<{ id: RecordId }>]>(`SELECT id FROM ${table};`)
    .collect<[Array<{ id: RecordId }>]>();
  return rows.length;
}

interface EdgeDecisionState {
  approved: boolean;
  applied: boolean;
  approved_by?: string;
}

async function readEdgeDecisionState(
  connection: SurrealConnection,
  table: WritebackEdgeTable,
  edgeId: RecordId,
): Promise<EdgeDecisionState[]> {
  const [rows] = await connection.db
    .query<[EdgeDecisionState[]]>(
      `SELECT approved, applied, approved_by FROM ${table} WHERE id = $id;`,
      { id: edgeId },
    )
    .collect<[EdgeDecisionState[]]>();
  return rows;
}

interface StoredIntentState {
  before_body: string;
  after_body: string;
  source_path: string;
  write_started_at?: unknown;
}

async function readIntentStates(connection: SurrealConnection): Promise<StoredIntentState[]> {
  const [rows] = await connection.db
    .query<[StoredIntentState[]]>(
      "SELECT before_body, after_body, source_path, write_started_at FROM approval_intent;",
    )
    .collect<[StoredIntentState[]]>();
  return rows;
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] ApprovalService", () => {
  let tempDir: string;
  let vaultRoot: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-approvals-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-approvals-smoke-"));
    vaultRoot = path.join(tempDir, "vault");
    await import("node:fs/promises").then((module) => module.mkdir(vaultRoot, { recursive: true }));
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
    await clearAllRows(connection);
  });

  test("[smoke] approve happy path: file mutated, daemon_write present, history present, applied=true", async () => {
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, "# Alpha\n\nbody.\n");
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "supports");
    const bus = new EventBus();
    const events: string[] = [];
    let historyPrunes = 0;
    bus.on("approval:decided", (event) => {
      events.push(`${event.kind}:${event.decision}`);
    });

    const service = new ApprovalService({
      db: connection.db,
      bus,
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {
        historyPrunes += 1;
      },
    });
    await service.approveEdge({ id: seed.edgeId, table: "supports", approvedBy: "human" });

    const body = await readFile(sourcePath, "utf8");
    expect(body).toContain("notient:");
    expect(body).toContain("supports:");
    expect(body).toContain("[[beta]]");

    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM supports WHERE id = $id;",
        { id: seed.edgeId },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(edgeRows[0]?.approved).toBe(true);
    expect(edgeRows[0]?.applied).toBe(true);

    const [daemonRows] = await connection.db
      .query<[Array<{ agent: string }>]>("SELECT agent FROM daemon_write WHERE note = $note;", {
        note: seed.sourceNoteId,
      })
      .collect<[Array<{ agent: string }>]>();
    expect(daemonRows.length).toBe(1);
    expect(daemonRows[0].agent).toBe("linker");

    const [historyRows] = await connection.db
      .query<[Array<{ kind: string; target: string; client_identity: string }>]>(
        "SELECT kind, target, client_identity FROM history;",
      )
      .collect<[Array<{ kind: string; target: string; client_identity: string }>]>();
    expect(historyRows.length).toBe(1);
    expect(historyRows[0].kind).toBe("note.frontmatter");
    expect(historyRows[0].target).toBe("alpha.md");
    expect(historyRows[0].client_identity).toBe("human");

    expect(events).toEqual(["edge:accepted"]);
    expect(historyPrunes).toBe(1);
  });

  test("[smoke] editor-wait revocation returns the relationship to review and cannot replay on restart", async () => {
    const before = "# Alpha\n\nOriginal.\n";
    await writeFile(path.join(vaultRoot, "alpha.md"), before);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "supports");
    let allowed = true;
    const vault = new FsVault(vaultRoot, {
      beforeMutation: async () => {
        allowed = false;
        return undefined;
      },
    });
    const options = {
      db: connection.db,
      bus: new EventBus(),
      vault,
      hash: sha256Hex,
      pruneHistory: async () => {},
    };
    const guard = {
      before,
      after: renderApprovedRelation(before, "supports", "beta.md"),
      authorize: async () => {
        if (!allowed) throw new Error("permission revoked");
      },
    };
    await expect(
      new ApprovalService(options).approveEdge(
        { id: seed.edgeId, table: "supports", approvedBy: "human" },
        guard,
      ),
    ).rejects.toThrow("permission revoked");
    expect(await vault.read("alpha.md")).toBe(before);
    expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(0);
    expect(await countApprovalArtifacts(connection, "history")).toBe(0);
    expect(await readEdgeDecisionState(connection, "supports", seed.edgeId)).toEqual([
      { approved: false, applied: true },
    ]);
    expect(await new ApprovalService(options).reconcilePendingApplications()).toEqual({
      replayed: 0,
      abandoned: 0,
      failed: 0,
      deferred: 0,
    });
    expect(await vault.read("alpha.md")).toBe(before);
  });

  test("[smoke] an interrupted relationship write honors a durable review rejection after migration and restart", async () => {
    const before = "# Alpha\n\nEvidence.\n";
    await writeFile(path.join(vaultRoot, "alpha.md"), before);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "supports");
    const source = { path: "alpha.md", revision: contentRevision(before) };
    const pending = await saveReview(
      connection.db,
      {
        id: "d".repeat(64),
        revision: "0".repeat(64),
        state: "pending",
        previewId: "e".repeat(64),
        previewRevision: "f".repeat(64),
        edgeIds: [seed.edgeId.toString()],
        provenance: {
          pipeline: "relate",
          jobId: "018f05cd-3f7b-7000-8000-000000000001",
          configurationRevision: "a".repeat(64),
          sources: [source],
          evidence: [
            {
              ...source,
              quote: before,
              range: { start: 0, end: before.length, startLine: 1, endLine: 4 },
            },
          ],
          rationale: "A grounded relationship",
          score: null,
        },
        createdAt: 100,
        decidedAt: null,
        decidedBy: null,
        appliedHistory: [],
      },
      null,
    );
    const vault = new FsVault(vaultRoot, {
      beforeMutation: async () => {
        throw new VaultMutationBlockedError("Unsaved editor");
      },
    });
    const options = {
      db: connection.db,
      bus: new EventBus(),
      vault,
      hash: sha256Hex,
      pruneHistory: async () => {},
    };
    const service = new ApprovalService(options);
    await expect(
      service.approveEdge({ id: seed.edgeId, table: "supports", approvedBy: "human" }),
    ).rejects.toMatchObject({ code: "PENDING_APPROVAL" });
    await expect(
      service.approveEdge(
        { id: seed.edgeId, table: "supports", approvedBy: "human" },
        {
          before,
          after: renderApprovedRelation(before, "supports", "beta.md"),
          authorize: async () => {},
        },
      ),
    ).rejects.toThrow("Unsaved editor");
    expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(1);
    // A crash can follow the durable decision before graph cleanup. Also exercise
    // migration of old proposal metadata without modifying its decision/revision.
    const rejected = await saveReview(
      connection.db,
      { ...pending, state: "rejected", decidedAt: 200, decidedBy: "human" },
      pending.revision,
    );
    await connection.db.query("UPDATE proposal_review UNSET preview_id, edge_ids;").collect();
    await backfillReviewPreviews(connection.db);
    expect(await readReview(connection.db, rejected.id)).toEqual(rejected);
    const restarted = new ApprovalService({ ...options, vault: new FsVault(vaultRoot) });
    expect(await restarted.reconcilePendingApplications()).toEqual({
      replayed: 0,
      abandoned: 1,
      failed: 0,
      deferred: 0,
    });
    expect(await vault.read("alpha.md")).toBe(before);
    expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(0);
    expect(await readEdgeDecisionState(connection, "supports", seed.edgeId)).toEqual([]);
    const [history] = await connection.db
      .query<[Array<{ kind: string }>]>("SELECT kind FROM history;")
      .collect();
    expect(history.map((row) => row.kind)).toEqual(["proposal.reject"]);
  });

  test("[smoke] approval writes the canonical target path when basenames collide", async () => {
    const sourceNotePath = "projects/a/source.md";
    const targetNotePath = "archive/readme.md";
    await mkdir(path.join(vaultRoot, "projects/a"), { recursive: true });
    await mkdir(path.join(vaultRoot, "archive"), { recursive: true });
    await writeFile(path.join(vaultRoot, sourceNotePath), "# Source\n");
    await writeFile(path.join(vaultRoot, targetNotePath), "# Intended\n");
    await writeFile(path.join(vaultRoot, "projects/a/readme.md"), "# Distractor\n");
    const source = await upsertNoteByPath(connection.db, {
      path: sourceNotePath,
      sha: "sha-source",
      wordCount: 2,
    });
    const target = await upsertNoteByPath(connection.db, {
      path: targetNotePath,
      sha: "sha-target",
      wordCount: 2,
    });
    await upsertNoteByPath(connection.db, {
      path: "projects/a/readme.md",
      sha: "sha-distractor",
      wordCount: 2,
    });
    const [edges] = await connection.db
      .query<[Array<{ id: RecordId }>]>(
        "RELATE $source->related_to->$target SET source = 'linker', class = 'INFERRED', confidence = 0.8, agent = 'linker', approved = false RETURN id;",
        { source, target },
      )
      .collect<[Array<{ id: RecordId }>]>();
    const edge = edges[0];
    if (edge === undefined) throw new Error("failed to seed duplicate-basename approval");

    const service = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    await service.approveEdge({ id: edge.id, table: "related_to", approvedBy: "human" });

    const body = await readFile(path.join(vaultRoot, sourceNotePath), "utf8");
    expect(body).toContain("[[archive/readme]]");
    expect(body).not.toContain("- [[readme]]");
  });

  test("[smoke] approve → undo → file restored, no nested-mirror artifact", async () => {
    const initialBody = "# Alpha\n\nbody.\n";
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, initialBody);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "related_to");
    const bus = new EventBus();

    const service = new ApprovalService({
      db: connection.db,
      bus,
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    await service.approveEdge({ id: seed.edgeId, table: "related_to", approvedBy: "human" });

    // Writeback ran: `## Related` section now present with `[[beta]]`.
    const bodyAfterApprove = await readFile(sourcePath, "utf8");
    expect(bodyAfterApprove).toContain("## Related");
    expect(bodyAfterApprove).toContain("[[beta]]");

    // History row carries the vault-relative path, not an absolute one. Pre-fix
    // this was the absolute `sourcePath`, which the inverter then re-joined
    // under vaultRoot to produce the phantom mirror.
    const vault = new FsVault(vaultRoot);
    const historyService = new HistoryService({
      db: connection.db,
      inverters: {
        "note.append_section": makeNoteBodyInverter({
          facade: {
            exists: (target) => vault.exists(target),
            read: (target) => vault.read(target),
            writeIfUnchanged: (target, expected, content) =>
              vault.writeIfUnchanged(target, expected, content),
            removeIfUnchanged: (target, expected) => vault.removeIfUnchanged(target, expected),
          },
          hash: sha256Hex,
          updateNoteSha: async () => {
            // The smoke harness does not exercise the SurrealDB note.sha
            // refresh; the bug surfaces in the file-write path before this
            // callback runs.
          },
          validateTargetIdentity: async () => true,
        }),
      },
      retention: { max: 100, maxPerTarget: 50 },
    });
    const recent = await historyService.getRecent(1);
    expect(recent.length).toBe(1);
    expect(recent[0].target).toBe("alpha.md");

    const undoResult = await historyService.undo(recent[0].id);
    expect(undoResult.ok).toBe(true);

    // Source file body is restored verbatim.
    const bodyAfterUndo = await readFile(sourcePath, "utf8");
    expect(bodyAfterUndo).toBe(initialBody);

    // No phantom-mirror artifact under vaultRoot. The bug always materializes
    // through `vaultRoot/tmp/...` because vaultRoot starts with `/tmp/...` in
    // this harness, so the existence of `vaultRoot/tmp` is the canary.
    const phantomRoot = path.join(vaultRoot, "tmp");
    let phantomExists = false;
    try {
      await stat(phantomRoot);
      phantomExists = true;
    } catch {
      phantomExists = false;
    }
    expect(phantomExists).toBe(false);
  });

  test("[smoke] approve idempotent no-op: target already present, no daemon_write and one decision audit", async () => {
    const sourcePath = path.join(vaultRoot, "alpha.md");
    // Pre-seed the body with the relation already present so the writeback
    // returns input unchanged.
    await writeFile(sourcePath, "---\nnotient:\n  supports:\n    - '[[beta]]'\n---\nbody.\n");
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "supports");
    const bus = new EventBus();
    const service = new ApprovalService({
      db: connection.db,
      bus,
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    await service.approveEdge({ id: seed.edgeId, table: "supports", approvedBy: "human" });

    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM supports WHERE id = $id;",
        { id: seed.edgeId },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(edgeRows[0]?.approved).toBe(true);
    expect(edgeRows[0]?.applied).toBe(true);

    const [daemonRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM daemon_write;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(daemonRows.length).toBe(0);

    const [historyRows] = await connection.db
      .query<[Array<{ id: RecordId; client_identity: string }>]>(
        "SELECT id, client_identity FROM history;",
      )
      .collect<[Array<{ id: RecordId; client_identity: string }>]>();
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]?.client_identity).toBe("human");
  });

  test("[smoke] approval refuses a source swapped to an escaping symlink and releases the claim", async () => {
    const sourcePath = path.join(vaultRoot, "alpha.md");
    const externalPath = path.join(tempDir, "outside-alpha.md");
    const externalBody = "# External\n\nprivate.\n";
    await writeFile(sourcePath, "# Alpha\n\nbody.\n");
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    await writeFile(externalPath, externalBody);
    const seed = await seedProposal(connection, "supports");

    await rm(sourcePath);
    await symlink(externalPath, sourcePath);
    const service = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    await expect(
      service.approveEdge({ id: seed.edgeId, table: "supports", approvedBy: "human" }),
    ).rejects.toThrow("escape");

    expect(await readFile(externalPath, "utf8")).toBe(externalBody);
    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean; approved_by?: string }>]>(
        "SELECT approved, applied, approved_by FROM supports WHERE id = $id;",
        { id: seed.edgeId },
      )
      .collect<[Array<{ approved: boolean; applied: boolean; approved_by?: string }>]>();
    expect(edgeRows).toEqual([{ approved: false, applied: true, approved_by: undefined }]);
    const [historyRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM history;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(historyRows).toHaveLength(0);
    await rm(sourcePath);
    await rm(externalPath);
  });

  test("[smoke] reject atomically audits the exact edge and retries return the first decision", async () => {
    await writeFile(path.join(vaultRoot, "alpha.md"), "# Alpha\n");
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "related_to");
    const bus = new EventBus();
    const events: Array<{
      reason: string | null;
      decidedBy: string;
      historyId: string;
    }> = [];
    let historyPrunes = 0;
    bus.on("approval:decided", (event) => {
      if (event.decision === "rejected") {
        events.push({
          reason: event.reason,
          decidedBy: event.decidedBy,
          historyId: event.historyId,
        });
      }
    });

    const service = new ApprovalService({
      db: connection.db,
      bus,
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {
        historyPrunes += 1;
      },
    });
    const [originalRows] = await connection.db
      .query<
        [
          Array<{
            id: RecordId;
            in: RecordId<"note">;
            out: RecordId<"note">;
            source: string;
            class: string;
            agent?: string;
            confidence: number;
            evidence?: RecordId<"chunk">[];
            approved: boolean;
            applied: boolean;
            created_at: unknown;
          }>,
        ]
      >(
        "SELECT id, in, out, source, class, agent, confidence, evidence, approved, applied, created_at FROM related_to WHERE id = $id;",
        { id: seed.edgeId },
      )
      .collect<
        [
          Array<{
            id: RecordId;
            in: RecordId<"note">;
            out: RecordId<"note">;
            source: string;
            class: string;
            agent?: string;
            confidence: number;
            evidence?: RecordId<"chunk">[];
            approved: boolean;
            applied: boolean;
            created_at: unknown;
          }>,
        ]
      >();
    const original = originalRows[0];
    if (original === undefined) throw new Error("seeded rejection edge disappeared");

    const first = await service.rejectEdge({
      id: seed.edgeId,
      table: "related_to",
      reason: "weak connection",
      rejectedBy: "operator-a",
    });
    const retried = await service.rejectEdge({
      id: seed.edgeId,
      table: "related_to",
      reason: "a conflicting retry must not replace the first reason",
      rejectedBy: "operator-b",
    });

    expect(first).not.toBeNull();
    expect(retried).toEqual(first);
    if (first === null) throw new Error("proposal rejection returned no audit");
    expect(first.reason).toBe("weak connection");

    const [rows] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM related_to WHERE id = $id;", {
        id: seed.edgeId,
      })
      .collect<[Array<{ id: RecordId }>]>();
    expect(rows.length).toBe(0);

    const [historyRows] = await connection.db
      .query<
        [
          Array<{
            id: RecordId<"history">;
            kind: string;
            target: string;
            before: { data: unknown };
            after: { data: unknown };
            client_identity: string;
          }>,
        ]
      >("SELECT id, kind, target, before, after, client_identity FROM history;")
      .collect<
        [
          Array<{
            id: RecordId<"history">;
            kind: string;
            target: string;
            before: { data: unknown };
            after: { data: unknown };
            client_identity: string;
          }>,
        ]
      >();
    expect(historyRows).toHaveLength(1);
    const audit = historyRows[0];
    if (audit === undefined) throw new Error("proposal rejection audit missing");
    expect(audit.id.toString()).toBe(first.historyId);
    expect(audit.kind).toBe("proposal.reject");
    expect(audit.target).toBe(seed.edgeId.toString());
    expect(audit.client_identity).toBe("operator-a");
    expect(audit.before.data).toEqual({
      id: original.id,
      table: "related_to",
      in: original.in,
      out: original.out,
      source: original.source,
      class: original.class,
      agent: original.agent,
      confidence: original.confidence,
      evidence: original.evidence ?? [],
      approved: original.approved,
      applied: original.applied,
      created_at: original.created_at,
    });
    expect(audit.after.data).toEqual({
      decision: "rejected",
      reason: "weak connection",
    });
    expect(events).toEqual([
      {
        reason: "weak connection",
        decidedBy: "operator-a",
        historyId: first.historyId,
      },
    ]);
    expect(historyPrunes).toBe(2);
  });

  test("[smoke] simultaneous rejects create one audit and emit one decision", async () => {
    await writeFile(path.join(vaultRoot, "alpha.md"), "# Alpha\n");
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "supports");
    const bus = new EventBus();
    const events: Array<{
      reason: string | null;
      decidedBy: string;
      historyId: string;
    }> = [];
    bus.on("approval:decided", (event) => {
      if (event.decision === "rejected") {
        events.push({
          reason: event.reason,
          decidedBy: event.decidedBy,
          historyId: event.historyId,
        });
      }
    });
    const service = new ApprovalService({
      db: connection.db,
      bus,
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });

    const [left, right] = await Promise.all([
      service.rejectEdge({
        id: seed.edgeId,
        table: "supports",
        reason: "first concurrent reason",
        rejectedBy: "operator-left",
      }),
      service.rejectEdge({
        id: seed.edgeId,
        table: "supports",
        reason: "second concurrent reason",
        rejectedBy: "operator-right",
      }),
    ]);

    expect(left).not.toBeNull();
    expect(right).toEqual(left);
    const winner = left;
    if (winner === null) throw new Error("concurrent rejection returned no decision");

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
    const audit = historyRows[0];
    if (audit === undefined) throw new Error("concurrent rejection audit missing");
    const decision = audit.after.data as { decision: string; reason: string | null };
    if (decision.reason === null) throw new Error("concurrent rejection lost both reasons");
    const expectedOperator =
      decision.reason === "first concurrent reason" ? "operator-left" : "operator-right";
    expect(["first concurrent reason", "second concurrent reason"]).toContain(decision.reason);
    expect(decision.decision).toBe("rejected");
    expect(audit.client_identity).toBe(expectedOperator);
    expect(audit.id.toString()).toBe(winner.historyId);
    expect(winner.reason).toBe(decision.reason);
    expect(events).toEqual([
      {
        reason: decision.reason,
        decidedBy: expectedOperator,
        historyId: winner.historyId,
      },
    ]);
  });

  test("[smoke] failed rejection transaction preserves the edge and creates no audit", async () => {
    await writeFile(path.join(vaultRoot, "alpha.md"), "# Alpha\n");
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "contradicts");
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("approval:decided", (event) => events.push(event.decision));
    const db = {
      query: (sql: string, bindings?: Record<string, unknown>) =>
        connection.db.query(
          sql.includes("CREATE ONLY $historyId")
            ? sql.replace("COMMIT;", 'THROW "forced rejection failure";\nCOMMIT;')
            : sql,
          bindings,
        ),
    } as unknown as ConstructorParameters<typeof ApprovalService>[0]["db"];
    const service = new ApprovalService({
      db,
      bus,
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });

    await expect(
      service.rejectEdge({
        id: seed.edgeId,
        table: "contradicts",
        reason: "must roll back",
        rejectedBy: "operator-failure",
      }),
    ).rejects.toThrow("failed transaction");

    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean }>]>("SELECT approved FROM contradicts WHERE id = $id;", {
        id: seed.edgeId,
      })
      .collect<[Array<{ approved: boolean }>]>();
    const [historyRows] = await connection.db
      .query<[Array<{ id: RecordId<"history"> }>]>(
        "SELECT id FROM history WHERE kind = 'proposal.reject';",
      )
      .collect<[Array<{ id: RecordId<"history"> }>]>();
    expect(edgeRows).toEqual([{ approved: false }]);
    expect(historyRows).toEqual([]);
    expect(events).toEqual([]);
  });

  test("[smoke] listPendingEdges returns rows with approved=false across writeback tables", async () => {
    await writeFile(path.join(vaultRoot, "alpha.md"), "# Alpha\n");
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    await seedProposal(connection, "supports");
    await seedProposal(connection, "contradicts");
    const service = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    const pending = await service.listPendingEdges();
    expect(pending.length).toBe(2);
    const tables = pending.map((entry) => entry.table).sort();
    expect(tables).toEqual(["contradicts", "supports"]);
  });

  test("[smoke] schema-valid but noncanonical proposal rows fail closed", async () => {
    const sourceNoteId = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    const targetNoteId = await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: "sha-beta",
      wordCount: 3,
    });
    const corruptions = [
      "source = 'linker', class = 'INFERRED', confidence = 0.8, approved = false",
      "source = 'linker', class = 'INFERRED', confidence = 0.8, agent = 'linker', evidence = [], approved = false",
      "source = 'user', class = 'INFERRED', confidence = 0.8, agent = 'user', approved = false",
      "source = 'linker', class = 'AMBIGUOUS', confidence = 0.8, agent = 'linker', approved = false",
      "source = 'linker', class = 'INFERRED', confidence = 0.8, agent = 'synthesizer', approved = false",
    ];
    const service = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });

    for (const fields of corruptions) {
      await connection.db
        .query(`RELATE $from->supports->$to SET ${fields};`, {
          from: sourceNoteId,
          to: targetNoteId,
        })
        .collect();
      await expect(service.listPendingEdges()).rejects.toThrow("proposal storage integrity");
      await connection.db.query("DELETE supports;").collect();
    }
  });

  test("[smoke] invalid pending-state combinations cannot be listed, approved, or rejected", async () => {
    const seed = await seedProposal(connection, "supports");
    await connection.db
      .query("UPDATE $id SET applied = false WHERE approved = false RETURN NONE;", {
        id: seed.edgeId,
      })
      .collect();
    const bus = new EventBus();
    const decisions: string[] = [];
    bus.on("approval:decided", (event) => decisions.push(event.decision));
    const service = new ApprovalService({
      db: connection.db,
      bus,
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });

    expect(await service.listPendingEdges()).toEqual([]);
    await service.approveEdge({ id: seed.edgeId, table: "supports", approvedBy: "human" });
    expect(
      await service.rejectEdge({
        id: seed.edgeId,
        table: "supports",
        rejectedBy: "operator",
      }),
    ).toBeNull();
    const [rows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM supports WHERE id = $id;",
        { id: seed.edgeId },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(rows).toEqual([{ approved: false, applied: false }]);
    expect(decisions).toEqual([]);
  });

  test("[smoke] reconciliation rejects an applying edge without a durable intent", async () => {
    const seed = await seedProposal(connection, "extends");
    await connection.db
      .query(
        "UPDATE $id SET approved = true, applied = false, approved_by = 'human' RETURN NONE;",
        { id: seed.edgeId },
      )
      .collect();
    const bus = new EventBus();
    const failures: Array<{
      type: "indexer:error";
      path: string;
      message: string;
      phase?: string;
    }> = [];
    bus.on("indexer:error", (event) => failures.push(event));
    const service = new ApprovalService({
      db: connection.db,
      bus,
      vault: {
        read: async () => {
          throw new Error("live reconciliation read failure");
        },
        writeIfUnchanged: (notePath, expected, content) =>
          new FsVault(vaultRoot).writeIfUnchanged(notePath, expected, content),
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });

    expect(await service.reconcilePendingApplications()).toEqual({
      replayed: 0,
      abandoned: 0,
      failed: 1,
      deferred: 0,
    });
    expect(failures).toEqual([
      {
        type: "indexer:error",
        path: seed.edgeId.toString(),
        phase: "approval-reconciliation",
        message: "approval storage integrity: applying edge has no durable write intent",
      },
    ]);
  });

  test("[smoke] read failure before planning leaves the proposal pending", async () => {
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, "# Alpha\n\nbody.\n");
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "extends");
    const bus = new EventBus();

    // The exact body plan is computed before the atomic claim+intent
    // transaction, so a read failure never creates an applying edge.
    const failing = new ApprovalService({
      db: connection.db,
      bus,
      vault: {
        read: async () => {
          throw new Error("synthetic read failure after approved flip");
        },
        writeIfUnchanged: (notePath, expected, content) =>
          new FsVault(vaultRoot).writeIfUnchanged(notePath, expected, content),
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    await expect(
      failing.approveEdge({ id: seed.edgeId, table: "extends", approvedBy: "human" }),
    ).rejects.toThrow("synthetic read failure");

    // The body must still be the pre-write content because the file write
    // never ran.
    const bodyAfterCrash = await readFile(sourcePath, "utf8");
    expect(bodyAfterCrash).toBe("# Alpha\n\nbody.\n");
    const [rowsBefore] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM extends WHERE id = $id;",
        { id: seed.edgeId },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(rowsBefore[0]?.approved).toBe(false);
    expect(rowsBefore[0]?.applied).toBe(true);

    // A fresh explicit approval can now complete the writeback.
    const recovering = new ApprovalService({
      db: connection.db,
      bus,
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    const result = await recovering.approveEdge({
      id: seed.edgeId,
      table: "extends",
      approvedBy: "human",
    });
    expect(result).not.toBeNull();

    const bodyAfter = await readFile(sourcePath, "utf8");
    expect(bodyAfter).toContain("[[beta]]");

    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM extends WHERE id = $id;",
        { id: seed.edgeId },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(edgeRows[0]?.approved).toBe(true);
    expect(edgeRows[0]?.applied).toBe(true);

    const [daemonRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM daemon_write;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(daemonRows.length).toBe(1);

    const [historyRows] = await connection.db
      .query<[Array<{ id: RecordId; kind: string }>]>("SELECT id, kind FROM history;")
      .collect<[Array<{ id: RecordId; kind: string }>]>();
    expect(historyRows.length).toBe(1);
    expect(historyRows[0].kind).toBe("note.frontmatter");
  });

  test("[smoke] concurrent approval and reconciliation converge on one deterministic commit", async () => {
    const originalBody = "# Alpha\n\nbody.\n";
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, originalBody);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "related_to");
    const durableVault = new FsVault(vaultRoot);
    const bus = new EventBus();
    const acceptedHistoryIds: string[] = [];
    bus.on("approval:decided", (event) => {
      if (event.decision === "accepted") acceptedHistoryIds.push(event.historyId);
    });

    // The first instance prepares the durable intent, then simulates a crash
    // before daemon attribution or a filesystem write. Reusing the instance
    // below keeps the actual race to exactly two ApprovalService instances.
    let preparationReads = 0;
    let interruptBeforeWrite = true;
    const approving = new ApprovalService({
      db: connection.db,
      bus,
      vault: {
        read: async (notePath) => {
          preparationReads += 1;
          if (interruptBeforeWrite && preparationReads === 2) {
            interruptBeforeWrite = false;
            throw new Error("synthetic pause after intent preparation");
          }
          return await durableVault.read(notePath);
        },
        writeIfUnchanged: (notePath, expected, content) =>
          durableVault.writeIfUnchanged(notePath, expected, content),
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    await expect(
      approving.approveEdge({ id: seed.edgeId, table: "related_to", approvedBy: "human" }),
    ).rejects.toThrow("synthetic pause after intent preparation");
    expect(await readEdgeDecisionState(connection, "related_to", seed.edgeId)).toEqual([
      { approved: true, applied: false, approved_by: "human" },
    ]);
    expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(1);
    expect(await countApprovalArtifacts(connection, "history")).toBe(0);
    expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(0);

    // Hold the reconciler after it has validated the same intent and edge.
    // The explicit approval commits while reconciliation is still active;
    // releasing the read then forces the stale recovery path to discover the
    // deterministic receipt rather than duplicate any side effect.
    let observedReconcileRead: () => void = () => {};
    const reconcileReadObserved = new Promise<void>((resolve) => {
      observedReconcileRead = resolve;
    });
    let releaseReconcileRead: () => void = () => {};
    const reconcileReadReleased = new Promise<void>((resolve) => {
      releaseReconcileRead = resolve;
    });
    let heldRead = false;
    const reconciling = new ApprovalService({
      db: connection.db,
      bus,
      vault: {
        read: async (notePath) => {
          if (!heldRead) {
            heldRead = true;
            observedReconcileRead();
            await reconcileReadReleased;
          }
          return await durableVault.read(notePath);
        },
        writeIfUnchanged: (notePath, expected, content) =>
          durableVault.writeIfUnchanged(notePath, expected, content),
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });

    const reconciliationPromise = reconciling.reconcilePendingApplications();
    await reconcileReadObserved;
    let receipt: Awaited<ReturnType<ApprovalService["approveEdge"]>>;
    try {
      receipt = await approving.approveEdge({
        id: seed.edgeId,
        table: "related_to",
        approvedBy: "human",
      });
    } finally {
      releaseReconcileRead();
    }
    expect(await reconciliationPromise).toEqual({
      replayed: 1,
      abandoned: 0,
      failed: 0,
      deferred: 0,
    });
    expect(receipt).not.toBeNull();

    const expectedHistoryId = (await proposalAcceptanceHistoryId(seed.edgeId)).toString();
    expect(receipt?.historyId).toBe(expectedHistoryId);
    expect(
      await reconciling.approveEdge({
        id: seed.edgeId,
        table: "related_to",
        approvedBy: "human",
      }),
    ).toEqual(receipt);
    expect(await readFile(sourcePath, "utf8")).toContain("[[beta]]");
    expect(await readEdgeDecisionState(connection, "related_to", seed.edgeId)).toEqual([
      { approved: true, applied: true, approved_by: "human" },
    ]);
    expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(0);
    expect(await countApprovalArtifacts(connection, "history")).toBe(1);
    expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(1);
    expect(acceptedHistoryIds).toEqual([expectedHistoryId]);
  });

  test("[smoke] an external third-value edit after intent preparation is never overwritten", async () => {
    const originalBody = "# Alpha\n\nbody.\n";
    const externalBody = "# Alpha\n\nexternal edit wins.\n";
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, originalBody);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "contradicts");
    const durableVault = new FsVault(vaultRoot);
    const bus = new EventBus();
    const decisions: string[] = [];
    bus.on("approval:decided", (event) => decisions.push(event.decision));
    let reads = 0;
    let writes = 0;
    const service = new ApprovalService({
      db: connection.db,
      bus,
      vault: {
        read: async (notePath) => {
          reads += 1;
          if (reads === 2) await writeFile(sourcePath, externalBody);
          return await durableVault.read(notePath);
        },
        writeIfUnchanged: async (notePath, expected, content) => {
          writes += 1;
          return await durableVault.writeIfUnchanged(notePath, expected, content);
        },
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });

    await expect(
      service.approveEdge({ id: seed.edgeId, table: "contradicts", approvedBy: "human" }),
    ).rejects.toThrow("changed after the decision was prepared");
    expect(reads).toBe(2);
    expect(writes).toBe(0);

    const recovering = new ApprovalService({
      db: connection.db,
      bus,
      vault: durableVault,
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    expect(await recovering.reconcilePendingApplications()).toEqual({
      replayed: 0,
      abandoned: 0,
      failed: 1,
      deferred: 0,
    });
    expect(await readFile(sourcePath, "utf8")).toBe(externalBody);
    expect(await readEdgeDecisionState(connection, "contradicts", seed.edgeId)).toEqual([
      { approved: true, applied: false, approved_by: "human" },
    ]);
    const intents = await readIntentStates(connection);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      source_path: "alpha.md",
      before_body: originalBody,
      write_started_at: undefined,
    });
    expect(intents[0]?.after_body).not.toBe(originalBody);
    expect(intents[0]?.after_body).not.toBe(externalBody);
    expect(await countApprovalArtifacts(connection, "history")).toBe(0);
    expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(0);
    expect(decisions).toEqual([]);
  });

  test("[smoke] a human save at the final filesystem boundary wins over approval", async () => {
    const originalBody = "# Alpha\n\nbody.\n";
    const externalBody = "# Alpha\n\nlast-moment human edit.\n";
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, originalBody);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "related_to");
    const durableVault = new FsVault(vaultRoot);
    let compareWrites = 0;
    const service = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: {
        read: (notePath) => durableVault.read(notePath),
        writeIfUnchanged: async (notePath, expected, content) => {
          compareWrites += 1;
          await writeFile(sourcePath, externalBody);
          return await durableVault.writeIfUnchanged(notePath, expected, content);
        },
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });

    await expect(
      service.approveEdge({ id: seed.edgeId, table: "related_to", approvedBy: "human" }),
    ).rejects.toThrow("changed immediately before writeback");

    expect(compareWrites).toBe(1);
    expect(await readFile(sourcePath, "utf8")).toBe(externalBody);
    expect(await readEdgeDecisionState(connection, "related_to", seed.edgeId)).toEqual([
      { approved: true, applied: false, approved_by: "human" },
    ]);
    expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(1);
    expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(1);
    expect(await countApprovalArtifacts(connection, "history")).toBe(0);
  });

  test("[smoke] deleting an endpoint rolls back exact Notient bytes and clears the in-flight intent", async () => {
    const originalBody = "# Alpha\n\nbody.\n";
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, originalBody);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "supports");
    const vault = new FsVault(vaultRoot);
    const failing = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: {
        read: (notePath) => vault.read(notePath),
        writeIfUnchanged: async (notePath, expected, content) => {
          await vault.writeIfUnchanged(notePath, expected, content);
          throw new Error("synthetic crash after approval rename");
        },
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });

    await expect(
      failing.approveEdge({ id: seed.edgeId, table: "supports", approvedBy: "human" }),
    ).rejects.toThrow("synthetic crash after approval rename");
    expect(await readFile(sourcePath, "utf8")).not.toBe(originalBody);
    expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(1);
    expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(1);

    const recovering = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault,
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    const deletionToken = await tombstoneNoteById(connection, seed.targetNoteId);
    if (deletionToken === null) throw new Error("failed to tombstone approval endpoint");
    expect(await recovering.cancelForNoteDeletion(seed.targetNoteId, deletionToken)).toEqual({
      cancelled: 1,
      failed: 0,
    });
    expect(await readFile(sourcePath, "utf8")).toBe(originalBody);
    expect(await readEdgeDecisionState(connection, "supports", seed.edgeId)).toEqual([]);
    expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(0);
    expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(0);
    expect(await countApprovalArtifacts(connection, "history")).toBe(0);
    const [firstTombstoneRows] = await connection.db
      .query<[Array<{ tombstoned_at: unknown }>]>(
        "SELECT tombstoned_at FROM note WHERE id = $id;",
        { id: seed.targetNoteId },
      )
      .collect<[Array<{ tombstoned_at: unknown }>]>();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await recovering.cancelForNoteDeletion(seed.targetNoteId, deletionToken)).toEqual({
      cancelled: 0,
      failed: 0,
    });
    const [secondTombstoneRows] = await connection.db
      .query<[Array<{ tombstoned_at: unknown }>]>(
        "SELECT tombstoned_at FROM note WHERE id = $id;",
        { id: seed.targetNoteId },
      )
      .collect<[Array<{ tombstoned_at: unknown }>]>();
    expect(String(secondTombstoneRows[0]?.tombstoned_at)).toBe(
      String(firstTombstoneRows[0]?.tombstoned_at),
    );
  });

  test("[smoke] boot reconciliation completes a cancellation interrupted after its durable request", async () => {
    const originalBody = "# Alpha\n\nbody.\n";
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, originalBody);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "contradicts");
    const vault = new FsVault(vaultRoot);
    const interrupted = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: {
        read: (notePath) => vault.read(notePath),
        writeIfUnchanged: async (notePath, expected, content) => {
          await vault.writeIfUnchanged(notePath, expected, content);
          throw new Error("synthetic process death after approval rename");
        },
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    await expect(
      interrupted.approveEdge({
        id: seed.edgeId,
        table: "contradicts",
        approvedBy: "human",
      }),
    ).rejects.toThrow("synthetic process death after approval rename");
    await connection.db
      .query(
        `BEGIN;
UPDATE $note SET tombstoned_at = time::now() WHERE tombstoned_at IS NONE RETURN NONE;
UPDATE approval_intent SET cancel_requested_at = time::now() WHERE target_note = $note AND cancel_requested_at IS NONE RETURN NONE;
COMMIT;`,
        { note: seed.targetNoteId },
      )
      .collect();

    const restarted = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault,
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    expect(await restarted.reconcilePendingApplications()).toEqual({
      replayed: 1,
      abandoned: 0,
      failed: 0,
      deferred: 0,
    });
    expect(await readFile(sourcePath, "utf8")).toBe(originalBody);
    expect(await readEdgeDecisionState(connection, "contradicts", seed.edgeId)).toEqual([]);
    expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(0);
    expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(0);
    expect(await countApprovalArtifacts(connection, "history")).toBe(0);
  });

  test("[smoke] approval cancellation preserves a third-value human edit and a missing source", async () => {
    for (const sourceState of ["human-edit", "missing"] as const) {
      await clearAllRows(connection);
      const originalBody = "# Alpha\n\nbody.\n";
      const humanBody = "# Alpha\n\nhuman edit after the approval decision.\n";
      const sourcePath = path.join(vaultRoot, "alpha.md");
      await writeFile(sourcePath, originalBody);
      await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
      const seed = await seedProposal(connection, "related_to");
      const vault = new FsVault(vaultRoot);
      let reads = 0;
      const interrupted = new ApprovalService({
        db: connection.db,
        bus: new EventBus(),
        vault: {
          read: async (notePath) => {
            reads += 1;
            if (reads === 2) throw new Error("synthetic crash before approval write");
            return await vault.read(notePath);
          },
          writeIfUnchanged: (notePath, expected, content) =>
            vault.writeIfUnchanged(notePath, expected, content),
        },
        hash: sha256Hex,
        pruneHistory: async () => {},
      });
      await expect(
        interrupted.approveEdge({
          id: seed.edgeId,
          table: "related_to",
          approvedBy: "human",
        }),
      ).rejects.toThrow("synthetic crash before approval write");
      if (sourceState === "human-edit") await writeFile(sourcePath, humanBody);
      else await rm(sourcePath);

      const recovering = new ApprovalService({
        db: connection.db,
        bus: new EventBus(),
        vault,
        hash: sha256Hex,
        pruneHistory: async () => {},
      });
      const deletionToken = await tombstoneNoteById(connection, seed.sourceNoteId);
      if (deletionToken === null) throw new Error("failed to tombstone approval endpoint");
      expect(await recovering.cancelForNoteDeletion(seed.sourceNoteId, deletionToken)).toEqual({
        cancelled: 1,
        failed: 0,
      });
      if (sourceState === "human-edit") expect(await readFile(sourcePath, "utf8")).toBe(humanBody);
      else await expect(readFile(sourcePath, "utf8")).rejects.toThrow();
      expect(await readEdgeDecisionState(connection, "related_to", seed.edgeId)).toEqual([]);
      expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(0);
      expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(0);
      expect(await countApprovalArtifacts(connection, "history")).toBe(0);
    }
  });

  test("[smoke] cancellation preserves byte-identical operator content when Notient never started its write", async () => {
    const originalBody = "# Alpha\n\nbody.\n";
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, originalBody);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "supports");
    const vault = new FsVault(vaultRoot);
    let reads = 0;
    const interrupted = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: {
        read: async (notePath) => {
          reads += 1;
          if (reads === 2) throw new Error("synthetic crash before write-start");
          return await vault.read(notePath);
        },
        writeIfUnchanged: (notePath, expected, content) =>
          vault.writeIfUnchanged(notePath, expected, content),
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    await expect(
      interrupted.approveEdge({ id: seed.edgeId, table: "supports", approvedBy: "human" }),
    ).rejects.toThrow("synthetic crash before write-start");
    const [intent] = await readIntentStates(connection);
    if (intent === undefined) throw new Error("approval intent was not persisted");
    expect(intent.write_started_at).toBeUndefined();

    // These bytes equal the planned result, but the durable state proves
    // Notient never began its filesystem write. They therefore belong to the
    // operator and cancellation must not roll them back.
    await writeFile(sourcePath, intent.after_body);
    const recovering = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault,
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    const deletionToken = await tombstoneNoteById(connection, seed.targetNoteId);
    if (deletionToken === null) throw new Error("failed to tombstone approval endpoint");
    expect(await recovering.cancelForNoteDeletion(seed.targetNoteId, deletionToken)).toEqual({
      cancelled: 1,
      failed: 0,
    });
    expect(await readFile(sourcePath, "utf8")).toBe(intent.after_body);
    expect(await readEdgeDecisionState(connection, "supports", seed.edgeId)).toEqual([]);
    expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(0);
    expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(0);
    expect(await countApprovalArtifacts(connection, "history")).toBe(0);
  });

  test("[smoke] concurrent approval and endpoint deletion converge without a stranded state-2 edge", async () => {
    const originalBody = "# Alpha\n\nbody.\n";
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, originalBody);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "extends");
    const vault = new FsVault(vaultRoot);
    let releaseRead = (): void => {};
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let observeRead = (): void => {};
    const readObserved = new Promise<void>((resolve) => {
      observeRead = resolve;
    });
    let reads = 0;
    const service = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: {
        read: async (notePath) => {
          reads += 1;
          if (reads === 2) {
            observeRead();
            await readReleased;
          }
          return await vault.read(notePath);
        },
        writeIfUnchanged: (notePath, expected, content) =>
          vault.writeIfUnchanged(notePath, expected, content),
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });

    const approval = service.approveEdge({
      id: seed.edgeId,
      table: "extends",
      approvedBy: "human",
    });
    await readObserved;
    const deletionToken = await tombstoneNoteById(connection, seed.targetNoteId);
    if (deletionToken === null) throw new Error("failed to tombstone approval endpoint");
    const purge = purgeNoteGraph(connection, seed.targetNoteId, deletionToken, service);
    const deadline = Date.now() + 2_000;
    for (;;) {
      const [rows] = await connection.db
        .query<[Array<{ cancel_requested_at?: unknown }>]>(
          "SELECT cancel_requested_at FROM approval_intent;",
        )
        .collect<[Array<{ cancel_requested_at?: unknown }>]>();
      if (rows[0]?.cancel_requested_at !== undefined) break;
      if (Date.now() >= deadline) throw new Error("cancellation request was not persisted");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseRead();

    expect(await approval).toBeNull();
    await expect(purge).resolves.toBe(true);
    expect(await readFile(sourcePath, "utf8")).toBe(originalBody);
    expect(await readEdgeDecisionState(connection, "extends", seed.edgeId)).toEqual([]);
    expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(0);
    expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(0);
    expect(await countApprovalArtifacts(connection, "history")).toBe(0);
    expect(await lookupNoteByPath(connection.db, "beta.md")).toBeNull();
  });

  test("[smoke] externally produced intended bytes without write-start remain a conflict", async () => {
    const originalBody = "# Alpha\n\nbody.\n";
    const intendedBody = applyApprovedRelation(originalBody, {
      key: "supports",
      target: "beta",
    });
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, originalBody);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "supports");
    const durableVault = new FsVault(vaultRoot);
    const bus = new EventBus();
    const decisions: string[] = [];
    bus.on("approval:decided", (event) => decisions.push(event.decision));
    let reads = 0;
    const service = new ApprovalService({
      db: connection.db,
      bus,
      vault: {
        read: async (notePath) => {
          reads += 1;
          if (reads === 2) await writeFile(sourcePath, intendedBody);
          return await durableVault.read(notePath);
        },
        writeIfUnchanged: (notePath, expected, content) =>
          durableVault.writeIfUnchanged(notePath, expected, content),
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });

    await expect(
      service.approveEdge({ id: seed.edgeId, table: "supports", approvedBy: "human" }),
    ).rejects.toThrow("reached the intended bytes outside Notient");
    const retrying = new ApprovalService({
      db: connection.db,
      bus,
      vault: durableVault,
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    await expect(
      retrying.approveEdge({ id: seed.edgeId, table: "supports", approvedBy: "human" }),
    ).rejects.toThrow("reached the intended bytes outside Notient");

    expect(await readFile(sourcePath, "utf8")).toBe(intendedBody);
    expect(await readEdgeDecisionState(connection, "supports", seed.edgeId)).toEqual([
      { approved: true, applied: false, approved_by: "human" },
    ]);
    expect(await readIntentStates(connection)).toEqual([
      {
        source_path: "alpha.md",
        before_body: originalBody,
        after_body: intendedBody,
        write_started_at: undefined,
      },
    ]);
    expect(await countApprovalArtifacts(connection, "history")).toBe(0);
    expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(0);
    expect(decisions).toEqual([]);
  });

  test("[smoke] endpoint path changes between planning and claim leave the edge pending", async () => {
    const originalBody = "# Alpha\n\nbody.\n";
    const cases = [
      { endpoint: "source", nextPath: "moved-alpha.md" },
      { endpoint: "target", nextPath: "moved-beta.md" },
    ] as const;

    for (const testCase of cases) {
      await clearAllRows(connection);
      await writeFile(path.join(vaultRoot, "alpha.md"), originalBody);
      await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
      const seed = await seedProposal(connection, "extends");
      const noteId = testCase.endpoint === "source" ? seed.sourceNoteId : seed.targetNoteId;
      const bus = new EventBus();
      const decisions: string[] = [];
      bus.on("approval:decided", (event) => decisions.push(event.decision));
      let pathChanged = false;
      const service = new ApprovalService({
        db: connection.db,
        bus,
        vault: new FsVault(vaultRoot),
        hash: async (body) => {
          if (!pathChanged) {
            pathChanged = true;
            await connection.db
              .query("UPDATE ONLY $noteId SET path = $nextPath RETURN NONE;", {
                noteId,
                nextPath: testCase.nextPath,
              })
              .collect();
          }
          return await sha256Hex(body);
        },
        pruneHistory: async () => {},
      });

      // Hashing occurs after both endpoint paths and exact bodies are planned,
      // but before the atomic edge-claim transaction. Moving either endpoint
      // here must make the transaction's live-path predicate fail closed.
      expect(
        await service.approveEdge({
          id: seed.edgeId,
          table: "extends",
          approvedBy: "human",
        }),
      ).toBeNull();
      expect(pathChanged).toBe(true);
      expect(await readEdgeDecisionState(connection, "extends", seed.edgeId)).toEqual([
        { approved: false, applied: true, approved_by: undefined },
      ]);
      expect(await countApprovalArtifacts(connection, "approval_intent")).toBe(0);
      expect(await countApprovalArtifacts(connection, "history")).toBe(0);
      expect(await countApprovalArtifacts(connection, "daemon_write")).toBe(0);
      expect(await readFile(path.join(vaultRoot, "alpha.md"), "utf8")).toBe(originalBody);
      expect(decisions).toEqual([]);
    }
  });

  test("[smoke] vault write response failure recovers without duplicate side-effects", async () => {
    const originalBody = "# Alpha\n\nbody.\n";
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, originalBody);
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "synthesizes");
    const bus = new EventBus();

    const durableVault = new FsVault(vaultRoot);
    const failAfterWriteVault = {
      read: (notePath: string) => durableVault.read(notePath),
      writeIfUnchanged: async (
        notePath: string,
        expected: string,
        content: string,
      ): Promise<boolean> => {
        await durableVault.writeIfUnchanged(notePath, expected, content);
        throw new Error("synthetic response loss after durable vault write");
      },
    };
    const failing = new ApprovalService({
      db: connection.db,
      bus,
      vault: failAfterWriteVault,
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    await expect(
      failing.approveEdge({ id: seed.edgeId, table: "synthesizes", approvedBy: "human" }),
    ).rejects.toThrow("synthetic response loss");

    // File mutation is durable even though the rename response was lost.
    const bodyAfterCrash = await readFile(sourcePath, "utf8");
    expect(bodyAfterCrash).toContain("[[beta]]");

    // daemon_write landed; history did not.
    const [daemonBefore] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM daemon_write;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(daemonBefore.length).toBe(1);
    const [historyBefore] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM history;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(historyBefore.length).toBe(0);

    // Reconcile from the immutable write-ahead intent. The body already
    // contains the intended bytes, but the original bytes remain durable in
    // the intent rather than being reconstructed as a false no-op snapshot.
    const recovering = new ApprovalService({
      db: connection.db,
      bus,
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    const result = await recovering.reconcilePendingApplications();
    expect(result.replayed).toBe(1);
    expect(result.failed).toBe(0);

    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM synthesizes WHERE id = $id;",
        { id: seed.edgeId },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(edgeRows[0]?.approved).toBe(true);
    expect(edgeRows[0]?.applied).toBe(true);

    const [daemonAfter] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM daemon_write;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(daemonAfter.length).toBe(1);
    const [historyAfter] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM history;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(historyAfter.length).toBe(1);

    const vault = new FsVault(vaultRoot);
    const historyService = new HistoryService({
      db: connection.db,
      inverters: {
        "note.frontmatter": makeNoteBodyInverter({
          facade: vault,
          hash: sha256Hex,
          updateNoteSha: async () => {},
          validateTargetIdentity: async () => true,
        }),
      },
      retention: { max: 100, maxPerTarget: 20 },
    });
    const [receipt] = await historyService.getRecent(1);
    expect(receipt?.before).toBe(originalBody);
    expect(receipt?.after).toBe(bodyAfterCrash);
    expect(receipt?.id).toBe(historyAfter[0]?.id.toString());
    if (receipt === undefined) throw new Error("missing recovered approval receipt");
    expect(await historyService.undo(receipt.id)).toMatchObject({ ok: true });
    expect(await readFile(sourcePath, "utf8")).toBe(originalBody);
  });

  test("[smoke] caller response loss after commit leaves state consistent", async () => {
    const sourcePath = path.join(vaultRoot, "alpha.md");
    await writeFile(sourcePath, "# Alpha\n\nbody.\n");
    await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
    const seed = await seedProposal(connection, "exemplifies");
    const bus = new EventBus();
    const decisions: string[] = [];
    bus.on("approval:decided", (event) => decisions.push(event.historyId));

    const committed = new ApprovalService({
      db: connection.db,
      bus,
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    const lostResponse = committed
      .approveEdge({ id: seed.edgeId, table: "exemplifies", approvedBy: "human" })
      .then(() => Promise.reject(new Error("synthetic caller response loss")));
    await expect(lostResponse).rejects.toThrow("synthetic caller response loss");

    // Closing transaction succeeded. Edge is in state 3.
    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM exemplifies WHERE id = $id;",
        { id: seed.edgeId },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(edgeRows[0]?.approved).toBe(true);
    expect(edgeRows[0]?.applied).toBe(true);

    const [daemonBefore] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM daemon_write;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(daemonBefore.length).toBe(1);
    const [historyBefore] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM history;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(historyBefore.length).toBe(1);

    const retried = await committed.approveEdge({
      id: seed.edgeId,
      table: "exemplifies",
      approvedBy: "human",
    });
    expect(retried).toEqual({
      historyId: historyBefore[0]?.id.toString(),
      approvedBy: "human",
    });
    expect(decisions).toEqual([historyBefore[0]?.id.toString()]);

    // Reconciliation finds no rows in state 2 and does nothing.
    const recovering = new ApprovalService({
      db: connection.db,
      bus,
      vault: new FsVault(vaultRoot),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    const result = await recovering.reconcilePendingApplications();
    expect(result.replayed).toBe(0);
    expect(result.failed).toBe(0);

    const [daemonAfter] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM daemon_write;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(daemonAfter.length).toBe(1);
    const [historyAfter] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM history;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(historyAfter.length).toBe(1);
  });
  for (const revoke of [false, true]) {
    test(`direct relationship recovery keeps explicit operator authority: revoke=${revoke}`, async () => {
      const before = "# Alpha\n\nOriginal.\n";
      await writeFile(path.join(vaultRoot, "alpha.md"), before);
      await writeFile(path.join(vaultRoot, "beta.md"), "# Beta\n");
      const { edgeId } = await seedProposal(connection, "supports");
      const operator = {
        id: "paired-reviewer",
        kind: "human" as const,
        scopes: ["read", "write", "admin"],
      };
      let blocked = true;
      let active = true;
      const vault = new FsVault(vaultRoot, {
        beforeMutation: async () => {
          if (blocked) throw new VaultMutationBlockedError("host offline");
          return undefined;
        },
      });
      const options: ConstructorParameters<typeof ApprovalService>[0] = {
        db: connection.db,
        bus: new EventBus(),
        vault,
        hash: sha256Hex,
        pruneHistory: async () => {},
        authorizeRecovery: async (edge, transition) => {
          if (!transition.toolApproval) throw new EffectAuthorityRevoked("missing permission");
          assertToolTarget(transition.toolApproval, transition.clientIdentity, { edgeId: edge });
          await assertToolApproval(transition.toolApproval, {
            authorizeIdentity: () => {
              if (!active) throw new EffectAuthorityRevoked("operator revoked");
            },
            grant: async () => null,
            policy: async () => ({ approvalMode: "safe", perTool: {} }),
          });
        },
      };
      const proof = toolApproval(
        { id: "approve", name: "proposals.approve", args: { id: edgeId.toString() } },
        operator.id,
        { kind: "human", operator },
      );
      await expect(
        new ApprovalService(options).approveEdge({
          id: edgeId,
          table: "supports",
          approvedBy: operator.id,
          toolApproval: proof,
        }),
      ).rejects.toThrow("host offline");
      active = !revoke;
      blocked = false;
      const result = await new ApprovalService(options).reconcilePendingApplications();
      expect(result).toEqual({
        replayed: revoke ? 0 : 1,
        abandoned: revoke ? 1 : 0,
        failed: 0,
        deferred: 0,
      });
      expect(await vault.read("alpha.md")).toBe(
        revoke ? before : renderApprovedRelation(before, "supports", "beta.md"),
      );
      expect((await readEdgeDecisionState(connection, "supports", edgeId))[0].approved).toBe(
        !revoke,
      );
      expect(await countApprovalArtifacts(connection, "history")).toBe(revoke ? 0 : 1);
      if (!revoke) {
        const [rows] = await connection.db
          .query<[Array<{ tool_approval: string }>]>("SELECT tool_approval FROM history;")
          .collect();
        expect(JSON.parse(rows[0].tool_approval).permission.operator.id).toBe(operator.id);
      }
    });
  }
});
