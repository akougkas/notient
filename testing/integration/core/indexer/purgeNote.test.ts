import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { ApprovalService } from "../../../../src/core/approvals/approvalService";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  replaceBlocks,
  replaceChunks,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { makeExclusionPredicate } from "../../../../src/core/indexer/excludePaths";
import { purgeExcludedNotes, tombstoneNoteById } from "../../../../src/core/indexer/purgeNote";
import type { BlockSpec } from "../../../../src/core/markdown/types";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const VECTOR_DIM = 768;
const EMBEDDING_IDENTITY = { model: "purge-fixture", dimension: VECTOR_DIM } as const;
const NO_APPROVAL_CANCELLATION = {
  cancelForNoteDeletion: async () => ({ cancelled: 0, failed: 0 }),
};

function block(ord: number, text: string): BlockSpec {
  return {
    blockId: null,
    headingLevel: null,
    headingPath: [],
    headingSlug: null,
    ord,
    startLine: ord,
    endLine: ord,
    text,
  };
}

async function countWhereNote(
  connection: SurrealConnection,
  table: "block" | "chunk",
  noteId: RecordId<"note">,
): Promise<number> {
  const [rows] = await connection.db
    .query<[Array<{ id: RecordId }>]>(`SELECT id FROM ${table} WHERE note = $note;`, {
      note: noteId,
    })
    .collect<[Array<{ id: RecordId }>]>();
  return rows.length;
}

async function noteExists(connection: SurrealConnection, notePath: string): Promise<boolean> {
  const [rows] = await connection.db
    .query<[Array<{ id: RecordId<"note"> }>]>("SELECT id FROM note WHERE path = $path;", {
      path: notePath,
    })
    .collect<[Array<{ id: RecordId<"note"> }>]>();
  return rows.length > 0;
}

async function countRecord(
  connection: SurrealConnection,
  table: "approval_intent" | "supports",
  id: RecordId,
): Promise<number> {
  const [rows] = await connection.db
    .query<[Array<{ id: RecordId }>]>(`SELECT id FROM ${table} WHERE id = $id;`, { id })
    .collect<[Array<{ id: RecordId }>]>();
  return rows.length;
}

async function seedActiveApprovalIntent(
  connection: SurrealConnection,
  sourceNote: RecordId<"note">,
  targetNote: RecordId<"note">,
  sourcePath: string,
  targetPath: string,
): Promise<{
  edgeId: RecordId<"supports">;
  intentId: RecordId<"approval_intent">;
}> {
  const [edges] = await connection.db
    .query<[Array<{ id: RecordId<"supports">; created_at: unknown }>]>(
      "RELATE $source->supports->$target SET source = 'linker', class = 'INFERRED', confidence = 0.8, agent = 'linker', approved = true, applied = false, approved_by = 'human' RETURN id, created_at;",
      { source: sourceNote, target: targetNote },
    )
    .collect<[Array<{ id: RecordId<"supports">; created_at: unknown }>]>();
  const edge = edges[0];
  if (edge === undefined) throw new Error("failed to seed approval-intent edge");

  const intentId = createUuidRecordId("approval_intent");
  const historyId = createUuidRecordId("history");
  await connection.db
    .query(
      `CREATE ONLY $intentId CONTENT {
  edge: $edgeId,
  table_name: 'supports',
  edge_created_at: $edgeCreatedAt,
  source_note: $sourceNote,
  target_note: $targetNote,
  source_path: $sourcePath,
  target_path: $targetPath,
  kind: 'note.append_section',
  before_body: '# Before',
  after_body: '# Before\\n\\n## Related\\n\\n- [[$targetPath]]\\n',
  before_sha: $beforeSha,
  after_sha: $afterSha,
  history_id: $historyId,
  approved_by: 'human',
  producer: 'linker'
};`,
      {
        intentId,
        edgeId: edge.id,
        edgeCreatedAt: edge.created_at,
        sourceNote,
        targetNote,
        sourcePath,
        targetPath,
        beforeSha: "a".repeat(64),
        afterSha: "b".repeat(64),
        historyId,
      },
    )
    .collect();
  return { edgeId: edge.id, intentId };
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] purgeExcludedNotes", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "purge-excluded-smoke-secret";
  const excludedPath = "nOtIeNt/CoNvErSaTiOnS/2026-08-28 chat.md";
  const keptPath = "notes/keeper.md";
  let excludedId: RecordId<"note">;
  let keptId: RecordId<"note">;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-purge-smoke-"));
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

    excludedId = await upsertNoteByPath(connection.db, {
      path: excludedPath,
      sha: "excluded-sha",
      wordCount: 3,
    });
    keptId = await upsertNoteByPath(connection.db, {
      path: keptPath,
      sha: "kept-sha",
      wordCount: 3,
    });
    for (const [noteId, text] of [
      [excludedId, "transcript body"],
      [keptId, "keeper body"],
    ] as const) {
      await replaceBlocks(connection.db, noteId, [block(0, text)]);
      await replaceChunks(connection.db, noteId, EMBEDDING_IDENTITY, [
        {
          ord: 0,
          text,
          tokenEstimate: 2,
          vector: new Array<number>(VECTOR_DIM).fill(0.1),
        },
      ]);
    }
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

  test("[smoke] an active approval intent blocks purge without deleting graph state", async () => {
    const active = await seedActiveApprovalIntent(
      connection,
      excludedId,
      keptId,
      excludedPath,
      keptPath,
    );
    const isExcluded = makeExclusionPredicate({
      excludePaths: [],
      excludeGlobs: [],
    });

    try {
      await expect(
        purgeExcludedNotes(connection, isExcluded, NO_APPROVAL_CANCELLATION),
      ).rejects.toThrow("still has an active approval cancellation");

      expect(await noteExists(connection, excludedPath)).toBe(true);
      expect(await countWhereNote(connection, "block", excludedId)).toBe(1);
      expect(await countWhereNote(connection, "chunk", excludedId)).toBe(1);
      expect(await countRecord(connection, "supports", active.edgeId)).toBe(1);
      expect(await countRecord(connection, "approval_intent", active.intentId)).toBe(1);
    } finally {
      await connection.db
        .query("DELETE $intentId; DELETE $edgeId;", {
          intentId: active.intentId,
          edgeId: active.edgeId,
        })
        .collect();
    }
  });

  test("[smoke] a stale deletion generation cannot re-tombstone or cancel approvals", async () => {
    const active = await seedActiveApprovalIntent(
      connection,
      excludedId,
      keptId,
      excludedPath,
      keptPath,
    );
    const deletionToken = await tombstoneNoteById(connection, excludedId);
    if (deletionToken === null) throw new Error("test setup: excluded note disappeared");
    await connection.db
      .query("UPDATE $note SET tombstoned_at = NONE;", { note: excludedId })
      .collect();
    const service = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vault: {
        read: async () => {
          throw new Error("stale cancellation must not read the vault");
        },
        writeIfUnchanged: async () => {
          throw new Error("stale cancellation must not write the vault");
        },
      },
      hash: async () => {
        throw new Error("stale cancellation must not hash vault bytes");
      },
      pruneHistory: async () => {},
    });

    try {
      await expect(service.cancelForNoteDeletion(excludedId, deletionToken)).rejects.toThrow(
        "deletion generation is stale",
      );
      const [notes] = await connection.db
        .query<[Array<{ tombstoned_at?: unknown }>]>(
          "SELECT tombstoned_at FROM note WHERE id = $note;",
          { note: excludedId },
        )
        .collect<[Array<{ tombstoned_at?: unknown }>]>();
      const [intents] = await connection.db
        .query<[Array<{ cancel_requested_at?: unknown }>]>(
          "SELECT cancel_requested_at FROM approval_intent WHERE id = $intent;",
          { intent: active.intentId },
        )
        .collect<[Array<{ cancel_requested_at?: unknown }>]>();
      expect(notes[0]?.tombstoned_at).toBeUndefined();
      expect(intents[0]?.cancel_requested_at).toBeUndefined();
      expect(await countRecord(connection, "supports", active.edgeId)).toBe(1);
    } finally {
      await connection.db
        .query("DELETE $intentId; DELETE $edgeId;", {
          intentId: active.intentId,
          edgeId: active.edgeId,
        })
        .collect();
    }
  });

  test("[smoke] purges the excluded note with its blocks and chunks, keeps the rest", async () => {
    expect(await countWhereNote(connection, "block", excludedId)).toBe(1);
    expect(await countWhereNote(connection, "chunk", excludedId)).toBe(1);

    const isExcluded = makeExclusionPredicate({ excludePaths: [], excludeGlobs: [] });
    const purged = await purgeExcludedNotes(connection, isExcluded, NO_APPROVAL_CANCELLATION);

    expect(purged).toEqual([excludedPath]);
    expect(await noteExists(connection, excludedPath)).toBe(false);
    expect(await countWhereNote(connection, "block", excludedId)).toBe(0);
    expect(await countWhereNote(connection, "chunk", excludedId)).toBe(0);

    expect(await noteExists(connection, keptPath)).toBe(true);
    expect(await countWhereNote(connection, "block", keptId)).toBe(1);
    expect(await countWhereNote(connection, "chunk", keptId)).toBe(1);
  });

  test("[smoke] a second run is a no-op", async () => {
    const purged = await purgeExcludedNotes(
      connection,
      makeExclusionPredicate({ excludePaths: [], excludeGlobs: [] }),
      NO_APPROVAL_CANCELLATION,
    );
    expect(purged).toEqual([]);
    expect(await noteExists(connection, keptPath)).toBe(true);
  });
});
