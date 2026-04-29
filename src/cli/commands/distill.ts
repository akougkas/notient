import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export type DistillFormat = "auto" | "markdown" | "jsonl" | "json";

export interface DistillCommandOptions {
  vaultPath: string;
  transcriptPath: string;
  format: DistillFormat;
  dryRun: boolean;
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

export async function runDistillCommand(options: DistillCommandOptions): Promise<number> {
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
    return await drainDistillCall({
      frames: client.call("agent.distill", params),
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

function buildRequestParams(options: DistillCommandOptions): Record<string, unknown> {
  if (options.transcriptPath.trim().length === 0) {
    throw new Error("INVALID_PARAMS: distill requires --from <path>");
  }
  const params: Record<string, unknown> = { transcriptPath: options.transcriptPath };
  if (options.format !== "auto") params.format = options.format;
  if (options.dryRun) params.dryRun = true;
  return params;
}

interface DrainDistillCallOptions {
  frames: AsyncIterable<Record<string, unknown>>;
  emitter: Emitter;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}

async function drainDistillCall(options: DrainDistillCallOptions): Promise<number> {
  for await (const frame of options.frames) {
    if (frame.type === "result") {
      renderResult(frame, options.writeStdout);
      return 0;
    }
    if (frame.type === "error") {
      const message = typeof frame.message === "string" ? frame.message : "agent.distill failed";
      const code = typeof frame.code === "string" ? frame.code : "INTERNAL";
      options.writeStderr(JSON.stringify({ type: "error", code, message }));
      options.emitter.emit({ type: "error", code, message });
      return 1;
    }
  }
  options.writeStderr("agent.distill returned no result frame");
  return 1;
}

function renderResult(frame: Record<string, unknown>, writeStdout: (line: string) => void): void {
  const payload: Record<string, unknown> = {
    candidates: frame.candidates,
    proposalsCreated: frame.proposalsCreated,
    byKind: frame.byKind,
    durationMs: frame.durationMs,
  };
  writeStdout(JSON.stringify(payload, null, 2));
}

export function parseDistillFormat(value: unknown): DistillFormat {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "markdown" || value === "jsonl" || value === "json") {
    return value;
  }
  throw new Error(
    `INVALID_PARAMS: --format must be one of auto | markdown | jsonl | json (got ${String(value)})`,
  );
}
