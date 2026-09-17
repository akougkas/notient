import type { Surreal } from "surrealdb";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import {
  type IndexingReadiness,
  searchCoverage,
  unknownIndexingReadiness,
} from "../../api/indexing";
import type { ReasoningScheduler } from "../coordinator/reasoningScheduler";
import type { LLMProvider } from "../llm/provider";
import type { Reranker } from "./reranker";
import { NoteRetrieval } from "./retrieval";
import { balancedSearch } from "./strategies/balanced";
import { deepSearch } from "./strategies/deep";
import { quickSearch } from "./strategies/quick";
import type { SearchEvent, SearchHit, SearchQuery, SearchResult, SynthesisCard } from "./types";

export interface SearchPipelineSettings {
  balanced: { topK: number; rerankTopN: number };
  deep: { synthesisEnabled: boolean };
}

export interface SearchPipelineDependencies {
  indexing?: () => IndexingReadiness;
  vault?: Pick<VaultAdapter, "read" | "readBounded" | "listMarkdown" | "isIndexablePath">;
  db: Surreal;
  reranker: Reranker;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  provider: LLMProvider;
  reasoningModel: string;
  scheduler: ReasoningScheduler;
  settings: () => SearchPipelineSettings;
  now?: () => number;
}

/**
 * Search pipeline. Exposes `run(query, signal)` returning an
 * `AsyncIterable<SearchEvent>` so streaming Deep mode can emit retrieval,
 * expansion, and synthesis progress separately. Quick and Balanced both
 * yield a single `search:hits` event followed by `search:done`.
 *
 * Retrieval reads SurrealDB directly: kNN over `chunk.vector` via HNSW, BM25
 * over `chunk.text` via the `chunk_text` full-text index, and one-hop graph
 * expansion over committed relationships.
 */
export class SearchPipeline {
  private readonly retrieval: NoteRetrieval | null;
  constructor(private readonly deps: SearchPipelineDependencies) {
    this.retrieval = deps.vault
      ? new NoteRetrieval({
          db: deps.db,
          vault: deps.vault,
          embed: deps.embed,
          indexing: deps.indexing,
        })
      : null;
    if (typeof deps.settings !== "function") {
      throw new Error("SearchPipeline settings must be a function");
    }
    assertSearchSettings(deps.settings());
  }

  retrieve(input: unknown, signal: AbortSignal) {
    if (!this.retrieval) throw new Error("note retrieval requires the vault read authority");
    return this.retrieval.search(input, signal);
  }

  context(input: unknown, signal: AbortSignal) {
    if (!this.retrieval) throw new Error("context retrieval requires the vault read authority");
    return this.retrieval.context(input, signal);
  }

  async *run(query: SearchQuery, signal: AbortSignal): AsyncIterable<SearchEvent> {
    const now = this.deps.now ?? (() => Math.round(performance.now()));
    const start = now();
    const indexing = this.indexing();
    const limit = resolveLimit(query.limit);
    yield { type: "search:retrieving", mode: query.mode };
    if (signal.aborted) {
      yield { type: "search:error", message: "aborted" };
      return;
    }
    if (query.mode === "deep") {
      yield* this.runDeep(query, limit, signal, start, now, indexing);
      return;
    }
    try {
      const hits = await this.executeNonDeep(query, limit, signal);
      yield { type: "search:hits", hits };
      const result: SearchResult = {
        coverage: searchCoverage(indexing, this.indexing()),
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
    const settings = this.readSettings();
    return balancedSearch({
      db: this.deps.db,
      embed: this.deps.embed,
      reranker: this.deps.reranker,
      query: query.query,
      filters: query.filters,
      topK: settings.balanced.topK,
      rerankTopN: Math.min(limit, settings.balanced.rerankTopN),
      signal,
      scheduler: this.deps.scheduler,
    });
  }

  private async *runDeep(
    query: SearchQuery,
    limit: number,
    signal: AbortSignal,
    start: number,
    now: () => number,
    indexing: IndexingReadiness,
  ): AsyncIterable<SearchEvent> {
    let output: { hits: SearchHit[]; synthesis: SynthesisCard | null } = {
      hits: [],
      synthesis: null,
    };
    try {
      const settings = this.readSettings();
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
        synthesisEnabled: settings.deep.synthesisEnabled,
        signal,
        scheduler: this.deps.scheduler,
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
      coverage: searchCoverage(indexing, this.indexing()),
      query: query.query,
      mode: query.mode,
      hits: output.hits,
      durationMs: now() - start,
      synthesis: output.synthesis,
    };
    yield { type: "search:done", result };
  }

  private indexing(): IndexingReadiness {
    return this.deps.indexing?.() ?? unknownIndexingReadiness();
  }

  private readSettings(): SearchPipelineSettings {
    const settings = this.deps.settings();
    assertSearchSettings(settings);
    return settings;
  }
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("search limit must be a safe integer from 1 through 50");
  }
  return limit;
}

function assertSearchSettings(raw: unknown): asserts raw is SearchPipelineSettings {
  if (!isRecord(raw) || !isRecord(raw.balanced) || !isRecord(raw.deep)) {
    throw new Error("SearchPipeline settings are invalid");
  }
  const topK = raw.balanced.topK;
  const rerankTopN = raw.balanced.rerankTopN;
  if (
    typeof topK !== "number" ||
    !Number.isSafeInteger(topK) ||
    topK < 1 ||
    topK > 1_000 ||
    typeof rerankTopN !== "number" ||
    !Number.isSafeInteger(rerankTopN) ||
    rerankTopN < 1 ||
    rerankTopN > topK ||
    typeof raw.deep.synthesisEnabled !== "boolean"
  ) {
    throw new Error("SearchPipeline settings are invalid");
  }
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
