import type { RecordId, Surreal } from "surrealdb";
import { lookupNoteByPath } from "../db/surreal";
import type { BlockSpec } from "../markdown/types";
import { type ChunkBlockSizes, type ChunkSpec, chunkBlocks } from "./chunker";
import type { Embedder } from "./embedder";

/**
 * Tier 2 indexer: chunks the note body, embeds each chunk, and writes
 * the chunk rows alongside `note.tier2_at` inside a single SurrealQL
 * transaction.
 *
 * Spec: Phase 3 plan §Task 7.
 *
 * Atomicity is delivered via a single SurrealQL script bracketed by
 * `BEGIN TRANSACTION;` / `COMMIT TRANSACTION;`. SurrealDB rolls the
 * entire script back when any statement fails, so a partial chunk
 * insert never leaves stale rows behind and `tier2_at` only advances on
 * full success. Pre-resolution work (note lookup, chunking, embedding)
 * runs BEFORE the transaction; the transaction body only writes.
 *
 * The embed model literal lives here per Phase 3 locked decision 11
 * (text-embedding-nomic-embed-text-v2-moe, 768-dim vectors).
 */

export const EMBED_MODEL = "text-embedding-nomic-embed-text-v2-moe";

export interface Tier2Input {
  notePath: string;
  blocks: BlockSpec[];
  embedder: Embedder;
  /**
   * Optional chunk size overrides. Defaults to the in-process `CHUNK`
   * constants when omitted; bootstrap forwards values loaded from
   * `<vault>/.notient/config.toml` via `loadVaultConfig`.
   */
  chunkSizes?: ChunkBlockSizes;
}

export interface Tier2Output {
  noteId: RecordId<"note">;
  chunkCount: number;
}

interface TransactionScript {
  sql: string;
  bindings: Record<string, unknown>;
}

async function listChunkIdsForNote(
  db: Surreal,
  noteId: RecordId<"note">,
): Promise<Array<RecordId<"chunk">>> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"chunk">; ord: number }>]>(
      "SELECT id, ord FROM chunk WHERE note = $note ORDER BY ord;",
      { note: noteId },
    )
    .collect<[Array<{ id: RecordId<"chunk">; ord: number }>]>();
  return rows.map((row) => row.id);
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
  chunks: ChunkSpec[],
  vectors: number[][],
  existingChunkIds: Array<RecordId<"chunk">>,
  blockIdsByOrd: ReadonlyMap<number, RecordId<"block">>,
): TransactionScript {
  const statements: string[] = [];
  const bindings: Record<string, unknown> = { note: noteId };

  statements.push("BEGIN TRANSACTION;");

  const reuseCount = Math.min(chunks.length, existingChunkIds.length);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    bindings[`c${index}_ord`] = chunk.ord;
    bindings[`c${index}_block`] =
      chunk.blockOrd === null ? undefined : (blockIdsByOrd.get(chunk.blockOrd) ?? undefined);
    bindings[`c${index}_text`] = chunk.text;
    bindings[`c${index}_tokenEstimate`] = chunk.tokenEstimate;
    bindings[`c${index}_vector`] = vectors[index];
    bindings[`c${index}_model`] = EMBED_MODEL;
    const content = `{ note: $note, block: $c${index}_block, ord: $c${index}_ord, text: $c${index}_text, token_estimate: $c${index}_tokenEstimate, vector: $c${index}_vector, embed_model: $c${index}_model, embedded_at: time::now() }`;
    if (index < reuseCount) {
      bindings[`c${index}_existingId`] = existingChunkIds[index];
      statements.push(`UPDATE $c${index}_existingId CONTENT ${content};`);
    } else {
      statements.push(`CREATE ONLY chunk CONTENT ${content};`);
    }
  }

  if (existingChunkIds.length > chunks.length) {
    bindings.surplusChunkIds = existingChunkIds.slice(chunks.length);
    statements.push("DELETE chunk WHERE id IN $surplusChunkIds;");
  }

  statements.push("UPDATE $note SET tier2_at = time::now();");
  statements.push("COMMIT TRANSACTION;");

  return { sql: statements.join("\n"), bindings };
}

export async function runTier2(db: Surreal, input: Tier2Input): Promise<Tier2Output> {
  const noteId = await lookupNoteByPath(db, input.notePath);
  if (noteId === null) {
    throw new Error(`runTier2: note not found by path '${input.notePath}'; Tier 1 must run first`);
  }

  const chunks = chunkBlocks(input.blocks, input.chunkSizes);

  if (chunks.length === 0) {
    await db
      .query(
        "BEGIN TRANSACTION;\nDELETE chunk WHERE note = $note;\nUPDATE $note SET tier2_at = time::now();\nCOMMIT TRANSACTION;",
        { note: noteId },
      )
      .collect();
    return { noteId, chunkCount: 0 };
  }

  const vectors = await input.embedder.embedAll(chunks.map((chunk) => chunk.text));
  if (vectors.length !== chunks.length) {
    throw new Error(
      `runTier2: embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
    );
  }

  const [existingChunkIds, blockIdsByOrd] = await Promise.all([
    listChunkIdsForNote(db, noteId),
    listBlockIdsByOrd(db, noteId),
  ]);
  const { sql, bindings } = buildTier2Transaction(
    noteId,
    chunks,
    vectors,
    existingChunkIds,
    blockIdsByOrd,
  );
  await db.query(sql, bindings).collect();

  return { noteId, chunkCount: chunks.length };
}
