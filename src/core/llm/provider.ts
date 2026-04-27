export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type ChatContent = string | Array<ChatTextPart | ChatImagePart>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Qwen3 / Nemotron-Cascade thinking toggle. When false, the request body
   * carries `chat_template_kwargs: { enable_thinking: false }` so llama-server's
   * jinja template skips the chain-of-thought preamble. Indexer extraction and
   * structured-output reranking pass false; chat / co-author / agents leave it
   * undefined to keep reasoning available.
   */
  enableThinking?: boolean;
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
  /** See {@link ChatOptions.enableThinking}. */
  enableThinking?: boolean;
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

export interface ChatVisionRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatVisionResult {
  content: string;
  durationMs: number;
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
  /**
   * OpenAI-compatible vision request. Posts multipart `messages[].content`
   * (a mix of `ChatTextPart` and `ChatImagePart`) and returns the assistant
   * string. Optional so non-vision providers and test fakes stay assignable.
   * The visionProbe in src/agent/visionProbe.ts uses presence-checks before
   * attempting the call.
   */
  chatVision?(request: ChatVisionRequest): Promise<ChatVisionResult>;
}
