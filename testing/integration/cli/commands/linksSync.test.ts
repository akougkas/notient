/**
 * Links sync CLI/daemon integration harness.
 *
 * Skipped by default. Run with
 * `NOTIENT_SMOKE=1 bun test testing/integration/cli/commands/linksSync.test.ts`.
 *
 * Crashes after a durable state-2 intent (`approved = true AND applied = false`), invokes
 * `runLinksSyncCommand`, and asserts the daemon's canonical approval service
 * advances the row to state 3.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { FsVault } from "../../../../src/adapters/fsVault";
import { runLinksSyncCommand } from "../../../../src/cli/commands/linksSync";
import type { StructuredEvent } from "../../../../src/cli/output";
import { makeEmitter } from "../../../../src/cli/output";
import { ApprovalService } from "../../../../src/core/approvals/approvalService";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { sha256Hex } from "../../../../src/core/utils/sha256";
import { makeLinksSyncHandler } from "../../../../src/daemon/handlers/links";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { type TestRpcDaemon, startTestRpcDaemon } from "../rpcTestDaemon";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] links sync CLI", () => {
  let tempDir: string;
  let homeOverride: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  let daemon: TestRpcDaemon;
  const secret = "phase5-task9-linkssync-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-linkssync-cli-"));
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

    const approvalService = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: new FsVault(vaultPath),
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    daemon = await startTestRpcDaemon(vaultPath, [
      {
        method: "links.sync",
        handler: makeLinksSyncHandler({ approvalService }),
        kind: "admin",
      },
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
    const tables = ["supports", "approval_intent", "history", "daemon_write", "note"];
    for (const table of tables) {
      await connection.db.query(`DELETE ${table};`).collect();
    }
  });

  test("[smoke] sync replays a pending writeback and returns replayed=1", async () => {
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
    // Stage a real pending proposal, then fail the first filesystem attempt.
    // The atomic claim leaves both state 2 and its exact durable byte intent.
    const [createdRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>(
        "RELATE $from->supports->$to SET source = 'linker', class = 'INFERRED', confidence = 0.8, agent = 'linker', approved = false RETURN id;",
        { from: alpha, to: beta },
      )
      .collect<[Array<{ id: RecordId }>]>();
    const created = createdRows[0];
    expect(created).toBeDefined();
    if (created === undefined) throw new Error("missing supports proposal seed");
    const durableVault = new FsVault(vaultPath);
    const crashingApproval = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: {
        read: (notePath) => durableVault.read(notePath),
        writeIfUnchanged: async () => {
          throw new Error("synthetic crash before vault rename");
        },
      },
      hash: sha256Hex,
      pruneHistory: async () => {},
    });
    await expect(
      crashingApproval.approveEdge({
        id: created.id,
        table: "supports",
        approvedBy: "human",
      }),
    ).rejects.toThrow("synthetic crash");

    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const exitCode = await runLinksSyncCommand({
      vaultPath,
      emitter,
    });
    expect(exitCode).toBe(0);
    const summary = events.find((event) => event.type === "links:sync");
    expect(summary?.replayed).toBe(1);
    expect(summary?.failed).toBe(0);

    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean; approved_by: string }>]>(
        "SELECT approved, applied, approved_by FROM supports WHERE id = $id;",
        { id: created.id },
      )
      .collect<[Array<{ approved: boolean; applied: boolean; approved_by: string }>]>();
    expect(edgeRows[0]?.approved).toBe(true);
    expect(edgeRows[0]?.applied).toBe(true);
    expect(edgeRows[0]?.approved_by).toBe("human");
  });

  test("[smoke] sync with no pending rows returns replayed=0", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const exitCode = await runLinksSyncCommand({
      vaultPath,
      emitter,
    });
    expect(exitCode).toBe(0);
    const summary = events.find((event) => event.type === "links:sync");
    expect(summary?.replayed).toBe(0);
    expect(summary?.failed).toBe(0);
  });
});
