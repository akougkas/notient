/**
 * LM Studio SDK Provider
 *
 * Native SDK-based provider for LM Studio.
 * Uses @lmstudio/sdk for proper async handling and better error messages.
 *
 * Key differences from REST API approach:
 * - WebSocket connection (ws://) instead of HTTP
 * - Native streaming with proper backpressure
 * - Built-in reasoning content parsing
 * - Structured output via SDK's structured option
 */

import { type LLMDynamicHandle, LMStudioClient } from "@lmstudio/sdk";
import { LLM_PROMPTS } from "../../constants";
import type { LLMProvider } from "../provider";
import type { ChatMessage, CompletionOptions, RankedResult, RerankCandidate } from "../types";

/**
 * LM Studio SDK-based provider
 *
 * Uses native TypeScript SDK instead of REST API for:
 * - Better async handling
 * - Proper streaming with backpressure
 * - Built-in reasoning content support
 * - More reliable abort/cancellation
 */
export class LMStudioSDKProvider implements LLMProvider {
  readonly name = "lmstudio-sdk";

  private client: LMStudioClient | null = null;
  private llmModel: LLMDynamicHandle | null = null;
  private disposed = false;
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    private baseUrl: string,
    private modelIdentifier: string,
  ) {}

  /** Current model identifier (for LLMProvider interface) */
  get model(): string {
    return this.modelIdentifier;
  }

  get isReady(): boolean {
    const ready = this.initialized && !this.disposed;
    return ready;
  }

  async initialize(): Promise<void> {
    if (this.disposed) {
      return;
    }

    // Prevent race condition: if already initializing, wait for that promise
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    if (this.initialized) {
      return;
    }

    this.initializationPromise = this.doInitialize();

    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    if (!this.baseUrl || !this.modelIdentifier) {
      throw new Error(`${this.name} not configured: missing baseUrl or model`);
    }

    // Convert HTTP URL to WebSocket URL for SDK
    // LM Studio SDK uses ws:// protocol
    const wsUrl = this.baseUrl.replace(/^https?:\/\//, "ws://").replace(/\/v1\/?$/, ""); // Remove /v1 suffix if present

    console.log(`[${this.name}] Connecting to ${wsUrl}...`);

    try {
      this.client = new LMStudioClient({ baseUrl: wsUrl });

      // Get handle to the loaded model
      // Use model() which gets the currently loaded model or waits for one
      this.llmModel = this.client.llm.createDynamicHandle(this.modelIdentifier);

      // Verify model is accessible with a minimal test
      console.log(`[${this.name}] Testing model connection...`);
      const testResult = await this.llmModel.complete("hi", { maxTokens: 1 });
      await testResult; // Wait for completion

      if (this.disposed) {
        return;
      }

      this.initialized = true;
      console.log(`[${this.name}] Initialized with model=${this.modelIdentifier}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Provide helpful error messages
      if (errorMessage.includes("ECONNREFUSED") || errorMessage.includes("connect")) {
        throw new Error(
          `${this.name}: Cannot connect to LM Studio at ${wsUrl}. Is LM Studio running with Developer Mode enabled?`,
        );
      }
      if (errorMessage.includes("not found") || errorMessage.includes("no model")) {
        throw new Error(
          `${this.name}: Model '${this.modelIdentifier}' not found. Is it loaded in LM Studio?`,
        );
      }

      throw new Error(`${this.name}: Initialization failed - ${errorMessage}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.initialized = false;
    // SDK client cleanup
    this.client = null;
    this.llmModel = null;
  }

  async listModels(): Promise<string[]> {
    if (!this.client) {
      throw new Error(`${this.name} not initialized`);
    }

    try {
      const models = await this.client.llm.listLoaded();
      const result = models.map((m) => m.identifier);
      return result;
    } catch (error) {
      console.error(`[${this.name}] Failed to list models:`, error);
      return [];
    }
  }

  async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string> {
    const startTime = Date.now();
    console.log(`[LMStudioSDK] complete START: ${messages.length} messages`);
    if (this.disposed || !this.initialized || !this.llmModel) {
      throw new Error(`${this.name} not initialized`);
    }

    const chat = this.convertToChatFormat(messages);
    const opts = this.buildCompletionOptions(options);

    try {
      const result = await this.llmModel.respond(chat, opts);
      const content = result.content || "";
      const reasoning = result.reasoningContent || "";
      const isStructuredOutput = options?.responseFormat?.type === "json_schema";

      const response = this.extractCompletionResponse(content, reasoning, isStructuredOutput);
      // Estimate token count (rough: ~4 chars per token)
      const tokenCount = Math.ceil((content.length + reasoning.length) / 4);
      const duration = Date.now() - startTime;
      console.log(`[LMStudioSDK] complete END: ${tokenCount} tokens, ${duration}ms`);
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[${this.name}] Completion error:`, errorMessage);
      throw new Error(`${this.name} completion error: ${errorMessage}`);
    }
  }

  private convertToChatFormat(
    messages: ChatMessage[],
  ): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const result = messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));
    return result;
  }

  private buildCompletionOptions(
    options?: CompletionOptions,
  ): Parameters<LLMDynamicHandle["respond"]>[1] {
    const opts: Parameters<LLMDynamicHandle["respond"]>[1] = {
      temperature: options?.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? 1500,
      stopStrings: options?.stopSequences,
    };

    if (options?.responseFormat?.type === "json_schema") {
      const schema = options.responseFormat.json_schema;
      opts.structured = { type: "json", jsonSchema: schema.schema };
      console.log(`[${this.name}] Using structured output: ${schema.name}`);
    } else if (options?.responseFormat?.type === "json_object") {
      opts.structured = { type: "json" };
    }

    return opts;
  }

  private extractCompletionResponse(
    content: string,
    reasoning: string,
    isStructuredOutput: boolean,
  ): string {
    if (isStructuredOutput) {
      if (content && content.trim()) {
        console.log(`[${this.name}] Structured output received (${content.length} chars)`);
        return content;
      }
      // Fallback: try extracting from reasoning
      if (reasoning) {
        console.warn(`[${this.name}] Structured output empty, extracting from reasoning`);
        const extracted = this.extractFromReasoning(reasoning);
        if (extracted) return extracted;
      }
      console.warn(`[${this.name}] Structured output empty and no reasoning fallback`);
      return content; // Return empty, let caller handle
    }

    if (content) {
      return content;
    }

    if (reasoning) {
      const result = this.extractFromReasoning(reasoning);
      return result;
    }

    console.warn(`[${this.name}] Empty response from model`);
    return "";
  }

  private extractFromReasoning(reasoning: string): string {
    console.log(`[${this.name}] Using reasoning content (no content field)`);

    const jsonMatch = reasoning.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        JSON.parse(jsonMatch[0]);
        return jsonMatch[0];
      } catch {
        // Not valid JSON, continue
      }
    }

    const withoutThinkTags = reasoning.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return withoutThinkTags || reasoning;
  }

  async *stream(
    messages: ChatMessage[],
    options?: CompletionOptions,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    this.assertReady();
    this.checkAborted(signal);

    const chat = this.convertToChatFormat(messages);
    const opts = this.buildStreamOptions(options);

    try {
      yield* this.streamWithReasoningTracking(chat, opts, signal);
    } catch (error) {
      this.handleStreamError(error);
    }
  }

  private buildStreamOptions(
    options?: CompletionOptions,
  ): Parameters<LLMDynamicHandle["respond"]>[1] {
    const result = {
      temperature: options?.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? 1500,
      stopStrings: options?.stopSequences,
    };
    return result;
  }

  private async *streamWithReasoningTracking(
    chat: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    opts: Parameters<LLMDynamicHandle["respond"]>[1],
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    if (!this.llmModel) {
      throw new Error(`${this.name} not initialized`);
    }
    const prediction = this.llmModel.respond(chat, opts);
    const reasoningState = { inBlock: false };
    let fragmentCount = 0;

    for await (const fragment of prediction) {
      fragmentCount++;
      this.checkAborted(signal);
      yield* this.processReasoningFragment(fragment, reasoningState);
    }

    if (reasoningState.inBlock) {
      yield "</think>";
    }
  }

  private assertReady(): void {
    if (this.disposed || !this.initialized || !this.llmModel) {
      throw new Error(`${this.name} not initialized`);
    }
  }

  private checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  }

  private handleStreamError(error: unknown): never {
    if ((error as Error).name === "AbortError") {
      throw new DOMException("Aborted", "AbortError");
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${this.name}] Stream error:`, errorMessage);
    throw new Error(`${this.name} stream error: ${errorMessage}`);
  }

  private processReasoningFragment(
    fragment: { reasoningType?: string; content: string },
    state: { inBlock: boolean },
  ): string[] {
    const tokens: string[] = [];
    const { reasoningType, content } = fragment;

    switch (reasoningType) {
      case "reasoningStartTag":
        tokens.push("<think>");
        state.inBlock = true;
        break;

      case "reasoningEndTag":
        tokens.push("</think>");
        state.inBlock = false;
        break;

      case "reasoning":
        if (!state.inBlock) {
          tokens.push("<think>");
          state.inBlock = true;
        }
        tokens.push(content);
        break;

      default:
        if (state.inBlock) {
          tokens.push("</think>");
          state.inBlock = false;
        }
        tokens.push(content);
        break;
    }

    return tokens;
  }

  /**
   * Rerank search results using LLM
   */
  async rerank(query: string, candidates: RerankCandidate[]): Promise<RankedResult[]> {
    if (this.disposed || !this.initialized) {
      return this.fallbackToVectorScores(candidates);
    }

    if (candidates.length === 0) {
      return [];
    }

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

      const result = this.parseRerankResponse(response, topCandidates);
      return result;
    } catch (error) {
      console.error(`[${this.name}] Rerank failed:`, error);
      return this.fallbackToVectorScores(topCandidates);
    }
  }

  private fallbackToVectorScores(candidates: RerankCandidate[]): RankedResult[] {
    const result = candidates.map((c) => ({
      noteId: c.noteId,
      path: c.path,
      title: c.title,
      score: c.originalScore,
      reasoning: "Vector similarity",
    }));
    return result;
  }

  private buildRerankPrompt(query: string, candidates: RerankCandidate[]): string {
    const candidateList = candidates
      .map((c, i) => {
        const preview = c.text.slice(0, 150).replace(/\n/g, " ").trim();
        return `[${i}] ${c.title}: ${preview}`;
      })
      .join("\n");

    const result = `Query: "${query}"

${candidateList}

Return JSON with rankings array. Example: {"rankings":[{"index":0,"score":90,"reason":"best match"}]}`;
    return result;
  }

  private parseRerankResponse(response: string, candidates: RerankCandidate[]): RankedResult[] {
    try {
      const jsonStr = this.extractJsonFromResponse(response);
      if (!jsonStr) {
        console.warn(`[${this.name}] No JSON object found in rerank response`);
        return this.fallbackToVectorScores(candidates);
      }

      const parsed = JSON.parse(jsonStr) as {
        rankings?: Array<{ index: number; score: number; reason?: string }>;
      };

      if (!parsed.rankings || !Array.isArray(parsed.rankings)) {
        console.warn(`[${this.name}] No rankings array in response`);
        return this.fallbackToVectorScores(candidates);
      }

      const results = this.buildRankedResults(parsed.rankings, candidates);

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

  private extractJsonFromResponse(response: string): string | null {
    const cleaned = this.cleanLlmResponse(response);
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objectMatch) {
      return null;
    }

    return this.tryParseJson(objectMatch[0]);
  }

  private cleanLlmResponse(response: string): string {
    let result = response.trim();

    // Strip <think>...</think> tags (reasoning models)
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    // Remove markdown code blocks
    const codeBlockMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      result = codeBlockMatch[1].trim();
    }

    return result;
  }

  private tryParseJson(candidate: string): string | null {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      return this.tryTruncatedJson(candidate);
    }
  }

  private tryTruncatedJson(candidate: string): string | null {
    const lines = candidate.split("\n");
    let bracketCount = 0;

    for (let i = 0; i < lines.length; i++) {
      for (const char of lines[i]) {
        if (char === "{") bracketCount++;
        else if (char === "}") bracketCount--;
      }

      if (bracketCount === 0) {
        const trimmed = lines.slice(0, i + 1).join("\n");
        try {
          JSON.parse(trimmed);
          return trimmed;
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  private buildRankedResults(
    rankings: Array<{ index: number; score: number; reason?: string }>,
    candidates: RerankCandidate[],
  ): RankedResult[] {
    const results: RankedResult[] = [];

    for (const ranking of rankings) {
      const result = this.parseRankingEntry(ranking, candidates);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  private parseRankingEntry(
    ranking: { index: number; score: number; reason?: string },
    candidates: RerankCandidate[],
  ): RankedResult | null {
    const idx =
      typeof ranking.index === "number"
        ? ranking.index
        : Number.parseInt(String(ranking.index), 10);
    const score =
      typeof ranking.score === "number"
        ? ranking.score
        : Number.parseInt(String(ranking.score), 10);

    if (Number.isNaN(idx) || Number.isNaN(score)) {
      return null;
    }

    const candidate = candidates[idx];
    if (!candidate || score < 30) {
      return null;
    }

    return {
      noteId: candidate.noteId,
      path: candidate.path,
      title: candidate.title,
      score: score / 100,
      reasoning: ranking.reason || "Relevant",
    };
  }
}
