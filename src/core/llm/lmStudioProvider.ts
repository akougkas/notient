import {
  ChatJsonParseError,
  type ChatMessage,
  type ChatOptions,
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
    const text = delta?.content ?? delta?.reasoning_content ?? null;
    return text && text.length > 0 ? text : null;
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
