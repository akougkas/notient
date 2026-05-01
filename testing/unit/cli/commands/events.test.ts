import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseEventsLongPollMs,
  parseEventsPositiveInt,
  parseEventsSince,
  runEventsCommand,
} from "../../../../src/cli/commands/events";
import { makeEmitter } from "../../../../src/cli/output";
import { currentPlatform, resolveSocketPath } from "../../../../src/daemon/socket";

interface FakeDaemon {
  server: Server;
  framesReceived: Record<string, unknown>[];
  setReply: (reply: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

async function startFakeDaemon(rootDir: string): Promise<FakeDaemon> {
  const socketPath = resolveSocketPath(rootDir, currentPlatform());
  await mkdir(join(rootDir, ".notient"), { recursive: true });
  const sockets = new Set<Socket>();
  const framesReceived: Record<string, unknown>[] = [];
  let pendingReply: Record<string, unknown> = {
    type: "result",
    ok: true,
    events: [],
    cursor: 0,
    longPollExpired: false,
  };
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
          socket.write(`${JSON.stringify({ id, ...pendingReply })}\n`);
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
    framesReceived,
    setReply: (reply) => {
      pendingReply = reply;
    },
    close: async () => {
      for (const socket of sockets) socket.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const SAMPLE_EVENTS = [
  { id: 1, ts: 1_700_000_000, type: "swarm:link_proposed", payload: { edgeId: "edge:1" } },
  { id: 2, ts: 1_700_000_010, type: "swarm:cluster_emerged", payload: { clusterId: "c1" } },
];

const CLI_ENTRY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
  "src/cli/index.ts",
);

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processHandle = Bun.spawn(
    [process.execPath, "--env-file=/dev/null", CLI_ENTRY_PATH, ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("events flag parsing", () => {
  test("parseEventsSince accepts non-negative integers and rejects everything else", () => {
    expect(parseEventsSince("0")).toBe(0);
    expect(parseEventsSince(0)).toBe(0);
    expect(parseEventsSince(42)).toBe(42);
    expect(parseEventsSince("42")).toBe(42);
    expect(() => parseEventsSince(undefined)).toThrow();
    expect(() => parseEventsSince(true)).toThrow();
    expect(() => parseEventsSince("abc")).toThrow();
    expect(() => parseEventsSince(-1)).toThrow();
    expect(() => parseEventsSince(3.5)).toThrow();
  });

  test("parseEventsPositiveInt mirrors the brief helper for --limit", () => {
    expect(parseEventsPositiveInt(undefined, "limit")).toBeUndefined();
    expect(parseEventsPositiveInt("8", "limit")).toBe(8);
    expect(parseEventsPositiveInt(7, "limit")).toBe(7);
    expect(parseEventsPositiveInt(3.7, "limit")).toBe(3);
    expect(() => parseEventsPositiveInt("0", "limit")).toThrow();
    expect(() => parseEventsPositiveInt("abc", "limit")).toThrow();
    expect(() => parseEventsPositiveInt(-1, "limit")).toThrow();
  });

  test("parseEventsLongPollMs accepts 0 and any positive integer, rejects negatives", () => {
    expect(parseEventsLongPollMs(undefined)).toBeUndefined();
    expect(parseEventsLongPollMs("0")).toBe(0);
    expect(parseEventsLongPollMs(0)).toBe(0);
    expect(parseEventsLongPollMs("5000")).toBe(5000);
    expect(parseEventsLongPollMs(5000)).toBe(5000);
    expect(parseEventsLongPollMs(5000.9)).toBe(5000);
    expect(() => parseEventsLongPollMs(-1)).toThrow();
    expect(() => parseEventsLongPollMs("abc")).toThrow();
  });
});
