/**
 * LM Studio Reasoning Service (Legacy)
 *
 * @deprecated Use core/llm/providers/lmstudio.ts for new code.
 * This file is kept for backward compatibility with SearchPipeline.
 * Contains ONLY API wrapper logic - NO Notient-specific code.
 *
 * For prompt building and task inference, use:
 * - core/agent/promptBuilder.ts
 * - core/agent/taskInference.ts
 */

import { LLM_PROMPTS } from "../core/constants";
import type { Kernel } from "../core/kernel";

// Re-export types from new architecture for backward compatibility
export type { ChatMessage, RankedResult, RerankCandidate } from "../core/llm/types";
import type { ChatMessage, RankedResult, RerankCandidate } from "../core/llm/types";

/**
 * LM Studio Service - provides reasoning capabilities
 *
 * @deprecated Use LMStudioProvider from core/llm for new code.
 * This service is kept for SearchPipeline compatibility.
 */
export class LMStudioService {
  private baseUrl = "";
  private model = "";
  private disposed = false;
  private initialized = false;

  constructor(private kernel: Kernel) {}

  async initialize(): Promise<void> {
    if (this.disposed) return;

    const settings = this.kernel.settings;
    this.baseUrl = settings.lmstudio.host;
    this.model = settings.lmstudio.reasoningModel;

    if (!this.baseUrl || !this.model) {
      throw new Error("LM Studio not configured");
    }

    // Verify connectivity
    try {
      await this.listModels();
      this.initialized = true;
      console.log(`[LMStudioService] Initialized with model=${this.model}`);
    } catch (error) {
      console.error("[LMStudioService] Failed to connect:", error);
      throw error;
    }
  }

  /**
   * List available models from LM Studio
   */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/v1/models`);
    if (!response.ok) {
      throw new Error(`LM Studio API error: ${response.status}`);
    }
    const data = await response.json();
    return data.data.map((m: { id: string }) => m.id);
  }

  /**
   * Simple chat completion (non-streaming)
   */
  async chat(messages: ChatMessage[]): Promise<string> {
    if (this.disposed || !this.initialized) {
      throw new Error("LMStudioService not initialized");
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      console.error("[LMStudioService] Chat error:", response.status, errorText);
      throw new Error(`LM Studio chat error: ${response.status}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    let content = message?.content || "";

    // Support reasoning_content from thinking models (DeepSeek, Falcon H1R, etc.)
    if (!content && message?.reasoning_content) {
      content = message.reasoning_content;
      console.log("[LMStudioService] Using reasoning_content from thinking model");
    }

    if (!content) {
      console.warn(
        "[LMStudioService] Empty content in response. Full response:",
        JSON.stringify(data).slice(0, 500),
      );
    }

    return content;
  }

  /**
   * Streaming chat completion with optional abort support
   * @param messages - Chat messages to send
   * @param signal - Optional AbortSignal for cancellation
   */
  async *chatStream(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string> {
    if (this.disposed || !this.initialized) {
      throw new Error("LMStudioService not initialized");
    }

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 1500,
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`LM Studio stream error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") return;

            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta;
              // Support both content and reasoning_content for thinking models
              const content = delta?.content || delta?.reasoning_content;
              if (content) yield content;
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Rerank search results using LLM
   */
  async rerank(query: string, candidates: RerankCandidate[]): Promise<RankedResult[]> {
    if (this.disposed || !this.initialized) {
      return this.fallbackToVectorScores(candidates);
    }

    if (candidates.length === 0) return [];

    const topCandidates = candidates.slice(0, 10);
    const prompt = this.buildRerankPrompt(query, topCandidates);

    try {
      const response = await this.chat([
        { role: "system", content: LLM_PROMPTS.RERANK_SYSTEM },
        { role: "user", content: prompt },
      ]);

      if (!response || response.trim().length === 0) {
        console.warn("[LMStudioService] Empty response from LLM, using vector scores");
        return this.fallbackToVectorScores(topCandidates);
      }

      console.log("[LMStudioService] Rerank response length:", response.length);
      return this.parseRerankResponse(response, topCandidates);
    } catch (error) {
      console.error("[LMStudioService] Rerank failed:", error);
      return this.fallbackToVectorScores(topCandidates);
    }
  }

  private fallbackToVectorScores(candidates: RerankCandidate[]): RankedResult[] {
    return candidates.map((c) => ({
      noteId: c.noteId,
      path: c.path,
      title: c.title,
      score: c.originalScore,
      reasoning: "Vector similarity",
    }));
  }

  private buildRerankPrompt(query: string, candidates: RerankCandidate[]): string {
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

  private parseRerankResponse(response: string, candidates: RerankCandidate[]): RankedResult[] {
    try {
      if (!response || response.trim().length < 10) {
        console.warn("[LMStudioService] Response too short:", response);
        return this.fallbackToVectorScores(candidates);
      }

      let jsonStr = response.trim();

      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        jsonStr = objectMatch[0];
      } else {
        console.warn("[LMStudioService] No JSON object found in response");
        return this.fallbackToVectorScores(candidates);
      }

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
        console.warn("[LMStudioService] No rankings array in response");
        return this.fallbackToVectorScores(candidates);
      }

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
            score: score / 100,
            reasoning: ranking.reason || "Relevant",
          });
        }
      }

      if (results.length === 0) {
        console.warn("[LMStudioService] No valid rankings extracted");
        return this.fallbackToVectorScores(candidates);
      }

      results.sort((a, b) => b.score - a.score);
      console.log(`[LMStudioService] Reranked ${results.length} results`);
      return results;
    } catch (error) {
      console.warn("[LMStudioService] Failed to parse rerank response:", error);
      return this.fallbackToVectorScores(candidates);
    }
  }

  private tryFixIncompleteJson(jsonStr: string): string | null {
    try {
      const openBraces = (jsonStr.match(/\{/g) || []).length;
      const closeBraces = (jsonStr.match(/\}/g) || []).length;
      const openBrackets = (jsonStr.match(/\[/g) || []).length;
      const closeBrackets = (jsonStr.match(/\]/g) || []).length;

      let fixed = jsonStr;

      for (let i = 0; i < openBrackets - closeBrackets; i++) {
        fixed += "]";
      }
      for (let i = 0; i < openBraces - closeBraces; i++) {
        fixed += "}";
      }

      JSON.parse(fixed);
      return fixed;
    } catch {
      return null;
    }
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return this.initialized && !this.disposed;
  }

  /**
   * Dispose of the service
   */
  dispose(): void {
    this.disposed = true;
    this.initialized = false;
  }
}
