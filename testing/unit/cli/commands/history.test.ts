import { describe, expect, test } from "bun:test";
import type { ClientHandle, ClientOptions, RpcResponseFrame } from "../../../../src/cli/client";
import { parseHistoryLimit, runHistoryCommand } from "../../../../src/cli/commands/history";
import type { StructuredEvent } from "../../../../src/cli/output";
import {
  HISTORY_FIXTURE_ID as HISTORY_ID,
  historyDetailFixture,
  historyEntryFixture,
  historyListFixture,
  historyUndoFixture,
} from "../../../historyFixture";

function harness(results: Record<string, Record<string, unknown>>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const events: StructuredEvent[] = [];
  let closed = false;
  const client: ClientHandle = {
    principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    call(method, params) {
      calls.push({ method, params });
      return (async function* () {
        if (!results[method]) throw new Error(`Unexpected method ${method}`);
        yield { id: "req-1", type: "result", ...results[method] } as RpcResponseFrame;
      })();
    },
    close: async () => {
      closed = true;
    },
  };
  return {
    calls,
    events,
    wasClosed: () => closed,
    emitter: { emit: (event: StructuredEvent) => events.push(event) },
    connect: async (_options: ClientOptions) => client,
  };
}

describe("history CLI", () => {
  test("lists bounded canonical metadata, including completed undo", async () => {
    const entry = historyUndoFixture().entry;
    const h = harness({ "history.list": historyListFixture([entry]) });
    expect(await runHistoryCommand({ action: "list", vaultPath: "/vault", limit: 7, ...h })).toBe(
      0,
    );
    expect(h.calls).toEqual([{ method: "history.list", params: { limit: 7 } }]);
    expect(h.events).toEqual([{ type: "history:entry", ...entry }]);
    expect(h.wasClosed()).toBe(true);
  });
  test("undo submits exact saved sources and a stable explicit target", async () => {
    const detail = historyDetailFixture();
    const h = harness({ "history.get": detail, "history.undo": historyUndoFixture() });
    expect(
      await runHistoryCommand({ action: "undo", vaultPath: "/vault", historyId: HISTORY_ID, ...h }),
    ).toBe(0);
    expect(h.calls).toEqual([
      { method: "history.get", params: { id: HISTORY_ID } },
      {
        method: "history.undo",
        params: { id: HISTORY_ID, sources: detail.sources, idempotencyKey: `undo:${HISTORY_ID}` },
      },
    ]);
    expect(h.events[0]).toEqual({ type: "history:undo_requested", id: HISTORY_ID });
    expect(h.events[1]).toEqual({ type: "history:undone", entry: historyUndoFixture().entry });
    expect(h.wasClosed()).toBe(true);
  });
  test("latest undo skips completed and non-reversible audit entries", async () => {
    const entry = historyEntryFixture();
    const h = harness({
      "history.list": historyListFixture([
        historyUndoFixture(
          historyEntryFixture({ id: HISTORY_ID.replace("000000000001", "000000000002") }),
        ).entry,
        historyEntryFixture({
          id: HISTORY_ID.replace("000000000001", "000000000003"),
          reversible: false,
        }),
        entry,
      ]),
      "history.get": historyDetailFixture(entry),
      "history.undo": historyUndoFixture(entry),
    });
    expect(await runHistoryCommand({ action: "undo", vaultPath: "/vault", ...h })).toBe(0);
    expect(h.calls.at(-1)?.params.id).toBe(entry.id);
  });
  test("conflict preserves the domain code and does not retry", async () => {
    const h = harness({
      "history.get": historyDetailFixture(),
      "history.undo": { type: "error", code: "CONFLICT", message: "The note changed." },
    });
    expect(
      await runHistoryCommand({ action: "undo", vaultPath: "/vault", historyId: HISTORY_ID, ...h }),
    ).toBe(1);
    expect(h.calls.filter((call) => call.method === "history.undo")).toHaveLength(1);
    expect(h.events.at(-1)).toEqual({
      type: "error",
      code: "CONFLICT",
      message: "The note changed.",
    });
  });
  test("malformed entries fail validation and close the connection", async () => {
    const h = harness({ "history.list": { ...historyListFixture(), entries: [{}] } });
    await expect(
      runHistoryCommand({ action: "list", vaultPath: "/vault", ...h }),
    ).rejects.toThrow();
    expect(h.events).toEqual([]);
    expect(h.wasClosed()).toBe(true);
  });
  test("incomplete undo responses cannot report successful restoration", async () => {
    const h = harness({
      "history.get": historyDetailFixture(),
      "history.undo": { ok: true, entry: historyEntryFixture() },
    });
    await expect(
      runHistoryCommand({ action: "undo", vaultPath: "/vault", historyId: HISTORY_ID, ...h }),
    ).rejects.toThrow();
    expect(h.events.some((event) => event.type === "history:undone")).toBe(false);
    expect(h.wasClosed()).toBe(true);
  });
  test("limit parser enforces the API bounds", () => {
    expect(parseHistoryLimit(undefined)).toBeUndefined();
    expect(parseHistoryLimit("12")).toBe(12);
    for (const value of ["0", "1.5", "201", "nope", true])
      expect(() => parseHistoryLimit(value)).toThrow(/between 1 and 200/);
  });
});
