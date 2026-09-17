import { type ChildProcess, spawn } from "node:child_process";
import { describeIndexing, indexingReadinessSchema } from "../../api/indexing";
import { vaultDaemonPidPath } from "../../core/vault/identity";
import {
  type PidRecord,
  inspectPidFile,
  isProcessAlive,
  listDaemonPidFiles,
} from "../../daemon/lifecycle";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { DaemonConnectionTimeoutError, connectClient } from "../client";
import type { Emitter, StructuredEvent } from "../output";

export type DaemonStartObservation =
  | { state: "reachable"; frame: Record<string, unknown> }
  | { state: "owned"; owner: PidRecord }
  | { state: "absent" };

export type DaemonStartProbe = (options: {
  vaultPath: string;
  socketPath: string;
  clientIdentity?: string;
}) => Promise<DaemonStartObservation>;

export type DaemonProcessSpawner = (vaultPath: string) => Pick<ChildProcess, "pid" | "unref">;

export interface DaemonCommandOptions {
  verb: "start" | "stop" | "status" | "list";
  vaultPath: string | null;
  emitter: Emitter;
  clientIdentity?: string;
  startProbe?: DaemonStartProbe;
  spawnDaemon?: DaemonProcessSpawner;
  connect?: typeof connectClient;
}

interface DaemonStatusProbe {
  status: "ok" | "mismatch";
  configuredModel: string;
  loadedModel: string | null;
  message: string;
}

const START_PROBE_TRANSITION_MS = 250;

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
      await runList(options);
      return;
  }
}

/**
 * Enumerate daemons from `~/.notient/<vault-id>/daemon.pid`.
 *
 * Reading pid files keeps `list` cheap and side-effect free: connecting to
 * each socket would both cost a round trip per vault and spawn a daemon
 * for any vault whose socket is missing, which is the opposite of what an
 * inventory command should do. Liveness comes from signal 0 on the
 * recorded pid; entries whose process is gone are reported as stale rather
 * than hidden, so an operator can see the debris.
 */
async function runList(options: DaemonCommandOptions): Promise<void> {
  const entries = await listDaemonPidFiles();
  options.emitter.emit({
    type: "daemon:list",
    count: entries.length,
    daemons: entries.map((entry) => ({
      vault: entry.record.vault,
      vaultId: entry.vaultId,
      pid: entry.record.pid,
      socketPath: entry.record.socketPath,
      startedAt: entry.record.startedAt,
      state: entry.alive ? (entry.record.booting ? "booting" : "running") : "stale",
      instanceId: entry.record.instanceId,
    })),
  });
}

async function runStart(options: DaemonCommandOptions): Promise<void> {
  if (!options.vaultPath) throw new Error("daemon start requires --vault");
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const probe = options.startProbe ?? ((input) => probeExistingDaemon(input, options.connect));
  const probeInput = {
    vaultPath: options.vaultPath,
    socketPath,
    clientIdentity: options.clientIdentity,
  };
  const observation = await probe(probeInput);
  if (reportExistingStart(options.emitter, observation)) return;

  // The daemon owns startup capability resolution. Local operation must not
  // depend on a CLI-only model chooser or mutate saved configuration.
  const finalObservation = await probe(probeInput);
  if (reportExistingStart(options.emitter, finalObservation)) return;

  const child = (options.spawnDaemon ?? spawnDaemonProcess)(options.vaultPath);
  child.unref();
  options.emitter.emit({ type: "daemon:start_spawned", pid: child.pid ?? -1 });
}

function reportExistingStart(emitter: Emitter, observation: DaemonStartObservation): boolean {
  if (observation.state === "reachable") {
    emitter.emit(renderDaemonAlreadyRunningFrame(observation.frame));
    return true;
  }
  if (observation.state === "owned") {
    const owner = observation.owner;
    emitter.emit({
      type: "daemon:start_in_progress",
      state: owner.booting ? "booting" : "stopping",
      vault: owner.vault,
      pid: owner.pid,
      instanceId: owner.instanceId,
      socketPath: owner.socketPath,
      startedAt: owner.startedAt,
    });
    return true;
  }
  return false;
}

function spawnDaemonProcess(vaultPath: string): Pick<ChildProcess, "pid" | "unref"> {
  return spawn(
    process.execPath,
    ["--env-file=/dev/null", resolveDaemonEntry(), "--vault", vaultPath],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
}

async function probeExistingDaemon(
  options: {
    vaultPath: string;
    socketPath: string;
    clientIdentity?: string;
  },
  connect: typeof connectClient = connectClient,
): Promise<DaemonStartObservation> {
  let client: Awaited<ReturnType<typeof connectClient>>;
  try {
    client = await connect({
      socketPath: options.socketPath,
      vaultPath: options.vaultPath,
      clientIdentity: options.clientIdentity,
      autoSpawn: false,
      spawnTimeoutMs: START_PROBE_TRANSITION_MS,
    });
  } catch (error) {
    const snapshot = await inspectPidFile(vaultDaemonPidPath(options.vaultPath));
    if (snapshot.kind === "record" && isProcessAlive(snapshot.record.pid)) {
      return { state: "owned", owner: snapshot.record };
    }
    // A short read-only probe may have waited on a shutdown owner that exited
    // during its last poll. Preserve ownership while alive, but do not let the
    // wrapped timeout hide a now-absent socket and prevent an explicit start.
    if (
      error instanceof DaemonConnectionTimeoutError &&
      (error.ownerPid === null || !isProcessAlive(error.ownerPid)) &&
      isMissingSocketError(error.cause)
    )
      return { state: "absent" };
    if (isMissingSocketError(error)) return { state: "absent" };
    throw error;
  }

  try {
    for await (const frame of client.call("daemon.status", {})) {
      if (frame.type === "result" || frame.type === "error") {
        return { state: "reachable", frame };
      }
    }
  } finally {
    await client.close();
  }
  throw new Error("daemon start: connected daemon returned no status result");
}

// Source and bundled entry points each keep the CLI and daemon as siblings
// within their runtime tree.
export function resolveDaemonEntry(): string {
  if (import.meta.url.endsWith("/dist/notient.js")) {
    return new URL("./daemon.js", import.meta.url).pathname;
  }
  return new URL("../../daemon/index.ts", import.meta.url).pathname;
}

async function runStop(options: DaemonCommandOptions): Promise<void> {
  if (!options.vaultPath) throw new Error("daemon stop requires --vault");
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  let client: Awaited<ReturnType<typeof connectClient>>;
  try {
    client = await (options.connect ?? connectClient)({
      socketPath,
      vaultPath: options.vaultPath,
      clientIdentity: options.clientIdentity,
      autoSpawn: false,
    });
  } catch (error) {
    if (!isMissingSocketError(error)) throw error;
    options.emitter.emit({
      type: "daemon:already_stopped",
      vault: options.vaultPath,
    });
    return;
  }
  try {
    for await (const frame of client.call("daemon.shutdown", {})) {
      options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
      if (frame.type === "result" || frame.type === "error") break;
    }
  } finally {
    await client.close();
  }
}

async function runStatus(options: DaemonCommandOptions): Promise<void> {
  if (!options.vaultPath) throw new Error("daemon status requires --vault");
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  // Report what the pid file claims before touching the socket. The RPC
  // call below still spawns a daemon when none is listening (the documented
  // behaviour of `status`), but the operator sees up-front whether a
  // process was already recorded for this vault and whether it is alive.
  const snapshot = await inspectPidFile(vaultDaemonPidPath(options.vaultPath));
  if (snapshot.kind === "missing") {
    options.emitter.emit({ type: "daemon:pidfile", state: "absent", vault: options.vaultPath });
  } else if (snapshot.kind === "invalid") {
    options.emitter.emit({
      type: "daemon:pidfile",
      state: "invalid",
      vault: options.vaultPath,
      reason: snapshot.reason,
    });
  } else {
    const record = snapshot.record;
    const alive = isProcessAlive(record.pid);
    options.emitter.emit({
      type: "daemon:pidfile",
      state: alive ? (record.booting ? "booting" : "running") : "stale",
      vault: record.vault,
      pid: record.pid,
      instanceId: record.instanceId,
      socketPath: record.socketPath,
      startedAt: record.startedAt,
    });
  }
  const client = await (options.connect ?? connectClient)({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });
  try {
    for await (const frame of client.call("daemon.status", {})) {
      options.emitter.emit(renderDaemonStatusFrame(frame));
      if (frame.type === "result" || frame.type === "error") break;
    }
  } finally {
    await client.close();
  }
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
    indexingSummary: describeIndexing(indexingReadinessSchema.parse(frame.indexing)),
    modelStatus: probe.status,
    configuredModel: probe.configuredModel,
    loadedModel: probe.loadedModel,
  };
  if (probe.status === "mismatch") {
    rendered.modelWarning = probe.message;
  }
  return { ...rendered, ...rest };
}

export function renderDaemonAlreadyRunningFrame(frame: Record<string, unknown>): StructuredEvent {
  const rendered = renderDaemonStatusFrame(frame);
  if (rendered.type !== "rpc:result") return rendered;
  const { type: _type, id: _id, ...rest } = rendered;
  return { type: "daemon:already_running", ...rest };
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

function isMissingSocketError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}
