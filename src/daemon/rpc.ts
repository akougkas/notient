export interface RpcEnvelope {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export type ParseResult = { ok: true; envelope: RpcEnvelope } | { ok: false; reason: string };

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
  if (typeof candidate.id !== "string") return { ok: false, reason: "id must be string" };
  if (typeof candidate.method !== "string") return { ok: false, reason: "method must be string" };
  const params =
    candidate.params && typeof candidate.params === "object" && !Array.isArray(candidate.params)
      ? (candidate.params as Record<string, unknown>)
      : {};
  return { ok: true, envelope: { id: candidate.id, method: candidate.method, params } };
}

export function encodeAck(id: string, method: string): string {
  return JSON.stringify({ id, type: "ack", method });
}

export function encodeEvent(id: string, event: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ id, type: "event", event, ...payload });
}

export function encodeResult(id: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ id, type: "result", ...payload });
}

export function encodeError(
  id: string,
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): string {
  return JSON.stringify({
    id,
    type: "error",
    code,
    message,
    detail: detail ?? {},
  });
}

export type MethodHandler = (
  params: Record<string, unknown>,
  emit: (line: string) => void,
  envelopeId: string,
) => Promise<Record<string, unknown>>;

export class MethodDispatcher {
  private readonly handlers = new Map<string, MethodHandler>();

  register(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  async dispatch(envelope: RpcEnvelope, emit: (line: string) => void): Promise<void> {
    emit(encodeAck(envelope.id, envelope.method));
    const handler = this.handlers.get(envelope.method);
    if (!handler) {
      emit(
        encodeError(envelope.id, "INVALID_PARAMS", "method not implemented in Phase A", {
          method: envelope.method,
        }),
      );
      return;
    }
    try {
      const payload = await handler(envelope.params, emit, envelope.id);
      emit(encodeResult(envelope.id, payload));
    } catch (error) {
      emit(
        encodeError(
          envelope.id,
          "INTERNAL",
          error instanceof Error ? error.message : String(error),
          {},
        ),
      );
    }
  }
}
