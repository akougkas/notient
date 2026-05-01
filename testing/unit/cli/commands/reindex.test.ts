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
import { currentPlatform, resolveSocketPath } from "../../../../src/daemon/socket";
import {
  DEFAULT_REINDEX_PATTERN,
  ReindexPatternError,
  resolveReindexPattern,
  runReindexCommand,
} from "../../../../src/cli/commands/reindex";

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

async function startFakeDaemon(socketPath: string): Promise<FakeDaemon> {
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

describe("resolveReindexPattern", () => {
  test("keeps the positional glob form", () => {
    expect(
      resolveReindexPattern({
        positionalPattern: "notes/**/*.md",
        flagPattern: undefined,
      }),
    ).toBe("notes/**/*.md");
  });

  test("accepts the --pattern flag form", () => {
    expect(
      resolveReindexPattern({
        positionalPattern: undefined,
        flagPattern: "4-archive/**",
      }),
    ).toBe("4-archive/**");
  });

  test("defaults to the full markdown vault glob when no pattern is supplied", () => {
    expect(resolveReindexPattern({})).toBe(DEFAULT_REINDEX_PATTERN);
  });

  test("accepts both forms when values match", () => {
    expect(
      resolveReindexPattern({
        positionalPattern: "daily/**",
        flagPattern: "daily/**",
      }),
    ).toBe("daily/**");
  });

  test("rejects both forms when values differ", () => {
    expect(() =>
      resolveReindexPattern({
        positionalPattern: "daily/**",
        flagPattern: "archive/**",
      }),
    ).toThrow(ReindexPatternError);
  });

  test("rejects --pattern without a glob value", () => {
    expect(() => resolveReindexPattern({ flagPattern: true })).toThrow(ReindexPatternError);
  });
});
