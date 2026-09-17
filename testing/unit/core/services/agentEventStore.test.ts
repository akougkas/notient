import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { wrapNativeValue } from "../../../../src/core/db/nativeValue";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { EventBus } from "../../../../src/core/events/eventBus";
import { AgentEventStore } from "../../../../src/core/services/agentEventStore";

function dbReturning(result: unknown): Surreal {
  return {
    query: () => ({ collect: async () => result }),
  } as unknown as Surreal;
}

function makeStore(result: unknown): AgentEventStore {
  return new AgentEventStore({
    db: dbReturning(result),
    bus: new EventBus(),
    maxRows: 50_000,
  });
}

function persistedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: createUuidRecordId("agent_event", "0198f4f0-1234-7000-8000-000000000001"),
    kind: "swarm:link_proposed",
    payload: wrapNativeValue({ edgeId: "related_to:0123456789abcdefghij" }),
    ts_ms: 1_800_000_000_000,
    ...overrides,
  };
}

describe("AgentEventStore storage integrity", () => {
  test.each([undefined, null, 0, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects non-canonical maxRows %p",
    (maxRows) => {
      expect(
        () =>
          new AgentEventStore({
            db: dbReturning([[]]),
            bus: new EventBus(),
            maxRows: maxRows as number,
          }),
      ).toThrow("maxRows must be a positive safe integer");
    },
  );

  test("decodes a valid native event row", async () => {
    const store = makeStore([[persistedRow()]]);
    await expect(store.since(null, 1)).resolves.toEqual([
      {
        id: 'agent_event:u"0198f4f0-1234-7000-8000-000000000001"',
        payload: { edgeId: "related_to:0123456789abcdefghij" },
        ts: 1_800_000_000_000,
        type: "swarm:link_proposed",
      },
    ]);
    store.dispose();
  });

  test("rejects an unsupported persisted event kind", async () => {
    const store = makeStore([[persistedRow({ kind: "swarm:imagined" })]]);
    await expect(store.since(null, 1)).rejects.toThrow("kind is not a supported event type");
    store.dispose();
  });

  test.each([null, "1", -1, 1.5, Number.NaN, 2 ** 53])(
    "rejects malformed persisted timestamp %p",
    async (ts_ms) => {
      const store = makeStore([[persistedRow({ ts_ms })]]);
      await expect(store.since(null, 1)).rejects.toThrow("timestamp");
      store.dispose();
    },
  );

  test("rejects malformed statement envelopes", async () => {
    const store = makeStore([]);
    await expect(store.since(null, 1)).rejects.toThrow("invalid statement envelope");
    store.dispose();
  });

  test("distinguishes a valid empty count from a malformed count row", async () => {
    const empty = makeStore([[]]);
    await expect(empty.countSince(null)).resolves.toBe(0);
    empty.dispose();

    const malformed = makeStore([[{}]]);
    await expect(malformed.countSince(null)).rejects.toThrow("count");
    malformed.dispose();
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects non-canonical query limit %p",
    async (limit) => {
      const store = makeStore([[]]);
      await expect(store.since(null, limit)).rejects.toThrow(
        "since limit must be a positive safe integer",
      );
      store.dispose();
    },
  );
});
