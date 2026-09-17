import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

const EVENT_2 = eventId(2);
const EVENT_7 = eventId(7);
const EVENT_42 = eventId(42);
const EVENT_99 = eventId(99);

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

describe("notient events CLI", () => {
  let rootDir: string;
  let daemon: FakeDaemon;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "notient-events-cli-"));
    daemon = await startFakeDaemon(rootDir);
  });
  afterEach(async () => {
    await daemon.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  test("an empty cursor prints retained NDJSON events plus a cursor line", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      events: SAMPLE_EVENTS,
      cursor: EVENT_2,
      longPollExpired: false,
    });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCode = await runEventsCommand({
      vaultPath: rootDir,
      since: null,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: (line) => stderrLines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(stderrLines).toHaveLength(0);
    expect(stdoutLines).toHaveLength(3);
    expect(JSON.parse(stdoutLines[0])).toEqual(SAMPLE_EVENTS[0]);
    expect(JSON.parse(stdoutLines[1])).toEqual(SAMPLE_EVENTS[1]);
    expect(JSON.parse(stdoutLines[2])).toEqual({ type: "events:cursor", cursor: EVENT_2 });
    const sent = daemon.framesReceived[0];
    expect(sent.method).toBe("agent.events");
    const params = sent.params as Record<string, unknown>;
    expect(params.since).toBeNull();
    expect(params.longPollMs).toBeUndefined();
    expect(params.limit).toBeUndefined();
  });

  test("--no-poll maps to longPollMs: 0 on the wire", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      events: [],
      cursor: EVENT_42,
      longPollExpired: false,
    });
    await runEventsCommand({
      vaultPath: rootDir,
      since: EVENT_42,
      noPoll: true,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.since).toBe(EVENT_42);
    expect(params.longPollMs).toBe(0);
  });

  test("CLI --no-poll defaults omitted --since to the retained beginning", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      events: [],
      cursor: null,
      longPollExpired: false,
    });
    const result = await runCli(["events", "--vault", rootDir, "--no-poll", "--ndjson"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(JSON.stringify({ type: "events:cursor", cursor: null }));
    expect(daemon.framesReceived).toHaveLength(1);
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.since).toBeNull();
    expect(params.longPollMs).toBe(0);
  });

  test("--long-poll-ms 5000 overrides the default longPollMs", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      events: [],
      cursor: EVENT_7,
      longPollExpired: true,
    });
    await runEventsCommand({
      vaultPath: rootDir,
      since: EVENT_7,
      longPollMs: 5000,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.longPollMs).toBe(5000);
  });

  test("--limit forwards into params", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      events: [],
      cursor: null,
      longPollExpired: false,
    });
    await runEventsCommand({
      vaultPath: rootDir,
      since: null,
      limit: 25,
      noPoll: true,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.limit).toBe(25);
  });

  test("expired long-poll prints only the cursor line", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      events: [],
      cursor: EVENT_99,
      longPollExpired: true,
    });
    const stdoutLines: string[] = [];
    const exitCode = await runEventsCommand({
      vaultPath: rootDir,
      since: EVENT_99,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: () => {},
    });
    expect(exitCode).toBe(0);
    expect(stdoutLines).toHaveLength(1);
    expect(JSON.parse(stdoutLines[0])).toEqual({ type: "events:cursor", cursor: EVENT_99 });
  });

  test("error frame prints to stderr and returns non-zero exit code", async () => {
    daemon.setReply({ type: "error", code: "INTERNAL", message: "boom" });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCode = await runEventsCommand({
      vaultPath: rootDir,
      since: null,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: (line) => stderrLines.push(line),
    });
    expect(exitCode).toBe(1);
    expect(stdoutLines).toHaveLength(0);
    expect(stderrLines).toHaveLength(1);
    const parsed = JSON.parse(stderrLines[0]) as Record<string, unknown>;
    expect(parsed.code).toBe("INTERNAL");
    expect(parsed.message).toBe("boom");
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
