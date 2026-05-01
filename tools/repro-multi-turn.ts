/**
 * Multi-turn chat reproduction for the substrate.
 *
 * Connects to the daemon (spawning one if needed) against the live LM Studio
 * substrate, calls chat.start once, then drives chat.send twice on the same
 * conversationId. Streams every wire frame to stdout so the failing turn's
 * loop:error or turn:aborted is captured verbatim.
 *
 *   bun run tools/repro-multi-turn.ts /mnt/c/Users/akougk/Projects/vaultex
 *
 * Set NOTIENT_DEBUG_LLM=1 to also dump the upstream request body of any 4xx
 * or 5xx LM Studio response to /tmp/notient-llm-request-<ts>.json.
 */

import { connectClient } from "../src/cli/client";
import { currentPlatform, resolveSocketPath } from "../src/daemon/socket";

const TURN_PROMPTS = [
  "what notes do i have for agentic coding?",
  "tell me more about the first one",
];

async function main(): Promise<void> {
  const vaultPath = process.argv[2];
  if (!vaultPath) {
    process.stderr.write("usage: bun tools/repro-multi-turn.ts <vault>\n");
    process.exit(2);
  }
  const socketPath = resolveSocketPath(vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath, spawnTimeoutMs: 60_000 });
  try {
    const conversationId = await runStart(client);
    emit({ phase: "start", conversationId });
    for (let turn = 0; turn < TURN_PROMPTS.length; turn++) {
      const prompt = TURN_PROMPTS[turn];
      emit({ phase: "turn:begin", turn, prompt });
      const outcome = await runTurn(client, conversationId, prompt, turn);
      emit({ phase: "turn:end", turn, ...outcome });
      if (outcome.failed) {
        emit({ phase: "abort", reason: "turn failed; stopping" });
        process.exitCode = 1;
        return;
      }
    }
    emit({ phase: "complete" });
  } finally {
    await client.close();
  }
}

interface ClientLike {
  call: (
    method: string,
    params: Record<string, unknown>,
  ) => AsyncIterable<{ id: string; type: string; [key: string]: unknown }>;
  close: () => Promise<void>;
}

async function runStart(client: ClientLike): Promise<string> {
  for await (const frame of client.call("chat.start", { topic: "repro multi-turn" })) {
    if (frame.type === "result") {
      const detail = frame as unknown as { conversation?: { id?: string } };
      if (typeof detail.conversation?.id === "string") return detail.conversation.id;
      throw new Error("chat.start: missing conversation.id in result");
    }
    if (frame.type === "error") {
      throw new Error(`chat.start: ${(frame as { message?: string }).message ?? "unknown"}`);
    }
  }
  throw new Error("chat.start: stream ended without result");
}

interface TurnOutcome {
  failed: boolean;
  events: number;
  toolCalls: number;
  assistantChars: number;
  reachedTurnComplete: boolean;
  loopError?: string;
  turnAborted?: string;
  rpcError?: string;
}

async function runTurn(
  client: ClientLike,
  conversationId: string,
  userMessage: string,
  turn: number,
): Promise<TurnOutcome> {
  const outcome: TurnOutcome = {
    failed: false,
    events: 0,
    toolCalls: 0,
    assistantChars: 0,
    reachedTurnComplete: false,
  };
  for await (const frame of client.call("chat.send", { conversationId, userMessage })) {
    outcome.events++;
    if (frame.type === "event") {
      const detail = frame as unknown as { event: string; [key: string]: unknown };
      emit({ phase: "frame", turn, event: detail.event, payload: redact(detail) });
      if (detail.event === "loop:tool_call_started") outcome.toolCalls++;
      if (detail.event === "loop:assistant_delta") {
        const delta = detail.contentDelta;
        if (typeof delta === "string") outcome.assistantChars += delta.length;
      }
      if (detail.event === "loop:error") {
        outcome.loopError =
          typeof detail.message === "string" ? detail.message : "unknown loop:error";
      }
      if (detail.event === "turn:aborted") {
        outcome.turnAborted =
          typeof detail.reason === "string" ? detail.reason : "unknown turn:aborted";
      }
      if (detail.event === "turn:complete") {
        outcome.reachedTurnComplete = true;
      }
      continue;
    }
    if (frame.type === "result") {
      emit({ phase: "result", turn, ok: (frame as { ok?: unknown }).ok === true });
      break;
    }
    if (frame.type === "error") {
      const message = (frame as { message?: unknown }).message;
      outcome.rpcError = typeof message === "string" ? message : "unknown rpc error";
      emit({ phase: "rpc:error", turn, message: outcome.rpcError });
      break;
    }
  }
  outcome.failed =
    !outcome.reachedTurnComplete ||
    outcome.loopError !== undefined ||
    outcome.turnAborted !== undefined ||
    outcome.rpcError !== undefined;
  return outcome;
}

function redact(detail: { event: string; [key: string]: unknown }): Record<string, unknown> {
  const summary: Record<string, unknown> = { event: detail.event };
  if (detail.event === "loop:assistant_delta") {
    const delta = detail.contentDelta;
    if (typeof delta === "string") summary.contentDeltaLength = delta.length;
    return summary;
  }
  if (detail.event === "loop:tool_call_result" || detail.event === "loop:tool_call_error") {
    summary.callId = detail.callId;
    if (detail.event === "loop:tool_call_result") {
      const result = detail.result as { hits?: unknown[] } | undefined;
      const hits = Array.isArray(result?.hits) ? result.hits.length : undefined;
      if (hits !== undefined) summary.hitCount = hits;
    } else {
      summary.error = detail.error;
    }
    return summary;
  }
  if (detail.event === "loop:done") {
    const finalMessage = detail.finalMessage as { content?: string } | undefined;
    summary.finalContentLength =
      typeof finalMessage?.content === "string" ? finalMessage.content.length : 0;
    return summary;
  }
  if (detail.event === "turn:complete") {
    const conversation = detail.conversation as { messageCount?: number } | undefined;
    summary.messageCount = conversation?.messageCount;
    return summary;
  }
  for (const key of Object.keys(detail)) {
    if (key === "event") continue;
    summary[key] = detail[key];
  }
  return summary;
}

function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

void main().catch((error) => {
  emit({
    phase: "fatal",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
