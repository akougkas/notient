import type { RecordId, Surreal } from "surrealdb";
import { lookupNoteByPath } from "../db/surreal";
import type { BlockSpec } from "../markdown/types";
import { type ChunkSpec, chunkBlocks } from "./chunker";
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
}

export interface Tier2Output {
  noteId: RecordId<"note">;
  chunkCount: number;
}

interface TransactionScript {
  sql: string;
  bindings: Record<string, unknown>;
}

function buildTier2Transaction(
  noteId: RecordId<"note">,
  chunks: ChunkSpec[],
  vectors: number[][],
): TransactionScript {
  const statements: string[] = [];
  const bindings: Record<string, unknown> = { note: noteId };

  statements.push("BEGIN TRANSACTION;");
  statements.push("DELETE chunk WHERE note = $note;");

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    bindings[`c${index}_ord`] = chunk.ord;
    bindings[`c${index}_text`] = chunk.text;
    bindings[`c${index}_tokenEstimate`] = chunk.tokenEstimate;
    bindings[`c${index}_vector`] = vectors[index];
    bindings[`c${index}_model`] = EMBED_MODEL;
    statements.push(
      `CREATE ONLY chunk CONTENT { note: $note, ord: $c${index}_ord, text: $c${index}_text, token_estimate: $c${index}_tokenEstimate, vector: $c${index}_vector, embed_model: $c${index}_model, embedded_at: time::now() };`,
    );
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

  const chunks = chunkBlocks(input.blocks);

  if (chunks.length === 0) {
    await db.query("UPDATE $note SET tier2_at = time::now();", { note: noteId }).collect();
    return { noteId, chunkCount: 0 };
  }

  const vectors = await input.embedder.embedAll(chunks.map((chunk) => chunk.text));
  if (vectors.length !== chunks.length) {
    throw new Error(
      `runTier2: embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
    );
  }

  const { sql, bindings } = buildTier2Transaction(noteId, chunks, vectors);
  await db.query(sql, bindings).collect();

  return { noteId, chunkCount: chunks.length };
}
