/**
 * Daemon stop/start hooks shared by `notient nuke` and `notient migrate-vault`.
 *
 * Both verbs need to drive the daemon lifecycle from a CLI-facing process,
 * not from inside the daemon itself. The default implementations:
 *
 *   - Stop: connect to the unix-socket `daemon.shutdown` RPC and wait
 *     for the port file to disappear (signalling the surreal child has
 *     released its handles too). If the socket is missing, treat the
 *     daemon as already stopped.
 *   - Start: spawn `bun run src/cli/index.ts daemon start --vault <path>`
 *     and wait for the port file to reappear.
 *
 * Tests inject substitute hooks that drive a hand-rolled `surreal` server
 * directly so they can run without the unix-socket layer.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { vaultPortPath } from "../../core/vault/identity";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";

export interface DaemonStopArgs {
  vaultPath: string;
  timeoutMs?: number;
}

export interface DaemonStartArgs {
  vaultPath: string;
  timeoutMs?: number;
}

export type DaemonStopHook = (args: DaemonStopArgs) => Promise<void>;
export type DaemonStartHook = (args: DaemonStartArgs) => Promise<void>;

const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: stop-then-poll has unavoidable branching for the socket-missing, connect-failed, and post-stop-poll cases
export const defaultDaemonStopHook: DaemonStopHook = async (args) => {
  const socketPath = resolveSocketPath(args.vaultPath, currentPlatform());
  const socketAlive = await pathExists(socketPath);
  if (!socketAlive && !(await pathExists(vaultPortPath(args.vaultPath)))) {
    return;
  }
  if (socketAlive) {
    try {
      const client = await connectClient({ socketPath, vaultPath: args.vaultPath });
      for await (const frame of client.call("daemon.shutdown", {})) {
        if (frame.type === "result" || frame.type === "error") break;
      }
      await client.close();
    } catch {
      // Daemon may have already exited between the existence check and
      // the connect; the port-file poll below catches that case.
    }
  }
  const deadline = Date.now() + (args.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (!(await pathExists(vaultPortPath(args.vaultPath)))) return;
    await sleep(50);
  }
  throw new Error(
    `daemon stop: port file ${vaultPortPath(args.vaultPath)} still present after ${args.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS}ms`,
  );
};

export const defaultDaemonStartHook: DaemonStartHook = async (args) => {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--env-file=/dev/null",
      new URL("../../daemon/index.ts", import.meta.url).pathname,
      "--vault",
      args.vaultPath,
    ],
    { detached: true, stdio: "ignore", env: process.env },
  );
  child.unref();
  const portFile = vaultPortPath(args.vaultPath);
  const deadline = Date.now() + (args.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (await pathExists(portFile)) {
      const text = await readFile(portFile, "utf8").catch(() => "");
      if (Number(text.trim()) > 0) return;
    }
    await sleep(100);
  }
  throw new Error(
    `daemon start: port file ${portFile} did not appear within ${args.timeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms`,
  );
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
