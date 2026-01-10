/**
 * Resource-Aware Model Parameter Selector
 *
 * Dynamically adjusts model parameters based on:
 * - Agent type and requirements
 * - Available context window
 * - Task complexity
 * - System resource constraints
 *
 * This allows optimal use of local LLMs with varying capabilities.
 */

import type { CompletionOptions } from "../llm/types";
import type { AgentConfig, AgentType, NoteContext } from "./types";
import { AGENT_CONFIGS } from "./types";

/**
 * Model capability profile
 */
export interface ModelProfile {
  /** Model identifier */
  name: string;
  /** Maximum context window (tokens) */
  contextWindow: number;
  /** Whether this is a "thinking" model with reasoning_content */
  isThinkingModel: boolean;
  /** Optimal temperature range */
  temperatureRange: { min: number; max: number };
  /** Speed tier (affects timeout decisions) */
  speedTier: "fast" | "medium" | "slow";
  /** Best for tasks */
  strengths: AgentType[];
}

/**
 * Known model profiles for common local LLMs
 */
export const MODEL_PROFILES: Record<string, Partial<ModelProfile>> = {
  // Falcon H1R series (thinking models)
  "falcon-h1r-7b": {
    contextWindow: 8192,
    isThinkingModel: true,
    temperatureRange: { min: 0.1, max: 0.8 },
    speedTier: "medium",
    strengths: ["chat", "note-editor"],
  },
  "falcon-h1r-3b": {
    contextWindow: 4096,
    isThinkingModel: true,
    temperatureRange: { min: 0.1, max: 0.7 },
    speedTier: "fast",
    strengths: ["classifier", "link-finder"],
  },

  // Qwen series
  "qwen2.5-7b-instruct": {
    contextWindow: 32768,
    isThinkingModel: false,
    temperatureRange: { min: 0.0, max: 1.0 },
    speedTier: "medium",
    strengths: ["chat", "note-editor", "link-finder"],
  },
  "qwen2.5-3b-instruct": {
    contextWindow: 32768,
    isThinkingModel: false,
    temperatureRange: { min: 0.0, max: 1.0 },
    speedTier: "fast",
    strengths: ["classifier", "context-builder"],
  },

  // Llama series
  "llama-3.1-8b-instruct": {
    contextWindow: 8192,
    isThinkingModel: false,
    temperatureRange: { min: 0.0, max: 1.0 },
    speedTier: "medium",
    strengths: ["chat", "note-editor"],
  },

  // Mistral series
  "mistral-7b-instruct": {
    contextWindow: 8192,
    isThinkingModel: false,
    temperatureRange: { min: 0.0, max: 1.0 },
    speedTier: "fast",
    strengths: ["chat", "classifier"],
  },

  // DeepSeek series (thinking models)
  "deepseek-r1": {
    contextWindow: 16384,
    isThinkingModel: true,
    temperatureRange: { min: 0.0, max: 0.6 },
    speedTier: "slow",
    strengths: ["note-editor", "link-finder"],
  },
};

/**
 * Default model profile for unknown models
 */
const DEFAULT_PROFILE: ModelProfile = {
  name: "unknown",
  contextWindow: 4096,
  isThinkingModel: false,
  temperatureRange: { min: 0.0, max: 1.0 },
  speedTier: "medium",
  strengths: [],
};

/**
 * Resource-aware model parameter selector
 */
export class ModelSelector {
  private modelName: string;
  private profile: ModelProfile;

  constructor(modelName: string) {
    this.modelName = modelName.toLowerCase();
    this.profile = this.resolveProfile(modelName);
  }

  /**
   * Resolve model profile from name
   */
  private resolveProfile(modelName: string): ModelProfile {
    const normalized = modelName.toLowerCase();

    // Exact match
    if (MODEL_PROFILES[normalized]) {
      return { ...DEFAULT_PROFILE, name: normalized, ...MODEL_PROFILES[normalized] };
    }

    // Partial match (e.g., "falcon-h1r-7b-q4" matches "falcon-h1r-7b")
    for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
      if (normalized.includes(key) || key.includes(normalized.split("-").slice(0, 3).join("-"))) {
        return { ...DEFAULT_PROFILE, name: key, ...profile };
      }
    }

    // Infer from name patterns
    if (
      normalized.includes("thinking") ||
      normalized.includes("-r1") ||
      normalized.includes("h1r")
    ) {
      return {
        ...DEFAULT_PROFILE,
        name: normalized,
        isThinkingModel: true,
        temperatureRange: { min: 0.0, max: 0.7 },
      };
    }

    return { ...DEFAULT_PROFILE, name: normalized };
  }

  /**
   * Get optimal completion options for an agent
   */
  getOptionsForAgent(agentType: AgentType, noteContext?: NoteContext): CompletionOptions {
    const agentConfig = AGENT_CONFIGS[agentType];

    // Start with agent's default temperature
    let temperature = agentConfig.temperature;

    // Clamp to model's optimal range
    temperature = Math.max(
      this.profile.temperatureRange.min,
      Math.min(this.profile.temperatureRange.max, temperature),
    );

    // Calculate context-aware max tokens
    const maxTokens = this.calculateMaxTokens(agentConfig, noteContext);

    return {
      temperature,
      maxTokens,
    };
  }

  /**
   * Calculate max tokens based on context and model capabilities
   */
  private calculateMaxTokens(agentConfig: AgentConfig, noteContext?: NoteContext): number {
    // Base max tokens from agent config
    let maxTokens = agentConfig.maxTokens;

    // Estimate input token usage (rough: 4 chars per token)
    const inputChars = noteContext?.content.length || 0;
    const estimatedInputTokens = Math.ceil(inputChars / 4);

    // Calculate available output tokens
    const availableTokens = this.profile.contextWindow - estimatedInputTokens - 500; // 500 token buffer

    // Clamp to available space
    maxTokens = Math.min(maxTokens, Math.max(500, availableTokens));

    // Thinking models need more tokens for reasoning
    if (this.profile.isThinkingModel) {
      maxTokens = Math.min(maxTokens * 1.5, availableTokens);
    }

    return Math.floor(maxTokens);
  }

  /**
   * Get timeout multiplier based on model speed
   */
  getTimeoutMultiplier(): number {
    switch (this.profile.speedTier) {
      case "fast":
        return 1.0;
      case "medium":
        return 1.5;
      case "slow":
        return 2.5;
      default:
        return 1.5;
    }
  }

  /**
   * Check if model is well-suited for an agent type
   */
  isOptimalFor(agentType: AgentType): boolean {
    return this.profile.strengths.includes(agentType);
  }

  /**
   * Get recommended agents for this model
   */
  getRecommendedAgents(): AgentType[] {
    return this.profile.strengths;
  }

  /**
   * Check if model supports reasoning content
   */
  isThinkingModel(): boolean {
    return this.profile.isThinkingModel;
  }

  /**
   * Get model's context window
   */
  getContextWindow(): number {
    return this.profile.contextWindow;
  }

  /**
   * Get current model profile
   */
  getProfile(): Readonly<ModelProfile> {
    return this.profile;
  }

  /**
   * Estimate if a context will fit in the model
   */
  willFit(contextChars: number, responseTokens: number): boolean {
    const estimatedInputTokens = Math.ceil(contextChars / 4);
    const totalTokens = estimatedInputTokens + responseTokens + 100; // Buffer
    return totalTokens <= this.profile.contextWindow;
  }

  /**
   * Get context budget for an agent considering model limits
   */
  getContextBudget(agentType: AgentType): number {
    const agentBudget = AGENT_CONFIGS[agentType].contextBudget;
    const modelBudgetChars = (this.profile.contextWindow - AGENT_CONFIGS[agentType].maxTokens) * 4;
    return Math.min(agentBudget, modelBudgetChars * 0.8); // 80% safety margin
  }
}

/**
 * Create a model selector with runtime model discovery
 */
export function createModelSelector(modelName: string): ModelSelector {
  return new ModelSelector(modelName);
}

/**
 * Get default completion options for testing/fallback
 */
export function getDefaultOptions(agentType: AgentType): CompletionOptions {
  const config = AGENT_CONFIGS[agentType];
  return {
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}
