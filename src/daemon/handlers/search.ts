import { searchCoverageSchema } from "../../api/indexing";
import { NoteApiError } from "../../api/schema";
import {
  parseCanonicalSearchFilters,
  parseCanonicalSearchLimit,
} from "../../core/search/searchInput";
import type { SearchPipeline } from "../../core/search/searchPipeline";
import type { SearchHit, SearchMode, SearchQuery, SearchResult } from "../../core/search/types";
import { isCanonicalOrdinaryNotePath } from "../../core/vault/publicPath";
import { type MethodHandler, RpcError, encodeEvent } from "../rpc";

export interface SearchHandlerDeps {
  pipeline: SearchPipeline;
  /**
   * Live vault default for `search.defaultMode`, read on every call so a
   * settings change takes effect without a daemon restart.
   */
  defaultMode: () => SearchMode;
}

const SEARCH_MODES: readonly SearchMode[] = ["quick", "balanced", "deep"];
const SEARCH_PARAM_FIELDS = ["query", "mode", "filters", "limit"] as const;

function parseSearchParams(
  params: Record<string, unknown>,
  defaultMode: () => SearchMode,
): SearchQuery {
  if (!hasOnlyKeys(params, SEARCH_PARAM_FIELDS)) {
    throw new RpcError("INVALID_PARAMS", "search.run received an unknown parameter");
  }
  const query = params.query;
  if (typeof query !== "string" || query.length === 0 || query.trim() !== query) {
    throw new RpcError("INVALID_PARAMS", "query must be a canonical nonblank string");
  }
  let mode: SearchMode;
  if (params.mode === undefined) {
    mode = parseSearchMode(defaultMode(), "search.defaultMode");
  } else if (typeof params.mode === "string" && SEARCH_MODES.includes(params.mode as SearchMode)) {
    mode = params.mode as SearchMode;
  } else {
    throw new RpcError("INVALID_PARAMS", "mode must be one of quick|balanced|deep");
  }
  const filters = parseInvalidParams(() => parseCanonicalSearchFilters(params.filters));
  const limit = parseInvalidParams(() => parseCanonicalSearchLimit(params.limit));
  return {
    query,
    mode,
    ...(filters === undefined ? {} : { filters }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function makeSearchHandler(deps: SearchHandlerDeps): MethodHandler {
  return async ({ params, emit, requestId }) => {
    if (["lexical", "semantic", "hybrid"].includes(String(params.mode))) {
      try {
        return await deps.pipeline.retrieve(params, AbortSignal.timeout(120000));
      } catch (error) {
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        throw error;
      }
    }
    const searchQuery = parseSearchParams(params, deps.defaultMode);
    const controller = new AbortController();
    let lastResult: SearchResult | null = null;
    for await (const event of deps.pipeline.run(searchQuery, controller.signal)) {
      emit(encodeEvent(requestId, event.type, event as unknown as Record<string, unknown>));
      if (event.type === "search:error") {
        throw new Error(`search pipeline failed: ${event.message}`);
      }
      if (event.type === "search:done") {
        if (lastResult !== null)
          throw new Error("search pipeline emitted search:done more than once");
        assertSearchResult(event.result, searchQuery);
        lastResult = event.result;
      }
    }
    if (lastResult === null) throw new Error("search pipeline ended without search:done");
    return { ok: true, result: lastResult };
  };
}

function parseSearchMode(raw: unknown, label: string): SearchMode {
  if (typeof raw !== "string" || !SEARCH_MODES.includes(raw as SearchMode)) {
    throw new Error(`${label} must be one of quick|balanced|deep`);
  }
  return raw as SearchMode;
}

function parseInvalidParams<Value>(parse: () => Value): Value {
  try {
    return parse();
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid search parameters";
    throw new RpcError("INVALID_PARAMS", message);
  }
}

function assertSearchResult(raw: unknown, query: SearchQuery): asserts raw is SearchResult {
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(raw, ["query", "mode", "hits", "durationMs", "synthesis", "coverage"]) ||
    !searchCoverageSchema.safeParse(raw.coverage).success ||
    raw.query !== query.query ||
    raw.mode !== query.mode ||
    !Array.isArray(raw.hits) ||
    typeof raw.durationMs !== "number" ||
    !Number.isSafeInteger(raw.durationMs) ||
    raw.durationMs < 0
  ) {
    throw new Error("search pipeline returned a malformed terminal result");
  }
  const seenPaths = new Set<string>();
  for (const hit of raw.hits) {
    assertSearchHit(hit);
    if (seenPaths.has(hit.notePath)) {
      throw new Error("search pipeline returned duplicate note hits");
    }
    seenPaths.add(hit.notePath);
  }
}

function assertSearchHit(raw: unknown): asserts raw is SearchHit {
  if (
    !isRecord(raw) ||
    typeof raw.notePath !== "string" ||
    raw.notePath.length === 0 ||
    raw.notePath.trim() !== raw.notePath ||
    !isCanonicalOrdinaryNotePath(raw.notePath) ||
    !(raw.chunkId === null || (typeof raw.chunkId === "string" && raw.chunkId.length > 0)) ||
    typeof raw.snippet !== "string" ||
    typeof raw.matchedText !== "string" ||
    typeof raw.score !== "number" ||
    !Number.isFinite(raw.score) ||
    raw.score < 0
  ) {
    throw new Error("search pipeline returned a malformed hit");
  }
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function hasOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(raw).every((key) => allowed.includes(key));
}
