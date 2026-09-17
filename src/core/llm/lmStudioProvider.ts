import { chmod, mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteApiError } from "../../api/schema";
import {
  assertBearerTokenAbsent,
  createBearerTokenStreamGuard,
  endpointRequestHeaders,
  redactBearerToken,
  validateBearerToken,
} from "./bearerAuth";
import {
  type CompletionMetadata,
  IncompleteCompletionError,
  type TokenUsage,
  completionMetadata,
  decodeUsage,
  requireComplete,
} from "./completion";
import { reserveGeneration } from "./executionBudget";
import { ProviderHttpError, providerHttpError } from "./httpError";
import {
  ChatJsonParseError,
  type ChatMessage,
  type ChatOptions,
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
import { stripThinkTags } from "./text";

export interface ProviderConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
}

type StreamErrorPayload = string | { message: string; code?: string | number };

/**
 * llama-server and LM Studio can answer a 200 stream with an error frame
 * (`data: {"error": {...}}`) when the model is unloaded or the request is
 * rejected mid-flight. Surface its message instead of crashing on the
 * missing `choices` array.
 */
function streamErrorMessage(event: unknown): string | null {
  if (!isRecord(event) || !Object.hasOwn(event, "error")) return null;
  const error = event.error as StreamErrorPayload | unknown;
  if (typeof error === "string" && error.length > 0 && error.trim() === error) return error;
  if (
    isRecord(error) &&
    typeof error.message === "string" &&
    error.message.length > 0 &&
    error.message.trim() === error.message &&
    (error.code === undefined || typeof error.code === "string" || typeof error.code === "number")
  ) {
    return error.message;
  }
  throw new Error("LLM stream error frame is malformed");
}

export class LMStudioProvider implements LLMProvider {
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = {
      baseUrl: config.baseUrl,
      ...(config.apiKey === undefined
        ? {}
        : { apiKey: validateBearerToken(config.apiKey, "provider apiKey") }),
    };
  }

  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: this.headers("none"),
        signal,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async chat(messages: ChatMessage[], supplied: ChatOptions): Promise<string> {
    const opts = {
      ...supplied,
      ...reserveGeneration(
        messages,
        generationCeiling(supplied.maxTokens),
        null,
        supplied.signal,
        supplied.onCompletion,
      ),
    };
    try {
      await opts.ready;
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers("json"),
        signal: opts.signal,
        body: JSON.stringify({
          model: opts.model,
          messages,
          temperature: opts.temperature ?? 0.3,
          max_tokens: generationCeiling(opts.maxTokens),
          stream: false,
          ...thinkingBody(opts.enableThinking),
        }),
      });
      if (!response.ok) throw await providerHttpError(response);
      const payload: unknown = await response.json();
      assertBearerTokenAbsent(payload, this.config.apiKey, "chat completion");
      const message = decodeAssistantMessage(payload, "chat completion", opts.onCompletion);
      const content = stripThinkTags(message.content);
      assertBearerTokenAbsent(content, this.config.apiKey, "chat completion");
      return content;
    } catch (error) {
      throw redactProviderError(error, this.config.apiKey);
    }
  }

  async *chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string> {
    const handle = await this.chatWithTools({
      ...opts,
      messages,
      tools: [],
      signal: opts.signal ?? new AbortController().signal,
    });
    for await (const event of handle.events) {
      if (event.contentDelta) yield event.contentDelta;
    }
    await handle.result();
  }

  async embed(input: string[], opts: EmbedOptions): Promise<number[][]> {
    const reservation = reserveGeneration(
      input.map((content) => ({ role: "user", content })),
      0,
      null,
      opts.signal,
    );
    try {
      await reservation.ready;
      const response = await fetch(`${this.config.baseUrl}/embeddings`, {
        method: "POST",
        headers: this.headers("json"),
        signal: reservation.signal,
        body: JSON.stringify({ model: opts.model, input }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Embed ${response.status} ${response.statusText} ${detail.slice(0, 300)}`.trim(),
        );
      }
      const payload: unknown = await response.json();
      assertBearerTokenAbsent(payload, this.config.apiKey, "embedding response");
      const usage = decodeUsage(isRecord(payload) ? payload.usage : undefined);
      reservation.onCompletion({ usage, finishReason: "stop", state: "complete" });
      return decodeEmbeddingResponse(payload, input.length);
    } catch (error) {
      throw redactProviderError(error, this.config.apiKey);
    }
  }

  async chatWithTools(supplied: ChatWithToolsRequest): Promise<ChatWithToolsHandle> {
    const reservation = reserveGeneration(
      supplied.messages,
      generationCeiling(supplied.maxTokens),
      { tools: supplied.tools, schema: supplied.responseSchema },
      supplied.signal,
      supplied.onCompletion,
    );
    const request = { ...supplied, ...reservation, signal: reservation.signal ?? supplied.signal };
    try {
      await request.ready;
      const body = JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.tools.length > 0
          ? { tools: request.tools, tool_choice: request.toolChoice ?? "auto" }
          : {}),
        ...(request.toolChoice === "none" ? { tool_choice: "none" } : {}),
        temperature: request.temperature ?? 0.3,
        max_tokens: generationCeiling(request.maxTokens),
        stream: true,
        stream_options: { include_usage: true },
        ...responseSchemaBody(request.responseSchema),
        ...thinkingBody(request.enableThinking),
      });
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers("json"),
        signal: request.signal,
        body,
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        if (process.env.NOTIENT_DEBUG_LLM === "1") {
          try {
            const file = await writePrivateDebugRequest(body);
            process.stderr.write(`[NOTIENT_DEBUG_LLM] request body dumped to ${file}\n`);
          } catch {
            // best-effort dump
          }
        }
        throw new Error(`LLM ${response.status} ${response.statusText} ${detail.slice(0, 600)}`);
      }
      const aggregator = new ToolStreamAggregator(this.config.apiKey, request.onCompletion);
      const events = redactStreamErrors(
        iterateToolEvents(response.body, request.signal, aggregator),
        this.config.apiKey,
      );
      return {
        events,
        result: async () => aggregator.finalize(),
      };
    } catch (error) {
      throw redactProviderError(error, this.config.apiKey);
    }
  }

  async chatVision(supplied: ChatVisionRequest): Promise<ChatVisionResult> {
    const reservation = reserveGeneration(
      supplied.messages,
      generationCeiling(supplied.maxTokens),
      null,
      supplied.signal,
    );
    const request = { ...supplied, ...reservation };
    try {
      await request.ready;
      const start = performance.now();
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers("json"),
        signal: request.signal,
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.2,
          max_tokens: generationCeiling(request.maxTokens),
          stream: false,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`vision request failed: ${response.status} ${response.statusText} ${text}`);
      }
      const payload: unknown = await response.json();
      assertBearerTokenAbsent(payload, this.config.apiKey, "vision completion");
      const { content } = decodeAssistantMessage(
        payload,
        "vision completion",
        reservation.onCompletion,
      );
      if (content.length === 0) throw new Error("vision completion returned empty content");
      return { content, durationMs: Math.round(performance.now() - start) };
    } catch (error) {
      throw redactProviderError(error, this.config.apiKey);
    }
  }

  async chatJson<T>(
    messages: ChatMessage[],
    supplied: ChatOptions,
    schema: JsonSchema,
  ): Promise<T> {
    const opts = {
      ...supplied,
      ...reserveGeneration(
        messages,
        generationCeiling(supplied.maxTokens),
        schema,
        supplied.signal,
        supplied.onCompletion,
      ),
    };
    try {
      await opts.ready;
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers("json"),
        signal: opts.signal,
        body: JSON.stringify({
          model: opts.model,
          messages,
          temperature: opts.temperature ?? 0.1,
          max_tokens: generationCeiling(opts.maxTokens),
          stream: false,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: schema.name,
              strict: true,
              schema: schema.schema,
            },
          },
          ...thinkingBody(opts.enableThinking),
        }),
      });
      if (!response.ok) throw await providerHttpError(response);
      const payload: unknown = await response.json();
      assertBearerTokenAbsent(payload, this.config.apiKey, "structured completion");
      const message = decodeAssistantMessage(payload, "structured completion", opts.onCompletion);
      const raw = stripThinkTags(message.content);
      const safeRaw = this.redact(raw);
      if (raw.length === 0 || raw.trim() !== raw) {
        throw new ChatJsonParseError(
          "chatJson returned non-canonical empty or padded content",
          safeRaw,
        );
      }
      try {
        const parsed = JSON.parse(raw) as T;
        assertBearerTokenAbsent(parsed, this.config.apiKey, "structured completion");
        return parsed;
      } catch (error) {
        throw new ChatJsonParseError(
          `chatJson failed to parse JSON: ${(error as Error).message}; raw=${safeRaw.slice(0, 200)}`,
          safeRaw,
        );
      }
    } catch (error) {
      throw redactProviderError(error, this.config.apiKey);
    }
  }

  private headers(contentType: "json" | "none"): Record<string, string> {
    return endpointRequestHeaders(this.config.apiKey, contentType);
  }

  private redact(text: string): string {
    return redactBearerToken(text, this.config.apiKey);
  }
}

async function* redactStreamErrors<T>(
  source: AsyncIterable<T>,
  apiKey: string | undefined,
): AsyncIterable<T> {
  try {
    yield* source;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const message = redactBearerToken(error.message, apiKey);
    if (message === error.message) throw error;
    if (error instanceof NoteApiError) throw new NoteApiError(error.code, message);
    const redacted = new Error(message);
    redacted.name = error.name;
    throw redacted;
  }
}

function redactProviderError(error: unknown, apiKey: string | undefined): Error {
  const message = redactBearerToken(error instanceof Error ? error.message : String(error), apiKey);
  if (error instanceof NoteApiError) return new NoteApiError(error.code, message);
  if (error instanceof ChatJsonParseError) {
    return new ChatJsonParseError(message, redactBearerToken(error.raw, apiKey));
  }
  if (error instanceof IncompleteCompletionError)
    return new IncompleteCompletionError(message, error.completion);
  if (error instanceof ProviderHttpError) return new ProviderHttpError(error.status, message);
  const redacted = new Error(message);
  if (error instanceof Error) redacted.name = error.name;
  return redacted;
}

async function writePrivateDebugRequest(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "notient-llm-debug-"));
  await chmod(directory, 0o700);
  const file = join(directory, "request.json");
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
  return file;
}

interface DecodedAssistantMessage {
  content: string;
  reasoningContent?: string;
}

function decodeAssistantMessage(
  raw: unknown,
  label: string,
  onCompletion?: (metadata: CompletionMetadata) => void,
): DecodedAssistantMessage {
  if (!isRecord(raw) || !Array.isArray(raw.choices) || raw.choices.length !== 1) {
    throw new Error(`${label} returned an invalid choices envelope`);
  }
  const choice = raw.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new Error(`${label} returned an invalid assistant message`);
  }
  const message = choice.message;
  if (message.content !== null && typeof message.content !== "string") {
    throw new Error(`${label} assistant content must be a string`);
  }
  const reasoning = message.reasoning_content;
  if (reasoning !== undefined && reasoning !== null && typeof reasoning !== "string") {
    throw new Error(`${label} reasoning_content must be a string when present`);
  }
  const metadata = completionMetadata(
    typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    decodeUsage(raw.usage),
  );
  const content = stripThinkTags(message.content ?? "");
  const finalMetadata =
    metadata.state === "complete" && content.length === 0
      ? { ...metadata, state: "incomplete" as const }
      : metadata;
  onCompletion?.(finalMetadata);
  requireComplete(finalMetadata, content);
  return { content, ...(typeof reasoning === "string" ? { reasoningContent: reasoning } : {}) };
}

function decodeEmbeddingResponse(raw: unknown, expectedCount: number): number[][] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new Error("Embed returned an invalid data envelope");
  }
  if (raw.data.length !== expectedCount) {
    throw new Error(`Embed returned ${raw.data.length} vectors, expected ${expectedCount}`);
  }
  const decoded = raw.data.map((item, position) => decodeEmbeddingItem(item, position));
  const indexed = decoded.filter((item) => item.index !== undefined);
  if (indexed.length !== 0 && indexed.length !== decoded.length) {
    throw new Error("Embed returned a partial index mapping");
  }
  const ordered = indexed.length === 0 ? decoded : orderIndexedEmbeddings(decoded);
  const dimension = ordered[0]?.embedding.length;
  if (dimension !== undefined && ordered.some((item) => item.embedding.length !== dimension)) {
    throw new Error("Embed returned inconsistent vector dimensions");
  }
  return ordered.map((item) => [...item.embedding]);
}

interface DecodedEmbeddingItem {
  embedding: number[];
  index?: number;
}

function decodeEmbeddingItem(raw: unknown, position: number): DecodedEmbeddingItem {
  if (!isRecord(raw) || !Array.isArray(raw.embedding) || raw.embedding.length === 0) {
    throw new Error(`Embed data[${position}] has no vector`);
  }
  if (!raw.embedding.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error(`Embed data[${position}] contains a non-finite vector value`);
  }
  if (
    raw.index !== undefined &&
    (typeof raw.index !== "number" || !Number.isSafeInteger(raw.index) || raw.index < 0)
  ) {
    throw new Error(`Embed data[${position}] has an invalid index`);
  }
  return {
    embedding: [...raw.embedding],
    ...(raw.index === undefined ? {} : { index: raw.index }),
  };
}

function orderIndexedEmbeddings(items: DecodedEmbeddingItem[]): DecodedEmbeddingItem[] {
  const ordered = [...items].sort(
    (left, right) => (left.index as number) - (right.index as number),
  );
  if (ordered.some((item, index) => item.index !== index)) {
    throw new Error("Embed indices must be a complete unique zero-based permutation");
  }
  return ordered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** A shared output ceiling includes legitimate reasoning. Callers can lower it to their remaining run budget. */
function generationCeiling(raw: number | undefined): number {
  const value = raw ?? 8192;
  if (!Number.isSafeInteger(value) || value < 1 || value > 131072)
    throw new Error("maxTokens must be an integer from 1 through 131072");
  return value;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argsJson: string;
  guardArguments: (chunk: string) => void;
}

class ToolStreamAggregator {
  private content = "";
  private reasoning = "";
  private readonly calls = new Map<number, ToolCallAccumulator>();
  private readonly guardContent: (chunk: string) => void;
  private readonly guardReasoning: (chunk: string) => void;
  private completed = false;
  private reported = false;
  private finishReason: string | null = null;
  private usage: TokenUsage = decodeUsage(undefined);
  private byteCount = 0;
  private resultValue: ChatWithToolsResult | null = null;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly onCompletion?: (metadata: CompletionMetadata) => void,
  ) {
    this.guardContent = createBearerTokenStreamGuard(apiKey, "LLM tool stream content");
    this.guardReasoning = createBearerTokenStreamGuard(apiKey, "LLM tool stream reasoning");
  }

  ingest(raw: unknown): ChatWithToolsEvent[] {
    if (this.completed) throw new Error("LLM tool stream emitted data after [DONE]");
    if (!isRecord(raw)) throw new Error("LLM stream frame must be an object");
    const error = streamErrorMessage(raw);
    if (error !== null)
      throw new Error(`LLM stream error: ${redactBearerToken(error, this.apiKey)}`);
    assertBearerTokenAbsent(raw, this.apiKey, "LLM stream frame");
    if (raw.usage != null) this.usage = decodeUsage(raw.usage);
    if (!Array.isArray(raw.choices) || raw.choices.length > 1)
      throw new Error("LLM tool stream frame must contain exactly one choice or a usage frame");
    if (raw.choices.length === 0) {
      if (raw.usage == null) throw new Error("LLM stream empty choices without usage");
      return [];
    }
    const choice = raw.choices[0];
    if (!isRecord(choice)) throw new Error("LLM tool stream choice must be an object");
    if (this.finishReason !== null)
      throw new Error("LLM stream emitted a choice after finish_reason");
    if (Object.hasOwn(choice, "delta") === Object.hasOwn(choice, "message"))
      throw new Error("LLM tool stream choice must contain exactly one delta or message");
    const fragment = choice.delta ?? choice.message;
    if (!isRecord(fragment)) throw new Error("LLM tool stream fragment must be an object");
    const out: ChatWithToolsEvent[] = [];
    for (const field of ["content", "reasoning_content"] as const) {
      const value = fragment[field];
      if (value == null) continue;
      if (typeof value !== "string") throw new Error(`LLM stream ${field} delta must be a string`);
      this.byteCount += value.length;
      if (field === "content") {
        this.guardContent(value);
        // Keep the preamble until finalization: templates can place a bare closing
        // think tag after an arbitrarily long prefix. No hidden text is emitted.
        this.content += value;
      } else {
        this.guardReasoning(value);
        this.reasoning += value;
        if (value) out.push({ type: "delta", reasoningDelta: value });
      }
    }
    if (fragment.tool_calls !== undefined) {
      if (!Array.isArray(fragment.tool_calls))
        throw new Error("LLM tool stream tool_calls must be an array");
      for (const rawPiece of fragment.tool_calls) this.ingestTool(rawPiece, out);
    }
    if (this.byteCount > 8 * 1024 * 1024)
      throw new Error("LLM stream exceeded the 8 MiB response bound");
    if (choice.finish_reason != null) {
      if (typeof choice.finish_reason !== "string")
        throw new Error("LLM finish_reason must be a string");
      this.finishReason = choice.finish_reason;
    }
    return out;
  }

  private ingestTool(raw: unknown, out: ChatWithToolsEvent[]): void {
    if (
      !isRecord(raw) ||
      typeof raw.index !== "number" ||
      !Number.isSafeInteger(raw.index) ||
      raw.index < 0 ||
      raw.index >= 64
    )
      throw new Error("LLM tool stream call index is invalid");
    if (raw.type !== undefined && raw.type !== "function")
      throw new Error("LLM tool stream call type is invalid");
    if (raw.function !== undefined && !isRecord(raw.function))
      throw new Error("LLM tool stream function must be an object");
    let call = this.calls.get(raw.index);
    if (!call) {
      call = {
        id: "",
        name: "",
        argsJson: "",
        guardArguments: createBearerTokenStreamGuard(this.apiKey, "LLM tool call arguments"),
      };
      this.calls.set(raw.index, call);
    }
    if (raw.id !== undefined) {
      if (typeof raw.id !== "string" || !raw.id.trim() || raw.id.trim() !== raw.id)
        throw new Error("LLM tool stream id is invalid");
      if (call.id && call.id !== raw.id)
        throw new Error("LLM tool stream changed the id for tool call index");
      call.id = raw.id;
    }
    const fn = raw.function;
    if (isRecord(fn)) {
      if (fn.name !== undefined) {
        if (typeof fn.name !== "string") throw new Error("LLM tool name must be a string");
        // OpenAI delta fields are fragments. A full repeated name is idempotent.
        if (fn.name !== call.name) call.name += fn.name;
      }
      if (fn.arguments !== undefined) {
        if (typeof fn.arguments !== "string")
          throw new Error("LLM tool call arguments must be a string");
        call.guardArguments(fn.arguments);
        call.argsJson += fn.arguments;
        this.byteCount += fn.arguments.length;
      }
    }
    out.push({
      type: "delta",
      toolCallDelta: { id: call.id, name: call.name, argsJson: call.argsJson },
    });
  }

  complete(): ChatWithToolsEvent[] {
    if (this.completed) throw new Error("LLM tool stream ended more than once");
    this.completed = true;
    const result = this.finalize();
    return result.content ? [{ type: "delta", contentDelta: result.content }] : [];
  }

  fail(cancelled: boolean): void {
    this.report({
      ...completionMetadata(this.finishReason, this.usage),
      state: cancelled ? "cancelled" : "incomplete",
    });
  }

  private report(metadata: CompletionMetadata): void {
    if (this.reported) return;
    this.reported = true;
    this.onCompletion?.(metadata);
  }

  finalize(): ChatWithToolsResult {
    if (this.resultValue) return this.resultValue;
    if (!this.completed) throw new Error("LLM tool stream result requested before [DONE]");
    const metadata = completionMetadata(this.finishReason, this.usage);
    const content = stripThinkTags(this.content);
    const finalMetadata =
      metadata.state === "complete" && !content && !this.calls.size
        ? { ...metadata, state: "incomplete" as const }
        : metadata;
    this.report(finalMetadata);
    requireComplete(finalMetadata, content, this.calls.size);
    const ids = new Set<string>();
    const toolCalls: ChatWithToolsToolCall[] = [];
    const ordered = [...this.calls].sort(([a], [b]) => a - b);
    for (const [position, [index, entry]] of ordered.entries()) {
      if (index !== position || !entry.id || !/^[a-zA-Z0-9_.-]{1,128}$/.test(entry.name))
        throw new Error("LLM tool stream contains an incomplete call");
      if (ids.has(entry.id)) throw new Error("LLM tool stream contains duplicate tool call ids");
      ids.add(entry.id);
      const args = parseToolArguments(entry.argsJson);
      assertBearerTokenAbsent(args, this.apiKey, "LLM tool arguments");
      toolCalls.push({ id: entry.id, name: entry.name, args });
    }
    this.resultValue = {
      content,
      reasoningContent: this.reasoning,
      toolCalls,
      completion: finalMetadata,
    };
    return this.resultValue;
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LLM tool call arguments are invalid JSON");
  }
  if (!isRecord(parsed)) throw new Error("LLM tool call arguments must decode to an object");
  return parsed;
}

/** Consume complete SSE events, not individual data lines. Metadata and keepalive
 * fields are valid SSE; only data is interpreted as an OpenAI response envelope. */
async function* iterateToolEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  aggregator: ToolStreamAggregator,
): AsyncIterable<ChatWithToolsEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let eventBytes = 0;
  let ended = false;
  const abort = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length + eventBytes > 8 * 1024 * 1024)
        throw new Error("LLM SSE frame exceeded the response bound");
      for (;;) {
        const newline = buffer.search(/[\r\n]/);
        if (newline < 0) break;
        // A CR at a network boundary may be the first byte of CRLF.
        if (!done && buffer[newline] === "\r" && newline === buffer.length - 1) break;
        const line = buffer.slice(0, newline);
        const delimiter = buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(newline + delimiter);
        if (line !== "") {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          if (field !== "data") continue;
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          data.push(value);
          eventBytes += value.length + 1;
          continue;
        }
        if (!data.length) continue;
        const payload = data.join("\n");
        data = [];
        eventBytes = 0;
        if (payload.trim() === "[DONE]") {
          if (buffer.trim()) throw new Error("LLM stream continued after [DONE]");
          for (const event of aggregator.complete()) yield event;
          ended = true;
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(payload);
        } catch {
          throw new Error("LLM stream contained invalid JSON");
        }
        for (const event of aggregator.ingest(raw)) yield event;
      }
      if (done) break;
    }
    if (buffer.trim() || data.length)
      throw new Error("LLM stream ended with an incomplete SSE frame");
    throw new Error("LLM stream ended before [DONE]");
  } finally {
    if (!ended) aggregator.fail(signal.aborted);
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
