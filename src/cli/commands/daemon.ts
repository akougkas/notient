import { spawn } from "node:child_process";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter, StructuredEvent } from "../output";

export interface DaemonCommandOptions {
  verb: "start" | "stop" | "status" | "list";
  vaultPath: string | null;
  emitter: Emitter;
  clientIdentity?: string;
}

interface DaemonStatusProbe {
  status: "ok" | "mismatch";
  configuredModel: string;
  loadedModel: string | null;
  message: string;
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
  const child = spawn(process.execPath, [resolveDaemonEntry(), "--vault", options.vaultPath], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
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
    options.emitter.emit(renderDaemonStatusFrame(frame));
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
}

export function renderDaemonStatusFrame(frame: Record<string, unknown>): StructuredEvent {
  const type = typeof frame.type === "string" ? frame.type : "event";
  if (type !== "result") {
    return { ...frame, type: `rpc:${type}` };
  }
  const probe = parseDaemonStatusProbe(frame.probe);
  if (probe === null) {
    return { ...frame, type: "rpc:result" };
  }

  const { type: _type, id, ...rest } = frame;
  const rendered: StructuredEvent = {
    type: "rpc:result",
    id,
    modelStatus: probe.status,
    configuredModel: probe.configuredModel,
    loadedModel: probe.loadedModel,
  };
  if (probe.status === "mismatch") {
    rendered.modelWarning = probe.message;
  }
  return { ...rendered, ...rest };
}

function parseDaemonStatusProbe(value: unknown): DaemonStatusProbe | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== "ok" && status !== "mismatch") return null;
  if (typeof value.configuredModel !== "string") return null;
  if (value.loadedModel !== null && typeof value.loadedModel !== "string") return null;
  return {
    status,
    configuredModel: value.configuredModel,
    loadedModel: value.loadedModel,
    message:
      typeof value.message === "string"
        ? value.message
        : `model ${status}: configured ${value.configuredModel}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
