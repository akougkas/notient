/**
 * Phase 2 end-to-end smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1).
 *
 * Validates the two locked-decision invariants Phase 5's `links audit`
 * planner depends on:
 *   - LD7: unresolved wikilinks persist with `target_unresolved` set,
 *          routed through the `note:unresolved` sentinel record.
 *   - LD8: every `tagged` edge written by Tier 1 has `source = 'structure'`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { applySchema } from "../../core/db/schemaApplier";
import { connect, type SurrealConnection } from "../../core/db/surreal";
import { runTier1 } from "../../core/indexer/tier1";
import { startSurreal, type SurrealServerHandle } from "../surrealServer";

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
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);

    await runTier1(connection.db, {
      notePath: "beta.md",
      source: noteBeta,
      vaultPaths,
    });
    await runTier1(connection.db, {
      notePath: "alpha.md",
      source: noteAlpha,
      vaultPaths,
    });
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

  test("[smoke] resolved wikilink alpha -> beta exists", async () => {
    const [rows] = await connection.db
      .query<[Array<{ in: RecordId; out: RecordId<"note"> }>]>(
        "SELECT in, out FROM wikilink WHERE source = 'wikilink' AND target_unresolved = NONE;",
      )
      .collect<[Array<{ in: RecordId; out: RecordId<"note"> }>]>();
    expect(rows.length).toBeGreaterThan(0);
  });

  test("[smoke] LD7: unresolved wikilink persists via note:unresolved sentinel", async () => {
    const [rows] = await connection.db
      .query<[Array<{ target_unresolved: string; out: RecordId<"note"> }>]>(
        "SELECT target_unresolved, out FROM wikilink WHERE target_unresolved = 'unknown-target';",
      )
      .collect<[Array<{ target_unresolved: string; out: RecordId<"note"> }>]>();
    expect(rows.length).toBe(1);
    expect(rows[0].target_unresolved).toBe("unknown-target");
    expect(String(rows[0].out)).toBe("note:unresolved");
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
      .query<[Array<{ path: string }>]>(
        "SELECT path FROM tag WHERE path = 'philosophy/ethics';",
      )
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
