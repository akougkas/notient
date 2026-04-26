import type { Database } from "../db/database";
import type { VectorIndex } from "../indexer/vectorIndex";
import type { Reranker } from "./reranker";
import { balancedSearch } from "./strategies/balanced";
import { quickSearch } from "./strategies/quick";
import type { SearchEvent, SearchHit, SearchQuery, SearchResult } from "./types";

export interface SearchPipelineSettings {
  balanced: { topK: number; rerankTopN: number };
}

export interface SearchPipelineDependencies {
  db: Database;
  vectorIndex: VectorIndex;
  reranker: Reranker;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  settings: () => SearchPipelineSettings;
  now?: () => number;
}

export class DeepNotImplementedError extends Error {
  constructor() {
    super("Deep search mode is implemented in Task 7.");
    this.name = "DeepNotImplementedError";
  }
}

/**
 * Search pipeline. Exposes `run(query, signal)` returning an
 * `AsyncIterable<SearchEvent>` so streaming Deep mode can emit retrieval,
 * expansion, and synthesis progress separately. Quick and Balanced both
 * yield a single `search:hits` event followed by `search:done`.
 */
export class SearchPipeline {
  constructor(private readonly deps: SearchPipelineDependencies) {}

  async *run(query: SearchQuery, signal: AbortSignal): AsyncIterable<SearchEvent> {
    const now = this.deps.now ?? (() => Date.now());
    const start = now();
    const limit = clampLimit(query.limit);
    yield { type: "search:retrieving", mode: query.mode };
    if (signal.aborted) {
      yield { type: "search:error", message: "aborted" };
      return;
    }
    try {
      const hits = await this.execute(query, limit, signal);
      yield { type: "search:hits", hits };
      const result: SearchResult = {
        query: query.query,
        mode: query.mode,
        hits,
        durationMs: now() - start,
      };
      yield { type: "search:done", result };
    } catch (error) {
      yield {
        type: "search:error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async execute(
    query: SearchQuery,
    limit: number,
    signal: AbortSignal,
  ): Promise<SearchHit[]> {
    if (query.mode === "quick") {
      return quickSearch({
        db: this.deps.db,
        query: query.query,
        filters: query.filters,
        limit,
      });
    }
    if (query.mode === "balanced") {
      const settings = this.deps.settings();
      return balancedSearch({
        db: this.deps.db,
        vectorIndex: this.deps.vectorIndex,
        embed: this.deps.embed,
        reranker: this.deps.reranker,
        query: query.query,
        filters: query.filters,
        topK: settings.balanced.topK,
        rerankTopN: Math.min(limit, settings.balanced.rerankTopN),
        signal,
      });
    }
    throw new DeepNotImplementedError();
  }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) return 5;
  if (limit < 1) return 1;
  if (limit > 50) return 50;
  return Math.floor(limit);
}
