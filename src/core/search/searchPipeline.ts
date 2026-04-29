import type { Surreal } from "surrealdb";
import type { LLMProvider } from "../llm/provider";
import type { Reranker } from "./reranker";
import { balancedSearch } from "./strategies/balanced";
import { deepSearch } from "./strategies/deep";
import { quickSearch } from "./strategies/quick";
import type { SearchEvent, SearchHit, SearchQuery, SearchResult, SynthesisCard } from "./types";

export interface SearchPipelineSettings {
  balanced: { topK: number; rerankTopN: number };
  deep: { graphExpansionDepth: number; synthesisEnabled: boolean };
}

export interface SearchPipelineDependencies {
  db: Surreal;
  reranker: Reranker;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  provider: LLMProvider;
  reasoningModel: string;
  settings: () => SearchPipelineSettings;
  now?: () => number;
}

/**
 * Search pipeline. Exposes `run(query, signal)` returning an
 * `AsyncIterable<SearchEvent>` so streaming Deep mode can emit retrieval,
 * expansion, and synthesis progress separately. Quick and Balanced both
 * yield a single `search:hits` event followed by `search:done`.
 *
 * Phase 4 Task 11 reads everything through SurrealDB: kNN over `chunk.vector`
 * via the HNSW index, BM25 over `chunk.text` via the `chunk_text` full-text
 * index, and graph expansion via the `wikilink` relation. The legacy SQLite
 * `chunks`/`notes`/`graph_edges` reads and the in-process HNSW vector index
 * are gone.
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
    if (query.mode === "deep") {
      yield* this.runDeep(query, limit, signal, start, now);
      return;
    }
    try {
      const hits = await this.executeNonDeep(query, limit, signal);
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

  private async executeNonDeep(
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
    const settings = this.deps.settings();
    return balancedSearch({
      db: this.deps.db,
      embed: this.deps.embed,
      reranker: this.deps.reranker,
      query: query.query,
      filters: query.filters,
      topK: settings.balanced.topK,
      rerankTopN: Math.min(limit, settings.balanced.rerankTopN),
      signal,
    });
  }

  private async *runDeep(
    query: SearchQuery,
    limit: number,
    signal: AbortSignal,
    start: number,
    now: () => number,
  ): AsyncIterable<SearchEvent> {
    const settings = this.deps.settings();
    let output: { hits: SearchHit[]; synthesis: SynthesisCard | null } = {
      hits: [],
      synthesis: null,
    };
    try {
      const events = deepSearch({
        db: this.deps.db,
        provider: this.deps.provider,
        embed: this.deps.embed,
        reranker: this.deps.reranker,
        reasoningModel: this.deps.reasoningModel,
        query: query.query,
        filters: query.filters,
        topK: settings.balanced.topK,
        rerankTopN: Math.min(limit, settings.balanced.rerankTopN),
        graphDepth: settings.deep.graphExpansionDepth,
        synthesisEnabled: settings.deep.synthesisEnabled,
        signal,
      });
      for await (const event of events) {
        if (event.type === "deep:result") {
          output = event.output;
          continue;
        }
        if (event.type === "search:retrieving") continue;
        yield event;
        if (event.type === "search:error") return;
      }
    } catch (error) {
      yield {
        type: "search:error",
        message: error instanceof Error ? error.message : String(error),
      };
      return;
    }
    const result: SearchResult = {
      query: query.query,
      mode: query.mode,
      hits: output.hits,
      durationMs: now() - start,
      synthesis: output.synthesis,
    };
    yield { type: "search:done", result };
  }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) return 5;
  if (limit < 1) return 1;
  if (limit > 50) return 50;
  return Math.floor(limit);
}
