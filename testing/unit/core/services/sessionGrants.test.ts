import { describe, expect, test } from "bun:test";
import { RecordId, type Surreal } from "surrealdb";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import {
  SessionGrantIntegrityError,
  SessionGrants,
} from "../../../../src/core/services/sessionGrants";

interface StoredGrantFixture {
  id: RecordId<"agent_session">;
  client: unknown;
  granted_at: unknown;
  expires_at: unknown;
  allowed_folders: unknown;
  allowed_tools: unknown;
  max_writes: unknown;
  used_writes: unknown;
  revoked_at: unknown;
}

function storedGrant(overrides: Partial<StoredGrantFixture> = {}): StoredGrantFixture {
  return {
    id: createUuidRecordId("agent_session", "018f05cd-3f7b-7000-8000-000000000001"),
    client: "claude-code",
    granted_at: 1_000,
    expires_at: 2_000,
    allowed_folders: ["Inbox/"],
    allowed_tools: ["notes.create"],
    max_writes: undefined,
    used_writes: 0,
    revoked_at: undefined,
    ...overrides,
  };
}

function mutationGrant(row: StoredGrantFixture): Record<string, unknown> {
  const { max_writes: maxWrites, revoked_at: revokedAt, ...required } = row;
  return {
    ...required,
    ...(maxWrites === undefined ? {} : { max_writes: maxWrites }),
    ...(revokedAt === undefined ? {} : { revoked_at: revokedAt }),
  };
}

function serviceReturning(row: StoredGrantFixture): {
  service: SessionGrants;
  queries: string[];
} {
  const queries: string[] = [];
  const db = {
    query: (sql: string) => {
      queries.push(sql);
      return {
        collect: async () => [[row]],
      };
    },
  };
  return { service: new SessionGrants({ db: db as never, now: () => 1_500 }), queries };
}

function serviceWithResponses(
  responses: unknown[],
  now: () => number = () => 1_500,
): {
  service: SessionGrants;
  queries: Array<{ sql: string; bindings: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; bindings: Record<string, unknown> }> = [];
  const db = {
    query: (sql: string, bindings: Record<string, unknown> = {}) => {
      queries.push({ sql, bindings });
      return {
        collect: async () => {
          if (responses.length === 0) throw new Error("no fake response remaining");
          return responses.shift();
        },
      };
    },
  };
  return { service: new SessionGrants({ db: db as never, now }), queries };
}

function serviceWithCollector(
  collect: (sql: string, bindings: Record<string, unknown>) => unknown,
  now: () => number = () => 1_500,
): SessionGrants {
  const db = {
    query: (sql: string, bindings: Record<string, unknown> = {}) => ({
      collect: async () => collect(sql, bindings),
    }),
  };
  return new SessionGrants({ db: db as never, now });
}

describe("SessionGrants storage integrity", () => {
  test("requires a concrete database and clock", () => {
    expect(() => new SessionGrants({ db: {} as Surreal, now: Date.now })).toThrow(/SurrealDB/);
    expect(
      () =>
        new SessionGrants({
          db: { query: () => ({ collect: async () => [] }) } as never,
          now: undefined,
        } as never),
    ).toThrow(/clock/);
  });

  test("grant accepts only canonical authority and returns the exact persisted row", async () => {
    let nativeId = false;
    const service = serviceWithCollector((_sql, bindings) => {
      nativeId = bindings.rowId instanceof RecordId;
      const row = storedGrant({
        id: bindings.rowId as RecordId<"agent_session">,
        client: bindings.client,
        granted_at: bindings.grantedAt,
        expires_at: bindings.expiresAt,
        allowed_folders: bindings.allowedFolders,
        allowed_tools: bindings.allowedTools,
        max_writes: bindings.maxWrites,
      });
      return [undefined, mutationGrant(row), undefined, [{ ...row }]];
    });
    const grant = await service.grant({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      allowedTools: ["notes.create"],
      maxWrites: 3,
      ttlMinutes: 30,
    });
    expect(nativeId).toBe(true);
    expect(grant).toMatchObject({
      client: "claude-code",
      allowedFolders: ["Inbox/"],
      allowedTools: ["notes.create"],
      maxWrites: 3,
      usedWrites: 0,
      revokedAt: null,
    });
  });

  test.each([
    ["missing statement", (row: StoredGrantFixture) => [undefined, row, undefined]],
    ["non-native BEGIN", (row: StoredGrantFixture) => [[], row, undefined, [row]]],
    ["array create guard", (row: StoredGrantFixture) => [undefined, [row], undefined, [row]]],
    ["empty SELECT", (row: StoredGrantFixture) => [undefined, row, undefined, []]],
    ["multiple SELECT rows", (row: StoredGrantFixture) => [undefined, row, undefined, [row, row]]],
    [
      "projected NONE in create row",
      (row: StoredGrantFixture) => [undefined, row, undefined, [row]],
    ],
  ])("grant rejects malformed create envelope: %s", async (_label, envelope) => {
    const service = serviceWithCollector((_sql, bindings) => {
      const row = storedGrant({
        id: bindings.rowId as RecordId<"agent_session">,
        client: bindings.client,
        granted_at: bindings.grantedAt,
        expires_at: bindings.expiresAt,
        allowed_folders: bindings.allowedFolders,
        allowed_tools: bindings.allowedTools,
        max_writes: bindings.maxWrites,
      });
      return envelope(row);
    });
    await expect(
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        allowedTools: ["notes.create"],
        maxWrites: 3,
        ttlMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(SessionGrantIntegrityError);
  });

  test.each([
    ["string id", { id: storedGrant().id.toString() }],
    ["null max_writes", { max_writes: null }],
    ["null revoked_at", { revoked_at: null }],
    ["used beyond max", { max_writes: 2, used_writes: 3 }],
    ["revoked before grant", { revoked_at: 999 }],
    ["unsafe used counter", { used_writes: Number.MAX_SAFE_INTEGER + 1 }],
    ["traversal folder", { allowed_folders: ["../Inbox/"] }],
    ["invalid tool", { allowed_tools: ["notes-create"] }],
    ["extra field", { legacy_scope: "Inbox/" }],
  ])("list fails closed for malformed canonical row field: %s", async (_label, overrides) => {
    const row = { ...storedGrant(), ...overrides };
    const { service } = serviceWithResponses([[[row]]]);
    await expect(service.list({ activeOnly: false })).rejects.toBeInstanceOf(
      SessionGrantIntegrityError,
    );
  });

  test.each([
    ["no statements", []],
    ["two statements", [[storedGrant()], []]],
    ["non-array slice", [storedGrant()]],
    ["null slice", [null]],
  ])("list rejects malformed one-statement envelope: %s", async (_label, response) => {
    const { service } = serviceWithResponses([response]);
    await expect(service.list({ activeOnly: false })).rejects.toBeInstanceOf(
      SessionGrantIntegrityError,
    );
  });

  test("list validates its filters and the database filter result", async () => {
    const { service: invalidClient } = serviceWithResponses([]);
    await expect(invalidClient.list({ client: " claude-code", activeOnly: false })).rejects.toThrow(
      /canonical agent id/,
    );
    await expect(invalidClient.list({ activeOnly: "yes" } as never)).rejects.toThrow(/boolean/);
    await expect(invalidClient.list({ activeOnly: false, legacy: true } as never)).rejects.toThrow(
      /unknown field/,
    );

    const { service: expired } = serviceWithResponses([[[storedGrant({ expires_at: 1_500 })]]]);
    await expect(expired.list({ activeOnly: true })).rejects.toBeInstanceOf(
      SessionGrantIntegrityError,
    );
  });

  test.each([
    ["non-canonical client", { client: " claude-code" }],
    ["missing folder slash", { allowedFolders: ["Inbox"] }],
    ["absolute folder", { allowedFolders: ["/Inbox/"] }],
    ["traversal folder", { allowedFolders: ["../Inbox/"] }],
    ["duplicate folders", { allowedFolders: ["Inbox/", "Inbox/"] }],
    ["non-canonical tool", { allowedTools: [" notes.create"] }],
    ["invalid tool", { allowedTools: ["notes-create"] }],
    ["duplicate tools", { allowedTools: ["notes.create", "notes.create"] }],
    ["mixed wildcard", { allowedTools: ["*", "notes.create"] }],
    ["null max", { maxWrites: null }],
    ["unsafe max", { maxWrites: Number.MAX_SAFE_INTEGER + 1 }],
    ["fractional TTL", { ttlMinutes: 1.5 }],
    ["unknown field", { legacy: true }],
  ])("grant rejects non-canonical input: %s", async (_label, overrides) => {
    const { service } = serviceWithResponses([]);
    await expect(
      service.grant({
        client: "claude-code",
        allowedFolders: ["Inbox/"],
        allowedTools: ["notes.create"],
        ttlMinutes: 30,
        ...overrides,
      } as never),
    ).rejects.toBeInstanceOf(Error);
  });

  test("grant and list reject unsafe clock readings before querying", async () => {
    const { service, queries } = serviceWithResponses([], () => Number.NaN);
    await expect(
      service.grant({ client: "claude-code", allowedFolders: ["Inbox/"], ttlMinutes: 30 }),
    ).rejects.toThrow(/clock/);
    await expect(service.list({ activeOnly: true })).rejects.toThrow(/clock/);
    expect(queries).toHaveLength(0);
  });

  test("claim enforces exact 0-or-1 update cardinality and returned counter", async () => {
    const candidate = storedGrant({ max_writes: 3 });
    const { service: duplicate } = serviceWithResponses([[[candidate]], [[candidate, candidate]]]);
    await expect(
      duplicate.claim({
        client: "claude-code",
        tool: "notes.create",
        folder: "Inbox/",
        now: 1_500,
      }),
    ).rejects.toBeInstanceOf(SessionGrantIntegrityError);

    const wrongCount = storedGrant({ max_writes: 3, used_writes: 2 });
    const { service: mismatch } = serviceWithResponses([
      [[candidate]],
      [[mutationGrant(wrongCount)]],
    ]);
    await expect(
      mismatch.claim({
        client: "claude-code",
        tool: "notes.create",
        folder: "Inbox/",
        now: 1_500,
      }),
    ).rejects.toBeInstanceOf(SessionGrantIntegrityError);

    const unlimited = storedGrant();
    const projectedUpdate = storedGrant({ used_writes: 1 });
    const { service: wrongNoneShape } = serviceWithResponses([[[unlimited]], [[projectedUpdate]]]);
    await expect(
      wrongNoneShape.claim({
        client: "claude-code",
        tool: "notes.create",
        folder: "Inbox/",
        now: 1_500,
      }),
    ).rejects.toBeInstanceOf(SessionGrantIntegrityError);
  });

  test("claim validates its canonical client, tool, folder, clock, and fields", async () => {
    const { service } = serviceWithResponses([]);
    for (const writeCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
      await expect(
        service.claim({
          client: "claude-code",
          tool: "agent.distill",
          folder: "Notient/proposals/",
          now: 1500,
          writeCount,
        } as never),
      ).rejects.toThrow("writeCount");
    }
    for (const query of [
      { client: " claude-code", tool: "notes.create", folder: "Inbox/", now: 1_500 },
      { client: "claude-code", tool: "*", folder: "Inbox/", now: 1_500 },
      { client: "claude-code", tool: "notes.create", folder: "Inbox/note.md", now: 1_500 },
      { client: "claude-code", tool: "notes.create", folder: "../Inbox/", now: 1_500 },
      { client: "claude-code", tool: "notes.create", folder: "Inbox/", now: 1.5 },
      {
        client: "claude-code",
        tool: "notes.create",
        folder: "Inbox/",
        now: 1_500,
        legacy: true,
      },
    ]) {
      await expect(service.claim(query as never)).rejects.toBeInstanceOf(Error);
    }
  });

  test("revoke enforces find/update cardinality and returns the stored update", async () => {
    const fixture = storedGrant();
    const { service: duplicateFind } = serviceWithResponses([[[fixture, fixture]]]);
    await expect(duplicateFind.revoke(fixture.id.toString())).rejects.toBeInstanceOf(
      SessionGrantIntegrityError,
    );

    const { service: missingUpdate } = serviceWithResponses([[[fixture]], [[]]]);
    await expect(missingUpdate.revoke(fixture.id.toString())).rejects.toBeInstanceOf(
      SessionGrantIntegrityError,
    );

    const revokedFixture = storedGrant({ revoked_at: 1_500 });
    const { service: successful } = serviceWithResponses([
      [[fixture]],
      [[mutationGrant(revokedFixture)]],
    ]);
    await expect(successful.revoke(fixture.id.toString())).resolves.toMatchObject({
      id: fixture.id.toString(),
      revokedAt: 1_500,
    });
  });

  test.each([
    ["JSON-string tools", { allowed_tools: '["notes.create"]' }],
    ["empty tools", { allowed_tools: [] }],
    ["ambiguous wildcard", { allowed_tools: ["*", "notes.create"] }],
    ["non-canonical folder", { allowed_folders: ["Inbox"] }],
    ["duplicate folder", { allowed_folders: ["Inbox/", "Inbox/"] }],
  ])("list fails closed for %s", async (_label, overrides) => {
    const { service } = serviceReturning(storedGrant(overrides));
    await expect(service.list({ activeOnly: false })).rejects.toBeInstanceOf(
      SessionGrantIntegrityError,
    );
  });

  test("claim rejects corrupt authority before issuing an update", async () => {
    const { service, queries } = serviceReturning(
      storedGrant({ allowed_tools: '["notes.create"]' }),
    );

    await expect(
      service.claim({
        client: "claude-code",
        tool: "notes.create",
        folder: "Inbox/",
        now: 1_500,
      }),
    ).rejects.toBeInstanceOf(SessionGrantIntegrityError);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toStartWith("SELECT");
  });
});
