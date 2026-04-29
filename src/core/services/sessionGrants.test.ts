import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { SESSION_GRANT_TTL_MAX_MINUTES, type SessionGrant, SessionGrants } from "./sessionGrants";

async function makeService(): Promise<{ database: Database; service: SessionGrants }> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await database.init();
  const service = new SessionGrants({ database });
  return { database, service };
}

interface ManualGrantOptions {
  client: string;
  grantedAt: number;
  expiresAt: number;
  allowedFolders: string[];
  allowedTools: string[];
  maxWrites: number | null;
  usedWrites?: number;
  revokedAt?: number | null;
}

function insertGrantManually(database: Database, options: ManualGrantOptions): number {
  database.run(
    `INSERT INTO agent_sessions
       (client, granted_at, expires_at, allowed_folders, allowed_tools,
        max_writes, used_writes, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      options.client,
      options.grantedAt,
      options.expiresAt,
      JSON.stringify(options.allowedFolders),
      JSON.stringify(options.allowedTools),
      options.maxWrites,
      options.usedWrites ?? 0,
      options.revokedAt ?? null,
    ],
  );
  const idRow = database.query<{ id: number }>("SELECT last_insert_rowid() AS id;")[0];
  return idRow.id;
}

describe("SessionGrants.grant", () => {
  test("creates a row and returns a populated SessionGrant", async () => {
    const { service } = await makeService();
    const before = Date.now();
    const grant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      allowedTools: ["notes.create"],
      maxWrites: 20,
      ttlMinutes: 60,
    });
    expect(grant.id).toBeGreaterThan(0);
    expect(grant.client).toBe("claude-code");
    expect(grant.grantedAt).toBeGreaterThanOrEqual(before);
    expect(grant.expiresAt).toBe(grant.grantedAt + 60 * 60_000);
    expect(grant.allowedFolders).toEqual(["Inbox/"]);
    expect(grant.allowedTools).toEqual(["notes.create"]);
    expect(grant.maxWrites).toBe(20);
    expect(grant.usedWrites).toBe(0);
    expect(grant.revokedAt).toBeNull();
  });

  test("normalizes the client via normalizeAgentId and rejects invalid ids", async () => {
    const { service } = await makeService();
    const granted = service.grant({
      client: "  claude-code  ",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 30,
    });
    expect(granted.client).toBe("claude-code");
    expect(() =>
      service.grant({
        client: "Bad Client!",
        allowedFolders: ["Inbox/"],
        ttlMinutes: 30,
      }),
    ).toThrow(/Invalid agent id/);
  });

  test("rejects an empty allowedFolders array", async () => {
    const { service } = await makeService();
    expect(() =>
      service.grant({
        client: "claude-code",
        allowedFolders: [],
        ttlMinutes: 30,
      }),
    ).toThrow(/allowedFolders/);
  });

  test("rejects empty folder entries", async () => {
    const { service } = await makeService();
    expect(() =>
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/", ""],
        ttlMinutes: 30,
      }),
    ).toThrow(/allowedFolders/);
  });

  test("normalizes folder entries to a trailing slash", async () => {
    const { service } = await makeService();
    const grant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox", "Notient/agent-asks/"],
      ttlMinutes: 30,
    });
    expect(grant.allowedFolders).toEqual(["Inbox/", "Notient/agent-asks/"]);
  });

  test("defaults allowedTools to the empty 'all writes' sentinel", async () => {
    const { service } = await makeService();
    const grant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 30,
    });
    expect(grant.allowedTools).toEqual([]);
  });

  test("rejects ttlMinutes <= 0", async () => {
    const { service } = await makeService();
    expect(() =>
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        ttlMinutes: 0,
      }),
    ).toThrow(/ttlMinutes/);
    expect(() =>
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        ttlMinutes: -5,
      }),
    ).toThrow(/ttlMinutes/);
  });

  test("clamps ttlMinutes silently at the documented maximum", async () => {
    const { service } = await makeService();
    const grant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: SESSION_GRANT_TTL_MAX_MINUTES + 100,
    });
    expect(grant.expiresAt - grant.grantedAt).toBe(SESSION_GRANT_TTL_MAX_MINUTES * 60_000);
  });

  test("rejects a non-positive maxWrites", async () => {
    const { service } = await makeService();
    expect(() =>
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        maxWrites: 0,
        ttlMinutes: 30,
      }),
    ).toThrow(/maxWrites/);
    expect(() =>
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        maxWrites: -1,
        ttlMinutes: 30,
      }),
    ).toThrow(/maxWrites/);
  });

  test("rejects a non-integer maxWrites", async () => {
    const { service } = await makeService();
    expect(() =>
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        maxWrites: 3.5,
        ttlMinutes: 30,
      }),
    ).toThrow(/maxWrites/);
  });
});

describe("SessionGrants.find", () => {
  test("returns the active grant when folder and tool match", async () => {
    const { service } = await makeService();
    const grant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      allowedTools: ["notes.create"],
      ttlMinutes: 60,
    });
    const found = service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).not.toBeNull();
    expect(found?.id).toBe(grant.id);
  });

  test("returns null when allowed_tools is non-empty and excludes the tool", async () => {
    const { service } = await makeService();
    service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      allowedTools: ["notes.create"],
      ttlMinutes: 60,
    });
    const found = service.find({
      client: "claude-code",
      tool: "notes.append",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("matches any tool when allowed_tools is the empty 'all writes' sentinel", async () => {
    const { service } = await makeService();
    service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const found = service.find({
      client: "claude-code",
      tool: "notes.append",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).not.toBeNull();
  });

  test("returns null when no folder prefix matches", async () => {
    const { service } = await makeService();
    service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const found = service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Outbox/today.md",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("returns null when the grant is expired", async () => {
    const { database, service } = await makeService();
    insertGrantManually(database, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 2_000,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const found = service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: 5_000,
    });
    expect(found).toBeNull();
  });

  test("returns null when the grant is revoked", async () => {
    const { service } = await makeService();
    const grant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    service.revoke(grant.id);
    const found = service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("returns null when used_writes has reached max_writes", async () => {
    const { database, service } = await makeService();
    insertGrantManually(database, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: 3,
      usedWrites: 3,
    });
    const found = service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: 5_000,
    });
    expect(found).toBeNull();
  });

  test("ignores max_writes when it is null", async () => {
    const { service } = await makeService();
    const grant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    for (let index = 0; index < 50; index++) {
      service.incrementWriteCount(grant.id);
    }
    const found = service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).not.toBeNull();
    expect(found?.usedWrites).toBe(50);
  });

  test("returns the most recent active grant when multiple match", async () => {
    const { database, service } = await makeService();
    const oldId = insertGrantManually(database, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const newId = insertGrantManually(database, {
      client: "claude-code",
      grantedAt: 2_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    expect(newId).toBeGreaterThan(oldId);
    const found = service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: 3_000,
    });
    expect(found?.id).toBe(newId);
  });

  test("scopes the search to the requested client", async () => {
    const { service } = await makeService();
    service.grant({
      client: "cursor",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const found = service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });
});

describe("SessionGrants.revoke", () => {
  test("flips revoked_at and excludes the row from subsequent find calls", async () => {
    const { service } = await makeService();
    const grant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const before = Date.now();
    const revoked = service.revoke(grant.id);
    expect(revoked).not.toBeNull();
    expect(revoked?.revokedAt).not.toBeNull();
    expect((revoked as SessionGrant).revokedAt).toBeGreaterThanOrEqual(before);
    const found = service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("returns null when the id does not match any row", async () => {
    const { service } = await makeService();
    const result = service.revoke(9_999);
    expect(result).toBeNull();
  });
});

describe("SessionGrants.list", () => {
  test("activeOnly filters expired and revoked rows by default", async () => {
    const { database, service } = await makeService();
    const liveGrant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    insertGrantManually(database, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 2_000,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const revokedGrant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    service.revoke(revokedGrant.id);

    const active = service.list({ activeOnly: true });
    expect(active.map((row) => row.id)).toEqual([liveGrant.id]);
  });

  test("activeOnly:false includes expired and revoked rows", async () => {
    const { database, service } = await makeService();
    service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    insertGrantManually(database, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 2_000,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const all = service.list({ activeOnly: false });
    expect(all).toHaveLength(2);
  });

  test("filters on exact client match", async () => {
    const { service } = await makeService();
    service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    service.grant({
      client: "cursor",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const filtered = service.list({ client: "claude-code", activeOnly: true });
    expect(filtered.map((row) => row.client)).toEqual(["claude-code"]);
  });

  test("orders rows by granted_at DESC", async () => {
    const { database, service } = await makeService();
    const oldId = insertGrantManually(database, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const newId = insertGrantManually(database, {
      client: "claude-code",
      grantedAt: 2_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const rows = service.list({ activeOnly: true });
    expect(rows.map((row) => row.id)).toEqual([newId, oldId]);
  });
});

describe("SessionGrants.incrementWriteCount", () => {
  test("ten back-to-back calls land used_writes at exactly 10", async () => {
    const { service } = await makeService();
    const grant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      maxWrites: 100,
      ttlMinutes: 60,
    });
    for (let index = 0; index < 10; index++) {
      service.incrementWriteCount(grant.id);
    }
    const rows = service.list({ activeOnly: true });
    const updated = rows.find((row) => row.id === grant.id);
    expect(updated?.usedWrites).toBe(10);
  });

  test("is a no-op against an unknown id", async () => {
    const { service } = await makeService();
    expect(() => service.incrementWriteCount(9_999)).not.toThrow();
  });
});
