import { describe, expect, test } from "bun:test";
import type { ClientHandle, ClientOptions, RpcResponseFrame } from "../../../../src/cli/client";
import { runLinksSyncCommand } from "../../../../src/cli/commands/linksSync";
import type { StructuredEvent } from "../../../../src/cli/output";

function harness(frame: RpcResponseFrame) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const events: StructuredEvent[] = [];
  let closed = false;
  const client: ClientHandle = {
    principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    call(method, params) {
      calls.push({ method, params });
      return (async function* () {
        yield frame;
      })();
    },
    close: async () => {
      closed = true;
    },
  };
  return {
    calls,
    events,
    closed: () => closed,
    emitter: { emit: (event: StructuredEvent) => events.push(event) },
    connect: async (_options: ClientOptions) => client,
  };
}

describe("links sync CLI", () => {
  test("returns nonzero when reconciliation reports unresolved failures", async () => {
    const test = harness({
      id: "req-1",
      type: "result",
      ok: true,
      replayed: 4,
      abandoned: 0,
      failed: 1,
    });
    const code = await runLinksSyncCommand({
      vaultPath: "/vault",
      emitter: test.emitter,
      connect: test.connect,
    });
    expect(code).toBe(1);
    expect(test.calls).toEqual([{ method: "links.sync", params: {} }]);
    expect(test.events).toEqual([{ type: "links:sync", replayed: 4, abandoned: 0, failed: 1 }]);
    expect(test.closed()).toBe(true);
  });

  test("preserves an admin authorization failure", async () => {
    const test = harness({
      id: "req-1",
      type: "error",
      code: "FORBIDDEN",
      message: "links.sync requires the 'admin' scope",
    });
    const code = await runLinksSyncCommand({
      vaultPath: "/vault",
      emitter: test.emitter,
      connect: test.connect,
    });
    expect(code).toBe(1);
    expect(test.events[0]).toMatchObject({ type: "error", code: "FORBIDDEN" });
    expect(test.closed()).toBe(true);
  });
});
