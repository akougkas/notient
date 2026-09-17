import type { Surreal } from "surrealdb";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { NoteCatalogService } from "../../api/catalog";
import {
  type IndexingReadiness,
  searchCoverage,
  unknownIndexingReadiness,
} from "../../api/indexing";
import { NoteReadService, sourceRange } from "../../api/notes";
import { operationInputs } from "../../api/operations";
import type { ContextResult, RetrievalHit, RetrievalResult } from "../../api/retrieval";
import { NoteApiError, type NoteReadResult, type SourceReference } from "../../api/schema";
import { scopeAllows } from "../../api/scope";
import {
  type SearchChunkRow,
  listNotePaths,
  searchBm25,
  searchVectorWithPath,
} from "../db/surreal";
import { withQueryPhrases } from "./filters";
import { dedupeByNote, fuseHybridRows } from "./strategies/deep";
import { significantTerms } from "./strategies/quick";

export interface RetrievalDependencies {
  indexing?: () => IndexingReadiness;
  db: Surreal;
  vault: Pick<VaultAdapter, "read" | "readBounded" | "listMarkdown" | "isIndexablePath">;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
}

/** Retrieval stage shared by the search pipeline, domain tools and all transports. */
export class NoteRetrieval {
  private readonly notes: NoteReadService;
  private readonly catalog: NoteCatalogService;
  constructor(private readonly deps: RetrievalDependencies) {
    this.notes = new NoteReadService(deps.vault);
    this.catalog = new NoteCatalogService(deps.vault);
  }

  async search(input: unknown, signal: AbortSignal): Promise<RetrievalResult> {
    const parsed = operationInputs["search.run"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const request = parsed.data;
    const start = performance.now();
    const indexing = this.deps.indexing?.() ?? unknownIndexingReadiness();
    signal.throwIfAborted();
    const candidates = (await listNotePaths(this.deps.db)).filter((path) =>
      this.deps.vault.isIndexablePath(path),
    );
    const paths = await this.catalog.filterCandidates(candidates, request.scope, signal);
    const base = {
      coverage: searchCoverage(indexing, this.deps.indexing?.() ?? unknownIndexingReadiness()),
      ok: true as const,
      query: request.query,
      mode: request.mode,
      hits: [] as RetrievalHit[],
      omitted: 0,
      durationMs: 0,
    };
    if (!paths.length) {
      base.durationMs = Math.round(performance.now() - start);
      return base;
    }
    const admitted = new Set(paths);
    const fragment = withQueryPhrases(request.query, {
      where: " AND note.path IN $f_paths",
      bindings: { f_paths: paths },
    });
    const filter = { extraWhere: fragment.where, extraBindings: fragment.bindings };
    const cap = Math.min(1000, request.limit * 8);
    let lexical: SearchChunkRow[] = [];
    let semantic: SearchChunkRow[] = [];
    let semanticUnavailable = false;
    if (request.mode !== "semantic") {
      lexical = await searchBm25(this.deps.db, { query: request.query, limit: cap, ...filter });
      if (!lexical.length) {
        const byId = new Map<string, SearchChunkRow>();
        for (const term of significantTerms(request.query)) {
          signal.throwIfAborted();
          for (const row of await searchBm25(this.deps.db, {
            query: term,
            limit: cap,
            ...filter,
          })) {
            const previous = byId.get(row.chunkId.toString());
            byId.set(row.chunkId.toString(), {
              ...row,
              bm25Score: (previous?.bm25Score ?? 0) + (row.bm25Score ?? 0),
            });
          }
        }
        lexical = [...byId.values()]
          .sort((a, b) => (b.bm25Score ?? 0) - (a.bm25Score ?? 0))
          .slice(0, cap);
      }
    }
    if (request.mode !== "lexical") {
      let vector: Float32Array | null = null;
      try {
        // Hybrid search can still answer lexically during inference outages.
        // Bound the optional network stage; a caller cancellation still aborts
        // the entire query. Pure semantic requests retain explicit failures.
        const embeddingSignal =
          request.mode === "hybrid"
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : signal;
        vector = await this.deps.embed(request.query, embeddingSignal);
        if (!vector) throw new Error("embedding returned no query vector");
      } catch (error) {
        signal.throwIfAborted();
        if (request.mode === "semantic")
          throw new NoteApiError(
            "INFERENCE_UNAVAILABLE",
            `semantic retrieval unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        semanticUnavailable = true;
      }
      // Database/schema integrity errors are not embedding outages and must
      // not be concealed behind a fallback.
      if (vector)
        semantic = await searchVectorWithPath(this.deps.db, {
          vector: [...vector],
          k: cap,
          ...filter,
        });
    }
    const rows =
      request.mode === "hybrid"
        ? dedupeByNote(fuseHybridRows(semantic, lexical))
        : request.mode === "lexical"
          ? lexical
          : semantic;
    const seen = new Set<string>();
    for (const row of rows) {
      signal.throwIfAborted();
      if (seen.has(row.notePath)) continue;
      if (!admitted.has(row.notePath) || !this.deps.vault.isIndexablePath(row.notePath)) {
        base.omitted++;
        continue;
      }
      seen.add(row.notePath);
      let note: NoteReadResult;
      try {
        note = await this.notes.read({ path: row.notePath });
      } catch (error) {
        if (
          (error instanceof NoteApiError && error.code === "NOT_FOUND") ||
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          base.omitted++;
          continue;
        }
        throw error;
      }
      // Recheck live metadata after querying: neither index lag nor a racing
      // exclusion/tag change may broaden the admitted source set.
      if (!scopeAllows(request.scope, note.note.path, note.structure.tags)) {
        base.omitted++;
        continue;
      }
      const indexedRevision = row.sourceRevision ?? null;
      const state =
        indexedRevision === null
          ? "unknown"
          : indexedRevision === note.note.revision
            ? "current"
            : "lagging";
      const evidence = state === "current" ? evidenceForChunk(note, row) : null;
      base.hits.push({
        note: note.note,
        score:
          request.mode === "hybrid"
            ? (row as SearchChunkRow & { score: number }).score
            : request.mode === "lexical"
              ? (row.bm25Score ?? 0)
              : 1 - (row.distance ?? 1),
        scoreKind:
          request.mode === "hybrid"
            ? "reciprocal-rank"
            : request.mode === "lexical"
              ? "bm25"
              : "cosine-similarity",
        evidence,
        freshness: {
          indexedRevision,
          state,
          reason:
            state !== "current"
              ? "Indexed text is not established for the current file revision."
              : evidence === null
                ? "No bounded exact passage resolved for this chunk."
                : null,
        },
      });
      if (base.hits.length >= request.limit) break;
    }
    base.coverage = searchCoverage(indexing, this.deps.indexing?.() ?? unknownIndexingReadiness());
    if (semanticUnavailable)
      base.coverage = {
        ...base.coverage,
        state: "incomplete",
        message: [
          "Semantic retrieval was unavailable; these are lexical results only. Conceptual matches may be missing.",
          base.coverage.message,
        ]
          .filter(Boolean)
          .join(" "),
      };
    base.durationMs = Math.round(performance.now() - start);
    return base;
  }

  async context(input: unknown, signal: AbortSignal): Promise<ContextResult> {
    const parsed = operationInputs["context.get"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const request = parsed.data;
    const hits = await this.search(
      { query: request.query, mode: "lexical", scope: request.scope, limit: request.limit },
      signal,
    );
    const result: ContextResult = {
      coverage: hits.coverage,
      ok: true,
      query: request.query,
      sources: [],
      omittedStale: 0,
      characters: 0,
      truncated: false,
    };
    for (const hit of hits.hits) {
      if (!hit.evidence) {
        result.omittedStale++;
        continue;
      }
      if (result.characters + hit.evidence.quote.length > request.maxCharacters) {
        result.truncated = true;
        continue;
      }
      result.sources.push(hit.evidence);
      result.characters += hit.evidence.quote.length;
    }
    return result;
  }
}

export function evidenceForChunk(
  note: NoteReadResult,
  row: Pick<SearchChunkRow, "text" | "startLine" | "endLine">,
): SourceReference | null {
  const exact = note.body.indexOf(row.text);
  if (exact >= 0 && note.body.indexOf(row.text, exact + 1) < 0 && row.text.length <= 8000) {
    return {
      ...note.note,
      range: sourceRange(note.body, exact, exact + row.text.length),
      quote: row.text,
    };
  }
  // Chunk text can normalize spaces/HTML. Cite the original bounded source
  // lines, never assign cooked chunk offsets to Markdown bytes.
  if (!row.startLine || !row.endLine) return null;
  const lines = [...note.body.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)].filter(
    (match) => match[0].length,
  );
  const first = lines[row.startLine - 1];
  const last = lines[row.endLine - 1];
  if (!first || !last) return null;
  const start = first.index;
  const end = last.index + last[0].length;
  if (end - start > 8000) return null;
  return {
    ...note.note,
    range: sourceRange(note.body, start, end),
    quote: note.body.slice(start, end),
  };
}
