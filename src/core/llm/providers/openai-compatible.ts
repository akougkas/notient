/**
 * OpenAI-Compatible Provider
 *
 * Base provider for any OpenAI-compatible API (LM Studio, Ollama, vLLM, etc.)
 * Contains ONLY HTTP/streaming logic - NO Notient-specific code.
 *
 * This is a thin wrapper that handles:
 * - HTTP requests to /v1/chat/completions
 * - Streaming SSE parsing
 * - Error handling
 */

import { LLM_PROMPTS } from "../../constants";
import type { LLMProvider } from "../provider";
import type { ChatMessage, CompletionOptions, RankedResult, RerankCandidate } from "../types";

/**
 * Base provider for OpenAI-compatible APIs
 */
export class OpenAICompatibleProvider implements LLMProvider {
  protected disposed = false;
  protected initialized = false;
  protected initializationPromise: Promise<void> | null = null;

  constructor(
    protected baseUrl: string,
    protected model: string,
    public readonly name: string = "openai-compatible",
  ) {}

  get isReady(): boolean {
    return this.initialized && !this.disposed;
  }

  async initialize(): Promise<void> {
    // Return early if already disposed
    if (this.disposed) return;

    // Prevent race condition: if already initializing, wait for that promise
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // If already initialized, return immediately
    if (this.initialized) return;

    // Create initialization promise to prevent concurrent initialization
    this.initializationPromise = this.doInitialize();

    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    if (!this.baseUrl || !this.model) {
      throw new Error(`${this.name} not configured: missing baseUrl or model`);
    }

    // Verify connectivity by listing models
    await this.listModels();

    // Check disposed state again after async operation
    if (this.disposed) return;

    // Verify model is actually loaded by doing a minimal test completion
    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(30000), // 30s timeout for init test
      });

      // Check disposed state after fetch
      if (this.disposed) return;

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        // Check for "no models loaded" error specifically
        if (errorText.includes("No models loaded")) {
          throw new Error(
            `${this.name}: Model '${this.model}' exists but is not loaded. Please load the model in LM Studio.`,
          );
        }
        throw new Error(`${this.name} model not available: ${response.status}`);
      }
    } catch (error) {
      // Re-throw with clearer message
      if (error instanceof Error && error.message.includes("not loaded")) {
        throw error;
      }
      console.warn(`[${this.name}] Model verification failed:`, error);
      throw new Error(`${this.name}: Cannot use model '${this.model}'. Is it loaded in LM Studio?`);
    }

    // Final disposed check before marking initialized
    if (this.disposed) return;

    this.initialized = true;
    console.log(`[${this.name}] Initialized with model=${this.model}`);
  }

  dispose(): void {
    this.disposed = true;
    this.initialized = false;
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(15000), // 15s timeout
    });
    if (!response.ok) {
      throw new Error(`${this.name} API error: ${response.status}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error(`${this.name}: Invalid JSON response from /v1/models`);
    }

    // Validate response structure
    if (
      !data ||
      typeof data !== "object" ||
      !("data" in data) ||
      !Array.isArray((data as { data: unknown }).data)
    ) {
      throw new Error(`${this.name}: Malformed response from /v1/models - expected {data: [...]}`);
    }

    return (data as { data: Array<{ id?: string }> }).data
      .filter((m): m is { id: string } => typeof m?.id === "string")
      .map((m) => m.id);
  }

  async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string> {
    if (this.disposed || !this.initialized) {
      throw new Error(`${this.name} not initialized`);
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 1500,
        stop: options?.stopSequences,
      }),
      signal: AbortSignal.timeout(120000), // 2min timeout for completions
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      console.error(`[${this.name}] Completion error:`, response.status, errorText);
      throw new Error(`${this.name} completion error: ${response.status}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;

    // Support both regular content and reasoning_content (for thinking models)
    let content = message?.content || "";
    const reasoning = message?.reasoning_content || "";

    // Thinking models (DeepSeek R1, Falcon H1R, Qwen QwQ) put answer in content
    // and reasoning in reasoning_content. If content is empty, the model failed
    // to produce output - try to salvage from reasoning.
    if (!content && reasoning) {
      // Strip <think> tags first, then look for JSON
      const strippedReasoning = reasoning.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

      // Try to find JSON in the stripped reasoning
      const jsonMatch = strippedReasoning.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) {
        content = jsonMatch[0];
        console.log(`[${this.name}] Extracted JSON from reasoning_content`);
      } else if (strippedReasoning.length > 0) {
        // No JSON but have text - use it (might be prose response)
        content = strippedReasoning;
        console.log(`[${this.name}] Using reasoning_content text (no JSON found)`);
      } else {
        // Only had thinking tags, no actual output
        console.warn(`[${this.name}] Model only produced <think> content, no answer`);
        content = reasoning; // Return raw for debugging
      }
    }

    // Also strip <think> tags from content itself (some models include it there)
    if (content.includes("<think>")) {
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    }

    if (!content) {
      console.warn(`[${this.name}] Empty response from model`);
    }

    return content;
  }

  async *stream(
    messages: ChatMessage[],
    options?: CompletionOptions,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    // Capture disposed state at start to detect mid-stream disposal
    if (this.disposed || !this.initialized) {
      throw new Error(`${this.name} not initialized`);
    }

    // Check if already aborted before starting
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // Create a combined abort signal with default 5-minute timeout for streaming
    // This protects against LLM hangs while allowing long responses
    const STREAM_TIMEOUT_MS = 300000; // 5 minutes
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort(new Error("LLM stream timeout after 5 minutes"));
    }, STREAM_TIMEOUT_MS);

    // If caller provided a signal, abort our timeout controller when it aborts
    if (signal) {
      signal.addEventListener("abort", () => timeoutController.abort(signal.reason), {
        once: true,
      });
    }

    const effectiveSignal = timeoutController.signal;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? 1500,
          stop: options?.stopSequences,
          stream: true,
        }),
        signal: effectiveSignal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      // Handle fetch errors (network, abort, etc.)
      if ((error as Error).name === "AbortError") {
        throw new DOMException("Aborted", "AbortError");
      }
      throw error;
    }

    // Check disposed state after fetch completes
    if (this.disposed) {
      clearTimeout(timeoutId);
      throw new Error(`${this.name} disposed during request`);
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      throw new Error(`${this.name} stream error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      clearTimeout(timeoutId);
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    // Track reasoning state for models that use separate reasoning_content field
    let inReasoningBlock = false;

    try {
      while (true) {
        // Check abort status before each read (includes timeout)
        if (effectiveSignal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        const { done, value } = await reader.read();
        if (done) {
          // Close reasoning block if stream ends while reasoning
          if (inReasoningBlock) {
            yield "</think>";
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE format
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
              // Close reasoning block if stream ends while reasoning
              if (inReasoningBlock) {
                yield "</think>";
              }
              return;
            }

            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta;
              const reasoning = delta?.reasoning_content;
              const content = delta?.content;

              // Handle reasoning_content (thinking models like DeepSeek R1, LM Studio thinking)
              if (reasoning) {
                if (!inReasoningBlock) {
                  // Start thinking block
                  yield "<think>";
                  inReasoningBlock = true;
                }
                yield reasoning;
              }

              // Handle regular content
              if (content) {
                if (inReasoningBlock) {
                  // End thinking block before content starts
                  yield "</think>";
                  inReasoningBlock = false;
                }
                yield content;
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
      reader.releaseLock();
    }
  }

  /**
   * Rerank search results using LLM
   */
  async rerank(query: string, candidates: RerankCandidate[]): Promise<RankedResult[]> {
    if (this.disposed || !this.initialized) {
      // Return original order if service unavailable
      return this.fallbackToVectorScores(candidates);
    }

    if (candidates.length === 0) return [];

    // Limit candidates for efficient reranking
    const topCandidates = candidates.slice(0, 10);
    const prompt = this.buildRerankPrompt(query, topCandidates);

    try {
      const response = await this.complete(
        [
          { role: "system", content: LLM_PROMPTS.RERANK_SYSTEM },
          { role: "user", content: prompt },
        ],
        { temperature: 0.3, maxTokens: 500 },
      );

      if (!response || response.trim().length < 10) {
        console.warn(`[${this.name}] Empty rerank response, using vector scores`);
        return this.fallbackToVectorScores(topCandidates);
      }

      return this.parseRerankResponse(response, topCandidates);
    } catch (error) {
      console.error(`[${this.name}] Rerank failed:`, error);
      return this.fallbackToVectorScores(topCandidates);
    }
  }

  /**
   * Fallback to vector similarity scores
   */
  protected fallbackToVectorScores(candidates: RerankCandidate[]): RankedResult[] {
    return candidates.map((c) => ({
      noteId: c.noteId,
      path: c.path,
      title: c.title,
      score: c.originalScore,
      reasoning: "Vector similarity",
    }));
  }

  /**
   * Build prompt for reranking
   */
  protected buildRerankPrompt(query: string, candidates: RerankCandidate[]): string {
    const candidateList = candidates
      .map((c, i) => {
        const preview = c.text.slice(0, 150).replace(/\n/g, " ").trim();
        return `[${i}] ${c.title}: ${preview}`;
      })
      .join("\n");

    return `Query: "${query}"

${candidateList}

Return JSON with rankings array. Example: {"rankings":[{"index":0,"score":90,"reason":"best match"}]}`;
  }

  /**
   * Parse LLM reranking response
   */
  protected parseRerankResponse(response: string, candidates: RerankCandidate[]): RankedResult[] {
    try {
      let jsonStr = response.trim();

      // Remove markdown code blocks
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      // Try to find JSON object in response
      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        jsonStr = objectMatch[0];
      } else {
        console.warn(`[${this.name}] No JSON object found in rerank response`);
        return this.fallbackToVectorScores(candidates);
      }

      // Try to parse - handle incomplete JSON
      let parsed: { rankings?: Array<{ index: number; score: number; reason?: string }> };
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        const fixedJson = this.tryFixIncompleteJson(jsonStr);
        if (fixedJson) {
          parsed = JSON.parse(fixedJson);
        } else {
          throw new Error("Cannot parse JSON");
        }
      }

      if (!parsed.rankings || !Array.isArray(parsed.rankings)) {
        console.warn(`[${this.name}] No rankings array in response`);
        return this.fallbackToVectorScores(candidates);
      }

      // Map rankings back to candidates
      const results: RankedResult[] = [];
      for (const ranking of parsed.rankings) {
        const idx =
          typeof ranking.index === "number"
            ? ranking.index
            : Number.parseInt(String(ranking.index), 10);
        const score =
          typeof ranking.score === "number"
            ? ranking.score
            : Number.parseInt(String(ranking.score), 10);

        if (Number.isNaN(idx) || Number.isNaN(score)) continue;

        const candidate = candidates[idx];
        if (candidate && score >= 30) {
          results.push({
            noteId: candidate.noteId,
            path: candidate.path,
            title: candidate.title,
            score: score / 100, // Normalize to 0-1
            reasoning: ranking.reason || "Relevant",
          });
        }
      }

      if (results.length === 0) {
        console.warn(`[${this.name}] No valid rankings extracted`);
        return this.fallbackToVectorScores(candidates);
      }

      results.sort((a, b) => b.score - a.score);
      console.log(`[${this.name}] Reranked ${results.length} results`);
      return results;
    } catch (error) {
      console.warn(`[${this.name}] Failed to parse rerank response:`, error);
      return this.fallbackToVectorScores(candidates);
    }
  }

  /**
   * Try to fix incomplete JSON (missing closing brackets)
   * Uses a stack-based approach to properly close nested structures
   */
  protected tryFixIncompleteJson(jsonStr: string): string | null {
    try {
      // Track nesting with a stack to handle proper order
      const stack: string[] = [];
      let inString = false;
      let escapeNext = false;

      for (const char of jsonStr) {
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (char === "\\") {
          escapeNext = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;

        if (char === "{") stack.push("}");
        else if (char === "[") stack.push("]");
        else if (char === "}" || char === "]") {
          if (stack.length > 0 && stack[stack.length - 1] === char) {
            stack.pop();
          }
        }
      }

      // Close any unclosed structures in reverse order
      let fixed = jsonStr.trimEnd();
      // Remove trailing comma if present
      if (fixed.endsWith(",")) {
        fixed = fixed.slice(0, -1);
      }
      // Add missing closing brackets/braces in correct order
      while (stack.length > 0) {
        fixed += stack.pop();
      }

      JSON.parse(fixed);
      return fixed;
    } catch {
      return null;
    }
  }
}
