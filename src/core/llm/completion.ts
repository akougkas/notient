/** Provider accounting is kept verbatim; absent breakdowns are never inferred as visible text. */
export interface TokenUsage {
  source: "provider" | "unavailable";
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  visibleAnswerTokens: number | null;
  /** Derived aggregate remainder; may also contain tool arguments or other output. */
  nonReasoningCompletionTokens: number | null;
}

export interface CompletionMetadata {
  finishReason: string | null;
  state: "complete" | "truncated" | "incomplete" | "filtered" | "cancelled";
  usage: TokenUsage;
}

export class IncompleteCompletionError extends Error {
  constructor(
    message: string,
    readonly completion: CompletionMetadata,
  ) {
    super(message);
    this.name = "IncompleteCompletionError";
  }
}

export function decodeUsage(raw: unknown): TokenUsage {
  if (raw === undefined || raw === null)
    return {
      source: "unavailable",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      reasoningTokens: null,
      visibleAnswerTokens: null,
      nonReasoningCompletionTokens: null,
    };
  if (!record(raw)) throw new Error("LLM usage must be an object");
  const details = raw.completion_tokens_details;
  if (details !== undefined && details !== null && !record(details)) {
    throw new Error("LLM completion token details must be an object");
  }
  const completionTokens = count(raw.completion_tokens);
  const reasoningTokens = count(record(details) ? details.reasoning_tokens : undefined);
  if (completionTokens !== null && reasoningTokens !== null && reasoningTokens > completionTokens) {
    throw new Error("LLM reasoning usage exceeds aggregate completion usage");
  }
  return {
    source: "provider",
    promptTokens: count(raw.prompt_tokens),
    completionTokens,
    totalTokens: count(raw.total_tokens),
    reasoningTokens,
    visibleAnswerTokens: count(record(details) ? details.text_tokens : undefined),
    nonReasoningCompletionTokens:
      completionTokens !== null && reasoningTokens !== null
        ? completionTokens - reasoningTokens
        : null,
  };
}

export function completionMetadata(
  finishReason: string | null,
  usage: TokenUsage,
): CompletionMetadata {
  return {
    finishReason,
    usage,
    state:
      finishReason === "stop" || finishReason === "tool_calls"
        ? "complete"
        : finishReason === "length"
          ? "truncated"
          : finishReason === "content_filter"
            ? "filtered"
            : "incomplete",
  };
}

export function requireComplete(
  metadata: CompletionMetadata,
  content: string,
  toolCount = 0,
): void {
  if (metadata.state !== "complete") {
    throw new IncompleteCompletionError(
      `LLM response ${metadata.state} (finish_reason=${metadata.finishReason ?? "unavailable"})`,
      metadata,
    );
  }
  if (toolCount === 0 && content.trim().length === 0) {
    throw new IncompleteCompletionError(
      "LLM returned no visible answer or tool calls (reasoning-only or empty response)",
      { ...metadata, state: "incomplete" },
    );
  }
  if (toolCount > 0 !== (metadata.finishReason === "tool_calls")) {
    throw new IncompleteCompletionError("LLM tool calls do not match finish_reason", {
      ...metadata,
      state: "incomplete",
    });
  }
}

function count(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)
    throw new Error("LLM token count is invalid");
  return raw;
}
function record(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
