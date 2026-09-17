/**
 * Awaken control-plane CLI integration harness.
 *
 * Skipped by default. Run with
 * `NOTIENT_SMOKE=1 bun test testing/integration/cli/commands/awaken.test.ts`.
 *
 * Boots a real SurrealDB for control-plane state assertions and exercises the
 * four CLI handlers over the daemon RPC transport.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { runAwakenCancel } from "../../../../src/cli/commands/awakenCancel";
import { runAwakenPause } from "../../../../src/cli/commands/awakenPause";
import { runAwakenResume } from "../../../../src/cli/commands/awakenResume";
import { runAwakenStatus } from "../../../../src/cli/commands/awakenStatus";
import { createRun, updateStatus } from "../../../../src/core/awaken/awakenRun";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { makeAwakenStatusHandler } from "../../../../src/daemon/handlers/awaken";
import { currentPlatform, resolveSocketPath } from "../../../../src/daemon/socket";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { installFakeDaemonAuth, replyToAuthenticatedHello } from "../../../helpers/fakeDaemonAuth";
import { startTestRpcDaemon } from "../rpcTestDaemon";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

function makeRunPaths(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `note-${index}.md`);
}

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

type FakeDaemonResponder = (
  frame: Record<string, unknown>,
) => FakeDaemonResponse | Promise<FakeDaemonResponse>;

async function replyFrame(
  frame: Record<string, unknown>,
  respond: FakeDaemonResponder,
): Promise<Record<string, unknown>> {
  const id = typeof frame.id === "string" ? frame.id : "unknown";
  const reply = await respond(frame);
  return { id, type: reply.type, ...reply.payload };
}

async function writeFakeDaemonReply(
  socket: Socket,
  line: string,
  respond: FakeDaemonResponder,
): Promise<void> {
  const frame = JSON.parse(line) as Record<string, unknown>;
  const id = typeof frame.id === "string" ? frame.id : "unknown";
  const method = typeof frame.method === "string" ? frame.method : "unknown";
  socket.write(`${JSON.stringify({ id, type: "ack", method })}\n`);
  if (replyToAuthenticatedHello(socket, frame)) return;
  socket.write(`${JSON.stringify(await replyFrame(frame, respond))}\n`);
}

/**
 * Minimal Unix-socket daemon stub for awaken control-result rendering tests.
 */
async function startFakeDaemon(
  vaultPath: string,
  respond: FakeDaemonResponder,
): Promise<FakeDaemon> {
  const socketPath = resolveSocketPath(vaultPath, currentPlatform());
  const cleanupAuth = await installFakeDaemonAuth(vaultPath);
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
          void writeFakeDaemonReply(socket, line, respond).catch((error: unknown) => {
            socket.destroy(error instanceof Error ? error : new Error(String(error)));
          });
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
      await cleanupAuth();
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
      hnswCacheMib: 64,
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret, { embedDim: 768, embedModel: "fixture-embedding" });
  }, 30_000);

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
  }, 30_000);

  afterEach(async () => {
    await connection.db.query("DELETE awaken_run;").collect();
  });

  test("[smoke] --pause with no current run writes stderr message and exits 1", async () => {
    const fake = await startFakeDaemon(vaultPath, (frame) => {
      expect(frame.method).toBe("awaken.pause");
      return {
        type: "error",
        payload: {
          code: "INVALID_PARAMS",
          message: "nothing to pause",
          detail: {},
        },
      };
    });
    try {
      const captured = makeCaptured();
      const exitCode = await runAwakenPause({
        vaultPath,
        stderr: makeStderrWriter(captured),
      });
      expect(exitCode).toBe(1);
      expect(captured.stderr.length).toBeGreaterThan(0);
      expect(captured.stderr[0]).toContain("nothing to pause");
    } finally {
      await fake.close();
    }
  });

  test("[smoke] --cancel with no current run writes stderr message and exits 1", async () => {
    const fake = await startFakeDaemon(vaultPath, (frame) => {
      expect(frame.method).toBe("awaken.cancel");
      return {
        type: "error",
        payload: {
          code: "INVALID_PARAMS",
          message: "nothing to cancel",
          detail: {},
        },
      };
    });
    try {
      const captured = makeCaptured();
      const exitCode = await runAwakenCancel({
        vaultPath,
        stderr: makeStderrWriter(captured),
      });
      expect(exitCode).toBe(1);
      expect(captured.stderr.length).toBeGreaterThan(0);
      expect(captured.stderr[0]).toContain("nothing to cancel");
    } finally {
      await fake.close();
    }
  });

  test("[smoke] --resume forwards an error frame from the daemon to stderr and exits 1", async () => {
    const fake = await startFakeDaemon(vaultPath, (frame) => {
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
    const daemon = await startTestRpcDaemon(vaultPath, [
      {
        method: "awaken.status",
        handler: makeAwakenStatusHandler({ surreal: connection }),
        kind: "read",
      },
    ]);
    try {
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
    } finally {
      await daemon.close();
    }
  });

  test("[smoke] --pause flips a running row to paused", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(5),
    });
    const fake = await startFakeDaemon(vaultPath, async (frame) => {
      expect(frame.method).toBe("awaken.pause");
      await updateStatus(connection.db, runId, "paused");
      return {
        type: "result",
        payload: {
          ok: true,
          runId: runId.toString(),
          processed: 0,
          failed: 0,
          total: 5,
          status: "paused",
          draining: false,
        },
      };
    });
    try {
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
    } finally {
      await fake.close();
    }
  });

  test("[smoke] --cancel flips a running row to cancelled", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(5),
    });
    const fake = await startFakeDaemon(vaultPath, async (frame) => {
      expect(frame.method).toBe("awaken.cancel");
      await updateStatus(connection.db, runId, "cancelled");
      return {
        type: "result",
        payload: {
          ok: true,
          runId: runId.toString(),
          processed: 0,
          failed: 0,
          total: 5,
          status: "cancelled",
          draining: false,
        },
      };
    });
    try {
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
    } finally {
      await fake.close();
    }
  });

  test("[smoke] --resume emits an awaken:resumed frame on a successful daemon response", async () => {
    const fakeRunId = createUuidRecordId(
      "awaken_run",
      "018f05cd-3f7b-7000-8000-000000000001",
    ).toString();
    const fake = await startFakeDaemon(vaultPath, (frame) => {
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
      paths: makeRunPaths(4),
    });
    await updateStatus(connection.db, runId, "running", { processed: 1, attempted: 1 });
    const daemon = await startTestRpcDaemon(vaultPath, [
      {
        method: "awaken.status",
        handler: makeAwakenStatusHandler({ surreal: connection }),
        kind: "read",
      },
    ]);
    try {
      const captured = makeCaptured();
      const flipPromise = (async () => {
        while (captured.stdout.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await updateStatus(connection.db, runId, "completed", { processed: 4, attempted: 4 });
      })();
      const exitCode = await runAwakenStatus({
        vaultPath,
        stdout: makeStdoutWriter(captured),
        stderr: makeStderrWriter(captured),
        pollIntervalMs: 25,
        follow: true,
      });
      await flipPromise;
      expect(exitCode).toBe(0);
      expect(captured.stdout.length).toBe(2);
      const last = JSON.parse(captured.stdout.at(-1) ?? "") as Record<string, unknown>;
      expect(last.type).toBe("awaken:status");
      expect(last.status).toBe("completed");
      expect(last.processed).toBe(4);
      expect(last.total).toBe(4);
    } finally {
      await daemon.close();
    }
  });
});
