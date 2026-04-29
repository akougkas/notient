import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";

export interface SurrealVersion {
  major: number;
  minor: number;
  patch: number;
}

const INSTALL_HINT =
  "SurrealDB 3.x is required. Install: curl -sSf https://install.surrealdb.com | sh";

/**
 * Parse the stdout of `surreal --version`. Returns the version tuple, or
 * `null` if the input is unparseable or the major version is below 3.
 */
export function parseSurrealVersion(stdout: string): SurrealVersion | null {
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (major < 3) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Extract the integer port from a stdout line of the form
 * `Started server at 127.0.0.1:NNNNN`. Returns null if not present.
 */
export function parseBoundPort(stdout: string): number | null {
  const match = stdout.match(/Started server at 127\.0\.0\.1:(\d+)/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

/**
 * Spawns `surreal --version`, parses the output, and returns the parsed
 * version on success. Throws if the binary is missing or pre-3.x.
 */
export async function checkSurrealBinary(): Promise<SurrealVersion> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["surreal", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new Error(INSTALL_HINT);
  }

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(INSTALL_HINT);
  }

  const version = parseSurrealVersion(stdout);
  if (!version) {
    throw new Error(INSTALL_HINT);
  }
  return version;
}

export interface SurrealServerOptions {
  dataDir: string;
  secret: string;
  portFile: string;
  pidFile: string;
  logLevel?: "trace" | "debug" | "info" | "warn" | "error" | "none";
  onUnexpectedExit?: (code: number | null) => void;
  /**
   * HNSW vector-index cache size in MiB, forwarded to the surreal child as
   * `SURREAL_HNSW_CACHE_SIZE`. Phase 4 Task 10 sources this from the
   * per-vault TOML config; bootstrap defaults it to 512 when omitted.
   */
  hnswCacheMib?: number;
}

export interface SurrealServerHandle {
  port: number;
  url: string;
  pid: number;
  stop(): Promise<void>;
}

export const STARTUP_TIMEOUT_MS = 5000;
export const STOP_TIMEOUT_MS = 10000;
export const RESTART_BUDGET = { maxRestarts: 3, windowMs: 60_000 } as const;

/**
 * Reserve a free TCP port on 127.0.0.1 by binding a temporary listener to
 * port 0, capturing the OS-assigned port, then closing the listener. There
 * is a small TOCTOU window between close and re-bind, but it is acceptable
 * for local single-tenant daemon spawn.
 *
 * SurrealDB 3.x logs the literal `--bind` argument verbatim, so binding to
 * port 0 makes the actual ephemeral port unobservable from log output. We
 * pre-allocate instead.
 */
async function reserveLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("reserveLocalPort: failed to obtain bound address"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Probe a 127.0.0.1 TCP port; resolves true when a connection is accepted,
 * false otherwise. Used to detect surreal readiness without depending on
 * log format or log level.
 */
async function probePort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const cleanup = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => cleanup(true));
    socket.once("error", () => cleanup(false));
    socket.setTimeout(500, () => cleanup(false));
  });
}

/**
 * Drain a stream silently. Used after startup to keep OS pipe buffers from
 * filling up and stalling the child.
 */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) {
        return;
      }
    }
  } catch {
    // ignore
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/**
 * Spawn `surreal start` with RocksDB storage, wait for it to bind a port,
 * write port/pid handoff files, and return a handle for graceful shutdown.
 */
export async function startSurreal(options: SurrealServerOptions): Promise<SurrealServerHandle> {
  await checkSurrealBinary();
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });

  const port = await reserveLocalPort();

  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (options.hnswCacheMib !== undefined) {
    childEnv.SURREAL_HNSW_CACHE_SIZE = String(options.hnswCacheMib);
  }

  const child = Bun.spawn(
    [
      "surreal",
      "start",
      "--bind",
      `127.0.0.1:${port}`,
      "--user",
      "root",
      "--pass",
      options.secret,
      "--log",
      options.logLevel ?? "warn",
      `rocksdb://${options.dataDir}`,
    ],
    { stdout: "pipe", stderr: "pipe", env: childEnv },
  );

  const stdoutStream = child.stdout as ReadableStream<Uint8Array>;
  const stderrStream = child.stderr as ReadableStream<Uint8Array>;

  // Drain output immediately so pipe buffers never block the child.
  void drainStream(stdoutStream);
  void drainStream(stderrStream);

  // Wait for the child to either accept a TCP connection on the chosen port
  // or exit prematurely, racing against STARTUP_TIMEOUT_MS.
  const exitedDuringStartup: { value: { code: number | null } | null } = { value: null };
  const exitWatch = child.exited.then((code) => {
    exitedDuringStartup.value = { code: code ?? null };
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    const exited = exitedDuringStartup.value;
    if (exited !== null) {
      throw new Error(`startSurreal: child exited before binding (code=${exited.code ?? "null"})`);
    }
    if (await probePort(port)) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Detach the exit watcher's role in startup (it remains harmless thereafter).
  void exitWatch;

  if (!ready) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    try {
      await child.exited;
    } catch {
      // ignore
    }
    throw new Error("startSurreal: timed out waiting for bound port");
  }

  await writeFile(options.portFile, `${port}\n`);
  await writeFile(options.pidFile, `${child.pid}\n`);

  let stopping = false;
  const restartTimestamps: number[] = [];

  void child.exited.then((code) => {
    if (stopping) {
      return;
    }
    const now = Date.now();
    restartTimestamps.push(now);
    while (restartTimestamps.length > 0 && now - restartTimestamps[0] > RESTART_BUDGET.windowMs) {
      restartTimestamps.shift();
    }
    options.onUnexpectedExit?.(code ?? null);
    // Phase 1: notification only; respawn is deferred to a later phase.
    if (restartTimestamps.length > RESTART_BUDGET.maxRestarts) {
      return;
    }
  });

  const stop = async (): Promise<void> => {
    stopping = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }

    let killTimeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      killTimeout = setTimeout(() => resolve("timeout"), STOP_TIMEOUT_MS);
    });
    const exitedPromise = child.exited.then(() => "exited" as const);

    const result = await Promise.race([exitedPromise, timeoutPromise]);
    if (killTimeout !== null) {
      clearTimeout(killTimeout);
    }
    if (result === "timeout") {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      await child.exited;
    }

    await unlink(options.portFile).catch(() => {});
    await unlink(options.pidFile).catch(() => {});
  };

  return {
    port,
    url: `ws://127.0.0.1:${port}/rpc`,
    pid: child.pid as number,
    stop,
  };
}
