/**
 * Iterative tool-call loop for a single chat turn.
 *
 * Each round calls the LLM with the running message buffer plus the tool
 * catalog. If the response carries tool calls, they are routed through the
 * approval gate (write-gated tools only) and dispatched via the registry.
 * Tool results join the buffer and the next round begins. The loop ends on
 * a text-only response or when the round cap is reached.
 *
 * The loop emits {@link AgentLoopEvent} values so the UI can render streaming
 * tokens, tool cards, and final messages in real time. The caller threads a
 * single AbortSignal through the loop so a turn-level cancellation tears down
 * everything in flight.
 */

import type {
  ChatWithToolsEvent,
  ChatWithToolsResult,
  LLMProvider,
  ChatMessage as ProviderChatMessage,
  ToolSpec,
} from "../llm/provider";
import type { ApprovalGate } from "./approvalGate";
import type { ToolRegistry } from "./tools/registry";
import type { ChatMessage, Conversation, ToolCall, ToolResult } from "./types";

export interface AgentLoopOptions {
  provider: LLMProvider;
  toolRegistry: ToolRegistry;
  approvalGate: ApprovalGate;
  maxRoundsPerTurn: number;
  toolMode: () => "native" | "json-fallback" | "disabled";
  generateId?: () => string;
  now?: () => number;
}

export type AgentLoopEvent =
  | { type: "loop:assistant-token"; delta: string }
  | { type: "loop:reasoning-token"; delta: string }
  | { type: "loop:tool-call"; call: ToolCall }
  | { type: "loop:tool-result"; result: ToolResult }
  | { type: "loop:approval-pending"; call: ToolCall }
  | { type: "loop:done"; finalMessage: ChatMessage; toolMessages: ChatMessage[] }
  | { type: "loop:error"; message: string };

export interface AgentTurnInput {
  conversation: Conversation;
  systemAndHistory: ProviderChatMessage[];
  model: string;
  signal: AbortSignal;
}

interface RoundContext {
  options: AgentLoopOptions;
  input: AgentTurnInput;
  generateId: () => string;
  now: () => number;
  messages: ProviderChatMessage[];
  accumulatedTurnMessages: ChatMessage[];
  tools: ToolSpec[];
}

export async function* runAgentTurn(
  options: AgentLoopOptions,
  input: AgentTurnInput,
): AsyncGenerator<AgentLoopEvent> {
  const generateId = options.generateId ?? defaultGenerateId;
  const now = options.now ?? Date.now;

  const guard = guardPreconditions(options, generateId, now);
  if (guard) {
    yield guard;
    return;
  }

  const context: RoundContext = {
    options,
    input,
    generateId,
    now,
    messages: [...input.systemAndHistory],
    accumulatedTurnMessages: [],
    tools: options.toolRegistry.exportToolsForOpenAI() as unknown as ToolSpec[],
  };

  for (let round = 0; round < options.maxRoundsPerTurn; round++) {
    if (input.signal.aborted) {
      yield { type: "loop:error", message: "aborted" };
      return;
    }
    const outcome = yield* runOneRound(context);
    if (outcome.kind === "done") {
      yield outcome.event;
      return;
    }
    if (outcome.kind === "error") {
      yield outcome.event;
      return;
    }
    // outcome.kind === "continue" — fall through to next round.
  }

  yield {
    type: "loop:done",
    finalMessage: {
      id: generateId(),
      role: "assistant",
      content: "I've used all available tool rounds. Let me know what to try next.",
      createdAt: now(),
    },
    toolMessages: context.accumulatedTurnMessages,
  };
}

function guardPreconditions(
  options: AgentLoopOptions,
  generateId: () => string,
  now: () => number,
): AgentLoopEvent | null {
  if (options.toolMode() === "disabled") {
    return {
      type: "loop:done",
      finalMessage: {
        id: generateId(),
        role: "assistant",
        content:
          "Tool calling is disabled for this model. Switch to a tool-capable model in settings to use the chat agent.",
        createdAt: now(),
      },
      toolMessages: [],
    };
  }
  if (!options.provider.chatWithTools) {
    return {
      type: "loop:error",
      message: "LLM provider does not support tool-calling chat.",
    };
  }
  return null;
}

type RoundOutcome =
  | { kind: "continue" }
  | { kind: "done"; event: AgentLoopEvent }
  | { kind: "error"; event: AgentLoopEvent };

async function* runOneRound(context: RoundContext): AsyncGenerator<AgentLoopEvent, RoundOutcome> {
  const { options, input } = context;
  const provider = options.provider;
  if (!provider.chatWithTools) {
    return { kind: "error", event: { type: "loop:error", message: "no chatWithTools" } };
  }
  const handle = await provider.chatWithTools({
    model: input.model,
    messages: context.messages,
    tools: context.tools,
    signal: input.signal,
  });

  const buffers = { content: "", reasoning: "" };
  try {
    for await (const event of handle.events) {
      const delta = readEventDeltas(event);
      if (delta.contentDelta) {
        buffers.content += delta.contentDelta;
        yield { type: "loop:assistant-token", delta: delta.contentDelta };
      }
      if (delta.reasoningDelta) {
        buffers.reasoning += delta.reasoningDelta;
        yield { type: "loop:reasoning-token", delta: delta.reasoningDelta };
      }
    }
  } catch (error) {
    return { kind: "error", event: { type: "loop:error", message: errorMessage(error) } };
  }

  const result = await handle.result();
  if (result.toolCalls.length === 0) {
    return { kind: "done", event: buildDoneEvent(context, buffers, result) };
  }

  const toolCalls: ToolCall[] = result.toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    args: call.args,
  }));
  const toolResults: ToolResult[] = [];

  for (const call of toolCalls) {
    const dispatch = yield* dispatchSingleCall(context, call);
    toolResults.push(dispatch.result);
    if (dispatch.aborted) {
      return { kind: "error", event: { type: "loop:error", message: "aborted" } };
    }
  }

  appendRoundToHistory(context, buffers, toolCalls, toolResults);
  return { kind: "continue" };
}

interface CallDispatch {
  result: ToolResult;
  aborted: boolean;
}

async function* dispatchSingleCall(
  context: RoundContext,
  call: ToolCall,
): AsyncGenerator<AgentLoopEvent, CallDispatch> {
  const { options, input, now } = context;
  yield { type: "loop:tool-call", call };
  if (input.signal.aborted) {
    return {
      result: makeFailureResult(call.id, "aborted"),
      aborted: true,
    };
  }
  try {
    if (options.toolRegistry.isWriteGated(call.name)) {
      const gateOutcome = yield* awaitApproval(context, call);
      if (gateOutcome.rejected) {
        yield { type: "loop:tool-result", result: gateOutcome.result };
        return { result: gateOutcome.result, aborted: false };
      }
    }
    const start = now();
    const data = await options.toolRegistry.invoke(call.name, call.args, input.signal);
    const success: ToolResult = {
      callId: call.id,
      status: "ok",
      data,
      durationMs: now() - start,
    };
    yield { type: "loop:tool-result", result: success };
    return { result: success, aborted: false };
  } catch (error) {
    const failure = makeFailureResult(call.id, errorMessage(error));
    yield { type: "loop:tool-result", result: failure };
    return { result: failure, aborted: isAbortError(error) };
  }
}

interface ApprovalOutcome {
  rejected: boolean;
  result: ToolResult;
}

async function* awaitApproval(
  context: RoundContext,
  call: ToolCall,
): AsyncGenerator<AgentLoopEvent, ApprovalOutcome> {
  // Kick off the request first so the gate registers the pending entry before
  // we hand the approval-pending event to the consumer. The consumer can then
  // call approvalGate.resolve(callId, ...) and the awaited promise resumes.
  const decisionPromise = context.options.approvalGate.request(
    call,
    context.input.conversation.approvalMode,
    JSON.stringify(call.args),
    context.input.signal,
  );
  yield { type: "loop:approval-pending", call };
  const decision = await decisionPromise;
  if (!decision.approved) {
    return {
      rejected: true,
      result: makeFailureResult(call.id, decision.reason ?? "rejected"),
    };
  }
  return {
    rejected: false,
    result: { callId: call.id, status: "ok", data: null, durationMs: 0 },
  };
}

function buildDoneEvent(
  context: RoundContext,
  buffers: { content: string; reasoning: string },
  result: ChatWithToolsResult,
): AgentLoopEvent {
  return {
    type: "loop:done",
    finalMessage: {
      id: context.generateId(),
      role: "assistant",
      content: buffers.content.length > 0 ? buffers.content : result.content,
      reasoningContent: buffers.reasoning.length > 0 ? buffers.reasoning : result.reasoningContent,
      createdAt: context.now(),
    },
    toolMessages: context.accumulatedTurnMessages,
  };
}

function appendRoundToHistory(
  context: RoundContext,
  buffers: { content: string; reasoning: string },
  toolCalls: ToolCall[],
  toolResults: ToolResult[],
): void {
  const assistantMessage: ChatMessage = {
    id: context.generateId(),
    role: "assistant",
    content: buffers.content,
    toolCalls,
    toolResults,
    reasoningContent: buffers.reasoning,
    createdAt: context.now(),
  };
  context.accumulatedTurnMessages.push(assistantMessage);
  context.messages.push({ role: "assistant", content: buffers.content });
  for (const toolResult of toolResults) {
    const toolMessage: ChatMessage = {
      id: context.generateId(),
      role: "tool",
      content:
        toolResult.status === "ok"
          ? JSON.stringify(toolResult.data ?? null)
          : `error: ${toolResult.error ?? "tool failed"}`,
      createdAt: context.now(),
    };
    context.accumulatedTurnMessages.push(toolMessage);
    context.messages.push({
      role: "user",
      content: `Tool result (${toolResult.callId}): ${toolMessage.content}`,
    });
  }
}

function makeFailureResult(callId: string, error: string): ToolResult {
  return { callId, status: "error", error, durationMs: 0 };
}

function readEventDeltas(event: ChatWithToolsEvent): {
  contentDelta?: string;
  reasoningDelta?: string;
} {
  return {
    contentDelta: event.contentDelta,
    reasoningDelta: event.reasoningDelta,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }
  return false;
}

function defaultGenerateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
