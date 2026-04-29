import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface BriefCommandOptions {
  vaultPath: string;
  topic?: string;
  filePath?: string;
  maxNotes?: number;
  maxQuestions?: number;
  maxDecisions?: number;
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

export async function runBriefCommand(options: BriefCommandOptions): Promise<number> {
  const writeStdout = options.writeStdout ?? defaultStdoutWriter;
  const writeStderr = options.writeStderr ?? defaultStderrWriter;
  const params = buildRequestParams(options);

  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });

  try {
    return await drainBriefCall({
      frames: client.call("agent.brief", params),
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

function buildRequestParams(options: BriefCommandOptions): Record<string, unknown> {
  const hasTopic = typeof options.topic === "string" && options.topic.length > 0;
  const hasFilePath = typeof options.filePath === "string" && options.filePath.length > 0;
  if (hasTopic && hasFilePath) {
    throw new Error("INVALID_PARAMS: brief accepts a topic OR --file, not both");
  }
  if (!hasTopic && !hasFilePath) {
    throw new Error('INVALID_PARAMS: brief requires a topic or --file (e.g. notient brief "auth")');
  }
  const params: Record<string, unknown> = {};
  if (hasTopic) params.topic = options.topic;
  if (hasFilePath) params.filePath = options.filePath;
  if (options.maxNotes !== undefined) params.maxNotes = options.maxNotes;
  if (options.maxQuestions !== undefined) params.maxQuestions = options.maxQuestions;
  if (options.maxDecisions !== undefined) params.maxDecisions = options.maxDecisions;
  return params;
}

interface DrainBriefCallOptions {
  frames: AsyncIterable<Record<string, unknown>>;
  emitter: Emitter;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}

async function drainBriefCall(options: DrainBriefCallOptions): Promise<number> {
  for await (const frame of options.frames) {
    if (frame.type === "result") {
      renderResult(frame, options.writeStdout);
      return 0;
    }
    if (frame.type === "error") {
      const message = typeof frame.message === "string" ? frame.message : "agent.brief failed";
      const code = typeof frame.code === "string" ? frame.code : "INTERNAL";
      options.writeStderr(JSON.stringify({ type: "error", code, message }));
      options.emitter.emit({ type: "error", code, message });
      return 1;
    }
  }
  options.writeStderr("agent.brief returned no result frame");
  return 1;
}

function renderResult(frame: Record<string, unknown>, writeStdout: (line: string) => void): void {
  const payload: Record<string, unknown> = {
    topic: frame.topic,
    summary: frame.summary,
    relevantNotes: frame.relevantNotes,
    recentDecisions: frame.recentDecisions,
    openQuestions: frame.openQuestions,
    openContradictions: frame.openContradictions,
    durationMs: frame.durationMs,
  };
  writeStdout(JSON.stringify(payload, null, 2));
}

export function parseBriefMaxField(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`INVALID_PARAMS: --${label} must be a positive integer`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`INVALID_PARAMS: --${label} must be a positive integer`);
  }
  return Math.floor(parsed);
}
