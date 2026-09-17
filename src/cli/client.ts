import { type ChildProcess, spawn } from "node:child_process";
import { type Socket, connect } from "node:net";
import { DEFAULT_AGENT_ID, validateAgentId } from "../core/auth/agentIdentity";
import { vaultAdminTokenPath, vaultDaemonPidPath } from "../core/vault/identity";
import { deriveAgentCredential } from "../daemon/auth";
import {
  type PidFileSnapshot,
  inspectPidFile,
  isProcessAlive,
  readAdminToken,
} from "../daemon/lifecycle";
import { AGENT_SCOPES, HELLO_METHOD, HUMAN_SCOPES, type Principal } from "../daemon/rpc";

export interface ClientOptions {
  /** Bounds this connection, including its authenticated hello and later reads. */
  signal?: AbortSignal;
  socketPath: string;
  vaultPath: string;
  spawnTimeoutMs?: number;
  autoSpawn?: boolean;
  /**
   * Authenticated identity established once in `session.hello`. Unset means
   * the reserved human operator; every explicit non-human id uses a derived
   * agent credential bound to that exact id.
   */
  clientIdentity?: string;
  /**
   * Root-token override used to construct the hello. When omitted, the client
   * reads `~/.notient/<vaultId>/admin.token`. Human clients send the token;
   * named agents send only an HMAC derived from it and their canonical id.
   * The root token never appears in an agent hello.
   */
  rootToken?: string;
}

export interface RpcResponseFrame {
  id: string;
  type: "ack" | "event" | "result" | "error";
  [key: string]: unknown;
}

export interface ClientHandle {
  call(method: string, params: Record<string, unknown>): AsyncIterable<RpcResponseFrame>;
  close(): Promise<void>;
  /** Principal the daemon assigned to this connection during `session.hello`. */
  readonly principal: Principal;
}

// Cold-start cost on the daemon side is dominated by the embedded SurrealDB
// child-process spawn, schema apply, and watcher readiness over the vault.
// Large WSL /mnt/c vaults have repeatedly taken longer than 30s while still
// booting successfully, so the default has to tolerate that first-run path.
// Callers that need a tighter bound pass spawnTimeoutMs.
const SPAWN_DEFAULT_MS = 120_000;
const SHUTDOWN_OWNER_WAIT_MS = 60_000;
const LIFECYCLE_POLL_MS = 50;

/**
 * Prefix on every error raised because the transport went away. Callers
 * match on it to distinguish "the daemon died" from a handler-level error
 * frame.
 */
export const DISCONNECT_PREFIX = "DAEMON_DISCONNECTED";

interface Waiter {
  resolve: (frame: RpcResponseFrame) => void;
  reject: (error: Error) => void;
}

interface ActiveRequestState {
  method: string;
  ackSeen: boolean;
  terminalSeen: boolean;
}

function decodeIncomingFrame(
  line: string,
  activeRequests: ReadonlyMap<string, ActiveRequestState>,
): RpcResponseFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("wire integrity: daemon sent invalid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("wire integrity: daemon response is not an object");
  }
  const frame = raw as RpcResponseFrame;
  const id = frame.id;
  const state = typeof id === "string" ? activeRequests.get(id) : undefined;
  if (state === undefined) {
    throw new Error("wire integrity: daemon response has an unknown request id");
  }
  if (
    frame.type !== "ack" &&
    frame.type !== "event" &&
    frame.type !== "result" &&
    frame.type !== "error"
  ) {
    throw new Error("wire integrity: daemon response has an invalid frame type");
  }
  if (state.terminalSeen) {
    throw new Error("wire integrity: daemon sent a frame after the terminal response");
  }
  if (frame.type === "ack") {
    const keys = Object.keys(frame).sort();
    if (
      state.ackSeen ||
      keys.length !== 3 ||
      keys[0] !== "id" ||
      keys[1] !== "method" ||
      keys[2] !== "type" ||
      frame.method !== state.method
    ) {
      throw new Error("wire integrity: daemon sent an invalid acknowledgement");
    }
    state.ackSeen = true;
    return frame;
  }
  if (!state.ackSeen) {
    throw new Error("wire integrity: daemon sent a response before its acknowledgement");
  }
  if (frame.type === "result" || frame.type === "error") {
    state.terminalSeen = true;
  }
  return frame;
}

export async function connectClient(options: ClientOptions): Promise<ClientHandle> {
  options.signal?.throwIfAborted();
  const socket = await connectOrSpawn(options);
  if (options.signal?.aborted) {
    socket.destroy();
    options.signal.throwIfAborted();
  }
  let buffer = "";
  const queues = new Map<string, RpcResponseFrame[]>();
  const waiters = new Map<string, Waiter[]>();
  const activeRequests = new Map<string, ActiveRequestState>();
  /**
   * Set once the transport goes away. Every pending waiter is rejected with
   * it and every later `call()` throws it synchronously, so a daemon that
   * dies mid-stream surfaces as a `DAEMON_DISCONNECTED` error instead of an
   * async iterator that never yields again.
   */
  let disconnected: Error | null = null;
  const abort = () => {
    fail("connection cancelled");
    socket.destroy();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  function fail(reason: string): void {
    if (disconnected !== null) return;
    disconnected = new Error(`${DISCONNECT_PREFIX}: ${reason}`);
    const pending = [...waiters.values()].flat();
    waiters.clear();
    for (const waiter of pending) waiter.reject(disconnected);
  }

  socket.on("error", (error: Error) => {
    fail(error.message);
  });
  socket.on("close", () => {
    options.signal?.removeEventListener("abort", abort);
    fail("daemon closed the connection");
  });

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
      frame = decodeIncomingFrame(line, activeRequests);
    } catch (error) {
      fail(error instanceof Error ? error.message : "wire integrity: invalid daemon response");
      socket.destroy();
      return;
    }
    const id = frame.id;
    const waitingForId = waiters.get(id);
    if (waitingForId && waitingForId.length > 0) {
      const waiter = waitingForId.shift();
      if (waiter) waiter.resolve(frame);
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
    if (disconnected !== null) throw disconnected;
    const id = `req-${nextId++}`;
    // No frame-level identity: the daemon binds the principal once, at
    // `session.hello`, and ignores any per-frame assertion.
    activeRequests.set(id, { method, ackSeen: false, terminalSeen: false });
    try {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
      while (true) {
        const responseFrame = await nextFrame(id);
        yield responseFrame;
        if (responseFrame.type === "result" || responseFrame.type === "error") return;
      }
    } finally {
      activeRequests.delete(id);
      queues.delete(id);
      waiters.delete(id);
    }
  }

  function nextFrame(id: string): Promise<RpcResponseFrame> {
    const queue = queues.get(id);
    if (queue && queue.length > 0) {
      const frame = queue.shift();
      if (frame) return Promise.resolve(frame);
    }
    // Frames already buffered before the disconnect are drained above; only
    // once the queue is empty does the disconnect become terminal.
    if (disconnected !== null) return Promise.reject(disconnected);
    return new Promise((resolve, reject) => {
      const list = waiters.get(id) ?? [];
      list.push({ resolve, reject });
      waiters.set(id, list);
    });
  }

  async function close(): Promise<void> {
    socket.end();
  }

  try {
    const principal = await performHello(call, options);
    return { call, close, principal };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * Send `session.hello` and adopt the principal the daemon assigns.
 *
 * This must be the first method on the connection: the daemon answers
 * anything else with `UNAUTHENTICATED`. A hello that errors is fatal — the
 * connection is unusable — so it surfaces as a thrown error rather than a
 * silently degraded handle.
 */
async function performHello(
  call: (method: string, params: Record<string, unknown>) => AsyncIterable<RpcResponseFrame>,
  options: ClientOptions,
): Promise<Principal> {
  const clientIdentity = options.clientIdentity ?? DEFAULT_AGENT_ID;
  const rootToken = await resolveRootToken(options);
  const params: Record<string, unknown> =
    clientIdentity === DEFAULT_AGENT_ID
      ? { clientIdentity, token: rootToken }
      : {
          clientIdentity,
          agentCredential: deriveAgentCredential(rootToken, clientIdentity),
        };
  for await (const frame of call(HELLO_METHOD, params)) {
    const principal = decodeHelloFrame(frame, clientIdentity);
    if (principal !== null) return principal;
  }
  throw new Error(`${HELLO_FAILED_PREFIX}: daemon closed before answering ${HELLO_METHOD}`);
}

function decodeHelloFrame(frame: RpcResponseFrame, clientIdentity: string): Principal | null {
  if (frame.type === "ack") return null;
  if (frame.type === "error") {
    if (!hasExactKeys(frame, ["id", "type", "code", "message", "detail"])) {
      throw new Error(`${HELLO_FAILED_PREFIX}: malformed error frame`);
    }
    const message = frame.message;
    if (typeof message !== "string" || message.length === 0) {
      throw new Error(`${HELLO_FAILED_PREFIX}: malformed error frame`);
    }
    throw new Error(`${HELLO_FAILED_PREFIX}: ${message}`);
  }
  if (frame.type === "event") {
    throw new Error(`${HELLO_FAILED_PREFIX}: unexpected event frame`);
  }
  if (!hasExactKeys(frame, ["id", "type", "ok", "principal"])) {
    throw new Error(`${HELLO_FAILED_PREFIX}: malformed result frame`);
  }
  if (frame.ok !== true) {
    throw malformedPrincipal("hello result ok must be true");
  }
  return decodePrincipal(frame.principal, clientIdentity);
}

/** Prefix on the error raised when `session.hello` is refused. */
export const HELLO_FAILED_PREFIX = "HELLO_FAILED";

async function resolveRootToken(options: ClientOptions): Promise<string> {
  const token = options.rootToken ?? (await readAdminToken(vaultAdminTokenPath(options.vaultPath)));
  if (token === null) {
    throw new Error(
      `${HELLO_FAILED_PREFIX}: daemon root token is unavailable for ${options.clientIdentity ?? DEFAULT_AGENT_ID}`,
    );
  }
  return token;
}

function decodePrincipal(raw: unknown, requestedId: string): Principal {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw malformedPrincipal("principal must be an object");
  }
  const candidate = raw as Record<string, unknown>;
  if (!hasExactKeys(candidate, ["id", "kind", "scopes"])) {
    throw malformedPrincipal("principal must contain exactly id, kind, and scopes");
  }
  if (typeof candidate.id !== "string") {
    throw malformedPrincipal("id must be a string");
  }
  const validatedId = validateAgentId(candidate.id);
  if (!validatedId.valid || validatedId.id !== candidate.id) {
    throw malformedPrincipal("id must be a canonical agent id");
  }
  if (candidate.id !== requestedId) {
    throw malformedPrincipal(`daemon assigned ${candidate.id}, requested ${requestedId}`);
  }
  if (candidate.kind !== "human" && candidate.kind !== "agent") {
    throw malformedPrincipal("kind must be 'human' or 'agent'");
  }
  const expectedKind = requestedId === DEFAULT_AGENT_ID ? "human" : "agent";
  if (candidate.kind !== expectedKind) {
    throw malformedPrincipal(`${requestedId} must be assigned kind '${expectedKind}'`);
  }
  const expectedScopes = candidate.kind === "human" ? HUMAN_SCOPES : AGENT_SCOPES;
  if (
    !Array.isArray(candidate.scopes) ||
    candidate.scopes.length !== expectedScopes.length ||
    candidate.scopes.some((scope, index) => scope !== expectedScopes[index])
  ) {
    throw malformedPrincipal(
      `${candidate.kind} scopes must be exactly [${expectedScopes.join(", ")}]`,
    );
  }
  return { id: candidate.id, kind: candidate.kind, scopes: [...expectedScopes] };
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function malformedPrincipal(reason: string): Error {
  return new Error(`${HELLO_FAILED_PREFIX}: malformed principal: ${reason}`);
}

export interface ConnectLifecycleDeps {
  openSocket(path: string, signal?: AbortSignal): Promise<Socket>;
  inspectPid(path: string): Promise<PidFileSnapshot>;
  isProcessAlive(pid: number): boolean;
  spawnDaemon(options: ClientOptions): void;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

const productionLifecycleDeps: ConnectLifecycleDeps = {
  openSocket,
  inspectPid: inspectPidFile,
  isProcessAlive,
  spawnDaemon: (options) => {
    spawnDaemon(options);
  },
  now: () => performance.now(),
  sleep,
};

export async function connectOrSpawn(
  options: ClientOptions,
  deps: ConnectLifecycleDeps = productionLifecycleDeps,
): Promise<Socket> {
  return await new DaemonConnector(options, deps).connect();
}

export class DaemonConnectionTimeoutError extends Error {
  constructor(
    timeoutMs: number,
    cause: unknown,
    readonly ownerPid: number | null,
  ) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`Daemon connection did not become ready within ${timeoutMs}ms${detail}`, { cause });
    this.name = "DaemonConnectionTimeoutError";
  }
}

interface ObservedOwner {
  pid: number;
  instanceId: string | null;
  booting: boolean;
  deadline: number;
}

class DaemonConnector {
  private readonly timeoutMs: number;
  private readonly deadline: number;
  private readonly pidPath: string;
  private spawned = false;
  private observedOwner: ObservedOwner | null = null;
  private lastSocketError: unknown;

  constructor(
    private readonly options: ClientOptions,
    private readonly deps: ConnectLifecycleDeps,
  ) {
    this.timeoutMs = options.spawnTimeoutMs ?? SPAWN_DEFAULT_MS;
    this.deadline = deps.now() + this.timeoutMs;
    this.pidPath = vaultDaemonPidPath(options.vaultPath);
    this.lastSocketError = new Error(`daemon socket is unavailable: ${options.socketPath}`);
  }

  async connect(): Promise<Socket> {
    while (this.deps.now() < this.deadline) {
      this.options.signal?.throwIfAborted();
      const socket = await this.step();
      if (socket !== null) return socket;
    }
    throw new DaemonConnectionTimeoutError(
      this.timeoutMs,
      this.lastSocketError,
      this.observedOwner?.pid ?? null,
    );
  }

  private async step(): Promise<Socket | null> {
    if (await this.waitForRetiringOwner()) return null;
    const socket = await this.tryOpenSocket();
    if (socket !== null) return socket;
    if (await this.waitForObservedOwner()) return null;

    const snapshot = await this.deps.inspectPid(this.pidPath);
    if (await this.adoptLiveOwner(snapshot)) return null;
    if (snapshot.kind === "invalid") {
      throw new Error(`invalid daemon pid file: ${snapshot.reason}`);
    }
    if (this.options.autoSpawn === false) throw this.lastSocketError;
    this.spawnOnce();
    await this.deps.sleep(LIFECYCLE_POLL_MS);
    return null;
  }

  private async waitForRetiringOwner(): Promise<boolean> {
    const owner = this.observedOwner;
    if (owner === null || owner.booting) return false;
    return await this.waitWhileAlive(owner);
  }

  /** Retain a captured pid even after its on-disk record disappears. */
  private async waitForObservedOwner(): Promise<boolean> {
    const owner = this.observedOwner;
    if (owner === null) return false;
    return await this.waitWhileAlive(owner);
  }

  private async waitWhileAlive(owner: ObservedOwner): Promise<boolean> {
    if (!this.deps.isProcessAlive(owner.pid)) {
      this.observedOwner = null;
      return false;
    }
    assertOwnerDeadline(owner, this.deps.now());
    await this.deps.sleep(LIFECYCLE_POLL_MS);
    return true;
  }

  private async tryOpenSocket(): Promise<Socket | null> {
    try {
      return await this.deps.openSocket(this.options.socketPath, this.options.signal);
    } catch (error) {
      if (!isMissingError(error)) throw error;
      this.lastSocketError = error;
      return null;
    }
  }

  private async adoptLiveOwner(snapshot: PidFileSnapshot): Promise<boolean> {
    const liveOwner = liveOwnerFrom(snapshot, this.deps.isProcessAlive);
    if (liveOwner === null) return false;
    const ownerWaitMs = liveOwner.booting
      ? Math.max(0, this.deadline - this.deps.now())
      : SHUTDOWN_OWNER_WAIT_MS;
    this.observedOwner = {
      ...liveOwner,
      deadline: Math.min(this.deadline, this.deps.now() + ownerWaitMs),
    };
    assertOwnerDeadline(this.observedOwner, this.deps.now());
    await this.deps.sleep(LIFECYCLE_POLL_MS);
    return true;
  }

  private spawnOnce(): void {
    this.options.signal?.throwIfAborted();
    if (this.spawned) return;
    this.deps.spawnDaemon(this.options);
    this.spawned = true;
  }
}

function liveOwnerFrom(
  snapshot: PidFileSnapshot,
  processAlive: (pid: number) => boolean,
): { pid: number; instanceId: string | null; booting: boolean } | null {
  if (snapshot.kind === "record" && processAlive(snapshot.record.pid)) {
    return {
      pid: snapshot.record.pid,
      instanceId: snapshot.record.instanceId,
      booting: snapshot.record.booting,
    };
  }
  if (snapshot.kind === "invalid" && snapshot.pid !== null && processAlive(snapshot.pid)) {
    return { pid: snapshot.pid, instanceId: null, booting: false };
  }
  return null;
}

function assertOwnerDeadline(owner: { pid: number; deadline: number }, now: number): void {
  if (now < owner.deadline) return;
  throw new Error(`daemon pid ${owner.pid} did not exit before its lifecycle deadline`);
}

function spawnDaemon(options: ClientOptions): ChildProcess {
  // Bun re-reads .env from the spawned-process cwd at startup regardless of
  // the inherited parent env. The daemon already reads <vault>/.notient/.env
  // explicitly via readEnvSource in envFile.ts, so we disable Bun's
  // auto-load to keep the daemon's env source surface limited to (a) what
  // the parent process passed in `env` and (b) the vault-scoped .env file.
  // This prevents a project-root .env from leaking into a tmp-vault daemon
  // spawned by tests or by `notient daemon start --vault /elsewhere`.
  const args = ["--env-file=/dev/null", resolveDaemonEntry(), "--vault", options.vaultPath];
  const child = spawn(process.execPath, args, {
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

function openSocket(path: string, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path, signal });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
