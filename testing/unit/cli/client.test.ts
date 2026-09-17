import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ConnectLifecycleDeps, connectClient, connectOrSpawn } from "../../../src/cli/client";
import { vaultAdminTokenPath } from "../../../src/core/vault/identity";
import { deriveAgentCredential } from "../../../src/daemon/auth";
import type { PidFileSnapshot, PidRecord } from "../../../src/daemon/lifecycle";

const ADMIN_TOKEN = "a".repeat(64);

describe("client cancellation", () => {
  test("aborts an accepted connection whose authenticated hello never completes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "notient-stalled-hello-"));
    const socketPath = join(rootDir, "notient.sock");
    const controller = new AbortController();
    const sockets = new Set<Socket>();
    let helloSeen = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.once("data", () => {
        helloSeen = true;
        controller.abort();
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(
        connectClient({
          socketPath,
          vaultPath: rootDir,
          rootToken: ADMIN_TOKEN,
          autoSpawn: false,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/cancelled/);
      expect(helloSeen).toBe(true);
      for (let i = 0; i < 20 && sockets.size > 0; i++) await Bun.sleep(10);
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("aborts a pending response after successful authentication", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "notient-stalled-response-"));
    const controller = new AbortController();
    const daemon = await startProtocolBreakingDaemon(rootDir, () => {
      controller.abort();
      return "";
    });
    try {
      const client = await connectClient({
        socketPath: daemon.socketPath,
        vaultPath: rootDir,
        rootToken: ADMIN_TOKEN,
        autoSpawn: false,
        signal: controller.signal,
      });
      const read = async () => {
        for await (const _ of client.call("daemon.status", {})) {
          /* pending response */
        }
      };
      await expect(read()).rejects.toThrow(/cancelled/);
    } finally {
      await daemon.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

interface FakeDaemon {
  server: Server;
  socketPath: string;
  framesReceived: Record<string, unknown>[];
  setHelloPrincipal: (principal: unknown) => void;
  setHelloOk: (ok: unknown) => void;
  close: () => Promise<void>;
}

async function startFakeDaemon(rootDir: string): Promise<FakeDaemon> {
  const socketPath = join(rootDir, "notient.sock");
  const framesReceived: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  let helloPrincipal: unknown;
  let helloOk: unknown = true;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          const frame = JSON.parse(line) as Record<string, unknown>;
          framesReceived.push(frame);
          socket.write(`${JSON.stringify({ id: frame.id, type: "ack", method: frame.method })}\n`);
          socket.write(`${JSON.stringify(replyFor(frame, helloPrincipal, helloOk))}\n`);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  return {
    server,
    socketPath,
    framesReceived,
    setHelloPrincipal: (principal) => {
      helloPrincipal = principal;
    },
    setHelloOk: (ok) => {
      helloOk = ok;
    },
    close: async () => {
      for (const socket of sockets) socket.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("connectClient session.hello", () => {
  let rootDir: string;
  let daemon: FakeDaemon;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "notient-client-"));
    daemon = await startFakeDaemon(rootDir);
  });
  afterEach(async () => {
    await daemon.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  test("sends session.hello as the first frame and exposes the principal", async () => {
    const client = await connectClient({
      socketPath: daemon.socketPath,
      vaultPath: rootDir,
      clientIdentity: "claude-code",
      rootToken: ADMIN_TOKEN,
    });
    for await (const frame of client.call("daemon.status", {})) {
      if (frame.type === "result" || frame.type === "error") break;
    }
    await client.close();
    expect(daemon.framesReceived).toHaveLength(2);
    expect(daemon.framesReceived[0].method).toBe("session.hello");
    expect(daemon.framesReceived[0].params).toEqual({
      clientIdentity: "claude-code",
      agentCredential: deriveAgentCredential(ADMIN_TOKEN, "claude-code"),
    });
    expect(daemon.framesReceived[1].method).toBe("daemon.status");
    expect(client.principal).toEqual({
      id: "claude-code",
      kind: "agent",
      scopes: ["read", "write"],
    });
  });

  test("no outgoing frame carries a per-frame clientIdentity any more", async () => {
    const client = await connectClient({
      socketPath: daemon.socketPath,
      vaultPath: rootDir,
      clientIdentity: "claude-code",
      rootToken: ADMIN_TOKEN,
    });
    for await (const frame of client.call("daemon.config_get", {})) {
      if (frame.type === "result" || frame.type === "error") break;
    }
    await client.close();
    for (const frame of daemon.framesReceived) {
      expect("clientIdentity" in frame).toBe(false);
    }
  });

  test("defaults clientIdentity to human when the option is unset", async () => {
    const client = await connectClient({
      socketPath: daemon.socketPath,
      vaultPath: rootDir,
      rootToken: ADMIN_TOKEN,
    });
    await client.close();
    expect(daemon.framesReceived[0].params).toEqual({
      clientIdentity: "human",
      token: ADMIN_TOKEN,
    });
    expect(client.principal.kind).toBe("human");
  });

  test("reads the admin token from the vault state dir and becomes human", async () => {
    const tokenPath = vaultAdminTokenPath(rootDir);
    await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(tokenPath), 0o700);
    await writeFile(tokenPath, ADMIN_TOKEN, { encoding: "utf-8", mode: 0o600 });
    try {
      const client = await connectClient({ socketPath: daemon.socketPath, vaultPath: rootDir });
      await client.close();
      expect(daemon.framesReceived[0].params).toEqual({
        clientIdentity: "human",
        token: ADMIN_TOKEN,
      });
      expect(client.principal.kind).toBe("human");
      expect(client.principal.scopes).toEqual(["read", "write", "admin"]);
    } finally {
      await rm(dirname(tokenPath), { recursive: true, force: true });
    }
  });

  test("an explicit agent reads the root token but never sends it", async () => {
    const tokenPath = vaultAdminTokenPath(rootDir);
    await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(tokenPath), 0o700);
    await writeFile(tokenPath, ADMIN_TOKEN, { encoding: "utf-8", mode: 0o600 });
    try {
      const client = await connectClient({
        socketPath: daemon.socketPath,
        vaultPath: rootDir,
        clientIdentity: "claude-code",
      });
      await client.close();
      expect(daemon.framesReceived[0].params).toEqual({
        clientIdentity: "claude-code",
        agentCredential: deriveAgentCredential(ADMIN_TOKEN, "claude-code"),
      });
      expect(JSON.stringify(daemon.framesReceived[0])).not.toContain(ADMIN_TOKEN);
      expect(client.principal.kind).toBe("agent");
    } finally {
      await rm(dirname(tokenPath), { recursive: true, force: true });
    }
  });

  test("a missing root token fails closed before sending hello", async () => {
    await expect(
      connectClient({
        socketPath: daemon.socketPath,
        vaultPath: rootDir,
        clientIdentity: "claude-code",
      }),
    ).rejects.toThrow("HELLO_FAILED: daemon root token is unavailable for claude-code");
    expect(daemon.framesReceived).toEqual([]);
  });

  test("a named agent refuses a daemon response that upgrades it to human", async () => {
    daemon.setHelloPrincipal({
      id: "claude-code",
      kind: "human",
      scopes: ["read", "write", "admin"],
    });
    await expect(
      connectClient({
        socketPath: daemon.socketPath,
        vaultPath: rootDir,
        clientIdentity: "claude-code",
        rootToken: ADMIN_TOKEN,
      }),
    ).rejects.toThrow("claude-code must be assigned kind 'agent'");
  });

  test.each([
    [[], "principal must be an object"],
    [{ id: "", kind: "agent", scopes: ["read", "write"] }, "canonical agent id"],
    [{ id: "human", kind: "robot", scopes: ["read", "write"] }, "kind must be"],
    [{ id: "human", kind: "human", scopes: ["read"] }, "scopes must be exactly"],
    [{ id: "codex", kind: "agent", scopes: ["read", "write"] }, "daemon assigned"],
    [
      { id: "human", kind: "human", scopes: ["read", "write", "admin"], legacy: true },
      "exactly id, kind, and scopes",
    ],
  ])("rejects a malformed hello principal %#", async (principal, reason) => {
    daemon.setHelloPrincipal(principal);
    await expect(
      connectClient({
        socketPath: daemon.socketPath,
        vaultPath: rootDir,
        rootToken: ADMIN_TOKEN,
      }),
    ).rejects.toThrow(new RegExp(`HELLO_FAILED: malformed principal: .*${reason}`));
  });

  test("rejects a result frame that does not explicitly report ok", async () => {
    daemon.setHelloOk(false);
    await expect(
      connectClient({
        socketPath: daemon.socketPath,
        vaultPath: rootDir,
        rootToken: ADMIN_TOKEN,
      }),
    ).rejects.toThrow("hello result ok must be true");
  });
});

/**
 * A daemon that completes `session.hello`, then acks the next request and
 * dies without ever sending a result, which is what a crashed or SIGKILL'd
 * daemon looks like from the client side.
 */
async function startDyingDaemon(rootDir: string): Promise<{
  socketPath: string;
  close: () => Promise<void>;
}> {
  const socketPath = join(rootDir, "dying.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      const line = chunk.toString("utf-8").trim();
      if (line.length === 0) return;
      const frame = JSON.parse(line) as Record<string, unknown>;
      const id = typeof frame.id === "string" ? frame.id : "unknown";
      socket.write(`${JSON.stringify({ id, type: "ack", method: frame.method })}\n`);
      if (frame.method === "session.hello") {
        socket.write(
          `${JSON.stringify({
            id,
            type: "result",
            ok: true,
            principal: {
              id: "human",
              kind: "human",
              scopes: ["read", "write", "admin"],
            },
          })}\n`,
        );
        return;
      }
      // Then vanish mid-stream, before any result frame.
      socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("connectClient disconnect handling", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "notient-client-dc-"));
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("a mid-stream disconnect rejects the pending waiter with DAEMON_DISCONNECTED", async () => {
    const daemon = await startDyingDaemon(rootDir);
    try {
      const client = await connectClient({
        socketPath: daemon.socketPath,
        vaultPath: rootDir,
        rootToken: ADMIN_TOKEN,
      });
      const frames: string[] = [];
      let caught: unknown;
      try {
        for await (const frame of client.call("awaken.run", {})) {
          frames.push(String(frame.type));
        }
      } catch (error) {
        caught = error;
      }
      // The buffered ack still drains before the disconnect becomes terminal.
      expect(frames).toEqual(["ack"]);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message.startsWith("DAEMON_DISCONNECTED")).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  test("call() throws immediately once the transport is gone", async () => {
    const daemon = await startDyingDaemon(rootDir);
    try {
      const client = await connectClient({
        socketPath: daemon.socketPath,
        vaultPath: rootDir,
        rootToken: ADMIN_TOKEN,
      });
      try {
        for await (const _frame of client.call("awaken.run", {})) {
          // drain until the disconnect surfaces
        }
      } catch {
        // expected
      }
      let caught: unknown;
      try {
        // The generator body runs on first pull, so the throw surfaces here.
        for await (const _frame of client.call("daemon.status", {})) {
          // unreachable
        }
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message.startsWith("DAEMON_DISCONNECTED")).toBe(true);
    } finally {
      await daemon.close();
    }
  });
});

async function startProtocolBreakingDaemon(
  rootDir: string,
  brokenReply: (requestId: string) => string,
): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const socketPath = join(rootDir, "protocol-breaking.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line) as Record<string, unknown>;
        const id = request.id as string;
        socket.write(`${JSON.stringify({ id, type: "ack", method: request.method })}\n`);
        if (request.method === "session.hello") {
          socket.write(
            `${JSON.stringify({
              id,
              type: "result",
              ok: true,
              principal: {
                id: "human",
                kind: "human",
                scopes: ["read", "write", "admin"],
              },
            })}\n`,
          );
        } else {
          socket.write(brokenReply(id));
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("connectClient response framing integrity", () => {
  test.each([
    ["invalid JSON", () => "not-json\n", /invalid JSON/],
    [
      "an unknown request id",
      () => `${JSON.stringify({ id: "req-999", type: "result", ok: true })}\n`,
      /unknown request id/,
    ],
    [
      "an invalid frame type",
      (id: string) => `${JSON.stringify({ id, type: "complete", ok: true })}\n`,
      /invalid frame type/,
    ],
  ])("rejects %s instead of waiting or dropping it", async (_label, reply, expected) => {
    const rootDir = await mkdtemp(join(tmpdir(), "notient-client-wire-"));
    const daemon = await startProtocolBreakingDaemon(rootDir, reply);
    try {
      const client = await connectClient({
        socketPath: daemon.socketPath,
        vaultPath: rootDir,
        rootToken: ADMIN_TOKEN,
      });
      let failure: unknown;
      try {
        for await (const _frame of client.call("daemon.status", {})) {
          // no valid frame is expected
        }
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(expected);
    } finally {
      await daemon.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

interface LifecycleHarnessOptions {
  snapshot: (now: number) => PidFileSnapshot;
  alive: (pid: number, now: number) => boolean;
  socketReady: (now: number) => boolean;
}

function pidRecord(overrides: Partial<PidRecord> = {}): PidRecord {
  return {
    pid: 101,
    socketPath: "/tmp/notient.sock",
    vault: "/vault",
    startedAt: 0,
    instanceId: "instance-a",
    version: "0.1.0-alpha",
    booting: false,
    ...overrides,
  };
}

function lifecycleHarness(options: LifecycleHarnessOptions): {
  deps: ConnectLifecycleDeps;
  now: () => number;
  spawnTimes: number[];
} {
  let now = 0;
  const spawnTimes: number[] = [];
  const deps: ConnectLifecycleDeps = {
    openSocket: async () => {
      if (options.socketReady(now)) return {} as Socket;
      throw Object.assign(new Error("socket unavailable"), { code: "ENOENT" });
    },
    inspectPid: async () => options.snapshot(now),
    isProcessAlive: (pid) => options.alive(pid, now),
    spawnDaemon: () => {
      spawnTimes.push(now);
    },
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  };
  return { deps, now: () => now, spawnTimes };
}

describe("connect-or-spawn lifecycle ownership", () => {
  const baseOptions = {
    socketPath: "/tmp/notient.sock",
    vaultPath: "/vault",
    spawnTimeoutMs: 120_000,
  };

  test("waits for a boot-intent owner instead of spawning", async () => {
    const harness = lifecycleHarness({
      snapshot: () => ({ kind: "record", record: pidRecord({ booting: true }) }),
      alive: (pid) => pid === 101,
      socketReady: (now) => now >= 2_000,
    });

    await connectOrSpawn(baseOptions, harness.deps);

    expect(harness.now()).toBe(2_000);
    expect(harness.spawnTimes).toEqual([]);
  });

  test("retains a shutting-down pid after its record disappears", async () => {
    let successorSpawned = false;
    const harness = lifecycleHarness({
      snapshot: (now) =>
        now < 500 ? { kind: "record", record: pidRecord() } : { kind: "missing" },
      alive: (pid, now) => pid === 101 && now < 1_500,
      socketReady: (now) => successorSpawned && now >= 2_000,
    });
    const spawn = harness.deps.spawnDaemon;
    harness.deps.spawnDaemon = (options) => {
      successorSpawned = true;
      spawn(options);
    };

    await connectOrSpawn(baseOptions, harness.deps);

    expect(harness.spawnTimes).toEqual([1_500]);
    expect(harness.now()).toBe(2_000);
  });

  test("reconciles a replacement owner only after the captured pid exits", async () => {
    const harness = lifecycleHarness({
      snapshot: (now) =>
        now < 500
          ? { kind: "record", record: pidRecord() }
          : {
              kind: "record",
              record: pidRecord({ pid: 202, instanceId: "instance-b", booting: true }),
            },
      alive: (pid, now) => (pid === 101 ? now < 1_500 : pid === 202),
      socketReady: (now) => now >= 2_000,
    });

    await connectOrSpawn(baseOptions, harness.deps);

    expect(harness.spawnTimes).toEqual([]);
    expect(harness.now()).toBe(2_000);
  });

  test("times out a live shutdown owner at sixty seconds without spawning", async () => {
    const harness = lifecycleHarness({
      snapshot: () => ({ kind: "record", record: pidRecord() }),
      alive: (pid) => pid === 101,
      socketReady: () => false,
    });

    await expect(connectOrSpawn(baseOptions, harness.deps)).rejects.toThrow(/lifecycle deadline/);
    expect(harness.now()).toBe(60_000);
    expect(harness.spawnTimes).toEqual([]);
  });

  test("a non-spawning caller still waits for a booting owner", async () => {
    const harness = lifecycleHarness({
      snapshot: () => ({ kind: "record", record: pidRecord({ booting: true }) }),
      alive: (pid) => pid === 101,
      socketReady: (now) => now >= 2_000,
    });

    await connectOrSpawn({ ...baseOptions, autoSpawn: false }, harness.deps);

    expect(harness.now()).toBe(2_000);
    expect(harness.spawnTimes).toEqual([]);
  });

  test("a short ownership probe retains the socket cause and captured owner on timeout", async () => {
    const harness = lifecycleHarness({
      snapshot: () => ({ kind: "record", record: pidRecord() }),
      alive: (pid, now) => pid === 101 && now < 250,
      socketReady: () => false,
    });
    const failure = await connectOrSpawn(
      { ...baseOptions, autoSpawn: false, spawnTimeoutMs: 250 },
      harness.deps,
    ).catch((error) => error);
    expect(failure.name).toBe("DaemonConnectionTimeoutError");
    expect(failure.cause.code).toBe("ENOENT");
    expect(failure.ownerPid).toBe(101);
    expect(harness.spawnTimes).toEqual([]);
  });

  test("fails closed on a malformed pid record", async () => {
    const harness = lifecycleHarness({
      snapshot: () => ({ kind: "invalid", pid: null, reason: "booting must be boolean" }),
      alive: () => false,
      socketReady: () => false,
    });

    await expect(connectOrSpawn(baseOptions, harness.deps)).rejects.toThrow(
      "invalid daemon pid file",
    );
    expect(harness.spawnTimes).toEqual([]);
  });
});

/**
 * The fake daemon's reply to one frame. `session.hello` is answered with a
 * principal derived from the token the client sent; everything else gets a
 * bare ok.
 */
function replyFor(
  frame: Record<string, unknown>,
  helloPrincipal: unknown,
  helloOk: unknown,
): Record<string, unknown> {
  const id = typeof frame.id === "string" ? frame.id : "unknown";
  if (frame.method !== "session.hello") return { id, type: "result", ok: true };
  const params = (frame.params ?? {}) as Record<string, unknown>;
  const isHuman = params.token === ADMIN_TOKEN;
  return {
    id,
    type: "result",
    ok: helloOk,
    principal:
      helloPrincipal ??
      ({
        id: params.clientIdentity ?? "human",
        kind: isHuman ? "human" : "agent",
        scopes: isHuman ? ["read", "write", "admin"] : ["read", "write"],
      } satisfies Record<string, unknown>),
  };
}
