import { describe, expect, test } from "bun:test";
import type { ClientHandle, RpcResponseFrame } from "../../../../src/cli/client";
import {
  callRpc,
  createReconnectingCaller,
  isDisconnect,
  isReplayable,
} from "../../../../src/cli/mcp/rpcBridge";

function handleYielding(frames: RpcResponseFrame[]): ClientHandle {
  return {
    call() {
      return (async function* () {
        for (const frame of frames) yield frame;
      })();
    },
    async close() {
      /* no-op */
    },
    principal: { id: "test-agent", kind: "agent", scopes: ["read", "write"] },
  };
}

function handleThrowing(error: Error): ClientHandle {
  return {
    call() {
      return (async function* () {
        throw error;
        // biome-ignore lint/correctness/noUnreachable: unreachable yield fixes the generator element type
        yield {} as RpcResponseFrame;
      })();
    },
    async close() {
      /* no-op */
    },
    principal: { id: "test-agent", kind: "agent", scopes: ["read", "write"] },
  };
}

describe("callRpc", () => {
  test("drains ack and event frames and strips the envelope from the result", async () => {
    const handle = handleYielding([
      { id: "req-1", type: "ack", method: "search.run" },
      {
        id: "req-1",
        type: "event",
        event: "search:progress",
        stage: "lexical",
      },
      { id: "req-1", type: "result", ok: true, result: { hits: [] } },
    ]);
    const outcome = await callRpc(handle, "search.run", { query: "x" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toEqual({ ok: true, result: { hits: [] } });
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0].event).toBe("search:progress");
  });

  test("folds an error frame into a failure with the daemon code", async () => {
    const handle = handleYielding([
      { id: "req-1", type: "ack", method: "vitals.get" },
      {
        id: "req-1",
        type: "error",
        code: "INVALID_PARAMS",
        message: "note not indexed",
      },
    ]);
    const outcome = await callRpc(handle, "vitals.get", { path: "a.md" });
    expect(outcome).toEqual({
      ok: false,
      code: "INVALID_PARAMS",
      message: "note not indexed",
    });
  });

  test("reports INTERNAL when the stream ends without a terminal frame", async () => {
    const handle = handleYielding([{ id: "req-1", type: "ack", method: "vault.list" }]);
    const outcome = await callRpc(handle, "vault.list", {});
    expect(outcome).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});

describe("isDisconnect", () => {
  test("recognizes the client's DAEMON_DISCONNECTED prefix", () => {
    expect(isDisconnect(new Error("DAEMON_DISCONNECTED: daemon closed the connection"))).toBe(true);
    expect(isDisconnect(new Error("INVALID_PARAMS: nope"))).toBe(false);
  });
});

describe("createReconnectingCaller", () => {
  test("connects lazily and reuses the handle across calls", async () => {
    let connects = 0;
    const caller = createReconnectingCaller(async () => {
      connects++;
      return handleYielding([{ id: "req-1", type: "result", ok: true }]);
    });
    expect(connects).toBe(0);
    await caller.call("daemon.status", {});
    await caller.call("daemon.status", {});
    expect(connects).toBe(1);
    await caller.close();
  });

  test("reconnects exactly once after a disconnect and replays the call", async () => {
    let connects = 0;
    const caller = createReconnectingCaller(async () => {
      connects++;
      if (connects === 1) {
        return handleThrowing(new Error("DAEMON_DISCONNECTED: daemon closed the connection"));
      }
      return handleYielding([{ id: "req-1", type: "result", ok: true, pid: 42 }]);
    });
    const outcome = await caller.call("vault.stats", {});
    expect(connects).toBe(2);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.pid).toBe(42);
    await caller.close();
  });

  test("returns a DAEMON_DISCONNECTED failure when the retry also disconnects", async () => {
    let connects = 0;
    const caller = createReconnectingCaller(async () => {
      connects++;
      return handleThrowing(new Error("DAEMON_DISCONNECTED: daemon closed the connection"));
    });
    const outcome = await caller.call("vault.stats", {});
    expect(connects).toBe(2);
    expect(outcome).toMatchObject({ ok: false, code: "DAEMON_DISCONNECTED" });
    await caller.close();
  });

  test("propagates a non-disconnect error instead of retrying", async () => {
    let connects = 0;
    const caller = createReconnectingCaller(async () => {
      connects++;
      return handleThrowing(new Error("boom"));
    });
    await expect(caller.call("daemon.status", {})).rejects.toThrow("boom");
    expect(connects).toBe(1);
    await caller.close();
  });

  test("close is a no-op before the first connect", async () => {
    let connects = 0;
    const caller = createReconnectingCaller(async () => {
      connects++;
      return handleYielding([]);
    });
    await caller.close();
    expect(connects).toBe(0);
  });
});

describe("createReconnectingCaller replay safety", () => {
  test("does not classify approval previews as reconnect-replayable reads", () => {
    expect(isReplayable("approvals.pending")).toBe(false);
  });

  test("does not replay notes.write after a disconnect", async () => {
    let connects = 0;
    const caller = createReconnectingCaller(async () => {
      connects++;
      if (connects === 1) {
        return handleThrowing(new Error("DAEMON_DISCONNECTED: daemon closed the connection"));
      }
      return handleYielding([{ id: "req-1", type: "result", ok: true, applied: true }]);
    });
    const outcome = await caller.call("notes.write", {
      path: "a.md",
      content: "x",
    });
    expect(connects).toBe(1);
    expect(outcome).toMatchObject({ ok: false, code: "DAEMON_DISCONNECTED" });
    await caller.close();
  });

  test("does not replay any mutating method, including proposals.propose_link", async () => {
    for (const method of [
      "chat.send",
      "agent.distill",
      "awaken.run",
      "reindex.glob",
      "proposals.propose_link",
    ]) {
      let connects = 0;
      const caller = createReconnectingCaller(async () => {
        connects++;
        return handleThrowing(new Error("DAEMON_DISCONNECTED: daemon closed the connection"));
      });
      const outcome = await caller.call(method, {});
      expect(connects).toBe(1);
      expect(outcome).toMatchObject({ ok: false, code: "DAEMON_DISCONNECTED" });
      await caller.close();
    }
  });

  test("never replays provider-touching reads after an ambiguous disconnect", async () => {
    for (const method of [
      "ask.run",
      "brief.run",
      "daemon.model_catalog",
      "daemon.status",
      "health.probe",
      "search.run",
    ]) {
      let connects = 0;
      const caller = createReconnectingCaller(async () => {
        connects++;
        return handleThrowing(new Error("DAEMON_DISCONNECTED: daemon closed the connection"));
      });
      const outcome = await caller.call(method, { query: "private query" });
      expect(connects).toBe(1);
      expect(outcome).toMatchObject({ ok: false, code: "DAEMON_DISCONNECTED" });
      await caller.close();
    }
  });

  test("two concurrent first calls share a single connect", async () => {
    let connects = 0;
    const caller = createReconnectingCaller(async () => {
      connects++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return handleYielding([{ id: "req-1", type: "result", ok: true }]);
    });
    await Promise.all([caller.call("daemon.status", {}), caller.call("daemon.status", {})]);
    expect(connects).toBe(1);
    await caller.close();
  });

  test("a late disconnect from a retired handle cannot discard its healthy replacement", async () => {
    let connects = 0;
    let oldCalls = 0;
    let releaseLateDisconnect = (): void => {};
    const lateDisconnect = new Promise<void>((resolve) => {
      releaseLateDisconnect = resolve;
    });
    let replacementUsed = (): void => {};
    const replacementCall = new Promise<void>((resolve) => {
      replacementUsed = resolve;
    });
    const oldHandle: ClientHandle = {
      call() {
        const callNumber = ++oldCalls;
        return (async function* () {
          if (callNumber > 1) await lateDisconnect;
          throw new Error("DAEMON_DISCONNECTED: retired handle closed");
          // biome-ignore lint/correctness/noUnreachable: unreachable yield fixes generator type
          yield {} as RpcResponseFrame;
        })();
      },
      async close() {},
      principal: { id: "test-agent", kind: "agent", scopes: ["read"] },
    };
    const newHandle: ClientHandle = {
      call() {
        replacementUsed();
        return (async function* () {
          yield { id: "req-new", type: "result", ok: true } as RpcResponseFrame;
        })();
      },
      async close() {},
      principal: { id: "test-agent", kind: "agent", scopes: ["read"] },
    };
    const caller = createReconnectingCaller(async () => {
      connects++;
      return connects === 1 ? oldHandle : newHandle;
    });

    const first = caller.call("vault.stats", {});
    const second = caller.call("vault.stats", {});
    await replacementCall;
    releaseLateDisconnect();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
    await expect(caller.call("vault.stats", {})).resolves.toMatchObject({
      ok: true,
    });
    expect(connects).toBe(2);
    await caller.close();
  });
});
