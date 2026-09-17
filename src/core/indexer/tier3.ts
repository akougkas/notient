import type { RecordId, Surreal } from "surrealdb";
import type { AgentRunCapability } from "../coordinator/types";
import { lookupNoteByPath, markTier3Done } from "../db/surreal";
import {
  type ExtractionChunk,
  type ExtractionCoverage,
  type Extractor,
  PartialExtractionError,
  writeExtractionToSurreal,
} from "./extractor";
import type { Extraction } from "./types";

/**
 * Tier 3 indexer: runs the LLM-driven extractor and linker concurrently
 * over a note's chunks, persists their findings to SurrealDB, and stamps
 * `note.tier3_at`.
 *
 * Extractor edges are auto-approved. Linker edges land with
 * `approved = false` so the human review queue surfaces them.
 *
 * A partial extraction or failed linker run persists whatever succeeded and
 * then throws. `tier3_at` is stamped only on a clean run, so a failed note is
 * retried on the next enqueue or awaken pass.
 *
 * Linker execution goes through the bound run capability so every proposal
 * carries a durable run id and observes the process-wide reasoning limit.
 */

export interface Tier3Chunk {
  /** The canonical chunk record that owns this text and its evidence links. */
  id: RecordId<"chunk">;
  ord: number;
  text: string;
  vector: number[];
}

export interface Tier3Input {
  notePath: string;
  chunks: Tier3Chunk[];
  extractor: Extractor;
  runLinker: AgentRunCapability<"linker">;
  signal?: AbortSignal;
}

export interface Tier3Output {
  noteId: RecordId<"note">;
  /** Structured-output calls the extractor issued for this note. */
  llmCalls: number;
  /** Windows the note's chunks were packed into. */
  extractionWindows: number;
}

const TIER3_TRIGGER = "vault-save" as const;

function adaptChunksForExtractor(chunks: Tier3Chunk[]): ExtractionChunk[] {
  return chunks.map((chunk) => ({
    id: chunk.id.toString(),
    ord: chunk.ord,
    text: chunk.text,
    tokenEstimate: Math.ceil(chunk.text.length / 4),
  }));
}

/** Map the extractor's chunk-id strings back to `chunk` records. */
function buildChunkIndex(chunks: Tier3Chunk[]): Map<string, RecordId<"chunk">> {
  const index = new Map<string, RecordId<"chunk">>();
  for (const chunk of chunks) {
    index.set(chunk.id.toString(), chunk.id);
  }
  return index;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export async function runTier3(db: Surreal, input: Tier3Input): Promise<Tier3Output> {
  const noteId = await lookupNoteByPath(db, input.notePath);
  if (noteId === null) {
    throw new Error(`runTier3: note not found by path '${input.notePath}'; Tier 1 must run first`);
  }

  const extractorChunks = adaptChunksForExtractor(input.chunks);

  const [extractionSettled, linkerSettled] = await Promise.allSettled([
    input.extractor.extract(extractorChunks, input.signal),
    input.runLinker.execute({
      trigger: TIER3_TRIGGER,
      notePath: input.notePath,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  ]);

  const failures: string[] = [];
  let extraction: Extraction | null = null;
  let extractionCoverage: ExtractionCoverage = { kind: "full" };

  if (extractionSettled.status === "fulfilled") {
    extraction = extractionSettled.value;
    assertExtractionStats(extraction.stats);
  } else if (isAbortError(extractionSettled.reason)) {
    throw extractionSettled.reason;
  } else if (extractionSettled.reason instanceof PartialExtractionError) {
    // Reconcile exactly the chunks whose windows succeeded (including an
    // empty successful window); failed-window evidence remains untouched.
    extraction = extractionSettled.reason.extraction;
    extractionCoverage = {
      kind: "partial",
      chunkIds: extractionSettled.reason.successfulChunkIds,
    };
    failures.push(extractionSettled.reason.message);
  } else {
    failures.push(`extractor failed: ${describe(extractionSettled.reason)}`);
  }

  if (linkerSettled.status === "rejected") {
    if (isAbortError(linkerSettled.reason)) throw linkerSettled.reason;
    failures.push(`linker failed: ${describe(linkerSettled.reason)}`);
  }

  if (extraction !== null) {
    await writeExtractionToSurreal(db, noteId, extraction, {
      chunkIndex: buildChunkIndex(input.chunks),
      coverage: extractionCoverage,
    });
  }

  if (failures.length > 0) {
    throw new Error(`runTier3('${input.notePath}'): ${failures.join("; ")}`);
  }

  if (extraction === null || extraction.stats === undefined) {
    throw new Error(`runTier3('${input.notePath}'): extractor returned no canonical result`);
  }

  await markTier3Done(db, noteId);

  return {
    noteId,
    llmCalls: extraction.stats.llmCalls,
    extractionWindows: extraction.stats.windows,
  };
}

function assertExtractionStats(
  stats: Extraction["stats"],
): asserts stats is NonNullable<Extraction["stats"]> {
  if (
    stats === undefined ||
    !Number.isSafeInteger(stats.llmCalls) ||
    stats.llmCalls < 0 ||
    !Number.isSafeInteger(stats.windows) ||
    stats.windows < 0 ||
    stats.llmCalls !== stats.windows
  ) {
    throw new Error("runTier3: extractor returned invalid execution statistics");
  }
}
