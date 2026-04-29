import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export type SessionSubcommand = "grant" | "list" | "revoke";

export interface SessionCommandOptions {
  vaultPath: string;
  subcommand: SessionSubcommand;
  client?: string;
  folders?: string[];
  tools?: string[];
  maxWrites?: number;
  ttlMinutes?: number;
  sessionId?: number;
  includeExpired?: boolean;
  emitter: Emitter;
  clientIdentity?: string;
  /**
   * Test seam. Defaults to writing to process.stdout/stderr with a trailing
   * newline. The runtime never threads this from the dispatcher; only tests
   * override it to capture output without spawning real sockets.
   */
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

export async function runSessionCommand(options: SessionCommandOptions): Promise<number> {
  const writeStdout = options.writeStdout ?? defaultStdoutWriter;
  const writeStderr = options.writeStderr ?? defaultStderrWriter;
  const { method, params } = buildRequest(options);

  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });

  try {
    return await drainSessionCall({
      frames: client.call(method, params),
      method,
      emitter: options.emitter,
      writeStdout,
      writeStderr,
    });
  } finally {
    await client.close();
  }
}

function defaultStdoutWriter(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderrWriter(line: string): void {
  process.stderr.write(`${line}\n`);
}

interface BuiltRequest {
  method: string;
  params: Record<string, unknown>;
}

function buildRequest(options: SessionCommandOptions): BuiltRequest {
  switch (options.subcommand) {
    case "grant":
      return { method: "session.grant", params: buildGrantParams(options) };
    case "revoke":
      return { method: "session.revoke", params: buildRevokeParams(options) };
    case "list":
      return { method: "session.list", params: buildListParams(options) };
  }
}

function buildGrantParams(options: SessionCommandOptions): Record<string, unknown> {
  if (typeof options.client !== "string" || options.client.length === 0) {
    throw new Error("INVALID_PARAMS: session grant requires --client <agent-id>");
  }
  if (!options.folders || options.folders.length === 0) {
    throw new Error("INVALID_PARAMS: session grant requires --folders <folder>[,<folder>...]");
  }
  if (typeof options.ttlMinutes !== "number" || options.ttlMinutes <= 0) {
    throw new Error("INVALID_PARAMS: session grant requires --ttl <positive minutes>");
  }
  const params: Record<string, unknown> = {
    client: options.client,
    allowedFolders: options.folders,
    ttlMinutes: options.ttlMinutes,
  };
  if (options.tools !== undefined && options.tools.length > 0) {
    params.allowedTools = options.tools;
  }
  if (options.maxWrites !== undefined) {
    params.maxWrites = options.maxWrites;
  }
  return params;
}

function buildRevokeParams(options: SessionCommandOptions): Record<string, unknown> {
  if (typeof options.sessionId !== "number" || options.sessionId <= 0) {
    throw new Error("INVALID_PARAMS: session revoke requires a positive integer sessionId");
  }
  return { sessionId: options.sessionId };
}

function buildListParams(options: SessionCommandOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (options.client !== undefined) params.client = options.client;
  if (options.includeExpired === true) {
    params.activeOnly = false;
  }
  return params;
}

interface DrainSessionCallOptions {
  frames: AsyncIterable<Record<string, unknown>>;
  method: string;
  emitter: Emitter;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}

async function drainSessionCall(options: DrainSessionCallOptions): Promise<number> {
  for await (const frame of options.frames) {
    if (frame.type === "result") {
      renderResult(frame, options.writeStdout);
      return 0;
    }
    if (frame.type === "error") {
      const message =
        typeof frame.message === "string" ? frame.message : `${options.method} failed`;
      const code = typeof frame.code === "string" ? frame.code : "INTERNAL";
      options.writeStderr(JSON.stringify({ type: "error", code, message }));
      options.emitter.emit({ type: "error", code, message });
      return 1;
    }
  }
  options.writeStderr(`${options.method} returned no result frame`);
  return 1;
}

function renderResult(frame: Record<string, unknown>, writeStdout: (line: string) => void): void {
  const { id: _id, type: _type, ...rest } = frame;
  writeStdout(JSON.stringify(rest, null, 2));
}

export function parseSessionFolders(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("INVALID_PARAMS: --folders requires a comma-separated list of folders");
  }
  const parts = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (parts.length === 0) {
    throw new Error("INVALID_PARAMS: --folders requires at least one folder");
  }
  return parts;
}

export function parseSessionTools(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== "string") {
    throw new Error("INVALID_PARAMS: --tools must be a comma-separated list of tool names");
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseSessionPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`INVALID_PARAMS: --${label} must be a positive integer`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`INVALID_PARAMS: --${label} must be a positive integer`);
  }
  return Math.floor(parsed);
}

export function parseSessionOptionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return parseSessionPositiveInt(value, label);
}

export function parseSessionId(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("INVALID_PARAMS: session revoke requires a positive integer sessionId");
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("INVALID_PARAMS: session revoke requires a positive integer sessionId");
  }
  return parsed;
}
