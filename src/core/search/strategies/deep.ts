import type { Surreal } from "surrealdb";
import { type SearchChunkRow, searchBm25, searchVectorWithPath } from "../../db/surreal";
import type { LLMProvider } from "../../llm/provider";
import { buildChunkNoteFilter } from "../filters";
import { expandViaApprovedEdges } from "../graphExpansion";
import type { Reranker } from "../reranker";
import { synthesize } from "../synthesis";
import type { SearchEvent, SearchFilters, SearchHit, SynthesisCard } from "../types";

export interface DeepSearchOptions {
  db: Surreal;
  provider: LLMProvider;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  reranker: Reranker;
  reasoningModel: string;
  query: string;
  filters?: SearchFilters;
  topK: number;
  rerankTopN: number;
  graphDepth: number;
  synthesisEnabled: boolean;
  signal: AbortSignal;
  /** Optional ef forwarded to the HNSW search operator. */
  ef?: number;
}

export interface DeepSearchOutput {
  hits: SearchHit[];
  synthesis: SynthesisCard | null;
}

export type DeepSearchEvent = SearchEvent | { type: "deep:result"; output: DeepSearchOutput };

const KNN_WEIGHT = 0.7;
const BM25_WEIGHT = 0.3;

/**
 * Deep search: hybrid kNN + BM25 retrieval against SurrealDB followed by an
 * LLM rerank, 1-hop graph expansion via approved-and-applied wikilink edges,
 * and a grounded LLM synthesis with `[[wikilink]]` citations. Streams progress
 * events so the UI can render a multi-stage card. Synthesis failures never
 * throw out of the strategy: a stub `SynthesisCard` with an `error` field is
 * returned on the result event and the pipeline still emits `search:done`.
 *
 * The hybrid retrieval issues two SurrealQL queries (kNN and BM25) against the
 * same `chunk` table and fuses the candidate sets in JS using the
 * `0.7 * (1 - distance) + 0.3 * normalisedBm25` weighting. Filters compose as
 * additional WHERE predicates inside both queries so date/folder/maturity
 * constraints are pushed down server-side.
 */
export async function* deepSearch(
  options: DeepSearchOptions,
): AsyncGenerator<DeepSearchEvent, void, void> {
  yield { type: "search:retrieving", mode: "deep" };
  if (options.signal.aborted) {
    yield { type: "search:error", message: "aborted" };
    return;
  }
  const baseHits = await retrieveBaseHits(options);
  yield { type: "search:hits", hits: baseHits };

  yield { type: "search:expanding", baseHitCount: baseHits.length };
  const expandedHits = await expandViaApprovedEdges({
    db: options.db,
    baseHits,
    depth: options.graphDepth,
  });
  yield { type: "search:graph-expansion", addedHitCount: expandedHits.length };
  const allHits: SearchHit[] = [...baseHits, ...expandedHits];

  let synthesis: SynthesisCard | null = null;
  if (options.synthesisEnabled && baseHits.length > 0) {
    yield { type: "search:synthesizing" };
    try {
      // Synthesis grounds bullets in note content; graph-expanded hits carry
      // a `via [[...]]` placeholder instead of real chunk text and would
      // dilute the prompt without adding evidence. Pass only the base hits.
      synthesis = await synthesize({
        provider: options.provider,
        model: options.reasoningModel,
        query: options.query,
        hits: baseHits,
        signal: options.signal,
      });
      yield { type: "search:synthesis-done", card: synthesis };
    } catch (error) {
      if (isAbortError(error)) {
        yield { type: "search:error", message: "aborted" };
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      synthesis = { bullets: [], rawText: "", error: message };
      yield { type: "search:synthesis-done", card: synthesis };
    }
  }

  yield { type: "deep:result", output: { hits: allHits, synthesis } };
}

async function retrieveBaseHits(options: DeepSearchOptions): Promise<SearchHit[]> {
  if (options.rerankTopN <= 0) return [];
  const embedding = await options.embed(options.query, options.signal);
  const fragment = buildChunkNoteFilter(options.filters);
  const knnRows: SearchChunkRow[] = embedding
    ? await searchVectorWithPath(options.db, {
        vector: Array.from(embedding),
        k: options.topK,
        ...(options.ef !== undefined ? { ef: options.ef } : {}),
        extraWhere: fragment.where,
        extraBindings: fragment.bindings,
      })
    : [];
  const bm25Rows = await searchBm25(options.db, {
    query: options.query,
    limit: options.topK,
    extraWhere: fragment.where,
    extraBindings: fragment.bindings,
  });
  if (knnRows.length === 0 && bm25Rows.length === 0) return [];
  const fused = fuseHybridRows(knnRows, bm25Rows);
  const initial: SearchHit[] = fused.slice(0, options.topK).map((entry) => ({
    notePath: entry.notePath,
    chunkId: entry.chunkId.toString(),
    snippet: entry.text.slice(0, 240),
    score: entry.score,
    matchedText: options.query,
  }));
  if (initial.length === 0) return [];
  return options.reranker.rerank(options.query, initial, options.rerankTopN, options.signal);
}

interface FusedRow extends SearchChunkRow {
  /** Composite score in [0, ~1] used for sorting before the rerank pass. */
  score: number;
}

function fuseHybridRows(knn: SearchChunkRow[], bm25: SearchChunkRow[]): FusedRow[] {
  const maxBm25 = bm25.reduce((acc, row) => {
    const score = row.bm25Score ?? 0;
    return score > acc ? score : acc;
  }, 0);
  const merged = new Map<string, FusedRow>();
  for (const row of knn) {
    const key = row.chunkId.toString();
    const knnComponent = row.distance === null ? 0 : Math.max(0, 1 - row.distance);
    merged.set(key, { ...row, score: KNN_WEIGHT * knnComponent });
  }
  for (const row of bm25) {
    const key = row.chunkId.toString();
    const bm25Component = maxBm25 === 0 ? 0 : (row.bm25Score ?? 0) / maxBm25;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...row, score: BM25_WEIGHT * bm25Component });
      continue;
    }
    existing.bm25Score = row.bm25Score;
    existing.score += BM25_WEIGHT * bm25Component;
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}
