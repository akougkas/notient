import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { applySchema } from "../db/schemaApplier";
import { connect, type SurrealConnection, upsertNoteByPath } from "../db/surreal";
import { EventBus } from "../events/eventBus";
import { startSurreal, type SurrealServerHandle } from "../../daemon/surrealServer";
import { runTier1 } from "./tier1";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const fixtureNote = `---
title: Active Note
related: "[[other]]"
---

# H1

A paragraph with [[other]] and [[also#section]] and [[non-existent-target]]. ^para-1

Tagged content #topic/sub here.
`;

describe.skipIf(!SMOKE_ENABLED)("[smoke] Tier 1 indexer", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "tier1-smoke-secret";
  const activePath = "notes/active.md";
  const otherPath = "notes/other.md";
  const alsoPath = "notes/also.md";
  const vaultPaths = [activePath, otherPath, alsoPath];

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-tier1-smoke-"));
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

    await upsertNoteByPath(connection.db, { path: otherPath, sha: "other-sha", wordCount: 1 });
    await upsertNoteByPath(connection.db, { path: alsoPath, sha: "also-sha", wordCount: 1 });
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

  test("inserts blocks including one with block_id = 'para-1'", async () => {
    const result = await runTier1(connection.db, {
      notePath: activePath,
      source: fixtureNote,
      vaultPaths,
    });
    expect(result.noteId).toBeDefined();

    const [blocks] = await connection.db
      .query<[Array<{ id: RecordId<"block">; block_id?: string }>]>(
        "SELECT id, block_id FROM block WHERE note = $note;",
        { note: result.noteId },
      )
      .collect<[Array<{ id: RecordId<"block">; block_id?: string }>]>();
    expect(blocks.length).toBeGreaterThan(0);
    const explicit = blocks.find((row) => row.block_id === "para-1");
    expect(explicit).toBeDefined();
  });

  test("creates a wikilink edge from the active note (or block) to other.md", async () => {
    const [edges] = await connection.db
      .query<[Array<{ in: RecordId; out?: RecordId<"note"> }>]>(
        "SELECT in, out FROM wikilink WHERE source = 'wikilink';",
      )
      .collect<[Array<{ in: RecordId; out?: RecordId<"note"> }>]>();
    const otherEdge = edges.find((edge) => edge.out !== undefined);
    expect(otherEdge).toBeDefined();
  });

  test("persists unresolved wikilink in wikilink_unresolved table", async () => {
    const [rows] = await connection.db
      .query<[Array<{ in: RecordId; raw_target: string; source: string }>]>(
        "SELECT in, raw_target, source FROM wikilink_unresolved WHERE raw_target = 'non-existent-target';",
      )
      .collect<[Array<{ in: RecordId; raw_target: string; source: string }>]>();
    expect(rows.length).toBe(1);
    expect(rows[0].raw_target).toBe("non-existent-target");
    expect(rows[0].source).toBe("wikilink");
  });

  test("tagged edge has source = 'structure' (literal-string equality)", async () => {
    const [rows] = await connection.db
      .query<[Array<{ source: string }>]>("SELECT source FROM tagged;")
      .collect<[Array<{ source: string }>]>();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toBe("structure");
    }
  });

  test("tag row exists with path = 'topic/sub'", async () => {
    const [rows] = await connection.db
      .query<[Array<{ path: string }>]>("SELECT path FROM tag WHERE path = 'topic/sub';")
      .collect<[Array<{ path: string }>]>();
    expect(rows.length).toBe(1);
    expect(rows[0].path).toBe("topic/sub");
  });

  test("frontmatter_ref edge exists from active to other.md", async () => {
    const [rows] = await connection.db
      .query<[Array<{ in: RecordId<"note">; out: RecordId<"note">; source: string }>]>(
        "SELECT in, out, source FROM frontmatter_ref;",
      )
      .collect<[Array<{ in: RecordId<"note">; out: RecordId<"note">; source: string }>]>();
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("frontmatter");
  });

  test("re-running runTier1 replaces blocks deterministically", async () => {
    const [beforeCount] = await connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM block WHERE note IN (SELECT id FROM note WHERE path = $path) GROUP ALL;",
        { path: activePath },
      )
      .collect<[Array<{ count: number }>]>();
    const before = beforeCount[0]?.count ?? 0;

    await runTier1(connection.db, {
      notePath: activePath,
      source: fixtureNote,
      vaultPaths,
    });

    const [afterCount] = await connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM block WHERE note IN (SELECT id FROM note WHERE path = $path) GROUP ALL;",
        { path: activePath },
      )
      .collect<[Array<{ count: number }>]>();
    const after = afterCount[0]?.count ?? 0;
    expect(after).toBe(before);
  });

  test("rolls back the entire transaction when a tag CREATE violates the schema regex", async () => {
    const badNotePath = "notes/rollback.md";
    const badFixture = `# Rollback Heading

A paragraph with [[rollback-only-missing-target]] and a #rollbackonlytag and an #_badtag tag.
`;
    let threwError = false;
    try {
      await runTier1(connection.db, {
        notePath: badNotePath,
        source: badFixture,
        vaultPaths: [...vaultPaths, badNotePath],
      });
    } catch {
      threwError = true;
    }
    expect(threwError).toBe(true);

    const [noteRows] = await connection.db
      .query<[Array<{ id: RecordId<"note"> }>]>("SELECT id FROM note WHERE path = $path;", {
        path: badNotePath,
      })
      .collect<[Array<{ id: RecordId<"note"> }>]>();
    expect(noteRows.length).toBe(0);

    const [blockRows] = await connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM block WHERE note IN (SELECT VALUE id FROM note WHERE path = $path) GROUP ALL;",
        { path: badNotePath },
      )
      .collect<[Array<{ count: number }>]>();
    expect(blockRows[0]?.count ?? 0).toBe(0);

    const [unresolvedRows] = await connection.db
      .query<[Array<{ raw_target: string }>]>(
        "SELECT raw_target FROM wikilink_unresolved WHERE raw_target = 'rollback-only-missing-target';",
      )
      .collect<[Array<{ raw_target: string }>]>();
    expect(unresolvedRows.length).toBe(0);

    const [tagRows] = await connection.db
      .query<[Array<{ path: string }>]>(
        "SELECT path FROM tag WHERE path IN ['rollbackonlytag', '_badtag'];",
      )
      .collect<[Array<{ path: string }>]>();
    expect(tagRows.length).toBe(0);
  });

  test("emits indexer:warn for each frontmatter ref whose target does not resolve", async () => {
    const warnEvents: Array<{ type: "indexer:warn"; phase?: string; message: string }> = [];
    const bus = new EventBus();
    bus.on("indexer:warn", (event) => warnEvents.push(event));

    const warningPath = "notes/warning-emitter.md";
    const fixture = `---
related: "[[other]]"
unrelated: "[[totally-missing-target]]"
---

# Heading

Body.
`;
    await runTier1(connection.db, {
      notePath: warningPath,
      source: fixture,
      vaultPaths: [...vaultPaths, warningPath],
      bus,
    });

    expect(warnEvents.length).toBe(1);
    expect(warnEvents[0].phase).toBe("tier1");
    expect(warnEvents[0].message).toContain("totally-missing-target");
    expect(warnEvents[0].message).toContain(warningPath);
    expect(warnEvents[0].message).toContain("unrelated");

    const [refs] = await connection.db
      .query<[Array<{ in: RecordId<"note">; out: RecordId<"note"> }>]>(
        "SELECT in, out FROM frontmatter_ref WHERE in IN (SELECT VALUE id FROM note WHERE path = $path);",
        { path: warningPath },
      )
      .collect<[Array<{ in: RecordId<"note">; out: RecordId<"note"> }>]>();
    expect(refs.length).toBe(1);
  });
});
