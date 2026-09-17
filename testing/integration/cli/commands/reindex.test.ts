/**
 * Phase 5 Task 11 reindex CLI module-shape tests, plus the later
 * `--pattern` parsing contract for the same command.
 *
 * The end-to-end timestamp-clearing assertions live alongside the
 * daemon handler in `src/daemon/handlers/awaken.test.ts` (the daemon
 * handler is the layer that actually issues the `UPDATE note SET
 * tier{N}_at = NONE` query). These tests pin the CLI module's public
 * surface so accidental rewires of `runReindexCommand` show up as a
 * failing import at type-check time.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_REINDEX_PATTERN,
  ReindexPatternError,
  resolveReindexPattern,
  runReindexCommand,
} from "../../../../src/cli/commands/reindex";
import { currentPlatform, resolveSocketPath } from "../../../../src/daemon/socket";
import { installFakeDaemonAuth, replyToAuthenticatedHello } from "../../../helpers/fakeDaemonAuth";

interface FakeDaemon {
  framesReceived: Record<string, unknown>[];
  close: () => Promise<void>;
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let tempDir: string | undefined;
let vaultPath: string;

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "notient-reindex-cli-"));
  tempDir = root;
  vaultPath = path.join(root, "vault");
  await mkdir(vaultPath, { recursive: true });
});

afterEach(async () => {
  if (tempDir !== undefined) {
    const root = tempDir;
    tempDir = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

async function startFakeDaemon(vaultPath: string): Promise<FakeDaemon> {
  const socketPath = resolveSocketPath(vaultPath, currentPlatform());
  const cleanupAuth = await installFakeDaemonAuth(vaultPath);
  await mkdir(path.dirname(socketPath), { recursive: true });
  await unlink(socketPath).catch(() => {});
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
          replyToFrame(socket, JSON.parse(line) as Record<string, unknown>, framesReceived, () => ({
            type: "result",
            ok: true,
          }));
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    framesReceived,
    close: async () => {
      for (const socket of sockets) socket.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => {});
      await cleanupAuth();
    },
  };
}

function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
}

async function runCli(args: string[]): Promise<CliResult> {
  const processHandle = Bun.spawn({
    cmd: [process.execPath, path.join(repoRoot(), "src/cli/index.ts"), ...args],
    cwd: repoRoot(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("reindex CLI pattern dispatch", () => {
  test("forwards --pattern to reindex.glob", async () => {
    const fakeDaemon = await startFakeDaemon(vaultPath);
    try {
      const result = await runCli([
        "reindex",
        "--vault",
        vaultPath,
        "--pattern",
        "4-archive/**",
        "--tier",
        "1",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(fakeDaemon.framesReceived).toHaveLength(1);
      expect(fakeDaemon.framesReceived[0].method).toBe("reindex.glob");
      expect(fakeDaemon.framesReceived[0].params).toEqual({
        pattern: "4-archive/**",
        tier: [1],
      });
    } finally {
      await fakeDaemon.close();
    }
  });

  test("still forwards the positional glob to reindex.glob", async () => {
    const fakeDaemon = await startFakeDaemon(vaultPath);
    try {
      const result = await runCli(["reindex", "notes/**", "--vault", vaultPath, "--tier", "2"]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(fakeDaemon.framesReceived).toHaveLength(1);
      expect(fakeDaemon.framesReceived[0].method).toBe("reindex.glob");
      expect(fakeDaemon.framesReceived[0].params).toEqual({
        pattern: "notes/**",
        tier: [2],
      });
    } finally {
      await fakeDaemon.close();
    }
  });

  test("rejects mismatched positional and --pattern values before RPC", async () => {
    const fakeDaemon = await startFakeDaemon(vaultPath);
    try {
      const result = await runCli([
        "reindex",
        "notes/**",
        "--vault",
        vaultPath,
        "--pattern",
        "4-archive/**",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(fakeDaemon.framesReceived).toHaveLength(0);
      const event = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      expect(event.type).toBe("error");
      expect(event.code).toBe("INVALID_PARAMS");
      expect(event.message).toContain("positional glob and --pattern must match");
    } finally {
      await fakeDaemon.close();
    }
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
