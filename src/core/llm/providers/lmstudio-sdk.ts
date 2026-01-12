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
  ) {
    console.log("[lmstudio-sdk:constructor] TRACE: START");
    console.log(`[lmstudio-sdk:constructor] TRACE: baseUrl=${baseUrl}, model=${modelIdentifier}`);
    console.log("[lmstudio-sdk:constructor] TRACE: END");
  }

  /** Current model identifier (for LLMProvider interface) */
  get model(): string {
    console.log("[lmstudio-sdk:model] TRACE: getter called");
    return this.modelIdentifier;
  }

  get isReady(): boolean {
    console.log("[lmstudio-sdk:isReady] TRACE: getter called");
    const ready = this.initialized && !this.disposed;
    console.log(`[lmstudio-sdk:isReady] TRACE: returning ${ready}`);
    return ready;
  }

  async initialize(): Promise<void> {
    console.log("[lmstudio-sdk:initialize] TRACE: START");
    if (this.disposed) {
      console.log("[lmstudio-sdk:initialize] TRACE: disposed, returning early");
      console.log("[lmstudio-sdk:initialize] TRACE: END");
      return;
    }

    // Prevent race condition: if already initializing, wait for that promise
    if (this.initializationPromise) {
      console.log(
        "[lmstudio-sdk:initialize] TRACE: already initializing, waiting for existing promise",
      );
      console.log("[lmstudio-sdk:initialize] TRACE: END");
      return this.initializationPromise;
    }

    if (this.initialized) {
      console.log("[lmstudio-sdk:initialize] TRACE: already initialized");
      console.log("[lmstudio-sdk:initialize] TRACE: END");
      return;
    }

    console.log("[lmstudio-sdk:initialize] TRACE: calling doInitialize");
    this.initializationPromise = this.doInitialize();

    try {
      await this.initializationPromise;
      console.log("[lmstudio-sdk:initialize] TRACE: doInitialize completed");
    } finally {
      this.initializationPromise = null;
    }
    console.log("[lmstudio-sdk:initialize] TRACE: END");
  }

  private async doInitialize(): Promise<void> {
    console.log("[lmstudio-sdk:doInitialize] TRACE: START");
    if (!this.baseUrl || !this.modelIdentifier) {
      console.log("[lmstudio-sdk:doInitialize] TRACE: missing baseUrl or model");
      console.log("[lmstudio-sdk:doInitialize] TRACE: END (throwing)");
      throw new Error(`${this.name} not configured: missing baseUrl or model`);
    }

    // Convert HTTP URL to WebSocket URL for SDK
    // LM Studio SDK uses ws:// protocol
    const wsUrl = this.baseUrl.replace(/^https?:\/\//, "ws://").replace(/\/v1\/?$/, ""); // Remove /v1 suffix if present

    console.log(`[lmstudio-sdk:doInitialize] TRACE: wsUrl=${wsUrl}`);
    console.log(`[${this.name}] Connecting to ${wsUrl}...`);

    try {
      console.log("[lmstudio-sdk:doInitialize] TRACE: creating LMStudioClient");
      this.client = new LMStudioClient({ baseUrl: wsUrl });
      console.log("[lmstudio-sdk:doInitialize] TRACE: LMStudioClient created");

      // Get handle to the loaded model
      // Use model() which gets the currently loaded model or waits for one
      console.log("[lmstudio-sdk:doInitialize] TRACE: creating dynamic handle");
      this.llmModel = this.client.llm.createDynamicHandle(this.modelIdentifier);
      console.log("[lmstudio-sdk:doInitialize] TRACE: dynamic handle created");

      // Verify model is accessible with a minimal test
      console.log(`[${this.name}] Testing model connection...`);
      console.log("[lmstudio-sdk:doInitialize] TRACE: calling llmModel.complete for test");
      const testResult = await this.llmModel.complete("hi", { maxTokens: 1 });
      console.log("[lmstudio-sdk:doInitialize] TRACE: llmModel.complete returned");
      console.log("[lmstudio-sdk:doInitialize] TRACE: awaiting testResult");
      await testResult; // Wait for completion
      console.log("[lmstudio-sdk:doInitialize] TRACE: testResult awaited");

      if (this.disposed) {
        console.log("[lmstudio-sdk:doInitialize] TRACE: disposed during init");
        console.log("[lmstudio-sdk:doInitialize] TRACE: END");
        return;
      }

      this.initialized = true;
      console.log(`[${this.name}] Initialized with model=${this.modelIdentifier}`);
      console.log("[lmstudio-sdk:doInitialize] TRACE: END");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`[lmstudio-sdk:doInitialize] TRACE: error caught: ${errorMessage}`);

      // Provide helpful error messages
      if (errorMessage.includes("ECONNREFUSED") || errorMessage.includes("connect")) {
        console.log("[lmstudio-sdk:doInitialize] TRACE: END (connection error)");
        throw new Error(
          `${this.name}: Cannot connect to LM Studio at ${wsUrl}. Is LM Studio running with Developer Mode enabled?`,
        );
      }
      if (errorMessage.includes("not found") || errorMessage.includes("no model")) {
        console.log("[lmstudio-sdk:doInitialize] TRACE: END (model not found)");
        throw new Error(
          `${this.name}: Model '${this.modelIdentifier}' not found. Is it loaded in LM Studio?`,
        );
      }

      console.log("[lmstudio-sdk:doInitialize] TRACE: END (generic error)");
      throw new Error(`${this.name}: Initialization failed - ${errorMessage}`);
    }
  }

  dispose(): void {
    console.log("[lmstudio-sdk:dispose] TRACE: START");
    this.disposed = true;
    this.initialized = false;
    // SDK client cleanup
    this.client = null;
    this.llmModel = null;
    console.log("[lmstudio-sdk:dispose] TRACE: END");
  }

  async listModels(): Promise<string[]> {
    console.log("[lmstudio-sdk:listModels] TRACE: START");
    if (!this.client) {
      console.log("[lmstudio-sdk:listModels] TRACE: END (not initialized)");
      throw new Error(`${this.name} not initialized`);
    }

    try {
      console.log("[lmstudio-sdk:listModels] TRACE: calling client.llm.listLoaded");
      const models = await this.client.llm.listLoaded();
      console.log(`[lmstudio-sdk:listModels] TRACE: listLoaded returned ${models.length} models`);
      const result = models.map((m) => m.identifier);
      console.log("[lmstudio-sdk:listModels] TRACE: END");
      return result;
    } catch (error) {
      console.error(`[${this.name}] Failed to list models:`, error);
      console.log("[lmstudio-sdk:listModels] TRACE: END (error, returning [])");
      return [];
    }
  }

  async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string> {
    console.log("[lmstudio-sdk:complete] TRACE: START");
    console.log(`[lmstudio-sdk:complete] TRACE: messages.length=${messages.length}`);
    if (this.disposed || !this.initialized || !this.llmModel) {
      console.log("[lmstudio-sdk:complete] TRACE: END (not initialized)");
      throw new Error(`${this.name} not initialized`);
    }

    console.log("[lmstudio-sdk:complete] TRACE: converting chat format");
    const chat = this.convertToChatFormat(messages);
    console.log("[lmstudio-sdk:complete] TRACE: building completion options");
    const opts = this.buildCompletionOptions(options);

    try {
      console.log("[lmstudio-sdk:complete] TRACE: calling llmModel.respond");
      const result = await this.llmModel.respond(chat, opts);
      console.log("[lmstudio-sdk:complete] TRACE: llmModel.respond returned");
      const content = result.content || "";
      const reasoning = result.reasoningContent || "";
      console.log(
        `[lmstudio-sdk:complete] TRACE: content.length=${content.length}, reasoning.length=${reasoning.length}`,
      );
      const isStructuredOutput = options?.responseFormat?.type === "json_schema";

      console.log("[lmstudio-sdk:complete] TRACE: extracting response");
      const response = this.extractCompletionResponse(content, reasoning, isStructuredOutput);
      console.log(`[lmstudio-sdk:complete] TRACE: response.length=${response.length}`);
      console.log("[lmstudio-sdk:complete] TRACE: END");
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[${this.name}] Completion error:`, errorMessage);
      console.log("[lmstudio-sdk:complete] TRACE: END (error)");
      throw new Error(`${this.name} completion error: ${errorMessage}`);
    }
  }

  private convertToChatFormat(
    messages: ChatMessage[],
  ): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    console.log("[lmstudio-sdk:convertToChatFormat] TRACE: START");
    const result = messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));
    console.log(`[lmstudio-sdk:convertToChatFormat] TRACE: converted ${result.length} messages`);
    console.log("[lmstudio-sdk:convertToChatFormat] TRACE: END");
    return result;
  }

  private buildCompletionOptions(
    options?: CompletionOptions,
  ): Parameters<LLMDynamicHandle["respond"]>[1] {
    console.log("[lmstudio-sdk:buildCompletionOptions] TRACE: START");
    const opts: Parameters<LLMDynamicHandle["respond"]>[1] = {
      temperature: options?.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? 1500,
      stopStrings: options?.stopSequences,
    };
    console.log(
      `[lmstudio-sdk:buildCompletionOptions] TRACE: temp=${opts.temperature}, maxTokens=${opts.maxTokens}`,
    );

    if (options?.responseFormat?.type === "json_schema") {
      const schema = options.responseFormat.json_schema;
      opts.structured = { type: "json", jsonSchema: schema.schema };
      console.log(`[${this.name}] Using structured output: ${schema.name}`);
      console.log(
        "[lmstudio-sdk:buildCompletionOptions] TRACE: using json_schema structured output",
      );
    } else if (options?.responseFormat?.type === "json_object") {
      opts.structured = { type: "json" };
      console.log(
        "[lmstudio-sdk:buildCompletionOptions] TRACE: using json_object structured output",
      );
    }

    console.log("[lmstudio-sdk:buildCompletionOptions] TRACE: END");
    return opts;
  }

  private extractCompletionResponse(
    content: string,
    reasoning: string,
    isStructuredOutput: boolean,
  ): string {
    console.log("[lmstudio-sdk:extractCompletionResponse] TRACE: START");
    console.log(
      `[lmstudio-sdk:extractCompletionResponse] TRACE: isStructuredOutput=${isStructuredOutput}`,
    );
    if (isStructuredOutput) {
      console.log(`[${this.name}] Structured output received (${content.length} chars)`);
      console.log("[lmstudio-sdk:extractCompletionResponse] TRACE: END (structured)");
      return content;
    }

    if (content) {
      console.log("[lmstudio-sdk:extractCompletionResponse] TRACE: END (has content)");
      return content;
    }

    if (reasoning) {
      console.log("[lmstudio-sdk:extractCompletionResponse] TRACE: extracting from reasoning");
      const result = this.extractFromReasoning(reasoning);
      console.log("[lmstudio-sdk:extractCompletionResponse] TRACE: END (from reasoning)");
      return result;
    }

    console.warn(`[${this.name}] Empty response from model`);
    console.log("[lmstudio-sdk:extractCompletionResponse] TRACE: END (empty)");
    return "";
  }

  private extractFromReasoning(reasoning: string): string {
    console.log("[lmstudio-sdk:extractFromReasoning] TRACE: START");
    console.log(`[${this.name}] Using reasoning content (no content field)`);

    const jsonMatch = reasoning.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      console.log("[lmstudio-sdk:extractFromReasoning] TRACE: found JSON pattern");
      try {
        JSON.parse(jsonMatch[0]);
        console.log("[lmstudio-sdk:extractFromReasoning] TRACE: valid JSON found");
        console.log("[lmstudio-sdk:extractFromReasoning] TRACE: END");
        return jsonMatch[0];
      } catch {
        console.log("[lmstudio-sdk:extractFromReasoning] TRACE: JSON parse failed");
        // Not valid JSON, continue
      }
    }

    const withoutThinkTags = reasoning.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    console.log(
      `[lmstudio-sdk:extractFromReasoning] TRACE: stripped think tags, result.length=${withoutThinkTags.length}`,
    );
    console.log("[lmstudio-sdk:extractFromReasoning] TRACE: END");
    return withoutThinkTags || reasoning;
  }

  async *stream(
    messages: ChatMessage[],
    options?: CompletionOptions,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    console.log("[lmstudio-sdk:stream] TRACE: START");
    console.log(`[lmstudio-sdk:stream] TRACE: messages.length=${messages.length}`);
    this.assertReady();
    this.checkAborted(signal);

    console.log("[lmstudio-sdk:stream] TRACE: converting chat format");
    const chat = this.convertToChatFormat(messages);
    console.log("[lmstudio-sdk:stream] TRACE: building stream options");
    const opts = this.buildStreamOptions(options);

    try {
      console.log("[lmstudio-sdk:stream] TRACE: starting streamWithReasoningTracking");
      yield* this.streamWithReasoningTracking(chat, opts, signal);
      console.log("[lmstudio-sdk:stream] TRACE: END");
    } catch (error) {
      console.log("[lmstudio-sdk:stream] TRACE: error caught");
      this.handleStreamError(error);
    }
  }

  private buildStreamOptions(
    options?: CompletionOptions,
  ): Parameters<LLMDynamicHandle["respond"]>[1] {
    console.log("[lmstudio-sdk:buildStreamOptions] TRACE: START");
    const result = {
      temperature: options?.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? 1500,
      stopStrings: options?.stopSequences,
    };
    console.log(
      `[lmstudio-sdk:buildStreamOptions] TRACE: temp=${result.temperature}, maxTokens=${result.maxTokens}`,
    );
    console.log("[lmstudio-sdk:buildStreamOptions] TRACE: END");
    return result;
  }

  private async *streamWithReasoningTracking(
    chat: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    opts: Parameters<LLMDynamicHandle["respond"]>[1],
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    console.log("[lmstudio-sdk:streamWithReasoningTracking] TRACE: START");
    if (!this.llmModel) {
      console.log("[lmstudio-sdk:streamWithReasoningTracking] TRACE: END (not initialized)");
      throw new Error(`${this.name} not initialized`);
    }
    console.log("[lmstudio-sdk:streamWithReasoningTracking] TRACE: calling llmModel.respond");
    const prediction = this.llmModel.respond(chat, opts);
    const reasoningState = { inBlock: false };
    let fragmentCount = 0;

    console.log("[lmstudio-sdk:streamWithReasoningTracking] TRACE: starting fragment loop");
    for await (const fragment of prediction) {
      fragmentCount++;
      this.checkAborted(signal);
      yield* this.processReasoningFragment(fragment, reasoningState);
    }
    console.log(
      `[lmstudio-sdk:streamWithReasoningTracking] TRACE: processed ${fragmentCount} fragments`,
    );

    if (reasoningState.inBlock) {
      console.log("[lmstudio-sdk:streamWithReasoningTracking] TRACE: closing unclosed think block");
      yield "</think>";
    }
    console.log("[lmstudio-sdk:streamWithReasoningTracking] TRACE: END");
  }

  private assertReady(): void {
    console.log("[lmstudio-sdk:assertReady] TRACE: START");
    if (this.disposed || !this.initialized || !this.llmModel) {
      console.log("[lmstudio-sdk:assertReady] TRACE: END (not ready, throwing)");
      throw new Error(`${this.name} not initialized`);
    }
    console.log("[lmstudio-sdk:assertReady] TRACE: END (ready)");
  }

  private checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      console.log("[lmstudio-sdk:checkAborted] TRACE: signal aborted, throwing");
      throw new DOMException("Aborted", "AbortError");
    }
  }

  private handleStreamError(error: unknown): never {
    console.log("[lmstudio-sdk:handleStreamError] TRACE: START");
    if ((error as Error).name === "AbortError") {
      console.log("[lmstudio-sdk:handleStreamError] TRACE: AbortError");
      throw new DOMException("Aborted", "AbortError");
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${this.name}] Stream error:`, errorMessage);
    console.log("[lmstudio-sdk:handleStreamError] TRACE: END (throwing)");
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
    console.log("[lmstudio-sdk:rerank] TRACE: START");
    console.log(
      `[lmstudio-sdk:rerank] TRACE: query.length=${query.length}, candidates.length=${candidates.length}`,
    );
    if (this.disposed || !this.initialized) {
      console.log("[lmstudio-sdk:rerank] TRACE: not ready, falling back to vector scores");
      console.log("[lmstudio-sdk:rerank] TRACE: END (fallback)");
      return this.fallbackToVectorScores(candidates);
    }

    if (candidates.length === 0) {
      console.log("[lmstudio-sdk:rerank] TRACE: END (no candidates)");
      return [];
    }

    const topCandidates = candidates.slice(0, 10);
    console.log(`[lmstudio-sdk:rerank] TRACE: processing top ${topCandidates.length} candidates`);
    console.log("[lmstudio-sdk:rerank] TRACE: building rerank prompt");
    const prompt = this.buildRerankPrompt(query, topCandidates);

    try {
      console.log("[lmstudio-sdk:rerank] TRACE: calling complete for reranking");
      const response = await this.complete(
        [
          { role: "system", content: LLM_PROMPTS.RERANK_SYSTEM },
          { role: "user", content: prompt },
        ],
        { temperature: 0.3, maxTokens: 500 },
      );
      console.log(
        `[lmstudio-sdk:rerank] TRACE: complete returned, response.length=${response.length}`,
      );

      if (!response || response.trim().length < 10) {
        console.warn(`[${this.name}] Empty rerank response, using vector scores`);
        console.log("[lmstudio-sdk:rerank] TRACE: END (empty response fallback)");
        return this.fallbackToVectorScores(topCandidates);
      }

      console.log("[lmstudio-sdk:rerank] TRACE: parsing rerank response");
      const result = this.parseRerankResponse(response, topCandidates);
      console.log(`[lmstudio-sdk:rerank] TRACE: parsed ${result.length} results`);
      console.log("[lmstudio-sdk:rerank] TRACE: END");
      return result;
    } catch (error) {
      console.error(`[${this.name}] Rerank failed:`, error);
      console.log("[lmstudio-sdk:rerank] TRACE: END (error fallback)");
      return this.fallbackToVectorScores(topCandidates);
    }
  }

  private fallbackToVectorScores(candidates: RerankCandidate[]): RankedResult[] {
    console.log("[lmstudio-sdk:fallbackToVectorScores] TRACE: START");
    const result = candidates.map((c) => ({
      noteId: c.noteId,
      path: c.path,
      title: c.title,
      score: c.originalScore,
      reasoning: "Vector similarity",
    }));
    console.log(`[lmstudio-sdk:fallbackToVectorScores] TRACE: returning ${result.length} results`);
    console.log("[lmstudio-sdk:fallbackToVectorScores] TRACE: END");
    return result;
  }

  private buildRerankPrompt(query: string, candidates: RerankCandidate[]): string {
    console.log("[lmstudio-sdk:buildRerankPrompt] TRACE: START");
    const candidateList = candidates
      .map((c, i) => {
        const preview = c.text.slice(0, 150).replace(/\n/g, " ").trim();
        return `[${i}] ${c.title}: ${preview}`;
      })
      .join("\n");

    const result = `Query: "${query}"

${candidateList}

Return JSON with rankings array. Example: {"rankings":[{"index":0,"score":90,"reason":"best match"}]}`;
    console.log(`[lmstudio-sdk:buildRerankPrompt] TRACE: prompt.length=${result.length}`);
    console.log("[lmstudio-sdk:buildRerankPrompt] TRACE: END");
    return result;
  }

  private parseRerankResponse(response: string, candidates: RerankCandidate[]): RankedResult[] {
    console.log("[lmstudio-sdk:parseRerankResponse] TRACE: START");
    try {
      console.log("[lmstudio-sdk:parseRerankResponse] TRACE: extracting JSON");
      const jsonStr = this.extractJsonFromResponse(response);
      if (!jsonStr) {
        console.warn(`[${this.name}] No JSON object found in rerank response`);
        console.log("[lmstudio-sdk:parseRerankResponse] TRACE: END (no JSON fallback)");
        return this.fallbackToVectorScores(candidates);
      }

      console.log("[lmstudio-sdk:parseRerankResponse] TRACE: parsing JSON");
      const parsed = JSON.parse(jsonStr) as {
        rankings?: Array<{ index: number; score: number; reason?: string }>;
      };

      if (!parsed.rankings || !Array.isArray(parsed.rankings)) {
        console.warn(`[${this.name}] No rankings array in response`);
        console.log("[lmstudio-sdk:parseRerankResponse] TRACE: END (no rankings fallback)");
        return this.fallbackToVectorScores(candidates);
      }

      console.log(
        `[lmstudio-sdk:parseRerankResponse] TRACE: building results from ${parsed.rankings.length} rankings`,
      );
      const results = this.buildRankedResults(parsed.rankings, candidates);

      if (results.length === 0) {
        console.warn(`[${this.name}] No valid rankings extracted`);
        console.log("[lmstudio-sdk:parseRerankResponse] TRACE: END (empty results fallback)");
        return this.fallbackToVectorScores(candidates);
      }

      results.sort((a, b) => b.score - a.score);
      console.log(`[${this.name}] Reranked ${results.length} results`);
      console.log("[lmstudio-sdk:parseRerankResponse] TRACE: END");
      return results;
    } catch (error) {
      console.warn(`[${this.name}] Failed to parse rerank response:`, error);
      console.log("[lmstudio-sdk:parseRerankResponse] TRACE: END (parse error fallback)");
      return this.fallbackToVectorScores(candidates);
    }
  }

  private extractJsonFromResponse(response: string): string | null {
    console.log("[lmstudio-sdk:extractJsonFromResponse] TRACE: START");
    let jsonStr = response.trim();

    // Remove markdown code blocks
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
      console.log("[lmstudio-sdk:extractJsonFromResponse] TRACE: extracted from code block");
    }

    // Try to find JSON object in response
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    const result = objectMatch ? objectMatch[0] : null;
    console.log(`[lmstudio-sdk:extractJsonFromResponse] TRACE: found JSON: ${result !== null}`);
    console.log("[lmstudio-sdk:extractJsonFromResponse] TRACE: END");
    return result;
  }

  private buildRankedResults(
    rankings: Array<{ index: number; score: number; reason?: string }>,
    candidates: RerankCandidate[],
  ): RankedResult[] {
    console.log("[lmstudio-sdk:buildRankedResults] TRACE: START");
    const results: RankedResult[] = [];

    for (const ranking of rankings) {
      const result = this.parseRankingEntry(ranking, candidates);
      if (result) {
        results.push(result);
      }
    }

    console.log(`[lmstudio-sdk:buildRankedResults] TRACE: built ${results.length} results`);
    console.log("[lmstudio-sdk:buildRankedResults] TRACE: END");
    return results;
  }

  private parseRankingEntry(
    ranking: { index: number; score: number; reason?: string },
    candidates: RerankCandidate[],
  ): RankedResult | null {
    console.log("[lmstudio-sdk:parseRankingEntry] TRACE: START");
    const idx =
      typeof ranking.index === "number"
        ? ranking.index
        : Number.parseInt(String(ranking.index), 10);
    const score =
      typeof ranking.score === "number"
        ? ranking.score
        : Number.parseInt(String(ranking.score), 10);

    if (Number.isNaN(idx) || Number.isNaN(score)) {
      console.log("[lmstudio-sdk:parseRankingEntry] TRACE: END (invalid idx/score)");
      return null;
    }

    const candidate = candidates[idx];
    if (!candidate || score < 30) {
      console.log("[lmstudio-sdk:parseRankingEntry] TRACE: END (no candidate or low score)");
      return null;
    }

    console.log("[lmstudio-sdk:parseRankingEntry] TRACE: END (valid)");
    return {
      noteId: candidate.noteId,
      path: candidate.path,
      title: candidate.title,
      score: score / 100,
      reasoning: ranking.reason || "Relevant",
    };
  }
}
