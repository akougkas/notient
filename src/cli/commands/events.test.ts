import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { makeEmitter } from "../output";
import {
  parseEventsLongPollMs,
  parseEventsPositiveInt,
  parseEventsSince,
  runEventsCommand,
} from "./events";

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

const CLI_ENTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

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

  test("since 0 forwards { since: 0 } and prints NDJSON events plus a cursor line", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      events: SAMPLE_EVENTS,
      cursor: 2,
      longPollExpired: false,
    });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCode = await runEventsCommand({
      vaultPath: rootDir,
      since: 0,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: (line) => stderrLines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(stderrLines).toHaveLength(0);
    expect(stdoutLines).toHaveLength(3);
    expect(JSON.parse(stdoutLines[0])).toEqual(SAMPLE_EVENTS[0]);
    expect(JSON.parse(stdoutLines[1])).toEqual(SAMPLE_EVENTS[1]);
    expect(JSON.parse(stdoutLines[2])).toEqual({ type: "events:cursor", cursor: 2 });
    const sent = daemon.framesReceived[0];
    expect(sent.method).toBe("agent.events");
    const params = sent.params as Record<string, unknown>;
    expect(params.since).toBe(0);
    expect(params.longPollMs).toBeUndefined();
    expect(params.limit).toBeUndefined();
  });

  test("--no-poll maps to longPollMs: 0 on the wire", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      events: [],
      cursor: 42,
      longPollExpired: false,
    });
    await runEventsCommand({
      vaultPath: rootDir,
      since: 42,
      noPoll: true,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.since).toBe(42);
    expect(params.longPollMs).toBe(0);
  });

  test("CLI --no-poll defaults omitted --since to 0", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      events: [],
      cursor: 0,
      longPollExpired: false,
    });
    const result = await runCli(["events", "--vault", rootDir, "--no-poll", "--ndjson"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(JSON.stringify({ type: "events:cursor", cursor: 0 }));
    expect(daemon.framesReceived).toHaveLength(1);
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.since).toBe(0);
    expect(params.longPollMs).toBe(0);
  });

  test("--long-poll-ms 5000 overrides the default longPollMs", async () => {
    daemon.setReply({
      type: "result",
      ok: true,
      events: [],
      cursor: 7,
      longPollExpired: true,
    });
    await runEventsCommand({
      vaultPath: rootDir,
      since: 7,
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
      cursor: 0,
      longPollExpired: false,
    });
    await runEventsCommand({
      vaultPath: rootDir,
      since: 0,
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
      cursor: 99,
      longPollExpired: true,
    });
    const stdoutLines: string[] = [];
    const exitCode = await runEventsCommand({
      vaultPath: rootDir,
      since: 99,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: () => {},
    });
    expect(exitCode).toBe(0);
    expect(stdoutLines).toHaveLength(1);
    expect(JSON.parse(stdoutLines[0])).toEqual({ type: "events:cursor", cursor: 99 });
  });

  test("error frame prints to stderr and returns non-zero exit code", async () => {
    daemon.setReply({ type: "error", code: "INTERNAL", message: "boom" });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCode = await runEventsCommand({
      vaultPath: rootDir,
      since: 0,
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
