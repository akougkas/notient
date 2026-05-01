import { describe, expect, test } from "bun:test";
import {
  MethodDispatcher,
  type RpcEnvelope,
  encodeAck,
  encodeError,
  encodeEvent,
  encodeResult,
  parseEnvelope,
} from "../../../src/daemon/rpc";

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

  test("parseEnvelope carries clientIdentity through when present", () => {
    const line = JSON.stringify({
      id: "req-1",
      method: "chat.start",
      params: {},
      clientIdentity: "claude-code",
    });
    const result = parseEnvelope(line);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.clientIdentity).toBe("claude-code");
  });

  test("parseEnvelope omits clientIdentity when absent or empty", () => {
    const absent = parseEnvelope(JSON.stringify({ id: "r", method: "m", params: {} }));
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.envelope.clientIdentity).toBeUndefined();
    const empty = parseEnvelope(
      JSON.stringify({ id: "r", method: "m", params: {}, clientIdentity: "" }),
    );
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.envelope.clientIdentity).toBeUndefined();
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
  });
});

describe("MethodDispatcher", () => {
  test("dispatches a registered method", async () => {
    const dispatcher = new MethodDispatcher();
    dispatcher.register("daemon.status", async () => ({ pid: 42 }));
    const lines: string[] = [];
    const envelope: RpcEnvelope = { id: "req-1", method: "daemon.status", params: {} };
    await dispatcher.dispatch(envelope, (line) => {
      lines.push(line);
    });
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).type).toBe("ack");
    expect(JSON.parse(lines[1])).toEqual({
      id: "req-1",
      type: "result",
      pid: 42,
    });
  });

  test("dispatcher passes clientIdentity to the handler with human as the default", async () => {
    const dispatcher = new MethodDispatcher();
    const captured: string[] = [];
    dispatcher.register("agent.identity", async (_params, _emit, _id, clientIdentity) => {
      captured.push(clientIdentity);
      return { ok: true };
    });
    await dispatcher.dispatch(
      { id: "req-default", method: "agent.identity", params: {} },
      () => {},
    );
    await dispatcher.dispatch(
      {
        id: "req-claude",
        method: "agent.identity",
        params: {},
        clientIdentity: "claude-code",
      },
      () => {},
    );
    expect(captured).toEqual(["human", "claude-code"]);
  });

  test("returns INVALID_PARAMS for unregistered method", async () => {
    const dispatcher = new MethodDispatcher();
    const lines: string[] = [];
    const envelope: RpcEnvelope = { id: "req-9", method: "chat.send", params: {} };
    await dispatcher.dispatch(envelope, (line) => {
      lines.push(line);
    });
    expect(JSON.parse(lines[0]).type).toBe("ack");
    expect(JSON.parse(lines[1])).toEqual({
      id: "req-9",
      type: "error",
      code: "INVALID_PARAMS",
      message: "method not implemented in Phase A",
      detail: { method: "chat.send" },
    });
  });
});
