/**
 * Proposal CLI/daemon integration harness.
 *
 * The end-to-end smoke is skipped by default. Run with
 * `NOTIENT_SMOKE=1 bun test testing/integration/cli/commands/proposalsCli.test.ts` to drive
 * a real SurrealDB through the daemon's canonical proposal handlers.
 *
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { FsVault } from "../../../../src/adapters/fsVault";
import {
  runProposalsApproveCommand,
  runProposalsListCommand,
  runProposalsRejectCommand,
} from "../../../../src/cli/commands/proposalsCli";
import type { StructuredEvent } from "../../../../src/cli/output";
import { makeEmitter } from "../../../../src/cli/output";
import { ApprovalService } from "../../../../src/core/approvals/approvalService";
import { unwrapNativeValue } from "../../../../src/core/db/nativeValue";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { purgeNoteGraph, tombstoneNoteById } from "../../../../src/core/indexer/purgeNote";
import { sha256Hex } from "../../../../src/core/utils/sha256";
import { makeProposalsHandlers } from "../../../../src/daemon/handlers/proposals";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { agentPrincipal, humanPrincipal, rpcRequest } from "../../../rpcRequest";
import { type TestRpcDaemon, startTestRpcDaemon } from "../rpcTestDaemon";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] proposals CLI", () => {
  let tempDir: string;
  let homeOverride: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  let daemon: TestRpcDaemon;
  let approvalService: ApprovalService;
  let proposalHandlers: ReturnType<typeof makeProposalsHandlers>;
  const secret = "m1-proposals-cli-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-proposals-cli-"));
    homeOverride = path.join(tempDir, "home");
    await mkdir(homeOverride, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = homeOverride;

    vaultPath = path.join(tempDir, "vault");
    await mkdir(vaultPath, { recursive: true });

    handle = await startSurreal({
      dataDir: path.join(tempDir, "surreal-data"),
      secret,
      portFile: path.join(tempDir, "surreal.port"),
      pidFile: path.join(tempDir, "surreal.pid"),
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

    const vault = new FsVault(vaultPath);
    approvalService = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault,
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    const handlers = makeProposalsHandlers({
      db: connection.db,
      approvalService,
      vault,
    });
    proposalHandlers = handlers;
    daemon = await startTestRpcDaemon(vaultPath, [
      { method: "links.proposals", handler: handlers.list, kind: "read" },
      { method: "proposals.propose_link", handler: handlers.proposeLink, kind: "write" },
      { method: "links.approve", handler: handlers.approve, kind: "admin" },
      { method: "links.reject", handler: handlers.reject, kind: "admin" },
    ]);
  }, 30_000);

  afterAll(async () => {
    if (daemon !== undefined) await daemon.close().catch(() => {});
    if (connection !== undefined) await connection.close().catch(() => {});
    if (handle !== undefined) await handle.stop().catch(() => {});
    if (originalHome === undefined) {
      process.env.HOME = undefined;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  afterEach(async () => {
    const tables = [
      "supports",
      "contradicts",
      "extends",
      "exemplifies",
      "synthesizes",
      "related_to",
      "approval_intent",
      "history",
      "daemon_write",
      "chunk",
      "note",
    ];
    for (const table of tables) {
      await connection.db.query(`DELETE ${table};`).collect();
    }
  });

  test("[smoke] propose_link transaction converges under concurrent same-agent calls", async () => {
    await writeFile(path.join(vaultPath, "alpha.md"), "# Alpha\n");
    await writeFile(path.join(vaultPath, "beta.md"), "# Beta\n");
    const alpha = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    const beta = await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: "sha-beta",
      wordCount: 3,
    });
    const request = (agent: string) =>
      rpcRequest(
        { sourcePath: "alpha.md", targetPath: "beta.md", relation: "related_to" },
        { principal: agentPrincipal(agent) },
      );

    const [first, concurrent] = await Promise.all([
      proposalHandlers.proposeLink(request("claude-code")),
      proposalHandlers.proposeLink(request("claude-code")),
    ]);
    const replay = await proposalHandlers.proposeLink(request("claude-code"));
    expect(first).toEqual(concurrent);
    expect(first).toEqual(replay);
    expect(first.pending).toBe(true);
    const proposalId = first.proposalId;
    if (typeof proposalId !== "string") throw new Error("propose_link omitted proposalId");

    const [rows] = await connection.db
      .query<
        [
          Array<{
            id: RecordId<"related_to">;
            in: RecordId<"note">;
            out: RecordId<"note">;
            source: string;
            class: string;
            agent: string;
            confidence: number;
            evidence?: unknown;
            approved: boolean;
            applied: boolean;
          }>,
        ]
      >(
        "SELECT id, in, out, source, class, agent, confidence, evidence, approved, applied FROM related_to;",
      )
      .collect<
        [
          Array<{
            id: RecordId<"related_to">;
            in: RecordId<"note">;
            out: RecordId<"note">;
            source: string;
            class: string;
            agent: string;
            confidence: number;
            evidence?: unknown;
            approved: boolean;
            applied: boolean;
          }>,
        ]
      >();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "user",
      class: "INFERRED",
      agent: "claude-code",
      confidence: 1,
      approved: false,
      applied: true,
    });
    expect(rows[0]?.id.toString()).toBe(proposalId);
    expect(rows[0]?.in.toString()).toBe(alpha.toString());
    expect(rows[0]?.out.toString()).toBe(beta.toString());
    expect(rows[0]?.evidence).toBeUndefined();

    await expect(proposalHandlers.proposeLink(request("codex"))).rejects.toThrow(
      "already exists for alpha.md -> beta.md",
    );
  });

  test("[smoke] every producer converges on one typed endpoint identity", async () => {
    await writeFile(path.join(vaultPath, "alpha.md"), "# Alpha\n");
    await writeFile(path.join(vaultPath, "beta.md"), "# Beta\n");
    const alpha = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    const beta = await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: "sha-beta",
      wordCount: 3,
    });
    const request = (relation: "related_to" | "supports") =>
      rpcRequest(
        { sourcePath: "alpha.md", targetPath: "beta.md", relation },
        { principal: agentPrincipal("claude-code") },
      );

    await proposalHandlers.proposeLink(request("related_to"));
    expect(
      await relateEdge(connection.db, {
        table: "related_to",
        from: alpha,
        to: beta,
        source: "linker",
        confidenceClass: "INFERRED",
        confidence: 0.82,
        agent: "linker",
        approved: false,
      }),
    ).toBe(false);
    const [userFirstRows] = await connection.db
      .query<[Array<{ source: string; agent: string }>]>("SELECT source, agent FROM related_to;")
      .collect<[Array<{ source: string; agent: string }>]>();
    expect(userFirstRows).toEqual([{ source: "user", agent: "claude-code" }]);

    expect(
      await relateEdge(connection.db, {
        table: "supports",
        from: alpha,
        to: beta,
        source: "linker",
        confidenceClass: "INFERRED",
        confidence: 0.82,
        agent: "linker",
        approved: false,
      }),
    ).toBe(true);
    await expect(proposalHandlers.proposeLink(request("supports"))).rejects.toThrow(
      "already exists for alpha.md -> beta.md",
    );
    const [agentFirstRows] = await connection.db
      .query<[Array<{ source: string; agent: string }>]>("SELECT source, agent FROM supports;")
      .collect<[Array<{ source: string; agent: string }>]>();
    expect(agentFirstRows).toEqual([{ source: "linker", agent: "linker" }]);
  });

  test("[smoke] a stale producer cannot recreate an edge after endpoint purge", async () => {
    await writeFile(path.join(vaultPath, "alpha.md"), "# Alpha\n");
    await writeFile(path.join(vaultPath, "beta.md"), "# Beta\n");
    const alpha = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    const beta = await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: "sha-beta",
      wordCount: 3,
    });

    const deletionToken = await tombstoneNoteById(connection, alpha);
    if (deletionToken === null) throw new Error("failed to tombstone stale producer endpoint");
    const results = await Promise.allSettled([
      purgeNoteGraph(connection, alpha, deletionToken, approvalService),
      relateEdge(connection.db, {
        table: "related_to",
        from: alpha,
        to: beta,
        source: "linker",
        confidenceClass: "INFERRED",
        confidence: 0.82,
        agent: "linker",
        approved: false,
      }),
    ]);
    expect(results[0]?.status).toBe("fulfilled");

    const [notes] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM note WHERE id = $id;", { id: alpha })
      .collect<[Array<{ id: RecordId }>]>();
    const [edges] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM related_to;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(notes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  test("[smoke] rejection receipt replays and permanently closes the same proposal identity", async () => {
    await writeFile(path.join(vaultPath, "alpha.md"), "# Alpha\n");
    await writeFile(path.join(vaultPath, "beta.md"), "# Beta\n");
    await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: "sha-beta",
      wordCount: 3,
    });
    const proposalRequest = rpcRequest(
      { sourcePath: "alpha.md", targetPath: "beta.md", relation: "related_to" },
      { principal: agentPrincipal("claude-code") },
    );
    const proposed = await proposalHandlers.proposeLink(proposalRequest);
    const decisionRequest = rpcRequest(
      { id: proposed.proposalId, reason: "not relevant" },
      { principal: humanPrincipal() },
    );

    const first = await proposalHandlers.reject(decisionRequest);
    const replay = await proposalHandlers.reject(decisionRequest);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ found: true, reason: "not relevant" });
    await expect(proposalHandlers.proposeLink(proposalRequest)).rejects.toThrow(
      "already rejected for these relation endpoints",
    );

    const [edges] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM related_to;")
      .collect<[Array<{ id: RecordId }>]>();
    const [audits] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM history WHERE kind = 'proposal.reject';")
      .collect<[Array<{ id: RecordId }>]>();
    expect(edges).toHaveLength(0);
    expect(audits).toHaveLength(1);
  });

  test("[smoke] simultaneous approve and reject report exactly one winning decision", async () => {
    await writeFile(path.join(vaultPath, "alpha.md"), "# Alpha\n\nbody.\n");
    await writeFile(path.join(vaultPath, "beta.md"), "# Beta\n");
    await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: "sha-beta",
      wordCount: 3,
    });
    const proposed = await proposalHandlers.proposeLink(
      rpcRequest(
        { sourcePath: "alpha.md", targetPath: "beta.md", relation: "related_to" },
        { principal: agentPrincipal("claude-code") },
      ),
    );
    const [approved, rejected] = await Promise.all([
      proposalHandlers.approve(
        rpcRequest({ id: proposed.proposalId }, { principal: humanPrincipal("admin-approve") }),
      ),
      proposalHandlers.reject(
        rpcRequest(
          { id: proposed.proposalId, reason: "race" },
          { principal: humanPrincipal("admin-reject") },
        ),
      ),
    ]);
    expect(Number(approved.found) + Number(rejected.found)).toBe(1);

    const [edges] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM related_to;",
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    const [history] = await connection.db
      .query<[Array<{ kind: string; client_identity: string }>]>(
        "SELECT kind, client_identity FROM history;",
      )
      .collect<[Array<{ kind: string; client_identity: string }>]>();
    expect(history).toHaveLength(1);
    if (approved.found) {
      expect(edges).toEqual([{ approved: true, applied: true }]);
      expect(history[0]).toEqual({ kind: "note.append_section", client_identity: "admin-approve" });
    } else {
      expect(edges).toHaveLength(0);
      expect(history[0]).toEqual({ kind: "proposal.reject", client_identity: "admin-reject" });
    }
  });

  test("[smoke] list returns pending edges with source and target paths", async () => {
    await writeFile(path.join(vaultPath, "alpha.md"), "# Alpha\n\nbody.\n");
    await writeFile(path.join(vaultPath, "beta.md"), "# Beta\n");
    const alpha = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    const beta = await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: "sha-beta",
      wordCount: 3,
    });
    const [evidence] = await connection.db
      .query<[{ id: RecordId<"chunk"> } | null]>(
        "CREATE ONLY chunk CONTENT { note: $note, ord: 0, text: 'Evidence from alpha.', token_estimate: 4 } RETURN id;",
        { note: alpha },
      )
      .collect<[{ id: RecordId<"chunk"> } | null]>();
    if (evidence === null) throw new Error("seed evidence chunk missing");
    await connection.db
      .query(
        "RELATE $from->supports->$to SET source = 'linker', class = 'INFERRED', confidence = 0.85, evidence = [$evidence], agent = 'linker', approved = false;",
        { from: alpha, to: beta, evidence: evidence.id },
      )
      .collect();

    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsListCommand({
      vaultPath,
      emitter,
      asJson: false,
    });
    expect(code).toBe(0);
    const listed = events.filter((event) => event.type === "proposals:list");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.source).toBe("alpha.md");
    expect(listed[0]?.target).toBe("beta.md");
    expect(listed[0]?.table).toBe("supports");
  });

  test("[smoke] approve writes the wikilink and lands the edge in state 3", async () => {
    const sourcePath = path.join(vaultPath, "alpha.md");
    await writeFile(sourcePath, "# Alpha\n\nbody.\n");
    await writeFile(path.join(vaultPath, "beta.md"), "# Beta\n");
    const alpha = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    const beta = await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: "sha-beta",
      wordCount: 3,
    });
    const [createdRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>(
        "RELATE $from->supports->$to SET source = 'linker', class = 'INFERRED', confidence = 0.85, agent = 'linker', approved = false RETURN id;",
        { from: alpha, to: beta },
      )
      .collect<[Array<{ id: RecordId }>]>();
    const created = createdRows[0];
    if (created === undefined) throw new Error("seed edge missing");

    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsApproveCommand({
      vaultPath,
      emitter,
      id: created.id.toString(),
    });
    expect(code).toBe(0);
    const summary = events.find((event) => event.type === "proposals:approved");
    expect(summary?.id).toBe(created.id.toString());

    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM supports WHERE id = $id;",
        { id: created.id },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(edgeRows[0]?.approved).toBe(true);
    expect(edgeRows[0]?.applied).toBe(true);

    const body = await readFile(sourcePath, "utf8");
    expect(body).toContain("[[beta]]");
  });

  test("[smoke] approve on missing id returns 0 with proposals:not_found", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsApproveCommand({
      vaultPath,
      emitter,
      id: "supports:abcdefghijklmnopqrst",
    });
    expect(code).toBe(0);
    expect(events.some((event) => event.type === "proposals:not_found")).toBe(true);
  });

  test("[smoke] reject deletes the edge and returns its durable audit", async () => {
    const alpha = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    const beta = await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: "sha-beta",
      wordCount: 3,
    });
    const [createdRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>(
        "RELATE $from->supports->$to SET source = 'linker', class = 'INFERRED', confidence = 0.85, agent = 'linker', approved = false RETURN id;",
        { from: alpha, to: beta },
      )
      .collect<[Array<{ id: RecordId }>]>();
    const created = createdRows[0];
    if (created === undefined) throw new Error("seed edge missing");

    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsRejectCommand({
      vaultPath,
      emitter,
      id: created.id.toString(),
      reason: "  noisy  ",
    });
    expect(code).toBe(0);
    const summary = events.find((event) => event.type === "proposals:rejected");
    expect(summary?.id).toBe(created.id.toString());
    expect(summary?.reason).toBe("noisy");
    const historyId = summary?.historyId;
    if (typeof historyId !== "string") throw new Error("CLI rejection omitted its audit id");
    expect(historyId).toMatch(
      /^history:u"[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/,
    );

    const [edgeRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM supports WHERE id = $id;", {
        id: created.id,
      })
      .collect<[Array<{ id: RecordId }>]>();
    expect(edgeRows).toHaveLength(0);

    const [historyRows] = await connection.db
      .query<[Array<{ id: RecordId<"history">; after: unknown; client_identity: string }>]>(
        "SELECT id, after, client_identity FROM history WHERE kind = 'proposal.reject';",
      )
      .collect<[Array<{ id: RecordId<"history">; after: unknown; client_identity: string }>]>();
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]?.id.toString()).toBe(historyId);
    expect(historyRows[0]?.client_identity).toBe("human");
    expect(unwrapNativeValue(historyRows[0]?.after, "proposal CLI smoke history")).toEqual({
      decision: "rejected",
      reason: "noisy",
    });
  });
});
