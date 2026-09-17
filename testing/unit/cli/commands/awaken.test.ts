import { describe, expect, test } from "bun:test";
import type { ClientHandle, RpcResponseFrame } from "../../../../src/cli/client";
import {
  parseAwakenSince,
  parseTierCsv,
  runAwakenCommand,
} from "../../../../src/cli/commands/awaken";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { FULL_INDEX_TIER_FILTER } from "../../../../src/core/indexer/tierFilter";

const RUN_ID = createUuidRecordId("awaken_run", "018f05cd-3f7b-7000-8000-000000000001").toString();

function fakeClient(
  frames: RpcResponseFrame[],
  options: { closeError?: Error } = {},
): { client: ClientHandle; calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
      call(method, params) {
        calls.push({ method, params });
        return (async function* () {
          if (frames[0]?.type !== "ack") {
            yield { id: frames[0]?.id ?? "req-1", type: "ack", method };
          }
          for (const frame of frames) yield frame;
        })();
      },
      close: async () => {
        if (options.closeError !== undefined) throw options.closeError;
      },
    },
  };
}

describe("parseTierCsv", () => {
  test("returns the full filter only when the flag is omitted", () => {
    expect(parseTierCsv(undefined)).toEqual([...FULL_INDEX_TIER_FILTER]);
    expect(() => parseTierCsv(true)).toThrow(/requires a comma-separated subset/);
  });

  test("rejects an empty string", () => {
    expect(() => parseTierCsv("")).toThrow(/requires a comma-separated subset/);
  });

  test("parses a single tier", () => {
    expect(parseTierCsv("1")).toEqual([1]);
    expect(parseTierCsv("2")).toEqual([2]);
    expect(parseTierCsv("3")).toEqual([3]);
  });

  test("parses a two-tier subset", () => {
    expect(parseTierCsv("2,3")).toEqual([2, 3]);
  });

  test("parses the full `[1, 2, 3]` filter", () => {
    expect(parseTierCsv("1,2,3")).toEqual([1, 2, 3]);
  });

  test("trims whitespace around tokens", () => {
    expect(parseTierCsv("1, 2, 3")).toEqual([1, 2, 3]);
    expect(parseTierCsv("  2 , 3  ")).toEqual([2, 3]);
  });

  test("de-duplicates and sorts the result", () => {
    expect(parseTierCsv("3,1,2,1")).toEqual([1, 2, 3]);
    expect(parseTierCsv("2,2")).toEqual([2]);
  });

  test("rejects invalid tokens", () => {
    expect(() => parseTierCsv("abc")).toThrow(/received abc/);
    expect(() => parseTierCsv("0,5")).toThrow(/received 0/);
    expect(() => parseTierCsv("99")).toThrow(/received 99/);
  });

  test("rejects mixed-validity input instead of broadening or narrowing it", () => {
    expect(() => parseTierCsv("0,2,5")).toThrow(/received 0/);
    expect(() => parseTierCsv("abc,1,xyz")).toThrow(/received abc/);
  });
});

describe("parseAwakenSince", () => {
  test("accepts an exact ISO date or timezone-qualified instant", () => {
    expect(parseAwakenSince("2026-08-30")).toBe(Date.parse("2026-08-30"));
    expect(parseAwakenSince("2026-08-30T12:34:56.789Z")).toBe(
      Date.parse("2026-08-30T12:34:56.789Z"),
    );
    expect(parseAwakenSince("2026-08-30T07:34:56-05:00")).toBe(
      Date.parse("2026-08-30T07:34:56-05:00"),
    );
  });

  test("rejects parser aliases, normalized dates, missing zones, and bare flags", () => {
    for (const value of [
      true,
      "tomorrow",
      "2026-02-30",
      "2026-08-30T12:34:56",
      " 2026-08-30",
      "2026-08-30T12:34:56+15:00",
    ]) {
      expect(() => parseAwakenSince(value)).toThrow(/--since/);
    }
  });
});

describe("awaken run CLI wire boundary", () => {
  test("sends canonical run params and emits an exact background result", async () => {
    const rpc = fakeClient([
      { id: "req-1", type: "ack", method: "awaken.run" },
      {
        id: "req-1",
        type: "result",
        ok: true,
        queued: 4,
        tier: [2, 3],
        runId: RUN_ID,
        status: "running",
        background: true,
      },
    ]);
    const events: Record<string, unknown>[] = [];
    const code = await runAwakenCommand({
      vaultPath: "/vault",
      since: 123,
      tier: [2, 3],
      background: true,
      emitter: { emit: (event) => events.push(event) },
      connect: async () => rpc.client,
    });
    expect(code).toBe(0);
    expect(rpc.calls).toEqual([
      {
        method: "awaken.run",
        params: { since: 123, tier: [2, 3], background: true },
      },
    ]);
    expect(events.at(-1)).toEqual({
      id: "req-1",
      ok: true,
      queued: 4,
      tier: [2, 3],
      runId: RUN_ID,
      status: "running",
      background: true,
      type: "rpc:result",
    });
  });

  test("returns nonzero for daemon errors and a stream with no terminal frame", async () => {
    const errorRpc = fakeClient([
      {
        id: "req-1",
        type: "error",
        code: "INVALID_PARAMS",
        message: "a run is already active",
        detail: {},
      },
    ]);
    const errorEvents: Record<string, unknown>[] = [];
    expect(
      await runAwakenCommand({
        vaultPath: "/vault",
        emitter: { emit: (event) => errorEvents.push(event) },
        connect: async () => errorRpc.client,
      }),
    ).toBe(1);
    expect(errorEvents.at(-1)?.type).toBe("rpc:error");

    const emptyRpc = fakeClient([]);
    const emptyEvents: Record<string, unknown>[] = [];
    expect(
      await runAwakenCommand({
        vaultPath: "/vault",
        emitter: { emit: (event) => emptyEvents.push(event) },
        connect: async () => emptyRpc.client,
      }),
    ).toBe(1);
    expect(emptyEvents.at(-1)?.message).toContain("returned no result");
  });

  test("rejects extra result fields and duplicate terminal frames", async () => {
    const validResult: RpcResponseFrame = {
      id: "req-1",
      type: "result",
      ok: true,
      queued: 1,
      tier: [1, 2, 3],
      runId: RUN_ID,
      status: "completed",
      processed: 1,
      failed: 0,
    };
    const extraRpc = fakeClient([{ ...validResult, compatibilityStatus: "done" }]);
    const extraEvents: Record<string, unknown>[] = [];
    expect(
      await runAwakenCommand({
        vaultPath: "/vault",
        emitter: { emit: (event) => extraEvents.push(event) },
        connect: async () => extraRpc.client,
      }),
    ).toBe(1);
    expect(extraEvents.at(-1)?.message).toContain("unsupported fields");

    const duplicateRpc = fakeClient([validResult, validResult]);
    const duplicateEvents: Record<string, unknown>[] = [];
    expect(
      await runAwakenCommand({
        vaultPath: "/vault",
        emitter: { emit: (event) => duplicateEvents.push(event) },
        connect: async () => duplicateRpc.client,
      }),
    ).toBe(1);
    expect(duplicateEvents.at(-1)?.message).toContain("duplicate terminal");
  });

  test("does not emit success when connection close fails", async () => {
    const rpc = fakeClient(
      [
        {
          id: "req-1",
          type: "result",
          ok: true,
          queued: 0,
          tier: [1, 2, 3],
          runId: RUN_ID,
          status: "completed",
          processed: 0,
          failed: 0,
        },
      ],
      { closeError: new Error("socket close failed") },
    );
    const events: Record<string, unknown>[] = [];
    expect(
      await runAwakenCommand({
        vaultPath: "/vault",
        emitter: { emit: (event) => events.push(event) },
        connect: async () => rpc.client,
      }),
    ).toBe(1);
    expect(events.filter((event) => event.type === "rpc:result")).toEqual([]);
    expect(events.at(-1)?.message).toContain("connection close failed");
  });
});
