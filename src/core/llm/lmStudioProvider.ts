import type { ChatMessage, ChatOptions, EmbedOptions, LLMProvider } from "./provider";

export interface ProviderConfig {
  baseUrl: string;
}

interface ChatCompletionResponse {
  choices: { message: { content: string } }[];
}

interface ChatStreamEvent {
  choices: { delta?: { content?: string } }[];
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
    yield* iterateSseDeltas(response.body);
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
}

function parseSseLine(line: string): string | "[DONE]" | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return "[DONE]";
  try {
    const event = JSON.parse(payload) as ChatStreamEvent;
    return event.choices[0]?.delta?.content ?? null;
  } catch {
    return null;
  }
}

async function* iterateSseDeltas(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      const delta = parseSseLine(line);
      if (delta === "[DONE]") return;
      if (delta) yield delta;
    }
  }
}
