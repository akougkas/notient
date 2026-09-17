/**
 * Daemon stop/start hooks shared by the operator verbs (`notient nuke`).
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
import { DISCONNECT_PREFIX, connectClient } from "../client";
import { parseDaemonPortFile } from "./surrealCli";

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

export const defaultDaemonStopHook: DaemonStopHook = async (args) => {
  const socketPath = resolveSocketPath(args.vaultPath, currentPlatform());
  const portFile = vaultPortPath(args.vaultPath);
  if (!(await pathExists(socketPath)) && !(await pathExists(portFile))) return;

  const shutdownFailure = await requestShutdownIfReachable(socketPath, args.vaultPath);
  await waitForPortRemoval(portFile, args.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, shutdownFailure);
  if (shutdownFailure !== null && !isShutdownRace(shutdownFailure)) throw shutdownFailure;
};

async function requestShutdownIfReachable(
  socketPath: string,
  vaultPath: string,
): Promise<Error | null> {
  if (!(await pathExists(socketPath))) return null;
  try {
    await requestShutdown(socketPath, vaultPath);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error("daemon shutdown failed with a non-Error");
  }
}

async function requestShutdown(socketPath: string, vaultPath: string): Promise<void> {
  const client = await connectClient({ socketPath, vaultPath, autoSpawn: false });
  try {
    let terminalSeen = false;
    for await (const frame of client.call("daemon.shutdown", {})) {
      if (frame.type === "ack") continue;
      if (frame.type === "error") throw decodeShutdownError(frame);
      if (frame.type !== "result" || !isExactShutdownResult(frame)) {
        throw new Error("daemon shutdown returned a malformed RPC stream");
      }
      terminalSeen = true;
    }
    if (!terminalSeen) throw new Error("daemon shutdown returned no terminal result");
  } finally {
    await client.close();
  }
}

function isExactShutdownResult(frame: Record<string, unknown>): boolean {
  const keys = Object.keys(frame).sort();
  return (
    keys.length === 3 &&
    keys[0] === "id" &&
    keys[1] === "ok" &&
    keys[2] === "type" &&
    typeof frame.id === "string" &&
    frame.id.length > 0 &&
    frame.ok === true
  );
}

function decodeShutdownError(frame: Record<string, unknown>): Error {
  const code = typeof frame.code === "string" ? frame.code : "WIRE_INTEGRITY";
  const message =
    typeof frame.message === "string" && frame.message.length > 0
      ? frame.message
      : "daemon shutdown returned a malformed error frame";
  return new Error(`${code}: ${message}`);
}

async function waitForPortRemoval(
  portFile: string,
  timeoutMs: number,
  shutdownFailure: Error | null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pathExists(portFile))) return;
    await sleep(50);
  }
  const timeout = new Error(
    `daemon stop: port file ${portFile} still present after ${timeoutMs}ms`,
  );
  if (shutdownFailure === null) throw timeout;
  throw new AggregateError([shutdownFailure, timeout], "daemon shutdown request and drain failed");
}

function isShutdownRace(error: Error): boolean {
  if (error.message.startsWith(DISCONNECT_PREFIX)) return true;
  if (!("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ECONNREFUSED";
}

export const defaultDaemonStartHook: DaemonStartHook = async (args) => {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--env-file=/dev/null", resolveDaemonEntry(), "--vault", args.vaultPath],
    { detached: true, stdio: "ignore", env: process.env },
  );
  child.unref();
  const portFile = vaultPortPath(args.vaultPath);
  const deadline = Date.now() + (args.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const port = await readDaemonPortIfPresent(portFile);
    if (port !== null) return;
    await sleep(100);
  }
  throw new Error(
    `daemon start: port file ${portFile} did not appear within ${args.timeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms`,
  );
};

async function readDaemonPortIfPresent(portFile: string): Promise<number | null> {
  try {
    return parseDaemonPortFile(await readFile(portFile, "utf8"));
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Mirrors the resolver in `daemon.ts#runStart`. Production runs spawn the
// sibling `dist/daemon.js`; dev runs spawn `src/daemon/index.ts`.
function resolveDaemonEntry(): string {
  if (import.meta.url.endsWith("/dist/notient.js")) {
    return new URL("./daemon.js", import.meta.url).pathname;
  }
  return new URL("../../daemon/index.ts", import.meta.url).pathname;
}
