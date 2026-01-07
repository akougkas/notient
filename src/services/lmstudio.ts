/**
 * LM Studio Reasoning Service
 *
 * Provides chat completions via OpenAI-compatible API.
 * Used for: search reranking, note classification, chat.
 */

import type { Kernel } from "../core/kernel";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RankedResult {
  noteId: string;
  path: string;
  title: string;
  score: number;
  reasoning: string;
}

interface RerankCandidate {
  noteId: string;
  path: string;
  title: string;
  text: string;
  originalScore: number;
}

const RERANK_SYSTEM_PROMPT = `You rank search results by relevance. Output ONLY valid JSON.

Example output:
{"rankings":[{"index":0,"score":90,"reason":"exact match"},{"index":2,"score":70,"reason":"related"}]}

Rules:
- score: 0-100
- index: candidate number
- reason: brief (under 30 chars)
- Only include relevant results (score >= 30)`;

const BASE_SYSTEM_PROMPT = `You are Notient, an AI assistant for an Obsidian vault. You help users understand, navigate, and improve their notes.

CRITICAL RULES:
- Always ground your responses in the actual note content provided
- Cite specific notes using [[Note Title]] format (wiki-links)
- Be concise, specific, and actionable
- If information isn't in the notes, explicitly say so
- Never invent or hallucinate content that isn't in the provided context`;

/**
 * LM Studio Service - provides reasoning capabilities
 */
export class LMStudioService {
  private baseUrl: string = "";
  private model: string = "";
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
    const content = data.choices?.[0]?.message?.content || "";
    
    if (!content) {
      console.warn("[LMStudioService] Empty content in response. Full response:", JSON.stringify(data).slice(0, 500));
    }
    
    return content;
  }

  /**
   * Streaming chat completion with optional abort support
   * @param messages - Chat messages to send
   * @param signal - Optional AbortSignal for cancellation
   */
  async *chatStream(
    messages: ChatMessage[],
    signal?: AbortSignal
  ): AsyncIterable<string> {
    if (this.disposed || !this.initialized) {
      throw new Error("LMStudioService not initialized");
    }

    // Check if already aborted before starting
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
      signal, // Pass the AbortSignal to fetch
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
        // Check abort status before each read
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE format
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") return;

            try {
              const json = JSON.parse(data);
              const content = json.choices?.[0]?.delta?.content;
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
  async rerank(
    query: string,
    candidates: RerankCandidate[]
  ): Promise<RankedResult[]> {
    if (this.disposed || !this.initialized) {
      // Return original order if service unavailable
      return candidates.map((c) => ({
        noteId: c.noteId,
        path: c.path,
        title: c.title,
        score: c.originalScore,
        reasoning: "Vector similarity",
      }));
    }

    if (candidates.length === 0) return [];

    // Limit candidates for efficient reranking (fewer = faster, better for smaller models)
    const topCandidates = candidates.slice(0, 10);

    const prompt = this.buildRerankPrompt(query, topCandidates);

    try {
      const response = await this.chat([
        { role: "system", content: RERANK_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ]);

      // Check for empty response
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

  /**
   * Fallback to vector similarity scores
   */
  private fallbackToVectorScores(candidates: RerankCandidate[]): RankedResult[] {
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
  private buildRerankPrompt(query: string, candidates: RerankCandidate[]): string {
    // Keep it simple for smaller models
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
  private parseRerankResponse(
    response: string,
    candidates: RerankCandidate[]
  ): RankedResult[] {
    try {
      // Check for empty or too short response
      if (!response || response.trim().length < 10) {
        console.warn("[LMStudioService] Response too short:", response);
        return this.fallbackToVectorScores(candidates);
      }

      // Extract JSON from response (handle markdown code blocks)
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
        console.warn("[LMStudioService] No JSON object found in response");
        return this.fallbackToVectorScores(candidates);
      }

      // Try to parse - handle incomplete JSON by closing brackets
      let parsed: { rankings?: Array<{ index: number; score: number; reason?: string }> };
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        // Try to fix incomplete JSON
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

      // Map rankings back to candidates
      const results: RankedResult[] = [];
      for (const ranking of parsed.rankings) {
        const idx = typeof ranking.index === "number" ? ranking.index : parseInt(String(ranking.index), 10);
        const score = typeof ranking.score === "number" ? ranking.score : parseInt(String(ranking.score), 10);
        
        if (isNaN(idx) || isNaN(score)) continue;
        
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

      // If no valid rankings, fallback
      if (results.length === 0) {
        console.warn("[LMStudioService] No valid rankings extracted");
        return this.fallbackToVectorScores(candidates);
      }

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);
      console.log(`[LMStudioService] Reranked ${results.length} results`);
      return results;
    } catch (error) {
      console.warn("[LMStudioService] Failed to parse rerank response:", error);
      return this.fallbackToVectorScores(candidates);
    }
  }

  /**
   * Try to fix incomplete JSON (missing closing brackets)
   */
  private tryFixIncompleteJson(jsonStr: string): string | null {
    try {
      // Count brackets
      const openBraces = (jsonStr.match(/\{/g) || []).length;
      const closeBraces = (jsonStr.match(/\}/g) || []).length;
      const openBrackets = (jsonStr.match(/\[/g) || []).length;
      const closeBrackets = (jsonStr.match(/\]/g) || []).length;

      let fixed = jsonStr;
      
      // Add missing closing brackets
      for (let i = 0; i < openBrackets - closeBrackets; i++) {
        fixed += "]";
      }
      for (let i = 0; i < openBraces - closeBraces; i++) {
        fixed += "}";
      }

      // Try to parse
      JSON.parse(fixed);
      return fixed;
    } catch {
      return null;
    }
  }

  /**
   * Build a RAG chat prompt with full vault context
   * This is the main entry point for building LLM prompts
   */
  buildChatSystemPrompt(
    contextSummary: string,
    relevantNotes: Array<{ title: string; path: string; text: string }>,
    currentNote?: { title: string; path: string; content: string },
    query?: string
  ): string {
    const parts: string[] = [BASE_SYSTEM_PROMPT];

    // Add the CURRENT NOTE prominently if this is a note-specific task
    if (currentNote?.content) {
      const truncatedContent = currentNote.content.length > 3000
        ? currentNote.content.slice(0, 3000) + "\n\n[... content truncated ...]"
        : currentNote.content;

      parts.push(`
=== CURRENT NOTE (FOCUS) ===
Title: ${currentNote.title}
Path: ${currentNote.path}

${truncatedContent}
=== END CURRENT NOTE ===`);
    }

    // Add task-specific instructions based on query patterns
    const taskInstructions = this.inferTaskInstructions(query || "");
    if (taskInstructions) {
      parts.push(`
TASK INSTRUCTIONS:
${taskInstructions}`);
    }

    // Add vault context summary
    if (contextSummary && contextSummary !== "No vault context available.") {
      parts.push(`
VAULT CONTEXT:
${contextSummary}`);
    }

    // Add related notes from RAG (exclude current note to avoid duplication)
    const filteredNotes = relevantNotes.filter(n => 
      !currentNote || n.path !== currentNote.path
    );
    
    if (filteredNotes.length > 0) {
      const noteSummaries = filteredNotes
        .slice(0, 5)
        .map((n) => {
          const preview = n.text.length > 400 
            ? n.text.slice(0, 400) + "..." 
            : n.text;
          return `### [[${n.title}]] (${n.path})
${preview}`;
        })
        .join("\n\n");

      parts.push(`
RELATED NOTES FROM VAULT:
${noteSummaries}`);
    }

    return parts.join("\n");
  }

  /**
   * Infer task-specific instructions from the query
   */
  private inferTaskInstructions(query: string): string | null {
    const q = query.toLowerCase();

    // Enrich/Expand action
    if (q.includes("enrich") || q.includes("expand") || q.includes("additional context")) {
      return `The user wants to ENRICH/EXPAND the current note.
- Analyze the note's content thoroughly
- Suggest additional sections, details, or context that would improve it
- Reference related notes from the vault that could provide insights
- Be specific and provide actionable additions
- Format suggestions as clear bullet points or sections`;
    }

    // Link action
    if (q.includes("link") || q.includes("linked") || q.includes("connections")) {
      return `The user wants to find LINKING opportunities for this note.
- Identify concepts, topics, or entities that could connect to other notes
- Look at the related notes and suggest specific wiki-links to add
- Explain WHY each link would be valuable (shared concepts, related projects, etc.)
- Suggest both outgoing links (from this note) and potential backlinks`;
    }

    // Move/Classify action
    if (q.includes("move") || q.includes("folder") || q.includes("category") || q.includes("para") || q.includes("classify") || q.includes("organize")) {
      return `The user wants to CLASSIFY/ORGANIZE this note.
- Analyze the note's content to understand its purpose
- Suggest the best folder/category based on PARA methodology:
  * Projects: Active efforts with clear outcomes
  * Areas: Ongoing responsibilities  
  * Resources: Reference material
  * Archives: Inactive/completed items
- Provide clear reasoning for your recommendation
- Consider the note's relationships to other vault content`;
    }

    // Analyze/Health action
    if (q.includes("analyze") || q.includes("health") || q.includes("improve") || q.includes("review")) {
      return `The user wants to ANALYZE and improve this note.
- Assess the note's completeness, clarity, and structure
- Identify gaps, unclear sections, or areas needing expansion
- Check for broken links or missing connections
- Suggest specific improvements with priorities
- Rate the note's overall "health" if applicable`;
    }

    // General chat - no specific instructions needed
    return null;
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
