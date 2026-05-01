import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentPlatform, resolveSocketPath } from "../../../../src/daemon/socket";
import { makeEmitter } from "../../../../src/cli/output";
import { parseAskFormat, parseAskMaxRounds, runAskCommand } from "../../../../src/cli/commands/ask";

interface FakeDaemon {
  server: Server;
  socketPath: string;
  setReply: (reply: Record<string, unknown>) => void;
  framesReceived: Record<string, unknown>[];
  close: () => Promise<void>;
}

async function startFakeDaemon(rootDir: string): Promise<FakeDaemon> {
  // Use the same path resolution runAskCommand uses so connectClient finds
  // the fake daemon instead of trying to spawn a real one.
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

const STRUCTURED_REPLY = {
  type: "result",
  ok: true,
  answer: "Auth uses JWT bearer tokens.",
  citations: [{ path: "Notient/auth.md", score: 0.9, snippet: "JWT-based auth" }],
  openQuestions: ["Refresh window?"],
  confidence: 0.7,
  toolCalls: [{ name: "vault.search_notes", args: { query: "auth" }, durationMs: 12 }],
  durationMs: 42,
};

describe("notient ask CLI", () => {
  let rootDir: string;
  let daemon: FakeDaemon;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "notient-ask-"));
    daemon = await startFakeDaemon(rootDir);
  });
  afterEach(async () => {
    await daemon.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  test("structured format pretty-prints the response JSON to stdout", async () => {
    daemon.setReply(STRUCTURED_REPLY);
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCode = await runAskCommand({
      vaultPath: rootDir,
      intent: "How does auth work?",
      format: "structured",
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: (line) => stderrLines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(stderrLines).toHaveLength(0);
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0]) as Record<string, unknown>;
    expect(parsed.answer).toBe(STRUCTURED_REPLY.answer);
    expect(parsed.citations).toEqual(STRUCTURED_REPLY.citations);
    expect(parsed.openQuestions).toEqual(STRUCTURED_REPLY.openQuestions);
    expect(parsed.confidence).toBe(STRUCTURED_REPLY.confidence);
    expect(parsed.toolCalls).toEqual(STRUCTURED_REPLY.toolCalls);
    expect(parsed.durationMs).toBe(STRUCTURED_REPLY.durationMs);
    // Verify the daemon received the intent and no extra wrapping.
    const sent = daemon.framesReceived[0];
    expect(sent.method).toBe("agent.ask");
    expect((sent.params as Record<string, unknown>).intent).toBe("How does auth work?");
  });

  test("text format prints only the answer field as plain text", async () => {
    daemon.setReply(STRUCTURED_REPLY);
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCode = await runAskCommand({
      vaultPath: rootDir,
      intent: "How does auth work?",
      format: "text",
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: (line) => stderrLines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(stderrLines).toHaveLength(0);
    expect(stdoutLines).toEqual([STRUCTURED_REPLY.answer]);
  });

  test("forwards maxRoundsPerTurn into the agent.ask params", async () => {
    daemon.setReply(STRUCTURED_REPLY);
    await runAskCommand({
      vaultPath: rootDir,
      intent: "anything",
      format: "structured",
      maxRoundsPerTurn: 6,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    expect((sent.params as Record<string, unknown>).maxRoundsPerTurn).toBe(6);
  });

  test("error frame prints to stderr and returns non-zero exit code", async () => {
    daemon.setReply({ type: "error", code: "INTERNAL", message: "boom" });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const emitterLines: string[] = [];
    const exitCode = await runAskCommand({
      vaultPath: rootDir,
      intent: "anything",
      format: "structured",
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

describe("ask flag parsing", () => {
  test("parseAskFormat accepts known values and rejects others", () => {
    expect(parseAskFormat(undefined)).toBe("structured");
    expect(parseAskFormat(true)).toBe("structured");
    expect(parseAskFormat("structured")).toBe("structured");
    expect(parseAskFormat("text")).toBe("text");
    expect(() => parseAskFormat("yaml")).toThrow();
  });

  test("parseAskMaxRounds floors numbers and rejects non-positive", () => {
    expect(parseAskMaxRounds(undefined)).toBeUndefined();
    expect(parseAskMaxRounds("6")).toBe(6);
    expect(parseAskMaxRounds(7)).toBe(7);
    expect(parseAskMaxRounds(3.7)).toBe(3);
    expect(() => parseAskMaxRounds("0")).toThrow();
    expect(() => parseAskMaxRounds("abc")).toThrow();
    expect(() => parseAskMaxRounds(-1)).toThrow();
  });
});
