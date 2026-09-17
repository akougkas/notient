import { type AskResult, askResultSchema } from "../../api/ask";
import { type OperationInput, scopeSchema } from "../../api/operations";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { type ClientHandle, type RpcResponseFrame, connectClient } from "../client";
import type { Emitter } from "../output";

export type AskFormat = "structured" | "text";

export interface AskCommandOptions {
  vaultPath: string;
  intent: string;
  format: AskFormat;
  maxRoundsPerTurn?: number;
  scope?: OperationInput<"ask.run">["scope"];
  emitter: Emitter;
  clientIdentity?: string;
  /**
   * Test seam. Defaults to writing to process.stdout/stderr with a trailing
   * newline. The runtime never threads this from the dispatcher; only tests
   * override it to capture output without spawning real sockets.
   */
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
  /** Direct-test seam; production always uses the canonical socket client. */
  connect?: typeof connectClient;
}

export async function runAskCommand(options: AskCommandOptions): Promise<number> {
  const request = parseAskRequest(options);
  const scope = scopeSchema.parse(options.scope ?? {});
  const writeStdout =
    options.writeStdout ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const writeStderr =
    options.writeStderr ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });

  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await (options.connect ?? connectClient)({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });

  const params: Record<string, unknown> = { query: request.intent, scope };
  if (request.maxRoundsPerTurn !== undefined) {
    params.maxRoundsPerTurn = request.maxRoundsPerTurn;
  }

  let terminal: AskTerminal | null;
  try {
    terminal = await readAskTerminal(client, params);
  } catch (error) {
    await closeAfterFailure(client, error);
    throw error;
  }
  try {
    await client.close();
  } catch {
    emitAskError("INTERNAL", "ask.run connection close failed", {}, options, writeStderr);
    return 1;
  }
  if (terminal === null) {
    emitAskError("INTERNAL", "ask.run returned no terminal frame", {}, options, writeStderr);
    return 1;
  }
  if (terminal.kind === "error") {
    emitAskError(terminal.code, terminal.message, terminal.detail, options, writeStderr);
    return 1;
  }
  renderResult(terminal.result, request.format, writeStdout);
  return 0;
}

async function closeAfterFailure(client: ClientHandle, original: unknown): Promise<void> {
  try {
    await client.close();
  } catch (closeError) {
    throw new AggregateError([original, closeError], "ask.run response and close both failed");
  }
}

function emitAskError(
  code: string,
  message: string,
  detail: Record<string, unknown>,
  options: AskCommandOptions,
  writeStderr: (line: string) => void,
): void {
  const event = { type: "error", code, message, detail };
  writeStderr(JSON.stringify(event));
  options.emitter.emit(event);
}

function renderResult(
  result: AgentAskResult,
  format: AskFormat,
  writeStdout: (line: string) => void,
): void {
  if (format === "text") {
    writeStdout(result.answer);
    return;
  }
  writeStdout(JSON.stringify(result, null, 2));
}

interface AskRequest {
  intent: string;
  format: AskFormat;
  maxRoundsPerTurn?: number;
}

function parseAskRequest(options: AskCommandOptions): AskRequest {
  if (!isCanonicalNonblank(options.intent)) {
    throw new Error("INVALID_PARAMS: ask intent must be a canonical nonblank string");
  }
  if (options.format !== "structured" && options.format !== "text") {
    throw new Error("INVALID_PARAMS: ask format must be structured or text");
  }
  if (options.maxRoundsPerTurn === undefined) {
    return { intent: options.intent, format: options.format };
  }
  return {
    intent: options.intent,
    format: options.format,
    maxRoundsPerTurn: parseAskMaxRounds(options.maxRoundsPerTurn),
  };
}

type AskTerminal =
  | { kind: "result"; result: AgentAskResult }
  | { kind: "error"; code: string; message: string; detail: Record<string, unknown> };

async function readAskTerminal(
  client: ClientHandle,
  params: Record<string, unknown>,
): Promise<AskTerminal | null> {
  let acknowledgementId: string | undefined;
  let terminal: AskTerminal | null = null;
  for await (const frame of client.call("ask.run", params)) {
    if (frame.type === "ack") {
      acknowledgementId = acceptAskAcknowledgement(frame, acknowledgementId);
      continue;
    }
    terminal = acceptAskTerminal(frame, acknowledgementId, terminal);
  }
  if (acknowledgementId === undefined) throw askWireError("missing acknowledgement");
  return terminal;
}

function acceptAskAcknowledgement(
  frame: RpcResponseFrame,
  acknowledgementId: string | undefined,
): string {
  if (acknowledgementId !== undefined) throw askWireError("duplicate acknowledgement");
  return parseAskAcknowledgement(frame);
}

function acceptAskTerminal(
  frame: RpcResponseFrame,
  acknowledgementId: string | undefined,
  terminal: AskTerminal | null,
): AskTerminal {
  if (acknowledgementId === undefined) {
    throw askWireError("terminal response arrived before acknowledgement");
  }
  if (frame.id !== acknowledgementId) {
    throw askWireError("terminal request id does not match ACK");
  }
  if (terminal !== null) throw askWireError("duplicate terminal response");
  if (frame.type === "result") return { kind: "result", result: decodeAskResult(frame) };
  if (frame.type === "error") return decodeAskError(frame);
  throw askWireError("ask.run emitted an unexpected event frame");
}

function parseAskAcknowledgement(frame: RpcResponseFrame): string {
  if (
    !hasExactKeys(frame, ["id", "type", "method"]) ||
    frame.type !== "ack" ||
    frame.method !== "ask.run" ||
    !isCanonicalRequestId(frame.id)
  ) {
    throw askWireError("malformed acknowledgement");
  }
  return frame.id;
}

const RPC_ERROR_CODES = new Set([
  "DAEMON_SHUTTING_DOWN",
  "FORBIDDEN",
  "HISTORY_CONFLICT",
  "HISTORY_EMPTY",
  "HISTORY_INVALID_PAYLOAD",
  "HISTORY_NOT_FOUND",
  "HISTORY_NOT_REVERSIBLE",
  "INTERNAL",
  "INVALID_LLM_OUTPUT",
  "INVALID_PARAMS",
  "METHOD_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "UNAUTHENTICATED",
  "VISION_UNAVAILABLE",
  "CONFLICT",
  "CANCELLED",
  "INFERENCE_UNAVAILABLE",
  "LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
  "NOT_FOUND",
]);

function decodeAskError(frame: RpcResponseFrame): AskTerminal {
  if (
    !hasExactKeys(frame, ["id", "type", "code", "message", "detail"]) ||
    frame.type !== "error" ||
    typeof frame.code !== "string" ||
    !RPC_ERROR_CODES.has(frame.code) ||
    !isCanonicalNonblank(frame.message) ||
    !isRecord(frame.detail)
  ) {
    throw askWireError("malformed error terminal");
  }
  return { kind: "error", code: frame.code, message: frame.message, detail: frame.detail };
}

export function parseAskFormat(value: unknown): AskFormat {
  if (value === "text") return "text";
  if (value === "structured" || value === undefined) {
    return "structured";
  }
  throw new Error("INVALID_PARAMS: --format must be 'structured' or 'text'");
}

export function parseAskMaxRounds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 2 || parsed > 8) {
    throw new Error("INVALID_PARAMS: --max-rounds must be an integer from 2 through 8");
  }
  return parsed;
}

type AgentAskResult = Omit<AskResult, "ok">;
function decodeAskResult(frame: Record<string, unknown>): AgentAskResult {
  if (frame.type !== "result" || !isCanonicalRequestId(frame.id))
    throw malformedAskResult("invalid terminal envelope");
  const { id: _id, type: _type, ...body } = frame;
  const parsed = askResultSchema.safeParse(body);
  if (!parsed.success)
    throw malformedAskResult(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  const { ok: _ok, ...result } = parsed.data;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isCanonicalNonblank(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCanonicalRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function malformedAskResult(reason: string): Error {
  return new Error(`ask.run returned a malformed result: ${reason}`);
}

function askWireError(reason: string): Error {
  return new Error(`ask.run wire integrity: ${reason}`);
}

export function parseAskScope(folder: unknown, note: unknown): OperationInput<"ask.run">["scope"] {
  if (folder !== undefined && typeof folder !== "string")
    throw new Error("INVALID_PARAMS: --folder requires a vault-relative folder");
  if (note !== undefined && typeof note !== "string")
    throw new Error("INVALID_PARAMS: --note requires a vault-relative Markdown path");
  return scopeSchema.parse({
    ...(folder === undefined ? {} : { folders: [folder] }),
    ...(note === undefined ? {} : { paths: [note] }),
  });
}
