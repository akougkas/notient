import { describe, expect, test } from "bun:test";
import { DateTime, RecordId, type Surreal } from "surrealdb";
import {
  ConversationIndex,
  ConversationMemoryIntegrityError,
  hashConversationSummary,
} from "../../../../src/core/chat/conversationIndex";
import type { Conversation } from "../../../../src/core/chat/types";
import { createEmbeddingIdentity } from "../../../../src/core/llm/embeddingIdentity";

interface StoredMemory {
  id: RecordId<"conversation_memory">;
  conversation_id: unknown;
  path: unknown;
  topic: unknown;
  client_identity: unknown;
  updated_at: unknown;
  summary_hash: unknown;
  embed_model: unknown;
  vector: unknown;
}

class InMemorySurreal {
  readonly rows = new Map<string, StoredMemory>();
  private readonly queuedResults: Array<{ value: unknown }> = [];

  respondOnce(value: unknown): void {
    this.queuedResults.push({ value });
  }

  asDb(): Surreal {
    return this as unknown as Surreal;
  }

  query(
    sql: string,
    bindings: Record<string, unknown> = {},
  ): {
    collect: () => Promise<unknown>;
  } {
    return { collect: async () => this.execute(sql, bindings) };
  }

  private execute(sql: string, bindings: Record<string, unknown>): unknown {
    const queued = this.queuedResults.shift();
    if (queued !== undefined) return queued.value;
    if (sql.startsWith("UPSERT $recordId CONTENT")) return this.upsert(bindings);
    if (sql === "DELETE conversation_memory RETURN NONE;") {
      this.rows.clear();
      return [[]];
    }
    if (sql === "DELETE $recordId RETURN NONE;") {
      this.rows.delete(readFakeRecordId(bindings.recordId, "recordId").toString());
      return [[]];
    }
    if (sql.startsWith("UPDATE $recordId SET path")) return this.update(bindings);
    return this.select(sql, bindings);
  }

  private upsert(bindings: Record<string, unknown>): unknown[][] {
    const recordId = readFakeRecordId(bindings.recordId, "recordId");
    this.rows.set(recordId.toString(), {
      id: recordId,
      conversation_id: bindings.conversationId,
      path: bindings.path,
      topic: bindings.topic,
      client_identity: bindings.clientIdentity,
      updated_at: bindings.updatedAt,
      summary_hash: bindings.summaryHash,
      embed_model: bindings.embedModel,
      vector: bindings.vector,
    });
    return [[]];
  }

  private update(bindings: Record<string, unknown>): unknown[][] {
    const row = this.rows.get(readFakeRecordId(bindings.recordId, "recordId").toString());
    if (row !== undefined) {
      row.path = bindings.path;
      row.topic = bindings.topic;
      row.client_identity = bindings.clientIdentity;
      row.updated_at = bindings.updatedAt;
    }
    return [[]];
  }

  private select(sql: string, bindings: Record<string, unknown>): unknown {
    if (sql.includes("FROM $recordId LIMIT 1")) {
      const row = this.rows.get(readFakeRecordId(bindings.recordId, "recordId").toString());
      return [row === undefined ? [] : [project(row)]];
    }
    if (sql.includes("FROM conversation_memory") && sql.includes("START $offset")) {
      const rows = sortedRows(this.rows)
        .filter((row) => row.client_identity === bindings.clientIdentity)
        .slice(readFakeSafeInteger(bindings.offset, "offset"))
        .map(project);
      return [rows];
    }
    if (sql.includes("vector::similarity::cosine")) return this.search(bindings);
    if (sql.includes("FROM conversation_memory") && sql.includes("ORDER BY updated_at DESC")) {
      return [sortedRows(this.rows).map(project)];
    }
    throw new Error(`unhandled fake Surreal query: ${sql}`);
  }

  private search(bindings: Record<string, unknown>): unknown {
    const query = readFakeNumberArray(bindings.query, "query");
    const model = readFakeString(bindings.embedModel, "embedModel");
    const clientIdentity = readFakeString(bindings.clientIdentity, "clientIdentity");
    const dimension = readFakeSafeInteger(bindings.dimension, "dimension");
    const threshold = readFakeFiniteNumber(bindings.threshold, "threshold");
    const limit = readFakeSafeInteger(bindings.limit, "limit");
    const rows = sortedRows(this.rows)
      .filter(
        (row) =>
          row.client_identity === clientIdentity &&
          row.embed_model === model &&
          Array.isArray(row.vector) &&
          row.vector.length === dimension,
      )
      .map((row) => ({
        ...project(row),
        similarity: cosine(readFakeNumberArray(row.vector, "stored vector"), query),
      }))
      .filter((row) => row.similarity >= threshold)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, limit);
    return [rows];
  }
}

function readFakeRecordId(raw: unknown, field: string): RecordId<"conversation_memory"> {
  if (!isFakeRecordId(raw)) throw new Error(`fake Surreal binding ${field} must be a RecordId`);
  return raw;
}

function isFakeRecordId(raw: unknown): raw is RecordId<"conversation_memory"> {
  return raw instanceof RecordId;
}

function readFakeString(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new Error(`fake Surreal binding ${field} must be a string`);
  return raw;
}

function readFakeSafeInteger(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`fake Surreal binding ${field} must be a non-negative safe integer`);
  }
  return raw;
}

function readFakeFiniteNumber(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`fake Surreal binding ${field} must be finite`);
  }
  return raw;
}

function readFakeNumberArray(raw: unknown, field: string): number[] {
  if (!Array.isArray(raw)) throw new Error(`fake Surreal binding ${field} must be an array`);
  return Array.from(raw, (value, index) => readFakeFiniteNumber(value, `${field}[${index}]`));
}

function project(row: StoredMemory): Record<string, unknown> {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    path: row.path,
    topic: row.topic,
    client_identity: row.client_identity,
    updated_at: row.updated_at,
    summary_hash: row.summary_hash,
    embed_model: row.embed_model,
    vector: row.vector,
    dimension: Array.isArray(row.vector) ? row.vector.length : null,
  };
}

function sortedRows(rows: Map<string, StoredMemory>): StoredMemory[] {
  return [...rows.values()].sort((left, right) => {
    const byUpdated = storedMilliseconds(right.updated_at) - storedMilliseconds(left.updated_at);
    if (byUpdated !== 0) return byUpdated;
    return String(left.conversation_id).localeCompare(String(right.conversation_id));
  });
}

function storedMilliseconds(raw: unknown): number {
  if (raw instanceof DateTime) return raw.toDate().getTime();
  return typeof raw === "number" ? raw : Number.NaN;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = a[index];
    const bv = b[index];
    if (av === undefined || bv === undefined) {
      throw new Error("fake Surreal cosine vectors must have equal dense dimensions");
    }
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? "conv";
  return {
    id,
    notePath: overrides.notePath ?? `Notient/conversations/2026-04-25 ${id}.md`,
    model: "reasoning-model",
    pinnedContext: [],
    approvalMode: "safe",
    topic: "Topic",
    summary: "A canonical summary",
    clientIdentity: "human",
    messageCount: 0,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    ...overrides,
  };
}

function makeIndex(
  fake: InMemorySurreal,
  overrides: { model?: string; dimension?: number | null; maxEntries?: number } = {},
): ConversationIndex {
  const dimension = overrides.dimension === undefined ? 3 : overrides.dimension;
  return new ConversationIndex({
    db: fake.asDb(),
    identity: createEmbeddingIdentity(overrides.model ?? "embed-model", dimension),
    ...(overrides.maxEntries === undefined ? {} : { maxEntries: overrides.maxEntries }),
  });
}

function projectedRow(
  id = "row",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: new RecordId("conversation_memory", id),
    conversation_id: id,
    path: `Notient/conversations/${id}.md`,
    topic: `Topic ${id}`,
    client_identity: "human",
    updated_at: new DateTime(new Date(1_000)),
    summary_hash: "a".repeat(64),
    embed_model: "embed-model",
    vector: [1, 0, 0],
    dimension: 3,
    ...overrides,
  };
}

function projectedSearchRow(
  id: string,
  similarity: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...projectedRow(id, overrides), similarity };
}

describe("ConversationIndex", () => {
  test("stores a native vector with exact model, summary hash, and canonical metadata", async () => {
    const fake = new InMemorySurreal();
    const index = makeIndex(fake);
    const conversation = makeConversation({ id: "c1", topic: "Hello", updatedAt: 1000 });

    await index.record(conversation, new Float32Array([1, 0, 0]));

    const [entry] = await index.list();
    expect(entry).toEqual({
      id: "c1",
      path: conversation.notePath,
      topic: "Hello",
      clientIdentity: "human",
      updatedAt: 1000,
      summaryHash: await hashConversationSummary(conversation.summary),
      embedModel: "embed-model",
      dimension: 3,
    });
    const stored = fake.rows.get("conversation_memory:c1");
    expect(stored?.vector).toEqual([1, 0, 0]);
    expect(stored?.updated_at).toBeInstanceOf(DateTime);
    if (!(stored?.updated_at instanceof DateTime)) {
      throw new Error("fake Surreal did not receive a native DateTime binding");
    }
    expect(stored.updated_at.toDate().getTime()).toBe(1000);
  });

  test("search returns database-scored top-K matches above the threshold", async () => {
    const fake = new InMemorySurreal();
    const index = makeIndex(fake);
    await index.record(makeConversation({ id: "near", updatedAt: 3 }), new Float32Array([1, 0, 0]));
    await index.record(
      makeConversation({ id: "mid", updatedAt: 2 }),
      new Float32Array([0.7, 0.7, 0]),
    );
    await index.record(makeConversation({ id: "far", updatedAt: 1 }), new Float32Array([0, 1, 0]));

    const results = await index.search(new Float32Array([1, 0, 0]), {
      k: 2,
      threshold: 0.5,
      clientIdentity: "human",
    });

    expect(results.map((result) => result.entry.id)).toEqual(["near", "mid"]);
    expect(results[0]?.similarity).toBeCloseTo(1, 5);
  });

  test("search and retention are isolated per conversation owner", async () => {
    const fake = new InMemorySurreal();
    const index = makeIndex(fake, { maxEntries: 1 });
    await index.record(
      makeConversation({ id: "human-old", clientIdentity: "human", updatedAt: 1 }),
      new Float32Array([1, 0, 0]),
    );
    await index.record(
      makeConversation({ id: "agent-old", clientIdentity: "agent-b", updatedAt: 2 }),
      new Float32Array([1, 0, 0]),
    );
    await index.record(
      makeConversation({ id: "human-new", clientIdentity: "human", updatedAt: 3 }),
      new Float32Array([1, 0, 0]),
    );
    await index.record(
      makeConversation({ id: "agent-new", clientIdentity: "agent-b", updatedAt: 4 }),
      new Float32Array([1, 0, 0]),
    );

    expect((await index.list()).map((entry) => entry.id)).toEqual(["agent-new", "human-new"]);
    const humanMatches = await index.search(new Float32Array([1, 0, 0]), {
      k: 5,
      threshold: 0,
      clientIdentity: "human",
    });
    expect(humanMatches.map((match) => match.entry.id)).toEqual(["human-new"]);
  });

  test("fails closed if storage returns a search row owned by another client", async () => {
    const fake = new InMemorySurreal();
    fake.respondOnce([[projectedSearchRow("cross-owner", 1, { client_identity: "agent-b" })]]);

    await expect(
      makeIndex(fake).search(new Float32Array([1, 0, 0]), {
        k: 1,
        threshold: 0,
        clientIdentity: "human",
      }),
    ).rejects.toThrow("owned by agent-b, expected human");
  });

  test("a failed embedding retains only an exact unchanged model/hash/width row", async () => {
    const fake = new InMemorySurreal();
    const index = makeIndex(fake);
    const original = makeConversation({ id: "same", updatedAt: 1 });
    await index.record(original, new Float32Array([1, 0, 0]));

    await index.record({ ...original, topic: "Renamed", updatedAt: 2 }, null);
    expect((await index.list())[0]).toMatchObject({ topic: "Renamed", updatedAt: 2 });

    await index.record({ ...original, summary: "Changed summary", updatedAt: 3 }, null);
    expect(await index.list()).toEqual([]);
  });

  test("reconcile deletes rows absent from or inconsistent with canonical Markdown", async () => {
    const fake = new InMemorySurreal();
    const index = makeIndex(fake);
    const kept = makeConversation({ id: "kept", topic: "Old topic", updatedAt: 1 });
    const changed = makeConversation({ id: "changed", summary: "Old summary", updatedAt: 1 });
    const removed = makeConversation({ id: "removed", updatedAt: 1 });
    await index.record(kept, new Float32Array([1, 0, 0]));
    await index.record(changed, new Float32Array([1, 0, 0]));
    await index.record(removed, new Float32Array([1, 0, 0]));

    await index.reconcile([
      { ...kept, topic: "Canonical topic", updatedAt: 4 },
      { ...changed, summary: "New summary", updatedAt: 5 },
    ]);

    expect(await index.list()).toEqual([
      expect.objectContaining({ id: "kept", topic: "Canonical topic", updatedAt: 4 }),
    ]);
  });

  test("an unresolved embedding identity clears memory and refuses search", async () => {
    const fake = new InMemorySurreal();
    const resolved = makeIndex(fake);
    await resolved.record(makeConversation(), new Float32Array([1, 0, 0]));
    const unresolved = makeIndex(fake, { dimension: null });

    await unresolved.reconcile([makeConversation()]);

    expect(await resolved.list()).toEqual([]);
    await expect(
      unresolved.search(new Float32Array([1, 0, 0]), {
        k: 1,
        threshold: 0,
        clientIdentity: "human",
      }),
    ).rejects.toThrow("no resolved dimension");
  });

  test("rejects wrong-width and non-finite vectors", async () => {
    const index = makeIndex(new InMemorySurreal());
    await expect(index.record(makeConversation(), new Float32Array([1, 0]))).rejects.toThrow(
      "width 2; expected 3",
    );
    await expect(
      index.record(makeConversation(), new Float32Array([1, Number.NaN, 0])),
    ).rejects.toThrow("non-finite");
    await expect(index.record(makeConversation(), new Float32Array([0, 0, 0]))).rejects.toThrow(
      "non-zero magnitude",
    );
    await expect(
      index.record(makeConversation(), [1, 0, 0] as unknown as Float32Array),
    ).rejects.toThrow("must be a Float32Array");
  });

  test("fails closed on a corrupt persisted row", async () => {
    const fake = new InMemorySurreal();
    const id = new RecordId("conversation_memory", "bad");
    fake.rows.set(id.toString(), {
      id,
      conversation_id: "bad",
      path: "Notient/conversations/bad.md",
      topic: "Bad",
      client_identity: "human",
      updated_at: new DateTime(new Date(1)),
      summary_hash: "not-a-hash",
      embed_model: "embed-model",
      vector: [1, 0, 0],
    });

    await expect(makeIndex(fake).list()).rejects.toBeInstanceOf(ConversationMemoryIntegrityError);
  });

  test("evicts the oldest semantic rows beyond the configured cap", async () => {
    const fake = new InMemorySurreal();
    const index = makeIndex(fake, { maxEntries: 2 });
    await index.record(makeConversation({ id: "old", updatedAt: 1 }), new Float32Array([1, 0, 0]));
    await index.record(makeConversation({ id: "mid", updatedAt: 2 }), new Float32Array([1, 0, 0]));
    await index.record(makeConversation({ id: "new", updatedAt: 3 }), new Float32Array([1, 0, 0]));

    expect((await index.list()).map((entry) => entry.id)).toEqual(["new", "mid"]);
  });

  test("rejects malformed SurrealDB result envelopes", async () => {
    const invalidEnvelopes: unknown[] = [null, [], [[], []], [{}], [null]];

    for (const envelope of invalidEnvelopes) {
      const fake = new InMemorySurreal();
      fake.respondOnce(envelope);
      await expect(makeIndex(fake).list()).rejects.toThrow(
        "invalid single-statement result envelope",
      );
    }
  });

  test("requires RETURN NONE mutations and verifies the persisted write", async () => {
    const mutationFake = new InMemorySurreal();
    mutationFake.respondOnce([[projectedRow("unexpected")]]);
    await expect(makeIndex(mutationFake).remove("unexpected")).rejects.toThrow(
      "returned rows for a RETURN NONE mutation",
    );

    const missingWriteFake = new InMemorySurreal();
    missingWriteFake.respondOnce([[]]);
    await expect(
      makeIndex(missingWriteFake).record(
        makeConversation({ id: "unwritten" }),
        new Float32Array([1, 0, 0]),
      ),
    ).rejects.toThrow("upsert did not persist the requested row");
  });

  test("requires exact projected row keys", async () => {
    const extraKeyFake = new InMemorySurreal();
    extraKeyFake.respondOnce([[{ ...projectedRow("extra"), legacy_embedding: "forbidden" }]]);
    await expect(makeIndex(extraKeyFake).list()).rejects.toThrow("must contain exactly");

    const missingKeyFake = new InMemorySurreal();
    const missingTopic = projectedRow("missing");
    Reflect.deleteProperty(missingTopic, "topic");
    missingKeyFake.respondOnce([[missingTopic]]);
    await expect(makeIndex(missingKeyFake).list()).rejects.toThrow("must contain exactly");
  });

  test("rejects forged native values and invalid stored numeric domains", async () => {
    const corruptions: Array<{ row: Record<string, unknown>; message: string }> = [
      {
        row: projectedRow("string-id", { id: "conversation_memory:string-id" }),
        message: "must be the native conversation_memory record",
      },
      {
        row: projectedRow("integer-time", { updated_at: 1_000 }),
        message: "must be a native SurrealDB datetime",
      },
      {
        row: projectedRow("negative-time", { updated_at: new DateTime(new Date(-1)) }),
        message: "must be a valid non-negative datetime",
      },
      {
        row: projectedRow("fractional-dimension", { dimension: 2.5 }),
        message: "must be a positive safe integer",
      },
      {
        row: projectedRow("unsafe-dimension", { dimension: Number.MAX_SAFE_INTEGER + 1 }),
        message: "must be a positive safe integer",
      },
      {
        row: projectedRow("nan-vector", { vector: [1, Number.NaN, 0] }),
        message: "must be finite",
      },
      {
        row: projectedRow("infinite-vector", { vector: [1, Number.POSITIVE_INFINITY, 0] }),
        message: "must be finite",
      },
      {
        row: projectedRow("zero-vector", { vector: [0, 0, 0] }),
        message: "must have non-zero magnitude",
      },
      {
        row: projectedRow("wrong-width", { vector: [1, 0], dimension: 3 }),
        message: "does not match native vector width",
      },
    ];

    for (const corruption of corruptions) {
      const fake = new InMemorySurreal();
      fake.respondOnce([[corruption.row]]);
      await expect(makeIndex(fake).list()).rejects.toThrow(corruption.message);
    }
  });

  test("rejects rows outside the boot-resolved embedding space", async () => {
    const wrongModelFake = new InMemorySurreal();
    wrongModelFake.respondOnce([[projectedRow("wrong-model", { embed_model: "retired-model" })]]);
    await expect(makeIndex(wrongModelFake).list()).rejects.toThrow(
      "belongs to embedding model retired-model, expected embed-model",
    );

    const wrongDimensionFake = new InMemorySurreal();
    wrongDimensionFake.respondOnce([
      [projectedRow("wrong-dimension", { vector: [1, 0], dimension: 2 })],
    ]);
    await expect(makeIndex(wrongDimensionFake).list()).rejects.toThrow(
      "has vector dimension 2, expected 3",
    );
  });

  test("reconcile deletes well-formed rows from a retired embedding model", async () => {
    const fake = new InMemorySurreal();
    const canonical = makeConversation({ id: "stale-model" });
    const id = new RecordId("conversation_memory", canonical.id);
    fake.rows.set(id.toString(), {
      id,
      conversation_id: canonical.id,
      path: canonical.notePath,
      topic: canonical.topic,
      client_identity: canonical.clientIdentity,
      updated_at: new DateTime(new Date(canonical.updatedAt)),
      summary_hash: await hashConversationSummary(canonical.summary),
      embed_model: "retired-model",
      vector: [1, 0, 0],
    });

    await makeIndex(fake).reconcile([canonical]);

    expect(fake.rows.size).toBe(0);
  });

  test("rejects duplicate stored identities and Markdown paths", async () => {
    const duplicateRecordFake = new InMemorySurreal();
    const duplicate = projectedRow("duplicate");
    duplicateRecordFake.respondOnce([[duplicate, duplicate]]);
    await expect(makeIndex(duplicateRecordFake).list()).rejects.toThrow("duplicate record");

    const duplicatePathFake = new InMemorySurreal();
    duplicatePathFake.respondOnce([
      [
        projectedRow("a", { path: "Notient/conversations/shared.md" }),
        projectedRow("b", { path: "Notient/conversations/shared.md" }),
      ],
    ]);
    await expect(makeIndex(duplicatePathFake).list()).rejects.toThrow(
      "duplicate conversation path",
    );
  });

  test("requires deterministic list ordering", async () => {
    const timestampOrderFake = new InMemorySurreal();
    timestampOrderFake.respondOnce([
      [
        projectedRow("older", { updated_at: new DateTime(new Date(1_000)) }),
        projectedRow("newer", { updated_at: new DateTime(new Date(2_000)) }),
      ],
    ]);
    await expect(makeIndex(timestampOrderFake).list()).rejects.toThrow(
      "not ordered by updated_at DESC, conversation_id ASC",
    );

    const idOrderFake = new InMemorySurreal();
    idOrderFake.respondOnce([[projectedRow("b"), projectedRow("a")]]);
    await expect(makeIndex(idOrderFake).list()).rejects.toThrow(
      "not ordered by updated_at DESC, conversation_id ASC",
    );
  });

  test("requires exact finite search scores, limits, thresholds, and ordering", async () => {
    const missingScoreFake = new InMemorySurreal();
    missingScoreFake.respondOnce([[projectedRow("missing-score")]]);
    await expect(
      makeIndex(missingScoreFake).search(new Float32Array([1, 0, 0]), {
        k: 1,
        threshold: 0,
        clientIdentity: "human",
      }),
    ).rejects.toThrow("must contain exactly");

    for (const similarity of [null, Number.NaN, Number.POSITIVE_INFINITY, -1.01, 1.01]) {
      const fake = new InMemorySurreal();
      fake.respondOnce([[projectedSearchRow("invalid-score", similarity)]]);
      await expect(
        makeIndex(fake).search(new Float32Array([1, 0, 0]), {
          k: 1,
          threshold: -1,
          clientIdentity: "human",
        }),
      ).rejects.toThrow("must be a finite cosine score between -1 and 1");
    }

    const belowThresholdFake = new InMemorySurreal();
    belowThresholdFake.respondOnce([[projectedSearchRow("below", 0.4)]]);
    await expect(
      makeIndex(belowThresholdFake).search(new Float32Array([1, 0, 0]), {
        k: 1,
        threshold: 0.5,
        clientIdentity: "human",
      }),
    ).rejects.toThrow("below threshold 0.5");

    const overLimitFake = new InMemorySurreal();
    overLimitFake.respondOnce([
      [projectedSearchRow("first", 0.9), projectedSearchRow("second", 0.8)],
    ]);
    await expect(
      makeIndex(overLimitFake).search(new Float32Array([1, 0, 0]), {
        k: 1,
        threshold: 0,
        clientIdentity: "human",
      }),
    ).rejects.toThrow("beyond requested limit 1");

    const scoreOrderFake = new InMemorySurreal();
    scoreOrderFake.respondOnce([
      [projectedSearchRow("lower", 0.5), projectedSearchRow("higher", 0.9)],
    ]);
    await expect(
      makeIndex(scoreOrderFake).search(new Float32Array([1, 0, 0]), {
        k: 2,
        threshold: 0,
        clientIdentity: "human",
      }),
    ).rejects.toThrow("not ordered by similarity DESC, updated_at DESC, conversation_id ASC");
  });

  test("empty canonical summaries invalidate semantic memory", async () => {
    const fake = new InMemorySurreal();
    const index = makeIndex(fake);
    const removedByRecord = makeConversation({ id: "record-empty" });
    await index.record(removedByRecord, new Float32Array([1, 0, 0]));

    await index.record({ ...removedByRecord, summary: "" }, new Float32Array([1, 0, 0]));
    expect(await index.list()).toEqual([]);

    const removedByReconcile = makeConversation({ id: "reconcile-empty" });
    await index.record(removedByReconcile, new Float32Array([1, 0, 0]));
    await index.reconcile([{ ...removedByReconcile, summary: "" }]);
    expect(await index.list()).toEqual([]);
  });

  test("rejects duplicate canonical Markdown paths", async () => {
    const index = makeIndex(new InMemorySurreal());
    const notePath = "Notient/conversations/shared.md";
    await expect(
      index.reconcile([
        makeConversation({ id: "first", notePath }),
        makeConversation({ id: "second", notePath }),
      ]),
    ).rejects.toThrow("duplicate canonical conversation path");
  });

  test("rejects non-canonical metadata and unsafe search inputs", async () => {
    const index = makeIndex(new InMemorySurreal());
    await expect(
      index.record(makeConversation({ notePath: "../outside.md" }), new Float32Array([1, 0, 0])),
    ).rejects.toThrow("canonical vault-relative Markdown path");
    await expect(
      index.record(
        makeConversation({ updatedAt: Number.MAX_SAFE_INTEGER }),
        new Float32Array([1, 0, 0]),
      ),
    ).rejects.toThrow("representable as a valid datetime");
    await expect(
      index.search(new Float32Array([1, 0, 0]), {
        k: Number.MAX_SAFE_INTEGER + 1,
        threshold: 0,
        clientIdentity: "human",
      }),
    ).rejects.toThrow("k must be a positive integer");
    await expect(
      index.search(new Float32Array([1, 0, 0]), {
        k: 1,
        threshold: Number.NaN,
        clientIdentity: "human",
      }),
    ).rejects.toThrow("threshold must be between -1 and 1");
  });
});
