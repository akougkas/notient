/**
 * Phase 5 substrate-cutover end-to-end smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1) or
 * directly via `NOTIENT_SMOKE=1 bun test src/daemon/__smoke__/phase5.smoke.test.ts`.
 *
 * Boots a real SurrealDB child per `describe` block, applies the Phase 1
 * schema, hand-writes a per-vault state directory under a tempdir-rooted
 * `HOME` so the Phase 5 CLI verbs (`graph dump`, `links audit`, `backup`,
 * `restore`) discover the daemon's port file and secret. Six scenarios
 * exercise the integration surface that the Phase 5 redesign is responsible
 * for:
 *
 *   1. graph dump deterministic JSON: two runs over the same graph produce
 *      byte-identical JSON, and the node/edge counts match independent
 *      SurrealDB queries.
 *   2. links audit NDJSON: an unresolved wikilink seeded by Tier 1 surfaces
 *      as a `kind: "unresolved-wikilink"` finding.
 *   3. backup -> nuke -> restore: row counts for `note`, `wikilink`, and
 *      `daemon_write` round-trip across the cycle. The nuke step uses an
 *      in-process daemon-control hook to keep the smoke tied to the test's
 *      own SurrealDB child.
 *   4. reindex --tier 2 only re-embeds: clearing `tier2_at` and re-running
 *      Tier 2 (the same DB-level invariant the daemon's reindex handler
 *      enforces) leaves Tier 3 entity rows untouched while chunk rows are
 *      re-inserted with fresh vectors.
 *   5. approve flow with the Task 1 SHA producer agreement: a seeded
 *      `related_to` proposal is approved end-to-end; the source note picks
 *      up `[[beta]]` under a `## Related` section, a `daemon_write` row
 *      lands with the post-write body SHA, and re-running Tier 1 over the
 *      new body attributes the wikilink edge to `source = 'linker'`.
 *   6. ApprovalService.reconcilePendingApplications replays
 *      `approved = true, applied = false` rows on simulated daemon restart.
 *
 * Hermetic guarantees:
 *   - Each `describe` block owns a fresh `mkdtemp` tree, a fresh SurrealDB
 *     child, and a fresh fixture vault.
 *   - `afterAll` restores `process.env.HOME`, closes the connection, stops
 *     the surreal subprocess, and removes the temp tree.
 *   - Per-test `beforeEach` clears every tracked table so no scenario
 *     observes another's data.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { runBackupCommand } from "../../cli/commands/backup";
import { type DumpedGraph, runGraphDumpCommand } from "../../cli/commands/graphDump";
import { runLinksAuditCommand } from "../../cli/commands/linksAudit";
import { runNukeCommand } from "../../cli/commands/nuke";
import { runRestoreCommand } from "../../cli/commands/restore";
import { makeEmitter } from "../../cli/output";
import { ApprovalService } from "../../core/approvals/approvalService";
import { EDGE_TABLES } from "../../core/db/edgeTables";
import { applySchema } from "../../core/db/schemaApplier";
import {
  type SurrealConnection,
  clearTierAtByPath,
  connect,
  insertUnresolvedEdge,
  lookupNoteByPath,
  recordDaemonWrite,
  upsertNoteByPath,
} from "../../core/db/surreal";
import { EventBus } from "../../core/events/eventBus";
import { Embedder } from "../../core/indexer/embedder";
import { runTier1 } from "../../core/indexer/tier1";
import { EMBED_MODEL, runTier2 } from "../../core/indexer/tier2";
import type { EmbedOptions, LLMProvider } from "../../core/llm/provider";
import {
  vaultDataDir,
  vaultPortPath,
  vaultSecretPath,
  vaultStateDir,
} from "../../core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;

const ENTITY_TABLES = ["note", "block", "chunk", "tag", "concept", "claim", "question"] as const;
const UNRESOLVED_TABLES = ["wikilink_unresolved", "embed_unresolved"] as const;
const OPS_TABLES = [
  "daemon_write",
  "history",
  "awaken_run",
  "agent_event",
  "agent_session",
  "agent_run",
] as const;

const ALL_TRACKED_TABLES: readonly string[] = [
  ...EDGE_TABLES,
  ...ENTITY_TABLES,
  ...UNRESOLVED_TABLES,
  ...OPS_TABLES,
];

async function clearAllTrackedTables(connection: SurrealConnection): Promise<void> {
  for (const table of ALL_TRACKED_TABLES) {
    await connection.db.query(`DELETE ${table};`).collect();
  }
}

async function countTable(connection: SurrealConnection, table: string): Promise<number> {
  const [rows] = await connection.db
    .query<[Array<{ count: number }>]>(`SELECT count() AS count FROM ${table} GROUP ALL;`)
    .collect<[Array<{ count: number }>]>();
  return rows[0]?.count ?? 0;
}

async function sha256Hex(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fakeProvider(impl: Partial<LLMProvider>): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    chatJson: async <T>() => ({}) as T,
    embed: async () => [],
    ...impl,
  };
}

function vectorOf(seed: number): number[] {
  const out = new Array<number>(VECTOR_DIM);
  for (let index = 0; index < VECTOR_DIM; index += 1) {
    out[index] = Math.sin((index + 1) * seed) * 0.5 + 0.5;
  }
  return out;
}

function makeDeterministicEmbedder(seed: number): Embedder {
  const provider = fakeProvider({
    embed: async (input: string[], _opts: EmbedOptions) =>
      input.map((_text, index) => vectorOf(seed + index)),
  });
  return new Embedder(provider, { model: EMBED_MODEL });
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

interface HarnessContext {
  tempDir: string;
  vaultPath: string;
  handle: SurrealServerHandle;
  connection: SurrealConnection;
  originalHome: string | undefined;
  secret: string;
}

async function bootHarness(prefix: string, secret: string): Promise<HarnessContext> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const homeOverride = path.join(tempDir, "home");
  await mkdir(homeOverride, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = homeOverride;

  const vaultPath = path.join(tempDir, "vault");
  await mkdir(vaultPath, { recursive: true });

  // Place the SurrealDB data dir at the per-vault `vaultDataDir` location
  // so `notient nuke` (which wipes that exact path) targets the same
  // RocksDB directory the test's child is running on.
  const stateDir = vaultStateDir(vaultPath);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const handle = await startSurreal({
    dataDir: vaultDataDir(vaultPath),
    secret,
    portFile: path.join(tempDir, "surreal.port"),
    pidFile: path.join(tempDir, "surreal.pid"),
    logLevel: "warn",
  });
  const connection = await connect({
    url: handle.url,
    user: "root",
    pass: secret,
    namespace: "notient",
    database: "vault",
  });
  await applySchema(connection.db, secret);

  const port = new URL(handle.url).port;
  await writeFile(vaultPortPath(vaultPath), port, "utf8");
  await writeFile(vaultSecretPath(vaultPath), secret, { mode: 0o600 });

  return { tempDir, vaultPath, handle, connection, originalHome, secret };
}

async function tearDownHarness(context: HarnessContext): Promise<void> {
  await context.connection.close().catch(() => {});
  await context.handle.stop().catch(() => {});
  if (context.originalHome === undefined) {
    process.env.HOME = undefined;
  } else {
    process.env.HOME = context.originalHome;
  }
  await rm(context.tempDir, { recursive: true, force: true });
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] Phase 5 substrate cutover", () => {
  let context: HarnessContext;
  const secret = "phase5-smoke-secret";

  beforeAll(async () => {
    context = await bootHarness("notient-phase5-smoke-", secret);
  }, 30_000);

  afterAll(async () => {
    await tearDownHarness(context);
  });

  beforeEach(async () => {
    await clearAllTrackedTables(context.connection);
  });

  test("[smoke] graph dump emits deterministic JSON whose counts match SurrealDB", async () => {
    const vaultPaths = ["alpha.md", "beta.md", "gamma.md"];
    const sources: Record<string, string> = {
      "alpha.md": "# Alpha\n\nAlpha links to [[beta]] and to [[gamma]].\n",
      "beta.md": "# Beta\n\nBeta references [[alpha]].\n",
      "gamma.md": "# Gamma\n\nGamma points at [[beta]].\n",
    };
    for (const notePath of vaultPaths) {
      await runTier1(context.connection.db, {
        notePath,
        source: sources[notePath] ?? "",
        vaultPaths,
      });
    }

    const firstFile = path.join(context.tempDir, "dump-first.json");
    const secondFile = path.join(context.tempDir, "dump-second.json");
    const firstExit = await runGraphDumpCommand({
      vaultPath: context.vaultPath,
      tier: 1,
      format: "json",
      outPath: firstFile,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
    });
    expect(firstExit).toBe(0);
    const secondExit = await runGraphDumpCommand({
      vaultPath: context.vaultPath,
      tier: 1,
      format: "json",
      outPath: secondFile,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
    });
    expect(secondExit).toBe(0);

    const firstText = await Bun.file(firstFile).text();
    const secondText = await Bun.file(secondFile).text();
    expect(firstText).toBe(secondText);

    const parsed = JSON.parse(firstText) as DumpedGraph;
    const noteNodeCount = parsed.nodes.filter((node) => node.table === "note").length;
    const wikilinkEdgeCount = parsed.edges.filter((edge) => edge.table === "wikilink").length;

    const noteRowCount = await countTable(context.connection, "note");
    const [wikilinkRows] = await context.connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM wikilink WHERE class = 'EXTRACTED' AND source = 'wikilink' GROUP ALL;",
      )
      .collect<[Array<{ count: number }>]>();
    const dbWikilinkCount = wikilinkRows[0]?.count ?? 0;
    expect(noteNodeCount).toBe(noteRowCount);
    expect(wikilinkEdgeCount).toBe(dbWikilinkCount);
  }, 60_000);

  test("[smoke] links audit emits NDJSON for unresolved wikilinks", async () => {
    const vaultPaths = ["delta.md"];
    const noteSource =
      "# Delta\n\nDelta has a dangling reference to [[ghost-note]] that no file resolves.\n";
    await runTier1(context.connection.db, {
      notePath: "delta.md",
      source: noteSource,
      vaultPaths,
    });

    const lines: string[] = [];
    const exitCode = await runLinksAuditCommand({
      vaultPath: context.vaultPath,
      mode: "ndjson",
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      writeStdout: (line) => lines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(lines.length).toBeGreaterThan(0);

    const findings = lines.map(
      (line) =>
        JSON.parse(line) as {
          kind: string;
          id: string;
          details: { raw_target?: string };
        },
    );
    const unresolved = findings.find(
      (finding) =>
        finding.kind === "unresolved-wikilink" && finding.details.raw_target === "ghost-note",
    );
    expect(unresolved).toBeDefined();
  }, 60_000);
});

describe.skipIf(!SMOKE_ENABLED)("[smoke] Phase 5 backup-nuke-restore", () => {
  let context: HarnessContext;
  const secret = "phase5-smoke-backup-nuke-restore-secret";

  beforeAll(async () => {
    context = await bootHarness("notient-phase5-backup-", secret);
  }, 30_000);

  afterAll(async () => {
    await tearDownHarness(context);
  });

  test("[smoke] backup, in-process nuke, and restore round-trip note/wikilink/daemon_write counts", async () => {
    // Seed a small graph: two notes, an alpha->beta wikilink (from Tier 1),
    // and a daemon_write row attributed to the linker for the alpha note.
    const vaultPaths = ["alpha.md", "beta.md"];
    const alphaSource = "# Alpha\n\nAlpha links to [[beta]].\n";
    const betaSource = "# Beta\n\nBeta is the target.\n";
    await runTier1(context.connection.db, {
      notePath: "beta.md",
      source: betaSource,
      vaultPaths,
    });
    await runTier1(context.connection.db, {
      notePath: "alpha.md",
      source: alphaSource,
      vaultPaths,
    });
    const alphaId = await lookupNoteByPath(context.connection.db, "alpha.md");
    const betaId = await lookupNoteByPath(context.connection.db, "beta.md");
    if (alphaId === null || betaId === null) {
      throw new Error("phase5 smoke: failed to look up seeded notes");
    }
    await recordDaemonWrite(context.connection.db, {
      noteId: alphaId,
      sha: await sha256Hex(alphaSource),
      agent: "linker",
      targets: [betaId],
    });

    const noteCountBefore = await countTable(context.connection, "note");
    const wikilinkCountBefore = await countTable(context.connection, "wikilink");
    const daemonWriteCountBefore = await countTable(context.connection, "daemon_write");
    expect(noteCountBefore).toBeGreaterThan(0);
    expect(wikilinkCountBefore).toBeGreaterThan(0);
    expect(daemonWriteCountBefore).toBeGreaterThan(0);

    const dumpFile = path.join(context.tempDir, `phase5-dump-${Date.now()}.surql`);
    const backupExit = await runBackupCommand({
      vaultPath: context.vaultPath,
      outPath: dumpFile,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
    });
    expect(backupExit).toBe(0);
    const dumpText = await Bun.file(dumpFile).text();
    expect(dumpText.length).toBeGreaterThan(0);

    // Hermetic nuke: stop our SurrealDB child, wipe the data dir
    // (`runNukeCommand` does that for us), then start a fresh child on
    // whatever port the kernel hands out and rewrite the per-vault port
    // file so subsequent restore calls connect to the new instance.
    const stopHook = async (): Promise<void> => {
      await context.connection.close().catch(() => {});
      await context.handle.stop().catch(() => {});
    };
    const startHook = async (): Promise<void> => {
      const newHandle = await startSurreal({
        dataDir: vaultDataDir(context.vaultPath),
        secret,
        portFile: path.join(context.tempDir, "surreal.port"),
        pidFile: path.join(context.tempDir, "surreal.pid"),
        logLevel: "warn",
      });
      const newConnection = await connect({
        url: newHandle.url,
        user: "root",
        pass: secret,
        namespace: "notient",
        database: "vault",
      });
      await applySchema(newConnection.db, secret);
      const newPort = new URL(newHandle.url).port;
      await writeFile(vaultPortPath(context.vaultPath), newPort, "utf8");
      context.handle = newHandle;
      context.connection = newConnection;
    };
    const nukeExit = await runNukeCommand({
      vaultPath: context.vaultPath,
      yes: true,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      stopDaemon: stopHook,
      startDaemon: startHook,
    });
    expect(nukeExit).toBe(0);

    // Post-nuke: every tracked table is empty on the fresh schema.
    for (const table of [...ENTITY_TABLES, ...EDGE_TABLES, ...OPS_TABLES]) {
      const count = await countTable(context.connection, table);
      if (count !== 0) {
        throw new Error(`phase5 smoke: expected ${table} to be empty post-nuke, got ${count}`);
      }
    }

    const restoreExit = await runRestoreCommand({
      vaultPath: context.vaultPath,
      inputPath: dumpFile,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
    });
    expect(restoreExit).toBe(0);

    const noteCountAfter = await countTable(context.connection, "note");
    const wikilinkCountAfter = await countTable(context.connection, "wikilink");
    const daemonWriteCountAfter = await countTable(context.connection, "daemon_write");
    expect(noteCountAfter).toBe(noteCountBefore);
    expect(wikilinkCountAfter).toBe(wikilinkCountBefore);
    expect(daemonWriteCountAfter).toBe(daemonWriteCountBefore);
  }, 120_000);
});

describe.skipIf(!SMOKE_ENABLED)("[smoke] Phase 5 reindex tier filter", () => {
  let context: HarnessContext;
  const secret = "phase5-smoke-reindex-secret";

  beforeAll(async () => {
    context = await bootHarness("notient-phase5-reindex-", secret);
  }, 30_000);

  afterAll(async () => {
    await tearDownHarness(context);
  });

  test("[smoke] reindex --tier 2 re-embeds chunks without disturbing Tier 3 entity rows", async () => {
    const notePath = "epsilon.md";
    const noteSource =
      "# Epsilon\n\nA paragraph with enough text to chunk and embed deterministically.\n";
    const vaultPaths = [notePath];
    const tier1Output = await runTier1(context.connection.db, {
      notePath,
      source: noteSource,
      vaultPaths,
    });

    // Tier 2: deterministic embedder.
    const initialEmbedder = makeDeterministicEmbedder(0.42);
    const tier2Initial = await runTier2(context.connection.db, {
      notePath,
      blocks: tier1Output.extraction.blocks,
      embedder: initialEmbedder,
    });
    expect(tier2Initial.chunkCount).toBeGreaterThan(0);

    // Tier 3 stand-in: insert one extractor-style row in each entity table
    // and one auto-approved `mentions` edge so we can witness that
    // reindex --tier 2 leaves the Tier 3 surface untouched.
    const noteId = tier1Output.noteId;
    const [conceptCreated] = await context.connection.db
      .query<[Array<{ id: RecordId<"concept"> }>]>(
        "CREATE concept CONTENT { label: $label, norm_label: $norm } RETURN id;",
        { label: "Epsilon Concept", norm: "epsilon concept" },
      )
      .collect<[Array<{ id: RecordId<"concept"> }>]>();
    const conceptId = conceptCreated[0]?.id;
    if (conceptId === undefined) {
      throw new Error("phase5 smoke: failed to create concept node");
    }
    await context.connection.db
      .query<[Array<{ id: RecordId }>]>(
        "RELATE $note->mentions->$concept SET source = 'extractor', class = 'INFERRED', confidence = 0.9, agent = 'extractor', approved = true RETURN id;",
        { note: noteId, concept: conceptId },
      )
      .collect<[Array<{ id: RecordId }>]>();
    await context.connection.db
      .query("CREATE claim CONTENT { text: $text, sha: $sha };", {
        text: "epsilon claim",
        sha: await sha256Hex("epsilon claim"),
      })
      .collect();
    await context.connection.db
      .query("CREATE question CONTENT { text: $text, sha: $sha };", {
        text: "epsilon question?",
        sha: await sha256Hex("epsilon question?"),
      })
      .collect();

    // Snapshot row counts and chunk vectors before the tier-2 reindex.
    const chunkCountBefore = await countTable(context.connection, "chunk");
    const conceptCountBefore = await countTable(context.connection, "concept");
    const claimCountBefore = await countTable(context.connection, "claim");
    const questionCountBefore = await countTable(context.connection, "question");
    const mentionsCountBefore = await countTable(context.connection, "mentions");
    const [vectorRowsBefore] = await context.connection.db
      .query<[Array<{ ord: number; vector: number[] }>]>(
        "SELECT ord, vector FROM chunk WHERE note = $note ORDER BY ord;",
        { note: noteId },
      )
      .collect<[Array<{ ord: number; vector: number[] }>]>();

    // Reindex --tier 2: this is the DB-level invariant the daemon's
    // `reindex.glob` handler enforces (clear `tier2_at`, then re-run the
    // matching tier). The smoke exercises it in-process so the test stays
    // tied to its own SurrealDB child.
    await clearTierAtByPath(context.connection.db, notePath, [2]);
    const reembedEmbedder = makeDeterministicEmbedder(7.5);
    const tier2Replay = await runTier2(context.connection.db, {
      notePath,
      blocks: tier1Output.extraction.blocks,
      embedder: reembedEmbedder,
    });
    expect(tier2Replay.chunkCount).toBe(tier2Initial.chunkCount);

    // Chunks were rewritten (count preserved, vectors changed).
    const chunkCountAfter = await countTable(context.connection, "chunk");
    expect(chunkCountAfter).toBe(chunkCountBefore);
    const [vectorRowsAfter] = await context.connection.db
      .query<[Array<{ ord: number; vector: number[] }>]>(
        "SELECT ord, vector FROM chunk WHERE note = $note ORDER BY ord;",
        { note: noteId },
      )
      .collect<[Array<{ ord: number; vector: number[] }>]>();
    expect(vectorRowsAfter.length).toBe(vectorRowsBefore.length);
    const beforeFirst = vectorRowsBefore[0]?.vector;
    const afterFirst = vectorRowsAfter[0]?.vector;
    if (beforeFirst === undefined || afterFirst === undefined) {
      throw new Error("phase5 smoke: chunk vectors missing");
    }
    const vectorsDiffer = beforeFirst.some((value, index) => value !== afterFirst[index]);
    expect(vectorsDiffer).toBe(true);

    // Tier 3 entity rows are untouched.
    expect(await countTable(context.connection, "concept")).toBe(conceptCountBefore);
    expect(await countTable(context.connection, "claim")).toBe(claimCountBefore);
    expect(await countTable(context.connection, "question")).toBe(questionCountBefore);
    expect(await countTable(context.connection, "mentions")).toBe(mentionsCountBefore);
  }, 60_000);
});

describe.skipIf(!SMOKE_ENABLED)("[smoke] Phase 5 approval flow with Task 1 SHA producer", () => {
  let context: HarnessContext;
  const secret = "phase5-smoke-approval-secret";

  beforeAll(async () => {
    context = await bootHarness("notient-phase5-approve-", secret);
  }, 30_000);

  afterAll(async () => {
    await tearDownHarness(context);
  });

  test("[smoke] approveEdge writes the wikilink, records daemon_write, and re-Tier1 attributes the new edge to the linker", async () => {
    // Per-test fixture vault rooted under the harness tempdir. Two notes
    // (A and B); A will accept a `supports` proposal pointing at B.
    const vaultRoot = path.join(context.tempDir, "approve-vault");
    await mkdir(vaultRoot, { recursive: true });
    const vaultPaths = ["alpha.md", "beta.md"];
    const alphaPath = path.join(vaultRoot, "alpha.md");
    const betaPath = path.join(vaultRoot, "beta.md");
    const alphaBody = "# Alpha\n\nAlpha is the source note.\n";
    const betaBody = "# Beta\n\nBeta is the target note.\n";
    await writeFile(alphaPath, alphaBody);
    await writeFile(betaPath, betaBody);

    // Tier 1 seeds the SurrealDB note rows so the approval flow can address
    // them by record id. Order matches the production indexer queue (target
    // first so the source's wikilink resolution can find it).
    await runTier1(context.connection.db, {
      notePath: "beta.md",
      source: betaBody,
      vaultPaths,
    });
    await runTier1(context.connection.db, {
      notePath: "alpha.md",
      source: alphaBody,
      vaultPaths,
    });
    const alphaId = await lookupNoteByPath(context.connection.db, "alpha.md");
    const betaId = await lookupNoteByPath(context.connection.db, "beta.md");
    if (alphaId === null || betaId === null) {
      throw new Error("phase5 smoke: failed to look up seeded approve-vault notes");
    }

    // Linker proposal: alpha->beta `related_to`. `approved = false` is the
    // initial pending-state contract value. The `related_to` table writes
    // back to the body's `## Related` section (the only writeback edge
    // that produces a body wikilink), which lets re-Tier 1 attribute the
    // resulting wikilink edge via the daemon_write override.
    const seedSql =
      "RELATE $from->related_to->$to SET source = 'linker', class = 'INFERRED', confidence = 0.78, agent = 'linker', approved = false RETURN id;";
    const [seedRows] = await context.connection.db
      .query<[Array<{ id: RecordId }>]>(seedSql, { from: alphaId, to: betaId })
      .collect<[Array<{ id: RecordId }>]>();
    const seedEdge = seedRows[0];
    if (seedEdge === undefined) {
      throw new Error("phase5 smoke: seed RELATE produced no related_to edge");
    }

    const bus = new EventBus();
    const decisions: string[] = [];
    bus.on("approval:decided", (event) => {
      decisions.push(`${event.kind}:${event.decision}`);
    });
    const approvalService = new ApprovalService({
      db: context.connection.db,
      bus,
      vaultRoot,
      fs: realFs,
      readFile: (filePath) => readFile(filePath, "utf8"),
    });
    await approvalService.approveEdge({ id: seedEdge.id, table: "related_to" });
    expect(decisions).toEqual(["edge:accepted"]);

    // Body writeback: alpha now contains a `## Related` section with `[[beta]]`.
    const alphaAfter = await readFile(alphaPath, "utf8");
    expect(alphaAfter).not.toBe(alphaBody);
    expect(alphaAfter).toContain("## Related");
    expect(alphaAfter).toContain("[[beta]]");

    // Edge row landed in pending-state-contract terminal state.
    const [edgeRows] = await context.connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM related_to WHERE id = $id;",
        { id: seedEdge.id },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(edgeRows[0]?.approved).toBe(true);
    expect(edgeRows[0]?.applied).toBe(true);

    // daemon_write row carries the post-write body SHA.
    const expectedSha = await sha256Hex(alphaAfter);
    interface DaemonRow {
      sha: string;
      agent: string;
      targets: RecordId[];
    }
    const [daemonRows] = await context.connection.db
      .query<[DaemonRow[]]>("SELECT sha, agent, targets FROM daemon_write WHERE note = $note;", {
        note: alphaId,
      })
      .collect<[DaemonRow[]]>();
    expect(daemonRows.length).toBe(1);
    expect(daemonRows[0].sha).toBe(expectedSha);
    expect(daemonRows[0].agent).toBe("linker");
    expect(daemonRows[0].targets.map((target) => target.toString())).toContain(betaId.toString());

    // Re-run Tier 1 over the new body. `findRecentDaemonWrite` matches the
    // body SHA recorded in the `daemon_write` row above; Tier 1 then
    // rewrites the new wikilink edge's `source` from the default
    // `wikilink` to `linker` (Locked Decision 3 attribution contract).
    const tier1Replay = await runTier1(context.connection.db, {
      notePath: "alpha.md",
      source: alphaAfter,
      vaultPaths,
    });
    expect(tier1Replay.noteId.toString()).toBe(alphaId.toString());

    const [wikilinkRows] = await context.connection.db
      .query<[Array<{ source: string; class: string }>]>(
        "SELECT source, class FROM wikilink WHERE in.note = $note AND out = $target;",
        { note: alphaId, target: betaId },
      )
      .collect<[Array<{ source: string; class: string }>]>();
    expect(wikilinkRows.length).toBeGreaterThan(0);
    expect(wikilinkRows[0].source).toBe("linker");
    expect(wikilinkRows[0].class).toBe("EXTRACTED");
  }, 60_000);
});

describe.skipIf(!SMOKE_ENABLED)(
  "[smoke] Phase 5 ApprovalService.reconcilePendingApplications",
  () => {
    let context: HarnessContext;
    const secret = "phase5-smoke-reconcile-secret";

    beforeAll(async () => {
      context = await bootHarness("notient-phase5-reconcile-", secret);
    }, 30_000);

    afterAll(async () => {
      await tearDownHarness(context);
    });

    test("[smoke] a fresh ApprovalService instance replays approved=true,applied=false rows on simulated daemon restart", async () => {
      const vaultRoot = path.join(context.tempDir, "reconcile-vault");
      await mkdir(vaultRoot, { recursive: true });
      const vaultPaths = ["alpha.md", "beta.md"];
      const alphaPath = path.join(vaultRoot, "alpha.md");
      const betaPath = path.join(vaultRoot, "beta.md");
      const alphaBody = "# Alpha\n\nAlpha awaits reconciliation.\n";
      const betaBody = "# Beta\n\nBeta is the reconciliation target.\n";
      await writeFile(alphaPath, alphaBody);
      await writeFile(betaPath, betaBody);

      // Seed the note rows directly so we can plant a `related_to` edge in
      // the writeback-in-flight state without first running the full
      // `approveEdge` (the test is the recovery path, not the happy path).
      const alphaId = await upsertNoteByPath(context.connection.db, {
        path: "alpha.md",
        sha: await sha256Hex(alphaBody),
        wordCount: 5,
      });
      const betaId = await upsertNoteByPath(context.connection.db, {
        path: "beta.md",
        sha: await sha256Hex(betaBody),
        wordCount: 5,
      });

      // Plant the row in state 2: `approved = true, applied = false`. This is
      // exactly what a daemon crash between the approved-flip and the closing
      // history transaction would leave behind.
      const seedSql =
        "RELATE $from->related_to->$to SET source = 'linker', class = 'INFERRED', confidence = 0.7, agent = 'linker', approved = true, applied = false RETURN id;";
      const [seedRows] = await context.connection.db
        .query<[Array<{ id: RecordId }>]>(seedSql, { from: alphaId, to: betaId })
        .collect<[Array<{ id: RecordId }>]>();
      const seedEdge = seedRows[0];
      if (seedEdge === undefined) {
        throw new Error("phase5 smoke: seed RELATE produced no related_to edge");
      }

      // Sanity: the file on disk does not yet contain `[[beta]]`.
      const beforeBody = await readFile(alphaPath, "utf8");
      expect(beforeBody).not.toContain("[[beta]]");

      // Construct a brand-new ApprovalService instance, mimicking the daemon
      // bootstrap path that calls `reconcilePendingApplications` on start.
      const bus = new EventBus();
      const reconciler = new ApprovalService({
        db: context.connection.db,
        bus,
        vaultRoot,
        fs: realFs,
        readFile: (filePath) => readFile(filePath, "utf8"),
      });
      const result = await reconciler.reconcilePendingApplications();
      expect(result.replayed).toBe(1);
      expect(result.failed).toBe(0);

      // Edge row reaches `applied = true`.
      const [edgeRows] = await context.connection.db
        .query<[Array<{ approved: boolean; applied: boolean }>]>(
          "SELECT approved, applied FROM related_to WHERE id = $id;",
          { id: seedEdge.id },
        )
        .collect<[Array<{ approved: boolean; applied: boolean }>]>();
      expect(edgeRows[0]?.approved).toBe(true);
      expect(edgeRows[0]?.applied).toBe(true);

      // File on disk now carries the wikilink under `## Related`.
      const afterBody = await readFile(alphaPath, "utf8");
      expect(afterBody).toContain("## Related");
      expect(afterBody).toContain("[[beta]]");

      // Smoke: also exercise the unresolved-edge plumbing the audit verb
      // depends on. The reconcile path is independent of this row, so its
      // presence does not affect the assertions above.
      await insertUnresolvedEdge(context.connection.db, {
        kind: "wikilink",
        from: alphaId,
        rawTarget: "ghost-target",
        source: "wikilink",
      });
      const auditLines: string[] = [];
      const auditExit = await runLinksAuditCommand({
        vaultPath: context.vaultPath,
        mode: "ndjson",
        emitter: makeEmitter({ mode: "json", write: () => {} }),
        writeStdout: (line) => auditLines.push(line),
      });
      expect(auditExit).toBe(0);
      const auditFindings = auditLines.map((line) => JSON.parse(line) as { kind: string });
      expect(auditFindings.some((finding) => finding.kind === "unresolved-wikilink")).toBe(true);
    }, 60_000);
  },
);
