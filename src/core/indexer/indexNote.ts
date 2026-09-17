import { createHash } from "node:crypto";
import type { RecordId } from "surrealdb";
import type { AgentRunCapability } from "../coordinator/types";
import {
  type SurrealConnection,
  clearTierAtByPath,
  fetchChunksForTier3,
  fetchNoteShaByPath,
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
import { persistLexicalChunks, runTier2 } from "./tier2";
import { runTier3 } from "./tier3";
import { maxRequestedTier } from "./tierFilter";
import type { IndexResult } from "./types";

/**
 * Indexer entry point: runs Tier 1 → Tier 2 → Tier 3 sequentially
 * against SurrealDB. Each tier is wrapped in its own try/catch; a failure in
 * one tier short-circuits the remaining tiers for that note and emits an
 * `indexer:error` event with the appropriate `phase` field.
 *
 * The pipeline requires SurrealDB and a bound Linker run capability.
 * `chunkCount` and `embedCount` reflect Tier 2's chunk count because every
 * chunk gets one embedding.
 */

export interface IndexNoteArgs {
  notePath: string;
  noteBody: string;
  embedder: Embedder;
  extractor: Extractor;
  bus: EventBus;
  /** Optional cancellation signal shared by Tier 3 extraction and linking. */
  signal?: AbortSignal;
  /** Required SurrealDB connection used by all three tiers. */
  surrealDb: SurrealConnection;
  /** Bound Linker execution capability used whenever Tier 3 is pending. */
  runLinker: AgentRunCapability<"linker">;
  /** Validated chunk sizes forwarded to Tier 2. */
  chunkSizes: ChunkBlockSizes;
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
   * When omitted, every unfinished tier runs.
   */
  tierFilter?: ReadonlyArray<number>;
  /**
   * Optional vault-wide path universe for Tier 1's wikilink resolver. When
   * omitted the orchestrator reads it through {@link getVaultPathUniverse},
   * which caches the list process-wide so a vault-wide awaken does not issue
   * one `SELECT path FROM note` per note.
   */
  vaultPaths?: string[];
}

export async function indexNote(args: IndexNoteArgs): Promise<IndexResult> {
  const start = performance.now();
  const { notePath, noteBody, bus, surrealDb, tierFilter } = args;
  const sha = await sha256(noteBody);

  // A filter is an upper bound: prerequisites run when unfinished, completed
  // lower tiers stay untouched, and higher tiers never run.
  const upperBound = maxRequestedTier(tierFilter);
  const fetchedTierState = await fetchNoteTierState(surrealDb.db, notePath);
  // Completion stamps describe specific source bytes. Clear them when the
  // body changes so each permitted tier processes the current content.
  const storedSha = await fetchNoteShaByPath(surrealDb.db, notePath);
  const shaDrifted = storedSha !== null && storedSha !== sha;
  if (shaDrifted) {
    await clearTierAtByPath(surrealDb.db, notePath, [1, 2, 3]);
  }
  const tierState = shaDrifted
    ? { tier1Done: false, tier2Done: false, tier3Done: false }
    : fetchedTierState;
  const runTier1Wanted = !tierState.tier1Done;
  const runTier2Wanted = upperBound >= 2 && !tierState.tier2Done;
  const runTier3Wanted = upperBound >= 3 && !tierState.tier3Done;

  // Later tiers reuse earlier outputs from this pass. When an earlier tier is
  // already complete, its required inputs are recovered from source or storage.
  let tier1Blocks: BlockSpec[] | null = null;
  let tier1NoteId: RecordId<"note"> | null = null;

  if (runTier1Wanted) {
    const output = await executeTier1(args);
    if (output === null) return buildResult(notePath, sha, 0, start);
    tier1Blocks = output.blocks;
    tier1NoteId = output.noteId;
  } else if (storedSha === sha) {
    // A successful retry may reuse an existing durable receipt; report it so
    // a transient read/database failure does not leave readiness stuck failed.
    bus.emit({ type: "indexer:tier1-reused", path: notePath, bodySha: sha });
  }

  let chunkCount = 0;
  // Tier 3 work counts ride out on the final event for per-note observability.
  let tier3LlmCalls = 0;
  let tier3Windows = 0;
  if (runTier2Wanted) {
    const output = await executeTier2(args, tier1Blocks);
    if (output === null) return buildResult(notePath, sha, 0, start);
    chunkCount = output.chunkCount;
    tier1NoteId ??= output.noteId;
  }

  if (runTier3Wanted) {
    const output = await executeTier3(args, tier1NoteId);
    if (output === null) {
      const partial = buildResult(notePath, sha, chunkCount, start);
      emitNoteIndexed(bus, notePath, partial);
      return partial;
    }
    tier3LlmCalls = output.llmCalls;
    tier3Windows = output.extractionWindows;
  }

  const result = buildResult(notePath, sha, chunkCount, start, {
    llmCalls: tier3LlmCalls,
    extractionWindows: tier3Windows,
  });
  emitNoteIndexed(bus, notePath, result);
  return result;
}

interface Tier1Progress {
  blocks: BlockSpec[];
  noteId: RecordId<"note">;
}

async function executeTier1(args: IndexNoteArgs): Promise<Tier1Progress | null> {
  try {
    const vaultPaths =
      args.vaultPaths ?? (await getVaultPathUniverse(args.surrealDb.db, args.bus, args.notePath));
    if (!vaultPaths.includes(args.notePath)) vaultPaths.push(args.notePath);
    const output = await runTier1(args.surrealDb.db, {
      notePath: args.notePath,
      source: args.noteBody,
      deferCompletion: true,
      vaultPaths,
      bus: args.bus,
    });
    await persistLexicalChunks(args.surrealDb.db, {
      noteId: output.noteId,
      sourceRevision: await sha256(args.noteBody),
      blocks: output.extraction.blocks,
      chunkSizes: args.chunkSizes,
    });
    args.bus.emit({
      type: "indexer:tier1-done",
      path: args.notePath,
      bodySha: output.extraction.bodySha,
    });
    return { blocks: output.extraction.blocks, noteId: output.noteId };
  } catch (error) {
    emitTierError(args, "tier1", error);
    return null;
  }
}

interface Tier2Progress {
  chunkCount: number;
  noteId: RecordId<"note">;
}

async function executeTier2(
  args: IndexNoteArgs,
  tier1Blocks: BlockSpec[] | null,
): Promise<Tier2Progress | null> {
  try {
    const blocks =
      tier1Blocks ?? extract(processAst(args.noteBody), args.notePath, args.noteBody).blocks;
    const output = await runTier2(args.surrealDb.db, {
      sourceRevision: await sha256(args.noteBody),
      notePath: args.notePath,
      signal: args.signal,
      blocks,
      embedder: args.embedder,
      bus: args.bus,
      chunkSizes: args.chunkSizes,
    });
    args.bus.emit({
      type: "indexer:tier2-done",
      path: args.notePath,
      chunkCount: output.chunkCount,
    });
    return { chunkCount: output.chunkCount, noteId: output.noteId };
  } catch (error) {
    emitTierError(args, "tier2", error);
    return null;
  }
}

async function executeTier3(
  args: IndexNoteArgs,
  priorNoteId: RecordId<"note"> | null,
): Promise<Tier3Telemetry | null> {
  try {
    const noteId = priorNoteId ?? (await lookupNoteByPath(args.surrealDb.db, args.notePath));
    if (noteId === null) {
      throw new Error(
        `indexNote: cannot run Tier 3 for '${args.notePath}'; no note row exists (Tier 1 must run first)`,
      );
    }
    const chunks = await fetchChunksForTier3(
      args.surrealDb.db,
      noteId,
      args.embedder.getIdentity(),
    );
    const output = await runTier3(args.surrealDb.db, {
      notePath: args.notePath,
      chunks,
      extractor: args.extractor,
      runLinker: args.runLinker,
      signal: args.signal,
    });
    args.bus.emit({ type: "indexer:tier3-done", path: args.notePath });
    return { llmCalls: output.llmCalls, extractionWindows: output.extractionWindows };
  } catch (error) {
    emitTierError(args, "tier3", error);
    return null;
  }
}

function emitTierError(
  args: Pick<IndexNoteArgs, "bus" | "notePath" | "noteBody">,
  phase: "tier1" | "tier2" | "tier3",
  error: unknown,
): void {
  args.bus.emit({
    type: "indexer:error",
    path: args.notePath,
    message: error instanceof Error ? error.message : String(error),
    phase,
    sourceRevision: createHash("sha256").update(args.noteBody).digest("hex"),
  });
}

/**
 * Process-wide cache of the vault's `note.path` universe.
 *
 * Tier 1's wikilink resolver needs every known path. Fetching it per note
 * made a vault-wide awaken quadratic (`O(notes^2)` rows shipped over the
 * wire). The list is fetched once and then kept correct incrementally:
 *
 *   - every note that flows through `indexNote` is added to the cached list
 *     (covers creates, since a create always reaches the indexer),
 *   - `indexer:tombstoned` and `indexer:renamed` invalidate the cache
 *     (covers deletes and renames),
 *   - {@link invalidateVaultPathUniverse} lets the awaken worker force a
 *     fresh read at the start of a run.
 *
 * The single-note watcher path needs no run-level cache: it hits the same
 * incremental rules and pays one `listNotePaths` on a cold cache.
 */
let cachedVaultPaths: string[] | null = null;
const subscribedBuses = new WeakSet<EventBus>();

export function invalidateVaultPathUniverse(): void {
  cachedVaultPaths = null;
}

/** Test/priming hook: seed the cache with a known path universe. */
export function primeVaultPathUniverse(paths: string[]): void {
  cachedVaultPaths = [...paths];
}

async function getVaultPathUniverse(
  db: SurrealConnection["db"],
  bus: EventBus,
  notePath: string,
): Promise<string[]> {
  if (!subscribedBuses.has(bus)) {
    subscribedBuses.add(bus);
    bus.on("indexer:tombstoned", invalidateVaultPathUniverse);
    bus.on("indexer:renamed", invalidateVaultPathUniverse);
  }
  if (cachedVaultPaths === null) {
    cachedVaultPaths = await listNotePaths(db);
  }
  if (!cachedVaultPaths.includes(notePath)) {
    cachedVaultPaths.push(notePath);
  }
  return cachedVaultPaths;
}

function emitNoteIndexed(bus: EventBus, notePath: string, result: IndexResult): void {
  bus.emit({
    type: "indexer:note-indexed",
    path: notePath,
    result: {
      chunkCount: result.chunkCount,
      embedCount: result.embedCount,
      durationMs: result.durationMs,
      llmCalls: result.llmCalls,
      extractionWindows: result.extractionWindows,
    },
  });
}

interface Tier3Telemetry {
  llmCalls: number;
  extractionWindows: number;
}

function buildResult(
  notePath: string,
  noteSha: string,
  chunkCount: number,
  startMs: number,
  tier3: Tier3Telemetry = { llmCalls: 0, extractionWindows: 0 },
): IndexResult {
  return {
    notePath,
    noteSha,
    chunkCount,
    embedCount: chunkCount,
    durationMs: Math.max(0, Math.round(performance.now() - startMs)),
    llmCalls: tier3.llmCalls,
    extractionWindows: tier3.extractionWindows,
  };
}

async function sha256(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
