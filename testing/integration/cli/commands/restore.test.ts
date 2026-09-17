/**
 * Phase 5 Task 10 restore CLI smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/cli/commands/restore.test.ts`.
 *
 * Three test cases:
 *   - Empty target imports an active intent, then invokes post-import link sync.
 *   - Non-empty entity state refuses with exit 2 and a nuke-instruction message.
 *   - A lone approval intent independently blocks restore preflight.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { runBackupCommand } from "../../../../src/cli/commands/backup";
import { runRestoreCommand } from "../../../../src/cli/commands/restore";
import { makeEmitter } from "../../../../src/cli/output";
import { createRun, updateStatus } from "../../../../src/core/awaken/awakenRun";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { RESTORE_IMPORT_ORPHAN_REASON } from "../../../../src/core/services/reconcileRunOrphans";
import { sha256Hex } from "../../../../src/core/utils/sha256";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../../../src/core/vault/identity";
import { clearRestoreQuarantine } from "../../../../src/core/vault/restoreQuarantine";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { acquireNoopMaintenanceLease } from "../../../helpers/maintenanceLease";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const FIXTURE_SOURCE_BODY = "# Fixture";
const FIXTURE_TARGET_BODY = "# Fixture target\n";
const FIXTURE_AFTER_BODY = "# Fixture\n\n## Related\n\n- [[fixture-target]]\n";

interface ApprovalIntentSeed {
  edgeId: RecordId<"supports">;
  edgeCreatedAt: unknown;
  sourceNote: RecordId<"note">;
  targetNote: RecordId<"note">;
  sourcePath: string;
  targetPath: string;
  beforeSha: string;
  afterSha: string;
}

async function createApprovalIntentRow(
  connection: SurrealConnection,
  seed: ApprovalIntentSeed,
): Promise<RecordId<"approval_intent">> {
  const intentId = createUuidRecordId("approval_intent");
  await connection.db
    .query(
      `CREATE ONLY $intentId CONTENT {
  edge: $edgeId,
  table_name: 'supports',
  edge_created_at: $edgeCreatedAt,
  source_note: $sourceNote,
  target_note: $targetNote,
  source_path: $sourcePath,
  target_path: $targetPath,
  kind: 'note.append_section',
  before_body: $beforeBody,
  after_body: $afterBody,
  before_sha: $beforeSha,
  after_sha: $afterSha,
  history_id: $historyId,
  approved_by: 'human',
  producer: 'linker'
};`,
      {
        intentId,
        edgeId: seed.edgeId,
        edgeCreatedAt: seed.edgeCreatedAt,
        sourceNote: seed.sourceNote,
        targetNote: seed.targetNote,
        sourcePath: seed.sourcePath,
        targetPath: seed.targetPath,
        beforeBody: FIXTURE_SOURCE_BODY,
        afterBody: FIXTURE_AFTER_BODY,
        beforeSha: seed.beforeSha,
        afterSha: seed.afterSha,
        historyId: createUuidRecordId("history"),
      },
    )
    .collect();
  return intentId;
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] restore CLI", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  let dumpFile: string;
  let pausedDumpFile: string;
  let approvalIntentSeed: ApprovalIntentSeed;
  let awakenRunId: RecordId<"awaken_run">;
  let agentRunId: RecordId<"agent_run">;
  const secret = "phase5-task10-restore-secret";
  const grantMarker = "restore-must-not-revive-this-grant";
  const unresolvedMarker = "restore-must-not-carry-unresolved-staging";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-restore-cli-"));
    const homeOverride = path.join(tempDir, "home");
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

    const stateDir = vaultStateDir(vaultPath);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const port = new URL(handle.url).port;
    await writeFile(vaultPortPath(vaultPath), `${port}\n`, "utf8");
    await writeFile(vaultSecretPath(vaultPath), secret, { mode: 0o600 });
    await writeFixtureMarkdown();

    // Produce a fixture dump from a temporarily-seeded vault, then drop
    // the rows so each test starts with a known state.
    const beforeSha = await sha256Hex(FIXTURE_SOURCE_BODY);
    const afterSha = await sha256Hex(FIXTURE_AFTER_BODY);
    const fixtureSource = await upsertNoteByPath(connection.db, {
      path: "fixture.md",
      sha: beforeSha,
      wordCount: 7,
    });
    const fixtureTarget = await upsertNoteByPath(connection.db, {
      path: "fixture-target.md",
      sha: await sha256Hex(FIXTURE_TARGET_BODY),
      wordCount: 3,
    });
    await connection.db
      .query(
        "UPDATE note SET tier1_at = time::now(), tier2_at = time::now(), tier3_at = time::now(), linker_refresh_pending = false;",
      )
      .collect();
    const [edges] = await connection.db
      .query<[Array<{ id: RecordId<"supports">; created_at: unknown }>]>(
        "RELATE $source->supports->$target SET source = 'linker', class = 'INFERRED', confidence = 0.8, agent = 'linker', approved = true, applied = false, approved_by = 'human' RETURN id, created_at;",
        { source: fixtureSource, target: fixtureTarget },
      )
      .collect<[Array<{ id: RecordId<"supports">; created_at: unknown }>]>();
    const fixtureEdge = edges[0];
    if (fixtureEdge === undefined) throw new Error("failed to seed restore approval intent edge");
    approvalIntentSeed = {
      edgeId: fixtureEdge.id,
      edgeCreatedAt: fixtureEdge.created_at,
      sourceNote: fixtureSource,
      targetNote: fixtureTarget,
      sourcePath: "fixture.md",
      targetPath: "fixture-target.md",
      beforeSha,
      afterSha,
    };
    await createApprovalIntentRow(connection, approvalIntentSeed);
    awakenRunId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: ["fixture.md", "fixture-target.md"],
    });
    agentRunId = createUuidRecordId("agent_run");
    await connection.db
      .query(
        `CREATE ONLY $agentRunId CONTENT {
  agent: 'linker',
  trigger: 'vault-save',
  note_path: 'fixture.md',
  started_at: 1000
};
CREATE ONLY $sessionId CONTENT {
  client: $grantMarker,
  granted_at: 1,
  expires_at: 9999999999999,
  allowed_folders: ['Private'],
  allowed_tools: ['notes.append'],
  max_writes: 1
};
CREATE wikilink_unresolved CONTENT {
  in: $fixtureSource,
  raw_target: $unresolvedMarker,
  source: 'wikilink'
};`,
        {
          agentRunId,
          sessionId: createUuidRecordId("agent_session"),
          grantMarker,
          fixtureSource,
          unresolvedMarker,
        },
      )
      .collect();
    dumpFile = path.join(tempDir, "fixture.surql");
    const fixtureExit = await runBackupCommand(
      {
        vaultPath,
        outPath: dumpFile,
        emitter: makeEmitter({ mode: "json", write: () => {} }),
      },
      { acquireMaintenance: acquireNoopMaintenanceLease },
    );
    expect(fixtureExit).toBe(0);
    const dumpText = await Bun.file(dumpFile).text();
    expect(dumpText).not.toContain(secret);
    expect(dumpText).not.toMatch(/\bDEFINE\b/i);
    expect(dumpText).not.toContain(grantMarker);
    expect(dumpText).not.toContain(unresolvedMarker);

    await updateStatus(connection.db, awakenRunId, "paused", { cursor: "fixture.md" });
    pausedDumpFile = path.join(tempDir, "fixture-paused.surql");
    const pausedFixtureExit = await runBackupCommand(
      {
        vaultPath,
        outPath: pausedDumpFile,
        emitter: makeEmitter({ mode: "json", write: () => {} }),
      },
      { acquireMaintenance: acquireNoopMaintenanceLease },
    );
    expect(pausedFixtureExit).toBe(0);
    await clearRestoredRows();
  }, 30_000);

  afterAll(async () => {
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
    await clearRestoredRows();
    await clearRestoreQuarantine(vaultPath);
    await writeFixtureMarkdown();
  }, 30_000);

  test("[smoke] records round-trip and active runs reconcile before links sync", async () => {
    const before = await countNotes();
    expect(before).toBe(0);

    const events: Array<Record<string, unknown>> = [];
    const observedIntentCounts: number[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    const exitCode = await runRestoreCommand(
      {
        vaultPath,
        inputPath: dumpFile,
        emitter,
        clientIdentity: "restore-test",
      },
      {
        acquireMaintenance: acquireNoopMaintenanceLease,
        syncLinks: async (options) => {
          expect(options.vaultPath).toBe(vaultPath);
          expect(options.clientIdentity).toBe("restore-test");
          observedIntentCounts.push(await countApprovalIntents());
          const awaken = await readAwakenRun();
          expect(awaken.status).toBe("failed");
          expect(awaken.failure_reason).toBe(RESTORE_IMPORT_ORPHAN_REASON);
          expect(awaken.finished_at).toBeDefined();
          const agent = await readAgentRun();
          expect(agent.ok).toBe(false);
          expect(agent.error).toBe(RESTORE_IMPORT_ORPHAN_REASON);
          expect(typeof agent.finished_at).toBe("number");
          expect(await countTable("agent_session")).toBe(0);
          expect(await countTable("wikilink_unresolved")).toBe(0);
          options.emitter.emit({ type: "links:sync", replayed: 1, abandoned: 0, failed: 0 });
          return 0;
        },
      },
    );
    if (exitCode !== 0) {
      throw new Error(`restore failed: ${JSON.stringify(events)}`);
    }
    expect(exitCode).toBe(0);

    const after = await countNotes();
    expect(after).toBe(2);
    expect(await countTable("supports")).toBe(1);
    expect(observedIntentCounts).toEqual([1]);
    expect(events.map((event) => event.type)).toEqual(["links:sync", "restore-success"]);
  });

  test("[smoke] restore preserves a paused awaken checkpoint while closing an agent orphan", async () => {
    let syncCalls = 0;
    const exitCode = await runRestoreCommand(
      {
        vaultPath,
        inputPath: pausedDumpFile,
        emitter: makeEmitter({ mode: "json", write: () => {} }),
      },
      {
        acquireMaintenance: acquireNoopMaintenanceLease,
        syncLinks: async () => {
          syncCalls += 1;
          const awaken = await readAwakenRun();
          expect(awaken.status).toBe("paused");
          expect(awaken.cursor).toBe("fixture.md");
          expect(awaken.failure_reason).toBeUndefined();
          expect(awaken.finished_at).toBeUndefined();
          const agent = await readAgentRun();
          expect(agent.ok).toBe(false);
          expect(agent.error).toBe(RESTORE_IMPORT_ORPHAN_REASON);
          return 0;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(syncCalls).toBe(1);
  });

  test("[smoke] an unexpected post-import continuation failure rolls back conservatively", async () => {
    const events: Array<Record<string, unknown>> = [];
    let releaseOptions: { rebuildAllMarkdown?: boolean } | undefined;
    const exitCode = await runRestoreCommand(
      {
        vaultPath,
        inputPath: dumpFile,
        emitter: makeEmitter({
          mode: "json",
          write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
        }),
      },
      {
        acquireMaintenance: async () => {
          const lease = await acquireNoopMaintenanceLease();
          return {
            ...lease,
            release: async (options?: { rebuildAllMarkdown?: boolean }) => {
              releaseOptions = options;
              return { vaultChanged: false };
            },
          };
        },
        syncLinks: async () => {
          throw new Error("held continuation failed");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(events[0]?.code).toBe("RESTORE_FAILED");
    expect(String(events[0]?.message)).toContain("restore engine failed unexpectedly");
    expect(releaseOptions).toEqual({ rebuildAllMarkdown: true });
    expect(await countNotes()).toBe(0);
    expect(await countTable("supports")).toBe(0);
    expect(await countTable("approval_intent")).toBe(0);
  });

  test("[smoke] restore fails after reconciling Markdown drift observed at lease release", async () => {
    const events: Array<Record<string, unknown>> = [];
    const exitCode = await runRestoreCommand(
      {
        vaultPath,
        inputPath: dumpFile,
        emitter: makeEmitter({
          mode: "json",
          write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
        }),
      },
      {
        acquireMaintenance: async () => {
          const lease = await acquireNoopMaintenanceLease();
          return { ...lease, release: async () => ({ vaultChanged: true }) };
        },
        syncLinks: async () => 0,
      },
    );

    expect(exitCode).toBe(1);
    expect(events.at(-1)?.code).toBe("RESTORE_FAILED");
    expect(String(events.at(-1)?.message)).toContain("Markdown changed");
    expect(String(events.at(-1)?.message)).toContain("notient nuke --yes");
  });

  test("[smoke] restore fails closed when Markdown changed after the backup", async () => {
    await writeFile(path.join(vaultPath, "fixture.md"), "# Human edit\n", "utf8");
    const events: Array<Record<string, unknown>> = [];
    let syncCalls = 0;
    let releaseOptions: { rebuildAllMarkdown?: boolean } | undefined;
    const exitCode = await runRestoreCommand(
      {
        vaultPath,
        inputPath: dumpFile,
        emitter: makeEmitter({
          mode: "json",
          write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
        }),
      },
      {
        acquireMaintenance: async () => {
          const lease = await acquireNoopMaintenanceLease();
          return {
            ...lease,
            release: async (options?: { rebuildAllMarkdown?: boolean }) => {
              releaseOptions = options;
              return { vaultChanged: false };
            },
          };
        },
        syncLinks: async () => {
          syncCalls += 1;
          return 0;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(syncCalls).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe("RESTORE_FAILED");
    expect(String(events[0]?.message)).toContain("restore snapshot mismatch");
    expect(String(events[0]?.message)).toContain("fixture.md");
    expect(String(events[0]?.message)).not.toContain("Human edit");
    expect(releaseOptions).toEqual({ rebuildAllMarkdown: true });
    expect(await countNotes()).toBe(0);
    expect(await countTable("supports")).toBe(0);
    expect(await countTable("approval_intent")).toBe(0);
  });

  test("[smoke] restore fails closed when backup Markdown was deleted", async () => {
    await rm(path.join(vaultPath, "fixture-target.md"));
    const events: Array<Record<string, unknown>> = [];
    let syncCalls = 0;
    const exitCode = await runRestoreCommand(
      {
        vaultPath,
        inputPath: dumpFile,
        emitter: makeEmitter({
          mode: "json",
          write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
        }),
      },
      {
        acquireMaintenance: acquireNoopMaintenanceLease,
        syncLinks: async () => {
          syncCalls += 1;
          return 0;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(syncCalls).toBe(0);
    expect(String(events[0]?.message)).toContain("backup-only 'fixture-target.md'");
  });

  test("[smoke] restore rejects vectors from a different embedding model before import", async () => {
    await connection.db
      .query(
        "UPDATE meta:embedding SET value = { model: 'different-local-model', dimension: 768 };",
      )
      .collect();
    const events: Array<Record<string, unknown>> = [];
    let syncCalls = 0;
    try {
      const exitCode = await runRestoreCommand(
        {
          vaultPath,
          inputPath: dumpFile,
          emitter: makeEmitter({
            mode: "json",
            write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
          }),
        },
        {
          acquireMaintenance: acquireNoopMaintenanceLease,
          syncLinks: async () => {
            syncCalls += 1;
            return 0;
          },
        },
      );

      expect(exitCode).toBe(1);
      expect(syncCalls).toBe(0);
      expect(await countNotes()).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]?.code).toBe("RESTORE_FAILED");
      expect(String(events[0]?.message)).toContain("restore embedding mismatch");
      expect(String(events[0]?.message)).toContain("different-local-model");
    } finally {
      await connection.db
        .query("UPDATE meta:embedding SET value = { model: 'fixture-embedding', dimension: 768 };")
        .collect();
    }
  });

  test("[smoke] restore refuses with exit 2 when any tracked table is non-empty", async () => {
    await upsertNoteByPath(connection.db, {
      path: "occupied.md",
      sha: "sha-occupied",
      wordCount: 3,
    });

    const events: Array<Record<string, unknown>> = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    const exitCode = await runRestoreCommand(
      {
        vaultPath,
        inputPath: dumpFile,
        emitter,
      },
      {
        acquireMaintenance: acquireNoopMaintenanceLease,
        syncLinks: async () => {
          throw new Error("links sync must not run when restore preflight refuses live data");
        },
      },
    );
    expect(exitCode).toBe(2);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.code).toBe("DB_NOT_EMPTY");
    expect(String(errorEvent?.message)).toContain("notient nuke");
  });

  test("[smoke] restore preflight treats approval_intent as live operational state", async () => {
    await createApprovalIntentRow(connection, approvalIntentSeed);

    const events: Array<Record<string, unknown>> = [];
    const exitCode = await runRestoreCommand(
      {
        vaultPath,
        inputPath: dumpFile,
        emitter: makeEmitter({
          mode: "json",
          write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
        }),
      },
      {
        acquireMaintenance: acquireNoopMaintenanceLease,
        syncLinks: async () => {
          throw new Error("links sync must not run when an approval intent blocks restore");
        },
      },
    );

    expect(exitCode).toBe(2);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent?.code).toBe("DB_NOT_EMPTY");
    expect(String(errorEvent?.message)).toContain("table 'approval_intent'");
    expect(await countApprovalIntents()).toBe(1);
  });

  test("[smoke] restore preflight refuses unresolved staging left by a failed import", async () => {
    await connection.db
      .query(
        "CREATE wikilink_unresolved CONTENT { in: $missingNote, raw_target: 'stale', source: 'wikilink' };",
        { missingNote: createUuidRecordId("note") },
      )
      .collect();

    const events: Array<Record<string, unknown>> = [];
    const exitCode = await runRestoreCommand(
      {
        vaultPath,
        inputPath: dumpFile,
        emitter: makeEmitter({
          mode: "json",
          write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
        }),
      },
      {
        acquireMaintenance: acquireNoopMaintenanceLease,
        syncLinks: async () => {
          throw new Error("links sync must not run when staging blocks restore");
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(events[0]?.code).toBe("DB_NOT_EMPTY");
    expect(String(events[0]?.message)).toContain("table 'wikilink_unresolved'");
  });

  async function countNotes(): Promise<number> {
    const [rows] = await connection.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM note GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    return rows[0]?.count ?? 0;
  }

  async function countApprovalIntents(): Promise<number> {
    return await countTable("approval_intent");
  }

  async function countTable(table: string): Promise<number> {
    const [rows] = await connection.db
      .query<[Array<{ count: number }>]>(`SELECT count() AS count FROM ${table} GROUP ALL;`)
      .collect<[Array<{ count: number }>]>();
    return rows[0]?.count ?? 0;
  }

  async function readAwakenRun(): Promise<{
    status: string;
    cursor?: string;
    failure_reason?: string;
    finished_at?: unknown;
  }> {
    const [rows] = await connection.db
      .query<
        [
          Array<{
            status: string;
            cursor?: string;
            failure_reason?: string;
            finished_at?: unknown;
          }>,
        ]
      >(
        "SELECT status, cursor, failure_reason, finished_at FROM awaken_run WHERE id = $id LIMIT 1;",
        { id: awakenRunId },
      )
      .collect<
        [
          Array<{
            status: string;
            cursor?: string;
            failure_reason?: string;
            finished_at?: unknown;
          }>,
        ]
      >();
    const row = rows[0];
    if (row === undefined) throw new Error("restored awaken run is missing");
    return row;
  }

  async function readAgentRun(): Promise<{
    ok?: boolean;
    error?: string;
    finished_at?: number;
  }> {
    const [rows] = await connection.db
      .query<[Array<{ ok?: boolean; error?: string; finished_at?: number }>]>(
        "SELECT ok, error, finished_at FROM agent_run WHERE id = $id LIMIT 1;",
        { id: agentRunId },
      )
      .collect<[Array<{ ok?: boolean; error?: string; finished_at?: number }>]>();
    const row = rows[0];
    if (row === undefined) throw new Error("restored agent run is missing");
    return row;
  }

  async function writeFixtureMarkdown(): Promise<void> {
    await writeFile(path.join(vaultPath, "fixture.md"), FIXTURE_SOURCE_BODY, "utf8");
    await writeFile(path.join(vaultPath, "fixture-target.md"), FIXTURE_TARGET_BODY, "utf8");
  }

  async function clearRestoredRows(): Promise<void> {
    for (const table of [
      "approval_intent",
      "supports",
      "wikilink_unresolved",
      "embed_unresolved",
      "agent_session",
      "agent_run",
      "awaken_run",
      "note",
    ]) {
      await connection.db.query(`DELETE ${table};`).collect();
    }
  }
});
