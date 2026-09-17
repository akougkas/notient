import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DateTime, type RecordId, type Surreal } from "surrealdb";
import { VaultMutationBlockedError } from "../../../../src/adapters/vaultAdapter";
import { wrapNativeValue } from "../../../../src/core/db/nativeValue";
import {
  type DurableNoteWriteInput,
  DurableNoteWriter,
} from "../../../../src/core/history/durableNoteWriter";

function sha256(value: string): Promise<string> {
  return Promise.resolve(createHash("sha256").update(value).digest("hex"));
}

class MemoryVault {
  readonly files = new Map<string, string>();
  beforeMutation: ((path: string) => void) | undefined;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const body = this.files.get(path);
    if (body === undefined) throw Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
    return body;
  }

  async createIfAbsent(path: string, body: string): Promise<boolean> {
    this.beforeMutation?.(path);
    if (this.files.has(path)) return false;
    this.files.set(path, body);
    return true;
  }

  async writeIfUnchanged(path: string, before: string, after: string): Promise<boolean> {
    this.beforeMutation?.(path);
    if (this.files.get(path) !== before) return false;
    this.files.set(path, after);
    return true;
  }
}

class IntentDb {
  readonly intents = new Map<string, Record<string, unknown>>();
  readonly history = new Map<string, Record<string, unknown>>();
  readonly calls: string[] = [];
  failClose = 0;
  failStart = 0;
  private clock = 1_000;

  query(sql: string, bindings: Record<string, unknown> = {}) {
    return { collect: async () => this.execute(sql, bindings) };
  }

  private execute(sql: string, bindings: Record<string, unknown>): unknown {
    this.calls.push(sql);
    if (sql.includes("note-write:prepare")) return this.prepare(bindings);
    if (sql.includes("note-write:start")) return this.start(bindings);
    if (sql.includes("note-write:abandon")) return this.abandon(bindings);
    if (sql.includes("note-write:close")) return this.close(bindings);
    if (sql.includes("note-write:receipt")) return [this.lookup(this.history, bindings.historyId)];
    if (sql.includes("note-write:list")) return [[...this.intents.values()]];
    if (sql.includes("note-write:intent")) return [this.lookup(this.intents, bindings.intentId)];
    if (sql.includes("note-write:delete")) return this.delete(bindings);
    throw new Error(`unexpected query in durable note writer test: ${sql}`);
  }

  private prepare(bindings: Record<string, unknown>): unknown {
    const intentId = requireRecordId(bindings.intentId, "intentId");
    const historyId = requireRecordId(bindings.historyId, "historyId");
    if (!this.intents.has(intentId.toString()) && !this.history.has(historyId.toString())) {
      this.intents.set(intentId.toString(), {
        id: intentId,
        kind: bindings.kind,
        target: bindings.target,
        before_exists: bindings.beforeExists,
        before_body: bindings.beforeBody,
        after_body: bindings.afterBody,
        before_sha: bindings.beforeSha,
        after_sha: bindings.afterSha,
        history_id: historyId,
        client_identity: bindings.clientIdentity,
        preview_id: bindings.previewId,
        prepared_at: bindings.preparedAt,
      });
    }
    return [];
  }

  private start(bindings: Record<string, unknown>): unknown {
    if (this.failStart > 0) {
      this.failStart -= 1;
      throw new Error("forced write-start failure");
    }
    const row = this.requireIntent(bindings.intentId);
    if (row.abandoned_at === undefined) row.write_started_at = this.tick();
    return [];
  }

  private abandon(bindings: Record<string, unknown>): unknown {
    const row = this.requireIntent(bindings.intentId);
    row.abandoned_at ??= this.tick();
    return [];
  }

  private close(bindings: Record<string, unknown>): unknown {
    if (this.failClose > 0) {
      this.failClose -= 1;
      throw new Error("forced history-close failure");
    }
    const intentId = requireRecordId(bindings.intentId, "intentId");
    const row = this.intents.get(intentId.toString());
    if (row !== undefined && row.write_started_at !== undefined && row.abandoned_at === undefined) {
      const historyId = requireRecordId(bindings.historyId, "historyId");
      const receipt: Record<string, unknown> = {
        id: historyId,
        kind: bindings.kind,
        target: bindings.target,
        after: bindings.after,
        client_identity: bindings.clientIdentity,
      };
      if (bindings.before !== undefined) receipt.before = bindings.before;
      this.history.set(historyId.toString(), receipt);
      this.intents.delete(intentId.toString());
    }
    return [];
  }

  private delete(bindings: Record<string, unknown>): unknown {
    const id = requireRecordId(bindings.intentId, "intentId");
    this.intents.delete(id.toString());
    return [];
  }

  private lookup(
    source: ReadonlyMap<string, Record<string, unknown>>,
    rawId: unknown,
  ): Record<string, unknown>[] {
    const id = requireRecordId(rawId, "lookup id");
    const row = source.get(id.toString());
    return row === undefined ? [] : [row];
  }

  private requireIntent(rawId: unknown): Record<string, unknown> {
    const id = requireRecordId(rawId, "intent id");
    const row = this.intents.get(id.toString());
    if (row === undefined) throw new Error(`missing intent ${id.toString()}`);
    return row;
  }

  private tick(): DateTime {
    this.clock += 1;
    return new DateTime(new Date(this.clock));
  }
}

function requireRecordId(raw: unknown, label: string): RecordId {
  if (typeof raw !== "object" || raw === null || !("toString" in raw)) {
    throw new Error(`${label} is not a record id`);
  }
  return raw as RecordId;
}

function makeWriter(
  db: IntentDb,
  vault: MemoryVault,
  options: { prune?: () => Promise<void> } = {},
): DurableNoteWriter {
  return new DurableNoteWriter({
    db: db as unknown as Surreal,
    vault,
    hash: sha256,
    now: () => 10_000,
    ...(options.prune === undefined ? {} : { pruneHistory: options.prune }),
  });
}

function replaceInput(): DurableNoteWriteInput {
  return {
    kind: "notes.append",
    target: "notes/a.md",
    before: "before\n",
    after: "before\nafter\n",
    clientIdentity: "human",
  };
}

describe("DurableNoteWriter", () => {
  test("creates a history receipt only after the exact guarded filesystem transition", async () => {
    const db = new IntentDb();
    const vault = new MemoryVault();
    vault.files.set("notes/a.md", "before\n");
    let prunes = 0;

    const result = await makeWriter(db, vault, {
      prune: async () => {
        prunes += 1;
      },
    }).apply(replaceInput());

    expect(result.applied).toBe(true);
    expect(vault.files.get("notes/a.md")).toBe("before\nafter\n");
    expect(db.intents.size).toBe(0);
    expect(db.history.size).toBe(1);
    expect(prunes).toBe(1);
    const receipt = [...db.history.values()][0];
    expect(receipt.before).toEqual(wrapNativeValue("before\n"));
    expect(receipt.after).toEqual(wrapNativeValue("before\nafter\n"));
  });

  test("restart finalizes a file committed before a forced history-close failure", async () => {
    const db = new IntentDb();
    const vault = new MemoryVault();
    vault.files.set("notes/a.md", "before\n");
    db.failClose = 1;

    await expect(makeWriter(db, vault).apply(replaceInput())).rejects.toThrow(
      "forced history-close failure",
    );
    expect(vault.files.get("notes/a.md")).toBe("before\nafter\n");
    expect(db.intents.size).toBe(1);
    expect(db.history.size).toBe(0);

    expect(await makeWriter(db, vault).reconcilePendingWrites()).toEqual({
      replayed: 1,
      abandoned: 0,
      failed: 0,
      deferred: 0,
    });
    expect(db.intents.size).toBe(0);
    expect(db.history.size).toBe(1);
  });

  test("restart replays an intent persisted before the filesystem write started", async () => {
    const db = new IntentDb();
    const vault = new MemoryVault();
    vault.files.set("notes/a.md", "before\n");
    db.failStart = 1;

    await expect(makeWriter(db, vault).apply(replaceInput())).rejects.toThrow(
      "forced write-start failure",
    );
    expect(vault.files.get("notes/a.md")).toBe("before\n");

    expect(await makeWriter(db, vault).reconcilePendingWrites()).toEqual({
      replayed: 1,
      abandoned: 0,
      failed: 0,
      deferred: 0,
    });
    expect(vault.files.get("notes/a.md")).toBe("before\nafter\n");
    expect(db.history.size).toBe(1);
  });

  test("editor unavailability defers recovery without losing the intent or poisoning later replay", async () => {
    const db = new IntentDb();
    const vault = new MemoryVault();
    vault.files.set("notes/a.md", "before\n");
    vault.beforeMutation = () => {
      throw new VaultMutationBlockedError("Unsaved editor");
    };
    await expect(makeWriter(db, vault).apply(replaceInput())).rejects.toThrow("Unsaved editor");
    const restarting = makeWriter(db, vault);
    expect(await restarting.reconcilePendingWrites()).toEqual({
      replayed: 0,
      abandoned: 0,
      failed: 0,
      deferred: 1,
    });
    expect(db.intents.size).toBe(1);
    expect(db.history.size).toBe(0);
    expect(vault.files.get("notes/a.md")).toBe("before\n");
    vault.beforeMutation = undefined;
    expect(await restarting.reconcilePendingWrites()).toEqual({
      replayed: 1,
      abandoned: 0,
      failed: 0,
      deferred: 0,
    });
    expect(db.intents.size).toBe(0);
    expect(db.history.size).toBe(1);
    expect(vault.files.get("notes/a.md")).toBe("before\nafter\n");
  });

  test("a guarded conflict creates neither history nor a replayable intent", async () => {
    const db = new IntentDb();
    const vault = new MemoryVault();
    vault.files.set("notes/a.md", "before\n");
    vault.beforeMutation = (path) => vault.files.set(path, "human edit\n");

    expect(await makeWriter(db, vault).apply(replaceInput())).toEqual({
      applied: false,
      reason: "conflict",
    });
    expect(vault.files.get("notes/a.md")).toBe("human edit\n");
    expect(db.intents.size).toBe(0);
    expect(db.history.size).toBe(0);
  });

  test("a third-value intent is terminally abandoned and cannot arm on a later boot", async () => {
    const db = new IntentDb();
    const vault = new MemoryVault();
    vault.files.set("notes/a.md", "before\n");
    db.failClose = 1;
    await expect(makeWriter(db, vault).apply(replaceInput())).rejects.toThrow();

    vault.files.set("notes/a.md", "human third value\n");
    expect(await makeWriter(db, vault).reconcilePendingWrites()).toEqual({
      replayed: 0,
      abandoned: 1,
      failed: 0,
      deferred: 0,
    });
    expect(db.intents.size).toBe(0);
    expect(db.history.size).toBe(0);

    vault.files.set("notes/a.md", "before\n");
    expect(await makeWriter(db, vault).reconcilePendingWrites()).toEqual({
      replayed: 0,
      abandoned: 0,
      failed: 0,
      deferred: 0,
    });
    expect(vault.files.get("notes/a.md")).toBe("before\n");
    expect(db.history.size).toBe(0);
  });

  test("a failed startup reconciliation closes later mutation admission", async () => {
    const db = new IntentDb();
    const vault = new MemoryVault();
    vault.files.set("notes/a.md", "before\n");
    db.failClose = 1;

    await expect(makeWriter(db, vault).apply(replaceInput())).rejects.toThrow(
      "forced history-close failure",
    );
    const restartingWriter = makeWriter(db, vault);
    db.failClose = 1;
    expect(await restartingWriter.reconcilePendingWrites()).toEqual({
      replayed: 0,
      abandoned: 0,
      failed: 1,
      deferred: 0,
    });

    await expect(
      restartingWriter.apply({
        kind: "notes.append",
        target: "notes/a.md",
        before: "before\nafter\n",
        after: "before\nafter\nnew write\n",
        clientIdentity: "human",
      }),
    ).rejects.toThrow("mutation admission is closed");
    expect(vault.files.get("notes/a.md")).toBe("before\nafter\n");
    expect(db.intents.size).toBe(1);
    expect(db.history.size).toBe(0);
  });

  test("rejects non-public paths before touching storage", async () => {
    const db = new IntentDb();
    const vault = new MemoryVault();

    await expect(
      makeWriter(db, vault).apply({
        kind: "notes.create",
        target: "../escape.md",
        before: null,
        after: "body",
        clientIdentity: "human",
      }),
    ).rejects.toThrow("exact public vault-relative Markdown path");
    expect(db.calls).toEqual([]);
  });
});
