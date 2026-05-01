import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDistillFormat, runDistillCommand } from "../../../../src/cli/commands/distill";
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
  candidates: [
    {
      kind: "decision",
      text: "Use OAuth2 with PKCE.",
      sourceMessageIds: ["msg-1-bbb"],
    },
  ],
  proposalsCreated: 1,
  byKind: { decision: 1 },
  durationMs: 7,
};

describe("notient distill CLI", () => {
  let rootDir: string;
  let daemon: FakeDaemon;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "notient-distill-cli-"));
    daemon = await startFakeDaemon(rootDir);
  });
  afterEach(async () => {
    await daemon.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  test("forwards transcriptPath and pretty-prints structured payload", async () => {
    daemon.setReply(STRUCTURED_REPLY);
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCode = await runDistillCommand({
      vaultPath: rootDir,
      transcriptPath: "session.md",
      format: "auto",
      dryRun: false,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: (line) => stderrLines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(stderrLines).toHaveLength(0);
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0]) as Record<string, unknown>;
    expect(parsed.proposalsCreated).toBe(1);
    expect(parsed.candidates).toBeDefined();
    expect(parsed.byKind).toEqual({ decision: 1 });
    const sent = daemon.framesReceived[0];
    expect(sent.method).toBe("agent.distill");
    const params = sent.params as Record<string, unknown>;
    expect(params.transcriptPath).toBe("session.md");
    expect(params.dryRun).toBeUndefined();
  });

  test("forwards dryRun flag when set", async () => {
    daemon.setReply({ ...STRUCTURED_REPLY, proposalsCreated: 0 });
    await runDistillCommand({
      vaultPath: rootDir,
      transcriptPath: "session.md",
      format: "auto",
      dryRun: true,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.dryRun).toBe(true);
  });

  test("forwards explicit format selection", async () => {
    daemon.setReply(STRUCTURED_REPLY);
    await runDistillCommand({
      vaultPath: rootDir,
      transcriptPath: "session.jsonl",
      format: "jsonl",
      dryRun: false,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sent = daemon.framesReceived[0];
    const params = sent.params as Record<string, unknown>;
    expect(params.format).toBe("jsonl");
  });

  test("error frame prints to stderr and returns non-zero exit code", async () => {
    daemon.setReply({ type: "error", code: "INTERNAL", message: "boom" });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCode = await runDistillCommand({
      vaultPath: rootDir,
      transcriptPath: "session.md",
      format: "auto",
      dryRun: false,
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

describe("distill flag parsing", () => {
  test("parseDistillFormat accepts only documented values", () => {
    expect(parseDistillFormat(undefined)).toBe("auto");
    expect(parseDistillFormat("auto")).toBe("auto");
    expect(parseDistillFormat("markdown")).toBe("markdown");
    expect(parseDistillFormat("jsonl")).toBe("jsonl");
    expect(parseDistillFormat("json")).toBe("json");
    expect(() => parseDistillFormat("bogus")).toThrow();
    expect(() => parseDistillFormat(true)).toThrow();
  });
});
