import { describe, expect, test } from "bun:test";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import type { SessionGrant, SessionGrants } from "../../../../src/core/services/sessionGrants";
import { makeSessionGrantHandler } from "../../../../src/daemon/handlers/sessionGrant";
import { makeSessionListHandler } from "../../../../src/daemon/handlers/sessionList";
import { agentPrincipal, humanPrincipal, rpcRequest } from "../../../rpcRequest";

function sessionId(value: number): string {
  return createUuidRecordId(
    "agent_session",
    `018f05cd-3f7b-7000-8000-${value.toString().padStart(12, "0")}`,
  ).toString();
}

function makeGrant(client: string, id = sessionId(1)): SessionGrant {
  return {
    id,
    client,
    grantedAt: 0,
    expiresAt: 1,
    allowedFolders: ["Inbox/"],
    allowedTools: ["*"],
    maxWrites: null,
    usedWrites: 0,
    revokedAt: null,
  };
}

describe("session.grant param validation", () => {
  function build(): { handler: ReturnType<typeof makeSessionGrantHandler>; seen: unknown[] } {
    const seen: unknown[] = [];
    const sessionGrants = {
      grant: async (options: { client: string }) => {
        seen.push(options);
        return makeGrant(options.client);
      },
    } as unknown as SessionGrants;
    return { handler: makeSessionGrantHandler({ sessionGrants }), seen };
  }

  const VALID = { client: "claude-code", allowedFolders: ["Inbox/"], ttlMinutes: 30 };

  test("accepts an explicit agent id", async () => {
    const { handler, seen } = build();
    const result = await handler(rpcRequest(VALID));
    expect(result.ok).toBe(true);
    expect((seen[0] as { client: string }).client).toBe("claude-code");
  });

  test("rejects a missing client", async () => {
    const { handler } = build();
    expect(handler(rpcRequest({ allowedFolders: ["Inbox/"], ttlMinutes: 30 }))).rejects.toThrow(
      "client must be a non-empty agent id",
    );
  });

  test("rejects 'human' as the grant subject", async () => {
    const { handler } = build();
    expect(handler(rpcRequest({ ...VALID, client: "human" }))).rejects.toThrow(
      /must be an agent id/,
    );
  });

  test("rejects a malformed agent id", async () => {
    const { handler } = build();
    expect(handler(rpcRequest({ ...VALID, client: "Claude Code!" }))).rejects.toThrow(/agent id/i);
  });
});

describe("session.list scoping", () => {
  function build(): {
    handler: ReturnType<typeof makeSessionListHandler>;
    filters: Record<string, unknown>[];
  } {
    const filters: Record<string, unknown>[] = [];
    const sessionGrants = {
      list: async (filter: Record<string, unknown>) => {
        filters.push(filter);
        return [makeGrant("claude-code", sessionId(1)), makeGrant("codex", sessionId(2))];
      },
    } as unknown as SessionGrants;
    return { handler: makeSessionListHandler({ sessionGrants }), filters };
  }

  test("an agent principal is scoped to its own grants", async () => {
    const { handler, filters } = build();
    await handler(rpcRequest({}, { principal: agentPrincipal() }));
    expect(filters[0]).toEqual({ client: "claude-code" });
  });

  test("an agent principal cannot widen the filter to another client", async () => {
    const { handler, filters } = build();
    await handler(rpcRequest({ client: "codex" }, { principal: agentPrincipal() }));
    expect(filters[0].client).toBe("claude-code");
  });

  test("a human principal sees whatever filter it asked for", async () => {
    const { handler, filters } = build();
    await handler(rpcRequest({ client: "codex" }, { principal: humanPrincipal() }));
    expect(filters[0]).toEqual({ client: "codex" });
    await handler(rpcRequest({}, { requestId: "req-2", principal: humanPrincipal() }));
    expect(filters[1]).toEqual({});
  });
});
