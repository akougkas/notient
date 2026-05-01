/**
 * Phase 4 Task 12 SessionGrants smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/services/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema (which now includes
 * the `agent_session` table added by Task 12), and exercises grant /
 * revoke / list / find / incrementWriteCount end-to-end. Each test
 * truncates the table in `afterEach` so seq counters and ordering
 * assertions stay independent.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { SESSION_GRANT_TTL_MAX_MINUTES, type SessionGrant, SessionGrants } from "../../../../src/core/services/sessionGrants";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

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

async function nextSeq(connection: SurrealConnection): Promise<number> {
  const [rows] = await connection.db
    .query<[Array<{ seq: number }>]>("SELECT seq FROM agent_session ORDER BY seq DESC LIMIT 1;")
    .collect<[Array<{ seq: number }>]>();
  return (rows[0]?.seq ?? 0) + 1;
}

async function insertGrantManually(
  connection: SurrealConnection,
  options: ManualGrantOptions,
): Promise<number> {
  const seq = await nextSeq(connection);
  const setClauses: string[] = [
    "seq: $seq",
    "client: $client",
    "granted_at: $grantedAt",
    "expires_at: $expiresAt",
    "allowed_folders: $allowedFolders",
    "allowed_tools: $allowedTools",
    "used_writes: $usedWrites",
  ];
  const bindings: Record<string, unknown> = {
    seq,
    client: options.client,
    grantedAt: options.grantedAt,
    expiresAt: options.expiresAt,
    allowedFolders: JSON.stringify(options.allowedFolders),
    allowedTools: JSON.stringify(options.allowedTools),
    usedWrites: options.usedWrites ?? 0,
  };
  if (options.maxWrites !== null) {
    setClauses.push("max_writes: $maxWrites");
    bindings.maxWrites = options.maxWrites;
  }
  if (options.revokedAt !== undefined && options.revokedAt !== null) {
    setClauses.push("revoked_at: $revokedAt");
    bindings.revokedAt = options.revokedAt;
  }
  await connection.db
    .query(`CREATE agent_session CONTENT { ${setClauses.join(", ")} };`, bindings)
    .collect();
  return seq;
}

async function clearAgentSessions(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE agent_session;").collect();
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] SessionGrants", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  let service: SessionGrants;
  const secret = "phase4-sessiongrants-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-sessiongrants-smoke-"));
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
    service = new SessionGrants({ db: connection.db });
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

  afterEach(async () => {
    await clearAgentSessions(connection);
  });

  test("[smoke] grant creates a row and returns a populated SessionGrant", async () => {
    const before = Date.now();
    const grant = await service.grant({
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

  test("[smoke] grant normalizes the client via normalizeAgentId and rejects invalid ids", async () => {
    const granted = await service.grant({
      client: "  claude-code  ",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 30,
    });
    expect(granted.client).toBe("claude-code");
    let thrown: unknown = null;
    try {
      await service.grant({
        client: "Bad Client!",
        allowedFolders: ["Inbox/"],
        ttlMinutes: 30,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/Invalid agent id/);
  });

  test("[smoke] grant rejects an empty allowedFolders array", async () => {
    let thrown: unknown = null;
    try {
      await service.grant({
        client: "claude-code",
        allowedFolders: [],
        ttlMinutes: 30,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/allowedFolders/);
  });

  test("[smoke] grant normalizes folder entries to a trailing slash", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox", "Notient/agent-asks/"],
      ttlMinutes: 30,
    });
    expect(grant.allowedFolders).toEqual(["Inbox/", "Notient/agent-asks/"]);
  });

  test("[smoke] grant defaults allowedTools to the empty 'all writes' sentinel", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 30,
    });
    expect(grant.allowedTools).toEqual([]);
  });

  test("[smoke] grant rejects ttlMinutes <= 0", async () => {
    let zeroThrown: unknown = null;
    try {
      await service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        ttlMinutes: 0,
      });
    } catch (error) {
      zeroThrown = error;
    }
    expect(zeroThrown).toBeInstanceOf(Error);
    let negThrown: unknown = null;
    try {
      await service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        ttlMinutes: -5,
      });
    } catch (error) {
      negThrown = error;
    }
    expect(negThrown).toBeInstanceOf(Error);
  });

  test("[smoke] grant clamps ttlMinutes silently at the documented maximum", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: SESSION_GRANT_TTL_MAX_MINUTES + 100,
    });
    expect(grant.expiresAt - grant.grantedAt).toBe(SESSION_GRANT_TTL_MAX_MINUTES * 60_000);
  });

  test("[smoke] find returns the active grant when folder and tool match", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      allowedTools: ["notes.create"],
      ttlMinutes: 60,
    });
    const found = await service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).not.toBeNull();
    expect(found?.id).toBe(grant.id);
  });

  test("[smoke] find returns null when allowed_tools excludes the tool", async () => {
    await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      allowedTools: ["notes.create"],
      ttlMinutes: 60,
    });
    const found = await service.find({
      client: "claude-code",
      tool: "notes.append",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("[smoke] find matches any tool when allowed_tools is the empty sentinel", async () => {
    await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const found = await service.find({
      client: "claude-code",
      tool: "notes.append",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).not.toBeNull();
  });

  test("[smoke] find returns null when no folder prefix matches", async () => {
    await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const found = await service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Outbox/today.md",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("[smoke] find returns null when the grant is expired", async () => {
    await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 2_000,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const found = await service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: 5_000,
    });
    expect(found).toBeNull();
  });

  test("[smoke] find returns null when the grant is revoked", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    await service.revoke(grant.id);
    const found = await service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("[smoke] find returns null when used_writes has reached max_writes", async () => {
    await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: 3,
      usedWrites: 3,
    });
    const found = await service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: 5_000,
    });
    expect(found).toBeNull();
  });

  test("[smoke] find ignores max_writes when it is null", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    for (let index = 0; index < 50; index++) {
      await service.incrementWriteCount(grant.id);
    }
    const found = await service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).not.toBeNull();
    expect(found?.usedWrites).toBe(50);
  });

  test("[smoke] find returns the most recent active grant when multiple match", async () => {
    const oldId = await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const newId = await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 2_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    expect(newId).toBeGreaterThan(oldId);
    const found = await service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: 3_000,
    });
    expect(found?.id).toBe(newId);
  });

  test("[smoke] find scopes the search to the requested client", async () => {
    await service.grant({
      client: "cursor",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const found = await service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("[smoke] revoke flips revoked_at and excludes the row from subsequent find calls", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const before = Date.now();
    const revoked = await service.revoke(grant.id);
    expect(revoked).not.toBeNull();
    expect(revoked?.revokedAt).not.toBeNull();
    expect((revoked as SessionGrant).revokedAt).toBeGreaterThanOrEqual(before);
    const found = await service.find({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/today.md",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("[smoke] revoke returns null when the id does not match any row", async () => {
    const result = await service.revoke(9_999);
    expect(result).toBeNull();
  });

  test("[smoke] list activeOnly filters expired and revoked rows by default", async () => {
    const liveGrant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 2_000,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const revokedGrant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    await service.revoke(revokedGrant.id);

    const active = await service.list({ activeOnly: true });
    expect(active.map((row) => row.id)).toEqual([liveGrant.id]);
  });

  test("[smoke] list activeOnly:false includes expired and revoked rows", async () => {
    await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 2_000,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const all = await service.list({ activeOnly: false });
    expect(all).toHaveLength(2);
  });

  test("[smoke] list filters on exact client match", async () => {
    await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    await service.grant({
      client: "cursor",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const filtered = await service.list({ client: "claude-code", activeOnly: true });
    expect(filtered.map((row) => row.client)).toEqual(["claude-code"]);
  });

  test("[smoke] list orders rows by granted_at DESC", async () => {
    const oldId = await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const newId = await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 2_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: [],
      maxWrites: null,
    });
    const rows = await service.list({ activeOnly: true });
    expect(rows.map((row) => row.id)).toEqual([newId, oldId]);
  });

  test("[smoke] incrementWriteCount: ten back-to-back calls land used_writes at exactly 10", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      maxWrites: 100,
      ttlMinutes: 60,
    });
    for (let index = 0; index < 10; index++) {
      await service.incrementWriteCount(grant.id);
    }
    const rows = await service.list({ activeOnly: true });
    const updated = rows.find((row) => row.id === grant.id);
    expect(updated?.usedWrites).toBe(10);
  });

  test("[smoke] incrementWriteCount is a no-op against an unknown id", async () => {
    let thrown: unknown = null;
    try {
      await service.incrementWriteCount(9_999);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
  });
});
