import { DateTime, RecordId, type Surreal, Surreal as SurrealClass, Table } from "surrealdb";
import type { BlockSpec } from "../markdown/types";
import { EDGE_TABLES, type EdgeTable } from "./edgeTables";

export interface SurrealConnection {
  db: Surreal;
  close(): Promise<void>;
}

export interface NoteRecord {
  id: RecordId<"note">;
  path: string;
  sha: string;
  word_count: number;
}

export interface SearchHit {
  noteId: RecordId<"note">;
  chunkId: RecordId<"chunk">;
  distance: number;
  text: string;
}

export interface ConnectOptions {
  url: string;
  user: string;
  pass: string;
  namespace: string;
  database: string;
}

export interface CreateNoteInput {
  path: string;
  sha: string;
  wordCount: number;
}

export interface RelateWikilinkInput {
  from: RecordId;
  to: RecordId;
  source: string;
  confidenceClass: string;
  confidence: number;
  agent?: string;
}

export interface SearchVectorInput {
  vector: number[];
  k: number;
  ef?: number;
}

/**
 * Open an authenticated SurrealDB session that survives WebSocket reconnects.
 *
 * The credentials are passed via `connect`'s `authentication` option rather
 * than a one-shot `signin()` call so the SDK's auto-renewal pipeline owns
 * the auth lifecycle: on disconnect the SDK cancels the renewal timer and
 * wipes session state, on reconnect it re-applies the auth provider, and
 * before token expiration it re-signs proactively. A standalone `signin()`
 * call locks the session to the initial token; after a transient
 * disconnect the reconnected socket is anonymous and every subsequent
 * query fails with "Anonymous access not allowed". Long-running Tier 2/3
 * indexer paths and idle CLI subscriptions both surface that failure mode
 * in production, so the auth provider form is the only acceptable shape.
 */
export async function connect(options: ConnectOptions): Promise<SurrealConnection> {
  const db = new SurrealClass();
  try {
    await db.connect(options.url, {
      namespace: options.namespace,
      database: options.database,
      authentication: { username: options.user, password: options.pass },
    });
  } catch (error) {
    try {
      await db.close();
    } catch {
      // Swallow secondary close failures so the original error surfaces.
    }
    throw error;
  }
  return {
    db,
    close: async () => {
      await db.close();
    },
  };
}

export async function createNote(db: Surreal, input: CreateNoteInput): Promise<NoteRecord> {
  const result = await db.create<NoteRecord>(new Table("note")).content({
    path: input.path,
    sha: input.sha,
    word_count: input.wordCount,
  });
  const record = Array.isArray(result) ? result[0] : result;
  if (!record) {
    throw new Error("createNote: SurrealDB returned no record");
  }
  return record as NoteRecord;
}

export async function relateWikilink(db: Surreal, input: RelateWikilinkInput): Promise<void> {
  const hasAgent = input.agent !== undefined;
  const agentClause = hasAgent ? ", agent = $agent" : "";
  const sql = `RELATE $from->wikilink->$to SET source = $source, class = $cls, confidence = $confidence${agentClause};`;
  const bindings: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    source: input.source,
    cls: input.confidenceClass,
    confidence: input.confidence,
  };
  if (hasAgent) {
    bindings.agent = input.agent;
  }
  await db.query(sql, bindings).collect();
}

interface ChunkSearchRow {
  id: RecordId<"chunk">;
  note: RecordId<"note"> | { id: RecordId<"note"> };
  text: string;
  d: number;
}

export async function lookupNoteByPath(
  db: Surreal,
  path: string,
): Promise<RecordId<"note"> | null> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"note"> }>]>("SELECT id FROM note WHERE path = $path LIMIT 1;", {
      path,
    })
    .collect<[Array<{ id: RecordId<"note"> }>]>();
  return rows[0]?.id ?? null;
}

/**
 * Returns every existing `note.path` row from SurrealDB. The Tier 1 wikilink
 * resolver consumes this as the vault-wide path universe so wikilinks like
 * `[[Other Note]]` can resolve against an existing on-disk path. Phase 5
 * Task 13 replaces the legacy SQLite `SELECT path FROM notes;` query the
 * indexer used to issue against the deleted `Database` class.
 */
export async function listNotePaths(db: Surreal): Promise<string[]> {
  const [rows] = await db
    .query<[Array<{ path: string }>]>("SELECT path FROM note;")
    .collect<[Array<{ path: string }>]>();
  return rows.map((row) => row.path);
}

export async function lookupBlockByHeading(
  db: Surreal,
  noteId: RecordId<"note">,
  headingSlug: string,
): Promise<RecordId<"block"> | null> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"block"> }>]>(
      "SELECT id FROM block WHERE note = $note AND heading_slug = $slug LIMIT 1;",
      { note: noteId, slug: headingSlug },
    )
    .collect<[Array<{ id: RecordId<"block"> }>]>();
  return rows[0]?.id ?? null;
}

export async function lookupBlockByExplicitId(
  db: Surreal,
  noteId: RecordId<"note">,
  blockId: string,
): Promise<RecordId<"block"> | null> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"block"> }>]>(
      "SELECT id FROM block WHERE note = $note AND block_id = $bid LIMIT 1;",
      { note: noteId, bid: blockId },
    )
    .collect<[Array<{ id: RecordId<"block"> }>]>();
  return rows[0]?.id ?? null;
}

export interface UpsertNoteInput {
  path: string;
  sha: string;
  wordCount: number;
}

export async function upsertNoteByPath(
  db: Surreal,
  input: UpsertNoteInput,
): Promise<RecordId<"note">> {
  const existing = await lookupNoteByPath(db, input.path);
  if (existing !== null) {
    await db
      .query("UPDATE $id SET sha = $sha, word_count = $wordCount;", {
        id: existing,
        sha: input.sha,
        wordCount: input.wordCount,
      })
      .collect();
    return existing;
  }
  const created = await createNote(db, input);
  return created.id;
}

export async function upsertTag(db: Surreal, path: string): Promise<RecordId<"tag">> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"tag"> }>]>("SELECT id FROM tag WHERE path = $path LIMIT 1;", {
      path,
    })
    .collect<[Array<{ id: RecordId<"tag"> }>]>();
  if (rows[0] !== undefined) {
    return rows[0].id;
  }
  const result = await db
    .create<{ id: RecordId<"tag">; path: string }>(new Table("tag"))
    .content({ path });
  const record = Array.isArray(result) ? result[0] : result;
  if (record === undefined) {
    throw new Error("upsertTag: SurrealDB returned no record");
  }
  return record.id;
}

interface BlockContent {
  note: RecordId<"note">;
  heading_path: string[];
  ord: number;
  start_line: number;
  end_line: number;
  text: string;
  block_id?: string;
  heading_slug?: string;
  heading_level?: number;
}

function buildBlockContent(noteId: RecordId<"note">, block: BlockSpec): BlockContent {
  const content: BlockContent = {
    note: noteId,
    heading_path: block.headingPath,
    ord: block.ord,
    start_line: block.startLine,
    end_line: block.endLine,
    text: block.text,
  };
  if (block.blockId !== null) {
    content.block_id = block.blockId;
  }
  if (block.headingSlug !== null) {
    content.heading_slug = block.headingSlug;
  }
  if (block.headingLevel !== null) {
    content.heading_level = block.headingLevel;
  }
  return content;
}

export async function replaceBlocks(
  db: Surreal,
  noteId: RecordId<"note">,
  blocks: BlockSpec[],
): Promise<RecordId<"block">[]> {
  await db.query("DELETE block WHERE note = $note;", { note: noteId }).collect();
  if (blocks.length === 0) {
    return [];
  }
  const inserted: RecordId<"block">[] = [];
  for (const block of blocks) {
    const result = await db
      .create<{ id: RecordId<"block"> }>(new Table("block"))
      .content(buildBlockContent(noteId, block) as unknown as Record<string, unknown>);
    const record = Array.isArray(result) ? result[0] : result;
    if (record === undefined) {
      throw new Error("replaceBlocks: SurrealDB returned no block record");
    }
    inserted.push(record.id);
  }
  return inserted;
}

export interface RelateEdgeInput {
  table: EdgeTable;
  from: RecordId;
  to: RecordId;
  source: string;
  confidenceClass: string;
  confidence: number;
  agent?: string;
  approved?: boolean;
}

export async function relateEdge(db: Surreal, input: RelateEdgeInput): Promise<void> {
  if (!EDGE_TABLES.includes(input.table)) {
    throw new Error(`relateEdge: unknown edge table '${input.table}'`);
  }
  const setClauses: string[] = ["source = $source", "class = $cls", "confidence = $confidence"];
  const bindings: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    source: input.source,
    cls: input.confidenceClass,
    confidence: input.confidence,
  };
  if (input.agent !== undefined) {
    setClauses.push("agent = $agent");
    bindings.agent = input.agent;
  }
  if (input.approved !== undefined) {
    setClauses.push("approved = $approved");
    bindings.approved = input.approved;
  }
  await db
    .query(`RELATE $from->${input.table}->$to SET ${setClauses.join(", ")};`, bindings)
    .collect();
}

export type UnresolvedEdgeKind = "wikilink" | "embed";

export interface InsertUnresolvedEdgeInput {
  kind: UnresolvedEdgeKind;
  from: RecordId;
  rawTarget: string;
  source: string;
}

export async function insertUnresolvedEdge(
  db: Surreal,
  input: InsertUnresolvedEdgeInput,
): Promise<void> {
  const table = input.kind === "wikilink" ? "wikilink_unresolved" : "embed_unresolved";
  await db
    .query(`CREATE ${table} CONTENT { in: $from, raw_target: $rawTarget, source: $source };`, {
      from: input.from,
      rawTarget: input.rawTarget,
      source: input.source,
    })
    .collect();
}

export async function markTier1Done(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  await db.query("UPDATE $id SET tier1_at = time::now();", { id: noteId }).collect();
}

export async function searchVector(db: Surreal, input: SearchVectorInput): Promise<SearchHit[]> {
  if (!Number.isInteger(input.k) || input.k <= 0) {
    throw new Error("searchVector: k must be a positive integer");
  }
  const operator = input.ef !== undefined ? `<|${input.k},${input.ef}|>` : `<|${input.k}|>`;
  const sql = `SELECT id, note, text, vector::distance::knn() AS d FROM chunk WHERE vector ${operator} $q ORDER BY d FETCH note;`;
  const [rows] = await db
    .query<[ChunkSearchRow[]]>(sql, { q: input.vector })
    .collect<[ChunkSearchRow[]]>();
  return rows.map((row) => {
    const note = row.note;
    const noteId = note instanceof RecordId ? (note as RecordId<"note">) : note.id;
    return {
      noteId,
      chunkId: row.id,
      distance: row.d,
      text: row.text,
    };
  });
}

/**
 * Search-side projection of a chunk row. Carries the parent note's path so the
 * search strategies can produce SearchHit objects without a second round-trip
 * to look up `note.path`. The four readers (quick, balanced, deep, smoke
 * harness) all consume this shape.
 */
export interface SearchChunkRow {
  chunkId: RecordId<"chunk">;
  noteId: RecordId<"note">;
  notePath: string;
  text: string;
  /** Vector distance from the kNN query, or null if the row came from BM25 only. */
  distance: number | null;
  /** BM25 score from the full-text query, or null if the row came from kNN only. */
  bm25Score: number | null;
}

interface ChunkSearchVectorRow {
  id: RecordId<"chunk">;
  note: { id: RecordId<"note">; path: string };
  text: string;
  d: number;
}

interface ChunkSearchBm25Row {
  id: RecordId<"chunk">;
  note: { id: RecordId<"note">; path: string };
  text: string;
  score: number;
}

export interface SearchVectorWithPathInput {
  vector: number[];
  k: number;
  /**
   * SurrealDB 3.x rejects the bare `<|k|>` operator with the error
   * "KNN operators nested in OR/NOT expressions or mixed with unsupported
   * KNN variants are not supported" when the SELECT projection materialises
   * the parent record (`note.{ id, path }` or `FETCH note`). The two-arg
   * form `<|k,ef|>` always parses, so the helper requires an `ef` value
   * and defaults it to {@link DEFAULT_SEARCH_EF} when callers omit it.
   */
  ef?: number;
  /**
   * Optional SurrealQL WHERE fragment composed by the caller (e.g. note path
   * prefix, maturity, date range filters). Must begin with ` AND` so the
   * call site can append it after the kNN predicate. Bindings live in
   * `extraBindings`.
   */
  extraWhere?: string;
  extraBindings?: Record<string, unknown>;
}

/**
 * Default ef value for the search-side HNSW operator. Larger than the
 * linker's 40 because search expects a wider candidate pool fed into the
 * reranker; small enough that the HNSW traversal stays bounded.
 */
export const DEFAULT_SEARCH_EF = 100;

/**
 * Vector kNN search over the `chunk` table that materialises the parent note's
 * `path` field. Used by the balanced and deep strategies; result rows are
 * sorted by distance ascending.
 */
export async function searchVectorWithPath(
  db: Surreal,
  input: SearchVectorWithPathInput,
): Promise<SearchChunkRow[]> {
  if (!Number.isInteger(input.k) || input.k <= 0) {
    throw new Error("searchVectorWithPath: k must be a positive integer");
  }
  const ef = input.ef ?? DEFAULT_SEARCH_EF;
  const extraWhere = input.extraWhere ?? "";
  const sql = `SELECT id, note.{ id, path } AS note, text, vector::distance::knn() AS d FROM chunk WHERE vector <|${input.k},${ef}|> $q${extraWhere} ORDER BY d LIMIT $k;`;
  const bindings: Record<string, unknown> = {
    q: input.vector,
    k: input.k,
    ...(input.extraBindings ?? {}),
  };
  const [rows] = await db
    .query<[ChunkSearchVectorRow[]]>(sql, bindings)
    .collect<[ChunkSearchVectorRow[]]>();
  return rows.map((row) => ({
    chunkId: row.id,
    noteId: row.note.id,
    notePath: row.note.path,
    text: row.text,
    distance: row.d,
    bm25Score: null,
  }));
}

export interface SearchBm25Input {
  query: string;
  limit: number;
  extraWhere?: string;
  extraBindings?: Record<string, unknown>;
}

/**
 * BM25 full-text search over the `chunk.text` field. The `chunk_text` index
 * defined in `schema.surql` powers the `@0@` operator and `search::score(0)`.
 * Returns rows ordered by descending score.
 */
export async function searchBm25(db: Surreal, input: SearchBm25Input): Promise<SearchChunkRow[]> {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new Error("searchBm25: limit must be a positive integer");
  }
  const trimmed = input.query.trim();
  if (trimmed.length === 0) return [];
  const extraWhere = input.extraWhere ?? "";
  const sql = `SELECT id, note.{ id, path } AS note, text, search::score(0) AS score FROM chunk WHERE text @0@ $q${extraWhere} ORDER BY score DESC LIMIT $k;`;
  const bindings: Record<string, unknown> = {
    q: trimmed,
    k: input.limit,
    ...(input.extraBindings ?? {}),
  };
  const [rows] = await db
    .query<[ChunkSearchBm25Row[]]>(sql, bindings)
    .collect<[ChunkSearchBm25Row[]]>();
  return rows.map((row) => ({
    chunkId: row.id,
    noteId: row.note.id,
    notePath: row.note.path,
    text: row.text,
    distance: null,
    bm25Score: row.score,
  }));
}

export interface ExpandWikilinkInput {
  startNoteIds: RecordId<"note">[];
  /**
   * Hop depth. `0` is a no-op. Phase 4 only exercises depth 1 (matching the
   * legacy SQLite-CTE behaviour); values >1 are accepted but reduce to the
   * one-hop neighbourhood because the graph expansion call site filters
   * everything except direct neighbours of the base hits.
   */
  depth: number;
  /**
   * When true (the default) the traversal restricts to edges that are both
   * `approved = true` and `applied = true`, matching the search-consumer
   * contract documented in `edgeTables.ts::provenanceFields`. Tests that
   * write rows with `approved = false` rely on this flag to keep
   * unapproved edges out of the result set.
   */
  requireApprovedAndApplied?: boolean;
}

export interface WikilinkNeighbor {
  fromPath: string;
  toPath: string;
  /** Edge type label used for snippet rendering. Always `"wikilink"` here. */
  edgeType: string;
  /** Agent that authored the edge, or `null` when stored as NONE. */
  agent: string | null;
}

interface WikilinkEdgeRow {
  fromPath: string;
  toPath: string;
  agent: string | null;
}

/**
 * Walks wikilink edges outwards from each start note up to the given depth and
 * returns one row per (from, to) pair. Phase 4 only exercises depth 1 (the
 * legacy SQLite recursive-CTE matched the same one-hop behaviour). The query
 * is one SurrealQL statement against the `wikilink` relation, so adding deeper
 * hops later is a matter of widening the `IN` predicate to a recursive idiom.
 *
 * The default `approved = true AND applied = true` filter matches the
 * search-consumer contract: linker proposals that have been approved but whose
 * writeback has not landed yet are filtered out so graph expansion never
 * surfaces a path the user has not yet seen.
 */
export async function expandWikilinkNeighbors(
  db: Surreal,
  input: ExpandWikilinkInput,
): Promise<WikilinkNeighbor[]> {
  if (input.depth <= 0) return [];
  if (input.startNoteIds.length === 0) return [];
  const requireApprovedAndApplied = input.requireApprovedAndApplied !== false;
  const approvalClause = requireApprovedAndApplied ? "approved = true AND applied = true AND " : "";
  const sql = `SELECT in.path AS fromPath, out.path AS toPath, agent FROM wikilink WHERE ${approvalClause}(in IN $starts OR out IN $starts);`;
  const [rows] = await db
    .query<[WikilinkEdgeRow[]]>(sql, { starts: input.startNoteIds })
    .collect<[WikilinkEdgeRow[]]>();
  return rows.map((row) => ({
    fromPath: row.fromPath,
    toPath: row.toPath,
    edgeType: "wikilink",
    agent: row.agent,
  }));
}

export interface ChunkInsertInput {
  ord: number;
  text: string;
  tokenEstimate: number;
  vector: number[];
  embedModel: string;
}

export async function replaceChunks(
  db: Surreal,
  noteId: RecordId<"note">,
  chunks: ChunkInsertInput[],
): Promise<RecordId<"chunk">[]> {
  await db.query("DELETE chunk WHERE note = $note;", { note: noteId }).collect();
  if (chunks.length === 0) {
    return [];
  }
  const inserted: RecordId<"chunk">[] = [];
  // embedded_at is set via SurrealQL time::now() so the value lands as a
  // native datetime; passing a JS Date through .content() would be coerced
  // to a string and fail the option<datetime> field assertion.
  const sql =
    "CREATE ONLY chunk CONTENT { note: $note, ord: $ord, text: $text, token_estimate: $tokenEstimate, vector: $vector, embed_model: $embedModel, embedded_at: time::now() } RETURN id;";
  for (const chunk of chunks) {
    // CREATE ONLY returns a single record (not an array) per SurrealDB 3.x.
    const [row] = await db
      .query<[{ id: RecordId<"chunk"> } | null]>(sql, {
        note: noteId,
        ord: chunk.ord,
        text: chunk.text,
        tokenEstimate: chunk.tokenEstimate,
        vector: chunk.vector,
        embedModel: chunk.embedModel,
      })
      .collect<[{ id: RecordId<"chunk"> } | null]>();
    if (row === null) {
      throw new Error("replaceChunks: SurrealDB returned no chunk record");
    }
    inserted.push(row.id);
  }
  return inserted;
}

export async function markTier2Done(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  await db.query("UPDATE $id SET tier2_at = time::now();", { id: noteId }).collect();
}

interface Tier3ChunkRow {
  ord: number;
  text: string;
  vector: number[];
}

/**
 * Fetch the chunks Tier 3 needs for a note, ordered by `ord` ascending.
 * Rows whose `vector` is `NONE` (e.g. an in-flight Tier 2 that has not yet
 * embedded a particular chunk) are excluded server-side via `vector != NONE`.
 *
 * Spec: Phase 3 plan §Task 9. Output is shaped to match
 * `Tier3Chunk` so `runTier3` can consume it directly.
 */
export async function fetchChunksForTier3(
  db: Surreal,
  noteId: RecordId<"note">,
): Promise<Array<{ ord: number; text: string; vector: number[] }>> {
  const [rows] = await db
    .query<[Tier3ChunkRow[]]>(
      "SELECT ord, text, vector FROM chunk WHERE note = $note AND vector != NONE ORDER BY ord;",
      { note: noteId },
    )
    .collect<[Tier3ChunkRow[]]>();
  return rows.map((row) => ({ ord: row.ord, text: row.text, vector: row.vector }));
}

export async function markTier3Done(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  await db.query("UPDATE $id SET tier3_at = time::now();", { id: noteId }).collect();
}

/**
 * Per-tier completion state for a note. `true` means the note's
 * `tier{N}_at` is set (the tier has run); `false` means it is `NONE`
 * or the note row does not yet exist. Used by `indexNote` to skip
 * tiers that are already up to date when running under a tier filter.
 *
 * Spec: Phase 5 Task 11.
 */
export interface NoteTierState {
  tier1Done: boolean;
  tier2Done: boolean;
  tier3Done: boolean;
}

/**
 * Read the per-tier completion state for the note at `path`. Missing
 * notes (no row in `note`) return all-false so a fresh note runs every
 * tier the caller's filter allows.
 *
 * Spec: Phase 5 Task 11. The query selects the raw tier columns; a
 * `null`/`undefined` value (option<datetime> not yet set) collapses to
 * `false`.
 */
export async function fetchNoteTierState(db: Surreal, path: string): Promise<NoteTierState> {
  const [rows] = await db
    .query<
      [
        Array<{
          tier1_at: string | Date | null | undefined;
          tier2_at: string | Date | null | undefined;
          tier3_at: string | Date | null | undefined;
        }>,
      ]
    >("SELECT tier1_at, tier2_at, tier3_at FROM note WHERE path = $path LIMIT 1;", { path })
    .collect<
      [
        Array<{
          tier1_at: string | Date | null | undefined;
          tier2_at: string | Date | null | undefined;
          tier3_at: string | Date | null | undefined;
        }>,
      ]
    >();
  const row = rows[0];
  if (row === undefined) {
    return { tier1Done: false, tier2Done: false, tier3Done: false };
  }
  return {
    tier1Done: row.tier1_at !== null && row.tier1_at !== undefined,
    tier2Done: row.tier2_at !== null && row.tier2_at !== undefined,
    tier3Done: row.tier3_at !== null && row.tier3_at !== undefined,
  };
}

/**
 * Clear the `tier{N}_at` columns listed in `tiers` for the note matching
 * `path`. The note row stays put; only the tier-completion timestamps
 * are reset to NONE so a subsequent indexer pass treats the cleared
 * tiers as un-run. Tiers outside `[1, 2, 3]` are silently ignored.
 *
 * Spec: Phase 5 Task 11 (`reindex --tier`). SurrealDB's option<datetime>
 * fields reject `null` bindings, so the SET clause emits the literal
 * `NONE` token instead of binding a value.
 *
 * The query uses `UPDATE note WHERE path = $path` so a path that never
 * reached Tier 1 (no `note` row exists) is a no-op rather than an error;
 * callers may issue a clear before enqueueing without first asserting
 * the row exists.
 */
export async function clearTierAtByPath(
  db: Surreal,
  path: string,
  tiers: ReadonlyArray<number>,
): Promise<void> {
  const valid = tiers.filter((tier) => tier === 1 || tier === 2 || tier === 3);
  if (valid.length === 0) return;
  const setClauses = valid.map((tier) => `tier${tier}_at = NONE`);
  const sql = `UPDATE note SET ${setClauses.join(", ")} WHERE path = $path;`;
  await db.query(sql, { path }).collect();
}

export interface LinkerNeighborsInput {
  activeNoteId: RecordId<"note">;
  activeChunkVectors: number[][];
  k: number;
  ef?: number;
}

export interface NeighborCandidate {
  noteId: RecordId<"note">;
  notePath: string;
  bestDistance: number;
  evidenceChunkIds: RecordId<"chunk">[];
}

interface NeighborRow {
  id: RecordId<"chunk">;
  note: RecordId<"note"> | { id: RecordId<"note">; path: string; tier3_at?: string };
  d: number;
}

const MAX_EVIDENCE_PER_NOTE = 4;
const DEFAULT_LINKER_EF = 40;

export async function linkerNeighbors(
  db: Surreal,
  input: LinkerNeighborsInput,
): Promise<NeighborCandidate[]> {
  if (!Number.isInteger(input.k) || input.k <= 0) {
    throw new Error("linkerNeighbors: k must be a positive integer");
  }
  if (input.activeChunkVectors.length === 0) {
    return [];
  }
  const queryVector = input.activeChunkVectors[0];
  const ef = input.ef ?? DEFAULT_LINKER_EF;
  const operator = `<|${input.k},${ef}|>`;
  // Multi-statement query: SurrealDB returns one result slice per statement.
  // We only care about the final SELECT, so we read the last slice.
  const sql = [
    "LET $excluded = (SELECT VALUE ->wikilink->note FROM ONLY $active);",
    "LET $excludedBack = (SELECT VALUE <-wikilink<-note FROM ONLY $active);",
    `SELECT id, note, vector::distance::knn() AS d FROM chunk WHERE vector ${operator} $q AND note != $active AND note NOT IN $excluded AND note NOT IN $excludedBack AND note.tier3_at != NONE ORDER BY d FETCH note;`,
  ].join("\n");
  const results = await db
    .query(sql, { active: input.activeNoteId, q: queryVector })
    .collect<unknown[]>();
  const lastSlice = results[results.length - 1];
  const rows = (Array.isArray(lastSlice) ? (lastSlice as NeighborRow[]) : []) as NeighborRow[];
  const grouped = new Map<
    string,
    { noteId: RecordId<"note">; notePath: string; rows: NeighborRow[] }
  >();
  for (const row of rows) {
    const note = row.note;
    let noteId: RecordId<"note">;
    let notePath: string;
    if (note instanceof RecordId) {
      noteId = note as RecordId<"note">;
      notePath = "";
    } else {
      noteId = note.id;
      notePath = note.path;
    }
    const key = noteId.toString();
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, { noteId, notePath, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }
  const candidates: NeighborCandidate[] = [];
  for (const entry of grouped.values()) {
    const sortedRows = entry.rows.slice().sort((a, b) => a.d - b.d);
    const evidenceChunkIds = sortedRows.slice(0, MAX_EVIDENCE_PER_NOTE).map((row) => row.id);
    const bestDistance = sortedRows[0].d;
    candidates.push({
      noteId: entry.noteId,
      notePath: entry.notePath,
      bestDistance,
      evidenceChunkIds,
    });
  }
  candidates.sort((a, b) => a.bestDistance - b.bestDistance);
  return candidates;
}

function normalizeLabel(label: string): string {
  return label.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

async function sha256Hex(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function upsertConcept(db: Surreal, label: string): Promise<RecordId<"concept">> {
  const normalized = normalizeLabel(label);
  const [rows] = await db
    .query<[Array<{ id: RecordId<"concept"> }>]>(
      "SELECT id FROM concept WHERE norm_label = $norm LIMIT 1;",
      { norm: normalized },
    )
    .collect<[Array<{ id: RecordId<"concept"> }>]>();
  if (rows[0] !== undefined) {
    return rows[0].id;
  }
  const result = await db
    .create<{ id: RecordId<"concept">; label: string; norm_label: string }>(new Table("concept"))
    .content({ label, norm_label: normalized });
  const record = Array.isArray(result) ? result[0] : result;
  if (record === undefined) {
    throw new Error("upsertConcept: SurrealDB returned no record");
  }
  return record.id;
}

export async function upsertClaim(db: Surreal, text: string): Promise<RecordId<"claim">> {
  const sha = await sha256Hex(text);
  const [rows] = await db
    .query<[Array<{ id: RecordId<"claim"> }>]>("SELECT id FROM claim WHERE sha = $sha LIMIT 1;", {
      sha,
    })
    .collect<[Array<{ id: RecordId<"claim"> }>]>();
  if (rows[0] !== undefined) {
    return rows[0].id;
  }
  const result = await db
    .create<{ id: RecordId<"claim">; text: string; sha: string }>(new Table("claim"))
    .content({ text, sha });
  const record = Array.isArray(result) ? result[0] : result;
  if (record === undefined) {
    throw new Error("upsertClaim: SurrealDB returned no record");
  }
  return record.id;
}

/**
 * Daemon-write audit row: a tamper-evident record that an agent wrote to a
 * note's body for a specific body sha. Tier 1 reads the most recent matching
 * row to attribute wikilink/embed edges back to the agent that introduced
 * them, distinguishing them from edges authored by the human.
 *
 * Spec: §3.5, Phase 4 plan §Task 2. Rows are immutable once inserted.
 */
export interface RecordDaemonWriteInput {
  noteId: RecordId<"note">;
  sha: string;
  agent: string;
  /**
   * The records this write touched. Schema is `array<record>`; in practice
   * these are usually `RecordId<"note">` (wikilink / frontmatter targets) but
   * the schema deliberately accepts any record id.
   */
  targets: RecordId[];
}

export async function recordDaemonWrite(
  db: Surreal,
  input: RecordDaemonWriteInput,
): Promise<RecordId<"daemon_write">> {
  // `written_at` has a DEFAULT of `time::now()` in the schema; we omit it
  // from the content to let SurrealDB stamp the server-side wallclock.
  const result = await db
    .create<{ id: RecordId<"daemon_write"> }>(new Table("daemon_write"))
    .content({
      note: input.noteId,
      sha: input.sha,
      agent: input.agent,
      targets: input.targets,
    });
  const record = Array.isArray(result) ? result[0] : result;
  if (record === undefined) {
    throw new Error("recordDaemonWrite: SurrealDB returned no record");
  }
  return record.id;
}

export interface FindRecentDaemonWriteInput {
  noteId: RecordId<"note">;
  sha: string;
  /**
   * Tolerance window in seconds. Defaults to 5s, which absorbs the race
   * between an agent's atomic file write and the filesystem watcher firing
   * a re-index for the same body.
   */
  withinSeconds?: number;
}

export interface DaemonWriteMatch {
  agent: string;
  targets: RecordId[];
}

const DEFAULT_DAEMON_WRITE_WINDOW_SECONDS = 5;

export async function findRecentDaemonWrite(
  db: Surreal,
  input: FindRecentDaemonWriteInput,
): Promise<DaemonWriteMatch | null> {
  const withinSeconds = input.withinSeconds ?? DEFAULT_DAEMON_WRITE_WINDOW_SECONDS;
  if (!Number.isFinite(withinSeconds) || withinSeconds < 0) {
    throw new Error("findRecentDaemonWrite: withinSeconds must be a non-negative number");
  }
  // The cutoff is computed in JS and shipped as a `DateTime` value so the
  // binding lands as a native datetime on the server. Building the duration
  // arithmetic on the SurrealQL side would require either string templating
  // (a `${seconds}s` literal in the query) or a `Duration` parameter; the
  // datetime-cutoff approach keeps both query and binding shape boring.
  //
  // Clock-skew trade-off: the cutoff is computed client-side via Date.now()
  // while `written_at` is stamped server-side via time::now(). On a single
  // host with sub-second skew the 5s default tolerates the file-write /
  // watcher race. Cross-host SurrealDB deployments with multi-second skew
  // may need a wider window or a server-side cutoff via `time::now() -
  // <duration>`.
  const cutoffDate = new Date(Date.now() - Math.floor(withinSeconds * 1000));
  const cutoff = new DateTime(cutoffDate);
  // SurrealDB 3.0.5 requires every `ORDER BY` field to appear in the
  // projection, so `written_at` is selected and discarded by the caller.
  const sql =
    "SELECT agent, targets, written_at FROM daemon_write WHERE note = $note AND sha = $sha AND written_at > $cutoff ORDER BY written_at DESC LIMIT 1;";
  const [rows] = await db
    .query<[Array<{ agent: string; targets: RecordId[] }>]>(sql, {
      note: input.noteId,
      sha: input.sha,
      cutoff,
    })
    .collect<[Array<{ agent: string; targets: RecordId[] }>]>();
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return { agent: row.agent, targets: row.targets };
}

export async function upsertQuestion(db: Surreal, text: string): Promise<RecordId<"question">> {
  const sha = await sha256Hex(text);
  const [rows] = await db
    .query<[Array<{ id: RecordId<"question"> }>]>(
      "SELECT id FROM question WHERE sha = $sha LIMIT 1;",
      { sha },
    )
    .collect<[Array<{ id: RecordId<"question"> }>]>();
  if (rows[0] !== undefined) {
    return rows[0].id;
  }
  const result = await db
    .create<{ id: RecordId<"question">; text: string; sha: string }>(new Table("question"))
    .content({ text, sha });
  const record = Array.isArray(result) ? result[0] : result;
  if (record === undefined) {
    throw new Error("upsertQuestion: SurrealDB returned no record");
  }
  return record.id;
}
