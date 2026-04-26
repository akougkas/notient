/**
 * Ollama Provider Implementation
 * Uses Ollama API at http://192.168.86.249:11434
 * Source of truth: .planning/PHASE-GALAXY.md (Phase D4)
 */

import type { LLMProviderConfig } from "../../types";
import type { CompletionOptions, LLMProvider } from "./provider";

/**
 * Ollama generate request.
 */
interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

/**
 * Ollama generate response.
 */
interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

/**
 * Ollama provider using native Ollama API.
 * Endpoints: POST /api/generate
 */
export class OllamaProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: LLMProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.model = config.model;
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const url = `${this.baseUrl}/api/generate`;

    const request: OllamaGenerateRequest = {
      model: this.model,
      prompt,
      stream: false,
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.maxTokens,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: options?.abortSignal,
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaGenerateResponse;

    if (!data.response) {
      throw new Error("Ollama returned empty response");
    }

    return data.response;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/api/tags`;

      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
