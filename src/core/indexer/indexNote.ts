import type { RecordId } from "surrealdb";
import type { Linker } from "../agents/linker";
import {
  type SurrealConnection,
  fetchChunksForTier3,
  fetchNoteTierState,
  listNotePaths,
  lookupNoteByPath,
} from "../db/surreal";
import type { EventBus } from "../events/eventBus";
import { extract } from "../markdown/extractor";
import { processAst } from "../markdown/pipeline";
import type { BlockSpec } from "../markdown/types";
import type { ChunkBlockSizes } from "./chunker";
import type { Embedder } from "./embedder";
import type { Extractor } from "./extractor";
import { runTier1 } from "./tier1";
import { runTier2 } from "./tier2";
import { runTier3 } from "./tier3";
import type { IndexResult } from "./types";

/**
 * Phase 3 indexer entry point: runs Tier 1 → Tier 2 → Tier 3 sequentially
 * against SurrealDB. Each tier is wrapped in its own try/catch; a failure in
 * one tier short-circuits the remaining tiers for that note and emits an
 * `indexer:error` event with the appropriate `phase` field.
 *
 * Spec: Phase 3 plan §Task 9. Phase 5 Task 13 deleted the SQLite substrate;
 * the previous `database`/`graph` parameters and `vectorIndex` slot are gone.
 * Tier 1's vault-path universe now reads from SurrealDB via `listNotePaths`.
 *
 * The `IndexResult` shape is preserved for callers that still inspect its
 * fields. `chunkCount`/`embedCount` reflect Tier 2's chunk count (1:1 in
 * Phase 3 because each chunk gets exactly one embedding). `nodeCount` and
 * `edgeCount` are no longer populated and are reported as zero.
 */

export interface IndexNoteArgs {
  notePath: string;
  noteBody: string;
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
  /**
   * Optional per-note tier filter, interpreted as an UPPER BOUND on the
   * tier ladder rather than a literal subset. The indexer derives
   * `maxRequested = max(filter)` and considers tiers `[1..maxRequested]`;
   * any tier in that range whose `tier{N}_at` is already set is skipped,
   * so prerequisite tiers run transparently when needed and tiers above
   * `maxRequested` never run. Tiers below `maxRequested` that the caller
   * did not list are not re-run if they are already done — `reindex` is
   * the opt-in path for replaying a tier (it clears `tier{N}_at` before
   * enqueueing, so the corresponding column reads NONE here and the tier
   * runs again while its already-done lower tiers stay skipped).
   *
   * Spec: Phase 5 Task 11 (the tier filter flows from `awaken --tier`
   * per-run scope and `reindex --tier` per-glob scope through the
   * indexer queue into this orchestrator) plus Bug 4 (`awaken --tier N`
   * on a fresh note must auto-run Tiers 1..N-1 instead of failing in
   * Tier 2's `Tier 1 must run first` guard). When omitted, every tier
   * whose `tier{N}_at` is NONE runs (preserving the pre-Phase-5
   * behaviour on fresh notes and idempotency on already-indexed ones).
   */
  tierFilter?: ReadonlyArray<number>;
}

const MAX_TIER = 3;

/**
 * Reduce the caller's tier filter to a single upper-bound integer in
 * `[1, MAX_TIER]`. An undefined or empty filter widens to the full ladder
 * (`MAX_TIER`); invalid entries (anything outside `1..MAX_TIER`) are
 * dropped before computing the max so a stray `0` or `5` does not collapse
 * the bound. Spec: Bug 4 reinterprets `tierFilter` as an upper bound rather
 * than a literal subset.
 */
function maxRequestedTier(filter: ReadonlyArray<number> | undefined): number {
  if (filter === undefined) return MAX_TIER;
  const valid = filter.filter((tier) => tier === 1 || tier === 2 || tier === 3);
  if (valid.length === 0) return MAX_TIER;
  return Math.max(...valid);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tier-by-tier orchestration is clearer in one function than split across helpers; mirrors the per-tier try/catch pattern that has lived here since Phase 3.
export async function indexNote(args: IndexNoteArgs): Promise<IndexResult> {
  const start = Date.now();
  const {
    notePath,
    noteBody,
    embedder,
    extractor,
    bus,
    signal,
    surrealDb,
    linker,
    chunkSizes,
    tierFilter,
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

  // Bug 4 fix: `tierFilter` is an upper bound, not a literal subset. We
  // run every tier in `[1..maxRequested]` whose `tier{N}_at` is still
  // NONE so a fresh note enqueued with `awaken --tier 2` transparently
  // runs Tier 1 first, while a `reindex --tier 2` call (which clears
  // only `tier2_at` upstream) re-runs Tier 2 alone because Tier 1 is
  // already stamped and skipped here. Tiers above `maxRequested` never
  // run regardless of their state.
  const upperBound = maxRequestedTier(tierFilter);
  const tierState = await fetchNoteTierState(surrealDb.db, notePath);
  const runTier1Wanted = upperBound >= 1 && !tierState.tier1Done;
  const runTier2Wanted = upperBound >= 2 && !tierState.tier2Done;
  const runTier3Wanted = upperBound >= 3 && !tierState.tier3Done;

  // Phase 5 Task 11: when Tier 1 is filtered out the orchestrator must
  // still hand Tier 2 a `BlockSpec[]` and Tier 3 a `noteId`. Both are
  // available as side effects of a Tier 1 run; when Tier 1 is skipped
  // we re-derive them from the saved source (extract is a pure function)
  // and from the existing `note` row respectively.
  let tier1Blocks: BlockSpec[] | null = null;
  let tier1NoteId: RecordId<"note"> | null = null;

  if (runTier1Wanted) {
    try {
      const vaultPaths = await listNotePaths(surrealDb.db);
      if (!vaultPaths.includes(notePath)) {
        vaultPaths.push(notePath);
      }
      const tier1Output = await runTier1(surrealDb.db, {
        notePath,
        source: noteBody,
        vaultPaths,
        bus,
      });
      tier1Blocks = tier1Output.extraction.blocks;
      tier1NoteId = tier1Output.noteId;
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
  }

  let chunkCount = 0;
  if (runTier2Wanted) {
    try {
      const blocks = tier1Blocks ?? extract(processAst(noteBody), notePath, noteBody).blocks;
      const tier2Output = await runTier2(surrealDb.db, {
        notePath,
        blocks,
        embedder,
        ...(chunkSizes !== undefined ? { chunkSizes } : {}),
      });
      chunkCount = tier2Output.chunkCount;
      tier1NoteId = tier1NoteId ?? tier2Output.noteId;
      bus.emit({ type: "indexer:tier2-done", path: notePath, chunkCount });
    } catch (error) {
      bus.emit({
        type: "indexer:error",
        message: error instanceof Error ? error.message : String(error),
        phase: "tier2",
      });
      return buildResult(notePath, sha, 0, start);
    }
  }

  if (runTier3Wanted && linker !== undefined) {
    try {
      const noteId = tier1NoteId ?? (await lookupNoteByPath(surrealDb.db, notePath));
      if (noteId === null) {
        throw new Error(
          `indexNote: cannot run Tier 3 for '${notePath}'; no note row exists (Tier 1 must run first)`,
        );
      }
      const chunks = await fetchChunksForTier3(surrealDb.db, noteId);
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
