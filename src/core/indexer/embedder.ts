import {
  type EmbeddingIdentity,
  type ResolvedEmbeddingIdentity,
  createEmbeddingIdentity,
  requireResolvedEmbeddingIdentity,
} from "../llm/embeddingIdentity";
import type { LLMProvider } from "../llm/provider";

/**
 * Retry ladder multipliers applied to `retryDelayMs`. With the 250ms default
 * this yields 250 / 750 / 2000ms before the second, third, and fourth attempt.
 */
const RETRY_BACKOFF_STEPS = [1, 3, 8] as const;

function isContextOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /exceeds the context length|context length|too long|input is too large/i.test(message);
}

export class EmbeddingContextOverflowError extends Error {
  readonly inputLength: number;

  constructor(inputLength: number, cause: unknown) {
    super(`Embedder: a ${inputLength}-character input exceeds the model context`, { cause });
    this.name = "EmbeddingContextOverflowError";
    this.inputLength = inputLength;
  }
}

export interface EmbedderOptions {
  /** Resolve a previously unavailable endpoint and establish the DB vector schema. */
  resolveIdentity?: (signal?: AbortSignal) => Promise<ResolvedEmbeddingIdentity>;
  /** The single boot-resolved identity for every vector this instance emits. */
  identity: EmbeddingIdentity;
  /** Inputs per provider request. Default 16. */
  batchSize?: number;
  /** Base retry delay; see {@link RETRY_BACKOFF_STEPS}. Default 250ms. */
  retryDelayMs?: number;
  /** Validated per-note fan-out cap for `embedAll`. */
  concurrency: number;
}

export class Embedder {
  private readonly batchSize: number;
  private readonly retryDelayMs: number;
  private readonly concurrency: number;
  private identity: EmbeddingIdentity;
  private readonly resolveIdentity?: EmbedderOptions["resolveIdentity"];
  private resolving: Promise<ResolvedEmbeddingIdentity> | null = null;

  constructor(
    private readonly provider: LLMProvider,
    opts: EmbedderOptions,
  ) {
    this.resolveIdentity = opts.resolveIdentity;
    this.batchSize = Math.max(1, opts.batchSize ?? 16);
    this.retryDelayMs = opts.retryDelayMs ?? 250;
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 128) {
      throw new Error("Embedder concurrency must be an integer between 1 and 128");
    }
    this.concurrency = opts.concurrency;
    this.identity =
      opts.identity.dimension === null
        ? createEmbeddingIdentity(opts.identity.model, null)
        : createEmbeddingIdentity(opts.identity.model, opts.identity.dimension);
  }

  /** Maximum number of in-flight embedding batches inside `embedAll`. */
  getConcurrency(): number {
    return this.concurrency;
  }

  /** The exact, resolved vector space used by every call from this instance. */
  getIdentity(): ResolvedEmbeddingIdentity {
    return requireResolvedEmbeddingIdentity(this.identity);
  }
  async ensureIdentity(signal?: AbortSignal): Promise<ResolvedEmbeddingIdentity> {
    if (this.identity.dimension !== null) return this.getIdentity();
    if (!this.resolveIdentity) return this.getIdentity();
    if (!this.resolving) {
      this.resolving = this.resolveIdentity(signal)
        .then((identity) => {
          if (identity.model !== this.identity.model)
            throw new Error("resolved embedding model differs from the configured identity");
          this.identity = createEmbeddingIdentity(identity.model, identity.dimension);
          return this.getIdentity();
        })
        .finally(() => {
          this.resolving = null;
        });
    }
    return this.resolving;
  }

  /** Inputs sent per provider request. */
  getBatchSize(): number {
    return this.batchSize;
  }

  async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    if (inputs.length === 0) return [];
    await this.ensureIdentity(signal);
    const out: number[][] = [];
    for (let index = 0; index < inputs.length; index += this.batchSize) {
      const batch = inputs.slice(index, index + this.batchSize);
      const vectors = await this.embedBatchWithRetry(batch, signal);
      out.push(...vectors);
    }
    return out;
  }

  /**
   * Embed every input, batching `batchSize` texts per provider request and
   * keeping up to `concurrency` batches in flight.
   *
   * Output is index-aligned with input. Any rejection propagates once the
   * in-flight batches settle; partial results are never returned.
   */
  async embedAll(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureIdentity(signal);

    const batches: Array<{ offset: number; texts: string[] }> = [];
    for (let index = 0; index < texts.length; index += this.batchSize) {
      batches.push({ offset: index, texts: texts.slice(index, index + this.batchSize) });
    }

    const out: number[][] = new Array(texts.length);
    let cursor = 0;
    const workerCount = Math.min(this.concurrency, batches.length);

    const runWorker = async (): Promise<void> => {
      while (true) {
        const slot = cursor;
        cursor += 1;
        if (slot >= batches.length) return;
        const batch = batches[slot];
        const vectors = await this.embedBatchWithRetry(batch.texts, signal);
        if (vectors.length !== batch.texts.length) {
          throw new Error(
            `Embedder.embedAll: provider returned ${vectors.length} vectors for a batch of ${batch.texts.length}`,
          );
        }
        for (let index = 0; index < vectors.length; index += 1) {
          out[batch.offset + index] = vectors[index];
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return out;
  }

  /**
   * Context overflow is not transient, so it gets a different recovery
   * from network retries: a rejected batch is split until the offending
   * input stands alone. A lone overflow is reported with its exact input
   * length so Tier 2 can split the persisted chunk or quarantine it. The
   * embedder never substitutes a prefix vector for full stored text.
   */
  private async embedBatchWithRetry(batch: string[], signal?: AbortSignal): Promise<number[][]> {
    try {
      const vectors = await this.embedBatchWithNetworkRetry(batch, signal);
      this.assertVectorIdentity(vectors, batch.length);
      return vectors;
    } catch (error) {
      if (!isContextOverflow(error) || signal?.aborted === true) throw error;
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        const head = await this.embedBatchWithRetry(batch.slice(0, mid), signal);
        const tail = await this.embedBatchWithRetry(batch.slice(mid), signal);
        return [...head, ...tail];
      }
      const text = batch[0] ?? "";
      throw new EmbeddingContextOverflowError(text.length, error);
    }
  }

  private async embedBatchWithNetworkRetry(
    batch: string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const totalAttempts = RETRY_BACKOFF_STEPS.length + 1;
    let lastError: unknown;
    let attempted = 0;
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      attempted = attempt;
      try {
        return await this.provider.embed(batch, { model: this.identity.model, signal });
      } catch (error) {
        lastError = error;
        if (signal?.aborted === true) break;
        if (isContextOverflow(error)) break;
        if (attempt < totalAttempts) {
          await sleep(this.retryDelayMs * RETRY_BACKOFF_STEPS[attempt - 1]);
        }
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Embedder: embedding ${batch.length} input(s) with model '${this.identity.model}' failed after ${attempted} attempts: ${detail}`,
      { cause: lastError },
    );
  }

  private assertVectorIdentity(vectors: number[][], expectedCount: number): void {
    const identity = this.getIdentity();
    if (vectors.length !== expectedCount) {
      throw new Error(
        `Embedder: model '${identity.model}' returned ${vectors.length} vectors for ${expectedCount} inputs`,
      );
    }
    const wrongWidth = vectors.findIndex((vector) => vector.length !== identity.dimension);
    if (wrongWidth !== -1) {
      throw new Error(
        `Embedder: model '${identity.model}' returned a ${vectors[wrongWidth].length}-dimension vector at index ${wrongWidth}; boot resolved ${identity.dimension}`,
      );
    }
    const nonFiniteVector = vectors.findIndex((vector) =>
      vector.some((value) => !Number.isFinite(value)),
    );
    if (nonFiniteVector !== -1) {
      throw new Error(
        `Embedder: model '${identity.model}' returned a non-finite vector value at index ${nonFiniteVector}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
