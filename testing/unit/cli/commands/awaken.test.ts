/**
 * Phase 4 Task 9 awaken control-plane CLI smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/cli/commands/awaken.test.ts`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, hand-writes a per-vault
 * state directory under a tempdir-rooted `HOME`, and exercises the four
 * control-plane handlers (`runAwakenPause`, `runAwakenCancel`,
 * `runAwakenResume`, `runAwakenStatus`) end-to-end against the Task 7 DAL.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_TIER_FILTER, parseTierCsv } from "../../../../src/cli/commands/awaken";
import { runAwakenCancel } from "../../../../src/cli/commands/awakenCancel";
import { runAwakenPause } from "../../../../src/cli/commands/awakenPause";
import { runAwakenResume } from "../../../../src/cli/commands/awakenResume";
import { runAwakenStatus } from "../../../../src/cli/commands/awakenStatus";
import { createRun, updateStatus } from "../../../../src/core/awaken/awakenRun";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../../../src/core/vault/identity";
import { currentPlatform, resolveSocketPath } from "../../../../src/daemon/socket";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

interface Captured {
  stdout: string[];
  stderr: string[];
}

function makeCaptured(): Captured {
  return { stdout: [], stderr: [] };
}

function makeStdoutWriter(captured: Captured): (line: string) => void {
  return (line) => {
    captured.stdout.push(line);
  };
}

function makeStderrWriter(captured: Captured): (line: string) => void {
  return (line) => {
    captured.stderr.push(line);
  };
}

interface FakeDaemonResponse {
  type: "result" | "error";
  payload: Record<string, unknown>;
}

interface FakeDaemon {
  server: Server;
  close: () => Promise<void>;
}

/**
 * Minimal Unix-socket daemon stub for the `awaken --resume` CLI tests.
 *
 * `awaken --resume` is a thin client over the daemon's `awaken.resume` RPC,
 * so this fixture lets the smoke tests assert what the CLI does with a
 * canned daemon reply without standing up a real daemon (and a second
 * SurrealDB child) inside an in-process test. The fixture mirrors the
 * shape of the helper in `src/cli/client.test.ts` but is duplicated here
 * to keep each test file self-contained.
 */
async function startFakeDaemon(
  socketPath: string,
  respond: (frame: Record<string, unknown>) => FakeDaemonResponse,
): Promise<FakeDaemon> {
  await mkdir(path.dirname(socketPath), { recursive: true });
  // A previous run may have left an orphan socket file behind. `listen`
  // would otherwise fail with EADDRINUSE; unlink first and ignore ENOENT.
  await unlink(socketPath).catch(() => {});
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
          const id = typeof frame.id === "string" ? frame.id : "unknown";
          const reply = respond(frame);
          socket.write(`${JSON.stringify({ id, type: reply.type, ...reply.payload })}\n`);
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
    close: async () => {
      for (const socket of sockets) socket.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => {});
    },
  };
}

// Phase 5 Task 11: `--tier <csv>` flag parsing. The CLI should strip
// invalid tokens, accept whitespace around tokens, and fall back to the
// default `[1, 2, 3]` when the result is empty.
describe("parseTierCsv", () => {
  test("returns the default filter for undefined or boolean inputs", () => {
    expect(parseTierCsv(undefined)).toEqual([...DEFAULT_TIER_FILTER]);
    expect(parseTierCsv(true)).toEqual([...DEFAULT_TIER_FILTER]);
  });

  test("returns the default filter for an empty string", () => {
    expect(parseTierCsv("")).toEqual([...DEFAULT_TIER_FILTER]);
  });

  test("parses a single tier", () => {
    expect(parseTierCsv("1")).toEqual([1]);
    expect(parseTierCsv("2")).toEqual([2]);
    expect(parseTierCsv("3")).toEqual([3]);
  });

  test("parses a two-tier subset", () => {
    expect(parseTierCsv("2,3")).toEqual([2, 3]);
  });

  test("parses the full `[1, 2, 3]` filter", () => {
    expect(parseTierCsv("1,2,3")).toEqual([1, 2, 3]);
  });

  test("trims whitespace around tokens", () => {
    expect(parseTierCsv("1, 2, 3")).toEqual([1, 2, 3]);
    expect(parseTierCsv("  2 , 3  ")).toEqual([2, 3]);
  });

  test("de-duplicates and sorts the result", () => {
    expect(parseTierCsv("3,1,2,1")).toEqual([1, 2, 3]);
    expect(parseTierCsv("2,2")).toEqual([2]);
  });

  test("falls back to the default filter when input has only invalid tokens", () => {
    expect(parseTierCsv("abc")).toEqual([...DEFAULT_TIER_FILTER]);
    expect(parseTierCsv("0,5")).toEqual([...DEFAULT_TIER_FILTER]);
    expect(parseTierCsv("99")).toEqual([...DEFAULT_TIER_FILTER]);
  });

  test("drops invalid tokens but keeps valid ones", () => {
    expect(parseTierCsv("0,2,5")).toEqual([2]);
    expect(parseTierCsv("abc,1,xyz")).toEqual([1]);
  });
});
