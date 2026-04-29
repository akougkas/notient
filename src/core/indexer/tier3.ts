import type { RecordId, Surreal } from "surrealdb";
import type { Linker } from "../agents/linker";
import { lookupNoteByPath, markTier3Done } from "../db/surreal";
import { EventBus } from "../events/eventBus";
import { type Extractor, writeExtractionToSurreal } from "./extractor";
import type { Chunk } from "./types";

/**
 * Tier 3 indexer: runs the LLM-driven extractor and linker concurrently
 * over a note's chunks, persists their findings to SurrealDB, and stamps
 * `note.tier3_at`.
 *
 * Spec: Phase 3 plan §Task 8. Extractor edges are auto-approved; linker
 * edges land with `approved = false` so the human review queue surfaces
 * them. Concurrency is bounded to two LLM calls per note via the natural
 * `Promise.all([extractor, linker])` parallelism (locked decision 5).
 */

export interface Tier3Chunk {
  ord: number;
  text: string;
  vector: number[];
}

export interface Tier3Input {
  notePath: string;
  chunks: Tier3Chunk[];
  extractor: Extractor;
  linker: Linker;
  signal?: AbortSignal;
}

export interface Tier3Output {
  noteId: RecordId<"note">;
}

const TIER3_TRIGGER = "vault-save" as const;

function adaptChunksForExtractor(notePath: string, chunks: Tier3Chunk[]): Chunk[] {
  return chunks.map((chunk) => ({
    id: `tier3-${chunk.ord}`,
    notePath,
    ord: chunk.ord,
    text: chunk.text,
    sha: "",
    tokenEstimate: Math.ceil(chunk.text.length / 4),
  }));
}

export async function runTier3(db: Surreal, input: Tier3Input): Promise<Tier3Output> {
  const noteId = await lookupNoteByPath(db, input.notePath);
  if (noteId === null) {
    throw new Error(`runTier3: note not found by path '${input.notePath}'; Tier 1 must run first`);
  }

  const extractorChunks = adaptChunksForExtractor(input.notePath, input.chunks);

  // Per-run AbortSignal cannot be threaded into Extractor.extract because the
  // extractor reads its signal from constructor options (set once per
  // Extractor instance). Phase 3 accepts this limitation; the linker honours
  // input.signal directly via its run context.
  const linkerSignal = input.signal ?? new AbortController().signal;
  const linkerBus = new EventBus();

  const [extraction] = await Promise.all([
    input.extractor.extract(extractorChunks),
    input.linker.run({
      trigger: TIER3_TRIGGER,
      notePath: input.notePath,
      signal: linkerSignal,
      runId: 0,
      bus: linkerBus,
    }),
  ]);

  await writeExtractionToSurreal(db, noteId, extraction);
  await markTier3Done(db, noteId);

  return { noteId };
}
