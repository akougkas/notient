import { z } from "zod";
import {
  chatAbortResultSchema,
  chatApproveResultSchema,
  chatListResultSchema,
  chatLoadResultSchema,
  chatSendRequestSchema,
  chatStartRequestSchema,
  chatStreamEventSchema,
  chatStreamFailureSchema,
  type ChatStreamEvent,
} from "./chat";
import { briefResultFor } from "./brief";
import { type OperationInput, operationInputs } from "./operations";
import {
  type ImplementedOperation,
  type OperationResult,
  capabilitiesSchema,
  eventSchema,
  operationOutputs,
} from "./results";

export class NotientApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly correlationId: string | null = null,
    readonly outcomeMayBeUnknown = false,
  ) {
    super(message);
  }
}
export interface NotientClientOptions {
  endpoint: string;
  token: string;
  vaultId: string;
  fetch?: typeof fetch;
}
export const pairingResultSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  credentialId: z.string().uuid(),
  principal: z.object({
    id: z.string(),
    kind: z.enum(["human", "agent"]),
    scopes: z.array(z.string()),
  }),
  vaultId: z.string().regex(/^[a-f0-9]{16}$/),
});

/** Fetch-only desktop/external client. Credentials never enter a URL and
 * mutations are never automatically replayed after an ambiguous disconnect. */
export class NotientClient {
  readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private connected = false;
  constructor(private readonly options: NotientClientOptions) {
    this.endpoint = validateEndpoint(options.endpoint);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  async connect(signal?: AbortSignal) {
    const capabilities = capabilitiesSchema.parse(
      await this.request("capabilities.get", {}, signal),
    );
    if (capabilities.vaultId !== this.options.vaultId)
      throw new NotientApiError(
        "VAULT_MISMATCH",
        "paired vault identity does not match this workspace",
      );
    this.connected = true;
    return capabilities;
  }
  async call<Name extends ImplementedOperation>(
    name: Name,
    input: OperationInput<Name>,
    signal?: AbortSignal,
  ): Promise<OperationResult<Name>> {
    if (name === "chat.send") {
      throw new NotientApiError("STREAM_REQUIRED", "use chatSend() to receive this streamed operation");
    }
    const parsed = operationInputs[name].parse(input);
    if (!this.connected) await this.connect(signal);
    const schema =
      name === "brief.run"
        ? briefResultFor(operationInputs["brief.run"].parse(parsed))
        : operationOutputs[name];
    return schema.parse(await this.request(name, parsed, signal)) as OperationResult<Name>;
  }
  async chatStart(input: { topic?: string; pinnedContext?: string[] } = {}, signal?: AbortSignal) {
    const parsed = chatStartRequestSchema.parse(input);
    return this.call("chat.start", parsed, signal);
  }
  async chatList(signal?: AbortSignal) {
    return this.call("chat.list", {}, signal);
  }
  async chatLoad(notePath: string, signal?: AbortSignal) {
    return this.call("chat.load", { notePath }, signal);
  }
  async chatApprove(
    input: { callId: string; approved: true } | { callId: string; approved: false; reason?: string },
    signal?: AbortSignal,
  ) {
    return this.call("chat.approve", input, signal);
  }
  async chatAbort(input: { turnId: string }, signal?: AbortSignal) {
    return chatAbortResultSchema.parse(
      await this.call("chat.abort", input, signal),
    );
  }
  async *chatSend(
    input: { conversationId: string; userMessage: string; turnId: string },
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<ChatStreamEvent> {
    const parsed = chatSendRequestSchema.parse(input);
    const signal = options.signal;
    if (signal?.aborted) signal.throwIfAborted();
    if (!this.connected) await this.connect(signal);
    let abortPromise: Promise<unknown> | undefined;
    const abortTurn = () => {
      abortPromise ??= this.chatAbort({ turnId: parsed.turnId }).catch(() => undefined);
      return abortPromise;
    };
    const onAbort = () => void abortTurn();
    signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    try {
      response = await this.fetcher(`${this.endpoint}/api/v1/chat/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parsed),
        signal,
        redirect: "error",
      });
    } catch {
      if (signal?.aborted) {
        await abortTurn();
        signal.removeEventListener("abort", onAbort);
        signal.throwIfAborted();
      }
      signal?.removeEventListener("abort", onAbort);
      throw new NotientApiError(
        "REQUEST_INTERRUPTED",
        "chat stream disconnected; reload the saved conversation before deciding whether to send again",
        null,
        true,
      );
    }
    try {
      if (!response.ok) await decodeResponse(response);
      if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body)
        throw new NotientApiError("PROTOCOL_ERROR", "chat event stream is unavailable", null, true);
      const correlationId = response.headers.get("x-correlation-id");
      let terminal = false;
      for await (const event of decodeChatStream(response, signal, correlationId)) {
        if (event.event === "turn:complete" || event.event === "turn:aborted") terminal = true;
        yield event;
      }
      if (signal?.aborted) {
        await abortTurn();
        signal.throwIfAborted();
      }
      if (!terminal)
        throw new NotientApiError(
          "STREAM_INTERRUPTED",
          "chat stream ended before a terminal turn event; reload the saved conversation before deciding whether to send again",
          correlationId,
          true,
        );
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) await abortTurn();
    }
  }
  private async request(
    name: ImplementedOperation,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.endpoint}/api/v1/${name.replaceAll(".", "/")}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal,
        redirect: "error",
      });
    } catch {
      throw new NotientApiError(
        "REQUEST_INTERRUPTED",
        "request interrupted; inspect its idempotency key before retrying an effect",
        null,
        [
          "changes.apply",
          "contributions.submit",
          "contributions.stage",
          "contributions.dismiss",
          "feedback.submit",
          "relationships.retain",
          "methodology.suggest",
          "jobs.control",
          "pipelines.run",
          "proposals.approve",
          "proposals.reject",
          "proposals.submit",
          "pipelines.configure",
          "cultivation.configure",
          "background.pause",
          "chat.configure",
        ].includes(name),
      );
    }
    return decodeResponse(response);
  }
  /** Reconnects reads only. Persist each yielded id after processing it. */
  async *events(options: { cursor?: string; signal: AbortSignal }): AsyncGenerator<
    z.infer<typeof eventSchema>
  > {
    if (!this.connected) await this.connect(options.signal);
    let cursor = options.cursor;
    let failures = 0;
    while (!options.signal.aborted) {
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${this.options.token}` };
        if (cursor) headers["Last-Event-ID"] = cursor;
        const response = await this.fetcher(`${this.endpoint}/api/v1/events`, {
          headers,
          signal: options.signal,
          redirect: "error",
        });
        if (!response.ok) await decodeResponse(response);
        for await (const event of decodeEvents(response, options.signal)) {
          cursor = event.id;
          failures = 0;
          yield event;
        }
      } catch (error) {
        if (options.signal.aborted) return;
        if (error instanceof NotientApiError || ++failures > 8) throw error;
      }
      await delay(Math.min(10000, 250 * 2 ** failures), options.signal);
    }
  }
  static async pair(endpoint: string, code: string, vaultId: string, signal?: AbortSignal) {
    const response = await fetch(`${validateEndpoint(endpoint)}/api/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, vaultId }),
      signal,
      redirect: "error",
    });
    const result = pairingResultSchema.parse(await decodeResponse(response));
    if (result.vaultId !== vaultId)
      throw new NotientApiError("VAULT_MISMATCH", "pairing returned a different vault identity");
    return result;
  }
}
function validateEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Notient requires an explicit loopback HTTP endpoint");
  return url.origin;
}
async function decodeResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 32 * 1024 * 1024)
    throw new NotientApiError("PROTOCOL_ERROR", "response exceeds client limit");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new NotientApiError("PROTOCOL_ERROR", "daemon returned invalid JSON");
  }
  if (!response.ok) {
    const error = z
      .object({
        error: z.object({ code: z.string(), message: z.string() }),
        correlationId: z.string().optional(),
      })
      .parse(body);
    throw new NotientApiError(error.error.code, error.error.message, error.correlationId ?? null);
  }
  // HTTP routing metadata belongs to the transport, never a domain payload.
  const { correlationId: _correlationId, ...result } = z
    .object({ correlationId: z.string().max(256).optional() })
    .passthrough()
    .parse(body);
  return result;
}
async function* decodeEvents(response: Response, signal: AbortSignal) {
  if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body)
    throw new NotientApiError("PROTOCOL_ERROR", "event stream is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 4 * 1024 * 1024)
        throw new NotientApiError("PROTOCOL_ERROR", "event frame exceeds client limit");
      while (true) {
        const end = pending.indexOf("\n\n");
        if (end === -1) break;
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const lines = frame.split("\n");
        const data = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (!data) continue;
        const event = eventSchema.parse(JSON.parse(data));
        if (lines.find((line) => line.startsWith("id: "))?.slice(4) !== event.id)
          throw new NotientApiError("PROTOCOL_ERROR", "event id does not match payload");
        yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function* decodeChatStream(
  response: Response,
  signal: AbortSignal | undefined,
  correlationId: string | null,
): AsyncGenerator<ChatStreamEvent> {
  const body = response.body;
  if (body === null)
    throw new NotientApiError("PROTOCOL_ERROR", "chat event body is missing", correlationId, true);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 4 * 1024 * 1024)
        throw new NotientApiError(
          "PROTOCOL_ERROR",
          "chat event frame exceeds client limit",
          correlationId,
          true,
        );
      while (true) {
        const end = pending.indexOf("\n\n");
        if (end === -1) break;
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const lines = frame.split("\n");
        const data = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (!data) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(data);
        } catch {
          throw new NotientApiError(
            "PROTOCOL_ERROR",
            "daemon returned invalid chat event JSON",
            correlationId,
            true,
          );
        }
        const failure = chatStreamFailureSchema.safeParse(raw);
        if (failure.success) {
          const frameId = lines.find((line) => line.startsWith("id: "))?.slice(4);
          const frameType = lines.find((line) => line.startsWith("event: "))?.slice(7);
          if (frameId === undefined || frameType !== failure.data.event)
            throw new NotientApiError(
              "PROTOCOL_ERROR",
              "chat error routing does not match its payload",
              correlationId,
              true,
            );
          throw new NotientApiError(
            failure.data.code,
            failure.data.message,
            failure.data.correlationId ?? correlationId,
            failure.data.outcomeMayBeUnknown ?? true,
          );
        }
        let event: ChatStreamEvent;
        try {
          event = chatStreamEventSchema.parse(raw);
        } catch {
          throw new NotientApiError(
            "PROTOCOL_ERROR",
            "daemon returned an invalid chat event",
            correlationId,
            true,
          );
        }
        const frameId = lines.find((line) => line.startsWith("id: "))?.slice(4);
        const frameType = lines.find((line) => line.startsWith("event: "))?.slice(7);
        if (frameId === undefined || frameType !== event.event)
          throw new NotientApiError(
            "PROTOCOL_ERROR",
            "chat event routing does not match its payload",
            correlationId,
            true,
          );
        yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const end = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", end);
      resolve();
    };
    const timer = setTimeout(end, ms);
    signal.addEventListener("abort", end, { once: true });
    if (signal.aborted) end();
  });
}
