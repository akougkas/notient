/**
 * LM Studio Provider Implementation
 * Uses OpenAI-compatible API at http://192.168.86.249:1234/v1
 * Source of truth: .planning/PHASE-GALAXY.md (Phase D4)
 */

import type { LLMProviderConfig } from "../../types";
import type { CompletionOptions, LLMProvider } from "./provider";

/**
 * OpenAI-compatible chat completion request.
 */
interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
}

/**
 * OpenAI-compatible chat completion response.
 */
interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * LM Studio provider using OpenAI-compatible API.
 * Endpoints: POST /chat/completions
 */
export class LMStudioProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;

  constructor(config: LLMProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.model = config.model;
    this.apiKey = config.apiKey;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;

    const request: ChatCompletionRequest = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: options?.abortSignal,
    });

    if (!response.ok) {
      throw new Error(`LM Studio request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LM Studio returned empty response");
    }

    return content;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/models`;
      const headers: Record<string, string> = {};

      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5000),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
