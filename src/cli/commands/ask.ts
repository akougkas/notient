import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export type AskFormat = "structured" | "text";

export interface AskCommandOptions {
  vaultPath: string;
  intent: string;
  format: AskFormat;
  maxRoundsPerTurn?: number;
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

export async function runAskCommand(options: AskCommandOptions): Promise<number> {
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
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });

  const params: Record<string, unknown> = { intent: options.intent };
  if (options.maxRoundsPerTurn !== undefined) {
    params.maxRoundsPerTurn = options.maxRoundsPerTurn;
  }

  try {
    for await (const frame of client.call("agent.ask", params)) {
      if (frame.type === "result") {
        renderResult(frame, options.format, writeStdout);
        return 0;
      }
      if (frame.type === "error") {
        const message = typeof frame.message === "string" ? frame.message : "agent.ask failed";
        const code = typeof frame.code === "string" ? frame.code : "INTERNAL";
        writeStderr(JSON.stringify({ type: "error", code, message }));
        options.emitter.emit({ type: "error", code, message });
        return 1;
      }
    }
    writeStderr("agent.ask returned no result frame");
    return 1;
  } finally {
    await client.close();
  }
}

function renderResult(
  frame: Record<string, unknown>,
  format: AskFormat,
  writeStdout: (line: string) => void,
): void {
  if (format === "text") {
    const answer = typeof frame.answer === "string" ? frame.answer : "";
    writeStdout(answer);
    return;
  }
  const payload: Record<string, unknown> = {
    answer: frame.answer,
    citations: frame.citations,
    openQuestions: frame.openQuestions,
    confidence: frame.confidence,
    toolCalls: frame.toolCalls,
    durationMs: frame.durationMs,
  };
  writeStdout(JSON.stringify(payload, null, 2));
}

export function parseAskFormat(value: unknown): AskFormat {
  if (value === "text") return "text";
  if (value === "structured" || value === "json" || value === undefined || value === true) {
    return "structured";
  }
  throw new Error(`INVALID_PARAMS: --format must be 'structured' or 'text' (got ${String(value)})`);
}

export function parseAskMaxRounds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("INVALID_PARAMS: --max-rounds must be a positive integer");
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("INVALID_PARAMS: --max-rounds must be a positive integer");
  }
  return Math.floor(parsed);
}
