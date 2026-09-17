import { DateTime, RecordId, type Surreal, Surreal as SurrealClass, Table } from "surrealdb";
import { proposalProvenanceIssue } from "../approvals/proposalStorage";
import { stagePendingProposal } from "../approvals/proposalWriter";
import { LINKER } from "../indexer/concurrencyDefaults";
import { readTierFilter } from "../indexer/tierFilter";
import { type ResolvedEmbeddingIdentity, createEmbeddingIdentity } from "../llm/embeddingIdentity";
import { STRUCTURAL_INDEX_VERSION } from "../markdown/types";
import type { BlockSpec } from "../markdown/types";
import { isCanonicalPublicNotePath } from "../vault/publicPath";
import {
  EDGE_TABLES,
  type EdgeTable,
  type ExtractorEdgeTable,
  WRITEBACK_EDGE_TABLES,
  isExtractorEdgeTable,
  isWritebackEdgeTable,
} from "./edgeTables";
import { isExactRecord, readSingleStatementRows } from "./queryResult";
import { parseSurrealRelationRecordId } from "./recordId";

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
  const [record] = await db.create<NoteRecord>(new Table("note")).content({
    path: input.path,
    sha: input.sha,
    word_count: input.wordCount,
  });
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

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function queryRows(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(`${label} storage integrity: invalid statement envelope`);
  }
  return raw[0];
}

function requireRecordId<TableName extends string>(
  value: unknown,
  table: TableName,
  label: string,
): RecordId<TableName> {
  if (!(value instanceof RecordId) || value.table.name !== table) {
    throw new Error(`${label} storage integrity: expected a native ${table} record id`);
  }
  return value as RecordId<TableName>;
}

function requireFetchedNote(
  value: unknown,
  label: string,
): {
  id: RecordId<"note">;
  path: string;
} {
  if (value instanceof RecordId || !isRow(value)) {
    throw new Error(`${label} storage integrity: parent note was not hydrated`);
  }
  const id = requireRecordId(value.id, "note", label);
  if (!isCanonicalPublicNotePath(value.path)) {
    throw new Error(`${label} storage integrity: parent note path is invalid`);
  }
  return { id, path: value.path };
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} storage integrity: expected a finite number`);
  }
  return value;
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
 * Returns every existing `note.path` row. The Tier 1 resolver consumes this
 * vault-wide path universe so wikilinks such as `[[Other Note]]` can resolve
 * against an indexed path.
 */
export async function listNotePaths(db: Surreal): Promise<string[]> {
  const [rows] = await db
    .query<[Array<{ path: string }>]>("SELECT path FROM note WHERE tombstoned_at IS NONE;")
    .collect<[Array<{ path: string }>]>();
  return rows.map((row) => {
    if (!isCanonicalPublicNotePath(row.path)) {
      throw new Error("note path listing storage integrity: returned a private or invalid path");
    }
    return row.path;
  });
}

/**
 * Batched `path -> note id` resolution. One `INSIDE` query resolves every
 * wikilink and frontmatter reference for a Tier 1 pass. Paths with no note
 * row are absent from the returned map.
 */
export async function lookupNoteIdsByPaths(
  db: Surreal,
  paths: readonly string[],
): Promise<Map<string, RecordId<"note">>> {
  const unique = Array.from(new Set(paths));
  const out = new Map<string, RecordId<"note">>();
  if (unique.length === 0) return out;
  const [rows] = await db
    .query<[Array<{ id: RecordId<"note">; path: string }>]>(
      "SELECT path, id FROM note WHERE path INSIDE $paths AND tombstoned_at IS NONE;",
      { paths: unique },
    )
    .collect<[Array<{ id: RecordId<"note">; path: string }>]>();
  for (const row of rows) {
    if (
      !isCanonicalPublicNotePath(row.path) ||
      !unique.includes(row.path) ||
      !(row.id instanceof RecordId) ||
      row.id.table.name !== "note"
    ) {
      throw new Error("note path lookup storage integrity: returned an invalid note row");
    }
    out.set(row.path, row.id);
  }
  return out;
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
      .query("UPDATE $id SET sha = $sha, word_count = $wordCount, tombstoned_at = NONE;", {
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
  const [record] = await db
    .create<{ id: RecordId<"tag">; path: string }>(new Table("tag"))
    .content({ path });
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
    const [record] = await db
      .create<{ id: RecordId<"block"> }>(new Table("block"))
      .content(buildBlockContent(noteId, block) as unknown as Record<string, unknown>);
    if (record === undefined) {
      throw new Error("replaceBlocks: SurrealDB returned no block record");
    }
    inserted.push(record.id);
  }
  return inserted;
}

interface RelateEdgeBase {
  from: RecordId;
  to: RecordId;
  source: string;
  confidenceClass: string;
  confidence: number;
  agent?: string;
  approved?: boolean;
}

export type NonEmptyChunkEvidence = readonly [RecordId<"chunk">, ...Array<RecordId<"chunk">>];

type OptionalEvidenceEdgeTable = Exclude<EdgeTable, ExtractorEdgeTable>;

export type RelateEdgeInput =
  | (RelateEdgeBase & {
      table: ExtractorEdgeTable;
      /** Current chunks that support this extraction. Extractor edges require at least one. */
      evidence: NonEmptyChunkEvidence;
    })
  | (RelateEdgeBase & {
      table: OptionalEvidenceEdgeTable;
      /** Optional provenance for deterministic and proposed edge families. */
      evidence?: readonly RecordId<"chunk">[];
    });

function recordTableName(id: RecordId): string {
  return id.table.name;
}

async function assertCurrentExtractorEvidence(
  db: Surreal,
  input: RelateEdgeBase & {
    table: ExtractorEdgeTable;
    evidence: readonly RecordId<"chunk">[];
  },
): Promise<void> {
  if (input.evidence.length === 0) {
    throw new Error(`relateEdge: ${input.table} requires at least one current chunk as evidence`);
  }
  if (
    input.evidence.some(
      (record) => !(record instanceof RecordId) || recordTableName(record) !== "chunk",
    )
  ) {
    throw new Error(`relateEdge: ${input.table} evidence must contain only chunk records`);
  }
  const evidenceIds = new Set(input.evidence.map((record) => record.toString()));
  if (evidenceIds.size !== input.evidence.length) {
    throw new Error(`relateEdge: ${input.table} evidence must not contain duplicate chunks`);
  }

  let sourceNote: RecordId<"note">;
  const sourceTable = recordTableName(input.from);
  if (sourceTable === "note") {
    sourceNote = input.from as RecordId<"note">;
  } else if (sourceTable === "block") {
    const [blocks] = await db
      .query<[Array<{ note: RecordId<"note"> }>]>(
        "SELECT note FROM block WHERE id = $block LIMIT 1;",
        { block: input.from },
      )
      .collect<[Array<{ note: RecordId<"note"> }>]>();
    const note = blocks[0]?.note;
    if (note === undefined) {
      throw new Error(`relateEdge: ${input.table} source block does not exist`);
    }
    sourceNote = note;
  } else {
    throw new Error(`relateEdge: ${input.table} source must be a note or block record`);
  }

  const [currentChunks] = await db
    .query<[Array<{ id: RecordId<"chunk"> }>]>(
      "SELECT id FROM chunk WHERE id INSIDE $evidence AND note = $note;",
      { evidence: input.evidence, note: sourceNote },
    )
    .collect<[Array<{ id: RecordId<"chunk"> }>]>();
  const currentIds = new Set(currentChunks.map((row) => row.id.toString()));
  if (input.evidence.some((record) => !currentIds.has(record.toString()))) {
    throw new Error(
      `relateEdge: ${input.table} evidence must name current chunks from its source note`,
    );
  }
}

function assertCanonicalOptionalEvidence(
  table: OptionalEvidenceEdgeTable,
  evidence: readonly RecordId<"chunk">[],
): void {
  if (evidence.length === 0) {
    throw new Error(
      `relateEdge: ${table} evidence must be omitted or contain at least one chunk record`,
    );
  }
  if (
    evidence.some((record) => !(record instanceof RecordId) || recordTableName(record) !== "chunk")
  ) {
    throw new Error(`relateEdge: ${table} evidence must contain only chunk records`);
  }
  const ids = new Set(evidence.map((record) => record.toString()));
  if (ids.size !== evidence.length) {
    throw new Error(`relateEdge: ${table} evidence must not contain duplicate chunks`);
  }
}

export async function relateEdge(db: Surreal, input: RelateEdgeInput): Promise<boolean> {
  if (!EDGE_TABLES.includes(input.table)) {
    throw new Error(`relateEdge: unknown edge table '${input.table}'`);
  }
  if (isExtractorEdgeTable(input.table)) {
    if (input.evidence === undefined) {
      throw new Error(`relateEdge: ${input.table} requires at least one current chunk as evidence`);
    }
    await assertCurrentExtractorEvidence(db, {
      ...input,
      table: input.table,
      evidence: input.evidence,
    });
  } else if (input.evidence !== undefined) {
    assertCanonicalOptionalEvidence(input.table, input.evidence);
  }
  const proposalCreated = await maybeStagePendingProposal(db, input);
  if (proposalCreated !== null) return proposalCreated;
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
  if (input.evidence !== undefined) {
    setClauses.push("evidence = $evidence");
    bindings.evidence = input.evidence;
  }
  await db
    .query(`RELATE $from->${input.table}->$to SET ${setClauses.join(", ")};`, bindings)
    .collect();
  return true;
}

async function maybeStagePendingProposal(
  db: Surreal,
  input: RelateEdgeInput,
): Promise<boolean | null> {
  if (!isWritebackEdgeTable(input.table) || input.approved !== false) return null;
  if (recordTableName(input.from) !== "note" || recordTableName(input.to) !== "note") {
    throw new Error(`relateEdge: ${input.table} proposals require note endpoints`);
  }
  if (input.confidenceClass !== "INFERRED") {
    throw new Error(`relateEdge: ${input.table} proposals require INFERRED confidence class`);
  }
  const issue = proposalProvenanceIssue({
    source: input.source,
    agent: input.agent,
    table: input.table,
    confidence: input.confidence,
    evidenceCount: input.evidence?.length ?? 0,
  });
  if (issue !== null) throw new Error(`relateEdge: ${issue}`);
  const result = await stagePendingProposal(db, {
    relation: input.table,
    from: input.from as RecordId<"note">,
    to: input.to as RecordId<"note">,
    source: input.source as "linker" | "synthesizer" | "contradictionHunter" | "user",
    agent: input.agent as string,
    confidence: input.confidence,
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  });
  return result.kind === "created";
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
  await db
    .query("UPDATE $id SET tier1_at = time::now(), structural_version = $version;", {
      id: noteId,
      version: STRUCTURAL_INDEX_VERSION,
    })
    .collect();
}

export async function searchVector(db: Surreal, input: SearchVectorInput): Promise<SearchHit[]> {
  if (!Number.isInteger(input.k) || input.k <= 0) {
    throw new Error("searchVector: k must be a positive integer");
  }
  const operator = input.ef !== undefined ? `<|${input.k},${input.ef}|>` : `<|${input.k}|>`;
  const sql = `SELECT id, note, text, vector::distance::knn() AS d FROM chunk WHERE vector ${operator} $q AND string::len(string::trim(text)) > 0 ORDER BY d FETCH note;`;
  const slices: unknown = await db.query(sql, { q: input.vector }).collect();
  return queryRows(slices, "vector search").map((value) => {
    if (!isRow(value)) throw new Error("vector search storage integrity: row is not an object");
    const note = requireFetchedNote(value.note, "vector search");
    const chunkId = requireRecordId(value.id, "chunk", "vector search");
    if (typeof value.text !== "string" || value.text.trim().length === 0) {
      throw new Error("vector search storage integrity: chunk text is invalid");
    }
    return {
      noteId: note.id,
      chunkId,
      distance: requireFiniteNumber(value.d, "vector search distance"),
      text: value.text,
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
  sourceRevision?: string;
  startLine?: number;
  endLine?: number;
  chunkId: RecordId<"chunk">;
  noteId: RecordId<"note">;
  notePath: string;
  text: string;
  /** Vector distance from the kNN query, or null if the row came from BM25 only. */
  distance: number | null;
  /** BM25 score from the full-text query, or null if the row came from kNN only. */
  bm25Score: number | null;
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
  const sql = `SELECT id, note.{ id, path } AS note, text, source_revision, start_line, end_line, vector::distance::knn() AS d FROM chunk WHERE vector <|${input.k},${ef}|> $q AND string::len(string::trim(text)) > 0 AND note.tombstoned_at IS NONE${extraWhere} ORDER BY d LIMIT $k;`;
  const bindings: Record<string, unknown> = {
    q: input.vector,
    k: input.k,
    ...(input.extraBindings ?? {}),
  };
  const slices: unknown = await db.query(sql, bindings).collect();
  return queryRows(slices, "vector path search").map((value) =>
    parseSearchChunkRow(value, "vector path search", "distance"),
  );
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
  const sql = `SELECT id, note.{ id, path } AS note, text, source_revision, start_line, end_line, search::score(0) AS score FROM chunk WHERE text @0@ $q AND string::len(string::trim(text)) > 0 AND note.tombstoned_at IS NONE${extraWhere} ORDER BY score DESC LIMIT $k;`;
  const bindings: Record<string, unknown> = {
    q: trimmed,
    k: input.limit,
    ...(input.extraBindings ?? {}),
  };
  const slices: unknown = await db.query(sql, bindings).collect();
  return queryRows(slices, "BM25 search").map((value) =>
    parseSearchChunkRow(value, "BM25 search", "bm25"),
  );
}

function parseSearchChunkRow(
  value: unknown,
  label: string,
  scoreKind: "distance" | "bm25",
): SearchChunkRow {
  if (!isRow(value)) throw new Error(`${label} storage integrity: row is not an object`);
  const note = requireFetchedNote(value.note, label);
  const chunkId = requireRecordId(value.id, "chunk", label);
  if (typeof value.text !== "string" || value.text.trim().length === 0) {
    throw new Error(`${label} storage integrity: chunk text is invalid`);
  }
  const score = requireFiniteNumber(scoreKind === "distance" ? value.d : value.score, label);
  return {
    chunkId,
    noteId: note.id,
    notePath: note.path,
    text: value.text,
    distance: scoreKind === "distance" ? score : null,
    bm25Score: scoreKind === "bm25" ? score : null,
    ...(typeof value.source_revision === "string" ? { sourceRevision: value.source_revision } : {}),
    ...(typeof value.start_line === "number" ? { startLine: value.start_line } : {}),
    ...(typeof value.end_line === "number" ? { endLine: value.end_line } : {}),
  };
}

export interface DirectNeighborInput {
  startNoteIds: RecordId<"note">[];
}

export interface WikilinkNeighbor {
  fromPath: string;
  toPath: string;
  /** Edge type label used for snippet rendering. Always `"wikilink"` here. */
  edgeType: string;
  /** Agent that authored the edge, or `null` when stored as NONE. */
  agent: string | null;
}

/**
 * Reads direct wikilink neighbours and returns one row per endpoint pair.
 * Only committed relationships participate: an approved proposal whose
 * Markdown writeback has not landed is not retrieval evidence.
 */
export async function expandWikilinkNeighbors(
  db: Surreal,
  input: DirectNeighborInput,
): Promise<WikilinkNeighbor[]> {
  if (input.startNoteIds.length === 0) return [];
  // A wikilink endpoint may be a block (heading- or ^id-anchored link); a
  // block has no path of its own, so fall through to its note's path.
  const sql =
    "SELECT (in.path ?? in.note.path) AS fromPath, (out.path ?? out.note.path) AS toPath, agent FROM wikilink WHERE approved = true AND applied = true AND (in IN $starts OR out IN $starts) AND (in.tombstoned_at ?? in.note.tombstoned_at) IS NONE AND (out.tombstoned_at ?? out.note.tombstoned_at) IS NONE;";
  const slices: unknown = await db.query(sql, { starts: input.startNoteIds }).collect();
  return queryRows(slices, "wikilink expansion").map((value) => {
    if (
      !isRow(value) ||
      !isCanonicalPublicNotePath(value.fromPath) ||
      !isCanonicalPublicNotePath(value.toPath) ||
      (value.agent !== null && value.agent !== undefined && typeof value.agent !== "string")
    ) {
      throw new Error("wikilink expansion storage integrity: malformed edge row");
    }
    return {
      fromPath: value.fromPath,
      toPath: value.toPath,
      edgeType: "wikilink",
      agent: typeof value.agent === "string" ? value.agent : null,
    };
  });
}

export interface TypedEdgeNeighbor {
  fromPath: string;
  toPath: string;
  /** One of the six linker edge tables. */
  edgeType: string;
  agent: string | null;
  confidence: number;
}

function typedNeighborsFromSlice(
  slice: unknown,
  edgeType: (typeof WRITEBACK_EDGE_TABLES)[number],
): TypedEdgeNeighbor[] {
  if (!Array.isArray(slice)) {
    throw new Error(`${edgeType} expansion storage integrity: result is not an array`);
  }
  const neighbors: TypedEdgeNeighbor[] = [];
  for (const value of slice) {
    if (
      !isRow(value) ||
      !isCanonicalPublicNotePath(value.fromPath) ||
      !isCanonicalPublicNotePath(value.toPath) ||
      (value.agent !== null && value.agent !== undefined && typeof value.agent !== "string")
    ) {
      throw new Error(`${edgeType} expansion storage integrity: malformed edge row`);
    }
    const confidence = requireFiniteNumber(value.confidence, `${edgeType} confidence`);
    if (confidence < 0 || confidence > 1) {
      throw new Error(`${edgeType} expansion storage integrity: confidence is out of range`);
    }
    neighbors.push({
      fromPath: value.fromPath,
      toPath: value.toPath,
      edgeType,
      agent: typeof value.agent === "string" ? value.agent : null,
      confidence,
    });
  }
  return neighbors;
}

/**
 * Reads the direct neighbours of each start note across the six linker edge
 * tables and returns one row per (from, to, table) triple.
 *
 * Only approved-and-applied relationships participate. Pending inferred
 * edges remain visible in the operator Inbox and Explore surfaces, but they
 * are not trusted retrieval evidence until the human accepts them and any
 * Markdown writeback has committed.
 */
export async function expandTypedEdgeNeighbors(
  db: Surreal,
  input: DirectNeighborInput,
): Promise<TypedEdgeNeighbor[]> {
  if (input.startNoteIds.length === 0) return [];
  const predicate =
    "approved = true AND applied = true AND (in IN $starts OR out IN $starts) AND in.tombstoned_at IS NONE AND out.tombstoned_at IS NONE";
  const sql = WRITEBACK_EDGE_TABLES.map(
    (table) =>
      `SELECT in.path AS fromPath, out.path AS toPath, agent, confidence FROM ${table} WHERE ${predicate};`,
  ).join("\n");
  const slices: unknown = await db.query(sql, { starts: input.startNoteIds }).collect();
  if (!Array.isArray(slices) || slices.length !== WRITEBACK_EDGE_TABLES.length) {
    throw new Error(
      `typed edge expansion storage integrity: expected ${WRITEBACK_EDGE_TABLES.length} result slices`,
    );
  }
  const out: TypedEdgeNeighbor[] = [];
  for (let index = 0; index < WRITEBACK_EDGE_TABLES.length; index += 1) {
    out.push(...typedNeighborsFromSlice(slices[index], WRITEBACK_EDGE_TABLES[index]));
  }
  return out;
}

/**
 * Batched first-chunk text lookup, keyed by note path. Graph expansion uses
 * it to give expanded hits a real snippet instead of a `via [[...]]`
 * placeholder. Two round-trips total regardless of neighbour count.
 */
export async function fetchFirstChunkTextByPath(
  db: Surreal,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const noteIds = await lookupNoteIdsByPaths(db, paths);
  if (noteIds.size === 0) return out;
  const idToPath = new Map<string, string>();
  for (const [path, id] of noteIds) idToPath.set(id.toString(), path);
  const slices: unknown = await db
    .query(
      "SELECT note, text FROM chunk WHERE note INSIDE $notes AND ord = 0 AND note.tombstoned_at IS NONE;",
      { notes: Array.from(noteIds.values()) },
    )
    .collect();
  for (const value of queryRows(slices, "first chunk lookup")) {
    if (!isRow(value) || typeof value.text !== "string") {
      throw new Error("first chunk lookup storage integrity: malformed chunk row");
    }
    const note = requireRecordId(value.note, "note", "first chunk lookup");
    const path = idToPath.get(note.toString());
    if (path === undefined) {
      throw new Error("first chunk lookup storage integrity: returned an unrequested note");
    }
    if (!out.has(path)) out.set(path, value.text);
  }
  return out;
}

export interface ChunkInsertInput {
  ord: number;
  text: string;
  tokenEstimate: number;
  vector: number[];
}

export async function replaceChunks(
  db: Surreal,
  noteId: RecordId<"note">,
  embeddingIdentity: ResolvedEmbeddingIdentity,
  chunks: ChunkInsertInput[],
): Promise<RecordId<"chunk">[]> {
  const identity = createEmbeddingIdentity(embeddingIdentity.model, embeddingIdentity.dimension);
  const wrongWidth = chunks.findIndex((chunk) => chunk.vector.length !== identity.dimension);
  if (wrongWidth !== -1) {
    throw new Error(
      `replaceChunks: chunk ${wrongWidth} has ${chunks[wrongWidth].vector.length} dimensions; embedding identity '${identity.model}' requires ${identity.dimension}`,
    );
  }
  const nonFinite = chunks.findIndex((chunk) =>
    chunk.vector.some((value) => !Number.isFinite(value)),
  );
  if (nonFinite !== -1) {
    throw new Error(`replaceChunks: chunk ${nonFinite} contains a non-finite vector value`);
  }
  const blankText = chunks.findIndex(
    (chunk) => typeof chunk.text !== "string" || chunk.text.trim().length === 0,
  );
  if (blankText !== -1) {
    throw new Error(`replaceChunks: chunk ${blankText} contains no searchable text`);
  }
  await db.query("DELETE chunk WHERE note = $note;", { note: noteId }).collect();
  if (chunks.length === 0) {
    return [];
  }
  const inserted: RecordId<"chunk">[] = [];
  // embedded_at is set via SurrealQL time::now() so the value lands as a
  // native datetime; passing a JS Date through .content() would be coerced
  // to a string and fail the option<datetime> field assertion.
  const sql =
    "CREATE ONLY chunk CONTENT { note: $note, ord: $ord, text: $text, sha: $sha, token_estimate: $tokenEstimate, vector: $vector, embed_model: $embedModel, embedded_at: time::now() } RETURN id;";
  for (const chunk of chunks) {
    // CREATE ONLY returns a single record (not an array) per SurrealDB 3.x.
    const [row] = await db
      .query<[{ id: RecordId<"chunk"> } | null]>(sql, {
        note: noteId,
        ord: chunk.ord,
        text: chunk.text,
        sha: await sha256Hex(chunk.text),
        tokenEstimate: chunk.tokenEstimate,
        vector: chunk.vector,
        embedModel: identity.model,
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

/**
 * Fetch the chunks Tier 3 needs for a note, ordered by `ord` ascending.
 * Rows whose `vector` is `NONE` (e.g. an in-flight Tier 2 that has not yet
 * embedded a particular chunk), or whose stored model/width does not match
 * the active identity, are excluded server-side. Tier 3 never extracts from
 * a stale embedding space during a model migration.
 * Output is shaped to match `Tier3Chunk` so `runTier3` can consume it
 * directly.
 */
export async function fetchChunksForTier3(
  db: Surreal,
  noteId: RecordId<"note">,
  embeddingIdentity: ResolvedEmbeddingIdentity,
): Promise<Array<{ id: RecordId<"chunk">; ord: number; text: string; vector: number[] }>> {
  const identity = createEmbeddingIdentity(embeddingIdentity.model, embeddingIdentity.dimension);
  const slices: unknown = await db
    .query(
      "SELECT id, ord, text, vector FROM chunk WHERE note = $note AND vector != NONE AND embed_model = $embedModel AND array::len(vector) = $embedDimension ORDER BY ord;",
      {
        note: noteId,
        embedModel: identity.model,
        embedDimension: identity.dimension,
      },
    )
    .collect();
  const rows = readSingleStatementRows(slices, "Tier 3 chunk lookup");
  const chunks = rows.map((row, index) => decodeTier3ChunkRow(row, index, identity.dimension));
  for (let index = 1; index < chunks.length; index += 1) {
    if (chunks[index - 1].ord >= chunks[index].ord) {
      throw new Error("Tier 3 chunk lookup storage integrity: rows are not ordered by unique ord");
    }
  }
  return chunks;
}

function decodeTier3ChunkRow(
  raw: unknown,
  index: number,
  dimension: number,
): { id: RecordId<"chunk">; ord: number; text: string; vector: number[] } {
  const label = `Tier 3 chunk lookup row ${index}`;
  if (!isExactRecord(raw, ["id", "ord", "text", "vector"])) {
    throw new Error(`${label} storage integrity: invalid fields`);
  }
  if (!(raw.id instanceof RecordId)) {
    throw new Error(`${label} storage integrity: id is not a native chunk record id`);
  }
  const id = parseSurrealRelationRecordId(raw.id.toString(), ["chunk"], `${label} id`).recordId;
  if (typeof raw.ord !== "number" || !Number.isSafeInteger(raw.ord) || raw.ord < 0) {
    throw new Error(`${label} storage integrity: ord is not a nonnegative safe integer`);
  }
  if (typeof raw.text !== "string" || raw.text.length === 0) {
    throw new Error(`${label} storage integrity: text is not a nonempty string`);
  }
  if (
    !Array.isArray(raw.vector) ||
    raw.vector.length !== dimension ||
    !raw.vector.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    throw new Error(`${label} storage integrity: vector does not match the active embedding space`);
  }
  return { id, ord: raw.ord, text: raw.text, vector: [...raw.vector] };
}

export async function markTier3Done(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  await db.query("UPDATE $id SET tier3_at = time::now();", { id: noteId }).collect();
}

/**
 * Per-tier completion state for a note. `true` means the note's
 * `tier{N}_at` is set (the tier has run); `false` means it is `NONE`
 * or the note row does not yet exist. Used by `indexNote` to skip
 * tiers that are already up to date when running under a tier filter.
 */
export interface NoteTierState {
  tier1Done: boolean;
  tier2Done: boolean;
  tier3Done: boolean;
}

/**
 * Return the stored `sha` for the `note` row at `path`, or `null` when no
 * row exists. Used by `indexNote` to detect a watcher-edit drift between
 * the on-disk body sha and the previously indexed sha so the orchestrator
 * can force a full re-run of every tier instead of short-circuiting on
 * stale `tier{N}_at` stamps.
 * Mirrors `fetchNoteTierState` in shape so the indexer can fetch tier state
 * and the prior sha from the same row in adjacent calls.
 */
export async function fetchNoteShaByPath(db: Surreal, path: string): Promise<string | null> {
  const slices: unknown = await db
    .query("SELECT sha FROM note WHERE path = $path LIMIT 1;", { path })
    .collect();
  const rows = readSingleStatementRows(slices, "note sha lookup");
  if (rows.length > 1) throw new Error("note storage integrity: sha lookup returned two rows");
  const row = rows[0];
  if (row === undefined) return null;
  if (!isExactRecord(row, ["sha"])) {
    throw new Error("note storage integrity: existing note has an invalid sha");
  }
  const sha = row.sha;
  if (typeof sha !== "string") {
    throw new Error("note storage integrity: existing note has an invalid sha");
  }
  return sha;
}

/**
 * Read the per-tier completion state for the note at `path`. Missing
 * notes (no row in `note`) return all-false so a fresh note runs every
 * tier the caller's filter allows.
 *
 * The query selects the raw tier columns; an unset `option<datetime>`
 * collapses to `false`.
 */
export async function fetchNoteTierState(db: Surreal, path: string): Promise<NoteTierState> {
  const slices: unknown = await db
    .query(
      "SELECT tier1_at, tier2_at, tier3_at, structural_version FROM note WHERE path = $path LIMIT 1;",
      {
        path,
      },
    )
    .collect();
  const rows = readSingleStatementRows(slices, "note tier lookup");
  if (rows.length > 1) throw new Error("note storage integrity: tier lookup returned two rows");
  const row = rows[0];
  if (row === undefined) {
    return { tier1Done: false, tier2Done: false, tier3Done: false };
  }
  if (!isExactRecord(row, ["tier1_at", "tier2_at", "tier3_at", "structural_version"])) {
    throw new Error("note storage integrity: tier lookup returned a malformed row");
  }
  return {
    tier1Done:
      readOptionalTierStamp(row.tier1_at, "tier1_at") &&
      row.structural_version === STRUCTURAL_INDEX_VERSION,
    tier2Done: readOptionalTierStamp(row.tier2_at, "tier2_at"),
    tier3Done: readOptionalTierStamp(row.tier3_at, "tier3_at"),
  };
}

function readOptionalTierStamp(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (!(value instanceof DateTime)) {
    throw new Error(`note storage integrity: ${label} is not a native SurrealDB datetime`);
  }
  const milliseconds = value.toDate().getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`note storage integrity: ${label} is not a valid datetime`);
  }
  return true;
}

/**
 * Clear the `tier{N}_at` columns listed in `tiers` for the note matching
 * `path`. The note row stays put; only the tier-completion timestamps
 * are reset to NONE so a subsequent indexer pass treats the cleared
 * tiers as un-run. Invalid or empty filters fail before issuing a query.
 *
 * SurrealDB's `option<datetime>` fields reject null bindings, so the SET
 * clause emits the literal `NONE` token instead of binding a value.
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
  const canonical = readTierFilter(tiers);
  const setClauses = canonical.map((tier) => `tier${tier}_at = NONE`);
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
  note: { id: RecordId<"note">; path: string };
  d: number;
}

interface GroupedNeighborRows {
  noteId: RecordId<"note">;
  notePath: string;
  rows: NeighborRow[];
}

/**
 * Four kNN probes of `k` each can group into dozens of candidate notes with
 * several evidence chunks apiece. `LINKER.maxCandidates` keeps the best
 * neighbours by `bestDistance`, and `LINKER.maxEvidencePerNote` bounds each
 * note's evidence so prompt size stays flat as notes grow.
 */
const MAX_EVIDENCE_PER_NOTE = LINKER.maxEvidencePerNote;
const MAX_LINKER_CANDIDATES = LINKER.maxCandidates;
const DEFAULT_LINKER_EF = 40;
const LINKER_PROBE_VECTORS = 4;

/** First vector plus evenly spaced ones, at most `count`, in note order. */
export function selectProbeVectors(vectors: number[][], count: number): number[][] {
  if (vectors.length <= count) return vectors;
  const out: number[][] = [];
  const step = (vectors.length - 1) / (count - 1);
  for (let index = 0; index < count; index += 1) {
    out.push(vectors[Math.round(index * step)]);
  }
  return out;
}

async function queryNeighborRows(
  db: Surreal,
  sql: string,
  activeNoteId: RecordId<"note">,
  probes: number[][],
): Promise<NeighborRow[]> {
  const rows: NeighborRow[] = [];
  const seen = new Set<string>();
  for (const queryVector of probes) {
    const results: unknown = await db
      .query(sql, { active: activeNoteId, q: queryVector })
      .collect();
    if (!Array.isArray(results) || results.length !== 3 || !Array.isArray(results[2])) {
      throw new Error("linker neighbor storage integrity: invalid query result slices");
    }
    for (const value of results[2]) {
      const row = parseNeighborRow(value);
      const key = row.id.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

function parseNeighborRow(value: unknown): NeighborRow {
  if (!isRow(value)) {
    throw new Error("linker neighbor storage integrity: row is not an object");
  }
  const id = requireRecordId(value.id, "chunk", "linker neighbor");
  const note = requireFetchedNote(value.note, "linker neighbor");
  const d = requireFiniteNumber(value.d, "linker neighbor distance");
  if (d < 0) {
    throw new Error("linker neighbor storage integrity: distance is negative");
  }
  return { id, note, d };
}

function groupNeighborRows(rows: NeighborRow[]): Map<string, GroupedNeighborRows> {
  const grouped = new Map<string, GroupedNeighborRows>();
  for (const row of rows) {
    const noteId = row.note.id;
    const notePath = row.note.path;
    const key = noteId.toString();
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, { noteId, notePath, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }
  return grouped;
}

function neighborCandidates(grouped: Map<string, GroupedNeighborRows>): NeighborCandidate[] {
  const candidates: NeighborCandidate[] = [];
  for (const entry of grouped.values()) {
    const sortedRows = entry.rows.slice().sort((a, b) => a.d - b.d);
    candidates.push({
      noteId: entry.noteId,
      notePath: entry.notePath,
      bestDistance: sortedRows[0].d,
      evidenceChunkIds: sortedRows.slice(0, MAX_EVIDENCE_PER_NOTE).map((row) => row.id),
    });
  }
  candidates.sort((a, b) => a.bestDistance - b.bestDistance);
  return candidates.slice(0, MAX_LINKER_CANDIDATES);
}

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
  const ef = input.ef ?? DEFAULT_LINKER_EF;
  const operator = `<|${input.k},${ef}|>`;
  // A long note is not its first paragraph. Probe with several vectors
  // spread across the note and merge the neighbourhoods; a candidate
  // only needs embeddings (tier2_at), not a finished extraction, so the
  // first full pass over a vault can link early notes to later ones.
  const probes = selectProbeVectors(input.activeChunkVectors, LINKER_PROBE_VECTORS);
  // Multi-statement query: SurrealDB returns one result slice per statement.
  // We only care about the final SELECT, so we read the last slice.
  // Tier 1 writes wikilink edges block-anchored: `in` is a `block` record
  // whose `note` field points at the source note, and `out` is either a note
  // or another block. A graph walk from the note (`->wikilink->note`) never
  // sees those edges, so the linker kept proposing typed edges to notes the
  // author had already wikilinked. The exclusion sets are computed over the
  // `wikilink` table directly with the same endpoint fallback that
  // `expandWikilinkNeighbors` uses.
  const sql = [
    "LET $excluded = (SELECT VALUE (out.note ?? out) FROM wikilink WHERE in = $active OR in.note = $active);",
    "LET $excludedBack = (SELECT VALUE (in.note ?? in) FROM wikilink WHERE out = $active OR out.note = $active);",
    `SELECT id, note, vector::distance::knn() AS d FROM chunk WHERE vector ${operator} $q AND note != $active AND note NOT IN $excluded AND note NOT IN $excludedBack AND note.tier2_at != NONE AND note.tombstoned_at IS NONE ORDER BY d FETCH note;`,
  ].join("\n");
  const rows = await queryNeighborRows(db, sql, input.activeNoteId, probes);
  return neighborCandidates(groupNeighborRows(rows));
}

/**
 * Fetch the text of specific chunks by record id, returned as an
 * id-string -> text map. Used by the linker to render bounded evidence
 * snippets for its candidate neighbours in a single round trip.
 */
export async function fetchChunkTexts(
  db: Surreal,
  ids: Array<RecordId<"chunk">>,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const slices: unknown = await db
    .query("SELECT id, text FROM chunk WHERE id IN $ids;", { ids })
    .collect();
  const out = new Map<string, string>();
  for (const value of queryRows(slices, "chunk text lookup")) {
    if (!isRow(value) || typeof value.text !== "string") {
      throw new Error("chunk text lookup storage integrity: malformed row");
    }
    const id = requireRecordId(value.id, "chunk", "chunk text lookup");
    out.set(id.toString(), value.text);
  }
  return out;
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

export interface ConceptUpsertOptions {
  kind?: string;
  source?: string;
}

export interface ClaimUpsertOptions {
  kind?: string;
}

export async function upsertConcept(
  db: Surreal,
  label: string,
  options: ConceptUpsertOptions = {},
): Promise<RecordId<"concept">> {
  const normalized = normalizeLabel(label);
  const kind = options.kind ?? "other";
  const source = options.source ?? "extractor";
  const [rows] = await db
    .query<[Array<{ id: RecordId<"concept"> }>]>(
      "SELECT id FROM concept WHERE norm_label = $norm LIMIT 1;",
      { norm: normalized },
    )
    .collect<[Array<{ id: RecordId<"concept"> }>]>();
  if (rows[0] !== undefined) {
    await db
      .query("UPDATE $id SET kind = $kind, source = $source;", {
        id: rows[0].id,
        kind,
        source,
      })
      .collect();
    return rows[0].id;
  }
  const [record] = await db
    .create<{ id: RecordId<"concept">; label: string; norm_label: string }>(new Table("concept"))
    .content({ label, norm_label: normalized, kind, source });
  if (record === undefined) {
    throw new Error("upsertConcept: SurrealDB returned no record");
  }
  return record.id;
}

export async function upsertClaim(
  db: Surreal,
  text: string,
  options: ClaimUpsertOptions = {},
): Promise<RecordId<"claim">> {
  const sha = await sha256Hex(text);
  const kind = options.kind ?? "assertion";
  const [rows] = await db
    .query<[Array<{ id: RecordId<"claim"> }>]>("SELECT id FROM claim WHERE sha = $sha LIMIT 1;", {
      sha,
    })
    .collect<[Array<{ id: RecordId<"claim"> }>]>();
  if (rows[0] !== undefined) {
    await db.query("UPDATE $id SET kind = $kind;", { id: rows[0].id, kind }).collect();
    return rows[0].id;
  }
  const [record] = await db
    .create<{ id: RecordId<"claim">; text: string; sha: string }>(new Table("claim"))
    .content({ text, sha, kind });
  if (record === undefined) {
    throw new Error("upsertClaim: SurrealDB returned no record");
  }
  return record.id;
}

/**
 * Daemon-write audit row: a tamper-evident record that an agent wrote to a
 * note's body for a specific body sha. Tier 1 reads the most recent matching
 * row to retain the authenticated client in the edge's `agent` field while
 * preserving canonical `wikilink` / `embed` / `frontmatter` source authority.
 *
 * Rows are immutable once inserted.
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
  const [record] = await db
    .create<{ id: RecordId<"daemon_write"> }>(new Table("daemon_write"))
    .content({
      note: input.noteId,
      sha: input.sha,
      agent: input.agent,
      targets: input.targets,
    });
  if (record === undefined) {
    throw new Error("recordDaemonWrite: SurrealDB returned no record");
  }
  return record.id;
}

export interface FindRecentDaemonWriteInput {
  noteId: RecordId<"note">;
  sha: string;
  /**
   * Tolerance window in seconds. Defaults to 60s to cover realistic watcher
   * timing on the dogfood corpus: ~5s debounce plus tier 1 reindex up to
   * ~30s plus clock-skew margin all add up well above the original 5s.
   */
  withinSeconds?: number;
}

export interface DaemonWriteMatch {
  agent: string;
  targets: RecordId[];
}

const DEFAULT_DAEMON_WRITE_WINDOW_SECONDS = 60;

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
  // host with sub-second skew the 60s default tolerates the file-write /
  // watcher race plus tier 1 reindex latency. Cross-host SurrealDB
  // deployments with multi-second skew may need a wider window or a
  // server-side cutoff via `time::now() - <duration>`.
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
  const [record] = await db
    .create<{ id: RecordId<"question">; text: string; sha: string }>(new Table("question"))
    .content({ text, sha });
  if (record === undefined) {
    throw new Error("upsertQuestion: SurrealDB returned no record");
  }
  return record.id;
}
