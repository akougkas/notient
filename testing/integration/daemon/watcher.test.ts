import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordId, type Surreal } from "surrealdb";
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
import { runTier1 } from "../../../src/core/indexer/tier1";
import { STRUCTURAL_INDEX_VERSION } from "../../../src/core/markdown/types";
import { DaemonMutationJournal } from "../../../src/core/vault/daemonMutationJournal";
import { type SurrealServerHandle, startSurreal } from "../../../src/daemon/surrealServer";
import { VaultWatcher, isWslPath } from "../../../src/daemon/watcher";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const VECTOR_DIM = 768;
const EMBEDDING_IDENTITY = { model: "watcher-fixture", dimension: VECTOR_DIM } as const;
const INCLUDE_ALL = (): boolean => false;
const WATCHER_ACTIVITY = {
  recordHumanActivity: () => {},
  recordDeletion: () => {},
};

function watcherRuntimeDeps() {
  return {
    activity: WATCHER_ACTIVITY,
    mutationJournal: new DaemonMutationJournal(),
    approvalIntents: {
      cancelForNoteDeletion: async () => ({ cancelled: 0, failed: 0 }),
    },
  };
}

function makeSurrealStub(): SurrealConnection {
  return {
    db: {
      create: () => ({
        content: async (input: Record<string, unknown>) => [
          { ...input, id: new RecordId("note", String(input.path)) },
        ],
      }),
      query: () => ({ collect: async () => [[]] }),
    } as unknown as Surreal,
    close: async () => {},
  };
}

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
      surrealDb: makeSurrealStub(),
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
      pollingInterval: 50,
      forcePolling: true,
    });
    await watcher.start();
    await writeFile(join(root, "new.md"), "hello");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await watcher.stop();
    expect(enqueued).toContain("new.md");
  });

  test("startup reconciliation enqueues existing files absent from the index", async () => {
    await writeFile(join(root, "existing.md"), "x");
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root,
      enqueue: (path) => {
        enqueued.push(path);
      },
      surrealDb: makeSurrealStub(),
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
      pollingInterval: 50,
      forcePolling: true,
    });
    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await watcher.stop();
    expect(enqueued).toEqual(["existing.md"]);
  });

  test("maintenance snapshot replay cannot silently miss add, edit, or delete", async () => {
    await writeFile(join(root, "edited.md"), "before");
    await writeFile(join(root, "deleted.md"), "deleted");
    const enqueued: string[] = [];
    const deleted: string[] = [];
    const watcher = new VaultWatcher({
      root,
      enqueue: (path) => enqueued.push(path),
      surrealDb: makeSurrealStub(),
      bus: new EventBus(),
      activity: {
        recordHumanActivity: () => {},
        recordDeletion: (path) => deleted.push(path),
      },
      mutationJournal: new DaemonMutationJournal(),
      approvalIntents: {
        cancelForNoteDeletion: async () => ({ cancelled: 0, failed: 0 }),
      },
      isExcluded: INCLUDE_ALL,
      pollingInterval: 50,
      forcePolling: true,
    });
    await watcher.start();
    const before = await watcher.capturePublicSnapshot();
    await watcher.stop();

    await writeFile(join(root, "edited.md"), "after");
    await writeFile(join(root, "added.md"), "added");
    await unlink(join(root, "deleted.md"));
    const after = await watcher.capturePublicSnapshot();

    // Startup reconciles stored identities; maintenance also replays its
    // captured snapshot to preserve its explicit consistency boundary.
    await watcher.start();
    await watcher.reconcileSnapshotChanges(before, after);
    await watcher.drain();
    await watcher.stop();

    expect(before.get("edited.md")).toBe(createHash("sha256").update("before").digest("hex"));
    expect(after.get("edited.md")).toBe(createHash("sha256").update("after").digest("hex"));
    expect(enqueued).toContain("edited.md");
    expect(enqueued).toContain("added.md");
    expect(deleted).toContain("deleted.md");
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
      hnswCacheMib: 64,
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret, {
      embedDim: EMBEDDING_IDENTITY.dimension,
      embedModel: EMBEDDING_IDENTITY.model,
    });
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

  test("startup reconciles offline add/edit/delete/exclusion and preserves unchanged bytes", async () => {
    const old = "old body\r\n";
    const unchanged = "\ufeff# Keep\r\nAuthored bytes.\r\n";
    for (const [path, body] of [
      ["edited.md", old],
      ["deleted.md", old],
      ["excluded.md", old],
      ["unchanged.md", unchanged],
    ]) {
      await upsertNoteByPath(connection.db, {
        path,
        sha: createHash("sha256").update(body).digest("hex"),
        wordCount: 2,
      });
    }
    await writeFile(join(vaultRoot, "edited.md"), "new body\r\n");
    await writeFile(join(vaultRoot, "added.md"), "# New\n");
    await writeFile(join(vaultRoot, "excluded.md"), old);
    await writeFile(join(vaultRoot, "unchanged.md"), unchanged);
    await connection.db
      .query(
        "UPDATE note SET tier1_at = time::now(), structural_version = $version, reference_targets = '[]';",
        {
          version: STRUCTURAL_INDEX_VERSION,
        },
      )
      .collect();
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: (path) => enqueued.push(path),
      surrealDb: connection,
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      isExcluded: (path) => path === "excluded.md",
      tombstoneWindowMs: 10000,
    });
    try {
      await watcher.start();
      await watcher.drain();
      expect(new Set(enqueued)).toEqual(new Set(["edited.md", "added.md"]));
      const [rows] = await connection.db
        .query<[Array<{ path: string }>]>("SELECT path FROM note WHERE tombstoned_at != NONE;")
        .collect<[Array<{ path: string }>]>();
      expect(rows.map((row) => row.path).sort()).toEqual(["deleted.md", "excluded.md"]);
      expect(await readFile(join(vaultRoot, "unchanged.md"), "utf8")).toBe(unchanged);
      expect(await readFile(join(vaultRoot, "excluded.md"), "utf8")).toBe(old);
    } finally {
      await watcher.stop();
    }
  });

  test("a parser upgrade repairs unchanged structure without inventing a human edit", async () => {
    const path = "parser-upgrade.md";
    const body = "# Existing knowledge\n\n[An authored reference](unchanged.md)\n";
    const bus = new EventBus();
    await writeFile(join(vaultRoot, path), body);
    await runTier1(connection.db, {
      notePath: path,
      source: body,
      vaultPaths: [path, "unchanged.md"],
      bus,
    });
    await connection.db
      .query(
        "UPDATE note SET structural_version = NONE, last_user_edit_at = d'2026-01-01T00:00:00Z' WHERE path = $path;",
        { path },
      )
      .collect();
    const enqueued: string[] = [];
    const human: string[] = [];
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: (path) => enqueued.push(path),
      surrealDb: connection,
      bus,
      ...watcherRuntimeDeps(),
      activity: {
        recordDeletion() {},
        recordHumanActivity(event) {
          if (event.notePath) human.push(event.notePath);
        },
      },
      isExcluded: INCLUDE_ALL,
    });
    try {
      await watcher.start();
      await watcher.drain();
      expect(enqueued).toContain(path);
      expect(human).not.toContain(path);
      await runTier1(connection.db, {
        notePath: path,
        source: body,
        vaultPaths: [path, "unchanged.md"],
        bus,
      });
      const [rows] = await connection.db
        .query<[Array<{ structural_version: number; edited: string }>]>(
          "SELECT structural_version, <string>last_user_edit_at AS edited FROM note WHERE path = $path;",
          { path },
        )
        .collect<[Array<{ structural_version: number; edited: string }>]>();
      expect(rows).toEqual([
        { structural_version: STRUCTURAL_INDEX_VERSION, edited: "2026-01-01T00:00:00Z" },
      ]);
      expect(await readFile(join(vaultRoot, path), "utf8")).toBe(body);
      await watcher.stop();
      enqueued.length = 0;
      await watcher.start();
      expect(enqueued).not.toContain(path);
    } finally {
      await watcher.stop();
    }
  });

  test("an edit arriving during startup reconciliation is enqueued", async () => {
    await writeFile(join(vaultRoot, "during.md"), "before");
    await upsertNoteByPath(connection.db, {
      path: "during.md",
      sha: createHash("sha256").update("before").digest("hex"),
      wordCount: 1,
    });
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: (path) => enqueued.push(path),
      surrealDb: connection,
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
      forcePolling: true,
      pollingInterval: 20,
    });
    const snapshot = watcher.capturePublicSnapshot.bind(watcher);
    watcher.capturePublicSnapshot = async () => {
      const captured = await snapshot();
      await writeFile(join(vaultRoot, "during.md"), "changed during scan");
      return captured;
    };
    try {
      await watcher.start();
      const seen = await waitFor(async () => (enqueued.includes("during.md") ? true : null), 1500);
      expect(seen).toBe(true);
    } finally {
      await watcher.stop();
    }
  });

  test("unlink eventually sets tombstoned_at", async () => {
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
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
    });
    await watcher.start();
    await unlink(filePath);
    const tombstoned = await waitFor(
      async () => {
        const [rows] = await connection.db
          .query<[Array<{ tombstoned_at: string | null }>]>(
            "SELECT tombstoned_at FROM note WHERE path = $path;",
            { path: "to-delete.md" },
          )
          .collect<[Array<{ tombstoned_at: string | null }>]>();
        const value = rows[0]?.tombstoned_at;
        return value !== null && value !== undefined ? value : null;
      },
      5000,
      50,
    );
    await watcher.stop();
    expect(tombstoned).not.toBeNull();
  });

  test("a save stamps last_user_edit_at", async () => {
    const filePath = join(vaultRoot, "edited.md");
    await writeFile(filePath, "original body");
    await upsertNoteByPath(connection.db, {
      path: "edited.md",
      sha: "edited-sha",
      wordCount: 2,
    });
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: () => {},
      pollingInterval: 30,
      forcePolling: true,
      surrealDb: connection,
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
    });
    await watcher.start();
    await writeFile(filePath, "edited body with more words");
    const stamped = await waitFor(
      async () => {
        const [rows] = await connection.db
          .query<[Array<{ last_user_edit_at: string | null }>]>(
            "SELECT last_user_edit_at FROM note WHERE path = $path;",
            { path: "edited.md" },
          )
          .collect<[Array<{ last_user_edit_at: string | null }>]>();
        const value = rows[0]?.last_user_edit_at;
        return value !== null && value !== undefined ? value : null;
      },
      5000,
      50,
    );
    await watcher.stop();
    expect(stamped).not.toBeNull();
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
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
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

  test("same-path recreation clears its tombstone before the cascade can purge it", async () => {
    const vaultPath = "atomic-save.md";
    const filePath = join(vaultRoot, vaultPath);
    const originalBody = "before atomic save";
    const replacementBody = "after atomic save";
    await writeFile(filePath, originalBody);
    const noteId = await upsertNoteByPath(connection.db, {
      path: vaultPath,
      sha: createHash("sha256").update(originalBody).digest("hex"),
      wordCount: 3,
    });
    const enqueued: string[] = [];
    let targetCancellationCalls = 0;
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: (path) => enqueued.push(path),
      pollingInterval: 20,
      forcePolling: true,
      surrealDb: connection,
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      approvalIntents: {
        cancelForNoteDeletion: async (candidate) => {
          if (candidate.toString() === noteId.toString()) targetCancellationCalls += 1;
          return { cancelled: 0, failed: 0 };
        },
      },
      isExcluded: INCLUDE_ALL,
      tombstoneWindowMs: 500,
    });
    await watcher.start();
    await unlink(filePath);
    const tombstoned = await waitFor(async () => {
      const [rows] = await connection.db
        .query<[Array<{ tombstoned_at?: unknown }>]>(
          "SELECT tombstoned_at FROM note WHERE id = $id;",
          { id: noteId },
        )
        .collect<[Array<{ tombstoned_at?: unknown }>]>();
      return rows[0]?.tombstoned_at !== undefined ? true : null;
    }, 1_500);
    expect(tombstoned).toBe(true);

    await writeFile(filePath, replacementBody);
    const revived = await waitFor(async () => {
      const [rows] = await connection.db
        .query<[Array<{ id: RecordId<"note">; tombstoned_at?: unknown }>]>(
          "SELECT id, tombstoned_at FROM note WHERE id = $id;",
          { id: noteId },
        )
        .collect<[Array<{ id: RecordId<"note">; tombstoned_at?: unknown }>]>();
      const row = rows[0];
      return row !== undefined && row.tombstoned_at === undefined ? row : null;
    }, 1_500);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await watcher.stop();

    expect(revived?.id.toString()).toBe(noteId.toString());
    expect(enqueued).toContain(vaultPath);
    expect(targetCancellationCalls).toBe(0);
    const [survivors] = await connection.db
      .query<[Array<{ id: RecordId<"note"> }>]>("SELECT id FROM note WHERE id = $id;", {
        id: noteId,
      })
      .collect<[Array<{ id: RecordId<"note"> }>]>();
    expect(survivors).toHaveLength(1);
  });

  test("startup recovery revives a tombstone when its Markdown file reappeared offline", async () => {
    const vaultPath = "offline-recreated.md";
    const filePath = join(vaultRoot, vaultPath);
    const body = "present before watcher startup";
    await writeFile(filePath, body);
    const noteId = await upsertNoteByPath(connection.db, {
      path: vaultPath,
      sha: createHash("sha256").update(body).digest("hex"),
      wordCount: 4,
    });
    await connection.db
      .query("UPDATE $id SET tombstoned_at = d'2000-01-01T00:00:00Z';", { id: noteId })
      .collect();
    const [beforeStartRows] = await connection.db
      .query<[Array<{ tombstoned_at?: unknown }>]>(
        "SELECT tombstoned_at FROM note WHERE id = $id;",
        { id: noteId },
      )
      .collect<[Array<{ tombstoned_at?: unknown }>]>();
    expect(beforeStartRows[0]?.tombstoned_at).toBeDefined();
    const enqueued: string[] = [];
    const failures: string[] = [];
    const bus = new EventBus();
    bus.on("indexer:error", (event) => failures.push(`${event.phase}: ${event.message}`));
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: (path) => enqueued.push(path),
      pollingInterval: 20,
      forcePolling: true,
      surrealDb: connection,
      bus,
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
      tombstoneWindowMs: 50,
    });
    await watcher.start();
    const revived = await waitFor(async () => {
      const [rows] = await connection.db
        .query<[Array<{ id: RecordId<"note">; tombstoned_at?: unknown }>]>(
          "SELECT id, tombstoned_at FROM note WHERE id = $id;",
          { id: noteId },
        )
        .collect<[Array<{ id: RecordId<"note">; tombstoned_at?: unknown }>]>();
      const row = rows[0];
      return row !== undefined && row.tombstoned_at === undefined ? row : null;
    }, 1_500);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await watcher.stop();

    expect(revived?.id.toString()).toBe(noteId.toString());
    expect(failures).toEqual([]);
    expect(enqueued).toContain(vaultPath);
  });

  test("startup recovery purges a newly excluded note even when its Markdown still exists", async () => {
    const vaultPath = "private/newly-excluded.md";
    const filePath = join(vaultRoot, vaultPath);
    await mkdir(join(vaultRoot, "private"), { recursive: true });
    await writeFile(filePath, "private body");
    const noteId = await upsertNoteByPath(connection.db, {
      path: vaultPath,
      sha: "private-sha",
      wordCount: 2,
    });
    await connection.db
      .query("UPDATE $id SET tombstoned_at = d'2000-01-01T00:00:00Z';", { id: noteId })
      .collect();
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: (path) => enqueued.push(path),
      pollingInterval: 20,
      forcePolling: true,
      surrealDb: connection,
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      isExcluded: (path) => path === vaultPath,
      tombstoneWindowMs: 50,
    });
    await watcher.start();
    const deleted = await waitFor(async () => {
      const [rows] = await connection.db
        .query<[Array<{ id: RecordId<"note"> }>]>("SELECT id FROM note WHERE id = $id;", {
          id: noteId,
        })
        .collect<[Array<{ id: RecordId<"note"> }>]>();
      return rows.length === 0 ? true : null;
    }, 1_500);
    await watcher.stop();

    expect(deleted).toBe(true);
    // Other notes in this shared fixture may require startup reconciliation.
    // The excluded note itself must never be admitted.
    expect(enqueued).not.toContain(vaultPath);
    expect(await readFile(filePath, "utf8")).toBe("private body");
  });

  test("rename window enforced server-side: stale tombstone rejected by threshold filter", async () => {
    const body = "stale-tombstone-body";
    const bodySha = createHash("sha256").update(body).digest("hex");
    await upsertNoteByPath(connection.db, {
      path: "stale.md",
      sha: bodySha,
      wordCount: 2,
    });

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
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
    });
    await watcher.start();
    // Stamp after startup so this test isolates the server-side rename
    // threshold. Startup recovery intentionally purges old tombstones.
    await connection.db
      .query("UPDATE note SET tombstoned_at = d'2000-01-01T00:00:00Z' WHERE path = $path;", {
        path: "stale.md",
      })
      .collect();
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
    const [evidenceId] = await replaceChunks(connection.db, sourceId, EMBEDDING_IDENTITY, [
      {
        ord: 0,
        text: "cascade body",
        tokenEstimate: 3,
        vector: new Array<number>(VECTOR_DIM).fill(0.1),
      },
    ]);
    if (evidenceId === undefined) throw new Error("expected cascade evidence chunk");
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
      evidence: [evidenceId],
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
      evidence: [evidenceId],
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
      evidence: [evidenceId],
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
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
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

  test("an old cascade cannot consume a newer deletion generation's grace window", async () => {
    const vaultPath = "generation-aba.md";
    const filePath = join(vaultRoot, vaultPath);
    await writeFile(filePath, "generation one");
    const noteId = await upsertNoteByPath(connection.db, {
      path: vaultPath,
      sha: "generation-aba-sha",
      wordCount: 2,
    });
    let observeFirstCancellation = (): void => {};
    const firstCancellationObserved = new Promise<void>((resolve) => {
      observeFirstCancellation = resolve;
    });
    let releaseFirstCancellation = (): void => {};
    const firstCancellationReleased = new Promise<void>((resolve) => {
      releaseFirstCancellation = resolve;
    });
    const cancellationTokens: string[] = [];
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: () => {},
      pollingInterval: 20,
      forcePolling: true,
      surrealDb: connection,
      bus: new EventBus(),
      activity: WATCHER_ACTIVITY,
      mutationJournal: new DaemonMutationJournal(),
      approvalIntents: {
        cancelForNoteDeletion: async (_candidate, tombstonedAt) => {
          cancellationTokens.push(tombstonedAt.toString());
          if (cancellationTokens.length === 1) {
            observeFirstCancellation();
            await firstCancellationReleased;
          }
          return { cancelled: 0, failed: 0 };
        },
      },
      isExcluded: INCLUDE_ALL,
      tombstoneWindowMs: 180,
      cascadeRetryMs: 40,
    });

    try {
      await watcher.start();
      await unlink(filePath);
      await firstCancellationObserved;

      await writeFile(filePath, "recreated between generations");
      const revived = await waitFor(async () => {
        const [rows] = await connection.db
          .query<[Array<{ tombstoned_at?: unknown }>]>(
            "SELECT tombstoned_at FROM note WHERE id = $id;",
            { id: noteId },
          )
          .collect<[Array<{ tombstoned_at?: unknown }>]>();
        return rows[0]?.tombstoned_at === undefined ? true : null;
      }, 1_500);
      expect(revived).toBe(true);

      await unlink(filePath);
      const secondGeneration = await waitFor(async () => {
        const [rows] = await connection.db
          .query<[Array<{ tombstoned_at?: unknown }>]>(
            "SELECT tombstoned_at FROM note WHERE id = $id;",
            { id: noteId },
          )
          .collect<[Array<{ tombstoned_at?: unknown }>]>();
        const token = rows[0]?.tombstoned_at;
        return token !== undefined && String(token) !== cancellationTokens[0]
          ? String(token)
          : null;
      }, 1_500);
      if (secondGeneration === null) {
        throw new Error("same-path deletion did not receive a second tombstone generation");
      }

      releaseFirstCancellation();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const [survivors] = await connection.db
        .query<[Array<{ id: RecordId<"note">; tombstoned_at?: unknown }>]>(
          "SELECT id, tombstoned_at FROM note WHERE id = $id;",
          { id: noteId },
        )
        .collect<[Array<{ id: RecordId<"note">; tombstoned_at?: unknown }>]>();
      expect(survivors).toHaveLength(1);
      expect(String(survivors[0]?.tombstoned_at)).toBe(secondGeneration);
      expect(cancellationTokens).toHaveLength(1);
    } finally {
      releaseFirstCancellation();
      await watcher.stop();
    }
  });

  test("a cancellation exception cannot strand a tombstone without a cascade retry", async () => {
    const vaultPath = "retry-cascade.md";
    const filePath = join(vaultRoot, vaultPath);
    await writeFile(filePath, "retry cascade body");
    const noteId = await upsertNoteByPath(connection.db, {
      path: vaultPath,
      sha: "retry-cascade-sha",
      wordCount: 3,
    });
    let cancellationCalls = 0;
    const bus = new EventBus();
    const failures: string[] = [];
    bus.on("indexer:error", (event) => failures.push(event.phase ?? ""));
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: () => {},
      pollingInterval: 20,
      forcePolling: true,
      surrealDb: connection,
      bus,
      activity: WATCHER_ACTIVITY,
      mutationJournal: new DaemonMutationJournal(),
      approvalIntents: {
        cancelForNoteDeletion: async (candidate) => {
          if (candidate.toString() !== noteId.toString()) {
            return { cancelled: 0, failed: 0 };
          }
          cancellationCalls += 1;
          if (cancellationCalls === 1) throw new Error("synthetic cancellation outage");
          return { cancelled: 0, failed: 0 };
        },
      },
      isExcluded: INCLUDE_ALL,
      tombstoneWindowMs: 40,
      cascadeRetryMs: 40,
    });
    await watcher.start();
    await unlink(filePath);
    const deleted = await waitFor(async () => {
      const [rows] = await connection.db
        .query<[Array<{ id: RecordId<"note"> }>]>("SELECT id FROM note WHERE id = $id;", {
          id: noteId,
        })
        .collect<[Array<{ id: RecordId<"note"> }>]>();
      return rows.length === 0 ? true : null;
    }, 2_000);
    await watcher.stop();

    expect(deleted).toBe(true);
    expect(cancellationCalls).toBeGreaterThanOrEqual(2);
    expect(failures).toContain("watcher-cascade");
  });

  test("startup reconstructs and completes a cascade whose process-local timer was lost", async () => {
    const noteId = await upsertNoteByPath(connection.db, {
      path: "orphaned-tombstone.md",
      sha: "orphaned-tombstone-sha",
      wordCount: 2,
    });
    await connection.db
      .query(
        "UPDATE $id SET tombstoned_at = d'2000-01-01T00:00:00Z' WHERE tombstoned_at IS NONE;",
        { id: noteId },
      )
      .collect();
    const watcher = new VaultWatcher({
      root: vaultRoot,
      enqueue: () => {},
      pollingInterval: 20,
      forcePolling: true,
      surrealDb: connection,
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
      tombstoneWindowMs: 100,
      cascadeRetryMs: 40,
    });
    await watcher.start();
    const deleted = await waitFor(async () => {
      const [rows] = await connection.db
        .query<[Array<{ id: RecordId<"note"> }>]>("SELECT id FROM note WHERE id = $id;", {
          id: noteId,
        })
        .collect<[Array<{ id: RecordId<"note"> }>]>();
      return rows.length === 0 ? true : null;
    }, 2_000);
    await watcher.stop();
    expect(deleted).toBe(true);
  });
});
