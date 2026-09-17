import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEventsLongPollMs,
  parseEventsPositiveInt,
  parseEventsSince,
  runEventsCommand,
} from "../../../../src/cli/commands/events";
import { makeEmitter } from "../../../../src/cli/output";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { currentPlatform, resolveSocketPath } from "../../../../src/daemon/socket";
import { installFakeDaemonAuth, replyToAuthenticatedHello } from "../../../helpers/fakeDaemonAuth";

interface FakeDaemon {
  server: Server;
  framesReceived: Record<string, unknown>[];
  setReply: (reply: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

async function startFakeDaemon(rootDir: string): Promise<FakeDaemon> {
  const socketPath = resolveSocketPath(rootDir, currentPlatform());
  const cleanupAuth = await installFakeDaemonAuth(rootDir);
  const sockets = new Set<Socket>();
  const framesReceived: Record<string, unknown>[] = [];
  let pendingReply: Record<string, unknown> = {
    type: "result",
    ok: true,
    events: [],
    cursor: null,
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
          replyToFrame(
            socket,
            JSON.parse(line) as Record<string, unknown>,
            framesReceived,
            () => pendingReply,
          );
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
      await cleanupAuth();
    },
  };
}

function eventId(value: number): string {
  return createUuidRecordId(
    "agent_event",
    `018f05cd-3f7b-7000-8000-${value.toString().padStart(12, "0")}`,
  ).toString();
}

const SAMPLE_EVENTS = [
  {
    id: eventId(1),
    ts: 1_700_000_000,
    type: "swarm:link_proposed",
    payload: { edgeId: "edge:1" },
  },
  {
    id: eventId(2),
    ts: 1_700_000_010,
    type: "swarm:claim_advanced",
    payload: { claimId: "c1" },
  },
];

describe("events flag parsing", () => {
  test("parseEventsSince accepts an event record id or the empty cursor", () => {
    expect(parseEventsSince(undefined)).toBeNull();
    expect(parseEventsSince(null)).toBeNull();
    expect(parseEventsSince(eventId(42))).toBe(eventId(42));
    expect(() => parseEventsSince(true)).toThrow();
    expect(() => parseEventsSince("abc")).toThrow();
    expect(() => parseEventsSince("note:event042")).toThrow();
    expect(() => parseEventsSince("agent_event:event042")).toThrow();
    expect(() => parseEventsSince(` ${eventId(42)}`)).toThrow();
    expect(() => parseEventsSince(`${eventId(42)} `)).toThrow();
    expect(() => parseEventsSince(-1)).toThrow();
  });

  test("parseEventsPositiveInt mirrors the brief helper for --limit", () => {
    expect(parseEventsPositiveInt(undefined, "limit")).toBeUndefined();
    expect(parseEventsPositiveInt("8", "limit")).toBe(8);
    expect(parseEventsPositiveInt(7, "limit")).toBe(7);
    expect(() => parseEventsPositiveInt(3.7, "limit")).toThrow();
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
    expect(() => parseEventsLongPollMs(5000.9)).toThrow();
    expect(() => parseEventsLongPollMs(-1)).toThrow();
    expect(() => parseEventsLongPollMs("abc")).toThrow();
  });
});

describe("events result decoding", () => {
  let rootDir: string;
  let daemon: FakeDaemon;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "notient-events-result-"));
    daemon = await startFakeDaemon(rootDir);
  });

  afterEach(async () => {
    await daemon.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  test("renders a fully validated result", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      events: SAMPLE_EVENTS,
      cursor: eventId(2),
      longPollExpired: false,
    });
    const stdout: string[] = [];
    const code = await runEventsCommand({
      vaultPath: rootDir,
      since: null,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdout.push(line),
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      ...SAMPLE_EVENTS,
      { type: "events:cursor", cursor: eventId(2) },
    ]);
  });

  test.each([
    [{ type: "result", ok: true, events: [], longPollExpired: false }, /cursor/],
    [
      {
        type: "result",
        ok: true,
        events: [{ ...SAMPLE_EVENTS[0], type: "made:up" }],
        cursor: eventId(1),
        longPollExpired: false,
      },
      /type/,
    ],
    [
      {
        type: "result",
        ok: true,
        events: [],
        cursor: eventId(1),
        longPollExpired: "false",
      },
      /longPollExpired/,
    ],
  ])("rejects malformed success payload %#", async (reply, expected) => {
    daemon.setReply(reply);
    const stdout: string[] = [];
    await expect(
      runEventsCommand({
        vaultPath: rootDir,
        since: null,
        emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
        writeStdout: (line) => stdout.push(line),
        writeStderr: () => {},
      }),
    ).rejects.toThrow(expected);
    expect(stdout).toEqual([]);
  });
});

/**
 * Answer one client frame. `session.hello` (which every client now opens
 * with) is authenticated by the production protocol and kept out of `framesReceived`
 * so assertions still address the command's own frame.
 */
function replyToFrame(
  socket: Socket,
  frame: Record<string, unknown>,
  framesReceived: Record<string, unknown>[],
  reply: () => Record<string, unknown>,
): void {
  const id = typeof frame.id === "string" ? frame.id : "unknown";
  const method = typeof frame.method === "string" ? frame.method : "unknown";
  socket.write(`${JSON.stringify({ id, type: "ack", method })}\n`);
  if (replyToAuthenticatedHello(socket, frame)) return;
  framesReceived.push(frame);
  socket.write(`${JSON.stringify({ id, ...reply() })}\n`);
}
