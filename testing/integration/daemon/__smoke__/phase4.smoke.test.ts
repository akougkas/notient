/**
 * Phase 4 end-to-end smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/daemon/__smoke__/phase4.smoke.test.ts`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, seeds a fresh vault
 * on disk, and exercises the full Phase 4 surface end-to-end:
 *
 *   1. A fresh awaken run reaches `running` and processes notes.
 *   2. A separate caller flips the run to `paused` mid-flight; the worker
 *      observes the live-query notification, exits, and persists
 *      `status='paused'` with `processed > 0`.
 *   3. A second worker invocation with `resume: true` adopts the same run
 *      row, processes the remaining notes, and reaches `completed`.
 *   4. A `related_to` linker proposal is approved via `ApprovalService`.
 *   5. The source note's body on disk now contains the wikilink under the
 *      `## Related` section (the AST writeback contract from Locked
 *      Decision 2).
 *   6. `daemon_write` carries one row whose `sha` matches the post-write
 *      body, `agent='linker'`, and `targets` contains the target note id.
 *   7. Re-running `runTier1` against the same body attributes the new
 *      wikilink edge with `source='linker'` because Tier 1's
 *      `findRecentDaemonWrite` cross-reference matches the row from step 6.
 *
 * Hermetic guarantees:
 *   - `mkdtemp` for both the SurrealDB data dir and the vault root.
 *   - `afterAll` removes the temp tree, kills the surreal subprocess,
 *     and closes the SurrealDB connection.
 *   - Each test owns its fixture vault under a per-test subdirectory so
 *     the steps do not leak state into one another.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import type { VaultAdapter } from "../../../../src/adapters/vaultAdapter";
import { ApprovalService } from "../../../../src/core/approvals/approvalService";
import { findById, findCurrent, updateStatus } from "../../../../src/core/awaken/awakenRun";
import {
  type AwakenWorkerIndexerQueue,
  type AwakenWorkerVaultFacade,
  runAwakenWorker,
} from "../../../../src/core/awaken/awakenWorker";
import { AwakenBackgroundRegistry } from "../../../../src/core/awaken/backgroundRegistry";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  lookupNoteByPath,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import type { IndexerQueue } from "../../../../src/core/indexer/indexerQueue";
import { runTier1 } from "../../../../src/core/indexer/tier1";
import { makeAwakenResumeHandler } from "../../../../src/daemon/handlers/awaken";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const PROPAGATION_DELAY_MS = 250;

function waitForLiveQueryDelivery(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PROPAGATION_DELAY_MS));
}

async function sha256Hex(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const realFs = {
  writeBinary: async (filePath: string, data: ArrayBuffer): Promise<void> => {
    await writeFile(filePath, new Uint8Array(data));
  },
  rename: async (from: string, to: string): Promise<void> => {
    const { rename } = await import("node:fs/promises");
    await rename(from, to);
  },
  remove: async (filePath: string): Promise<void> => {
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath).catch(() => {
      // missing-file is not an error for cleanup
    });
  },
};

interface RecordedEnqueue {
  path: string;
  priority: number;
}

function makeIndexerQueue(records: RecordedEnqueue[]): AwakenWorkerIndexerQueue {
  return {
    enqueue(filePath: string, priority?: number): void {
      records.push({ path: filePath, priority: priority ?? 2 });
    },
  };
}

function makeVaultFacade(paths: string[]): AwakenWorkerVaultFacade {
  return {
    listMarkdownPaths: async () => [...paths],
  };
}

async function clearAwakenRuns(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE awaken_run;").collect();
}

async function clearGraphRows(connection: SurrealConnection): Promise<void> {
  const tables = [
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
    "history",
    "daemon_write",
    "chunk",
    "block",
    "wikilink_unresolved",
    "embed_unresolved",
    "note",
  ];
  for (const table of tables) {
    await connection.db.query(`DELETE ${table};`).collect();
  }
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] Phase 4 vault enrichment", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-phase4-smoke-"));
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
  });

  test("[smoke] awaken pause mid-flight, resume to completion", async () => {
    await clearAwakenRuns(connection);
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];

    // First pass: pause once `b.md` finishes. The pause is signalled from
    // the `onNoteIndexed` callback to mirror the production path where
    // `awaken --pause` runs in a separate process and updates the status
    // row that the worker subscribes to via SurrealDB live query.
    const firstEnqueued: RecordedEnqueue[] = [];
    let pauseSignalled = false;
    let runIdRef: RecordId<"awaken_run"> | null = null;
    const firstResult = await runAwakenWorker({
      db: connection.db,
      vaultFacade: makeVaultFacade(paths),
      indexerQueue: makeIndexerQueue(firstEnqueued),
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      resume: false,
      onNoteIndexed: async (notePath) => {
        if (notePath === "b.md" && !pauseSignalled) {
          pauseSignalled = true;
          const active = await findCurrent(connection.db);
          if (active === null) {
            throw new Error("phase4 smoke: expected an active run while pausing");
          }
          runIdRef = active.id;
          await updateStatus(connection.db, active.id, "paused");
          await waitForLiveQueryDelivery();
        }
      },
    });

    expect(firstResult.status).toBe("paused");
    expect(firstResult.processed).toBeGreaterThan(0);
    expect(firstResult.processed).toBe(2);
    expect(firstResult.failed).toBe(0);
    expect(firstEnqueued.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
    expect(runIdRef).not.toBeNull();
    if (runIdRef === null) return;

    const [pausedRows] = await connection.db
      .query<
        [Array<{ status: string; processed: number; cursor: string | null; finished_at: unknown }>]
      >("SELECT status, processed, cursor, finished_at FROM awaken_run WHERE id = $id;", {
        id: runIdRef,
      })
      .collect<
        [Array<{ status: string; processed: number; cursor: string | null; finished_at: unknown }>]
      >();
    expect(pausedRows[0]?.status).toBe("paused");
    expect(pausedRows[0]?.processed).toBe(2);
    expect(pausedRows[0]?.cursor).toBe("b.md");
    expect(pausedRows[0]?.finished_at == null).toBe(true);

    // Second pass: drive resume through the daemon's `awaken.resume`
    // handler the way the production CLI now does. The handler picks the
    // resumable row, flips it to `running`, and spawns a fresh worker
    // via the same fire-and-forget background path `awaken --background`
    // uses. The CLI used to mutate SurrealDB directly, but the worker's
    // live-query subscription closes when the run pauses, so no worker
    // ever observed the status flip. The RPC handler fixes that gap by
    // owning the worker spawn.
    const secondEnqueued: RecordedEnqueue[] = [];
    const secondBus = new EventBus();
    const secondVault: Pick<VaultAdapter, "listMarkdown" | "read"> = {
      listMarkdown: async () => paths.map((entry, index) => ({ path: entry, mtime: index })),
      read: async (target: string) => `# ${target}\n`,
    };
    const secondIndexerQueue = {
      enqueue(filePath: string, priority?: number): void {
        secondEnqueued.push({ path: filePath, priority: priority ?? 2 });
        // Mirror the unit-test pattern: tee `enqueue` into the worker's
        // per-note completion event so the background worker drains
        // without needing the real indexer.
        queueMicrotask(() => {
          secondBus.emit({ type: "indexer:tier3-done", path: filePath });
        });
      },
    };
    const resumeHandler = makeAwakenResumeHandler({
      bus: secondBus,
      indexer: secondIndexerQueue as unknown as IndexerQueue,
      vault: secondVault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal: connection,
    });
    const resumeResult = await resumeHandler();
    expect(resumeResult.ok).toBe(true);
    expect(resumeResult.status).toBe("running");
    expect(resumeResult.runId).toBe(firstResult.runId.toString());

    // The handler returns synchronously after kicking the worker off.
    // Poll the row until the worker reaches `completed` or fails.
    const completionDeadline = Date.now() + 5_000;
    let finalRow = await findById(connection.db, firstResult.runId);
    while (Date.now() < completionDeadline && finalRow !== null && finalRow.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      finalRow = await findById(connection.db, firstResult.runId);
    }
    if (finalRow === null) {
      throw new Error("phase4 smoke: run row vanished during resume");
    }
    expect(finalRow.status).toBe("completed");
    expect(finalRow.processed).toBe(paths.length);
    expect(finalRow.failed).toBe(0);
    expect(finalRow.cursor).toBeNull();
    expect(finalRow.finished_at).not.toBeNull();
    expect(secondEnqueued.map((entry) => entry.path)).toEqual(["c.md", "d.md", "e.md"]);
  });

  test("[smoke] approve linker proposal writes ## Related, records daemon_write, and re-Tier1 attributes the wikilink to linker", async () => {
    await clearGraphRows(connection);

    // Per-test fixture vault. Hermetic across tests: each phase-4 test
    // owns its own subdirectory under the smoke's tempDir.
    const vaultRoot = path.join(tempDir, "approve-vault");
    await mkdir(vaultRoot, { recursive: true });
    const sourcePath = path.join(vaultRoot, "alpha.md");
    const targetPath = path.join(vaultRoot, "beta.md");
    const sourceBody = "# Alpha\n\nSome body content.\n";
    const targetBody = "# Beta\n\nSibling note content.\n";
    await writeFile(sourcePath, sourceBody);
    await writeFile(targetPath, targetBody);

    // Seed both notes in SurrealDB so the linker proposal can address
    // them by record id. Production seeds via `runTier1`; here we use
    // `upsertNoteByPath` because the focus is the approval/writeback path.
    const sourceNoteId = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: await sha256Hex(sourceBody),
      wordCount: 4,
    });
    const targetNoteId = await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: await sha256Hex(targetBody),
      wordCount: 4,
    });

    // Seed a `related_to` linker proposal. `approveEdge` will route this
    // through `applyApprovedLink` which appends a `[[beta]]` entry under
    // a `## Related` H2.
    const seedSql =
      "RELATE $from->related_to->$to SET source = 'linker', class = 'INFERRED', confidence = 0.82, agent = 'linker', approved = false RETURN id;";
    const [seedRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>(seedSql, { from: sourceNoteId, to: targetNoteId })
      .collect<[Array<{ id: RecordId }>]>();
    const seedEdge = seedRows[0];
    if (seedEdge === undefined) {
      throw new Error("phase4 smoke: seed RELATE produced no edge id");
    }

    // Step 4: approve via the production approval service. The pending-
    // state contract (Locked Decision 3) flips approved -> applied, runs
    // the writeback, records `daemon_write`, atomically writes the file,
    // and commits a `history` row in the closing transaction.
    const bus = new EventBus();
    const decisions: string[] = [];
    bus.on("approval:decided", (event) => {
      decisions.push(`${event.kind}:${event.decision}`);
    });
    // ApprovalService defaults its hash to a SHA-256 over the file body's
    // UTF-8 bytes. Tier 1's `extractor.ts` now hashes the same raw file
    // body, so the `daemon_write.sha` row matches Tier 1's
    // `findRecentDaemonWrite` lookup on re-save without any test-only
    // hash shim.
    const service = new ApprovalService({
      db: connection.db,
      bus,
      vaultRoot,
      fs: realFs,
      readFile: (filePath) => readFile(filePath, "utf8"),
    });
    await service.approveEdge({ id: seedEdge.id, table: "related_to" });

    expect(decisions).toEqual(["edge:accepted"]);

    // Step 5: the on-disk source body now contains the new wikilink under
    // `## Related`. The writeback creates the section if it was missing.
    const afterBody = await readFile(sourcePath, "utf8");
    expect(afterBody).toContain("## Related");
    expect(afterBody).toContain("[[beta]]");
    expect(afterBody).not.toBe(sourceBody);

    // The edge row landed in state 3 of the pending-state contract
    // (`approved = true AND applied = true`), which is what search
    // consumers filter on.
    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM related_to WHERE id = $id;",
        { id: seedEdge.id },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(edgeRows[0]?.approved).toBe(true);
    expect(edgeRows[0]?.applied).toBe(true);

    // Step 6: a single `daemon_write` row exists for the source note
    // with the post-write body's SHA (the Tier 1 cross-reference key),
    // agent='linker', and targets including the target note id.
    const expectedSha = await sha256Hex(afterBody);
    interface DaemonRow {
      sha: string;
      agent: string;
      targets: RecordId[];
    }
    const [daemonRows] = await connection.db
      .query<[DaemonRow[]]>("SELECT sha, agent, targets FROM daemon_write WHERE note = $note;", {
        note: sourceNoteId,
      })
      .collect<[DaemonRow[]]>();
    expect(daemonRows.length).toBe(1);
    expect(daemonRows[0].sha).toBe(expectedSha);
    expect(daemonRows[0].agent).toBe("linker");
    expect(daemonRows[0].targets.map((target) => target.toString())).toContain(
      targetNoteId.toString(),
    );

    // The closing history row commits the writeback per Task 4.
    const [historyRows] = await connection.db
      .query<[Array<{ kind: string; client_identity: string }>]>(
        "SELECT kind, client_identity FROM history;",
      )
      .collect<[Array<{ kind: string; client_identity: string }>]>();
    expect(historyRows.length).toBe(1);
    expect(historyRows[0].kind).toBe("note.append_section");
    expect(historyRows[0].client_identity).toBe("linker");

    // Step 7: simulate the user save that would normally arrive after the
    // file watcher fires for the writeback. Re-running `runTier1` against
    // the new body must attribute the new `[[beta]]` wikilink to the
    // linker because the daemon_write row matches `(noteId, newSha)`.
    const vaultPaths = ["alpha.md", "beta.md"];
    await runTier1(connection.db, {
      notePath: "beta.md",
      source: targetBody,
      vaultPaths,
    });
    const tier1Output = await runTier1(connection.db, {
      notePath: "alpha.md",
      source: afterBody,
      vaultPaths,
    });
    expect(tier1Output.noteId.toString()).toBe(sourceNoteId.toString());

    const resolvedTargetId = await lookupNoteByPath(connection.db, "beta.md");
    if (resolvedTargetId === null) {
      throw new Error("phase4 smoke: target note disappeared after re-Tier1");
    }
    interface WikilinkRow {
      source: string;
      class: string;
      out: RecordId<"note">;
    }
    const [wikilinkRows] = await connection.db
      .query<[WikilinkRow[]]>(
        "SELECT source, class, out FROM wikilink WHERE in.note = $note AND out = $target;",
        { note: sourceNoteId, target: resolvedTargetId },
      )
      .collect<[WikilinkRow[]]>();
    expect(wikilinkRows.length).toBeGreaterThan(0);
    // Tier 1's daemon_write override rewrites the wikilink's `source`
    // from the default literal `'wikilink'` to the agent name recorded
    // on the matching `daemon_write` row. This is the Locked Decision 3
    // attribution contract that prevents the user from being credited
    // with edges the daemon wrote on their behalf.
    expect(wikilinkRows[0].source).toBe("linker");
    expect(wikilinkRows[0].class).toBe("EXTRACTED");
  });
});
