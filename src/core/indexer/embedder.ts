import type { LLMProvider } from "../llm/provider";

export interface EmbedderOptions {
  model: string;
  batchSize?: number;
  retryDelayMs?: number;
}

export class Embedder {
  private readonly batchSize: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly provider: LLMProvider,
    private readonly opts: EmbedderOptions,
  ) {
    this.batchSize = opts.batchSize ?? 16;
    this.retryDelayMs = opts.retryDelayMs ?? 250;
  }

  async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += this.batchSize) {
      const batch = inputs.slice(i, i + this.batchSize);
      const vectors = await this.embedBatchWithRetry(batch, signal);
      out.push(...vectors);
    }
    return out;
  }

  private async embedBatchWithRetry(batch: string[], signal?: AbortSignal): Promise<number[][]> {
    try {
      return await this.provider.embed(batch, { model: this.opts.model, signal });
    } catch (firstError) {
      await sleep(this.retryDelayMs);
      try {
        return await this.provider.embed(batch, { model: this.opts.model, signal });
      } catch {
        throw firstError;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
