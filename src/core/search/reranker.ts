import type { ReasoningScheduler } from "../coordinator/reasoningScheduler";
import { type EventBus, assertEventBus } from "../events/eventBus";
import type { LLMProvider } from "../llm/provider";
import { RERANK_SCHEMA, buildRerankPrompt } from "./prompts/rerank";
import type { SearchHit } from "./types";

export interface RerankerOptions {
  provider: LLMProvider;
  model: string;
  /** Optional cap on input snippet length to keep the prompt small. */
  snippetMaxChars?: number;
  /** Receives `search:rerank_failed` whenever reranking degrades. */
  bus: EventBus;
}

interface RerankResponse {
  ranking: number[];
}

/**
 * LLM-driven reranker. Candidates are presented to the model as short 1-based
 * integers and the returned integer ranking is mapped back to hits; opaque
 * record ids never reach the prompt.
 *
 * On any failure (provider error, unparseable ranking, no usable index) the
 * reranker falls back to the input order so callers always receive results,
 * and emits `search:rerank_failed` on the bus when one was supplied.
 * AbortError propagates.
 */
export class Reranker {
  constructor(private readonly options: RerankerOptions) {
    assertEventBus(options.bus, "Reranker");
  }

  async rerank(
    query: string,
    hits: SearchHit[],
    topN: number,
    signal: AbortSignal,
    scheduler: ReasoningScheduler,
  ): Promise<SearchHit[]> {
    if (topN <= 0) return [];
    if (hits.length <= 1) return hits.slice(0, topN);
    const snippetCap = this.options.snippetMaxChars ?? 320;
    const candidates = hits.map((hit, index) => ({
      index: index + 1,
      snippet: hit.snippet.slice(0, snippetCap),
    }));
    const messages = buildRerankPrompt({ query, candidates });
    try {
      const response = await scheduler.run(
        "search:rerank",
        (scheduledSignal) =>
          this.options.provider.chatJson<RerankResponse>(
            messages,
            {
              model: this.options.model,
              signal: scheduledSignal,
              temperature: 0.1,
              enableThinking: false,
            },
            RERANK_SCHEMA,
          ),
        { signal },
      );
      const order = parseRankingResponse(response, hits.length);
      return sortByRanking(hits, order).slice(0, topN);
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.reportFailure(
        query,
        hits.length,
        error instanceof Error ? error.message : String(error),
      );
      return hits.slice(0, topN);
    }
  }

  private reportFailure(query: string, candidates: number, message: string): void {
    this.options.bus.emit({ type: "search:rerank_failed", query, candidates, message });
  }
}

/**
 * Decode the exact schema promised to the model. A ranking is useful only if
 * it is a complete permutation: accepting strings, omissions, duplicates, or
 * extra fields would let malformed model output silently influence retrieval.
 */
function parseRankingResponse(raw: unknown, hitCount: number): number[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("reranker response must be the canonical ranking object");
  }
  const response = raw as Record<string, unknown>;
  if (Object.keys(response).length !== 1 || !Array.isArray(response.ranking)) {
    throw new Error("reranker response must contain only the ranking array");
  }
  if (response.ranking.length !== hitCount) {
    throw new Error("reranker ranking must contain every candidate exactly once");
  }
  const out: number[] = [];
  const seen = new Set<number>();
  for (const entry of response.ranking) {
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry < 1 ||
      entry > hitCount
    ) {
      throw new Error("reranker ranking contains an invalid candidate index");
    }
    const position = entry - 1;
    if (seen.has(position)) {
      throw new Error("reranker ranking contains a duplicate candidate index");
    }
    seen.add(position);
    out.push(position);
  }
  return out;
}

/** Hits absent from the ranking keep their input order at the bottom. */
function sortByRanking(hits: SearchHit[], order: number[]): SearchHit[] {
  const rank = new Map<number, number>();
  for (let index = 0; index < order.length; index += 1) {
    rank.set(order[index], index);
  }
  return hits
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => {
      const ar = rank.get(a.index);
      const br = rank.get(b.index);
      if (ar === undefined && br === undefined) return a.index - b.index;
      if (ar === undefined) return 1;
      if (br === undefined) return -1;
      return ar - br;
    })
    .map((entry) => entry.hit);
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}
