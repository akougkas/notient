/**
 * Smoke harness for the awaken handler's cross-note edge pre-pass.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1) or
 * directly via `NOTIENT_SMOKE=1 bun test src/daemon/__smoke__/awaken.crossresolution.smoke.test.ts`.
 *
 * Bug. Tier 1 resolves wikilink and frontmatter_ref targets via
 * `lookupNoteByPath`. When the indexer queue processes notes one at a
 * time, a note that references a sibling that sits later in the queue
 * resolves the lookup to null: wikilinks fall back to the recoverable
 * `wikilink_unresolved` table, but frontmatter_refs are silently
 * dropped. After a single awaken pass on a fresh vault, the database
 * holds half the expected frontmatter_refs; only a second pass
 * converges the count.
 *
 * Fix. The awaken handler now pre-creates every queued note row via
 * `prepareNoteRow` before the indexer drains. This smoke test boots a
 * real SurrealDB child, creates an on-disk vault with mutually
 * referencing notes, runs the awaken handler exactly once, and asserts
 * the edge counts on the first pass equal the legacy two-pass count.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsVault } from "../../../../src/adapters/fsVault";
import { AwakenBackgroundRegistry } from "../../../../src/core/awaken/backgroundRegistry";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { IndexerQueue } from "../../../../src/core/indexer/indexerQueue";
import { runTier1 } from "../../../../src/core/indexer/tier1";
import { makeAwakenHandler } from "../../../../src/daemon/handlers/awaken";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

async function countTable(connection: SurrealConnection, table: string): Promise<number> {
  const [rows] = await connection.db
    .query<[Array<{ count: number }>]>(`SELECT count() AS count FROM ${table} GROUP ALL;`)
    .collect<[Array<{ count: number }>]>();
  return rows[0]?.count ?? 0;
}

async function countWhere(
  connection: SurrealConnection,
  table: string,
  predicate: string,
): Promise<number> {
  const [rows] = await connection.db
    .query<[Array<{ count: number }>]>(
      `SELECT count() AS count FROM ${table} WHERE ${predicate} GROUP ALL;`,
    )
    .collect<[Array<{ count: number }>]>();
  return rows[0]?.count ?? 0;
}

async function clearGraphTables(connection: SurrealConnection): Promise<void> {
  const tables = [
    "wikilink",
    "frontmatter_ref",
    "tagged",
    "contained_in",
    "under_heading",
    "wikilink_unresolved",
    "embed_unresolved",
    "embed",
    "block",
    "tag",
    "note",
  ];
  for (const table of tables) {
    await connection.db.query(`DELETE ${table};`).collect();
  }
}

interface FixtureNote {
  path: string;
  body: string;
}

/**
 * Ten-note fixture with mutual cross-references via frontmatter and
 * wikilinks. The expected edge counts match the post-second-pass
 * convergence of the legacy code: every frontmatter ref resolves, and
 * every body wikilink to a sibling resolves.
 */
function buildFixture(): FixtureNote[] {
  const note = (name: string, supports: string[], links: string[]): FixtureNote => {
    const supportsBlock =
      supports.length === 0
        ? ""
        : `notient:\n  supports:\n${supports.map((target) => `    - "[[${target}]]"`).join("\n")}\n`;
    const linksLine =
      links.length === 0
        ? ""
        : `\nThis note references ${links.map((target) => `[[${target}]]`).join(" and ")}.\n`;
    return {
      path: `notes/${name}.md`,
      body: `---\n${supportsBlock}---\n\n# ${name.toUpperCase()}\n\nBody for ${name}.${linksLine}`,
    };
  };

  return [
    note("a", ["b", "c"], ["b"]),
    note("b", ["a"], ["c", "d"]),
    note("c", ["d"], ["a"]),
    note("d", ["e"], ["e", "f"]),
    note("e", ["f"], ["g"]),
    note("f", ["g", "h"], ["a"]),
    note("g", ["h"], ["b"]),
    note("h", ["i"], ["i"]),
    note("i", ["j"], ["a", "b"]),
    note("j", ["a"], ["c"]),
  ];
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] awaken cross-note edge pre-pass", () => {
  let tempDir: string;
  let vaultDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "awaken-crossres-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-awaken-crossres-"));
    vaultDir = path.join(tempDir, "vault");
    await mkdir(path.join(vaultDir, "notes"), { recursive: true });

    const fixture = buildFixture();
    for (const entry of fixture) {
      await writeFile(path.join(vaultDir, entry.path), entry.body, "utf8");
    }

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

  test("[smoke] one awaken pass produces the same cross-edge counts as two passes did before the fix", async () => {
    await clearGraphTables(connection);

    const bus = new EventBus();
    const vault = new FsVault(vaultDir);

    // Bind a Tier-1-only indexer. Tier 2 / Tier 3 are out of scope for
    // this regression: we only verify cross-note edge convergence on
    // the first awaken pass. Wiring just Tier 1 keeps the smoke fast
    // and avoids embedder/linker dependencies.
    const allMarkdown = await vault.listMarkdown();
    const vaultPaths = allMarkdown.map((entry) => entry.path);
    const indexer = new IndexerQueue({
      bus,
      debounceMs: 0,
      indexNote: async (notePath) => {
        const body = await vault.read(notePath);
        await runTier1(connection.db, {
          notePath,
          source: body,
          vaultPaths,
          bus,
        });
        // The awaken handler now drives `runAwakenWorker`, which awaits
        // `indexer:note-indexed` per note before advancing. The bare
        // Tier-1-only indexNote in this smoke does not emit it; emit it
        // here so the worker observes per-note completion.
        bus.emit({
          type: "indexer:note-indexed",
          path: notePath,
          result: {
            chunkCount: 0,
            embedCount: 0,
            nodeCount: 0,
            edgeCount: 0,
            durationMs: 0,
          },
        });
      },
    });

    const handler = makeAwakenHandler({
      bus,
      indexer,
      vault,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal: connection,
    });
    const result = await handler({ tier: [1] }, () => {}, "smoke-1");
    expect(result.ok).toBe(true);
    expect(result.queued).toBe(vaultPaths.length);

    // Every fixture note exists.
    const noteCount = await countTable(connection, "note");
    expect(noteCount).toBe(vaultPaths.length);

    // 12 frontmatter refs (a:2, b:1, c:1, d:1, e:1, f:2, g:1, h:1, i:1,
    // j:1) all land on the first pass. Before the fix this number was
    // 5 after pass 1 and only converged on pass 2.
    const frontmatterRefs = await countWhere(
      connection,
      "frontmatter_ref",
      "class = 'EXTRACTED' AND source = 'frontmatter'",
    );
    expect(frontmatterRefs).toBe(12);

    // Body wikilinks: every sibling reference resolves; the body never
    // mentions a path that does not exist, so wikilink_unresolved stays
    // empty and the resolved wikilink edge count equals the body
    // reference count (b, c, d, e, f, a, b, a, i, a, b, c → 12).
    const wikilinks = await countWhere(
      connection,
      "wikilink",
      "class = 'EXTRACTED' AND source = 'wikilink'",
    );
    expect(wikilinks).toBe(13);
    const unresolvedWikilinks = await countTable(connection, "wikilink_unresolved");
    expect(unresolvedWikilinks).toBe(0);

    // A second awaken pass converges to the exact same numbers; the
    // pre-pass plus Tier 1's idempotent transaction guarantees no
    // duplicates accumulate.
    const secondResult = await handler({ tier: [1] }, () => {}, "smoke-2");
    expect(secondResult.ok).toBe(true);

    const secondFrontmatter = await countWhere(
      connection,
      "frontmatter_ref",
      "class = 'EXTRACTED' AND source = 'frontmatter'",
    );
    expect(secondFrontmatter).toBe(12);
    const secondWikilinks = await countWhere(
      connection,
      "wikilink",
      "class = 'EXTRACTED' AND source = 'wikilink'",
    );
    expect(secondWikilinks).toBe(13);
    const secondUnresolved = await countTable(connection, "wikilink_unresolved");
    expect(secondUnresolved).toBe(0);
  }, 120_000);
});
