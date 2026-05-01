import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { prepareNoteRow, runTier1 } from "../../../../src/core/indexer/tier1";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

/**
 * Regression coverage for cross-note edge resolution determinism.
 *
 * Bug. `runTier1` resolves wikilink and frontmatter_ref targets via
 * `lookupNoteByPath`. When two notes mutually reference each other and
 * the indexer queue processes them one at a time, the first note's
 * cross-note edges fail to resolve because the sibling row does not
 * exist yet: wikilinks fall back to the recoverable
 * `wikilink_unresolved` table, but frontmatter_refs are silently
 * dropped. After a single awaken pass the database holds half the
 * expected frontmatter_refs; only a second pass converges the count.
 *
 * Fix. The awaken handler now pre-creates every queued note row via
 * `prepareNoteRow` before the indexer drains. This test exercises the
 * exact scenario directly: pre-create A and B, then run Tier 1 against
 * each in turn (B's runTier1 happens after A's so the legacy
 * single-phase code would still drop A->B's frontmatter_ref because
 * B's row would not exist when A is indexed). Both edges land on the
 * first pass.
 */

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

interface FrontmatterRefRow {
  in: RecordId<"note">;
  out: RecordId<"note">;
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] Tier 1 cross-note edge resolution", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "tier1-crossresolution-secret";
  const aPath = "notes/a.md";
  const bPath = "notes/b.md";
  const vaultPaths = [aPath, bPath];

  const aSource = `---
notient:
  supports:
    - "[[b]]"
---

# A

A links to [[b]].
`;
  const bSource = `---
notient:
  supports:
    - "[[a]]"
---

# B

B links to [[a]].
`;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-tier1-crossres-"));
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

  test("prepareNoteRow plus runTier1 emits both directions of the frontmatter_ref edge in one pass", async () => {
    // Pre-create both note rows so the second-phase Tier 1 lookups for
    // cross-note targets succeed regardless of indexing order. This is
    // the same pre-pass the awaken handler now performs over the queue
    // before the indexer drains.
    await prepareNoteRow(connection.db, {
      path: aPath,
      sha: "placeholder-a-sha",
      wordCount: 0,
    });
    await prepareNoteRow(connection.db, {
      path: bPath,
      sha: "placeholder-b-sha",
      wordCount: 0,
    });

    // Process A first. Without the pre-create, B's row would not exist
    // and A's frontmatter_ref to B would be dropped.
    await runTier1(connection.db, {
      notePath: aPath,
      source: aSource,
      vaultPaths,
    });
    // Then process B. B's frontmatter_ref to A always resolved because
    // A's row was created by A's own runTier1; the pre-create is the
    // only mechanism that saves the A->B direction.
    await runTier1(connection.db, {
      notePath: bPath,
      source: bSource,
      vaultPaths,
    });

    const [refs] = await connection.db
      .query<[FrontmatterRefRow[]]>(
        "SELECT in, out FROM frontmatter_ref WHERE class = 'EXTRACTED' AND source = 'frontmatter';",
      )
      .collect<[FrontmatterRefRow[]]>();
    expect(refs.length).toBe(2);

    const [aRow] = await connection.db
      .query<[Array<{ id: RecordId<"note"> }>]>("SELECT id FROM note WHERE path = $path LIMIT 1;", {
        path: aPath,
      })
      .collect<[Array<{ id: RecordId<"note"> }>]>();
    const [bRow] = await connection.db
      .query<[Array<{ id: RecordId<"note"> }>]>("SELECT id FROM note WHERE path = $path LIMIT 1;", {
        path: bPath,
      })
      .collect<[Array<{ id: RecordId<"note"> }>]>();
    const aId = aRow[0]?.id;
    const bId = bRow[0]?.id;
    expect(aId).toBeDefined();
    expect(bId).toBeDefined();

    const directions = refs.map((row) => `${row.in.toString()}->${row.out.toString()}`).sort();
    expect(directions).toEqual(
      [`${aId?.toString()}->${bId?.toString()}`, `${bId?.toString()}->${aId?.toString()}`].sort(),
    );

    // Wikilinks are also resolved in a single pass: A->B and B->A.
    const [wikilinks] = await connection.db
      .query<[Array<{ in: RecordId; out?: RecordId }>]>(
        "SELECT in, out FROM wikilink WHERE class = 'EXTRACTED' AND source = 'wikilink';",
      )
      .collect<[Array<{ in: RecordId; out?: RecordId }>]>();
    const resolvedWikilinks = wikilinks.filter((row) => row.out !== undefined);
    expect(resolvedWikilinks.length).toBe(2);

    const [unresolved] = await connection.db
      .query<[Array<{ raw_target: string }>]>("SELECT raw_target FROM wikilink_unresolved;")
      .collect<[Array<{ raw_target: string }>]>();
    expect(unresolved.length).toBe(0);
  });

  test("prepareNoteRow is idempotent and never advances tier1_at", async () => {
    const probePath = "notes/prepare-probe.md";
    await prepareNoteRow(connection.db, { path: probePath, sha: "sha-1", wordCount: 0 });
    await prepareNoteRow(connection.db, { path: probePath, sha: "sha-2", wordCount: 7 });

    const [rows] = await connection.db
      .query<
        [
          Array<{
            sha: string;
            word_count: number;
            tier1_at: string | null;
            tier2_at: string | null;
            tier3_at: string | null;
          }>,
        ]
      >("SELECT sha, word_count, tier1_at, tier2_at, tier3_at FROM note WHERE path = $path;", {
        path: probePath,
      })
      .collect<
        [
          Array<{
            sha: string;
            word_count: number;
            tier1_at: string | null;
            tier2_at: string | null;
            tier3_at: string | null;
          }>,
        ]
      >();
    expect(rows.length).toBe(1);
    expect(rows[0].sha).toBe("sha-2");
    expect(rows[0].word_count).toBe(7);
    // SurrealDB option<datetime> fields surface as undefined (NONE) when
    // unset. prepareNoteRow must never advance the tier timestamps;
    // tier1_at / tier2_at / tier3_at only become non-NONE after the
    // owning tier's transaction commits successfully.
    expect(rows[0].tier1_at == null).toBe(true);
    expect(rows[0].tier2_at == null).toBe(true);
    expect(rows[0].tier3_at == null).toBe(true);
  });
});
