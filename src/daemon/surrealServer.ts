import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";

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
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
  } catch {
    throw new Error(INSTALL_HINT);
  }

  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

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
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "none";
  onUnexpectedExit?: (code: number | null) => void;
  /**
   * HNSW vector-index cache size in MiB, forwarded to the SurrealDB child as
   * `SURREAL_HNSW_CACHE_SIZE`. Bootstrap supplies the strict per-vault config.
   */
  hnswCacheMib: number;
}

export interface SurrealServerHandle {
  port: number;
  url: string;
  pid: number;
  stop(): Promise<void>;
}

export interface SurrealStartInvocation {
  argv: string[];
  env: Record<string, string>;
}

interface SurrealOwnershipBase {
  format: "notient-surreal-process";
  version: 2;
  instanceId: string;
  dataDir: string;
  expectedExecutable: string;
}

interface SurrealOwnershipIntent extends SurrealOwnershipBase {
  state: "starting";
  port: number;
  ownerPid: number;
  ownerProof: SurrealProcessProof;
}

interface SurrealOwnershipRecord extends SurrealOwnershipBase {
  state: "running";
  pid: number;
  port: number;
  proof: SurrealProcessProof;
}

type SurrealOwnership = SurrealOwnershipIntent | SurrealOwnershipRecord;

interface LinuxProcessIdentity {
  bootId: string;
  processStartTicks: string;
  executable: string;
  argv: string[];
  environment: string[];
}

interface DarwinProcessIdentity {
  bootTime: string;
  processStartedAt: string;
  executable: string;
  commandWithEnvironment: string;
}

export type SurrealProcessProof =
  | {
      kind: "linux-procfs";
      bootId: string;
      processStartTicks: string;
      executable: string;
    }
  | {
      kind: "darwin-process";
      bootTime: string;
      processStartedAt: string;
      executable: string;
    }
  | {
      kind: "unavailable";
      executable: string;
    };

export const STARTUP_TIMEOUT_MS = 5000;
export const STOP_TIMEOUT_MS = 10000;
const STALE_PROCESS_POLL_MS = 100;
const FRESH_PROCESS_PROOF_TIMEOUT_MS = 1000;

/** Build the embedded server boundary without exposing its root secret in argv. */
export function buildSurrealStartInvocation(
  options: SurrealServerOptions,
  port: number,
  instanceId: string,
  executablePath: string | undefined = process.env.PATH,
): SurrealStartInvocation {
  assertSurrealRuntimeOptions(options);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("startSurreal: port must be an integer between 1 and 65535");
  }
  if (instanceId.length === 0) {
    throw new Error("startSurreal: instanceId must be non-empty");
  }
  const env: Record<string, string> = {
    NOTIENT_SURREAL_INSTANCE_ID: instanceId,
    SURREAL_PASS: options.secret,
    SURREAL_HNSW_CACHE_SIZE: String(options.hnswCacheMib),
  };
  if (executablePath !== undefined) env.PATH = executablePath;
  return {
    argv: [
      "surreal",
      "start",
      "--bind",
      `127.0.0.1:${port}`,
      "--user",
      "root",
      "--log",
      options.logLevel,
      `rocksdb://${options.dataDir}`,
    ],
    env,
  };
}

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
  assertSurrealRuntimeOptions(options);
  await checkSurrealBinary();
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const canonicalDataDir = await realpath(options.dataDir);
  const runtimeOptions = { ...options, dataDir: canonicalDataDir };
  await stopStaleSurrealProcess(runtimeOptions);

  const port = await reserveLocalPort();
  const instanceId = randomUUID();
  const invocation = buildSurrealStartInvocation(runtimeOptions, port, instanceId);
  const locatedExecutable = Bun.which(invocation.argv[0]) ?? invocation.argv[0];
  const expectedExecutable = await realpath(locatedExecutable).catch(() => locatedExecutable);
  const ownerProof = await captureFreshSurrealProof(process.pid, process.execPath);
  await claimSurrealOwnership(options.pidFile, {
    format: "notient-surreal-process",
    version: 2,
    state: "starting",
    instanceId,
    dataDir: canonicalDataDir,
    expectedExecutable,
    port,
    ownerPid: process.pid,
    ownerProof,
  });

  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(invocation.argv, {
      stdout: "pipe",
      stderr: "pipe",
      env: invocation.env,
    });
  } catch (error) {
    await removeOwnedSurrealHandoff(options, instanceId);
    throw error;
  }

  const stdoutStream = child.stdout as ReadableStream<Uint8Array>;
  const stderrStream = child.stderr as ReadableStream<Uint8Array>;

  // Drain output immediately so pipe buffers never block the child.
  void drainStream(stdoutStream);
  void drainStream(stderrStream);

  try {
    const proof = await captureFreshSurrealProof(child.pid, expectedExecutable);
    const record: SurrealOwnershipRecord = {
      format: "notient-surreal-process",
      version: 2,
      state: "running",
      instanceId,
      dataDir: canonicalDataDir,
      expectedExecutable,
      pid: child.pid,
      port,
      proof,
    };
    if (proof.kind !== "unavailable" && !(await processMatchesOwnership(record))) {
      throw new Error("startSurreal: could not establish child process ownership");
    }
    await publishSurrealOwnership(options.pidFile, instanceId, record);
  } catch (error) {
    await stopSpawnedChild(child);
    await removeOwnedSurrealHandoff(options, instanceId);
    throw error;
  }

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
      await removeOwnedSurrealHandoff(options, instanceId);
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
    await stopSpawnedChild(child);
    await removeOwnedSurrealHandoff(options, instanceId);
    throw new Error("startSurreal: timed out waiting for bound port");
  }

  try {
    await writeFile(options.portFile, `${port}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    await stopSpawnedChild(child);
    await removeOwnedSurrealHandoff(options, instanceId);
    throw error;
  }

  let stopping = false;

  void child.exited.then((code) => {
    if (stopping) return;
    options.onUnexpectedExit?.(code ?? null);
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

    await removeOwnedSurrealHandoff(options, instanceId);
  };

  return {
    port,
    url: `ws://127.0.0.1:${port}/rpc`,
    pid: child.pid as number,
    stop,
  };
}

function assertSurrealRuntimeOptions(options: SurrealServerOptions): void {
  const logLevels = new Set(["trace", "debug", "info", "warn", "error", "none"]);
  if (!logLevels.has(options.logLevel)) {
    throw new Error("startSurreal: logLevel must be a supported SurrealDB log level");
  }
  if (
    !Number.isInteger(options.hnswCacheMib) ||
    options.hnswCacheMib < 1 ||
    options.hnswCacheMib > 1_048_576
  ) {
    throw new Error("startSurreal: hnswCacheMib must be an integer between 1 and 1048576");
  }
}

export async function stopStaleSurrealProcess(
  options: Pick<SurrealServerOptions, "dataDir" | "pidFile" | "portFile">,
): Promise<void> {
  const ownership = await readSurrealOwnership(options.pidFile);
  if (ownership === null) {
    await unlink(options.portFile).catch(() => {});
    return;
  }
  if (ownership.kind === "invalid") {
    throw new Error(
      `startSurreal: refusing to trust invalid ownership record at ${options.pidFile}: ${ownership.reason}`,
    );
  }

  const canonicalDataDir = await realpath(options.dataDir);
  if (ownership.record.dataDir !== canonicalDataDir) {
    throw new Error("startSurreal: Surreal ownership record belongs to a different data directory");
  }
  if (ownership.record.state === "starting") {
    await recoverStartingOwnership(options, ownership.record);
    return;
  }

  const record = ownership.record;
  if (!processIsAlive(record.pid)) {
    await removeOwnedSurrealHandoff(options, record.instanceId);
    return;
  }
  if (!(await processMatchesOwnership(record))) {
    throw new Error(
      "startSurreal: recorded pid is alive but is not provably this vault's SurrealDB child; refusing to signal it",
    );
  }
  await terminateOwnedProcess(record);
  await removeOwnedSurrealHandoff(options, record.instanceId);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function terminateOwnedProcess(record: SurrealOwnershipRecord): Promise<void> {
  if (!(await processMatchesOwnership(record))) return;
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    return;
  }
  if (await waitForOwnedProcessExit(record, STOP_TIMEOUT_MS)) return;
  if (!(await processMatchesOwnership(record))) return;
  try {
    process.kill(record.pid, "SIGKILL");
  } catch {
    return;
  }
  await waitForOwnedProcessExit(record, STOP_TIMEOUT_MS);
}

async function waitForOwnedProcessExit(
  record: SurrealOwnershipRecord,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(record.pid) || !(await processMatchesOwnership(record))) return true;
    await new Promise((resolve) => setTimeout(resolve, STALE_PROCESS_POLL_MS));
  }
  return !processIsAlive(record.pid) || !(await processMatchesOwnership(record));
}

async function stopSpawnedChild(child: Bun.Subprocess): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child already exited.
    }
  }, STOP_TIMEOUT_MS);
  try {
    await child.exited;
  } finally {
    clearTimeout(timeout);
  }
}

async function processMatchesOwnership(record: SurrealOwnershipRecord): Promise<boolean> {
  if (record.proof.kind === "linux-procfs" && process.platform === "linux") {
    return processMatchesLinuxOwnership(record, record.proof);
  }
  if (record.proof.kind === "darwin-process" && process.platform === "darwin") {
    return processMatchesDarwinOwnership(record, record.proof);
  }
  return false;
}

async function processMatchesLinuxOwnership(
  record: SurrealOwnershipRecord,
  proof: Extract<SurrealProcessProof, { kind: "linux-procfs" }>,
): Promise<boolean> {
  const identity = await readLinuxProcessIdentity(record.pid);
  if (identity === null) return false;
  return (
    linuxIdentityMatchesProof(identity, proof) &&
    identity.executable === record.expectedExecutable &&
    identity.argv.includes("start") &&
    identity.argv.includes(`rocksdb://${record.dataDir}`) &&
    identity.environment.includes(`NOTIENT_SURREAL_INSTANCE_ID=${record.instanceId}`)
  );
}

async function processMatchesDarwinOwnership(
  record: SurrealOwnershipRecord,
  proof: Extract<SurrealProcessProof, { kind: "darwin-process" }>,
): Promise<boolean> {
  const identity = await readDarwinProcessIdentity(record.pid);
  if (identity === null) return false;
  return (
    darwinIdentityMatchesProof(identity, proof) &&
    identity.executable === record.expectedExecutable &&
    commandContainsToken(identity.commandWithEnvironment, "start") &&
    identity.commandWithEnvironment.includes(`rocksdb://${record.dataDir}`) &&
    identity.commandWithEnvironment.includes(`NOTIENT_SURREAL_INSTANCE_ID=${record.instanceId}`)
  );
}

/**
 * A fresh child is owned through its Bun subprocess handle on every platform.
 * Linux records procfs generation evidence for later stale-PID recovery.
 * macOS uses its stock ps/sysctl/lsof process surfaces when all are available;
 * otherwise it records that proof is unavailable. Fresh children remain
 * owned through their Bun subprocess handle, but unavailable proof can never
 * authorize signaling a stale live pid.
 */
export async function captureFreshSurrealProof(
  pid: number,
  executable: string,
  platform: NodeJS.Platform = process.platform,
): Promise<SurrealProcessProof> {
  if (platform === "linux") {
    const deadline = Date.now() + FRESH_PROCESS_PROOF_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const identity = await readLinuxProcessIdentity(pid);
      if (identity?.executable === executable) {
        return {
          kind: "linux-procfs",
          bootId: identity.bootId,
          processStartTicks: identity.processStartTicks,
          executable: identity.executable,
        };
      }
      if (!processIsAlive(pid)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("startSurreal: Linux procfs could not capture expected process generation");
  }
  if (platform === "darwin" && process.platform === "darwin") {
    const identity = await readDarwinProcessIdentity(pid);
    if (identity !== null) return darwinProof(identity);
  }
  return { kind: "unavailable", executable };
}

async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | null> {
  try {
    const [bootId, stat, executable, argv, environment] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
      readlink(`/proc/${pid}/exe`),
      readNullSeparatedFile(`/proc/${pid}/cmdline`),
      readNullSeparatedFile(`/proc/${pid}/environ`),
    ]);
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const statFields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/);
    const processStartTicks = statFields[19];
    if (processStartTicks === undefined || !/^\d+$/.test(processStartTicks)) return null;
    return {
      bootId: bootId.trim(),
      processStartTicks,
      executable,
      argv,
      environment,
    };
  } catch {
    // If the platform cannot prove identity, stale cleanup must fail closed.
    return null;
  }
}

function linuxIdentityMatchesProof(
  identity: LinuxProcessIdentity,
  proof: Extract<SurrealProcessProof, { kind: "linux-procfs" }>,
): boolean {
  return (
    identity.bootId === proof.bootId &&
    identity.processStartTicks === proof.processStartTicks &&
    identity.executable === proof.executable
  );
}

async function readDarwinProcessIdentity(pid: number): Promise<DarwinProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const [bootTime, processStartedAt, executableOutput, commandWithEnvironment] =
      await Promise.all([
        runDarwinCommand(["/usr/sbin/sysctl", "-n", "kern.boottime"]),
        runDarwinCommand(["/bin/ps", "-p", String(pid), "-o", "lstart="]),
        runDarwinCommand(["/usr/sbin/lsof", "-a", "-p", String(pid), "-d", "txt", "-Fn"]),
        runDarwinCommand(["/bin/ps", "-ww", "-E", "-p", String(pid), "-o", "command="]),
      ]);
    const executable = parseDarwinExecutable(executableOutput);
    if (
      bootTime.length === 0 ||
      processStartedAt.length === 0 ||
      executable === null ||
      commandWithEnvironment.length === 0
    ) {
      return null;
    }
    return { bootTime, processStartedAt, executable, commandWithEnvironment };
  } catch {
    return null;
  }
}

async function runDarwinCommand(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, {
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Darwin process probe exited ${exitCode}`);
  return stdout.trim();
}

function parseDarwinExecutable(output: string): string | null {
  const paths = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("n") && line.length > 1)
    .map((line) => line.slice(1));
  return paths.length === 1 ? paths[0] : null;
}

function darwinProof(identity: DarwinProcessIdentity): SurrealProcessProof {
  return {
    kind: "darwin-process",
    bootTime: identity.bootTime,
    processStartedAt: identity.processStartedAt,
    executable: identity.executable,
  };
}

function darwinIdentityMatchesProof(
  identity: DarwinProcessIdentity,
  proof: Extract<SurrealProcessProof, { kind: "darwin-process" }>,
): boolean {
  return (
    identity.bootTime === proof.bootTime &&
    identity.processStartedAt === proof.processStartedAt &&
    identity.executable === proof.executable
  );
}

function commandContainsToken(command: string, token: string): boolean {
  return command.split(/\s+/).includes(token);
}

async function recoverStartingOwnership(
  options: Pick<SurrealServerOptions, "pidFile" | "portFile">,
  intent: SurrealOwnershipIntent,
): Promise<void> {
  if (intent.ownerProof.kind === "linux-procfs" && process.platform === "linux") {
    await recoverLinuxStartingOwnership(options, intent, intent.ownerProof);
    return;
  }
  if (intent.ownerProof.kind === "darwin-process" && process.platform === "darwin") {
    await recoverDarwinStartingOwnership(options, intent, intent.ownerProof);
    return;
  }
  throw new Error(
    "startSurreal: incomplete ownership record cannot be proved safe on this platform; refusing automatic recovery",
  );
}

async function recoverLinuxStartingOwnership(
  options: Pick<SurrealServerOptions, "pidFile" | "portFile">,
  intent: SurrealOwnershipIntent,
  ownerProof: Extract<SurrealProcessProof, { kind: "linux-procfs" }>,
): Promise<void> {
  const ownerIdentity = await readLinuxProcessIdentity(intent.ownerPid);
  if (ownerIdentity !== null && linuxIdentityMatchesProof(ownerIdentity, ownerProof)) {
    throw new Error("startSurreal: another live Notient process still owns SurrealDB startup");
  }

  const children = await findLinuxChildrenForIntent(intent);
  if (children.length > 1) {
    throw new Error(
      "startSurreal: multiple processes match an incomplete ownership generation; refusing to signal any",
    );
  }
  const child = children[0];
  if (child !== undefined) await terminateOwnedProcess(child);
  await removeOwnedSurrealHandoff(options, intent.instanceId);
}

async function recoverDarwinStartingOwnership(
  options: Pick<SurrealServerOptions, "pidFile" | "portFile">,
  intent: SurrealOwnershipIntent,
  ownerProof: Extract<SurrealProcessProof, { kind: "darwin-process" }>,
): Promise<void> {
  const ownerIdentity = await readDarwinProcessIdentity(intent.ownerPid);
  if (ownerIdentity !== null && darwinIdentityMatchesProof(ownerIdentity, ownerProof)) {
    throw new Error("startSurreal: another live Notient process still owns SurrealDB startup");
  }

  const children = await findDarwinChildrenForIntent(intent);
  if (children.length > 1) {
    throw new Error(
      "startSurreal: multiple processes match an incomplete ownership generation; refusing to signal any",
    );
  }
  const child = children[0];
  if (child !== undefined) await terminateOwnedProcess(child);
  await removeOwnedSurrealHandoff(options, intent.instanceId);
}

async function findLinuxChildrenForIntent(
  intent: SurrealOwnershipIntent,
): Promise<SurrealOwnershipRecord[]> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const matches: SurrealOwnershipRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const identity = await readLinuxProcessIdentity(pid);
    if (identity === null) continue;
    if (identity.executable !== intent.expectedExecutable) continue;
    if (!identity.argv.includes("start")) continue;
    if (!identity.argv.includes(`rocksdb://${intent.dataDir}`)) continue;
    if (!identity.environment.includes(`NOTIENT_SURREAL_INSTANCE_ID=${intent.instanceId}`)) {
      continue;
    }
    matches.push({
      format: "notient-surreal-process",
      version: 2,
      state: "running",
      instanceId: intent.instanceId,
      dataDir: intent.dataDir,
      expectedExecutable: intent.expectedExecutable,
      pid,
      port: intent.port,
      proof: {
        kind: "linux-procfs",
        bootId: identity.bootId,
        processStartTicks: identity.processStartTicks,
        executable: identity.executable,
      },
    });
  }
  return matches;
}

async function findDarwinChildrenForIntent(
  intent: SurrealOwnershipIntent,
): Promise<SurrealOwnershipRecord[]> {
  const processList = await runDarwinCommand(["/bin/ps", "-A", "-ww", "-o", "pid=,command="]);
  const candidates = parseDarwinProcessList(processList).filter((candidate) => {
    return (
      commandContainsToken(candidate.command, "start") &&
      candidate.command.includes(`rocksdb://${intent.dataDir}`)
    );
  });
  const matches: SurrealOwnershipRecord[] = [];
  for (const candidate of candidates) {
    const identity = await readDarwinProcessIdentity(candidate.pid);
    if (identity === null || identity.executable !== intent.expectedExecutable) continue;
    if (
      !identity.commandWithEnvironment.includes(`NOTIENT_SURREAL_INSTANCE_ID=${intent.instanceId}`)
    ) {
      continue;
    }
    matches.push({
      format: "notient-surreal-process",
      version: 2,
      state: "running",
      instanceId: intent.instanceId,
      dataDir: intent.dataDir,
      expectedExecutable: intent.expectedExecutable,
      pid: candidate.pid,
      port: intent.port,
      proof: darwinProof(identity),
    });
  }
  return matches;
}

function parseDarwinProcessList(output: string): Array<{ pid: number; command: string }> {
  const processes: Array<{ pid: number; command: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    processes.push({ pid, command: match[2] });
  }
  return processes;
}

async function readNullSeparatedFile(path: string): Promise<string[]> {
  const raw = await readFile(path);
  return raw
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

async function claimSurrealOwnership(path: string, record: SurrealOwnershipIntent): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

async function publishSurrealOwnership(
  path: string,
  instanceId: string,
  record: SurrealOwnershipRecord,
): Promise<void> {
  const temporaryPath = `${path}.${instanceId}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const current = await readSurrealOwnership(path);
    if (
      current === null ||
      current.kind !== "record" ||
      current.record.instanceId !== instanceId ||
      current.record.state !== "starting"
    ) {
      throw new Error("startSurreal: ownership record changed while the child was starting");
    }
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

type SurrealOwnershipSnapshot =
  | { kind: "record"; record: SurrealOwnership }
  | { kind: "invalid"; reason: string };

async function readSurrealOwnership(path: string): Promise<SurrealOwnershipSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { kind: "invalid", reason: "record is unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "record is not valid JSON" };
  }
  const reason = validateSurrealOwnership(parsed);
  if (reason !== null) return { kind: "invalid", reason };
  return { kind: "record", record: parsed as SurrealOwnership };
}

function validateSurrealOwnership(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "record is not an object";
  }
  const candidate = value as Record<string, unknown>;
  const baseReason = validateSurrealOwnershipBase(candidate);
  if (baseReason !== null) return baseReason;
  if (candidate.state === "starting") return validateStartingOwnership(candidate);
  if (candidate.state === "running") return validateRunningOwnership(candidate);
  return "state must be starting or running";
}

function validateSurrealOwnershipBase(candidate: Record<string, unknown>): string | null {
  if (candidate.format !== "notient-surreal-process" || candidate.version !== 2) {
    return "record format is unsupported";
  }
  if (typeof candidate.instanceId !== "string" || candidate.instanceId.length === 0) {
    return "instanceId must be non-empty";
  }
  if (typeof candidate.dataDir !== "string" || candidate.dataDir.length === 0) {
    return "dataDir must be non-empty";
  }
  if (
    typeof candidate.expectedExecutable !== "string" ||
    candidate.expectedExecutable.length === 0
  ) {
    return "expectedExecutable must be non-empty";
  }
  const portReason = validatePort(candidate.port);
  return portReason;
}

function validateStartingOwnership(candidate: Record<string, unknown>): string | null {
  if (!Number.isSafeInteger(candidate.ownerPid) || (candidate.ownerPid as number) <= 0) {
    return "ownerPid must be a positive integer";
  }
  const ownerProofReason = validateProcessProof(candidate.ownerProof);
  return ownerProofReason === null ? null : `ownerProof ${ownerProofReason}`;
}

function validateRunningOwnership(candidate: Record<string, unknown>): string | null {
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0) {
    return "pid must be a positive integer";
  }
  const proofReason = validateProcessProof(candidate.proof);
  return proofReason === null ? null : `proof ${proofReason}`;
}

function validatePort(value: unknown): string | null {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    return "port must be an integer between 1 and 65535";
  }
  return null;
}

function validateProcessProof(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "must be an object";
  }
  const proof = value as Record<string, unknown>;
  if (proof.kind === "unavailable") {
    return typeof proof.executable === "string" && proof.executable.length > 0
      ? null
      : "executable must be non-empty";
  }
  const fields =
    proof.kind === "linux-procfs"
      ? (["bootId", "processStartTicks", "executable"] as const)
      : proof.kind === "darwin-process"
        ? (["bootTime", "processStartedAt", "executable"] as const)
        : null;
  if (fields === null) return "kind is unsupported";
  for (const field of fields) {
    if (typeof proof[field] !== "string" || proof[field].length === 0) {
      return `${field} must be non-empty`;
    }
  }
  return null;
}

async function removeOwnedSurrealHandoff(
  options: Pick<SurrealServerOptions, "pidFile" | "portFile">,
  instanceId: string,
): Promise<void> {
  const current = await readSurrealOwnership(options.pidFile);
  if (current === null || current.kind !== "record" || current.record.instanceId !== instanceId) {
    return;
  }
  await unlink(options.portFile).catch(() => {});
  await unlink(options.pidFile).catch(() => {});
}
