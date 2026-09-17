/**
 * session.{grant,revoke,list} handler smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/daemon/handlers/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, and exercises the
 * three RPC handlers against the SurrealDB-backed SessionGrants service.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { SessionGrants } from "../../../../src/core/services/sessionGrants";
import { makeSessionGrantHandler } from "../../../../src/daemon/handlers/sessionGrant";
import {
  type SessionListEntry,
  makeSessionListHandler,
} from "../../../../src/daemon/handlers/sessionList";
import { makeSessionRevokeHandler } from "../../../../src/daemon/handlers/sessionRevoke";
import { RpcError } from "../../../../src/daemon/rpc";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { rpcRequest } from "../../../rpcRequest";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

async function clearAgentSessions(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE agent_session;").collect();
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] session.* handlers", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  let service: SessionGrants;
  const secret = "phase4-session-handlers-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-session-handlers-smoke-"));
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

  describe("[smoke] session.grant handler", () => {
    test("happy path: returns the row the storage layer wrote", async () => {
      const handler = makeSessionGrantHandler({ sessionGrants: service });
      const result = await handler(
        rpcRequest({
          client: "claude-code",
          allowedFolders: ["Inbox/"],
          allowedTools: ["notes.create"],
          maxWrites: 20,
          ttlMinutes: 60,
        }),
      );
      expect(result.ok).toBe(true);
      expect(typeof result.sessionId).toBe("string");
      expect(result.sessionId).toStartWith("agent_session:");
      expect(result.client).toBe("claude-code");
      expect(result.allowedFolders).toEqual(["Inbox/"]);
      expect(result.allowedTools).toEqual(["notes.create"]);
      expect(result.maxWrites).toBe(20);
      expect(typeof result.expiresAt).toBe("number");
    });

    test("rejects a non-canonical folder prefix", async () => {
      const handler = makeSessionGrantHandler({ sessionGrants: service });
      await expect(
        handler(
          rpcRequest({
            client: "claude-code",
            allowedFolders: ["Inbox", "Notient/agent-asks/"],
            ttlMinutes: 30,
          }),
        ),
      ).rejects.toThrow(/ending in/);
    });

    test("rejects missing client", async () => {
      const handler = makeSessionGrantHandler({ sessionGrants: service });
      let thrown: unknown = null;
      try {
        await handler(rpcRequest({ allowedFolders: ["Inbox/"], ttlMinutes: 30 }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("client");
    });

    test("rejects empty allowedFolders array", async () => {
      const handler = makeSessionGrantHandler({ sessionGrants: service });
      let thrown: unknown = null;
      try {
        await handler(rpcRequest({ client: "claude-code", allowedFolders: [], ttlMinutes: 30 }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("allowedFolders");
    });

    test("rejects non-array allowedFolders", async () => {
      const handler = makeSessionGrantHandler({ sessionGrants: service });
      let thrown: unknown = null;
      try {
        await handler(
          rpcRequest({ client: "claude-code", allowedFolders: "Inbox/", ttlMinutes: 30 }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("allowedFolders");
    });

    test("rejects ttlMinutes <= 0", async () => {
      const handler = makeSessionGrantHandler({ sessionGrants: service });
      let thrown: unknown = null;
      try {
        await handler(
          rpcRequest({ client: "claude-code", allowedFolders: ["Inbox/"], ttlMinutes: 0 }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("ttlMinutes");
    });

    test("rejects fractional maxWrites", async () => {
      const handler = makeSessionGrantHandler({ sessionGrants: service });
      let thrown: unknown = null;
      try {
        await handler(
          rpcRequest({
            client: "claude-code",
            allowedFolders: ["Inbox/"],
            maxWrites: 3.5,
            ttlMinutes: 30,
          }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("maxWrites");
    });
  });

  describe("[smoke] session.revoke handler", () => {
    test("happy path: flips revoked_at and returns the timestamp", async () => {
      const grant = await service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        ttlMinutes: 30,
      });
      const handler = makeSessionRevokeHandler({ sessionGrants: service });
      const result = await handler(rpcRequest({ sessionId: grant.id }));
      expect(result.ok).toBe(true);
      expect(result.sessionId).toBe(grant.id);
      expect(typeof result.revokedAt).toBe("number");
    });

    test("unknown id raises SESSION_NOT_FOUND", async () => {
      const handler = makeSessionRevokeHandler({ sessionGrants: service });
      let thrown: unknown = null;
      try {
        await handler(
          rpcRequest({
            sessionId: createUuidRecordId(
              "agent_session",
              "018f05cd-3f7b-7000-8000-999999999999",
            ).toString(),
          }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toBeInstanceOf(RpcError);
      expect((thrown as RpcError).code).toBe("SESSION_NOT_FOUND");
    });

    test("rejects malformed or non-session record ids", async () => {
      const handler = makeSessionRevokeHandler({ sessionGrants: service });
      for (const bad of [undefined, "abc", "note:wrong-table", -1, 0, 3.5]) {
        let thrown: unknown = null;
        try {
          await handler(rpcRequest({ sessionId: bad }));
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain("sessionId");
      }
    });
  });

  describe("[smoke] session.list handler", () => {
    test("default activeOnly returns only live grants", async () => {
      const live = await service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        ttlMinutes: 30,
      });
      const revoked = await service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        ttlMinutes: 30,
      });
      await service.revoke(revoked.id);

      const handler = makeSessionListHandler({ sessionGrants: service });
      const result = await handler(rpcRequest());
      expect(result.ok).toBe(true);
      const sessions = result.sessions as SessionListEntry[];
      expect(sessions.map((entry) => entry.sessionId)).toEqual([live.id]);
    });

    test("activeOnly:false includes revoked rows", async () => {
      await service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        ttlMinutes: 30,
      });
      const revoked = await service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        ttlMinutes: 30,
      });
      await service.revoke(revoked.id);

      const handler = makeSessionListHandler({ sessionGrants: service });
      const result = await handler(rpcRequest({ activeOnly: false }));
      const sessions = result.sessions as SessionListEntry[];
      expect(sessions).toHaveLength(2);
    });

    test("client filter scopes the result", async () => {
      await service.grant({ client: "claude-code", allowedFolders: ["Inbox/"], ttlMinutes: 30 });
      await service.grant({ client: "cursor", allowedFolders: ["Inbox/"], ttlMinutes: 30 });
      const handler = makeSessionListHandler({ sessionGrants: service });
      const result = await handler(rpcRequest({ client: "claude-code" }));
      const sessions = result.sessions as SessionListEntry[];
      expect(sessions.map((entry) => entry.client)).toEqual(["claude-code"]);
    });

    test("rejects non-string client", async () => {
      const handler = makeSessionListHandler({ sessionGrants: service });
      let thrown: unknown = null;
      try {
        await handler(rpcRequest({ client: 7 as unknown as string }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("client");
    });

    test("rejects non-boolean activeOnly", async () => {
      const handler = makeSessionListHandler({ sessionGrants: service });
      let thrown: unknown = null;
      try {
        await handler(rpcRequest({ activeOnly: "true" as unknown as boolean }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("activeOnly");
    });
  });
});
