import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDistillFormat, runDistillCommand } from "../../../../src/cli/commands/distill";
import { makeEmitter } from "../../../../src/cli/output";
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

const STRUCTURED_REPLY: Record<string, unknown> = {
  type: "result",
  ok: true,
  dryRun: false,
  applied: true,
  pending: false,
  denied: false,
  candidates: [
    {
      kind: "decision",
      text: "Use OAuth2 with PKCE.",
      sourceMessageIds: ["msg-1-bbb"],
    },
  ],
  proposalPaths: ["Notient/proposals/distilled-1-decision-1-batch.md"],
  proposalsCreated: 1,
  writes: [
    {
      path: "Notient/proposals/distilled-1-decision-1-batch.md",
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      historyId: 'history:u"00000000-0000-4000-8000-000000000001"',
    },
  ],
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
    expect(parsed).toMatchObject({ dryRun: false, applied: true, pending: false, denied: false });
    expect(parsed.candidates).toBeDefined();
    expect(parsed.byKind).toEqual({ decision: 1 });
    expect(parsed.proposalPaths).toEqual(["Notient/proposals/distilled-1-decision-1-batch.md"]);
    expect(parsed.writes).toEqual([
      {
        path: "Notient/proposals/distilled-1-decision-1-batch.md",
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        historyId: 'history:u"00000000-0000-4000-8000-000000000001"',
      },
    ]);
    const sent = daemon.framesReceived[0];
    expect(sent.method).toBe("agent.distill");
    const params = sent.params as Record<string, unknown>;
    expect(params.transcriptPath).toBe("session.md");
    expect(params.dryRun).toBeUndefined();
  });

  test("forwards dryRun flag when set", async () => {
    daemon.setReply({
      ...STRUCTURED_REPLY,
      dryRun: true,
      applied: false,
      proposalsCreated: 0,
      writes: [],
    });
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

  test("renders a parked batch with its call id, preview, and exact proposal paths", async () => {
    daemon.setReply({
      ...STRUCTURED_REPLY,
      applied: false,
      pending: true,
      proposalsCreated: 0,
      writes: [],
      callId: "batch-parked",
      preview: "Create one distilled proposal",
    });
    const stdoutLines: string[] = [];
    const exitCode = await runDistillCommand({
      vaultPath: rootDir,
      transcriptPath: "session.md",
      format: "auto",
      dryRun: false,
      emitter: makeEmitter({ mode: "ndjson", write: () => {} }),
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: () => {},
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutLines[0]) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      applied: false,
      pending: true,
      callId: "batch-parked",
      preview: "Create one distilled proposal",
      proposalsCreated: 0,
    });
    expect(parsed.proposalPaths).toEqual(["Notient/proposals/distilled-1-decision-1-batch.md"]);
  });

  test("error frame prints to stderr and returns non-zero exit code", async () => {
    daemon.setReply({ type: "error", code: "INTERNAL", message: "boom", detail: {} });
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
