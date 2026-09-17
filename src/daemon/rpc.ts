import { type ApiErrorCode, NoteApiError } from "../api/schema";
export interface RpcEnvelope {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** Closed set of failure codes the daemon is allowed to place on the wire. */
export type RpcErrorCode =
  | ApiErrorCode
  | "DAEMON_MAINTENANCE"
  | "DAEMON_SHUTTING_DOWN"
  | "FORBIDDEN"
  | "HISTORY_CONFLICT"
  | "HISTORY_EMPTY"
  | "HISTORY_INVALID_PAYLOAD"
  | "HISTORY_NOT_FOUND"
  | "HISTORY_NOT_REVERSIBLE"
  | "INTERNAL"
  | "INVALID_LLM_OUTPUT"
  | "INVALID_PARAMS"
  | "METHOD_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "UNAUTHENTICATED"
  | "VISION_UNAVAILABLE";

export type ParseResult = { ok: true; envelope: RpcEnvelope } | { ok: false; reason: string };

/** Parse the one canonical request envelope accepted by the daemon. */
export function parseEnvelope(line: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "envelope is not an object" };
  }
  const candidate = raw as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== 3 || keys[0] !== "id" || keys[1] !== "method" || keys[2] !== "params") {
    return { ok: false, reason: "envelope must contain exactly id, method, and params" };
  }
  if (
    typeof candidate.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.id)
  ) {
    return { ok: false, reason: "id must be a canonical request id" };
  }
  if (typeof candidate.method !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/.test(candidate.method)) {
    return { ok: false, reason: "method must be a canonical method name" };
  }
  if (
    typeof candidate.params !== "object" ||
    candidate.params === null ||
    Array.isArray(candidate.params)
  ) {
    return { ok: false, reason: "params must be an object" };
  }
  return {
    ok: true,
    envelope: {
      id: candidate.id,
      method: candidate.method,
      params: candidate.params as Record<string, unknown>,
    },
  };
}

export function encodeAck(id: string, method: string): string {
  return JSON.stringify({ id, type: "ack", method });
}

/**
 * Envelope fields are written after the payload spread so that a handler
 * payload carrying `id`, `type`, or `event` can never shadow the routing
 * keys the client dispatches on.
 */
export function encodeEvent(id: string, event: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ ...payload, id, type: "event", event });
}

/** Envelope `id` and `type` always win over payload keys of the same name. */
export function encodeResult(id: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ ...payload, id, type: "result" });
}

export function encodeError(
  id: string,
  code: RpcErrorCode,
  message: string,
  detail?: Record<string, unknown>,
): string {
  if (
    detail !== undefined &&
    (typeof detail !== "object" || detail === null || Array.isArray(detail))
  ) {
    throw new Error("RPC error detail must be an object when provided");
  }
  return JSON.stringify({
    id,
    type: "error",
    code,
    message,
    detail: detail === undefined ? {} : detail,
  });
}

/**
 * RPC authority model.
 *
 * Every method carries a descriptor kind. A connection has no principal
 * until it calls `session.hello`; the dispatcher answers anything else with
 * `UNAUTHENTICATED`. Once a principal exists, a method whose kind is outside
 * the principal's scopes is refused with `FORBIDDEN`, and a second
 * `session.hello` is refused with `INVALID_PARAMS` so the principal on a
 * live connection can never be swapped.
 */
export type MethodKind = "read" | "write" | "admin" | "host";

export interface MethodDescriptor {
  kind: MethodKind;
}

export type PrincipalKind = "human" | "agent";

export interface Principal {
  /** Attribution id only. Never a capability. */
  id: string;
  kind: PrincipalKind;
  scopes: string[];
}

export const HUMAN_SCOPES: readonly MethodKind[] = ["read", "write", "admin"];
export const AGENT_SCOPES: readonly MethodKind[] = ["read", "write"];

export const HELLO_METHOD = "session.hello";
export const RPC_HELLO_TIMEOUT_MS = 10_000;
export const MAX_RPC_CONNECTIONS = 64;

/**
 * Admission gate and completion fence for RPC dispatch work. `start` stores
 * the exact Promise returned by the dispatcher so shutdown can close
 * admission, await every already-started handler, and only then tear down
 * the services those handlers can enqueue into or emit events from.
 */
export class RpcDispatchFence {
  private readonly inFlight = new Set<Promise<unknown>>();
  private accepting = true;
  private maintenanceOwner: string | null = null;
  private poisonedMaintenance = false;

  get size(): number {
    return this.inFlight.size;
  }

  get maintenanceConnectionId(): string | null {
    return this.maintenanceOwner;
  }

  get maintenancePoisoned(): boolean {
    return this.poisonedMaintenance;
  }

  isMaintenanceBlocked(connectionId: string): boolean {
    return this.maintenanceOwner !== null && this.maintenanceOwner !== connectionId;
  }

  /** Start and track one dispatch, or return null once shutdown has begun. */
  start<T>(dispatch: () => Promise<T>): Promise<T> | null {
    if (!this.accepting) return null;
    return this.track(dispatch());
  }

  /**
   * Block new callers immediately, drain the dispatches admitted before this
   * request, and only then run the maintenance-begin handler. The lease stays
   * owned by the connection after the handler returns.
   */
  enterMaintenance(connectionId: string, dispatch: () => Promise<void>): Promise<void> | null {
    if (!this.accepting || this.maintenanceOwner !== null) return null;
    this.maintenanceOwner = connectionId;
    this.poisonedMaintenance = false;
    const admitted = [...this.inFlight];
    return this.track(
      (async () => {
        await Promise.allSettled(admitted);
        // The owning socket may disappear while earlier dispatches drain.
        // Releasing its lease cancels a begin that has not reached the
        // handler; otherwise it could quiesce the daemon with no owner left
        // to send maintenance.end.
        if (this.maintenanceOwner !== connectionId) return;
        await dispatch();
      })(),
    );
  }

  releaseMaintenance(connectionId: string): boolean {
    if (this.maintenanceOwner !== connectionId) return false;
    this.maintenanceOwner = null;
    this.poisonedMaintenance = false;
    return true;
  }

  /** Keep admission fenced until an active maintenance owner is fully resumed. */
  async finishMaintenance(connectionId: string, cleanup: () => Promise<void>): Promise<boolean> {
    if (this.maintenanceOwner !== connectionId) return false;
    await this.track(cleanup());
    return this.releaseMaintenance(connectionId);
  }

  poisonMaintenance(connectionId: string): boolean {
    if (this.maintenanceOwner !== connectionId) return false;
    this.poisonedMaintenance = true;
    return true;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  /** Wait until every dispatch admitted before `stopAccepting` settles. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    void work.then(
      () => this.inFlight.delete(work),
      () => this.inFlight.delete(work),
    );
    return work;
  }
}

interface RpcConnectionEntry {
  helloDeadline: ReturnType<typeof setTimeout> | null;
}

/**
 * Owns admission and the authentication deadline for live RPC connections.
 *
 * Accepted connections occupy a slot until `release` is called, including
 * after authentication. The hello deadline is removed as soon as the
 * connection has an established principal, while the slot remains occupied
 * for the lifetime of the socket.
 */
export class RpcConnectionRegistry<Connection extends { destroy(): void }> {
  private readonly entries = new Map<Connection, RpcConnectionEntry>();
  private accepting = true;

  get size(): number {
    return this.entries.size;
  }

  /** Admit a connection or close it immediately when no slot is available. */
  accept(connection: Connection): boolean {
    if (!this.accepting || this.entries.size >= MAX_RPC_CONNECTIONS) {
      connection.destroy();
      return false;
    }

    const entry: RpcConnectionEntry = { helloDeadline: null };
    entry.helloDeadline = setTimeout(() => {
      if (this.entries.get(connection) !== entry || entry.helloDeadline === null) return;
      this.entries.delete(connection);
      entry.helloDeadline = null;
      connection.destroy();
    }, RPC_HELLO_TIMEOUT_MS);
    entry.helloDeadline.unref();
    this.entries.set(connection, entry);
    return true;
  }

  /** Keep an authenticated connection without retaining its hello timer. */
  markAuthenticated(connection: Connection): void {
    const entry = this.entries.get(connection);
    if (!entry || entry.helloDeadline === null) return;
    clearTimeout(entry.helloDeadline);
    entry.helloDeadline = null;
  }

  /** Release a closed connection and cancel any outstanding hello timer. */
  release(connection: Connection): void {
    const entry = this.entries.get(connection);
    if (!entry) return;
    if (entry.helloDeadline !== null) clearTimeout(entry.helloDeadline);
    this.entries.delete(connection);
  }

  /** Stop admission and cancel every deadline before daemon socket teardown. */
  shutdown(): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const entry of this.entries.values()) {
      if (entry.helloDeadline !== null) clearTimeout(entry.helloDeadline);
      entry.helloDeadline = null;
    }
  }

  connections(): IterableIterator<Connection> {
    return this.entries.keys();
  }
}

/** Per-connection state the dispatcher mutates on a successful hello. */
export interface ConnectionSession {
  /** A socket's work ends when its peer disconnects. Durable mutations still
   * keep their receipts and must finish any already-committed recovery steps. */
  signal?: AbortSignal;
  /** Stable id for the lifetime of one socket connection. */
  id: string;
  principal: Principal | null;
  /**
   * Set while a `session.hello` on this connection is still authenticating.
   * A client may write its hello and its first call in one socket write, and
   * the daemon dispatches every frame without awaiting the previous one, so
   * a non-hello frame awaits this before it reads `principal`. Without it the
   * pipelined call is answered `UNAUTHENTICATED`.
   */
  helloInFlight?: Promise<void> | null;
}

/**
 * Complete, authenticated context for one method invocation.
 *
 * Handlers receive exactly this object. Identity is available only through
 * the principal established by `session.hello`; there is no parallel string
 * argument that can drift from it, and transport fields are never optional.
 */
export interface RpcRequestContext {
  signal?: AbortSignal;
  params: Record<string, unknown>;
  emit: (line: string) => void;
  requestId: string;
  principal: Principal;
  connectionId: string;
}

export type MethodHandler = (request: RpcRequestContext) => Promise<Record<string, unknown>>;

export type Authenticator = (params: Record<string, unknown>) => Principal | Promise<Principal>;

export interface MethodDispatcherOptions {
  /** Resolves `session.hello` params into a principal. */
  authenticate?: Authenticator;
  beforeInvoke?: (method: string, kind: MethodKind) => void;
}

function readClientIdentity(params: Record<string, unknown>): string {
  const raw = params.clientIdentity;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : "human";
}

/**
 * Default authenticator for callers that stand up a dispatcher without a
 * token store (tests, embedded harnesses). It never grants `admin`.
 */
export const defaultAuthenticator: Authenticator = (params) => ({
  id: readClientIdentity(params),
  kind: "agent",
  scopes: [...AGENT_SCOPES],
});

/**
 * The only supported way for handler code to select a non-INTERNAL wire
 * error. Plain errors are implementation failures even when their message
 * happens to begin with an uppercase prefix.
 */
export class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface RpcFailure {
  code: RpcErrorCode;
  message: string;
  detail: Record<string, unknown>;
}

function rpcFailure(error: unknown): RpcFailure {
  if (error instanceof RpcError) {
    return { code: error.code, message: error.message, detail: error.detail };
  }
  if (error instanceof NoteApiError)
    return { code: error.code, message: error.message, detail: {} };
  if (error instanceof Error && error.name === "AbortError")
    return { code: "CANCELLED", message: "request cancelled", detail: {} };
  if (error instanceof Error && error.name === "TimeoutError")
    return { code: "LIMIT_EXCEEDED", message: "request time budget exhausted", detail: {} };
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL", message, detail: {} };
}

interface Registration {
  handler: MethodHandler;
  descriptor: MethodDescriptor;
}

export class MethodDispatcher {
  private readonly handlers = new Map<string, Registration>();
  private readonly authenticate: Authenticator;
  private readonly beforeInvoke?: MethodDispatcherOptions["beforeInvoke"];

  constructor(options: MethodDispatcherOptions = {}) {
    this.authenticate = options.authenticate ?? defaultAuthenticator;
    this.beforeInvoke = options.beforeInvoke;
  }

  register(method: string, handler: MethodHandler, descriptor: MethodDescriptor): void {
    this.handlers.set(method, { handler, descriptor });
  }

  /** Descriptor kind for a registered method; `undefined` when unknown. */
  kindOf(method: string): MethodKind | undefined {
    return this.handlers.get(method)?.descriptor.kind;
  }

  /** Authenticated transport entry point; HTTP and sockets share registrations. */
  async invoke(method: string, context: RpcRequestContext): Promise<Record<string, unknown>> {
    const registration = this.handlers.get(method);
    if (!registration) throw new RpcError("METHOD_NOT_FOUND", `unknown method: ${method}`);
    if (!context.principal.scopes.includes(registration.descriptor.kind))
      throw new RpcError("FORBIDDEN", `${method} requires ${registration.descriptor.kind} scope`);
    context.signal?.throwIfAborted();
    this.beforeInvoke?.(method, registration.descriptor.kind);
    return registration.handler(context);
  }

  async dispatch(
    envelope: RpcEnvelope,
    emit: (line: string) => void,
    session: ConnectionSession,
  ): Promise<void> {
    emit(encodeAck(envelope.id, envelope.method));

    if (envelope.method === HELLO_METHOD) {
      // Identity is established once per connection. A second hello would
      // otherwise swap the principal on a live connection, which is how an
      // agent connection could quietly upgrade itself to human.
      if (session.principal !== null || session.helloInFlight != null) {
        emit(
          encodeError(
            envelope.id,
            "INVALID_PARAMS",
            `${HELLO_METHOD} is already established on this connection`,
            { method: envelope.method },
          ),
        );
        return;
      }
      // Published before the first await so a frame dispatched later in the
      // same tick sees it and waits rather than reading a null principal.
      const attempt = Promise.resolve(this.authenticate(envelope.params));
      session.helloInFlight = attempt.then(
        () => {},
        () => {},
      );
      try {
        const principal = await attempt;
        session.principal = principal;
        emit(encodeResult(envelope.id, { ok: true, principal }));
      } catch (error) {
        const failure = rpcFailure(error);
        emit(encodeError(envelope.id, failure.code, failure.message, failure.detail));
      } finally {
        session.helloInFlight = null;
      }
      return;
    }

    await session.helloInFlight;
    const principal = session.principal;
    if (principal === null) {
      emit(
        encodeError(
          envelope.id,
          "UNAUTHENTICATED",
          `${HELLO_METHOD} must be the first method on a connection`,
          { method: envelope.method },
        ),
      );
      return;
    }

    const registration = this.handlers.get(envelope.method);
    if (!registration) {
      emit(
        encodeError(envelope.id, "METHOD_NOT_FOUND", `unknown method: ${envelope.method}`, {
          method: envelope.method,
        }),
      );
      return;
    }

    const required = registration.descriptor.kind;
    if (!principal.scopes.includes(required)) {
      emit(
        encodeError(
          envelope.id,
          "FORBIDDEN",
          `${envelope.method} requires the '${required}' scope`,
          { method: envelope.method, required, scopes: principal.scopes },
        ),
      );
      return;
    }

    try {
      const payload = await this.invoke(envelope.method, {
        params: envelope.params,
        emit,
        requestId: envelope.id,
        principal,
        connectionId: session.id,
        signal: session.signal,
      });
      emit(encodeResult(envelope.id, payload));
    } catch (error) {
      const failure = rpcFailure(error);
      emit(encodeError(envelope.id, failure.code, failure.message, failure.detail));
    }
  }
}
