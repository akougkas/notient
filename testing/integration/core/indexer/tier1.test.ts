import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  lookupNoteByPath,
  recordDaemonWrite,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { prepareNoteRow, runTier1 } from "../../../../src/core/indexer/tier1";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

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

    await upsertNoteByPath(connection.db, { path: otherPath, sha: "other-sha", wordCount: 1 });
    await upsertNoteByPath(connection.db, { path: alsoPath, sha: "also-sha", wordCount: 1 });
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

  test("inserts blocks including one with block_id = 'para-1'", async () => {
    const result = await runTier1(connection.db, {
      notePath: activePath,
      source: fixtureNote,
      vaultPaths,
      bus: new EventBus(),
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

  test("persists an H6 heading as level 6 end to end", async () => {
    const deepPath = "notes/deep-heading.md";
    const result = await runTier1(connection.db, {
      notePath: deepPath,
      source: "# Root\n\n###### Deep truth\n\nThis note keeps its full depth.\n",
      vaultPaths: [...vaultPaths, deepPath],
      bus: new EventBus(),
    });
    const [blocks] = await connection.db
      .query<[Array<{ heading_level?: number; heading_slug?: string }>]>(
        "SELECT heading_level, heading_slug FROM block WHERE note = $note AND heading_slug = 'deep-truth';",
        { note: result.noteId },
      )
      .collect<[Array<{ heading_level?: number; heading_slug?: string }>]>();

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.heading_level).toBe(6);
  });

  test("note.sha equals sha-256 of the raw file body (frontmatter included)", async () => {
    // The body-SHA contract is shared with `daemon/watcher.ts#sha256Body`
    // and `ApprovalService.hash`. All three producers hash the same bytes
    // so Tier 1's `findRecentDaemonWrite` cross-reference can attribute
    // approved writes to the originating agent.
    const [rows] = await connection.db
      .query<[Array<{ sha: string }>]>("SELECT sha FROM note WHERE path = $path;", {
        path: activePath,
      })
      .collect<[Array<{ sha: string }>]>();
    expect(rows.length).toBe(1);
    expect(rows[0].sha).toBe(sha256Hex(fixtureNote));
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

  test("reuses a single tag row when one note repeats the same tag", async () => {
    const duplicatePath = "notes/duplicate-tags.md";
    const duplicateFixture = `# Duplicate Tags

First mention #dupe and second mention #dupe.
`;

    const result = await runTier1(connection.db, {
      notePath: duplicatePath,
      source: duplicateFixture,
      vaultPaths: [...vaultPaths, duplicatePath],
      bus: new EventBus(),
    });

    const [tagRows] = await connection.db
      .query<[Array<{ path: string }>]>("SELECT path FROM tag WHERE path = 'dupe';")
      .collect<[Array<{ path: string }>]>();
    expect(tagRows.length).toBe(1);

    const [edgeRows] = await connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM tagged WHERE out IN (SELECT VALUE id FROM tag WHERE path = 'dupe') AND (in = $note OR in.note = $note) GROUP ALL;",
        { note: result.noteId },
      )
      .collect<[Array<{ count: number }>]>();
    expect(edgeRows[0]?.count ?? 0).toBe(2);
  });

  test("stores Unicode and emoji tags under one case-insensitive identity", async () => {
    const unicodePath = "notes/unicode-tags.md";
    const source =
      '---\ntags: ["#Café"]\n---\n# Reading #📚Books\n\nNotes on #café, #日本語 and #emoji✨. \\#escaped #2024\n';
    const result = await runTier1(connection.db, {
      notePath: unicodePath,
      source,
      vaultPaths: [...vaultPaths, unicodePath],
      bus: new EventBus(),
    });
    const [rows] = await connection.db
      .query<[Array<{ path: string }>]>(
        "SELECT VALUE out.path AS path FROM tagged WHERE in = $note OR in.note = $note;",
        { note: result.noteId },
      )
      .collect<[Array<{ path: string }>]>();
    expect([...new Set(rows as unknown as string[])].sort()).toEqual(
      ["café", "emoji✨", "日本語", "📚books"].sort(),
    );
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
      bus: new EventBus(),
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

  test("rolls back the entire transaction when a tag CREATE violates the schema", async () => {
    // Parser and storage share one tag grammar, so force a storage refusal for
    // this run only and restore the managed definition afterwards.
    await connection.db
      .query("DEFINE FIELD OVERWRITE path ON tag TYPE string ASSERT $value != '_badtag';")
      .collect();
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
        bus: new EventBus(),
      });
    } catch {
      threwError = true;
    } finally {
      await applySchema(connection.db, secret, { embedDim: 768, embedModel: "fixture-embedding" });
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

describe.skipIf(!SMOKE_ENABLED)("[smoke] Tier 1 daemon_write source override", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "tier1-daemon-override-secret";
  const activePath = "notes/source/active.md";
  const targetPath = "notes/source/target.md";
  const otherTargetPath = "notes/source/other.md";
  const vaultPaths = [activePath, targetPath, otherTargetPath];

  // The fixture body has a single body wikilink to `target` so the test can
  // assert exactly one wikilink edge per run. The frontmatter is omitted to
  // avoid frontmatter_ref noise.
  const sourceWithTargetLink = `# Heading

A paragraph that links to [[target]] and nothing else.
`;
  const sourceWithDifferentBody = `# Heading

A paragraph that links to [[target]] but the body has more text now.
`;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-tier1-daemon-"));
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
    await upsertNoteByPath(connection.db, {
      path: targetPath,
      sha: "target-sha",
      wordCount: 1,
    });
    await upsertNoteByPath(connection.db, {
      path: otherTargetPath,
      sha: "other-sha",
      wordCount: 1,
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

  async function fetchSingleWikilinkProvenance(
    noteId: RecordId<"note">,
  ): Promise<{ source: string; agent?: string }> {
    const [rows] = await connection.db
      .query<[Array<{ source: string; agent?: string }>]>(
        "SELECT source, agent FROM wikilink WHERE in.note = $note;",
        { note: noteId },
      )
      .collect<[Array<{ source: string; agent?: string }>]>();
    expect(rows.length).toBe(1);
    return rows[0];
  }

  async function fetchActiveNoteSha(noteId: RecordId<"note">): Promise<string> {
    const [rows] = await connection.db
      .query<[Array<{ sha: string }>]>("SELECT sha FROM note WHERE id = $id;", { id: noteId })
      .collect<[Array<{ sha: string }>]>();
    expect(rows.length).toBe(1);
    return rows[0].sha;
  }

  test("wikilink edge has source='wikilink' when no daemon_write row matches", async () => {
    const result = await runTier1(connection.db, {
      notePath: activePath,
      source: sourceWithTargetLink,
      vaultPaths,
      bus: new EventBus(),
    });
    const provenance = await fetchSingleWikilinkProvenance(result.noteId);
    expect(provenance).toEqual({ source: "wikilink", agent: undefined });
  });

  test("wikilink keeps canonical source and attributes an arbitrary MCP client", async () => {
    const noteId = await lookupNoteByPath(connection.db, activePath);
    expect(noteId).not.toBeNull();
    if (noteId === null) return;
    const targetId = await lookupNoteByPath(connection.db, targetPath);
    expect(targetId).not.toBeNull();
    if (targetId === null) return;
    const currentSha = await fetchActiveNoteSha(noteId);

    await recordDaemonWrite(connection.db, {
      noteId,
      sha: currentSha,
      agent: "claude-code",
      targets: [targetId],
    });

    await runTier1(connection.db, {
      notePath: activePath,
      source: sourceWithTargetLink,
      vaultPaths,
      bus: new EventBus(),
    });

    const provenance = await fetchSingleWikilinkProvenance(noteId);
    expect(provenance).toEqual({ source: "wikilink", agent: "claude-code" });
  });

  test("wikilink keeps source='wikilink' when daemon_write targets do not include the link target (sha collision alone is insufficient)", async () => {
    const noteId = await lookupNoteByPath(connection.db, activePath);
    expect(noteId).not.toBeNull();
    if (noteId === null) return;
    const otherTargetId = await lookupNoteByPath(connection.db, otherTargetPath);
    expect(otherTargetId).not.toBeNull();
    if (otherTargetId === null) return;
    const currentSha = await fetchActiveNoteSha(noteId);

    // Wipe any prior daemon_write rows for this note so the test stands alone.
    await connection.db
      .query("DELETE daemon_write WHERE note = $note;", { note: noteId })
      .collect();

    await recordDaemonWrite(connection.db, {
      noteId,
      sha: currentSha,
      agent: "linker",
      targets: [otherTargetId],
    });

    await runTier1(connection.db, {
      notePath: activePath,
      source: sourceWithTargetLink,
      vaultPaths,
      bus: new EventBus(),
    });

    const provenance = await fetchSingleWikilinkProvenance(noteId);
    expect(provenance).toEqual({ source: "wikilink", agent: undefined });
  });

  test("wikilink keeps source='wikilink' when daemon_write sha differs from the current body sha", async () => {
    const noteId = await lookupNoteByPath(connection.db, activePath);
    expect(noteId).not.toBeNull();
    if (noteId === null) return;
    const targetId = await lookupNoteByPath(connection.db, targetPath);
    expect(targetId).not.toBeNull();
    if (targetId === null) return;

    await connection.db
      .query("DELETE daemon_write WHERE note = $note;", { note: noteId })
      .collect();

    // Insert a daemon_write tagged at the previous body sha. Then re-index
    // the note with a different body so the current sha changes.
    const previousSha = await fetchActiveNoteSha(noteId);
    await recordDaemonWrite(connection.db, {
      noteId,
      sha: previousSha,
      agent: "linker",
      targets: [targetId],
    });

    await runTier1(connection.db, {
      notePath: activePath,
      source: sourceWithDifferentBody,
      vaultPaths,
      bus: new EventBus(),
    });
    const newSha = await fetchActiveNoteSha(noteId);
    expect(newSha).not.toBe(previousSha);

    const provenance = await fetchSingleWikilinkProvenance(noteId);
    expect(provenance).toEqual({ source: "wikilink", agent: undefined });
  });
});

describe.skipIf(!SMOKE_ENABLED)("[smoke] Tier 1 idempotent re-run cleanup", () => {
  // Regression harness for the orphan-block leak that surfaced when
  // `awaken --tier 1` was run twice over the same vault. The earlier
  // re-run test in this file shares state with prior tests and only
  // asserts a count delta; here we run on an isolated database, sweep
  // a multi-paragraph note repeatedly, and assert that block and
  // `contained_in` counts stay flat across passes.
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "tier1-rerun-secret";
  const activePath = "notes/rerun.md";
  const peerPath = "notes/rerun-peer.md";
  const vaultPaths = [activePath, peerPath];

  const fixture = `# Heading

First paragraph with [[rerun-peer]] and a #topic/sub tag.

Second paragraph that stands alone.

Third paragraph anchors the note. ^anchor-1
`;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-tier1-rerun-"));
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
    await upsertNoteByPath(connection.db, {
      path: peerPath,
      sha: "peer-sha",
      wordCount: 1,
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

  async function countBlocksForNote(noteId: RecordId<"note">): Promise<number> {
    const [rows] = await connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM block WHERE note = $note GROUP ALL;",
        { note: noteId },
      )
      .collect<[Array<{ count: number }>]>();
    return rows[0]?.count ?? 0;
  }

  async function countContainedInForNote(noteId: RecordId<"note">): Promise<number> {
    const [rows] = await connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM contained_in WHERE in.note = $note GROUP ALL;",
        { note: noteId },
      )
      .collect<[Array<{ count: number }>]>();
    return rows[0]?.count ?? 0;
  }

  test("block and contained_in counts stay stable across three re-runs", async () => {
    const first = await runTier1(connection.db, {
      notePath: activePath,
      source: fixture,
      vaultPaths,
      bus: new EventBus(),
    });
    const expectedBlocks = first.extraction.blocks.length;
    expect(expectedBlocks).toBeGreaterThan(1);

    const blocksAfterFirst = await countBlocksForNote(first.noteId);
    const containedAfterFirst = await countContainedInForNote(first.noteId);
    expect(blocksAfterFirst).toBe(expectedBlocks);
    expect(containedAfterFirst).toBe(expectedBlocks);

    await runTier1(connection.db, {
      notePath: activePath,
      source: fixture,
      vaultPaths,
      bus: new EventBus(),
    });
    const blocksAfterSecond = await countBlocksForNote(first.noteId);
    const containedAfterSecond = await countContainedInForNote(first.noteId);
    expect(blocksAfterSecond).toBe(expectedBlocks);
    expect(containedAfterSecond).toBe(expectedBlocks);

    await runTier1(connection.db, {
      notePath: activePath,
      source: fixture,
      vaultPaths,
      bus: new EventBus(),
    });
    const blocksAfterThird = await countBlocksForNote(first.noteId);
    const containedAfterThird = await countContainedInForNote(first.noteId);
    expect(blocksAfterThird).toBe(expectedBlocks);
    expect(containedAfterThird).toBe(expectedBlocks);
  });
});

describe.skipIf(!SMOKE_ENABLED)(
  "[smoke] Tier 1 daemon_write source override on frontmatter_ref",
  () => {
    // Regression for the linker writeback attribution gap. Phase 4 writes a
    // wikilink under `frontmatter.notient.<key>` and records a `daemon_write`
    // row whose `targets` includes the resolved target. Tier 1 then re-runs
    // over the new body, the frontmatter wikilink resolves to the target,
    // and the resulting `frontmatter_ref` edge must inherit the agent name
    // from the matching `daemon_write` row instead of the default
    // `'frontmatter'` literal.
    let tempDir: string;
    let handle: SurrealServerHandle;
    let connection: SurrealConnection;
    const secret = "tier1-frontmatter-override-secret";
    const activePath = "notes/frontmatter/active.md";
    const targetPath = "notes/frontmatter/target.md";
    const otherTargetPath = "notes/frontmatter/other.md";
    const vaultPaths = [activePath, targetPath, otherTargetPath];

    // The fixture seeds `notient.supports: [[target]]` in the frontmatter to
    // mirror the linker writeback shape. The body has no wikilinks so the
    // single edge under test is the frontmatter_ref to `target`.
    const sourceWithFrontmatterSupports = [
      "---",
      "notient:",
      "  supports:",
      '    - "[[target]]"',
      "---",
      "",
      "# Heading",
      "",
      "Body without wikilinks.",
      "",
    ].join("\n");

    beforeAll(async () => {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-tier1-frontmatter-"));
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
      await upsertNoteByPath(connection.db, {
        path: targetPath,
        sha: "target-sha",
        wordCount: 1,
      });
      await upsertNoteByPath(connection.db, {
        path: otherTargetPath,
        sha: "other-sha",
        wordCount: 1,
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

    async function fetchSingleFrontmatterRefProvenance(
      noteId: RecordId<"note">,
    ): Promise<{ source: string; agent?: string }> {
      const [rows] = await connection.db
        .query<[Array<{ source: string; agent?: string }>]>(
          "SELECT source, agent FROM frontmatter_ref WHERE in = $note;",
          { note: noteId },
        )
        .collect<[Array<{ source: string; agent?: string }>]>();
      expect(rows.length).toBe(1);
      return rows[0];
    }

    async function fetchActiveNoteSha(noteId: RecordId<"note">): Promise<string> {
      const [rows] = await connection.db
        .query<[Array<{ sha: string }>]>("SELECT sha FROM note WHERE id = $id;", { id: noteId })
        .collect<[Array<{ sha: string }>]>();
      expect(rows.length).toBe(1);
      return rows[0].sha;
    }

    test("frontmatter_ref keeps canonical source and attributes the daemon client", async () => {
      // Seed the active note via Tier 1 first so a record id and sha exist
      // for the daemon_write row to reference.
      const seeded = await runTier1(connection.db, {
        notePath: activePath,
        source: sourceWithFrontmatterSupports,
        vaultPaths,
        bus: new EventBus(),
      });
      const noteId = seeded.noteId;
      const targetId = await lookupNoteByPath(connection.db, targetPath);
      expect(targetId).not.toBeNull();
      if (targetId === null) return;
      const currentSha = await fetchActiveNoteSha(noteId);

      await connection.db
        .query("DELETE daemon_write WHERE note = $note;", { note: noteId })
        .collect();
      await recordDaemonWrite(connection.db, {
        noteId,
        sha: currentSha,
        agent: "claude-code",
        targets: [targetId],
      });

      await runTier1(connection.db, {
        notePath: activePath,
        source: sourceWithFrontmatterSupports,
        vaultPaths,
        bus: new EventBus(),
      });

      const provenance = await fetchSingleFrontmatterRefProvenance(noteId);
      expect(provenance).toEqual({ source: "frontmatter", agent: "claude-code" });
    });

    test("frontmatter_ref keeps source='frontmatter' when daemon_write targets do not include the resolved target", async () => {
      const noteId = await lookupNoteByPath(connection.db, activePath);
      expect(noteId).not.toBeNull();
      if (noteId === null) return;
      const otherTargetId = await lookupNoteByPath(connection.db, otherTargetPath);
      expect(otherTargetId).not.toBeNull();
      if (otherTargetId === null) return;
      const currentSha = await fetchActiveNoteSha(noteId);

      await connection.db
        .query("DELETE daemon_write WHERE note = $note;", { note: noteId })
        .collect();
      await recordDaemonWrite(connection.db, {
        noteId,
        sha: currentSha,
        agent: "linker",
        targets: [otherTargetId],
      });

      await runTier1(connection.db, {
        notePath: activePath,
        source: sourceWithFrontmatterSupports,
        vaultPaths,
        bus: new EventBus(),
      });

      const provenance = await fetchSingleFrontmatterRefProvenance(noteId);
      expect(provenance).toEqual({ source: "frontmatter", agent: undefined });
    });
  },
);
