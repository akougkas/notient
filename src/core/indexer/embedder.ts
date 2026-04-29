import type { LLMProvider } from "../llm/provider";
import { CONCURRENCY } from "./concurrencyDefaults";

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
    for (let index = 0; index < inputs.length; index += this.batchSize) {
      const batch = inputs.slice(index, index + this.batchSize);
      const vectors = await this.embedBatchWithRetry(batch, signal);
      out.push(...vectors);
    }
    return out;
  }

  /**
   * Embed each input as its own provider call with bounded concurrency.
   *
   * Tier 2 fans out per-chunk embeddings for one note in parallel. The
   * cap is `CONCURRENCY.embed` (Phase 4 makes it configurable). Output
   * is index-aligned with input. Any rejection aborts the remaining
   * workers and propagates; partial results are never returned.
   */
  async embedAll(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = new Array(texts.length);
    let cursor = 0;
    const workerCount = Math.min(CONCURRENCY.embed, texts.length);

    const runWorker = async (): Promise<void> => {
      while (true) {
        const slot = cursor;
        cursor += 1;
        if (slot >= texts.length) return;
        const vectors = await this.embedBatchWithRetry([texts[slot]], signal);
        out[slot] = vectors[0];
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
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
