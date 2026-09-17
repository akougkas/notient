import { assertInferenceBudgetAvailable } from "../llm/executionBudget";
import type { ToolInvokeContext } from "./tools/registry";
/**
 * Iterative tool-call loop for a single chat turn.
 *
 * Each round calls the LLM with the running message buffer plus the tool
 * catalog. If the response carries tool calls, they are dispatched via the
 * registry. Write tools own their approval gate requests so they can show
 * precise markdown previews before writing.
 * Tool results join the buffer and the next round begins. The loop ends on
 * a text-only response. The last permitted generation is reserved for answering
 * from gathered evidence with tools disabled.
 *
 * The loop emits {@link AgentLoopEvent} values so the UI can render streaming
 * tokens, tool cards, and final messages in real time. The caller threads a
 * single AbortSignal through the loop so a turn-level cancellation tears down
 * everything in flight.
 */

import type {
  ChatToolCall,
  ChatWithToolsEvent,
  ChatWithToolsResult,
  JsonSchema,
  LLMProvider,
  ChatMessage as ProviderChatMessage,
  ToolSpec,
} from "../llm/provider";
import { ChatJsonParseError } from "../llm/provider";
import { extractFirstJsonObject, stripThinkTags } from "../llm/text";
import { fitToolEvidence } from "./contextBudget";
import type { ToolMode } from "./toolModeProbe";
import type { ToolRegistry } from "./tools/registry";
import type { ChatMessage, Conversation, ToolCall, ToolResult } from "./types";

export interface AgentLoopOptions {
  provider: LLMProvider;
  toolRegistry: ToolRegistry;
  /** Total provider generations, including any structured-output finalization. */
  maxRoundsPerTurn: number;
  toolMode: () => ToolMode;
  responseSchema?: JsonSchema;
  /**
   * Controls when response_format/json_schema is sent alongside tools.
   * Some local OpenAI-compatible servers prioritize response_format over
   * tool_calls when both are present, so retrieval-first callers can defer the
   * final schema until a tool result is already in the prompt.
   */
  responseSchemaMode?: "always" | "after-tool-call";
  /**
   * Soft ceiling on the running provider message buffer, in tokens. Checked
   * before every round after the first: when the accumulated messages exceed
   * it, the oldest tool results are replaced by a `[truncated N chars]`
   * marker. Cheaper and far more predictable than letting the server reject an
   * oversized request mid-turn. Omitted means no in-loop re-budgeting.
   */
  contextBudgetTokens?: number;
  /** Shared reasoning + final-answer ceiling, bounded by the owning turn. */
  generationTokens?: number;
  /** Token estimator for {@link AgentLoopOptions.contextBudgetTokens}. Defaults to chars/4. */
  estimateTokens?: (text: string) => number;
  generateId?: () => string;
  now?: () => number;
}

export type AgentLoopEvent =
  | { type: "loop:assistant-token"; delta: string }
  | { type: "loop:reasoning-token"; delta: string }
  | { type: "loop:tool-call"; call: ToolCall }
  | { type: "loop:tool-result"; result: ToolResult }
  | { type: "loop:approval-pending"; call: ToolCall }
  | {
      type: "loop:done";
      finalMessage: ChatMessage;
      toolMessages: ChatMessage[];
      truncated?: boolean;
    }
  | {
      type: "loop:error";
      kind: "runtime" | "invalid-model-output";
      message: string;
      /** Bounded diagnostic from an invalid final answer, never hidden reasoning. */
      rawContent?: string;
    };

export interface AgentTurnInput {
  conversation: Conversation;
  noteScope?: ToolInvokeContext["noteScope"];
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
  calls: Map<string, { signature: string; dispatch: CallDispatch }>;
  remainingCalls: number;
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
    calls: new Map(),
    remainingCalls: options.maxRoundsPerTurn,
  };

  for (let round = 0; round < options.maxRoundsPerTurn; round++) {
    if (input.signal.aborted) {
      yield { type: "loop:error", kind: "runtime", message: "aborted" };
      return;
    }
    rebudgetMessages(context);
    let outcome: RoundOutcome;
    try {
      outcome = yield* runOneRound(context);
    } catch (error) {
      yield {
        type: "loop:error",
        kind: error instanceof ChatJsonParseError ? "invalid-model-output" : "runtime",
        message: errorMessage(error),
        ...(error instanceof ChatJsonParseError
          ? { rawContent: stripThinkTags(error.raw).slice(0, 200) }
          : {}),
      };
      return;
    }
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
    type: "loop:error",
    kind: "runtime",
    message: "Turn ended without a final answer within its generation budget.",
  };
}

const FINAL_ANSWER_INSTRUCTION =
  "This is the final generation in this turn. Tools are unavailable. Answer the user now from the evidence already gathered. Cite only sources actually inspected. State specific gaps without claiming that unsuccessful retrieval proves the vault contains no answer. Never invent a successful write or infer technical guarantees from an omitted feature. If the evidence is insufficient, explain what is known and what remains unverified.";

function guardPreconditions(
  options: AgentLoopOptions,
  generateId: () => string,
  now: () => number,
): AgentLoopEvent | null {
  if (!Number.isSafeInteger(options.maxRoundsPerTurn) || options.maxRoundsPerTurn < 1) {
    return {
      type: "loop:error",
      kind: "runtime",
      message: "maxRoundsPerTurn must be a positive integer",
    };
  }
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
      kind: "runtime",
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
    return {
      kind: "error",
      event: { type: "loop:error", kind: "runtime", message: "no chatWithTools" },
    };
  }
  const answerOnly = context.remainingCalls === 1;
  const messages = answerOnly ? finalAnswerMessages(context.messages) : context.messages;
  context.remainingCalls--;
  const handle = await provider.chatWithTools({
    model: input.model,
    messages,
    tools: answerOnly ? [] : context.tools,
    ...(answerOnly ? { toolChoice: "none" as const } : {}),
    signal: input.signal,
    maxTokens: options.generationTokens,
    responseSchema: answerOnly ? schemaWanted(context) : selectResponseSchema(context),
  });

  const buffers = { content: "", reasoning: "" };
  try {
    for await (const event of handle.events) {
      const delta = readEventDeltas(event);
      if (delta.contentDelta) {
        buffers.content += delta.contentDelta;
        if (!unexecutedToolSyntax(buffers.content))
          yield { type: "loop:assistant-token", delta: delta.contentDelta };
      }
      if (delta.reasoningDelta) {
        buffers.reasoning += delta.reasoningDelta;
        yield { type: "loop:reasoning-token", delta: delta.reasoningDelta };
      }
    }
  } catch (error) {
    return {
      kind: "error",
      event: { type: "loop:error", kind: "runtime", message: errorMessage(error) },
    };
  }

  const result = await handle.result();
  assertInferenceBudgetAvailable();
  if (result.toolCalls.length === 0) {
    if (unexecutedToolSyntax(result.content || buffers.content))
      return {
        kind: "error",
        event: {
          type: "loop:error",
          kind: "invalid-model-output",
          message:
            "The model returned tool-call markup instead of an answer. No call was executed.",
        },
      };
    if (!stripThinkTags(result.content || buffers.content).trim())
      return {
        kind: "error",
        event: {
          type: "loop:error",
          kind: "invalid-model-output",
          message:
            "The model returned no visible answer. Reasoning alone is not a completed response.",
        },
      };
    const finalized = await finalizeWithSchema(context, buffers, result);
    return { kind: "done", event: buildDoneEvent(context, finalized.buffers, finalized.result) };
  }

  if (answerOnly)
    return {
      kind: "error",
      event: {
        type: "loop:error",
        kind: "invalid-model-output",
        message:
          "The model requested tools after the turn's tool budget ended. No additional calls were executed.",
      },
    };
  const parsedToolCalls = parseProviderToolCallBatch(result.toolCalls);
  if (!parsedToolCalls.ok) {
    return {
      kind: "error",
      event: {
        type: "loop:error",
        kind: "invalid-model-output",
        message: parsedToolCalls.message,
      },
    };
  }
  const toolCalls = parsedToolCalls.calls;
  const toolResults: ToolResult[] = [];
  try {
    for (const call of toolCalls) options.toolRegistry.validate(call.name, call.args);
  } catch (error) {
    return {
      kind: "error",
      event: { type: "loop:error", kind: "invalid-model-output", message: errorMessage(error) },
    };
  }

  // Emit all start events upfront so the UI knows what's running before
  // any individual call returns.
  for (const call of toolCalls) {
    yield { type: "loop:tool-call", call };
  }

  // Only adjacent reads run concurrently. Each write is an ordering barrier,
  // so create -> append -> read in one batch observes the preceding effect.
  const dispatches: CallDispatch[] = [];
  for (let index = 0; index < toolCalls.length; ) {
    const call = toolCalls[index];
    if (options.toolRegistry.isWriteGated(call.name)) {
      dispatches.push(await runSingleCall(context, call));
      index++;
    } else {
      let end = index + 1;
      while (end < toolCalls.length && !options.toolRegistry.isWriteGated(toolCalls[end].name))
        end++;
      dispatches.push(
        ...(await Promise.all(
          toolCalls.slice(index, end).map((item) => runSingleCall(context, item)),
        )),
      );
      index = end;
    }
  }

  for (const { result: callResult, aborted } of dispatches) {
    yield { type: "loop:tool-result", result: callResult };
    toolResults.push(callResult);
    if (aborted) {
      return {
        kind: "error",
        event: { type: "loop:error", kind: "runtime", message: "aborted" },
      };
    }
  }

  appendRoundToHistory(context, buffers, toolCalls, toolResults);
  return { kind: "continue" };
}

/** Qwen chat templates require system instructions at the beginning. Preserve
 * the tool/result sequence while adding the turn limit to its system context. */
function finalAnswerMessages(messages: ProviderChatMessage[]): ProviderChatMessage[] {
  const finish: ProviderChatMessage = {
    role: "user",
    content:
      "[Turn execution limit] Retrieval is finished. Answer the original question now from the available tool results. Do not request further searches or emit tool-call syntax. Cite inspected sources, state concrete evidence gaps, and do not claim that an unexecuted action happened.",
  };
  const first = messages[0];
  if (first?.role !== "system")
    return [{ role: "system", content: FINAL_ANSWER_INSTRUCTION }, ...messages, finish];
  const content =
    typeof first.content === "string"
      ? `${first.content}\n\n${FINAL_ANSWER_INSTRUCTION}`
      : [...first.content, { type: "text" as const, text: FINAL_ANSWER_INSTRUCTION }];
  return [{ ...first, content }, ...messages.slice(1), finish];
}

function unexecutedToolSyntax(content: string): boolean {
  return /^\s*(?:<tool_call>|<function=[\w.-]+>)/.test(stripThinkTags(content));
}

/**
 * A tool round never carries a response schema. llama.cpp builds one
 * grammar per request and rejects `tools` combined with `json_schema`
 * ("failed to parse grammar"), so structure is enforced in a separate
 * finalize call once the model stops calling tools.
 */
function selectResponseSchema(context: RoundContext): JsonSchema | undefined {
  const schema = context.options.responseSchema;
  if (schema === undefined) return undefined;
  if (context.tools.length > 0) return undefined;
  if (context.options.responseSchemaMode !== "after-tool-call") return schema;
  const hasToolResult = context.accumulatedTurnMessages.some((message) => message.role === "tool");
  return hasToolResult ? schema : undefined;
}

function schemaWanted(context: RoundContext): JsonSchema | undefined {
  const schema = context.options.responseSchema;
  if (schema === undefined) return undefined;
  if (context.options.responseSchemaMode !== "after-tool-call") return schema;
  const hasToolResult = context.accumulatedTurnMessages.some((message) => message.role === "tool");
  return hasToolResult ? schema : undefined;
}

/**
 * "Already structured" means an object that carries every top-level key the
 * schema requires, not merely any JSON object: a draft like {"answer": "..."}
 * without citations must still go through the constrained finalize pass.
 */
function parsesAsJsonObject(text: string, schema: JsonSchema): boolean {
  const candidate = extractFirstJsonObject(stripThinkTags(text));
  if (candidate === null) return false;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const required = (schema.schema as { required?: unknown }).required;
    if (!Array.isArray(required)) return true;
    const record = parsed as Record<string, unknown>;
    return required.every((key) => typeof key === "string" && key in record);
  } catch {
    return false;
  }
}

/**
 * When the turn wants structured output and the model's final prose does
 * not already parse, use a remaining generation with tools disabled and the
 * schema attached. An incomplete structured answer fails without extra calls.
 */
async function finalizeWithSchema(
  context: RoundContext,
  buffers: { content: string; reasoning: string },
  result: ChatWithToolsResult,
): Promise<{ buffers: { content: string; reasoning: string }; result: ChatWithToolsResult }> {
  const schema = schemaWanted(context);
  const provider = context.options.provider;
  if (schema === undefined || context.tools.length === 0 || !provider.chatWithTools) {
    return { buffers, result };
  }
  const draft = buffers.content.length > 0 ? buffers.content : result.content;
  if (parsesAsJsonObject(draft, schema)) return { buffers, result };
  const finalized = await requestSchemaCompletion(context, schema, [
    { role: "assistant", content: draft },
    {
      role: "user",
      content:
        "Render your previous answer as JSON that satisfies the required response schema. Preserve the claims and citations exactly; fill every other required field with your honest value (for example a real confidence in [0, 1]), never a placeholder.",
    },
  ]);
  if (finalized === null || !parsesAsJsonObject(finalized, schema))
    throw new ChatJsonParseError(
      "Structured answer could not be completed within the generation budget.",
      draft,
    );
  return {
    buffers: { content: finalized, reasoning: buffers.reasoning },
    result: { ...result, content: finalized },
  };
}

/**
 * One non-streamed call with tools disabled and the schema attached. Returns
 * the content, or null for an empty/unusable answer. Provider failures propagate.
 */
async function requestSchemaCompletion(
  context: RoundContext,
  schema: JsonSchema,
  extraMessages: ProviderChatMessage[],
): Promise<string | null> {
  const provider = context.options.provider;
  if (!provider.chatWithTools || context.remainingCalls < 1 || context.input.signal.aborted)
    return null;
  context.remainingCalls--;
  const handle = await provider.chatWithTools({
    model: context.input.model,
    messages: [...context.messages, ...extraMessages],
    tools: [],
    toolChoice: "none",
    signal: context.input.signal,
    maxTokens: context.options.generationTokens,
    responseSchema: schema,
  });
  for await (const _event of handle.events) {
    // Drain; the finalize pass is not streamed to the client.
  }
  const finalized = await handle.result();
  if (finalized.toolCalls.length || context.input.signal.aborted) return null;
  return finalized.content.trim().length === 0 ? null : finalized.content;
}

interface CallDispatch {
  result: ToolResult;
  aborted: boolean;
}

async function runSingleCall(context: RoundContext, call: ToolCall): Promise<CallDispatch> {
  const { options, input } = context;
  if (input.signal.aborted) {
    return { result: makeFailureResult(call.id, "aborted"), aborted: true };
  }
  const signature = JSON.stringify([call.name, call.args]);
  const previous = context.calls.get(call.id);
  if (previous) {
    if (previous.signature !== signature)
      return {
        result: makeFailureResult(call.id, "tool call id reused with different arguments"),
        aborted: false,
      };
    return previous.dispatch;
  }
  // Record an uncertain outcome before invoking. A thrown/ambiguous write is
  // never blindly replayed under a repeated provider call id in this turn.
  context.calls.set(call.id, {
    signature,
    dispatch: {
      result: makeFailureResult(
        call.id,
        "prior invocation outcome is uncertain; inspect history before retrying",
      ),
      aborted: false,
    },
  });
  try {
    const start = performance.now();
    const data = await options.toolRegistry.invoke(call.name, call.args, input.signal, {
      clientIdentity: input.conversation.clientIdentity,
      noteScope: input.noteScope,
      callId: call.id,
    });
    const dispatch: CallDispatch = {
      result: {
        callId: call.id,
        status: "ok",
        data,
        durationMs: Math.round(performance.now() - start),
      },
      aborted: false,
    };
    context.calls.set(call.id, { signature, dispatch });
    return dispatch;
  } catch (error) {
    return {
      result: makeFailureResult(call.id, errorMessage(error)),
      aborted: isAbortError(error),
    };
  }
}

function buildDoneEvent(
  context: RoundContext,
  buffers: { content: string; reasoning: string },
  result: ChatWithToolsResult,
): AgentLoopEvent {
  // The streamed buffer is the raw content channel. Templates that leak
  // `<think>...</think>` into it would otherwise persist the reasoning into
  // history and replay it on every later turn; the provider's own
  // result.content is already stripped.
  const streamed = stripThinkTags(buffers.content);
  return {
    type: "loop:done",
    finalMessage: {
      id: context.generateId(),
      role: "assistant",
      content: streamed.length > 0 ? streamed : result.content,
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

  // OpenAI tool-call protocol requires the assistant turn with intact
  // `tool_calls`, followed by `role:"tool"` messages keyed by `tool_call_id`.
  // This gives every result an unambiguous originating call.
  context.messages.push({
    role: "assistant",
    content: buffers.content,
    tool_calls: toolCalls.map(toProviderToolCall),
  });
  for (const toolResult of toolResults) {
    const content =
      toolResult.status === "ok"
        ? JSON.stringify(toolResult.data ?? null)
        : `error: ${toolResult.error ?? "tool failed"}`;
    const toolMessage: ChatMessage = {
      id: context.generateId(),
      role: "tool",
      content,
      toolCallId: toolResult.callId,
      createdAt: context.now(),
    };
    context.accumulatedTurnMessages.push(toolMessage);
    context.messages.push({ role: "tool", tool_call_id: toolResult.callId, content });
  }
}

function toProviderToolCall(call: ToolCall): ChatToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  };
}

type ParsedToolCallBatch = { ok: true; calls: ToolCall[] } | { ok: false; message: string };

/**
 * Treat provider tool calls as untrusted runtime data. The complete assistant
 * batch is checked before emitting a tool card or invoking the registry so a
 * duplicate id can never execute two effects and only fail later when the
 * conversation serializer discovers the ambiguous transcript.
 */
function parseProviderToolCallBatch(raw: unknown): ParsedToolCallBatch {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "LLM returned a malformed tool-call batch" };
  }
  const calls: ToolCall[] = [];
  const seenIds = new Set<string>();
  for (const candidate of raw) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      candidate.id.trim() !== candidate.id ||
      typeof candidate.name !== "string" ||
      candidate.name.length === 0 ||
      candidate.name.trim() !== candidate.name ||
      !isRecord(candidate.args)
    ) {
      return { ok: false, message: "LLM returned a malformed tool call" };
    }
    if (seenIds.has(candidate.id)) {
      return { ok: false, message: "duplicate tool call id in one assistant batch" };
    }
    seenIds.add(candidate.id);
    calls.push({ id: candidate.id, name: candidate.name, args: candidate.args });
  }
  return { ok: true, calls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Trim the running message buffer back under the caller's budget by blanking
 * the oldest tool results first. Tool payloads are the only part of the buffer
 * that grows without bound, and the oldest ones are the least likely to matter
 * to the next round. Everything else (system prompt, user turn, assistant tool
 * calls) stays intact so the transcript keeps its shape and every tool call
 * keeps its answer.
 */
function rebudgetMessages(context: RoundContext): void {
  const budget = context.options.contextBudgetTokens;
  if (budget === undefined || budget <= 0) return;
  context.messages = fitToolEvidence(
    context.messages,
    budget,
    context.options.estimateTokens ?? defaultEstimateTokens,
  );
}

function defaultEstimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function makeFailureResult(callId: string, error: string): ToolResult {
  const canonicalError = error.trim();
  return {
    callId,
    status: "error",
    error: canonicalError.length > 0 ? canonicalError : "tool failed without a diagnostic",
    durationMs: 0,
  };
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
