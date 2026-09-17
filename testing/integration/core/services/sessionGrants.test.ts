/**
 * SessionGrants real-SurrealDB integration harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/services/`.
 *
 * Boots a real SurrealDB, applies the canonical schema, and exercises grant,
 * revoke, list, and atomic claim behavior end-to-end. Each test
 * truncates the table in `afterEach` so ordering assertions stay independent.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalGate } from "../../../../src/core/chat/approvalGate";
import { assertToolApproval } from "../../../../src/core/chat/toolAuthority";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import {
  SESSION_GRANT_TTL_MAX_MINUTES,
  type SessionGrant,
  SessionGrants,
} from "../../../../src/core/services/sessionGrants";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

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

async function insertGrantManually(
  connection: SurrealConnection,
  options: ManualGrantOptions,
): Promise<string> {
  const id = createUuidRecordId("agent_session");
  const setClauses: string[] = [
    "client: $client",
    "granted_at: $grantedAt",
    "expires_at: $expiresAt",
    "allowed_folders: $allowedFolders",
    "allowed_tools: $allowedTools",
    "used_writes: $usedWrites",
  ];
  const bindings: Record<string, unknown> = {
    id,
    client: options.client,
    grantedAt: options.grantedAt,
    expiresAt: options.expiresAt,
    allowedFolders: options.allowedFolders,
    allowedTools: options.allowedTools,
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
    .query(`CREATE ONLY $id CONTENT { ${setClauses.join(", ")} };`, bindings)
    .collect();
  return id.toString();
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
    service = new SessionGrants({ db: connection.db, now: Date.now });
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
    expect(grant.id).toMatch(/^agent_session:/);
    expect(grant.client).toBe("claude-code");
    expect(grant.grantedAt).toBeGreaterThanOrEqual(before);
    expect(grant.expiresAt).toBe(grant.grantedAt + 60 * 60_000);
    expect(grant.allowedFolders).toEqual(["Inbox/"]);
    expect(grant.allowedTools).toEqual(["notes.create"]);
    expect(grant.maxWrites).toBe(20);
    expect(grant.usedWrites).toBe(0);
    expect(grant.revokedAt).toBeNull();
  });

  test("[smoke] grant rejects non-canonical and invalid client ids", async () => {
    await expect(
      service.grant({
        client: "  claude-code  ",
        allowedFolders: ["Inbox/"],
        ttlMinutes: 30,
      }),
    ).rejects.toThrow(/canonical agent id/);
    await expect(
      service.grant({
        client: "Bad Client!",
        allowedFolders: ["Inbox/"],
        ttlMinutes: 30,
      }),
    ).rejects.toThrow(/Invalid agent id/);
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

  test("[smoke] grant rejects a folder prefix without its canonical trailing slash", async () => {
    await expect(
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox", "Notient/agent-asks/"],
        ttlMinutes: 30,
      }),
    ).rejects.toThrow(/ending in/);
  });

  test("[smoke] grant defaults allowedTools to the explicit wildcard", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 30,
    });
    expect(grant.allowedTools).toEqual(["*"]);
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

  test("[smoke] grant rejects ttlMinutes beyond the maximum", async () => {
    await expect(
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        ttlMinutes: SESSION_GRANT_TTL_MAX_MINUTES + 100,
      }),
    ).rejects.toThrow(/must not exceed/);
  });

  test("[smoke] claim returns and consumes the active grant when folder and tool match", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      allowedTools: ["notes.create"],
      ttlMinutes: 60,
    });
    const found = await service.claim({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/",
      now: Date.now(),
    });
    expect(found).not.toBeNull();
    expect(found?.id).toBe(grant.id);
  });

  test("[smoke] claim returns null when allowed_tools excludes the tool", async () => {
    await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      allowedTools: ["notes.create"],
      ttlMinutes: 60,
    });
    const found = await service.claim({
      client: "claude-code",
      tool: "notes.append",
      folder: "Inbox/",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("[smoke] claim matches any tool only with the explicit wildcard", async () => {
    await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const found = await service.claim({
      client: "claude-code",
      tool: "notes.append",
      folder: "Inbox/",
      now: Date.now(),
    });
    expect(found).not.toBeNull();
  });

  test("[smoke] claim returns null when no folder prefix matches", async () => {
    await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const found = await service.claim({
      client: "claude-code",
      tool: "notes.create",
      folder: "Outbox/",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("[smoke] claim returns null when the grant is expired", async () => {
    await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 2_000,
      allowedFolders: ["Inbox/"],
      allowedTools: ["*"],
      maxWrites: null,
    });
    const found = await service.claim({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/",
      now: 5_000,
    });
    expect(found).toBeNull();
  });

  test("[smoke] claim returns null when the grant is revoked", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    await service.revoke(grant.id);
    const found = await service.claim({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("[smoke] claim returns null when used_writes has reached max_writes", async () => {
    await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: ["*"],
      maxWrites: 3,
      usedWrites: 3,
    });
    const found = await service.claim({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/",
      now: 5_000,
    });
    expect(found).toBeNull();
  });

  test("[smoke] claim remains unlimited when max_writes is absent", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const claims = await Promise.all(
      Array.from({ length: 50 }, () =>
        service.claim({
          client: "claude-code",
          tool: "notes.create",
          folder: "Inbox/",
          now: Date.now(),
        }),
      ),
    );
    expect(claims.every((claim) => claim?.id === grant.id)).toBe(true);
    const rows = await service.list({ activeOnly: true });
    expect(rows.find((row) => row.id === grant.id)?.usedWrites).toBe(50);
  });

  test("[smoke] claim returns the most recent active grant when multiple match", async () => {
    const oldId = await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 1_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: ["*"],
      maxWrites: null,
    });
    const newId = await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 2_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: ["*"],
      maxWrites: null,
    });
    const found = await service.claim({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/",
      now: 3_000,
    });
    expect(found?.id).toBe(newId);
  });

  test("[smoke] claim scopes the search to the requested client", async () => {
    await service.grant({
      client: "cursor",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 60,
    });
    const found = await service.claim({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("[smoke] revoke flips revoked_at and excludes the row from subsequent claims", async () => {
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
    const found = await service.claim({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/",
      now: Date.now(),
    });
    expect(found).toBeNull();
  });

  test("[smoke] revoke returns null when the id does not match any row", async () => {
    const result = await service.revoke(
      createUuidRecordId("agent_session", "018f05cd-3f7b-7000-8000-999999999999").toString(),
    );
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
      allowedTools: ["*"],
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
      allowedTools: ["*"],
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
      allowedTools: ["*"],
      maxWrites: null,
    });
    const newId = await insertGrantManually(connection, {
      client: "claude-code",
      grantedAt: 2_000,
      expiresAt: 99_999_999_999_999,
      allowedFolders: ["Inbox/"],
      allowedTools: ["*"],
      maxWrites: null,
    });
    const rows = await service.list({ activeOnly: true });
    expect(rows.map((row) => row.id)).toEqual([newId, oldId]);
  });

  test("[smoke] concurrent claims cannot exceed max_writes", async () => {
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      maxWrites: 10,
      ttlMinutes: 60,
    });
    const claims = await Promise.all(
      Array.from({ length: 25 }, () =>
        service.claim({
          client: "claude-code",
          tool: "notes.create",
          folder: "Inbox/",
          now: Date.now(),
        }),
      ),
    );
    expect(claims.filter((claim) => claim !== null)).toHaveLength(10);
    const rows = await service.list({ activeOnly: true });
    const updated = rows.find((row) => row.id === grant.id);
    expect(updated?.usedWrites).toBe(10);
  });

  test("[smoke] batch claims reserve all effects or none, including concurrent reservations", async () => {
    const grant = await service.grant({
      client: "codex",
      allowedFolders: ["Notient/proposals/"],
      allowedTools: ["agent.distill"],
      maxWrites: 5,
      ttlMinutes: 60,
    });
    const query = {
      client: "codex",
      tool: "agent.distill",
      folder: "Notient/proposals/",
      now: Date.now(),
      writeCount: 3,
    };
    const claims = await Promise.all([service.claim(query), service.claim(query)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await service.get(grant.id))?.usedWrites).toBe(3);
    expect(await service.claim(query)).toBeNull();
    expect((await service.get(grant.id))?.usedWrites).toBe(3);
    expect(await service.claim({ ...query, writeCount: 2 })).toMatchObject({
      id: grant.id,
      usedWrites: 5,
    });
    expect(await service.claim({ ...query, writeCount: 1 })).toBeNull();
  });

  test("[smoke] a one-write grant parks a two-note approval without consuming allowance", async () => {
    const grant = await service.grant({
      client: "codex",
      allowedFolders: ["Notient/proposals/"],
      allowedTools: ["agent.distill"],
      maxWrites: 1,
      ttlMinutes: 60,
    });
    const gate = new ApprovalGate({
      sessionGrants: service,
      recordHistoryAutoApprove: async () => {},
      perToolPolicy: () => ({}),
    });
    let pending!: () => void;
    const parked = new Promise<void>((resolve) => {
      pending = resolve;
    });
    gate.subscribe({ onPending: () => pending(), onResolved: () => {} });
    const paths = ["Notient/proposals/first.md", "Notient/proposals/second.md"];
    const call = {
      id: "batch",
      name: "agent.distill",
      args: { path: paths[0], proposalPaths: paths },
    };
    const signal = new AbortController().signal;
    const decision = gate.request(call, "safe", "Create two notes", signal, {
      clientIdentity: "codex",
    });
    await parked;
    expect((await service.get(grant.id))?.usedWrites).toBe(0);
    expect(gate.pendingCount()).toBe(1);
    gate.resolve("batch", { approved: false, reason: "No additional permission" });
    expect(await decision).toEqual({ approved: false, reason: "No additional permission" });
    const enough = await service.grant({
      client: "codex",
      allowedFolders: ["Notient/proposals/"],
      allowedTools: ["agent.distill"],
      maxWrites: 2,
      ttlMinutes: 60,
    });
    const approved = await gate.request(
      { ...call, id: "batch2" },
      "safe",
      "Create two notes",
      signal,
      { clientIdentity: "codex" },
    );
    const proof = gate.writeGuard(approved, signal).toolApproval;
    expect(proof.permission).toMatchObject({
      kind: "session",
      id: enough.id,
      claimedWrite: 2,
      claimedWrites: 2,
    });
    await expect(
      assertToolApproval(proof, {
        authorizeIdentity: () => {},
        grant: (id) => service.get(id),
        policy: async () => ({ approvalMode: "safe", perTool: {} }),
      }),
    ).resolves.toBeUndefined();
    expect((await service.get(grant.id))?.usedWrites).toBe(0);
  });

  test("[smoke] grant rejects ambiguous or empty tool authority", async () => {
    await expect(
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        allowedTools: [],
        ttlMinutes: 60,
      }),
    ).rejects.toThrow(/allowedTools/);
    await expect(
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        allowedTools: ["*", "notes.create"],
        ttlMinutes: 60,
      }),
    ).rejects.toThrow(/wildcard/);
  });
});
