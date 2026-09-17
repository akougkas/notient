import { describe, expect, test } from "bun:test";
import type { ClientHandle, RpcResponseFrame } from "../../../../src/cli/client";
import { acquireGraphMaintenanceLease } from "../../../../src/cli/commands/maintenanceLease";

function resultFrames(method: string, result: Record<string, unknown>): RpcResponseFrame[] {
  return [
    { id: method, type: "ack", method },
    { id: method, type: "result", ...result },
  ];
}

describe("acquireGraphMaintenanceLease", () => {
  test("holds begin and end on one authenticated connection and returns vault drift", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let closed = 0;
    const client: ClientHandle = {
      principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
      call: async function* (method, params) {
        calls.push({ method, params });
        const frames =
          method === "maintenance.begin"
            ? resultFrames(method, { ok: true, operation: "backup" })
            : resultFrames(method, { ok: true, vaultChanged: true });
        for (const frame of frames) yield frame;
      },
      close: async () => {
        closed += 1;
      },
    };

    const lease = await acquireGraphMaintenanceLease({
      vaultPath: "/vault",
      operation: "backup",
      connect: async () => client,
    });
    expect(await lease.release()).toEqual({ vaultChanged: true });
    expect(calls).toEqual([
      { method: "maintenance.begin", params: { operation: "backup" } },
      { method: "maintenance.end", params: {} },
    ]);
    expect(closed).toBe(1);
  });

  test("closes the connection when the daemon refuses maintenance", async () => {
    let closed = 0;
    const client: ClientHandle = {
      principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
      call: async function* (method) {
        yield { id: method, type: "ack", method };
        yield {
          id: method,
          type: "error",
          code: "DAEMON_MAINTENANCE",
          message: "busy",
          detail: {},
        };
      },
      close: async () => {
        closed += 1;
      },
    };

    await expect(
      acquireGraphMaintenanceLease({
        vaultPath: "/vault",
        operation: "restore",
        connect: async () => client,
      }),
    ).rejects.toThrow("DAEMON_MAINTENANCE: busy");
    expect(closed).toBe(1);
  });

  test("poisons a failed restore on the owning connection without sending end", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let closed = 0;
    const client: ClientHandle = {
      principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
      call: async function* (method, params) {
        calls.push({ method, params });
        yield* resultFrames(method, { ok: true, poisoned: true, operation: "restore" });
      },
      close: async () => {
        closed += 1;
      },
    };
    const lease = await acquireGraphMaintenanceLease({
      vaultPath: "/vault",
      operation: "restore",
      connect: async () => client,
    });

    await lease.poison();

    expect(calls).toEqual([
      { method: "maintenance.begin", params: { operation: "restore" } },
      { method: "maintenance.poison", params: {} },
    ]);
    expect(closed).toBe(1);
  });
});
