import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectClient } from "../../../src/cli/client";

interface FakeDaemon {
  server: Server;
  socketPath: string;
  framesReceived: Record<string, unknown>[];
  close: () => Promise<void>;
}

async function startFakeDaemon(rootDir: string): Promise<FakeDaemon> {
  const socketPath = join(rootDir, "notient.sock");
  const framesReceived: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();

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
          const id = typeof frame.id === "string" ? frame.id : "unknown";
          socket.write(`${JSON.stringify({ id, type: "result", ok: true })}\n`);
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
    close: async () => {
      for (const socket of sockets) socket.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("connectClient identity plumbing", () => {
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

  test("omits clientIdentity from outgoing frames when option is unset", async () => {
    const client = await connectClient({ socketPath: daemon.socketPath, vaultPath: rootDir });
    for await (const frame of client.call("daemon.status", {})) {
      if (frame.type === "result" || frame.type === "error") break;
    }
    await client.close();
    expect(daemon.framesReceived).toHaveLength(1);
    expect(daemon.framesReceived[0].method).toBe("daemon.status");
    expect("clientIdentity" in daemon.framesReceived[0]).toBe(false);
  });

  test("stamps clientIdentity on every outgoing frame when option is set", async () => {
    const client = await connectClient({
      socketPath: daemon.socketPath,
      vaultPath: rootDir,
      clientIdentity: "claude-code",
    });
    for await (const frame of client.call("daemon.status", {})) {
      if (frame.type === "result" || frame.type === "error") break;
    }
    for await (const frame of client.call("daemon.config_get", {})) {
      if (frame.type === "result" || frame.type === "error") break;
    }
    await client.close();
    expect(daemon.framesReceived).toHaveLength(2);
    for (const frame of daemon.framesReceived) {
      expect(frame.clientIdentity).toBe("claude-code");
    }
  });
});
