import type { SearchPipeline } from "../../core/search/searchPipeline";
import type { SearchFilters, SearchMode, SearchQuery } from "../../core/search/types";
import { encodeEvent } from "../rpc";

export interface SearchHandlerDeps {
  pipeline: SearchPipeline;
  bridgeUp: () => boolean;
}

function parseSearchParams(params: Record<string, unknown>, bridgeUp: () => boolean): SearchQuery {
  const query = typeof params.query === "string" ? params.query : "";
  if (query.trim().length === 0) {
    throw new Error("INVALID_PARAMS: query is required");
  }
  const mode = (typeof params.mode === "string" ? params.mode : "balanced") as SearchMode;
  if (mode === "quick" && !bridgeUp()) {
    throw new Error(
      "BRIDGE_DOWN: notient search mode=quick wraps Obsidian's native search; start Obsidian or pass mode=balanced",
    );
  }
  const filters = (params.filters as SearchFilters | undefined) ?? {};
  const limit = typeof params.limit === "number" ? params.limit : undefined;
  return { query, mode, filters, limit };
}

export function makeSearchHandler(deps: SearchHandlerDeps) {
  return async (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const searchQuery = parseSearchParams(params, deps.bridgeUp);
    const controller = new AbortController();
    let lastResult: unknown = null;
    for await (const event of deps.pipeline.run(searchQuery, controller.signal)) {
      emit(encodeEvent(envelopeId, event.type, event as unknown as Record<string, unknown>));
      if (event.type === "search:done") lastResult = event.result;
    }
    return { ok: true, result: lastResult };
  };
}
