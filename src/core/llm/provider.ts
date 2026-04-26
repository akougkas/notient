export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface EmbedOptions {
  model: string;
  signal?: AbortSignal;
}

export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export class ChatJsonParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "ChatJsonParseError";
  }
}

export interface LLMProvider {
  isAvailable(signal?: AbortSignal): Promise<boolean>;
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string>;
  chatJson<T>(messages: ChatMessage[], opts: ChatOptions, schema: JsonSchema): Promise<T>;
  embed(input: string[], opts: EmbedOptions): Promise<number[][]>;
}
