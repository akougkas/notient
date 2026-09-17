import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DateTime, type RecordId } from "surrealdb";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { prepareNoteRow, runTier1 } from "../../../../src/core/indexer/tier1";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

import { contentRevision } from "../../../../src/api/notes";
import { IndexReadiness } from "../../../../src/core/indexer/indexReadiness";
import { ReferenceRepair } from "../../../../src/core/indexer/referenceRepair";

describe.skipIf(process.env.NOTIENT_SMOKE !== "1")("[smoke] authored reference repair", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "reference-repair-fixture";
  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-tier1-crossres-"));
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

  test("invalidates only changed destinations, preserving inference and human timestamps", async () => {
    const bus = new EventBus();
    const readiness = new IndexReadiness(bus, () => false);
    const queued: string[] = [];
    const repair = new ReferenceRepair({
      db: connection.db,
      bus,
      readiness,
      enqueue: (path) => queued.push(path),
      isExcluded: () => false,
    });
    const body = '---\nrelated: "[[Missing]]"\n---\n\n# Source\n\n[Later](Missing.md)\n';
    await runTier1(connection.db, {
      notePath: "Source.md",
      source: body,
      vaultPaths: ["Source.md"],
      bus,
    });
    await runTier1(connection.db, {
      notePath: "Unrelated.md",
      source: "# Other\n",
      vaultPaths: ["Source.md", "Unrelated.md"],
      bus,
    });
    await connection.db
      .query(
        "UPDATE note SET tier2_at = time::now(), tier3_at = time::now(), last_user_edit_at = time::now();",
      )
      .collect();
    const [before] = await connection.db
      .query<[Array<Record<string, unknown>>]>(
        "SELECT path, tier1_at, tier2_at, tier3_at, last_user_edit_at FROM note ORDER BY path;",
      )
      .collect();
    readiness.finishScan(
      new Map([["Source.md", contentRevision(body)]]),
      new Map([["Source.md", contentRevision(body)]]),
    );
    repair.start();
    try {
      await repair.reconcile();
      expect(queued).toEqual([]);
      await prepareNoteRow(connection.db, {
        path: "Missing.md",
        sha: contentRevision("# Missing"),
        wordCount: 1,
      });
      await repair.reconcile();
      expect(queued).toEqual(["Source.md"]);
      expect(readiness.snapshot()).toMatchObject({ current: 0, pending: 1 });
      const [after] = await connection.db
        .query<[Array<Record<string, unknown>>]>(
          "SELECT path, tier1_at, tier2_at, tier3_at, last_user_edit_at FROM note WHERE path != 'Missing.md' ORDER BY path;",
        )
        .collect();
      expect(after[0].tier1_at).toBeUndefined();
      for (const key of ["tier2_at", "tier3_at", "last_user_edit_at"]) {
        expect(after[0][key]).toBeInstanceOf(DateTime);
        expect(String(after[0][key])).toBe(String(before[0][key]));
      }
      expect(after[1]).toEqual(before[1]);
      // The durable invalidation is retained if shutdown precedes reindexing.
      await repair.stop();
      await runTier1(connection.db, {
        notePath: "Source.md",
        source: body,
        vaultPaths: ["Source.md", "Missing.md", "Unrelated.md"],
        bus,
      });
      repair.start();
      queued.length = 0;
      await repair.reconcile();
      expect(queued).toEqual([]);
      const [edges] = await connection.db
        .query<[Array<{ in: RecordId; out: RecordId }>]>("SELECT in, out FROM frontmatter_ref;")
        .collect();
      expect(edges).toHaveLength(1);
    } finally {
      await repair.stop();
      readiness.dispose();
    }
  });
});
