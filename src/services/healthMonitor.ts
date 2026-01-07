/**
 * Runtime Health Monitor
 *
 * Probes external dependencies (Ollama, LM Studio) and
 * reports health status via events.
 */

import { PERFORMANCE } from "../core/constants";
import type { Kernel } from "../core/kernel";
import type { AvailableModel, ServiceHealth } from "../types/services";

/**
 * Health monitor for external services (Ollama, LM Studio)
 */
export class HealthMonitor {
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  // Cached available models
  private ollamaModels: AvailableModel[] = [];
  private lmstudioModels: AvailableModel[] = [];

  constructor(private kernel: Kernel) {}

  /**
   * Initialize and start monitoring
   */
  async initialize(): Promise<void> {
    // Initial check
    await this.checkAll();

    // Periodic checks
    this.checkInterval = setInterval(() => this.checkAll(), PERFORMANCE.HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Check all external services
   */
  async checkAll(): Promise<void> {
    if (this.disposed) return;

    await Promise.all([this.checkOllama(), this.checkLMStudio()]);
  }

  /**
   * Check Ollama health and fetch models
   */
  async checkOllama(): Promise<ServiceHealth> {
    const settings = this.kernel.settings;

    if (!settings.ollama.enabled) {
      const health: ServiceHealth = {
        status: "unknown",
        lastChecked: Date.now(),
        error: "Ollama is disabled",
      };
      this.kernel.updateServiceHealth("ollama", health);
      return health;
    }

    this.kernel.updateServiceHealth("ollama", {
      status: "checking",
      lastChecked: Date.now(),
      error: null,
    });

    try {
      this.ollamaModels = await this.fetchOllamaModels(settings.ollama.host);

      if (this.ollamaModels.length === 0) {
        throw new Error("No models found");
      }

      // Verify configured embedding model exists
      const configuredModel = settings.ollama.embeddingModel;
      const modelExists =
        !configuredModel || this.ollamaModels.some((m) => m.name === configuredModel);

      const health: ServiceHealth = {
        status: "healthy",
        lastChecked: Date.now(),
        error: modelExists ? null : `Model "${configuredModel}" not found`,
        details: {
          modelCount: this.ollamaModels.length,
          models: this.ollamaModels.map((m) => m.name),
          configuredModelValid: modelExists,
        },
      };

      this.kernel.updateServiceHealth("ollama", health);
      return health;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const health: ServiceHealth = {
        status: "unhealthy",
        lastChecked: Date.now(),
        error: `Cannot connect to Ollama: ${message}`,
      };
      this.ollamaModels = [];
      this.kernel.updateServiceHealth("ollama", health);
      return health;
    }
  }

  /**
   * Check LM Studio health and fetch models
   */
  async checkLMStudio(): Promise<ServiceHealth> {
    const settings = this.kernel.settings;

    if (!settings.lmstudio.enabled) {
      const health: ServiceHealth = {
        status: "unknown",
        lastChecked: Date.now(),
        error: "LM Studio is disabled",
      };
      this.kernel.updateServiceHealth("lmstudio", health);
      return health;
    }

    this.kernel.updateServiceHealth("lmstudio", {
      status: "checking",
      lastChecked: Date.now(),
      error: null,
    });

    try {
      this.lmstudioModels = await this.fetchLMStudioModels(settings.lmstudio.host);

      // Verify configured model exists (if any)
      const configuredModel = settings.lmstudio.reasoningModel;
      const modelExists =
        !configuredModel || this.lmstudioModels.some((m) => m.name === configuredModel);

      if (!modelExists) {
        const health: ServiceHealth = {
          status: "unhealthy",
          lastChecked: Date.now(),
          error: `Model "${configuredModel}" not found in LM Studio`,
          details: {
            modelCount: this.lmstudioModels.length,
            models: this.lmstudioModels.map((m) => m.name),
            configuredModelValid: false,
          },
        };
        this.kernel.updateServiceHealth("lmstudio", health);
        return health;
      }

      // Verify model is actually LOADED by doing a minimal test completion
      // LM Studio can list models in library but fail if none are loaded
      if (configuredModel) {
        const testResponse = await fetch(`${settings.lmstudio.host}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: configuredModel,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (!testResponse.ok) {
          const errorText = await testResponse.text().catch(() => "");
          const isNotLoaded = errorText.includes("No models loaded");
          const health: ServiceHealth = {
            status: "unhealthy",
            lastChecked: Date.now(),
            error: isNotLoaded
              ? `Model "${configuredModel}" exists but is not loaded. Load it in LM Studio.`
              : `Model "${configuredModel}" failed: ${testResponse.status}`,
            details: {
              modelCount: this.lmstudioModels.length,
              models: this.lmstudioModels.map((m) => m.name),
              configuredModelValid: false,
            },
          };
          this.kernel.updateServiceHealth("lmstudio", health);
          return health;
        }
      }

      const health: ServiceHealth = {
        status: "healthy",
        lastChecked: Date.now(),
        error: null,
        details: {
          modelCount: this.lmstudioModels.length,
          models: this.lmstudioModels.map((m) => m.name),
          configuredModelValid: true,
        },
      };

      this.kernel.updateServiceHealth("lmstudio", health);
      return health;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const health: ServiceHealth = {
        status: "unhealthy",
        lastChecked: Date.now(),
        error: `Cannot connect to LM Studio: ${message}`,
      };
      this.lmstudioModels = [];
      this.kernel.updateServiceHealth("lmstudio", health);
      return health;
    }
  }

  /**
   * Fetch models from Ollama
   */
  async fetchOllamaModels(host: string): Promise<AvailableModel[]> {
    const response = await fetch(`${host}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      models?: Array<{
        name: string;
        size?: number;
        details?: { quantization_level?: string };
      }>;
    };

    return (data.models ?? []).map((m) => ({
      name: m.name,
      displayName: m.name,
      size: m.size,
      quantization: m.details?.quantization_level,
      capabilities: this.inferOllamaCapabilities(m.name),
    }));
  }

  /**
   * Fetch models from LM Studio
   */
  async fetchLMStudioModels(host: string): Promise<AvailableModel[]> {
    const response = await fetch(`${host}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as { data?: Array<{ id: string }> };

    return (data.data ?? []).map((m) => ({
      name: m.id,
      displayName: m.id,
      capabilities: ["chat", "completion"] as ("embedding" | "chat" | "completion")[],
    }));
  }

  /**
   * Check if a specific model exists in Ollama
   */
  async validateOllamaModel(host: string, modelName: string): Promise<boolean> {
    try {
      const models = await this.fetchOllamaModels(host);
      return models.some((m) => m.name === modelName);
    } catch {
      return false;
    }
  }

  /**
   * Check if a specific model exists in LM Studio
   */
  async validateLMStudioModel(host: string, modelName: string): Promise<boolean> {
    try {
      const models = await this.fetchLMStudioModels(host);
      return models.some((m) => m.name === modelName);
    } catch {
      return false;
    }
  }

  /**
   * Get cached Ollama models
   */
  getOllamaModels(): AvailableModel[] {
    return [...this.ollamaModels];
  }

  /**
   * Get cached LM Studio models
   */
  getLMStudioModels(): AvailableModel[] {
    return [...this.lmstudioModels];
  }

  /**
   * Get embedding-capable models from Ollama
   */
  getEmbeddingModels(): AvailableModel[] {
    return this.ollamaModels.filter((m) => m.capabilities.includes("embedding"));
  }

  /**
   * Dispose of the monitor
   */
  dispose(): void {
    this.disposed = true;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Infer capabilities from model name
   */
  private inferOllamaCapabilities(modelName: string): ("embedding" | "chat" | "completion")[] {
    const name = modelName.toLowerCase();

    // Known embedding models - expanded list
    if (
      name.includes("embed") ||
      name.includes("nomic") ||
      name.includes("minilm") ||
      name.includes("bge") ||
      name.includes("e5-") ||
      name.includes("gte-") ||
      name.includes("jina") ||
      name.includes("snowflake-arctic-embed") ||
      (name.includes("qwen") && name.includes("embedding"))
    ) {
      return ["embedding"];
    }

    // Default to chat/completion
    return ["chat", "completion"];
  }
}
