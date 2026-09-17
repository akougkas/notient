/**
 * Idempotent SurrealDB schema applier for the Notient vault graph.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md §3.6.
 *
 * The `DEFINE ACCESS agent_jwt` block in `schema.surql` references the session
 * parameter `$NOTIENT_AGENT_JWT_KEY`. That parameter MUST be bound via `db.set`
 * (the SDK's wrapper for the SurrealQL `LET` statement) BEFORE the schema query
 * runs, otherwise SurrealDB rejects the DDL with an undefined-parameter error.
 * The applier enforces this ordering.
 *
 * Provenance fields for every edge table live in TypeScript (see
 * `./edgeTables.ts`) and are emitted as a second `query` call after the base
 * schema, so the canonical edge list stays in one place.
 *
 * The applier also owns three embedding-index responsibilities:
 *
 *   1. Parametric vector width. `schema.surql` carries a `{{EMBED_DIM}}`
 *      placeholder instead of a hardcoded 768. The width comes from the
 *      boot-time embedding probe (`src/core/llm/embeddingProbe.ts`), falling
 *      back to the width recorded in `meta:embedding`, or to no constraint on
 *      a genuinely fresh database.
 *   2. Self-healing model switches. When the probe reports a model or
 *      dimension that differs from `meta:embedding`, every stored vector is
 *      invalidated and `note.tier2_at` is reset. Tier 3 extraction and its
 *      graph stay intact; a durable note flag schedules a linker-only refresh
 *      after Tier 2 has been rebuilt against the new model.
 *   3. Index reconciliation. HNSW and FULLTEXT index builds are expensive.
 *      `INFO FOR TABLE chunk` is consulted first and the managed indexes are
 *      (re)defined only when missing or built at the wrong dimension.
 */

import type { Surreal } from "surrealdb";
import { backfillReviewPreviews } from "../approvals/reviewStorage";
import { AGENT_ID_PATTERN } from "../auth/agentIdentity";
import { EDGE_TABLES, EXTRACTOR_EDGE_TABLES, provenanceFields } from "./edgeTables";

const MANAGED_BEGIN = "-- BEGIN MANAGED INDEXES";
const MANAGED_END = "-- END MANAGED INDEXES";
const EMBED_DIM_PLACEHOLDER = "{{EMBED_DIM}}";
const AGENT_ID_PATTERN_PLACEHOLDER = "{{AGENT_ID_PATTERN}}";

export interface EmbeddingMeta {
  model: string;
  dimension: number;
}

interface ApplySchemaBaseOptions {
  /** Structured log sink. Defaults to a JSON line on stderr. */
  log?: (line: string) => void;
}

/**
 * The boot probe has exactly two honest outcomes: a resolved model/width pair,
 * or an explicit failure. Omitted fields and half-resolved identities are not
 * valid schema inputs.
 */
export type ApplySchemaOptions = ApplySchemaBaseOptions &
  ({ embedDim: number; embedModel: string } | { embedDim: null; embedModel: null });

export interface ApplySchemaResult {
  /** Width the schema was actually applied at; `null` when unconstrained. */
  embedDim: number | null;
  /**
   * Embedding state recorded in `meta:embedding` before this call.
   */
  previousEmbedding: EmbeddingMeta | null;
  /** True when a model/dimension change invalidated stored vectors. */
  vectorsInvalidated: boolean;
  /** Managed indexes (re)defined during this call. */
  indexesDefined: string[];
}

interface SchemaSources {
  base: string;
  vectorIndex: string;
  textIndex: string;
}

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

function substituteDim(sql: string, embedDim: number | null): string {
  if (embedDim === null) {
    return sql.replaceAll(`<float, ${EMBED_DIM_PLACEHOLDER}>`, "<float>");
  }
  return sql.replaceAll(EMBED_DIM_PLACEHOLDER, String(embedDim));
}

function substituteAgentIdPattern(sql: string): string {
  if (!sql.includes(AGENT_ID_PATTERN_PLACEHOLDER)) {
    throw new Error(
      "applySchema: schema.surql is missing the agent identity placeholder; storage and authentication would have split authority",
    );
  }
  return sql.replaceAll(AGENT_ID_PATTERN_PLACEHOLDER, AGENT_ID_PATTERN.source);
}

function splitManagedIndexes(source: string): SchemaSources {
  const begin = source.indexOf(MANAGED_BEGIN);
  const end = source.indexOf(MANAGED_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      "applySchema: schema.surql is missing the managed-index markers; the applier and the schema file are out of sync",
    );
  }
  const block = source.slice(begin + MANAGED_BEGIN.length, end);
  const base = `${source.slice(0, begin)}${source.slice(end + MANAGED_END.length)}`;

  const statements = block
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !statement.startsWith("--"))
    .map((statement) => `${statement};`);

  const vectorIndex = statements.find((statement) => statement.includes("chunk_vec"));
  const textIndex = statements.find((statement) => statement.includes("chunk_text"));
  if (vectorIndex === undefined || textIndex === undefined) {
    throw new Error(
      "applySchema: managed-index block must contain both the chunk_vec and chunk_text definitions",
    );
  }
  return { base, vectorIndex, textIndex };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class EmbeddingStorageIntegrityError extends Error {
  constructor(message: string) {
    super(`embedding storage integrity: ${message}`);
    this.name = "EmbeddingStorageIntegrityError";
  }
}

function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:table.*does not exist|does not exist.*table)/i.test(message);
}

/**
 * SurrealDB accepts `ENFORCED` when a relation table is redefined, but it does
 * not retroactively remove rows whose endpoints were already missing. Repair
 * those rows before the enforcing DDL lands. Checking the current database
 * definition keeps this a one-time transition instead of a graph-wide scan on
 * every daemon boot; if the process stops between cleanup and DDL, the next
 * boot sees the still-unenforced table and repeats the idempotent cleanup.
 */
async function repairUnenforcedExtractorEndpoints(db: Surreal): Promise<void> {
  const slices: unknown = await db.query("INFO FOR DB;").collect();
  if (!Array.isArray(slices) || slices.length !== 1 || !isRecord(slices[0])) {
    throw new Error("applySchema: database information returned an invalid envelope");
  }
  const tables = slices[0].tables;
  if (!isRecord(tables)) {
    throw new Error("applySchema: database information has no table definitions");
  }

  const repair: string[] = [];
  for (const table of EXTRACTOR_EDGE_TABLES) {
    const definition = tables[table];
    if (definition === undefined) continue;
    if (typeof definition !== "string") {
      throw new Error(`applySchema: ${table} table definition is not a string`);
    }
    if (/\bENFORCED\b/i.test(definition)) continue;
    repair.push(`DELETE ${table} WHERE !record::exists(in) OR !record::exists(out) RETURN NONE;`);
  }
  if (repair.length > 0) await db.query(repair.join("\n")).collect();
}

/**
 * Reads `meta:embedding`. Returns null when the table or row does not exist.
 *
 * `SELECT *` rather than `SELECT value`: `value` is a SurrealQL keyword and
 * `SELECT value FROM ...` parses as the `SELECT VALUE` projection, which is a
 * syntax error here.
 */
async function readEmbeddingMeta(db: Surreal): Promise<EmbeddingMeta | null> {
  let result: unknown;
  try {
    const slices = await db
      .query<[unknown]>("SELECT * FROM meta WHERE key = 'embedding';")
      .collect<[unknown]>();
    if (!Array.isArray(slices) || slices.length !== 1) {
      throw new EmbeddingStorageIntegrityError("meta query returned an invalid statement envelope");
    }
    [result] = slices;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
  if (!Array.isArray(result)) {
    throw new EmbeddingStorageIntegrityError("meta query result is not an array");
  }
  if (result.length === 0) return null;
  if (result.length !== 1 || !isRecord(result[0])) {
    throw new EmbeddingStorageIntegrityError("meta:embedding is not exactly one object row");
  }
  const value = result[0].value;
  if (!isRecord(value)) {
    throw new EmbeddingStorageIntegrityError("meta:embedding.value is not an object");
  }
  const model = value.model;
  const dimension = value.dimension;
  if (typeof model !== "string" || model.length === 0 || model.trim() !== model) {
    throw new EmbeddingStorageIntegrityError("meta:embedding model is not canonical");
  }
  if (typeof dimension !== "number" || !Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new EmbeddingStorageIntegrityError("meta:embedding dimension is not a positive integer");
  }
  return { model, dimension };
}

/**
 * A database with vectors but no embedding identity cannot be interpreted
 * safely. It is neither a fresh database nor a valid model migration state.
 */
async function assertNoUnidentifiedVectors(db: Surreal): Promise<void> {
  let result: unknown;
  try {
    const slices = await db
      .query<[unknown]>("SELECT id FROM chunk WHERE vector != NONE LIMIT 1;")
      .collect<[unknown]>();
    if (!Array.isArray(slices) || slices.length !== 1) {
      throw new EmbeddingStorageIntegrityError(
        "orphan-vector query returned an invalid statement envelope",
      );
    }
    [result] = slices;
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw error;
  }
  if (!Array.isArray(result)) {
    throw new EmbeddingStorageIntegrityError("orphan-vector query result is not an array");
  }
  if (result.length > 0) {
    throw new EmbeddingStorageIntegrityError("stored vectors exist without meta:embedding");
  }
}

/**
 * Existing index DDL for `chunk`, keyed by index name. Empty when the table
 * does not exist yet.
 */
async function readChunkIndexes(db: Surreal): Promise<Record<string, string>> {
  try {
    const slices = await db.query<[unknown]>("INFO FOR TABLE chunk;").collect<[unknown]>();
    if (!Array.isArray(slices) || slices.length !== 1) {
      throw new EmbeddingStorageIntegrityError(
        "chunk index query returned an invalid statement envelope",
      );
    }
    const info = slices[0];
    if (!isRecord(info) || !isRecord(info.indexes)) {
      throw new EmbeddingStorageIntegrityError("chunk table information has no index map");
    }
    const out: Record<string, string> = {};
    for (const [name, ddl] of Object.entries(info.indexes)) {
      if (typeof ddl !== "string") {
        throw new EmbeddingStorageIntegrityError(`chunk index ${name} has non-string DDL`);
      }
      out[name] = ddl;
    }
    return out;
  } catch (error) {
    if (isMissingTableError(error)) return {};
    throw error;
  }
}

function hnswDimensionOf(ddl: string | undefined): number | null {
  if (ddl === undefined) return null;
  const match = ddl.match(/DIMENSION\s+(\d+)/i);
  return match === null ? null : Number(match[1]);
}

function embeddingChanged(previous: EmbeddingMeta, current: EmbeddingMeta): boolean {
  return previous.model !== current.model || previous.dimension !== current.dimension;
}

/**
 * A model or dimension change invalidates every stored vector, and the wipe
 * MUST happen while the old width is still the declared one: redefining
 * `chunk.vector` to the new width first makes every existing row fail
 * validation, and even `SET vector = NONE` is then rejected. Order is drop
 * the index, rewind the Tier 2 stamp, invalidate the vectors, and only then
 * apply the schema at the new width. Tier 3's stamp and extracted graph are
 * deliberately untouched: only the linker's vector-derived proposals need
 * refreshing after Tier 2 has been rebuilt.
 *
 * One transaction, stamps rewound before the vectors are dropped. Run as
 * three separate statements a crash in the middle could leave chunks with
 * `vector = NONE` while `tier2_at` was still stamped, and the vault would
 * never be re-embedded.
 */
async function healEmbeddingChange(
  db: Surreal,
  log: (line: string) => void,
  previous: EmbeddingMeta,
  current: EmbeddingMeta,
): Promise<boolean> {
  log(
    JSON.stringify({
      type: "daemon:embedding_model_changed",
      previous,
      current,
      vectorsInvalidated: true,
    }),
  );
  await db.query(
    [
      "BEGIN TRANSACTION;",
      "REMOVE INDEX IF EXISTS chunk_vec ON chunk;",
      "UPDATE note SET tier2_at = NONE;",
      "UPDATE chunk SET vector = NONE, embed_model = NONE, embedded_at = NONE;",
      "DELETE conversation_memory;",
      "COMMIT TRANSACTION;",
    ].join("\n"),
  );
  return true;
}

function validateApplySchemaOptions(options: ApplySchemaOptions): void {
  const hasHalfIdentity = (options.embedDim === null) !== (options.embedModel === null);
  const hasInvalidDimension =
    options.embedDim !== null && (!Number.isInteger(options.embedDim) || options.embedDim <= 0);
  const hasInvalidModel = options.embedModel !== null && options.embedModel.trim().length === 0;
  if (hasHalfIdentity || hasInvalidDimension || hasInvalidModel) {
    throw new Error(
      "applySchema: embedDim and embedModel must be a resolved positive-width identity or null together",
    );
  }
}

export async function applySchema(
  db: Surreal,
  jwtKey: string,
  options: ApplySchemaOptions,
): Promise<ApplySchemaResult> {
  const log = options.log ?? defaultLog;
  validateApplySchemaOptions(options);
  await db.set("NOTIENT_AGENT_JWT_KEY", jwtKey);
  await repairUnenforcedExtractorEndpoints(db);

  const storedEmbedding = await readEmbeddingMeta(db);
  if (storedEmbedding === null) await assertNoUnidentifiedVectors(db);
  const previousEmbedding = storedEmbedding;

  const probeDim = options.embedDim;
  const probeModel = options.embedModel;

  // Resolve the width the schema is applied at. A failed probe (null) reuses
  // whatever the database was last built for; with no stored width there is
  // nothing honest to assert, so the constraint and the HNSW index are both
  // dropped and Tier 2 fails fast at the embedder instead.
  const embedDim = probeDim ?? previousEmbedding?.dimension ?? null;
  if (probeDim === null) {
    log(
      JSON.stringify({
        type: "daemon:embedding_dimension_unknown",
        storedDimension: previousEmbedding?.dimension ?? null,
        applied: embedDim,
      }),
    );
  }

  const current: EmbeddingMeta | null =
    probeModel !== null && embedDim !== null ? { model: probeModel, dimension: embedDim } : null;
  const vectorsInvalidated =
    current !== null && previousEmbedding !== null && embeddingChanged(previousEmbedding, current)
      ? await healEmbeddingChange(db, log, previousEmbedding, current)
      : false;

  const rawSource = await Bun.file(new URL("./schema.surql", import.meta.url)).text();
  const sources = splitManagedIndexes(substituteAgentIdPattern(rawSource));

  await db.query(substituteDim(sources.base, embedDim));
  await backfillReviewPreviews(db);

  const provenanceSource = EDGE_TABLES.map(provenanceFields).join("\n");
  await db.query(provenanceSource);

  const indexesDefined = await reconcileManagedIndexes(db, sources, embedDim, log);

  if (current !== null && vectorsInvalidated) {
    // This is the durable hand-off to bootstrap's two-phase repair. It must
    // land only after both the schema and managed indexes are ready, and the
    // pending flags must be atomic with the new meta row. If the process dies
    // before this transaction, the old meta record makes the next boot repeat
    // the idempotent invalidation. If it dies after commit, the note flags make
    // the Tier 2 -> linker repair resumable without touching Tier 3 extraction.
    await db.query(
      [
        "BEGIN TRANSACTION;",
        "UPDATE note SET linker_refresh_pending = true WHERE tombstoned_at IS NONE;",
        "UPSERT meta:embedding CONTENT { key: 'embedding', value: { model: $model, dimension: $dimension }, updated_at: time::now() };",
        "COMMIT TRANSACTION;",
      ].join("\n"),
      { model: current.model, dimension: current.dimension },
    );
  } else if (current !== null && storedEmbedding === null) {
    await db.query(
      "UPSERT meta:embedding CONTENT { key: 'embedding', value: { model: $model, dimension: $dimension }, updated_at: time::now() };",
      { model: current.model, dimension: current.dimension },
    );
  }

  return { embedDim, previousEmbedding, vectorsInvalidated, indexesDefined };
}

async function reconcileManagedIndexes(
  db: Surreal,
  sources: SchemaSources,
  embedDim: number | null,
  log: (line: string) => void,
): Promise<string[]> {
  const existing = await readChunkIndexes(db);
  const defined: string[] = [];

  if (embedDim === null) {
    if (existing.chunk_vec !== undefined) {
      // Nothing valid to rebuild at, and an index whose width we cannot
      // confirm is worse than none. Leave it alone rather than churn.
      log(JSON.stringify({ type: "daemon:embedding_index_skipped", reason: "unknown_dimension" }));
    }
  } else {
    const existingVectorIndex = existing.chunk_vec;
    const currentDim = hnswDimensionOf(existingVectorIndex);
    if (existingVectorIndex !== undefined && currentDim === null) {
      throw new EmbeddingStorageIntegrityError("chunk_vec DDL has no HNSW dimension");
    }
    if (currentDim !== embedDim) {
      if (existingVectorIndex !== undefined) {
        await db.query("REMOVE INDEX IF EXISTS chunk_vec ON chunk;");
      }
      await db.query(substituteDim(sources.vectorIndex, embedDim));
      defined.push("chunk_vec");
    }
  }

  if (existing.chunk_text === undefined) {
    await db.query(sources.textIndex);
    defined.push("chunk_text");
  }

  return defined;
}
