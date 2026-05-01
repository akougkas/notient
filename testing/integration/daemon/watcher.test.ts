import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordId } from "surrealdb";
import { applySchema } from "../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  replaceChunks,
  upsertClaim,
  upsertConcept,
  upsertNoteByPath,
  upsertQuestion,
} from "../../../src/core/db/surreal";
import { EventBus } from "../../../src/core/events/eventBus";
import { type SurrealServerHandle, startSurreal } from "../../../src/daemon/surrealServer";
import { VaultWatcher, isWslPath } from "../../../src/daemon/watcher";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const VECTOR_DIM = 768;

async function waitFor<T>(
  predicate: () => Promise<T | null>,
  timeoutMs: number,
  pollMs = 25,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result !== null) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

describe("VaultWatcher", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-watch-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("emits enqueue when a markdown file is added after start", async () => {
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root,
      enqueue: (path) => {
        enqueued.push(path);
      },
      pollingInterval: 50,
      forcePolling: true,
    });
    await watcher.start();
    await writeFile(join(root, "new.md"), "hello");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await watcher.stop();
    expect(enqueued).toContain("new.md");
  });

  test("ignoreInitial: existing files are not enqueued on start", async () => {
    await writeFile(join(root, "existing.md"), "x");
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root,
      enqueue: (path) => {
        enqueued.push(path);
      },
      pollingInterval: 50,
      forcePolling: true,
    });
    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await watcher.stop();
    expect(enqueued).toEqual([]);
  });
});

describe.skipIf(!SMOKE_ENABLED)("[smoke] VaultWatcher with SurrealDB", () => {
  let tempDir: string;
  let dataDir: string;
  let vaultRoot: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "watcher-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "notient-watcher-smoke-"));
    dataDir = join(tempDir, "data");
    vaultRoot = join(tempDir, "vault");
    await mkdir(vaultRoot, { recursive: true });
    handle = await startSurreal({
      dataDir,
      secret,
      portFile: join(tempDir, "port"),
      pidFile: join(tempDir, "pid"),
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

  test("unlink sets tombstoned_at within 200ms", async () => {
    const filePath = join(vaultRoot, "to-delete.md");
    await writeFile(filePath, "deletable body");
    await upsertNoteByPath(connection.db, {
      path: "to-delete.md",
      sha: "deletable-sha",
      wordCount: 2,
    });
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: () => {},
      pollingInterval: 30,
      forcePolling: true,
      surrealDb: connection,
    });
    await watcher.start();
    await unlink(filePath);
    const tombstoned = await waitFor(async () => {
      const [rows] = await connection.db
        .query<[Array<{ tombstoned_at: string | null }>]>(
          "SELECT tombstoned_at FROM note WHERE path = $path;",
          { path: "to-delete.md" },
        )
        .collect<[Array<{ tombstoned_at: string | null }>]>();
      const value = rows[0]?.tombstoned_at;
      return value !== null && value !== undefined ? value : null;
    }, 1500);
    await watcher.stop();
    expect(tombstoned).not.toBeNull();
  });

  test("rename within 60s SHA-match window preserves note id and clears tombstone", async () => {
    const sourcePath = join(vaultRoot, "source.md");
    const renamedPath = join(vaultRoot, "renamed.md");
    const body = "rename me";
    await writeFile(sourcePath, body);
    const bodySha = createHash("sha256").update(body).digest("hex");
    const noteRecord = await upsertNoteByPath(connection.db, {
      path: "source.md",
      sha: bodySha,
      wordCount: 2,
    });
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: () => {},
      pollingInterval: 30,
      forcePolling: true,
      surrealDb: connection,
      tombstoneWindowMs: 60_000,
    });
    await watcher.start();
    await unlink(sourcePath);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(renamedPath, body);
    const renamed = await waitFor(async () => {
      const [rows] = await connection.db
        .query<[Array<{ id: RecordId<"note">; path: string; tombstoned_at: string | null }>]>(
          "SELECT id, path, tombstoned_at FROM note WHERE id = $id;",
          { id: noteRecord },
        )
        .collect<[Array<{ id: RecordId<"note">; path: string; tombstoned_at: string | null }>]>();
      const row = rows[0];
      return row !== undefined && row.path === "renamed.md" ? row : null;
    }, 1500);
    await watcher.stop();
    expect(renamed).not.toBeNull();
    expect(renamed?.path).toBe("renamed.md");
    expect(renamed?.tombstoned_at ?? null).toBeNull();
  });

  test("rename window enforced server-side: stale tombstone rejected by threshold filter", async () => {
    const body = "stale-tombstone-body";
    const bodySha = createHash("sha256").update(body).digest("hex");
    await upsertNoteByPath(connection.db, {
      path: "stale.md",
      sha: bodySha,
      wordCount: 2,
    });
    await connection.db
      .query("UPDATE note SET tombstoned_at = d'2000-01-01T00:00:00Z' WHERE path = $path;", {
        path: "stale.md",
      })
      .collect();

    const enqueued: string[] = [];
    const renameEvents: Array<{ from: string; to: string }> = [];
    const bus = new EventBus();
    bus.on("indexer:renamed", (event) => {
      renameEvents.push({ from: event.fromPath, to: event.toPath });
    });

    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: (vaultPath) => {
        enqueued.push(vaultPath);
      },
      pollingInterval: 30,
      forcePolling: true,
      surrealDb: connection,
      tombstoneWindowMs: 60_000,
      bus,
    });
    await watcher.start();
    await writeFile(join(vaultRoot, "renamed-stale.md"), body);
    const observed = await waitFor(async () => {
      if (enqueued.includes("renamed-stale.md") || renameEvents.length > 0) {
        return true;
      }
      return null;
    }, 1500);
    await watcher.stop();

    expect(observed).toBe(true);
    expect(renameEvents).toEqual([]);
    expect(enqueued).toContain("renamed-stale.md");

    const [rows] = await connection.db
      .query<[Array<{ path: string; tombstoned_at: string | null }>]>(
        "SELECT path, tombstoned_at FROM note WHERE path = 'stale.md';",
      )
      .collect<[Array<{ path: string; tombstoned_at: string | null }>]>();
    expect(rows.length).toBe(1);
    expect(rows[0].tombstoned_at).not.toBeNull();
  });

  test("unlink cascade removes chunks and graph rows after the tombstone window", async () => {
    const filePath = join(vaultRoot, "cascade.md");
    await writeFile(filePath, "cascade body");
    const sourceId = await upsertNoteByPath(connection.db, {
      path: "cascade.md",
      sha: "cascade-sha",
      wordCount: 2,
    });
    const targetId = await upsertNoteByPath(connection.db, {
      path: "cascade-target.md",
      sha: "target-sha",
      wordCount: 1,
    });
    await replaceChunks(connection.db, sourceId, [
      {
        ord: 0,
        text: "cascade body",
        tokenEstimate: 3,
        vector: new Array<number>(VECTOR_DIM).fill(0.1),
        embedModel: "text-embedding-nomic-embed-text-v2-moe",
      },
    ]);
    const conceptId = await upsertConcept(connection.db, "Cascade Concept");
    const claimId = await upsertClaim(connection.db, "Cascade claim.");
    const questionId = await upsertQuestion(connection.db, "Cascade question?");
    await relateEdge(connection.db, {
      table: "mentions",
      from: sourceId,
      to: conceptId,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.7,
      agent: "extractor",
      approved: true,
    });
    await relateEdge(connection.db, {
      table: "asserts",
      from: sourceId,
      to: claimId,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.7,
      agent: "extractor",
      approved: true,
    });
    await relateEdge(connection.db, {
      table: "asks",
      from: sourceId,
      to: questionId,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.7,
      agent: "extractor",
      approved: true,
    });
    await relateEdge(connection.db, {
      table: "supports",
      from: sourceId,
      to: targetId,
      source: "linker",
      confidenceClass: "INFERRED",
      confidence: 0.8,
      agent: "linker",
      approved: false,
    });
    await relateEdge(connection.db, {
      table: "wikilink",
      from: targetId,
      to: sourceId,
      source: "wikilink",
      confidenceClass: "EXTRACTED",
      confidence: 1,
      approved: true,
    });

    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: () => {},
      pollingInterval: 30,
      forcePolling: true,
      surrealDb: connection,
      tombstoneWindowMs: 50,
    });
    await watcher.start();
    await unlink(filePath);
    const deleted = await waitFor(async () => {
      const [rows] = await connection.db
        .query<[Array<{ id: RecordId<"note"> }>]>("SELECT id FROM note WHERE id = $id;", {
          id: sourceId,
        })
        .collect<[Array<{ id: RecordId<"note"> }>]>();
      return rows.length === 0 ? true : null;
    }, 1500);
    await watcher.stop();
    expect(deleted).toBe(true);

    for (const table of ["chunk", "mentions", "asserts", "asks", "supports", "wikilink"]) {
      const where = table === "chunk" ? "note = $note" : "in = $note OR out = $note";
      const [rows] = await connection.db
        .query<[Array<{ count: number }>]>(
          `SELECT count() AS count FROM ${table} WHERE ${where} GROUP ALL;`,
          { note: sourceId },
        )
        .collect<[Array<{ count: number }>]>();
      expect(rows[0]?.count ?? 0).toBe(0);
    }

    const [conceptRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM concept WHERE id = $id;", {
        id: conceptId,
      })
      .collect<[Array<{ id: RecordId }>]>();
    expect(conceptRows).toHaveLength(0);
    const [claimRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM claim WHERE id = $id;", { id: claimId })
      .collect<[Array<{ id: RecordId }>]>();
    expect(claimRows).toHaveLength(0);
    const [questionRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM question WHERE id = $id;", {
        id: questionId,
      })
      .collect<[Array<{ id: RecordId }>]>();
    expect(questionRows).toHaveLength(0);
  });
});
