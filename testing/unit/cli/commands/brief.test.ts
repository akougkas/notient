import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentPlatform, resolveSocketPath } from "../../../../src/daemon/socket";
import { makeEmitter } from "../../../../src/cli/output";
import { parseBriefMaxField, runBriefCommand } from "../../../../src/cli/commands/brief";

interface FakeDaemon {
  server: Server;
  socketPath: string;
  setReply: (reply: Record<string, unknown>) => void;
  framesReceived: Record<string, unknown>[];
  close: () => Promise<void>;
}

async function startFakeDaemon(rootDir: string): Promise<FakeDaemon> {
  const socketPath = resolveSocketPath(rootDir, currentPlatform());
  await mkdir(join(rootDir, ".notient"), { recursive: true });
  const sockets = new Set<Socket>();
  const framesReceived: Record<string, unknown>[] = [];
  let pendingReply: Record<string, unknown> = { type: "result", ok: true };

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
    socketPath,
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

const STRUCTURED_REPLY: Record<string, unknown> = {
  type: "result",
  ok: true,
  topic: "authentication",
  summary: "Auth uses OAuth+PKCE with rotating JWTs.",
  relevantNotes: [{ path: "auth/oauth.md", score: 0.9, snippet: "OAuth", lastTouchedAt: 100 }],
  recentDecisions: [{ id: "claim:1", text: "We use PKCE.", notePath: "auth/oauth.md", ts: 200 }],
  openQuestions: [
    { id: "question:1", text: "What is the refresh window?", notePath: "auth/jwt.md" },
  ],
  openContradictions: [],
  durationMs: 12,
};

describe("notient brief CLI", () => {
  let rootDir: string;
  let daemon: FakeDaemon;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "notient-brief-"));
    daemon = await startFakeDaemon(rootDir);
  });
  afterEach(async () => {
    await daemon.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  test("topic mode pretty-prints the structured payload to stdout", async () => {
    daemon.setReply(STRUCTURED_REPLY);
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCode = await runBriefCommand({
      vaultPath: rootDir,
      topic: "authentication",
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: (line) => stderrLines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(stderrLines).toHaveLength(0);
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0]) as Record<string, unknown>;
    expect(parsed.topic).toBe(STRUCTURED_REPLY.topic);
    expect(parsed.summary).toBe(STRUCTURED_REPLY.summary);
    expect(parsed.relevantNotes).toEqual(STRUCTURED_REPLY.relevantNotes);
    expect(parsed.recentDecisions).toEqual(STRUCTURED_REPLY.recentDecisions);
    expect(parsed.openQuestions).toEqual(STRUCTURED_REPLY.openQuestions);
    expect(parsed.openContradictions).toEqual(STRUCTURED_REPLY.openContradictions);
    expect(parsed.durationMs).toBe(STRUCTURED_REPLY.durationMs);
    const sent = daemon.framesReceived[0];
    expect(sent.method).toBe("agent.brief");
    expect((sent.params as Record<string, unknown>).topic).toBe("authentication");
  });

  test("file mode forwards filePath into the daemon params", async () => {
    daemon.setReply(STRUCTURED_REPLY);
    await runBriefCommand({
      vaultPath: rootDir,
      filePath: "src/auth/oauth.ts",
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.filePath).toBe("src/auth/oauth.ts");
    expect(params.topic).toBeUndefined();
  });

  test("forwards max caps into the daemon params", async () => {
    daemon.setReply(STRUCTURED_REPLY);
    await runBriefCommand({
      vaultPath: rootDir,
      topic: "auth",
      maxNotes: 4,
      maxQuestions: 2,
      maxDecisions: 1,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.maxNotes).toBe(4);
    expect(params.maxQuestions).toBe(2);
    expect(params.maxDecisions).toBe(1);
  });

  test("rejects when neither topic nor filePath is supplied", async () => {
    let thrown: unknown = null;
    try {
      await runBriefCommand({
        vaultPath: rootDir,
        emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
        writeStdout: () => {},
        writeStderr: () => {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("topic or --file");
  });

  test("rejects when both topic and filePath are supplied", async () => {
    let thrown: unknown = null;
    try {
      await runBriefCommand({
        vaultPath: rootDir,
        topic: "auth",
        filePath: "src/auth.ts",
        emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
        writeStdout: () => {},
        writeStderr: () => {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("not both");
  });

  test("error frame prints to stderr and returns non-zero exit code", async () => {
    daemon.setReply({ type: "error", code: "INTERNAL", message: "boom" });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const emitterLines: string[] = [];
    const exitCode = await runBriefCommand({
      vaultPath: rootDir,
      topic: "auth",
      emitter: makeEmitter({
        mode: "ndjson",
        write: (line) => emitterLines.push(line),
      }),
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

describe("brief flag parsing", () => {
  test("parseBriefMaxField floors numbers and rejects non-positive", () => {
    expect(parseBriefMaxField(undefined, "max-notes")).toBeUndefined();
    expect(parseBriefMaxField("8", "max-notes")).toBe(8);
    expect(parseBriefMaxField(7, "max-notes")).toBe(7);
    expect(parseBriefMaxField(3.7, "max-notes")).toBe(3);
    expect(() => parseBriefMaxField("0", "max-notes")).toThrow();
    expect(() => parseBriefMaxField("abc", "max-notes")).toThrow();
    expect(() => parseBriefMaxField(-1, "max-notes")).toThrow();
    expect(() => parseBriefMaxField(true, "max-notes")).toThrow();
  });
});
