import { GraphService } from "../../../../src/core/graph/graphService";
/**
 * Phase 2 end-to-end smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1).
 *
 * Validates the two locked-decision invariants Phase 5's `links audit`
 * planner depends on:
 *   - LD7: unresolved wikilinks persist in the `wikilink_unresolved`
 *          table with `raw_target` set, keeping the wikilink relation
 *          traversal-clean.
 *   - LD8: every `tagged` edge written by Tier 1 has `source = 'structure'`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { makeFindPathTool } from "../../../../src/core/chat/tools/graph";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { readNoteNeighbors } from "../../../../src/core/graph/noteNeighbors";
import { runTier1 } from "../../../../src/core/indexer/tier1";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const noteAlpha = `---
title: Alpha
---

# Alpha

A paragraph that links to [[beta]] and to [[unknown-target]]. Tagged with #philosophy/ethics.
`;

const noteBeta = `# Beta

Beta links back to [[alpha]].
`;

describe.skipIf(!SMOKE_ENABLED)("[smoke] Phase 2 Tier 1 end-to-end", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase2-smoke-secret";
  const vaultPaths = ["alpha.md", "beta.md"];

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-phase2-smoke-"));
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

    await runTier1(connection.db, {
      notePath: "beta.md",
      source: noteBeta,
      vaultPaths,
      bus: new EventBus(),
    });
    await runTier1(connection.db, {
      notePath: "alpha.md",
      source: noteAlpha,
      vaultPaths,
      bus: new EventBus(),
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

  test("[smoke] resolved wikilink alpha -> beta exists", async () => {
    const [rows] = await connection.db
      .query<[Array<{ in: RecordId; out: RecordId<"note"> }>]>(
        "SELECT in, out FROM wikilink WHERE source = 'wikilink';",
      )
      .collect<[Array<{ in: RecordId; out: RecordId<"note"> }>]>();
    expect(rows.length).toBeGreaterThan(0);
  });

  test("Markdown links, embeds and properties share note connections and paths", async () => {
    const paths = [
      "Links/Active.md",
      "Design Notes.md",
      "Archive/Decision.md",
      "Links/Reference.md",
    ];
    const bus = new EventBus();
    for (const notePath of paths.slice(1))
      await runTier1(connection.db, {
        notePath,
        source: "# Trade offs\n\nA documented choice. ^choice\n",
        vaultPaths: paths,
        bus,
      });
    const source =
      '---\nrelated: "[[Archive/Decision]]"\n---\n# [Design](../Design%20Notes.md#Trade%20offs)\n\n[decision][ref] ![excerpt](./Reference.md#^choice) [same](#Here) [web](https://example.com/a.md)\n\n[ref]: /Archive/Decision.md#^choice\n\n## Here\n';
    await runTier1(connection.db, { notePath: paths[0], source, vaultPaths: paths, bus });
    const neighbors = await readNoteNeighbors(connection.db, paths[0]);
    expect(neighbors.map((row) => [row.notePath, row.table, row.agent]).sort()).toEqual(
      [
        ["Design Notes.md", "wikilink", "markdown"],
        ["Archive/Decision.md", "wikilink", "markdown"],
        ["Links/Reference.md", "embed", "markdown"],
        ["Archive/Decision.md", "frontmatter_ref", "frontmatter"],
      ].sort(),
    );
    const backlinks = await readNoteNeighbors(connection.db, "Links/Reference.md");
    expect(backlinks).toEqual([
      {
        notePath: paths[0],
        table: "embed",
        direction: "incoming",
        agent: "markdown",
        confidence: 1,
        proposed: false,
      },
    ]);
    const tool = makeFindPathTool(
      new GraphService({
        db: connection.db,
        vault: {
          readBounded: async (path) =>
            path === paths[0] ? source : "# Trade offs\n\nA documented choice. ^choice\n",
        },
      }),
    );
    const route = await tool.invoke(
      { fromNotePath: "Links/Reference.md", toNotePath: "Design Notes.md", maxHops: 2 },
      new AbortController().signal,
      { clientIdentity: "human" },
    );
    expect(route.path.map((note) => note.path)).toEqual([
      "Links/Reference.md",
      "Links/Active.md",
      "Design Notes.md",
    ]);
    const [external] = await connection.db
      .query<[Array<{ raw_target: string }>]>(
        "SELECT raw_target FROM wikilink_unresolved WHERE source = 'markdown';",
      )
      .collect<[Array<{ raw_target: string }>]>();
    expect(external).toEqual([]);
  });

  test("[smoke] LD7: unresolved wikilink persists in wikilink_unresolved table", async () => {
    const [rows] = await connection.db
      .query<[Array<{ raw_target: string; in: RecordId; source: string }>]>(
        "SELECT raw_target, in, source FROM wikilink_unresolved WHERE raw_target = 'unknown-target';",
      )
      .collect<[Array<{ raw_target: string; in: RecordId; source: string }>]>();
    expect(rows.length).toBe(1);
    expect(rows[0].raw_target).toBe("unknown-target");
    expect(rows[0].source).toBe("wikilink");
  });

  test("[smoke] LD8: every tagged edge has source = 'structure'", async () => {
    const [rows] = await connection.db
      .query<[Array<{ source: string }>]>("SELECT source FROM tagged;")
      .collect<[Array<{ source: string }>]>();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toBe("structure");
    }
  });

  test("[smoke] tag rows include the nested path 'philosophy/ethics'", async () => {
    const [rows] = await connection.db
      .query<[Array<{ path: string }>]>("SELECT path FROM tag WHERE path = 'philosophy/ethics';")
      .collect<[Array<{ path: string }>]>();
    expect(rows.length).toBe(1);
  });

  test("[smoke] block rows exist for both indexed notes", async () => {
    const [rows] = await connection.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM block GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    expect(rows[0]?.count ?? 0).toBeGreaterThan(0);
  });
});
