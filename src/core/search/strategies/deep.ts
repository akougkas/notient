import type { Database } from "../../db/database";
import type { VectorIndex } from "../../indexer/vectorIndex";
import type { LLMProvider } from "../../llm/provider";
import { expandViaApprovedEdges } from "../graphExpansion";
import type { Reranker } from "../reranker";
import { synthesize } from "../synthesis";
import type { SearchEvent, SearchFilters, SearchHit, SynthesisCard } from "../types";
import { balancedSearch } from "./balanced";

export interface DeepSearchOptions {
  db: Database;
  provider: LLMProvider;
  vectorIndex: VectorIndex;
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
}

export interface DeepSearchOutput {
  hits: SearchHit[];
  synthesis: SynthesisCard | null;
}

export type DeepSearchEvent = SearchEvent | { type: "deep:result"; output: DeepSearchOutput };

/**
 * Deep search: balanced retrieval + 1-hop graph expansion via approved edges
 * + grounded LLM synthesis with `[[wikilink]]` citations. Streams progress
 * events so the UI can render a multi-stage card. Synthesis failures never
 * throw out of the strategy: a stub `SynthesisCard` with an `error` field is
 * returned on the result event and the pipeline still emits `search:done`.
 */
export async function* deepSearch(
  options: DeepSearchOptions,
): AsyncGenerator<DeepSearchEvent, void, void> {
  yield { type: "search:retrieving", mode: "deep" };
  if (options.signal.aborted) {
    yield { type: "search:error", message: "aborted" };
    return;
  }
  const baseHits = await balancedSearch({
    db: options.db,
    vectorIndex: options.vectorIndex,
    embed: options.embed,
    reranker: options.reranker,
    query: options.query,
    filters: options.filters,
    topK: options.topK,
    rerankTopN: options.rerankTopN,
    signal: options.signal,
  });
  yield { type: "search:hits", hits: baseHits };

  yield { type: "search:expanding", baseHitCount: baseHits.length };
  const expandedHits = expandViaApprovedEdges({
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
      synthesis = await synthesize({
        provider: options.provider,
        model: options.reasoningModel,
        query: options.query,
        hits: allHits,
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

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}
