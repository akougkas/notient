import { randomUUID } from "node:crypto";
import { type OperationName, operationInputs } from "../api/operations";
import { type ImplementedOperation, eventsResultSchema, operationOutputs } from "../api/results";
import { NoteApiError } from "../api/schema";
import type { PairingStore } from "./pairing";
import { type Principal, RpcError, type RpcRequestContext } from "./rpc";

export interface HttpApiOptions {
  invoke: (method: string, context: RpcRequestContext) => Promise<Record<string, unknown>>;
  pairing: PairingStore;
  port?: number;
  admission?: () => boolean;
}

/** Loopback transport over the authenticated, fenced domain dispatcher. */
export function startHttpApi(options: HttpApiOptions) {
  const active = new Map<string, Set<AbortController>>();
  const requests = new Set<Promise<Response>>();
  let accepting = true;
  let count = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 30,
    maxRequestBodySize: 8 * 1024 * 1024,
    fetch: (request) => {
      const work = respond(request);
      requests.add(work);
      void work.finally(() => requests.delete(work));
      return work;
    },
  });

  async function respond(request: Request): Promise<Response> {
    const correlationId = request.headers.get("x-correlation-id") ?? randomUUID();
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "x-correlation-id": correlationId,
    };
    if (request.headers.get("origin") === "app://obsidian.md") {
      headers["access-control-allow-origin"] = "app://obsidian.md";
      headers.vary = "Origin";
    }
    try {
      validateRequestOrigin(request, server.port ?? 0);
      if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(correlationId))
        throw new RpcError("INVALID_PARAMS", "invalid correlation id");
      if (request.method === "OPTIONS") return preflight(headers);
      assertAdmission();
      const url = new URL(request.url);
      if (url.search)
        throw new RpcError(
          "INVALID_PARAMS",
          "query parameters are not accepted; credentials belong in Authorization",
        );
      if (url.pathname === "/api/v1/discovery" && request.method === "GET")
        return Response.json(
          { name: "Notient", apiVersion: "v1", pairing: "local-code" },
          { headers },
        );
      if (url.pathname === "/api/v1/pair" && request.method === "POST")
        return await exchange(request, headers);
      return await authenticated(request, url, correlationId, headers);
    } catch (error) {
      return errorResponse(error, correlationId, headers);
    }
  }
  function assertAdmission(): void {
    if (!accepting || options.admission?.() === false)
      throw new RpcError("DAEMON_MAINTENANCE", "daemon is stopping or undergoing maintenance");
    if (count >= 32) throw new RpcError("LIMIT_EXCEEDED", "HTTP concurrency limit reached");
  }
  async function exchange(request: Request, headers: Record<string, string>): Promise<Response> {
    count++;
    try {
      return Response.json(await options.pairing.exchange(await readJson(request)), { headers });
    } finally {
      count--;
    }
  }
  async function authenticated(
    request: Request,
    url: URL,
    id: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const token = bearer(request);
    const credential = options.pairing.authenticate(token);
    const controller = new AbortController();
    const controllers = active.get(credential.credentialId) ?? new Set<AbortController>();
    controllers.add(controller);
    active.set(credential.credentialId, controllers);
    count++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      count--;
      controllers.delete(controller);
      if (!controllers.size) active.delete(credential.credentialId);
    };
    const signal = AbortSignal.any([
      request.signal,
      controller.signal,
      AbortSignal.timeout(180000),
    ]);
    const invoke = async (method: string, params: Record<string, unknown>) => {
      assertAdmissionForActive();
      options.pairing.authenticate(token);
      const result = await options.invoke(method, {
        params,
        principal: credential.principal,
        requestId: id,
        connectionId: `http-${credential.credentialId}`,
        emit: () => {},
        signal,
      });
      options.pairing.authenticate(token);
      signal.throwIfAborted();
      return result;
    };
    try {
      if (url.pathname === "/api/v1/events" && request.method === "GET") {
        const cursor = request.headers.get("last-event-id") ?? undefined;
        const first = await invoke("events.subscribe", { ...(cursor ? { cursor } : {}) });
        return eventStream(first, invoke, signal, release, headers);
      }
      const method = operationFromUrl(url, request.method);
      const parsed = operationInputs[method].safeParse(await readJson(request));
      if (!parsed.success) throw new RpcError("INVALID_PARAMS", parsed.error.message);
      const result = operationOutputs[method].parse(await invoke(method, parsed.data));
      release();
      return Response.json({ ...result, correlationId: id }, { headers });
    } catch (error) {
      release();
      throw error;
    }
  }
  function assertAdmissionForActive(): void {
    if (!accepting || options.admission?.() === false)
      throw new RpcError("DAEMON_MAINTENANCE", "daemon is stopping or undergoing maintenance");
  }
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    revoke: async (id: string, principal: Principal) => {
      for (const controller of active.get(id) ?? [])
        controller.abort(new RpcError("UNAUTHENTICATED", "credential revoked"));
      await options.pairing.revoke(id, principal);
    },
    stop: async () => {
      accepting = false;
      for (const set of active.values()) for (const controller of set) controller.abort();
      await server.stop(true);
      await Promise.allSettled([...requests]);
    },
  };
}

function operationFromUrl(url: URL, verb: string): ImplementedOperation {
  const method = url.pathname.replace(/^\/api\/v1\//, "").replaceAll("/", ".");
  if (
    !url.pathname.startsWith("/api/v1/") ||
    !Object.hasOwn(operationOutputs, method) ||
    verb !== "POST"
  )
    throw new RpcError("NOT_FOUND", "unknown API operation");
  return method as ImplementedOperation;
}
function preflight(headers: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers":
        "Authorization, Content-Type, X-Correlation-Id, Last-Event-ID",
    },
  });
}
function errorResponse(
  error: unknown,
  correlationId: string,
  headers: Record<string, string>,
): Response {
  const known = error instanceof RpcError || error instanceof NoteApiError;
  const code = known
    ? error.code
    : error instanceof DOMException && error.name === "AbortError"
      ? "CANCELLED"
      : error instanceof Error && error.name === "TimeoutError"
        ? "LIMIT_EXCEEDED"
        : "INTERNAL_ERROR";
  const status: Record<string, number> = {
    UNAUTHENTICATED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_FOUND: 404,
    INVALID_PARAMS: 400,
    LIMIT_EXCEEDED: 429,
    CONFLICT: 409,
    CANCELLED: 409,
    DAEMON_MAINTENANCE: 503,
    INFERENCE_UNAVAILABLE: 503,
  };
  return Response.json(
    {
      error: { code, message: known ? error.message : "request could not complete" },
      correlationId,
    },
    { status: status[code] ?? 500, headers },
  );
}
function validateRequestOrigin(request: Request, port: number): void {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!allowedHosts.includes(request.headers.get("host") ?? ""))
    throw new RpcError("FORBIDDEN", "unrecognized HTTP Host");
  const origin = request.headers.get("origin");
  if (
    origin !== null &&
    origin !== "app://obsidian.md" &&
    !allowedHosts.some((host) => origin === `http://${host}`)
  )
    throw new RpcError("FORBIDDEN", "origin is not an authorized desktop client");
}
function bearer(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(value))
    throw new RpcError("UNAUTHENTICATED", "scoped bearer credential required");
  return value.slice(7);
}
async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new RpcError("INVALID_PARAMS", "application/json required");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new RpcError("INVALID_PARAMS", "invalid JSON request");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new RpcError("INVALID_PARAMS", "request body must be an object");
  return body as Record<string, unknown>;
}

/** One bounded page per pull: slow clients exert backpressure instead of accumulating events. */
function eventStream(
  first: Record<string, unknown>,
  invoke: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  signal: AbortSignal,
  release: () => void,
  headers: Record<string, string>,
): Response {
  let pending: Record<string, unknown> | null = first;
  let cursor: unknown = first.cursor;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          signal.throwIfAborted();
          const page = eventsResultSchema.parse(
            pending ?? (await invoke("events.subscribe", { ...(cursor ? { cursor } : {}) })),
          );
          pending = null;
          cursor = page.cursor;
          const events = page.events;
          if (events.length) {
            controller.enqueue(
              encoder.encode(
                events
                  .map(
                    (event) =>
                      `id: ${event.id}\nevent: notient\ndata: ${JSON.stringify(event)}\n\n`,
                  )
                  .join(""),
              ),
            );
          } else {
            await abortableDelay(1000, signal);
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }
        } catch (error) {
          controller.error(error);
          release();
        }
      },
      cancel() {
        release();
      },
    },
    { highWaterMark: 1 },
  );
  signal.addEventListener("abort", release, { once: true });
  return new Response(stream, {
    headers: { ...headers, "content-type": "text/event-stream", "x-accel-buffering": "no" },
  });
}
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
