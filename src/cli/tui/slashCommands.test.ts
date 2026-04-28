import { describe, expect, test } from "bun:test";
import type { ClientHandle, RpcResponseFrame } from "../client";
import { dispatchSlashCommand, isSlashCommand, parseSlashCommand } from "./slashCommands";

describe("isSlashCommand", () => {
  test("matches lines beginning with /", () => {
    expect(isSlashCommand("/quit")).toBe(true);
    expect(isSlashCommand("hello")).toBe(false);
    expect(isSlashCommand(" /quit")).toBe(false);
  });
});

describe("parseSlashCommand", () => {
  test("splits verb and rest", () => {
    expect(parseSlashCommand("/search foo bar")).toEqual({
      verb: "search",
      rest: "foo bar",
    });
    expect(parseSlashCommand("/quit")).toEqual({ verb: "quit", rest: "" });
  });

  test("handles trailing whitespace", () => {
    expect(parseSlashCommand("/help   ")).toEqual({ verb: "help", rest: "" });
  });
});

interface CapturedCall {
  method: string;
  params: Record<string, unknown>;
}

interface FakeClient extends ClientHandle {
  calls: CapturedCall[];
}

interface FakeSpec {
  method: string;
  result: Record<string, unknown>;
}

function makeFakeClient(specs: FakeSpec[]): FakeClient {
  const calls: CapturedCall[] = [];
  const handle: FakeClient = {
    calls,
    call(method, params): AsyncIterable<RpcResponseFrame> {
      calls.push({ method, params });
      const spec = specs.find((entry) => entry.method === method);
      return (async function* () {
        if (!spec) {
          yield {
            id: "fake",
            type: "error",
            message: `no fake for ${method}`,
          } as RpcResponseFrame;
          return;
        }
        yield {
          id: "fake",
          type: "result",
          ...spec.result,
        } as RpcResponseFrame;
      })();
    },
    close: async () => {},
  };
  return handle;
}

describe("dispatchSlashCommand", () => {
  test("/approve <callId> calls chat.approve with approved:true and no reason", async () => {
    const client = makeFakeClient([{ method: "chat.approve", result: { ok: true } }]);
    const outcome = await dispatchSlashCommand("/approve abc123", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.method).toBe("chat.approve");
    expect(client.calls[0]?.params).toEqual({ callId: "abc123", approved: true });
    expect(outcome.message).toBe("approved abc123");
  });

  test("/approve <callId> <reason> includes reason field", async () => {
    const client = makeFakeClient([{ method: "chat.approve", result: { ok: true } }]);
    const outcome = await dispatchSlashCommand("/approve abc123 please", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls[0]?.params).toEqual({
      callId: "abc123",
      approved: true,
      reason: "please",
    });
    expect(outcome.message).toBe("approved abc123");
  });

  test("/deny <callId> calls chat.approve with approved:false", async () => {
    const client = makeFakeClient([{ method: "chat.approve", result: { ok: true } }]);
    const outcome = await dispatchSlashCommand("/deny abc123", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls[0]?.method).toBe("chat.approve");
    expect(client.calls[0]?.params).toEqual({ callId: "abc123", approved: false });
    expect(outcome.message).toBe("denied abc123");
  });

  test("/undo renders reversed entry on success", async () => {
    const client = makeFakeClient([
      {
        method: "notes.undo",
        result: { ok: true, reversed: { kind: "notes.create", target: "x.md" } },
      },
    ]);
    const outcome = await dispatchSlashCommand("/undo", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls[0]?.method).toBe("notes.undo");
    expect(outcome.message).toBe("undone: notes.create x.md");
  });

  test("/undo surfaces daemon error string when ok:false", async () => {
    const client = makeFakeClient([
      { method: "notes.undo", result: { ok: false, error: "no history" } },
    ]);
    const outcome = await dispatchSlashCommand("/undo", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toBe("undo: no history");
  });

  test("/history prints one line per entry", async () => {
    const createdAt = Date.UTC(2026, 0, 2, 3, 4, 5);
    const client = makeFakeClient([
      {
        method: "notes.history",
        result: {
          entries: [{ kind: "notes.create", target: "alpha.md", createdAt }],
        },
      },
    ]);
    const outcome = await dispatchSlashCommand("/history", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls[0]?.method).toBe("notes.history");
    expect(client.calls[0]?.params).toEqual({ limit: 10 });
    expect(outcome.message).toBe(`notes.create alpha.md ${new Date(createdAt).toISOString()}`);
  });

  test("/history reports empty list", async () => {
    const client = makeFakeClient([{ method: "notes.history", result: { entries: [] } }]);
    const outcome = await dispatchSlashCommand("/history", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toBe("history: (empty)");
  });

  test("/read <path> renders body in fenced markdown block", async () => {
    const client = makeFakeClient([{ method: "notes.read", result: { body: "hello world" } }]);
    const outcome = await dispatchSlashCommand("/read inbox/foo.md", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls[0]?.method).toBe("notes.read");
    expect(client.calls[0]?.params).toEqual({ path: "inbox/foo.md" });
    expect(outcome.message).toBe("```md\nhello world\n```");
  });

  test("/read truncates a 6000-char body with elision marker", async () => {
    const body = "a".repeat(6000);
    const client = makeFakeClient([{ method: "notes.read", result: { body } }]);
    const outcome = await dispatchSlashCommand("/read big.md", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message.startsWith("```md\n")).toBe(true);
    expect(outcome.message.endsWith("\n```")).toBe(true);
    expect(outcome.message).toContain("[…1000 characters elided…]");
    // head ~= 3500 chars, tail ~= 1500 chars; total elision = 1000
    const stripped = outcome.message.slice("```md\n".length, -"\n```".length);
    const [head, tail] = stripped.split(/\n\[…\d+ characters elided…\]\n/);
    expect(head?.length).toBe(3500);
    expect(tail?.length).toBe(1500);
  });
});
