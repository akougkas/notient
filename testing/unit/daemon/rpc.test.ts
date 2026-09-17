import { describe, expect, test } from "bun:test";
import { NoteApiError } from "../../../src/api/schema";
import {
  AGENT_SCOPES,
  type ConnectionSession,
  HELLO_METHOD,
  HUMAN_SCOPES,
  MethodDispatcher,
  type Principal,
  RpcDispatchFence,
  type RpcEnvelope,
  RpcError,
  encodeAck,
  encodeError,
  encodeEvent,
  encodeResult,
  parseEnvelope,
} from "../../../src/daemon/rpc";

const HUMAN: Principal = { id: "human", kind: "human", scopes: [...HUMAN_SCOPES] };
const AGENT: Principal = { id: "claude-code", kind: "agent", scopes: [...AGENT_SCOPES] };

function sessionFor(principal: Principal | null): ConnectionSession {
  return { id: "conn-1", principal };
}

describe("envelope codec", () => {
  test("parseEnvelope accepts a well-formed request", () => {
    const line = JSON.stringify({ id: "req-1", method: "daemon.status", params: {} });
    const result = parseEnvelope(line);
    expect(result).toEqual({
      ok: true,
      envelope: { id: "req-1", method: "daemon.status", params: {} },
    });
  });

  test("parseEnvelope rejects non-JSON", () => {
    const result = parseEnvelope("not json");
    expect(result.ok).toBe(false);
  });

  test("parseEnvelope rejects missing id or method", () => {
    expect(parseEnvelope(JSON.stringify({ method: "x" })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ id: "x" })).ok).toBe(false);
  });

  test("parseEnvelope rejects frame-level identity and every surplus field", () => {
    const line = JSON.stringify({
      id: "req-1",
      method: "chat.start",
      params: {},
      clientIdentity: "claude-code",
    });
    expect(parseEnvelope(line)).toEqual({
      ok: false,
      reason: "envelope must contain exactly id, method, and params",
    });
    expect(
      parseEnvelope(JSON.stringify({ id: "req-1", method: "chat.start", params: {}, old: true }))
        .ok,
    ).toBe(false);
  });

  test.each([
    [{ id: "", method: "x", params: {} }, "id"],
    [{ id: " req-1", method: "x", params: {} }, "id"],
    [{ id: "req-1", method: " x", params: {} }, "method"],
    [{ id: "req-1", method: "x", params: null }, "params"],
    [{ id: "req-1", method: "x", params: [] }, "params"],
    [{ id: "req-1", method: "x" }, "exactly"],
  ])("rejects malformed canonical envelope %#", (value, reason) => {
    const parsed = parseEnvelope(JSON.stringify(value));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });

  test("encodeAck/event/result/error produce stable shapes", () => {
    expect(JSON.parse(encodeAck("req-1", "daemon.status"))).toEqual({
      id: "req-1",
      type: "ack",
      method: "daemon.status",
    });
    expect(JSON.parse(encodeEvent("req-1", "indexer:queued", { path: "a.md" }))).toEqual({
      id: "req-1",
      type: "event",
      event: "indexer:queued",
      path: "a.md",
    });
    expect(JSON.parse(encodeResult("req-1", { ok: true }))).toEqual({
      id: "req-1",
      type: "result",
      ok: true,
    });
    expect(JSON.parse(encodeError("req-1", "INVALID_PARAMS", "bad", { detail: 1 }))).toEqual({
      id: "req-1",
      type: "error",
      code: "INVALID_PARAMS",
      message: "bad",
      detail: { detail: 1 },
    });
    expect(() =>
      encodeError("req-1", "INVALID_PARAMS", "bad", null as unknown as Record<string, unknown>),
    ).toThrow(/detail must be an object/);
  });

  test("envelope fields survive a payload that carries the same keys", () => {
    expect(
      JSON.parse(encodeResult("req-1", { ok: true, id: "supports:abc", type: "edge" })),
    ).toEqual({
      id: "req-1",
      type: "result",
      ok: true,
    });
    expect(
      JSON.parse(encodeEvent("req-1", "indexer:queued", { id: "note:a", type: "x", event: "y" })),
    ).toEqual({
      id: "req-1",
      type: "event",
      event: "indexer:queued",
    });
    expect(
      JSON.parse(encodeError("req-1", "INVALID_PARAMS", "bad", { id: "other", type: "x" })),
    ).toEqual({
      id: "req-1",
      type: "error",
      code: "INVALID_PARAMS",
      message: "bad",
      detail: { id: "other", type: "x" },
    });
  });
});

describe("MethodDispatcher", () => {
  test("dispatches a registered method", async () => {
    const dispatcher = new MethodDispatcher();
    dispatcher.register("daemon.status", async () => ({ pid: 42 }), { kind: "read" });
    const lines: string[] = [];
    const envelope: RpcEnvelope = { id: "req-1", method: "daemon.status", params: {} };
    await dispatcher.dispatch(
      envelope,
      (line) => {
        lines.push(line);
      },
      sessionFor(HUMAN),
    );
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).type).toBe("ack");
    expect(JSON.parse(lines[1])).toEqual({
      id: "req-1",
      type: "result",
      pid: 42,
    });
  });

  test("a payload key named id cannot overwrite the envelope id", async () => {
    const dispatcher = new MethodDispatcher();
    dispatcher.register("proposals.approve", async () => ({ ok: true, id: "other" }), {
      kind: "write",
    });
    const lines: string[] = [];
    await dispatcher.dispatch(
      { id: "req-1", method: "proposals.approve", params: {} },
      (line) => {
        lines.push(line);
      },
      sessionFor(HUMAN),
    );
    const frame = JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
    expect(frame.id).toBe("req-1");
    expect(frame.type).toBe("result");
  });

  test("dispatcher passes one complete authenticated request context", async () => {
    const dispatcher = new MethodDispatcher();
    const captured: string[] = [];
    let seenKind: string | undefined;
    let seenConnection: string | undefined;
    dispatcher.register(
      "agent.identity",
      async ({ principal, connectionId }) => {
        captured.push(principal.id);
        seenKind = principal.kind;
        seenConnection = connectionId;
        return { ok: true };
      },
      { kind: "read" },
    );
    await dispatcher.dispatch(
      { id: "req-human", method: "agent.identity", params: {} },
      () => {},
      sessionFor(HUMAN),
    );
    await dispatcher.dispatch(
      { id: "req-claude", method: "agent.identity", params: {} },
      () => {},
      sessionFor(AGENT),
    );
    expect(captured).toEqual(["human", "claude-code"]);
    expect(seenKind).toBe("agent");
    expect(seenConnection).toBe("conn-1");
  });

  test("socket lifetime cancels in-flight reads and prevents subsequent dispatch", async () => {
    const dispatcher = new MethodDispatcher();
    const controller = new AbortController();
    const session = { ...sessionFor(HUMAN), signal: controller.signal };
    let started = false;
    let invocations = 0;
    dispatcher.register(
      "bounded.read",
      async ({ signal }) => {
        invocations++;
        started = true;
        if (!signal) throw new Error("socket lifetime missing");
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
        return { ok: true };
      },
      { kind: "read" },
    );
    const frames: string[] = [];
    const pending = dispatcher.dispatch(
      { id: "r1", method: "bounded.read", params: {} },
      (line) => {
        frames.push(line);
      },
      session,
    );
    for (let i = 0; i < 10 && !started; i++) await Promise.resolve();
    expect(started).toBe(true);
    controller.abort();
    await pending;
    expect(JSON.parse(frames.at(-1) ?? "{}")).toMatchObject({ type: "error", code: "CANCELLED" });
    await dispatcher.dispatch(
      { id: "r2", method: "bounded.read", params: {} },
      (line) => {
        frames.push(line);
      },
      session,
    );
    expect(invocations).toBe(1);
    expect(JSON.parse(frames.at(-1) ?? "{}")).toMatchObject({ type: "error", code: "CANCELLED" });
  });

  test("returns METHOD_NOT_FOUND for unregistered method", async () => {
    const dispatcher = new MethodDispatcher();
    const lines: string[] = [];
    const envelope: RpcEnvelope = { id: "req-9", method: "chat.send", params: {} };
    await dispatcher.dispatch(
      envelope,
      (line) => {
        lines.push(line);
      },
      sessionFor(HUMAN),
    );
    expect(JSON.parse(lines[0]).type).toBe("ack");
    expect(JSON.parse(lines[1])).toEqual({
      id: "req-9",
      type: "error",
      code: "METHOD_NOT_FOUND",
      message: "unknown method: chat.send",
      detail: { method: "chat.send" },
    });
  });

  async function dispatchThrowing(error: unknown): Promise<Record<string, unknown>> {
    const dispatcher = new MethodDispatcher();
    dispatcher.register(
      "boom",
      async () => {
        throw error;
      },
      { kind: "read" },
    );
    const lines: string[] = [];
    await dispatcher.dispatch(
      { id: "req-e", method: "boom", params: {} },
      (line) => {
        lines.push(line);
      },
      sessionFor(HUMAN),
    );
    return JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
  }

  test("an RpcError supplies its own code", async () => {
    const frame = await dispatchThrowing(
      new RpcError("HISTORY_CONFLICT", "vault changed since the history row"),
    );
    expect(frame.code).toBe("HISTORY_CONFLICT");
    expect(frame.message).toBe("vault changed since the history row");
  });

  test("a prefixed plain Error cannot select a wire code", async () => {
    const frame = await dispatchThrowing(new Error("NOT_FOUND: note missing"));
    expect(frame.code).toBe("INTERNAL");
    expect(frame.message).toBe("NOT_FOUND: note missing");
  });

  test.each([
    [new NoteApiError("CONFLICT", "source changed"), "CONFLICT"],
    [new DOMException("aborted", "AbortError"), "CANCELLED"],
    [new DOMException("expired", "TimeoutError"), "LIMIT_EXCEEDED"],
  ] as const)(
    "preserves domain and cancellation errors across sockets: %s",
    async (error, code) => {
      expect((await dispatchThrowing(error)).code).toBe(code);
    },
  );

  test("an unprefixed failure stays INTERNAL with the message intact", async () => {
    const frame = await dispatchThrowing(new Error("something broke"));
    expect(frame.code).toBe("INTERNAL");
    expect(frame.message).toBe("something broke");
  });

  test("a lowercase or too-short prefix is not treated as a code", async () => {
    expect((await dispatchThrowing(new Error("oops: bad"))).code).toBe("INTERNAL");
    expect((await dispatchThrowing(new Error("AB: bad"))).code).toBe("INTERNAL");
  });

  test("a non-Error throw is stringified under INTERNAL", async () => {
    const frame = await dispatchThrowing("plain string");
    expect(frame.code).toBe("INTERNAL");
    expect(frame.message).toBe("plain string");
  });
});

describe("RpcDispatchFence", () => {
  test("drains a held handler before downstream shutdown and refuses late producers", async () => {
    const fence = new RpcDispatchFence();
    const dispatcher = new MethodDispatcher();
    const order: string[] = [];
    const frames: Array<Record<string, unknown>> = [];
    let releaseHandler: () => void = () => {
      throw new Error("handler release was not initialized");
    };
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    dispatcher.register(
      "producer.run",
      async () => {
        order.push("handler.start");
        await handlerGate;
        order.push("handler.enqueue");
        order.push("handler.emit");
        return { ok: true };
      },
      { kind: "write" },
    );
    const emit = (line: string): void => {
      frames.push(JSON.parse(line) as Record<string, unknown>);
    };

    const held = fence.start(() =>
      dispatcher.dispatch(
        { id: "held", method: "producer.run", params: {} },
        emit,
        sessionFor(HUMAN),
      ),
    );
    if (held === null) throw new Error("initial handler was unexpectedly refused");

    fence.stopAccepting();
    const drained = fence.drain().then(() => {
      order.push("downstream.shutdown");
    });
    const late = fence.start(() =>
      dispatcher.dispatch(
        { id: "late", method: "producer.run", params: {} },
        emit,
        sessionFor(HUMAN),
      ),
    );

    expect(late).toBeNull();
    await Promise.resolve();
    expect(order).toEqual(["handler.start"]);

    releaseHandler();
    await Promise.all([held, drained]);
    expect(order).toEqual([
      "handler.start",
      "handler.enqueue",
      "handler.emit",
      "downstream.shutdown",
    ]);
    expect(frames.map((frame) => [frame.id, frame.type])).toEqual([
      ["held", "ack"],
      ["held", "result"],
    ]);
    expect(fence.size).toBe(0);
  });

  test("a connection-owned maintenance lease drains prior work and blocks other callers", async () => {
    const fence = new RpcDispatchFence();
    const order: string[] = [];
    let releasePrior = (): void => {};
    const priorGate = new Promise<void>((resolve) => {
      releasePrior = resolve;
    });
    const prior = fence.start(async () => {
      order.push("prior.start");
      await priorGate;
      order.push("prior.end");
    });
    if (prior === null) throw new Error("prior dispatch was unexpectedly refused");

    const entered = fence.enterMaintenance("conn-owner", async () => {
      order.push("maintenance.enter");
    });
    if (entered === null) throw new Error("maintenance was unexpectedly refused");
    expect(fence.isMaintenanceBlocked("conn-other")).toBe(true);
    expect(fence.isMaintenanceBlocked("conn-owner")).toBe(false);
    expect(fence.maintenanceConnectionId).toBe("conn-owner");
    expect(fence.enterMaintenance("conn-other", async () => {})).toBeNull();
    await Promise.resolve();
    expect(order).toEqual(["prior.start"]);

    releasePrior();
    await Promise.all([prior, entered]);
    expect(order).toEqual(["prior.start", "prior.end", "maintenance.enter"]);
    expect(fence.releaseMaintenance("conn-other")).toBe(false);
    expect(fence.releaseMaintenance("conn-owner")).toBe(true);
    expect(fence.maintenanceConnectionId).toBeNull();
  });

  test("owner disconnect cancels a begin still delayed behind admitted work", async () => {
    const fence = new RpcDispatchFence();
    let releasePrior = (): void => {};
    const priorGate = new Promise<void>((resolve) => {
      releasePrior = resolve;
    });
    const prior = fence.start(async () => await priorGate);
    if (prior === null) throw new Error("prior dispatch was unexpectedly refused");
    let began = false;
    const entering = fence.enterMaintenance("owner", async () => {
      began = true;
    });
    if (entering === null) throw new Error("maintenance was unexpectedly refused");

    expect(fence.releaseMaintenance("owner")).toBe(true);
    releasePrior();
    await Promise.all([prior, entering]);

    expect(began).toBe(false);
    expect(fence.maintenanceConnectionId).toBeNull();
  });

  test("owner disconnect keeps admission closed until active maintenance cleanup finishes", async () => {
    const fence = new RpcDispatchFence();
    const entered = fence.enterMaintenance("owner", async () => {});
    if (entered === null) throw new Error("maintenance was unexpectedly refused");
    await entered;

    let finishCleanup = (): void => {};
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const cleanup = fence.finishMaintenance("owner", async () => await cleanupGate);

    await Promise.resolve();
    expect(fence.maintenanceConnectionId).toBe("owner");
    expect(fence.enterMaintenance("other", async () => {})).toBeNull();

    finishCleanup();
    expect(await cleanup).toBe(true);
    expect(fence.maintenanceConnectionId).toBeNull();
  });

  test("a poisoned maintenance fence remains closed after its owner disconnects", async () => {
    const fence = new RpcDispatchFence();
    const entered = fence.enterMaintenance("restore-owner", async () => {});
    if (entered === null) throw new Error("maintenance entry was unexpectedly refused");
    await entered;

    expect(fence.poisonMaintenance("restore-owner")).toBe(true);
    expect(fence.maintenancePoisoned).toBe(true);
    expect(fence.maintenanceConnectionId).toBe("restore-owner");
    expect(fence.isMaintenanceBlocked("another-connection")).toBe(true);
  });
});

describe("MethodDispatcher authority model", () => {
  function build(): MethodDispatcher {
    const dispatcher = new MethodDispatcher({
      authenticate: (params) =>
        params.token === "secret-token"
          ? {
              id: String(params.clientIdentity ?? "human"),
              kind: "human",
              scopes: [...HUMAN_SCOPES],
            }
          : {
              id: String(params.clientIdentity ?? "human"),
              kind: "agent",
              scopes: [...AGENT_SCOPES],
            },
    });
    dispatcher.register("notes.read", async () => ({ ok: true }), { kind: "read" });
    dispatcher.register("chat.send", async () => ({ ok: true }), { kind: "write" });
    dispatcher.register("session.grant", async () => ({ ok: true }), { kind: "admin" });
    return dispatcher;
  }

  async function run(
    dispatcher: MethodDispatcher,
    session: ConnectionSession,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const lines: string[] = [];
    await dispatcher.dispatch(
      { id: "req-1", method, params },
      (line) => {
        lines.push(line);
      },
      session,
    );
    return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
  }

  test("any method before session.hello is UNAUTHENTICATED", async () => {
    const session = sessionFor(null);
    const frame = await run(build(), session, "notes.read");
    expect(frame.type).toBe("error");
    expect(frame.code).toBe("UNAUTHENTICATED");
    expect(session.principal).toBeNull();
  });

  test("an unknown method before hello is UNAUTHENTICATED, not METHOD_NOT_FOUND", async () => {
    const frame = await run(build(), sessionFor(null), "does.not.exist");
    expect(frame.code).toBe("UNAUTHENTICATED");
  });

  test("hello with the admin token yields a human principal", async () => {
    const dispatcher = build();
    const session = sessionFor(null);
    const frame = await run(dispatcher, session, HELLO_METHOD, {
      clientIdentity: "human",
      token: "secret-token",
    });
    expect(frame.type).toBe("result");
    expect(frame.principal).toEqual({
      id: "human",
      kind: "human",
      scopes: ["read", "write", "admin"],
    });
    expect(session.principal?.kind).toBe("human");
  });

  test("dispatcher preserves the principal returned by its configured authenticator", async () => {
    const dispatcher = build();
    const noToken = sessionFor(null);
    await run(dispatcher, noToken, HELLO_METHOD, { clientIdentity: "claude-code" });
    expect(noToken.principal).toEqual({
      id: "claude-code",
      kind: "agent",
      scopes: ["read", "write"],
    });
    const wrongToken = sessionFor(null);
    await run(dispatcher, wrongToken, HELLO_METHOD, {
      clientIdentity: "claude-code",
      token: "not-the-token",
    });
    expect(wrongToken.principal?.kind).toBe("agent");
  });

  test("a second hello is refused and leaves the principal intact", async () => {
    const dispatcher = build();
    const session = sessionFor(null);
    await run(dispatcher, session, HELLO_METHOD, {
      clientIdentity: "human",
      token: "secret-token",
    });
    expect(session.principal?.kind).toBe("human");
    const frame = await run(dispatcher, session, HELLO_METHOD, { clientIdentity: "codex" });
    expect(frame.type).toBe("error");
    expect(frame.code).toBe("INVALID_PARAMS");
    expect(session.principal).toEqual({ id: "human", kind: "human", scopes: [...HUMAN_SCOPES] });
  });

  test("a call pipelined behind a slow hello is not UNAUTHENTICATED", async () => {
    const dispatcher = new MethodDispatcher({
      authenticate: async (params) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          id: String(params.clientIdentity ?? "human"),
          kind: "agent",
          scopes: [...AGENT_SCOPES],
        };
      },
    });
    dispatcher.register("notes.read", async () => ({ ok: true }), { kind: "read" });
    const session = sessionFor(null);
    const frames: Record<string, unknown>[] = [];
    const emit = (line: string): void => {
      frames.push(JSON.parse(line) as Record<string, unknown>);
    };
    // One socket write carrying both frames: index.ts dispatches them
    // back to back without awaiting the first.
    const hello = dispatcher.dispatch(
      { id: "req-hello", method: HELLO_METHOD, params: { clientIdentity: "claude-code" } },
      emit,
      session,
    );
    const call = dispatcher.dispatch(
      { id: "req-call", method: "notes.read", params: {} },
      emit,
      session,
    );
    await Promise.all([hello, call]);
    const callFrame = frames.find((frame) => frame.id === "req-call" && frame.type !== "ack");
    expect(callFrame?.type).toBe("result");
    expect(callFrame?.ok).toBe(true);
  });

  test("an agent principal is FORBIDDEN on an admin method", async () => {
    const dispatcher = build();
    const session = sessionFor(null);
    await run(dispatcher, session, HELLO_METHOD, { clientIdentity: "claude-code" });
    const frame = await run(dispatcher, session, "session.grant");
    expect(frame.type).toBe("error");
    expect(frame.code).toBe("FORBIDDEN");
    expect((frame.detail as Record<string, unknown>).required).toBe("admin");
  });

  test("an agent principal may still call read and write methods", async () => {
    const dispatcher = build();
    const session = sessionFor(null);
    await run(dispatcher, session, HELLO_METHOD, { clientIdentity: "claude-code" });
    expect((await run(dispatcher, session, "notes.read")).type).toBe("result");
    expect((await run(dispatcher, session, "chat.send")).type).toBe("result");
  });

  test("a human principal is allowed on an admin method", async () => {
    const dispatcher = build();
    const session = sessionFor(null);
    await run(dispatcher, session, HELLO_METHOD, {
      clientIdentity: "human",
      token: "secret-token",
    });
    expect((await run(dispatcher, session, "session.grant")).type).toBe("result");
  });

  test("kindOf reports the registered descriptor", () => {
    const dispatcher = build();
    expect(dispatcher.kindOf("notes.read")).toBe("read");
    expect(dispatcher.kindOf("session.grant")).toBe("admin");
    expect(dispatcher.kindOf("nope")).toBeUndefined();
  });
});
