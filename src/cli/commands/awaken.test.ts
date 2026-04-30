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
import { createRun, updateStatus } from "../../core/awaken/awakenRun";
import { applySchema } from "../../core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../core/db/surreal";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../core/vault/identity";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { type SurrealServerHandle, startSurreal } from "../../daemon/surrealServer";
import { DEFAULT_TIER_FILTER, parseTierCsv } from "./awaken";
import { runAwakenCancel } from "./awakenCancel";
import { runAwakenPause } from "./awakenPause";
import { runAwakenResume } from "./awakenResume";
import { runAwakenStatus } from "./awakenStatus";

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

describe.skipIf(!SMOKE_ENABLED)("[smoke] awaken control-plane CLI", () => {
  let tempDir: string;
  let homeOverride: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-task9-cli-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-awaken-cli-smoke-"));
    homeOverride = path.join(tempDir, "home");
    await mkdir(homeOverride, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = homeOverride;

    vaultPath = path.join(tempDir, "vault");
    await mkdir(vaultPath, { recursive: true });

    handle = await startSurreal({
      dataDir: path.join(tempDir, "surreal-data"),
      secret,
      portFile: path.join(tempDir, "surreal.port"),
      pidFile: path.join(tempDir, "surreal.pid"),
      logLevel: "warn",
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);

    // Hand-write the per-vault state directory the CLI helpers expect.
    const stateDir = vaultStateDir(vaultPath);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const port = new URL(handle.url).port;
    await writeFile(vaultPortPath(vaultPath), port, "utf8");
    await writeFile(vaultSecretPath(vaultPath), secret, { mode: 0o600 });
  });

  afterAll(async () => {
    if (connection !== undefined) await connection.close().catch(() => {});
    if (handle !== undefined) await handle.stop().catch(() => {});
    if (originalHome === undefined) {
      process.env.HOME = undefined;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await connection.db.query("DELETE awaken_run;").collect();
  });

  test("[smoke] --pause with no current run writes stderr message and exits 1", async () => {
    const captured = makeCaptured();
    const exitCode = await runAwakenPause({
      vaultPath,
      stderr: makeStderrWriter(captured),
    });
    expect(exitCode).toBe(1);
    expect(captured.stderr.length).toBeGreaterThan(0);
    expect(captured.stderr[0]).toContain("nothing to pause");
  });

  test("[smoke] --cancel with no current run writes stderr message and exits 1", async () => {
    const captured = makeCaptured();
    const exitCode = await runAwakenCancel({
      vaultPath,
      stderr: makeStderrWriter(captured),
    });
    expect(exitCode).toBe(1);
    expect(captured.stderr.length).toBeGreaterThan(0);
    expect(captured.stderr[0]).toContain("nothing to cancel");
  });

  test("[smoke] --resume forwards an error frame from the daemon to stderr and exits 1", async () => {
    // The daemon owns the awaken_run flip and worker spawn (see cf9d490),
    // so the CLI is a thin client over `awaken.resume`. The fake daemon
    // here replies with the same INVALID_PARAMS frame the real handler
    // emits when no `paused`/`failed` row exists, and the test asserts
    // the CLI surfaces that message verbatim.
    const socketPath = resolveSocketPath(vaultPath, currentPlatform());
    const fake = await startFakeDaemon(socketPath, (frame) => {
      expect(frame.method).toBe("awaken.resume");
      return {
        type: "error",
        payload: {
          code: "INVALID_PARAMS",
          message: "no resumable awaken run found",
          detail: {},
        },
      };
    });
    try {
      const captured = makeCaptured();
      const exitCode = await runAwakenResume({
        vaultPath,
        stdout: makeStdoutWriter(captured),
        stderr: makeStderrWriter(captured),
      });
      expect(exitCode).toBe(1);
      expect(captured.stdout.length).toBe(0);
      expect(captured.stderr.length).toBeGreaterThan(0);
      expect(captured.stderr[0]).toContain("no resumable awaken run");
    } finally {
      await fake.close();
    }
  });

  test("[smoke] --status with no run emits a single none frame and exits 0", async () => {
    const captured = makeCaptured();
    const exitCode = await runAwakenStatus({
      vaultPath,
      stdout: makeStdoutWriter(captured),
      stderr: makeStderrWriter(captured),
      pollIntervalMs: 0,
    });
    expect(exitCode).toBe(0);
    expect(captured.stdout.length).toBe(1);
    const parsed = JSON.parse(captured.stdout[0] ?? "");
    expect(parsed).toEqual({ type: "awaken:status", status: "none" });
  });

  test("[smoke] --pause flips a running row to paused", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 5,
    });
    const captured = makeCaptured();
    const exitCode = await runAwakenPause({
      vaultPath,
      stderr: makeStderrWriter(captured),
    });
    expect(exitCode).toBe(0);
    expect(captured.stderr.length).toBe(0);

    const [rows] = await connection.db
      .query<[Array<{ status: string }>]>("SELECT status FROM awaken_run WHERE id = $id;", {
        id: runId,
      })
      .collect<[Array<{ status: string }>]>();
    expect(rows[0]?.status).toBe("paused");
  });

  test("[smoke] --cancel flips a running row to cancelled", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 5,
    });
    const captured = makeCaptured();
    const exitCode = await runAwakenCancel({
      vaultPath,
      stderr: makeStderrWriter(captured),
    });
    expect(exitCode).toBe(0);

    const [rows] = await connection.db
      .query<[Array<{ status: string; finished_at: string | null }>]>(
        "SELECT status, finished_at FROM awaken_run WHERE id = $id;",
        { id: runId },
      )
      .collect<[Array<{ status: string; finished_at: string | null }>]>();
    expect(rows[0]?.status).toBe("cancelled");
    expect(rows[0]?.finished_at).not.toBeNull();
  });

  test("[smoke] --resume emits an awaken:resumed frame on a successful daemon response", async () => {
    // Daemon-side row flip plus worker spawn live in
    // src/daemon/__smoke__/phase4.smoke.test.ts (resume scenario) and the
    // unique-active index test in awakenRun.unique.smoke.test.ts. This
    // test's only job is to verify the CLI translates the
    // `awaken.resume` `result` frame into the right NDJSON shape on stdout.
    const fakeRunId = "awaken_run:abc";
    const socketPath = resolveSocketPath(vaultPath, currentPlatform());
    const fake = await startFakeDaemon(socketPath, (frame) => {
      expect(frame.method).toBe("awaken.resume");
      return {
        type: "result",
        payload: {
          ok: true,
          runId: fakeRunId,
          processed: 3,
          failed: 0,
          total: 10,
          status: "running",
        },
      };
    });
    try {
      const captured = makeCaptured();
      const exitCode = await runAwakenResume({
        vaultPath,
        stdout: makeStdoutWriter(captured),
        stderr: makeStderrWriter(captured),
      });
      expect(exitCode).toBe(0);
      expect(captured.stdout.length).toBe(1);
      const frame = JSON.parse(captured.stdout[0] ?? "") as Record<string, unknown>;
      expect(frame.type).toBe("awaken:resumed");
      expect(frame.runId).toBe(fakeRunId);
      expect(frame.processed).toBe(3);
      expect(frame.failed).toBe(0);
      expect(frame.total).toBe(10);
      expect(frame.status).toBe("running");
    } finally {
      await fake.close();
    }
  });

  test("[smoke] --status emits running frame then completed and exits 0", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 4,
    });
    await updateStatus(connection.db, runId, "running", { processed: 1 });

    const captured = makeCaptured();
    // Drive two ticks: first sees running, second sees completed.
    const flipPromise = (async () => {
      // Wait until the first frame has been emitted, then flip the row.
      while (captured.stdout.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await updateStatus(connection.db, runId, "completed", { processed: 4 });
    })();

    const exitCode = await runAwakenStatus({
      vaultPath,
      stdout: makeStdoutWriter(captured),
      stderr: makeStderrWriter(captured),
      pollIntervalMs: 25,
    });
    await flipPromise;

    expect(exitCode).toBe(0);
    expect(captured.stdout.length).toBeGreaterThanOrEqual(2);
    const last = JSON.parse(captured.stdout[captured.stdout.length - 1] ?? "") as Record<
      string,
      unknown
    >;
    expect(last.type).toBe("awaken:status");
    expect(last.status).toBe("completed");
    expect(last.processed).toBe(4);
    expect(last.total).toBe(4);
  });
});

// Required-export placeholder so the file holds at least one test under the
// default skip path; mirrors the awaken_run smoke convention.
describe("awaken control-plane module shape", () => {
  test("module exports the four control handlers", () => {
    expect(typeof runAwakenPause).toBe("function");
    expect(typeof runAwakenCancel).toBe("function");
    expect(typeof runAwakenResume).toBe("function");
    expect(typeof runAwakenStatus).toBe("function");
  });
});

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
