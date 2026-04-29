import { spawn } from "node:child_process";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface DaemonCommandOptions {
  verb: "start" | "stop" | "status" | "list";
  vaultPath: string | null;
  emitter: Emitter;
  clientIdentity?: string;
}

export async function runDaemonCommand(options: DaemonCommandOptions): Promise<void> {
  switch (options.verb) {
    case "start":
      await runStart(options);
      return;
    case "stop":
      await runStop(options);
      return;
    case "status":
      await runStatus(options);
      return;
    case "list":
      options.emitter.emit({ type: "daemon:list", note: "stub", lastVault: options.vaultPath });
      return;
  }
}

async function runStart(options: DaemonCommandOptions): Promise<void> {
  if (!options.vaultPath) throw new Error("daemon start requires --vault");
  const child = spawn(
    process.execPath,
    [new URL("../../daemon/index.ts", import.meta.url).pathname, "--vault", options.vaultPath],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.unref();
  options.emitter.emit({ type: "daemon:start_spawned", pid: child.pid ?? -1 });
}

async function runStop(options: DaemonCommandOptions): Promise<void> {
  if (!options.vaultPath) throw new Error("daemon stop requires --vault");
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });
  for await (const frame of client.call("daemon.shutdown", {})) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
}

async function runStatus(options: DaemonCommandOptions): Promise<void> {
  if (!options.vaultPath) throw new Error("daemon status requires --vault");
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });
  for await (const frame of client.call("daemon.status", {})) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
}
