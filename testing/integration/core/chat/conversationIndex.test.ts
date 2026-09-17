import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DateTime, RecordId } from "surrealdb";
import {
  ConversationIndex,
  hashConversationSummary,
} from "../../../../src/core/chat/conversationIndex";
import type { Conversation } from "../../../../src/core/chat/types";
import { isExactRecord, readSingleStatementRows } from "../../../../src/core/db/queryResult";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { createEmbeddingIdentity } from "../../../../src/core/llm/embeddingIdentity";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const secret = "conversation-memory-smoke-secret";

interface Fixture {
  tempDir: string;
  handle: SurrealServerHandle;
  connection: SurrealConnection;
  index: ConversationIndex;
}

let active: Fixture | null = null;

async function startFixture(): Promise<Fixture> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-conversation-memory-smoke-"));
  const handle = await startSurreal({
    dataDir: path.join(tempDir, "data"),
    secret,
    portFile: path.join(tempDir, "port"),
    pidFile: path.join(tempDir, "pid"),
    logLevel: "warn",
    hnswCacheMib: 64,
  });
  const connection = await connect({
    url: handle.url,
    user: "root",
    pass: secret,
    namespace: "notient",
    database: "vault",
  });
  await applySchema(connection.db, secret, { embedDim: 3, embedModel: "memory-model-a" });
  const index = new ConversationIndex({
    db: connection.db,
    identity: createEmbeddingIdentity("memory-model-a", 3),
  });
  const fixture = { tempDir, handle, connection, index };
  active = fixture;
  return fixture;
}

afterEach(async () => {
  if (active === null) return;
  const { tempDir, handle, connection } = active;
  active = null;
  await connection.close();
  await handle.stop();
  await rm(tempDir, { recursive: true, force: true });
}, 30_000);

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-a",
    notePath: "Notient/conversations/2026-08-29 semantic-memory.md",
    model: "reasoning-model",
    pinnedContext: [],
    approvalMode: "safe",
    topic: "Semantic memory",
    summary: "The notes connected filesystem evidence to a durable claim.",
    clientIdentity: "human",
    messageCount: 0,
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    ...overrides,
  };
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] ConversationIndex", () => {
  test("[smoke] stores fixed-width native vectors and searches them in SurrealDB", async () => {
    const { connection, index } = await startFixture();
    const first = conversation();
    const second = conversation({
      id: "conv-b",
      notePath: "Notient/conversations/2026-08-29 other.md",
      topic: "Other",
      summary: "An unrelated line of thought.",
      updatedAt: 3,
    });
    await index.record(first, new Float32Array([1, 0, 0]));
    await index.record(second, new Float32Array([0, 1, 0]));

    const rawRows: unknown = await connection.db
      .query(
        "SELECT id, conversation_id, client_identity, vector, embed_model, summary_hash, updated_at FROM conversation_memory ORDER BY conversation_id;",
      )
      .collect();
    const rows = readSingleStatementRows(rawRows, "conversation memory integration read");
    expect(rows).toHaveLength(2);
    const firstRow = rows[0];
    if (
      !isExactRecord(firstRow, [
        "id",
        "conversation_id",
        "client_identity",
        "vector",
        "embed_model",
        "summary_hash",
        "updated_at",
      ])
    ) {
      throw new Error("conversation memory integration row did not have the exact native shape");
    }
    if (!(firstRow.id instanceof RecordId)) {
      throw new Error("conversation memory id was not a native SurrealDB record id");
    }
    expect(firstRow.id.toString()).toBe(new RecordId("conversation_memory", "conv-a").toString());
    expect(firstRow.conversation_id).toBe("conv-a");
    expect(firstRow.client_identity).toBe("human");
    expect(firstRow.vector).toEqual([1, 0, 0]);
    expect(firstRow.embed_model).toBe("memory-model-a");
    expect(firstRow.summary_hash).toBe(await hashConversationSummary(first.summary));
    expect(firstRow.updated_at).toBeInstanceOf(DateTime);
    if (!(firstRow.updated_at instanceof DateTime)) {
      throw new Error("conversation memory updated_at was not a native SurrealDB datetime");
    }
    expect(firstRow.updated_at.toDate().getTime()).toBe(first.updatedAt);

    const matches = await index.search(new Float32Array([1, 0, 0]), {
      k: 1,
      threshold: 0.8,
      clientIdentity: "human",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.entry.id).toBe("conv-a");
    expect(matches[0]?.similarity).toBeCloseTo(1, 6);

    await expect(
      connection.db.query("UPDATE conversation_memory:conv-a SET vector = [1.0, 0.0];").collect(),
    ).rejects.toThrow();
    await expect(
      connection.db
        .query("UPDATE $recordId SET updated_at = $updatedAt RETURN NONE;", {
          recordId: new RecordId("conversation_memory", "conv-a"),
          updatedAt: 1,
        })
        .collect(),
    ).rejects.toThrow();
  }, 30_000);

  test("[smoke] removes stale memory on failed re-embedding and retains exact unchanged memory", async () => {
    const { index } = await startFixture();
    const original = conversation();
    await index.record(original, new Float32Array([1, 0, 0]));

    await index.record({ ...original, topic: "Renamed", updatedAt: 4 }, null);
    expect((await index.list())[0]).toMatchObject({ topic: "Renamed", updatedAt: 4 });

    await index.record({ ...original, summary: "A new canonical summary.", updatedAt: 5 }, null);
    expect(await index.list()).toEqual([]);
  }, 30_000);

  test("[smoke] an embedding-space change deletes conversation vectors before schema redefinition", async () => {
    const { connection, index } = await startFixture();
    await index.record(conversation(), new Float32Array([1, 0, 0]));

    const swapped = await applySchema(connection.db, secret, {
      embedDim: 5,
      embedModel: "memory-model-b",
      log: () => {},
    });

    expect(swapped.vectorsInvalidated).toBe(true);
    const rawRows: unknown = await connection.db
      .query("SELECT * FROM conversation_memory;")
      .collect();
    const rows = readSingleStatementRows(rawRows, "conversation memory invalidation read");
    expect(rows).toEqual([]);
  }, 30_000);
});
