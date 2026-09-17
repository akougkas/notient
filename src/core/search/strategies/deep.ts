import type { Surreal } from "surrealdb";
import type { ReasoningScheduler } from "../../coordinator/reasoningScheduler";
import { type SearchChunkRow, searchBm25, searchVectorWithPath } from "../../db/surreal";
import type { LLMProvider } from "../../llm/provider";
import { buildChunkNoteFilter, withQueryPhrases } from "../filters";
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
  synthesisEnabled: boolean;
  signal: AbortSignal;
  scheduler: ReasoningScheduler;
  /** Optional ef forwarded to the HNSW search operator. */
  ef?: number;
}

export interface DeepSearchOutput {
  hits: SearchHit[];
  synthesis: SynthesisCard | null;
}

export type DeepSearchEvent = SearchEvent | { type: "deep:result"; output: DeepSearchOutput };

/**
 * Reciprocal-rank-fusion constant. The two retrieval arms produce scores on
 * incomparable scales (cosine distance vs BM25). RRF fuses rank lists instead
 * of scores, avoiding scale-sensitive normalization. k = 60 is the standard
 * value from Cormack et al. 2009.
 */
const RRF_K = 60;
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
 * same `chunk` table and fuses the candidate sets in JS with weighted
 * reciprocal rank fusion (k = 60, 0.7 kNN / 0.3 BM25). Filters compose as
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
        scheduler: options.scheduler,
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
  const fragment = withQueryPhrases(options.query, buildChunkNoteFilter(options.filters));
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
  const fused = dedupeByNote(fuseHybridRows(knnRows, bm25Rows));
  const initial: SearchHit[] = fused.slice(0, options.topK).map((entry) => ({
    notePath: entry.notePath,
    chunkId: entry.chunkId.toString(),
    snippet: entry.text.slice(0, 240),
    score: entry.score,
    matchedText: options.query,
  }));
  if (initial.length === 0) return [];
  return options.reranker.rerank(
    options.query,
    initial,
    options.rerankTopN,
    options.signal,
    options.scheduler,
  );
}

export interface FusedRow extends SearchChunkRow {
  /** RRF score used for sorting before the rerank pass. */
  score: number;
}

/**
 * Weighted reciprocal rank fusion over the kNN and BM25 rank lists.
 *
 * `score(d) = 0.7 / (k + rank_knn(d)) + 0.3 / (k + rank_bm25(d))`, ranks
 * 1-based, a missing arm contributing nothing. Exported for unit tests.
 */
export function fuseHybridRows(knn: SearchChunkRow[], bm25: SearchChunkRow[]): FusedRow[] {
  const merged = new Map<string, FusedRow>();
  for (let index = 0; index < knn.length; index += 1) {
    const row = knn[index];
    const key = row.chunkId.toString();
    const existing = merged.get(key);
    const contribution = KNN_WEIGHT / (RRF_K + index + 1);
    if (existing === undefined) {
      merged.set(key, { ...row, score: contribution });
      continue;
    }
    existing.score += contribution;
  }
  for (let index = 0; index < bm25.length; index += 1) {
    const row = bm25[index];
    const key = row.chunkId.toString();
    const contribution = BM25_WEIGHT / (RRF_K + index + 1);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...row, score: contribution });
      continue;
    }
    existing.bm25Score = row.bm25Score;
    existing.score += contribution;
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

/**
 * Keeps the best-scoring chunk per note. RRF dedupes by chunk id, so a single
 * long note could contribute every candidate in the topK window and hide the
 * rest of the vault behind its own paragraphs. Quick search dedupes per note
 * for the same reason; this is the deep-mode equivalent, applied after fusion
 * so ranking still sees every chunk. Input must be sorted by score descending,
 * which is what `fuseHybridRows` returns.
 */
export function dedupeByNote(rows: FusedRow[]): FusedRow[] {
  const seen = new Set<string>();
  const out: FusedRow[] = [];
  for (const row of rows) {
    if (seen.has(row.notePath)) continue;
    seen.add(row.notePath);
    out.push(row);
  }
  return out;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}
