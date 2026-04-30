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
    [resolveDaemonEntry(), "--vault", options.vaultPath],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.unref();
  options.emitter.emit({ type: "daemon:start_spawned", pid: child.pid ?? -1 });
}

// `import.meta.url` points to `dist/notient.js` in bundled runs and to
// `src/cli/commands/daemon.ts` in dev runs (esbuild does not inline this
// module). The daemon entry sits at `dist/daemon.js` and at
// `src/daemon/index.ts` respectively. The previous resolver walked two
// levels up from the bundle, which landed outside the project root.
function resolveDaemonEntry(): string {
  if (import.meta.url.endsWith("/dist/notient.js")) {
    return new URL("./daemon.js", import.meta.url).pathname;
  }
  return new URL("../../daemon/index.ts", import.meta.url).pathname;
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
