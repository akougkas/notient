import type { Linker } from "../agents/linker";
import type { Database } from "../db/database";
import { type SurrealConnection, fetchChunksForTier3 } from "../db/surreal";
import type { EventBus } from "../events/eventBus";
import type { GraphStore } from "../graph/graphStore";
import type { ChunkBlockSizes } from "./chunker";
import type { Embedder } from "./embedder";
import type { Extractor } from "./extractor";
import { runTier1 } from "./tier1";
import { runTier2 } from "./tier2";
import { runTier3 } from "./tier3";
import type { IndexResult } from "./types";
import type { VectorIndex } from "./vectorIndex";

/**
 * Phase 3 indexer entry point: runs Tier 1 → Tier 2 → Tier 3 sequentially
 * against SurrealDB. Each tier is wrapped in its own try/catch; a failure in
 * one tier short-circuits the remaining tiers for that note and emits an
 * `indexer:error` event with the appropriate `phase` field.
 *
 * Spec: Phase 3 plan §Task 9. Search-side READS against the SQLite
 * `embeddings` table are untouched (locked decision 7); the legacy
 * SQLite-bound chunk/embedding/graph WRITE path that previously lived here
 * has been removed.
 *
 * The `IndexResult` shape is preserved for callers that still inspect its
 * fields. `chunkCount`/`embedCount` reflect Tier 2's chunk count (1:1 in
 * Phase 3 because each chunk gets exactly one embedding). `nodeCount` and
 * `edgeCount` are no longer populated and are reported as zero.
 */

export interface IndexNoteArgs {
  notePath: string;
  noteBody: string;
  /** Legacy SQLite handle. Kept so search-side reads continue to function. */
  database: Database;
  /** Legacy graph store. Phase 3 does not write to it from this entry point. */
  graph: GraphStore;
  /** Legacy in-process vector index. Phase 3 does not write to it from here. */
  vectorIndex: VectorIndex;
  embedder: Embedder;
  extractor: Extractor;
  bus: EventBus;
  /** Optional cancellation signal threaded into Tier 3's linker. */
  signal?: AbortSignal;
  /**
   * Optional SurrealDB connection. When present, Tiers 1–3 run; when
   * undefined (legacy/test paths) the function emits no tier events and
   * returns a minimal IndexResult.
   */
  surrealDb?: SurrealConnection;
  /**
   * Linker required by Tier 3. Must be provided whenever `surrealDb` is
   * provided; absent in test paths that exercise only Tiers 1 and 2.
   */
  linker?: Linker;
  /**
   * Optional chunk size overrides forwarded to Tier 2. Defaults to the
   * in-process `CHUNK` constants when omitted; bootstrap forwards values
   * loaded from `<vault>/.notient/config.toml`.
   */
  chunkSizes?: ChunkBlockSizes;
}

export async function indexNote(args: IndexNoteArgs): Promise<IndexResult> {
  const start = Date.now();
  const {
    notePath,
    noteBody,
    database,
    embedder,
    extractor,
    bus,
    signal,
    surrealDb,
    linker,
    chunkSizes,
  } = args;
  const sha = await sha256(noteBody);

  if (surrealDb === undefined) {
    return {
      notePath,
      noteSha: sha,
      chunkCount: 0,
      embedCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      durationMs: Date.now() - start,
    };
  }

  let tier1Output: Awaited<ReturnType<typeof runTier1>> | null = null;
  try {
    const vaultPaths = database
      .query<{ path: string }>("SELECT path FROM notes;", [])
      .map((row) => row.path);
    if (!vaultPaths.includes(notePath)) {
      vaultPaths.push(notePath);
    }
    tier1Output = await runTier1(surrealDb.db, {
      notePath,
      source: noteBody,
      vaultPaths,
      bus,
    });
    bus.emit({
      type: "indexer:tier1-done",
      path: notePath,
      bodySha: tier1Output.extraction.bodySha,
    });
  } catch (error) {
    bus.emit({
      type: "indexer:error",
      message: error instanceof Error ? error.message : String(error),
      phase: "tier1",
    });
    return buildResult(notePath, sha, 0, start);
  }

  let chunkCount = 0;
  try {
    const tier2Output = await runTier2(surrealDb.db, {
      notePath,
      blocks: tier1Output.extraction.blocks,
      embedder,
      ...(chunkSizes !== undefined ? { chunkSizes } : {}),
    });
    chunkCount = tier2Output.chunkCount;
    bus.emit({ type: "indexer:tier2-done", path: notePath, chunkCount });
  } catch (error) {
    bus.emit({
      type: "indexer:error",
      message: error instanceof Error ? error.message : String(error),
      phase: "tier2",
    });
    return buildResult(notePath, sha, 0, start);
  }

  if (linker !== undefined) {
    try {
      const chunks = await fetchChunksForTier3(surrealDb.db, tier1Output.noteId);
      await runTier3(surrealDb.db, {
        notePath,
        chunks,
        extractor,
        linker,
        signal,
      });
      bus.emit({ type: "indexer:tier3-done", path: notePath });
    } catch (error) {
      bus.emit({
        type: "indexer:error",
        message: error instanceof Error ? error.message : String(error),
        phase: "tier3",
      });
      const partial = buildResult(notePath, sha, chunkCount, start);
      emitNoteIndexed(bus, notePath, partial);
      return partial;
    }
  }

  const result = buildResult(notePath, sha, chunkCount, start);
  emitNoteIndexed(bus, notePath, result);
  return result;
}

function emitNoteIndexed(bus: EventBus, notePath: string, result: IndexResult): void {
  bus.emit({
    type: "indexer:note-indexed",
    path: notePath,
    result: {
      chunkCount: result.chunkCount,
      embedCount: result.embedCount,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
      durationMs: result.durationMs,
    },
  });
}

function buildResult(
  notePath: string,
  noteSha: string,
  chunkCount: number,
  startMs: number,
): IndexResult {
  return {
    notePath,
    noteSha,
    chunkCount,
    embedCount: chunkCount,
    nodeCount: 0,
    edgeCount: 0,
    durationMs: Date.now() - startMs,
  };
}

async function sha256(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
