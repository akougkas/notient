import { describe, expect, test } from "bun:test";
import { Database } from "../../core/db/database";
import { MemoryAdapter, loadWasm } from "../../core/db/database.test";
import { SessionGrants } from "../../core/services/sessionGrants";
import { makeSessionGrantHandler } from "./sessionGrant";
import { type SessionListEntry, makeSessionListHandler } from "./sessionList";
import { makeSessionRevokeHandler } from "./sessionRevoke";

interface Rig {
  database: Database;
  service: SessionGrants;
}

async function makeRig(): Promise<Rig> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await database.init();
  const service = new SessionGrants({ database });
  return { database, service };
}

describe("session.grant handler", () => {
  test("happy path: returns the row the storage layer wrote", async () => {
    const { service } = await makeRig();
    const handler = makeSessionGrantHandler({ sessionGrants: service });
    const result = await handler(
      {
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        allowedTools: ["notes.create"],
        maxWrites: 20,
        ttlMinutes: 60,
      },
      () => {},
      "req-grant-1",
      "human",
    );
    expect(result.ok).toBe(true);
    expect(typeof result.sessionId).toBe("number");
    expect(result.client).toBe("claude-code");
    expect(result.allowedFolders).toEqual(["Inbox/"]);
    expect(result.allowedTools).toEqual(["notes.create"]);
    expect(result.maxWrites).toBe(20);
    expect(typeof result.expiresAt).toBe("number");
  });

  test("normalizes folder entries on the way back out", async () => {
    const { service } = await makeRig();
    const handler = makeSessionGrantHandler({ sessionGrants: service });
    const result = await handler(
      {
        client: "claude-code",
        allowedFolders: ["Inbox", "Notient/agent-asks/"],
        ttlMinutes: 30,
      },
      () => {},
      "req-grant-norm",
      "human",
    );
    expect(result.allowedFolders).toEqual(["Inbox/", "Notient/agent-asks/"]);
  });

  test("rejects missing client", async () => {
    const { service } = await makeRig();
    const handler = makeSessionGrantHandler({ sessionGrants: service });
    let thrown: unknown = null;
    try {
      await handler(
        { allowedFolders: ["Inbox/"], ttlMinutes: 30 },
        () => {},
        "req-grant-noclient",
        "human",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("client");
  });

  test("rejects empty allowedFolders array", async () => {
    const { service } = await makeRig();
    const handler = makeSessionGrantHandler({ sessionGrants: service });
    let thrown: unknown = null;
    try {
      await handler(
        { client: "claude-code", allowedFolders: [], ttlMinutes: 30 },
        () => {},
        "req-grant-empty",
        "human",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("allowedFolders");
  });

  test("rejects non-array allowedFolders", async () => {
    const { service } = await makeRig();
    const handler = makeSessionGrantHandler({ sessionGrants: service });
    let thrown: unknown = null;
    try {
      await handler(
        { client: "claude-code", allowedFolders: "Inbox/", ttlMinutes: 30 },
        () => {},
        "req-grant-string",
        "human",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("allowedFolders");
  });

  test("rejects ttlMinutes <= 0", async () => {
    const { service } = await makeRig();
    const handler = makeSessionGrantHandler({ sessionGrants: service });
    let thrown: unknown = null;
    try {
      await handler(
        { client: "claude-code", allowedFolders: ["Inbox/"], ttlMinutes: 0 },
        () => {},
        "req-grant-zero",
        "human",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("ttlMinutes");
  });

  test("rejects fractional maxWrites", async () => {
    const { service } = await makeRig();
    const handler = makeSessionGrantHandler({ sessionGrants: service });
    let thrown: unknown = null;
    try {
      await handler(
        {
          client: "claude-code",
          allowedFolders: ["Inbox/"],
          maxWrites: 3.5,
          ttlMinutes: 30,
        },
        () => {},
        "req-grant-frac",
        "human",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("maxWrites");
  });
});

describe("session.revoke handler", () => {
  test("happy path: flips revoked_at and returns the timestamp", async () => {
    const { service } = await makeRig();
    const grant = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 30,
    });
    const handler = makeSessionRevokeHandler({ sessionGrants: service });
    const result = await handler({ sessionId: grant.id }, () => {}, "req-revoke-1", "human");
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe(grant.id);
    expect(typeof result.revokedAt).toBe("number");
  });

  test("unknown id raises SESSION_NOT_FOUND", async () => {
    const { service } = await makeRig();
    const handler = makeSessionRevokeHandler({ sessionGrants: service });
    let thrown: unknown = null;
    try {
      await handler({ sessionId: 9_999 }, () => {}, "req-revoke-missing", "human");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("SESSION_NOT_FOUND");
  });

  test("rejects missing or non-integer sessionId", async () => {
    const { service } = await makeRig();
    const handler = makeSessionRevokeHandler({ sessionGrants: service });
    for (const bad of [undefined, "abc", -1, 0, 3.5]) {
      let thrown: unknown = null;
      try {
        await handler({ sessionId: bad as unknown as number }, () => {}, "req-revoke-bad", "human");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("sessionId");
    }
  });
});

describe("session.list handler", () => {
  test("default activeOnly returns only live grants", async () => {
    const { service } = await makeRig();
    const live = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 30,
    });
    const revoked = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 30,
    });
    service.revoke(revoked.id);

    const handler = makeSessionListHandler({ sessionGrants: service });
    const result = await handler({}, () => {}, "req-list-default", "human");
    expect(result.ok).toBe(true);
    const sessions = result.sessions as SessionListEntry[];
    expect(sessions.map((entry) => entry.sessionId)).toEqual([live.id]);
  });

  test("activeOnly:false includes revoked rows", async () => {
    const { service } = await makeRig();
    service.grant({ client: "claude-code", allowedFolders: ["Inbox/"], ttlMinutes: 30 });
    const revoked = service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      ttlMinutes: 30,
    });
    service.revoke(revoked.id);

    const handler = makeSessionListHandler({ sessionGrants: service });
    const result = await handler({ activeOnly: false }, () => {}, "req-list-all", "human");
    const sessions = result.sessions as SessionListEntry[];
    expect(sessions).toHaveLength(2);
  });

  test("client filter scopes the result", async () => {
    const { service } = await makeRig();
    service.grant({ client: "claude-code", allowedFolders: ["Inbox/"], ttlMinutes: 30 });
    service.grant({ client: "cursor", allowedFolders: ["Inbox/"], ttlMinutes: 30 });
    const handler = makeSessionListHandler({ sessionGrants: service });
    const result = await handler({ client: "claude-code" }, () => {}, "req-list-client", "human");
    const sessions = result.sessions as SessionListEntry[];
    expect(sessions.map((entry) => entry.client)).toEqual(["claude-code"]);
  });

  test("rejects non-string client", async () => {
    const { service } = await makeRig();
    const handler = makeSessionListHandler({ sessionGrants: service });
    let thrown: unknown = null;
    try {
      await handler({ client: 7 as unknown as string }, () => {}, "req-list-bad-client", "human");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("client");
  });

  test("rejects non-boolean activeOnly", async () => {
    const { service } = await makeRig();
    const handler = makeSessionListHandler({ sessionGrants: service });
    let thrown: unknown = null;
    try {
      await handler(
        { activeOnly: "true" as unknown as boolean },
        () => {},
        "req-list-bad-active",
        "human",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("activeOnly");
  });
});
