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

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatToolCallDelta {
  id: string;
  name: string;
  argsJson: string;
}

export interface ChatWithToolsRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  toolChoice?: "auto" | "required" | "none";
  signal: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatWithToolsEvent {
  type: "delta";
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallDelta?: ChatToolCallDelta;
}

export interface ChatWithToolsToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatWithToolsResult {
  content: string;
  reasoningContent: string;
  toolCalls: ChatWithToolsToolCall[];
}

export interface ChatWithToolsHandle {
  events: AsyncIterable<ChatWithToolsEvent>;
  result: () => Promise<ChatWithToolsResult>;
}

export interface LLMProvider {
  isAvailable(signal?: AbortSignal): Promise<boolean>;
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string>;
  chatJson<T>(messages: ChatMessage[], opts: ChatOptions, schema: JsonSchema): Promise<T>;
  embed(input: string[], opts: EmbedOptions): Promise<number[][]>;
  /**
   * OpenAI-compatible tool-calling streaming entry point. Optional in the
   * interface so existing test fakes (which never call tools) compile without
   * stubbing it. Real providers (LMStudio) implement it; consumers that need
   * tools must check for presence or rely on the LMStudio implementation.
   */
  chatWithTools?(request: ChatWithToolsRequest): Promise<ChatWithToolsHandle>;
}
