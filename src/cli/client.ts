import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { type Socket, connect } from "node:net";
import { dirname } from "node:path";

export interface ClientOptions {
  socketPath: string;
  vaultPath: string;
  /** Override for the daemon binary path; default uses `process.execPath` argv[0]. */
  daemonCommand?: string;
  daemonArgs?: string[];
  spawnTimeoutMs?: number;
}

export interface RpcResponseFrame {
  id: string;
  type: "ack" | "event" | "result" | "error";
  [key: string]: unknown;
}

export interface ClientHandle {
  call(method: string, params: Record<string, unknown>): AsyncIterable<RpcResponseFrame>;
  close(): Promise<void>;
}

const SPAWN_DEFAULT_MS = 5000;

export async function connectClient(options: ClientOptions): Promise<ClientHandle> {
  const socket = await connectOrSpawn(options);
  let buffer = "";
  const queues = new Map<string, RpcResponseFrame[]>();
  const waiters = new Map<string, ((frame: RpcResponseFrame) => void)[]>();

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) deliver(line);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  let nextId = 1;

  function deliver(line: string): void {
    let frame: RpcResponseFrame;
    try {
      frame = JSON.parse(line) as RpcResponseFrame;
    } catch {
      return;
    }
    const id = frame.id;
    const waitingForId = waiters.get(id);
    if (waitingForId && waitingForId.length > 0) {
      const waiter = waitingForId.shift();
      if (waiter) waiter(frame);
      return;
    }
    const queue = queues.get(id) ?? [];
    queue.push(frame);
    queues.set(id, queue);
  }

  async function* call(
    method: string,
    params: Record<string, unknown>,
  ): AsyncIterable<RpcResponseFrame> {
    const id = `req-${nextId++}`;
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    while (true) {
      const frame = await nextFrame(id);
      yield frame;
      if (frame.type === "result" || frame.type === "error") return;
    }
  }

  function nextFrame(id: string): Promise<RpcResponseFrame> {
    const queue = queues.get(id);
    if (queue && queue.length > 0) {
      const frame = queue.shift();
      if (frame) return Promise.resolve(frame);
    }
    return new Promise((resolve) => {
      const list = waiters.get(id) ?? [];
      list.push(resolve);
      waiters.set(id, list);
    });
  }

  async function close(): Promise<void> {
    socket.end();
  }

  return { call, close };
}

async function connectOrSpawn(options: ClientOptions): Promise<Socket> {
  try {
    return await openSocket(options.socketPath);
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }

  spawnDaemon(options);
  const deadline = Date.now() + (options.spawnTimeoutMs ?? SPAWN_DEFAULT_MS);
  while (Date.now() < deadline) {
    if (await pathExists(options.socketPath)) {
      try {
        return await openSocket(options.socketPath);
      } catch {
        // fallthrough; the daemon may still be opening the socket file
      }
    }
    await sleep(50);
  }
  throw new Error(`Daemon failed to start within ${options.spawnTimeoutMs ?? SPAWN_DEFAULT_MS}ms`);
}

function spawnDaemon(options: ClientOptions): ChildProcess {
  const command = options.daemonCommand ?? process.execPath;
  // Bun re-reads .env from the spawned-process cwd at startup regardless of
  // the inherited parent env. The daemon already reads <vault>/.notient/.env
  // explicitly via readEnvSource in bootstrap.ts, so we disable Bun's
  // auto-load to keep the daemon's env source surface limited to (a) what
  // the parent process passed in `env` and (b) the vault-scoped .env file.
  // This prevents a project-root .env from leaking into a tmp-vault daemon
  // spawned by tests or by `notient daemon start --vault /elsewhere`.
  const baseArgs = options.daemonArgs ?? [
    "--env-file=/dev/null",
    resolveDaemonEntry(),
    "--vault",
    options.vaultPath,
  ];
  const child = spawn(command, baseArgs, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return child;
}

function resolveDaemonEntry(): string {
  // Two resolution targets:
  //   - Dev/source: src/cli/client.ts is sibling of src/daemon/index.ts
  //   - Bundled: dist/notient.js sits next to dist/daemon.js
  // Both files are siblings under their respective root, so the same URL
  // form works once we know which extension the runtime sees.
  const callerUrl = import.meta.url;
  if (callerUrl.endsWith(".ts")) {
    return new URL("../daemon/index.ts", callerUrl).pathname;
  }
  return new URL("./daemon.js", callerUrl).pathname;
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function useDirname(): string {
  return dirname(new URL(import.meta.url).pathname);
}
