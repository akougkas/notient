import { type RecordId, StringRecordId, type Surreal } from "surrealdb";
import { NoteReadService } from "../../api/notes";
import type { PipelinePlan } from "../../api/pipelines";
import { NoteApiError } from "../../api/schema";
import { markTier3Done } from "../db/surreal";
import type { EventBus } from "../events/eventBus";
import type { Embedder } from "../indexer/embedder";
import { type Extractor, writeExtractionToSurreal } from "../indexer/extractor";
import { runTier1 } from "../indexer/tier1";
import { persistLexicalChunks, runTier2 } from "../indexer/tier2";
import { evidenceForChunk } from "../search/retrieval";
import type { PipelineContext } from "./context";

export interface IndexExtractDependencies {
  db: Surreal;
  bus: EventBus;
  embedder: Embedder;
  extractor: Extractor;
  chunkSizes: { targetTokens: number; maxTokens: number };
  embeddingConfigured: () => boolean;
}
interface ChunkRow {
  id: RecordId<"chunk">;
  ord: number;
  text: string;
  source_revision: string;
  start_line?: number;
  end_line?: number;
}
export async function indexExtract(
  context: PipelineContext,
  plan: PipelinePlan,
  deps: IndexExtractDependencies,
): Promise<void> {
  const universe = (await context.options.vault.listMarkdown()).map((entry) => entry.path);
  for (const [index, note] of context.selected.entries()) {
    const authorize = async () => {
      context.options.signal.throwIfAborted();
      await new NoteReadService(context.options.vault).read(note.note);
    };
    await context.options.stage("structure", index, context.selected.length);
    await authorize();
    const structural = await runTier1(deps.db, {
      notePath: note.note.path,
      source: note.body,
      vaultPaths: universe,
      bus: deps.bus,
      deferCompletion: true,
    });
    await persistLexicalChunks(deps.db, {
      noteId: structural.noteId,
      sourceRevision: note.note.revision,
      blocks: structural.extraction.blocks,
      chunkSizes: deps.chunkSizes,
    });
    deps.bus.emit({
      type: "indexer:tier1-done",
      path: note.note.path,
      bodySha: note.note.revision,
    });
    if (context.options.policy.parameters.indexExtract.embeddings && deps.embeddingConfigured()) {
      await context.options.stage("embeddings", index, context.selected.length);
      const result = await runTier2(deps.db, {
        notePath: note.note.path,
        sourceRevision: note.note.revision,
        blocks: structural.extraction.blocks,
        chunkSizes: deps.chunkSizes,
        embedder: deps.embedder,
        bus: deps.bus,
        signal: context.options.signal,
        authorize,
      });
      if (result.quarantinedCount)
        throw new NoteApiError(
          "PARTIAL",
          "some chunks exceed the embedding context; lexical evidence is preserved",
        );
    }
    if (!context.options.policy.parameters.indexExtract.extraction) continue;
    await context.options.stage("extract", index, context.selected.length);
    const [chunks] = await deps.db
      .query<[ChunkRow[]]>(
        "SELECT id, ord, text, source_revision, start_line, end_line FROM chunk WHERE note = $note ORDER BY ord;",
        { note: structural.noteId },
      )
      .collect();
    if (chunks.some((chunk) => chunk.source_revision !== note.note.revision))
      throw new NoteApiError("CONFLICT", "chunks changed before extraction");
    const extraction = await deps.extractor.extract(
      chunks.map((chunk) => ({
        id: chunk.id.toString(),
        ord: chunk.ord,
        text: chunk.text,
        tokenEstimate: Math.ceil(chunk.text.length / 4),
      })),
      context.options.signal,
    );
    const witnesses = new Map(
      chunks.map((chunk) => [
        chunk.id.toString(),
        evidenceForChunk(note, {
          text: chunk.text,
          startLine: chunk.start_line,
          endLine: chunk.end_line,
        }),
      ]),
    );
    for (const [kind, values, mappings] of [
      ["concept", extraction.entities, extraction.entityEvidence],
      ["claim", extraction.claims, extraction.claimEvidence],
      ["question", extraction.questions, extraction.questionEvidence],
    ] as const) {
      for (const value of values) {
        const evidence = (mappings?.[value] ?? [])
          .map((id) => witnesses.get(id))
          .filter((entry) => entry !== null && entry !== undefined);
        if (!evidence.length) throw new Error("extraction lacks resolvable exact source evidence");
        plan.findings.push({
          kind,
          title: value.slice(0, 300),
          explanation: value,
          evidence: evidence.slice(0, 30),
        });
      }
    }
    plan.extractions.push({
      source: note.note,
      noteId: structural.noteId.toString(),
      chunkIds: chunks.map((chunk) => chunk.id.toString()),
      extraction,
    });
  }
  if (!plan.findings.length)
    plan.reason =
      "Structural indexing completed; supplied content yielded no supported concepts, claims or questions.";
}

/** Called only after the job has durably checkpointed its complete output. */
export async function persistExtractions(
  plan: PipelinePlan,
  context: PipelineContext,
  deps: IndexExtractDependencies,
  authorize: () => Promise<void>,
): Promise<void> {
  for (const item of plan.extractions) {
    await authorize();
    await new NoteReadService(context.options.vault).read(item.source);
    const noteId = new StringRecordId(item.noteId) as unknown as RecordId<"note">;
    const [chunks] = await deps.db
      .query<[ChunkRow[]]>(
        "SELECT id, ord, text, source_revision FROM chunk WHERE note = $note ORDER BY ord;",
        { note: noteId },
      )
      .collect();
    if (
      chunks.length !== item.chunkIds.length ||
      chunks.some(
        (chunk, index) =>
          chunk.id.toString() !== item.chunkIds[index] ||
          chunk.source_revision !== item.source.revision,
      )
    )
      throw new NoteApiError("CONFLICT", "extraction source chunks are stale");
    await writeExtractionToSurreal(deps.db, noteId, item.extraction, {
      chunkIndex: new Map(chunks.map((chunk) => [chunk.id.toString(), chunk.id])),
      coverage: { kind: "full" },
    });
    await markTier3Done(deps.db, noteId);
  }
}
