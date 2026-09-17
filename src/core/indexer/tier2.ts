import { createHash } from "node:crypto";
import type { RecordId, Surreal } from "surrealdb";
import { lookupNoteByPath } from "../db/surreal";
import { type EventBus, assertEventBus } from "../events/eventBus";
import type { ResolvedEmbeddingIdentity } from "../llm/embeddingIdentity";
import type { BlockSpec } from "../markdown/types";
import { type ChunkBlockSizes, type ChunkSpec, chunkBlocks, tokenEstimate } from "./chunker";
import { type Embedder, EmbeddingContextOverflowError } from "./embedder";

/**
 * Tier 2 indexer: chunks the note body, embeds each chunk, and writes
 * the chunk rows alongside `note.tier2_at` inside a single SurrealQL
 * transaction.
 *
 * Atomicity is delivered via a single SurrealQL script bracketed by
 * `BEGIN TRANSACTION;` / `COMMIT TRANSACTION;`. SurrealDB rolls the
 * entire script back when any statement fails, so a partial chunk
 * insert never leaves stale rows behind and `tier2_at` only advances on
 * full success. Pre-resolution work (note lookup, chunking, embedding)
 * runs BEFORE the transaction; the transaction body only writes.
 *
 * `chunk.embed_model` is stamped from the embedder's boot-resolved identity.
 * The same identity constrains every vector width, and is what the schema
 * applier compares against `meta:embedding` to decide whether a model swap
 * invalidates stored vectors.
 */

export interface Tier2Input {
  signal?: AbortSignal;
  authorize?: () => Promise<void>;
  notePath: string;
  sourceRevision?: string;
  blocks: BlockSpec[];
  embedder: Embedder;
  /** Receives a durable `indexer:warn` event for every quarantined chunk. */
  bus: EventBus;
  /** Validated chunk sizes from the boot configuration. */
  chunkSizes: ChunkBlockSizes;
}

export interface Tier2Output {
  noteId: RecordId<"note">;
  chunkCount: number;
  quarantinedCount: number;
  embeddingIdentity: ResolvedEmbeddingIdentity;
}

interface TransactionScript {
  sql: string;
  bindings: Record<string, unknown>;
}

interface StoredChunk {
  id: RecordId<"chunk">;
  ord: number;
  text: string;
  sha?: string;
}

interface PreparedChunk {
  chunk: ChunkSpec;
  vector?: number[];
  embedError?: string;
}

async function listChunksForNote(db: Surreal, noteId: RecordId<"note">): Promise<StoredChunk[]> {
  const [rows] = await db
    .query<[StoredChunk[]]>(
      "SELECT id, ord, text, sha FROM chunk WHERE note = $note ORDER BY ord;",
      {
        note: noteId,
      },
    )
    .collect<[StoredChunk[]]>();
  return rows;
}

async function listBlockIdsByOrd(
  db: Surreal,
  noteId: RecordId<"note">,
): Promise<Map<number, RecordId<"block">>> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"block">; ord: number }>]>(
      "SELECT id, ord FROM block WHERE note = $note ORDER BY ord;",
      { note: noteId },
    )
    .collect<[Array<{ id: RecordId<"block">; ord: number }>]>();
  return new Map(rows.map((row) => [row.ord, row.id]));
}

function buildTier2Transaction(
  noteId: RecordId<"note">,
  preparedChunks: PreparedChunk[],
  existingChunks: StoredChunk[],
  blockIdsByOrd: ReadonlyMap<number, RecordId<"block">>,
  embeddingIdentity: ResolvedEmbeddingIdentity | null,
  sourceRevision?: string,
): TransactionScript {
  const statements: string[] = [];
  const bindings: Record<string, unknown> = { note: noteId, sourceRevision };
  const chunks = preparedChunks.map((prepared) => prepared.chunk);
  const reuse = planChunkReuse(chunks, existingChunks);
  const cachedHashes = new Map(existingChunks.map((row) => [row.id.toString(), row.sha]));

  statements.push("BEGIN TRANSACTION;");
  if (sourceRevision !== undefined)
    statements.push(
      "IF (SELECT VALUE sha FROM ONLY $note) != $sourceRevision { THROW 'source revision changed before chunk persistence'; };",
    );
  if (existingChunks.length > 0) {
    // Free every non-negative final ordinal before assigning the new order.
    // The transaction makes the temporary negative ordinals unobservable.
    statements.push("UPDATE chunk SET ord = -ord - 1 WHERE note = $note;");
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const prepared = preparedChunks[index];
    bindings[`c${index}_ord`] = chunk.ord;
    bindings[`c${index}_startLine`] = chunk.startLine;
    bindings[`c${index}_endLine`] = chunk.endLine;
    bindings[`c${index}_block`] =
      chunk.blockOrd === null ? undefined : (blockIdsByOrd.get(chunk.blockOrd) ?? undefined);
    bindings[`c${index}_text`] = chunk.text;
    bindings[`c${index}_sha`] = sha256(chunk.text);
    bindings[`c${index}_tokenEstimate`] = chunk.tokenEstimate;
    bindings[`c${index}_model`] = embeddingIdentity?.model;
    let embeddingFields: string;
    if (prepared.vector === undefined) {
      bindings[`c${index}_embedError`] = prepared.embedError;
      embeddingFields = `vector: NONE, embed_model: $c${index}_model, embedded_at: NONE, embed_error: $c${index}_embedError`;
    } else {
      bindings[`c${index}_vector`] = prepared.vector;
      embeddingFields = `vector: $c${index}_vector, embed_model: $c${index}_model, embedded_at: time::now(), embed_error: NONE`;
    }
    const lexical = `note: $note, source_revision: $sourceRevision, start_line: $c${index}_startLine, end_line: $c${index}_endLine, block: $c${index}_block, ord: $c${index}_ord, text: $c${index}_text, sha: $c${index}_sha, token_estimate: $c${index}_tokenEstimate`;
    const content = `{ ${lexical}, ${embeddingFields} }`;
    const existingId = reuse.ids[index];
    if (existingId !== undefined) {
      bindings[`c${index}_existingId`] = existingId;
      // Reuse is by exact text, never just ordinal. A structural refresh can
      // update locations without destroying a valid embedding of identical text.
      const reusableEmbedding =
        embeddingIdentity === null &&
        cachedHashes.get(existingId.toString()) === bindings[`c${index}_sha`];
      statements.push(
        reusableEmbedding
          ? `UPDATE $c${index}_existingId MERGE { ${lexical} };`
          : `UPDATE $c${index}_existingId CONTENT ${content};`,
      );
    } else {
      statements.push(`CREATE ONLY chunk CONTENT ${content};`);
    }
  }

  if (reuse.surplus.length > 0) {
    bindings.surplusChunkIds = reuse.surplus;
    statements.push("DELETE chunk WHERE id IN $surplusChunkIds;");
  }

  statements.push(
    embeddingIdentity === null
      ? "UPDATE $note SET tier1_at = time::now(), tier2_at = IF tier2_at != NONE AND array::len((SELECT id FROM chunk WHERE note = $note AND (vector IS NONE OR embed_model IS NONE) LIMIT 1)) = 0 { time::now() } ELSE { NONE };"
      : "UPDATE $note SET tier2_at = time::now();",
  );
  statements.push("COMMIT TRANSACTION;");

  return { sql: statements.join("\n"), bindings };
}

interface ChunkReusePlan {
  ids: Array<RecordId<"chunk"> | undefined>;
  surplus: Array<RecordId<"chunk">>;
}

interface ReuseBucket {
  rows: StoredChunk[];
  next: number;
}

function planChunkReuse(chunks: ChunkSpec[], existing: StoredChunk[]): ChunkReusePlan {
  const buckets = new Map<string, Map<string, ReuseBucket>>();
  for (const row of existing) {
    const computedDigest = sha256(row.text);
    const digest = row.sha === computedDigest ? row.sha : computedDigest;
    let byText = buckets.get(digest);
    if (byText === undefined) {
      byText = new Map();
      buckets.set(digest, byText);
    }
    let bucket = byText.get(row.text);
    if (bucket === undefined) {
      bucket = { rows: [], next: 0 };
      byText.set(row.text, bucket);
    }
    bucket.rows.push(row);
  }

  const used = new Set<string>();
  const ids = chunks.map((chunk) => {
    const bucket = buckets.get(sha256(chunk.text))?.get(chunk.text);
    const row = bucket?.rows[bucket.next];
    if (bucket === undefined || row === undefined) return undefined;
    bucket.next += 1;
    used.add(row.id.toString());
    return row.id;
  });
  const surplus = existing.filter((row) => !used.has(row.id.toString())).map((row) => row.id);
  return { ids, surplus };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const MIN_SPLIT_CHARS = 200;

function splitText(text: string): [string, string] {
  const midpoint = Math.floor(text.length / 2);
  let split = midpoint;
  for (let distance = 0; distance < midpoint; distance += 1) {
    const right = midpoint + distance;
    if (right < text.length && /\s/u.test(text[right])) {
      split = right;
      break;
    }
    const left = midpoint - distance;
    if (left > 0 && /\s/u.test(text[left])) {
      split = left;
      break;
    }
  }
  const before = text.charCodeAt(split - 1);
  const after = text.charCodeAt(split);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
    split += 1;
  }
  const left = text.slice(0, split).trimEnd();
  const right = text.slice(split).trimStart();
  if (left.length > 0 && right.length > 0) return [left, right];
  return [text.slice(0, midpoint), text.slice(midpoint)];
}

function withText(chunk: ChunkSpec, text: string): ChunkSpec {
  return { ...chunk, text, tokenEstimate: tokenEstimate(text) };
}

async function embedOneAdaptively(
  chunk: ChunkSpec,
  embedder: Embedder,
  signal?: AbortSignal,
): Promise<PreparedChunk[]> {
  try {
    const vectors = await embedder.embed([chunk.text], signal);
    if (vectors.length !== 1 || vectors[0] === undefined) {
      throw new Error(`runTier2: embedder returned ${vectors.length} vectors for one chunk`);
    }
    return [{ chunk, vector: vectors[0] }];
  } catch (error) {
    if (!(error instanceof EmbeddingContextOverflowError)) throw error;
    if (chunk.text.length <= MIN_SPLIT_CHARS) {
      return [{ chunk, embedError: `context_overflow:${chunk.text.length}` }];
    }
    const [left, right] = splitText(chunk.text);
    const leftChunks = await embedOneAdaptively(withText(chunk, left), embedder, signal);
    const rightChunks = await embedOneAdaptively(withText(chunk, right), embedder, signal);
    return [...leftChunks, ...rightChunks];
  }
}

async function prepareChunks(
  chunks: ChunkSpec[],
  embedder: Embedder,
  signal?: AbortSignal,
): Promise<PreparedChunk[]> {
  try {
    const vectors = await embedder.embedAll(
      chunks.map((chunk) => chunk.text),
      signal,
    );
    if (vectors.length !== chunks.length) {
      throw new Error(
        `runTier2: embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
      );
    }
    return chunks.map((chunk, index) => ({ chunk, vector: vectors[index] }));
  } catch (error) {
    if (!(error instanceof EmbeddingContextOverflowError)) throw error;
  }

  const prepared: PreparedChunk[] = [];
  for (const chunk of chunks) {
    prepared.push(...(await embedOneAdaptively(chunk, embedder, signal)));
  }
  return prepared.map((entry, ord) => ({
    ...entry,
    chunk: { ...entry.chunk, ord },
  }));
}

/** Persist lexical chunks through the same transaction/reuse authority before
 * inference. A missing vector never counts as completed embedding work. */
export async function persistLexicalChunks(
  db: Surreal,
  input: {
    noteId: RecordId<"note">;
    sourceRevision?: string;
    blocks: BlockSpec[];
    chunkSizes: ChunkBlockSizes;
  },
): Promise<void> {
  assertChunkSizes(input.chunkSizes);
  const chunks = chunkBlocks(input.blocks, input.chunkSizes);
  const existing = await listChunksForNote(db, input.noteId);
  const blockIds = await listBlockIdsByOrd(db, input.noteId);
  const { sql, bindings } = buildTier2Transaction(
    input.noteId,
    chunks.map((chunk) => ({ chunk })),
    existing,
    blockIds,
    null,
    input.sourceRevision,
  );
  await db.query(sql, bindings).collect();
}

export async function runTier2(db: Surreal, input: Tier2Input): Promise<Tier2Output> {
  assertEventBus(input.bus, "runTier2");
  assertChunkSizes(input.chunkSizes);
  const embeddingIdentity = await input.embedder.ensureIdentity(input.signal);
  const noteId = await lookupNoteByPath(db, input.notePath);
  if (noteId === null) {
    throw new Error(`runTier2: note not found by path '${input.notePath}'; Tier 1 must run first`);
  }

  const chunks = chunkBlocks(input.blocks, input.chunkSizes);

  if (chunks.length === 0) {
    input.signal?.throwIfAborted();
    await input.authorize?.();
    await db
      .query(
        "BEGIN TRANSACTION;\nDELETE chunk WHERE note = $note;\nUPDATE $note SET tier2_at = time::now();\nCOMMIT TRANSACTION;",
        { note: noteId },
      )
      .collect();
    return { noteId, chunkCount: 0, quarantinedCount: 0, embeddingIdentity };
  }

  const prepared = await prepareChunks(chunks, input.embedder, input.signal);

  const [existingChunks, blockIdsByOrd] = await Promise.all([
    listChunksForNote(db, noteId),
    listBlockIdsByOrd(db, noteId),
  ]);
  const { sql, bindings } = buildTier2Transaction(
    noteId,
    prepared,
    existingChunks,
    blockIdsByOrd,
    embeddingIdentity,
    input.sourceRevision,
  );
  input.signal?.throwIfAborted();
  await input.authorize?.();
  await db.query(sql, bindings).collect();

  const quarantined = prepared.filter((entry) => entry.vector === undefined);
  for (const entry of quarantined) {
    input.bus.emit({
      type: "indexer:warn",
      phase: "tier2",
      message: `embedding chunk quarantined: note='${input.notePath}' ord=${entry.chunk.ord} chars=${entry.chunk.text.length} reason='${entry.embedError}'`,
    });
  }
  return {
    noteId,
    chunkCount: prepared.length,
    quarantinedCount: quarantined.length,
    embeddingIdentity,
  };
}

function assertChunkSizes(sizes: ChunkBlockSizes): void {
  if (typeof sizes !== "object" || sizes === null) {
    throw new Error("runTier2: chunkSizes must be configured");
  }
  if (
    !Number.isInteger(sizes.targetTokens) ||
    sizes.targetTokens < 1 ||
    sizes.targetTokens > 1_000_000
  ) {
    throw new Error("runTier2: chunkSizes.targetTokens must be an integer between 1 and 1000000");
  }
  if (
    !Number.isInteger(sizes.maxTokens) ||
    sizes.maxTokens < sizes.targetTokens ||
    sizes.maxTokens > 1_000_000
  ) {
    throw new Error(
      "runTier2: chunkSizes.maxTokens must be an integer between targetTokens and 1000000",
    );
  }
}
