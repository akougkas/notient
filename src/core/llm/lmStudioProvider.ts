import {
  ChatJsonParseError,
  type ChatMessage,
  type ChatOptions,
  type ChatToolCallDelta,
  type ChatVisionRequest,
  type ChatVisionResult,
  type ChatWithToolsEvent,
  type ChatWithToolsHandle,
  type ChatWithToolsRequest,
  type ChatWithToolsResult,
  type ChatWithToolsToolCall,
  type EmbedOptions,
  type JsonSchema,
  type LLMProvider,
} from "./provider";

export interface ProviderConfig {
  baseUrl: string;
}

interface ChatCompletionResponse {
  choices: { message: { content: string; reasoning_content?: string } }[];
}

interface ChatStreamEvent {
  choices: { delta?: { content?: string; reasoning_content?: string } }[];
}

interface EmbeddingResponse {
  data: { embedding: number[] }[];
}

export class LMStudioProvider implements LLMProvider {
  constructor(private readonly config: ProviderConfig) {}

  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/models`, { signal });
      return response.ok;
    } catch {
      return false;
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens,
        stream: false,
        ...thinkingBody(opts.enableThinking),
      }),
    });
    if (!response.ok) throw new Error(`LLM ${response.status} ${response.statusText}`);
    const data = (await response.json()) as ChatCompletionResponse;
    return data.choices[0]?.message.content ?? "";
  }

  async *chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens,
        stream: true,
        ...thinkingBody(opts.enableThinking),
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`LLM ${response.status} ${response.statusText}`);
    }
    yield* iterateSseDeltas(response.body, opts.signal);
  }

  async embed(input: string[], opts: EmbedOptions): Promise<number[][]> {
    const response = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({ model: opts.model, input }),
    });
    if (!response.ok) throw new Error(`Embed ${response.status} ${response.statusText}`);
    const data = (await response.json()) as EmbeddingResponse;
    return data.data.map((d) => d.embedding);
  }

  async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsHandle> {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.toolChoice ?? "auto",
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens,
      stream: true,
      ...responseSchemaBody(request.responseSchema),
      ...thinkingBody(request.enableThinking),
    });
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: request.signal,
      body,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      if (process.env.NOTIENT_DEBUG_LLM === "1") {
        try {
          const file = `/tmp/notient-llm-request-${Date.now()}.json`;
          await Bun.write(file, body);
          process.stderr.write(`[NOTIENT_DEBUG_LLM] request body dumped to ${file}\n`);
        } catch {
          // best-effort dump
        }
      }
      throw new Error(`LLM ${response.status} ${response.statusText} ${detail.slice(0, 600)}`);
    }
    const aggregator = new ToolStreamAggregator();
    const events = iterateToolEvents(response.body, request.signal, aggregator);
    return {
      events,
      result: async () => aggregator.finalize(),
    };
  }

  async chatVision(request: ChatVisionRequest): Promise<ChatVisionResult> {
    const start = Date.now();
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: request.signal,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens,
        stream: false,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`vision request failed: ${response.status} ${response.statusText} ${text}`);
    }
    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices[0]?.message.content ?? "";
    return { content, durationMs: Date.now() - start };
  }

  async chatJson<T>(messages: ChatMessage[], opts: ChatOptions, schema: JsonSchema): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens,
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: { name: schema.name, strict: true, schema: schema.schema },
        },
        ...thinkingBody(opts.enableThinking),
      }),
    });
    if (!response.ok) throw new Error(`LLM ${response.status} ${response.statusText}`);
    const data = (await response.json()) as ChatCompletionResponse;
    const message = data.choices[0]?.message;
    const raw = pickJsonPayload(message?.content ?? "", message?.reasoning_content ?? "");
    const stripped = stripJsonFences(raw).trim();
    try {
      return JSON.parse(stripped) as T;
    } catch (error) {
      throw new ChatJsonParseError(
        `chatJson failed to parse JSON: ${(error as Error).message}; raw=${raw.slice(0, 200)}`,
        raw,
      );
    }
  }
}

function thinkingBody(enableThinking: boolean | undefined): Record<string, unknown> {
  if (enableThinking !== false) return {};
  return { chat_template_kwargs: { enable_thinking: false } };
}

function responseSchemaBody(schema: JsonSchema | undefined): Record<string, unknown> {
  if (schema === undefined) return {};
  return {
    response_format: {
      type: "json_schema",
      json_schema: { name: schema.name, strict: true, schema: schema.schema },
    },
  };
}

function pickJsonPayload(content: string, reasoningContent: string): string {
  const trimmed = content.trim();
  if (trimmed.length > 0) return content;
  return reasoningContent;
}

function parseSseLine(line: string): string | "[DONE]" | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return "[DONE]";
  try {
    const event = JSON.parse(payload) as ChatStreamEvent;
    const delta = event.choices[0]?.delta;
    if (!delta) return null;
    // Phase 4 H2: llama-server can emit `{content: "", reasoning_content: "..."}`
    // payloads that the previous `??` form treated as content (empty string)
    // and then dropped, losing the reasoning text entirely. Prefer non-empty
    // content; otherwise fall back to non-empty reasoning_content.
    const content = delta.content;
    if (typeof content === "string" && content.length > 0) return content;
    const reasoning = delta.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
    return null;
  } catch {
    return null;
  }
}

function asAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

interface DrainResult {
  rest: string;
  deltas: string[];
  done: boolean;
}

function drainSseLines(buffer: string): DrainResult {
  const deltas: string[] = [];
  let rest = buffer;
  for (;;) {
    const newlineIndex = rest.indexOf("\n");
    if (newlineIndex < 0) break;
    const line = rest.slice(0, newlineIndex).trim();
    rest = rest.slice(newlineIndex + 1);
    const delta = parseSseLine(line);
    if (delta === "[DONE]") return { rest, deltas, done: true };
    if (delta) deltas.push(delta);
  }
  return { rest, deltas, done: false };
}

async function* iterateSseDeltas(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const abortState = attachAbortHandler(reader, signal);
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      throwIfAborted(abortState.aborted());
      const { done, value } = await reader.read();
      throwIfAborted(abortState.aborted());
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const drained = drainSseLines(buffer);
      buffer = drained.rest;
      for (const delta of drained.deltas) yield delta;
      if (drained.done) return;
    }
  } finally {
    abortState.cleanup();
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

function attachAbortHandler(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): { aborted: () => boolean; cleanup: () => void } {
  let abortRequested = signal?.aborted ?? false;
  const onAbort = (): void => {
    abortRequested = true;
    debugLmStudioStream("abort");
    void reader.cancel(asAbortError());
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    aborted: () => abortRequested || signal?.aborted === true,
    cleanup: () => signal?.removeEventListener("abort", onAbort),
  };
}

function throwIfAborted(aborted: boolean): void {
  if (aborted) throw asAbortError();
}

function stripJsonFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1] : text;
}

function debugLmStudioStream(message: string, data?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  console.log(`[Notient][LMStudioStream] ${message}`, data ?? {});
}

interface ToolCallStreamFragment {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ToolStreamSseEvent {
  choices: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: ToolCallStreamFragment[];
    };
    message?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: ToolCallStreamFragment[];
    };
  }[];
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argsJson: string;
}

class ToolStreamAggregator {
  private content = "";
  private reasoning = "";
  private readonly callsByIndex = new Map<number, ToolCallAccumulator>();
  private readonly callOrder: number[] = [];
  private fallbackCounter = 0;

  ingestDelta(event: ToolStreamSseEvent): ChatWithToolsEvent[] {
    const choice = event.choices[0];
    if (!choice) return [];
    const fragment = choice.delta ?? choice.message;
    if (!fragment) return [];
    const out: ChatWithToolsEvent[] = [];
    this.ingestContent(fragment.content, out);
    this.ingestReasoning(fragment.reasoning_content, out);
    this.ingestToolCalls(fragment.tool_calls, out);
    return out;
  }

  private ingestContent(content: string | undefined, out: ChatWithToolsEvent[]): void {
    if (!content || content.length === 0) return;
    this.content += content;
    out.push({ type: "delta", contentDelta: content });
  }

  private ingestReasoning(reasoning: string | undefined, out: ChatWithToolsEvent[]): void {
    if (!reasoning || reasoning.length === 0) return;
    this.reasoning += reasoning;
    out.push({ type: "delta", reasoningDelta: reasoning });
  }

  private ingestToolCalls(
    pieces: ToolCallStreamFragment[] | undefined,
    out: ChatWithToolsEvent[],
  ): void {
    if (!pieces) return;
    for (const piece of pieces) {
      const indexKey = typeof piece.index === "number" ? piece.index : this.fallbackCounter++;
      const entry = this.upsertCall(indexKey, piece);
      this.applyPieceToCall(entry, piece);
      const delta: ChatToolCallDelta = {
        id: entry.id,
        name: entry.name,
        argsJson: entry.argsJson,
      };
      out.push({ type: "delta", toolCallDelta: delta });
    }
  }

  private upsertCall(indexKey: number, piece: ToolCallStreamFragment): ToolCallAccumulator {
    const existing = this.callsByIndex.get(indexKey);
    if (existing) {
      if (piece.id) existing.id = piece.id;
      return existing;
    }
    const created: ToolCallAccumulator = {
      id: piece.id ?? `call_${indexKey}`,
      name: "",
      argsJson: "",
    };
    this.callsByIndex.set(indexKey, created);
    this.callOrder.push(indexKey);
    return created;
  }

  private applyPieceToCall(entry: ToolCallAccumulator, piece: ToolCallStreamFragment): void {
    if (piece.function?.name) entry.name = piece.function.name;
    if (typeof piece.function?.arguments === "string") {
      entry.argsJson += piece.function.arguments;
    }
  }

  finalize(): ChatWithToolsResult {
    const toolCalls: ChatWithToolsToolCall[] = [];
    for (const indexKey of this.callOrder) {
      const entry = this.callsByIndex.get(indexKey);
      if (!entry || !entry.name) continue;
      const args = parseToolArguments(entry.argsJson);
      toolCalls.push({ id: entry.id, name: entry.name, args });
    }
    // Phase 2.5 fallback extended to the tool path: some llama-server response
    // shapes leak reasoning_content into the empty content channel. When the
    // model returns no tool calls and no content but did emit reasoning, fall
    // back to the reasoning text so downstream consumers see something useful.
    let content = this.content;
    if (toolCalls.length === 0 && content.trim().length === 0 && this.reasoning.length > 0) {
      content = this.reasoning;
    }
    return { content, reasoningContent: this.reasoning, toolCalls };
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function parseToolStreamLine(line: string): ToolStreamSseEvent | "[DONE]" | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return "[DONE]";
  try {
    return JSON.parse(payload) as ToolStreamSseEvent;
  } catch {
    return null;
  }
}

interface ToolDrainResult {
  rest: string;
  events: ToolStreamSseEvent[];
  done: boolean;
}

function drainToolStreamLines(buffer: string): ToolDrainResult {
  const events: ToolStreamSseEvent[] = [];
  let rest = buffer;
  for (;;) {
    const newlineIndex = rest.indexOf("\n");
    if (newlineIndex < 0) break;
    const line = rest.slice(0, newlineIndex).trim();
    rest = rest.slice(newlineIndex + 1);
    const parsed = parseToolStreamLine(line);
    if (parsed === "[DONE]") return { rest, events, done: true };
    if (parsed) events.push(parsed);
  }
  return { rest, events, done: false };
}

async function* iterateToolEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  aggregator: ToolStreamAggregator,
): AsyncIterable<ChatWithToolsEvent> {
  const reader = body.getReader();
  const abortState = attachAbortHandler(reader, signal);
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      throwIfAborted(abortState.aborted());
      const { done, value } = await reader.read();
      throwIfAborted(abortState.aborted());
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const drained = drainToolStreamLines(buffer);
      buffer = drained.rest;
      for (const event of drained.events) {
        for (const out of aggregator.ingestDelta(event)) yield out;
      }
      if (drained.done) return;
    }
  } finally {
    abortState.cleanup();
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
