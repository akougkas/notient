import type { Surreal } from "surrealdb";
import type { AgentRunCapability } from "../coordinator/types";
import type { IndexerQueue } from "./indexerQueue";

/**
 * Boot-time continuation for an embedding model/dimension migration.
 *
 * `applySchema` invalidates only Tier 2 vectors and durably marks each active
 * note with `linker_refresh_pending = true`. Every full daemon boot invokes
 * this coordinator, including boots where the model did not change, so a
 * crash in either phase resumes from database state rather than process
 * memory.
 *
 * The ordering is intentionally global rather than per-note:
 *
 *   1. enqueue every pending note through the normal indexer with a Tier 2
 *      upper bound, then drain the queue;
 *   2. verify every still-pending note has a successful Tier 2 stamp;
 *   3. only then execute a linker-only run for each note and clear that note's
 *      pending flag after the run resolves successfully.
 *
 * The bound capability deliberately skips `runTier3`, because repair must not
 * rewrite concepts, claims, questions, or evidence that remain valid across
 * an embedding-model change. It still creates normal run provenance.
 */

export interface EmbeddingRepairOptions {
  db: Surreal;
  indexer: Pick<IndexerQueue, "enqueue" | "drain">;
  runLinker: AgentRunCapability<"linker">;
  signal?: AbortSignal;
  /** Structured log sink. Defaults to a JSON line on stderr. */
  log?: (line: string) => void;
}

export interface EmbeddingRepairResult {
  /** Notes carrying the durable pending flag when this invocation started. */
  pendingAtStart: number;
  /** Pending notes whose Tier 2 stamp was still absent after the queue drained. */
  tier2Incomplete: string[];
  /** Notes whose linker-only refresh succeeded and whose flag was cleared. */
  linkerRefreshed: number;
  /** Notes whose linker invocation failed; their flags remain set for boot resume. */
  linkerFailed: string[];
  /** True when daemon shutdown aborted the linker phase. */
  aborted: boolean;
}

interface PendingNoteRow {
  path: string;
  tier2_at?: Date | string | null;
}

const REPAIR_PRIORITY = 0;
const TIER2_ONLY = [2] as const;

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function listPendingNotes(db: Surreal): Promise<PendingNoteRow[]> {
  const [rows] = await db
    .query<[PendingNoteRow[]]>(
      "SELECT path, tier2_at FROM note WHERE linker_refresh_pending = true AND tombstoned_at IS NONE ORDER BY path;",
    )
    .collect<[PendingNoteRow[]]>();
  return rows;
}

async function clearPendingFlag(db: Surreal, path: string): Promise<void> {
  await db
    .query(
      "UPDATE note SET linker_refresh_pending = false WHERE path = $path AND tier2_at IS NOT NONE;",
      { path },
    )
    .collect();
}

function isTier2Complete(row: PendingNoteRow): boolean {
  return row.tier2_at !== null && row.tier2_at !== undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyResult(pendingAtStart = 0): EmbeddingRepairResult {
  return {
    pendingAtStart,
    tier2Incomplete: [],
    linkerRefreshed: 0,
    linkerFailed: [],
    aborted: false,
  };
}

async function refreshPendingLinkers(
  options: EmbeddingRepairOptions,
  notes: PendingNoteRow[],
  result: EmbeddingRepairResult,
  log: (line: string) => void,
): Promise<void> {
  for (const note of notes) {
    if (isAborted(options.signal)) {
      result.aborted = true;
      break;
    }
    try {
      await options.runLinker.execute({
        trigger: "embedding-repair",
        notePath: note.path,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await clearPendingFlag(options.db, note.path);
      result.linkerRefreshed += 1;
    } catch (error) {
      if (isAborted(options.signal) || isAbortError(error)) {
        result.aborted = true;
        break;
      }
      result.linkerFailed.push(note.path);
      log(
        JSON.stringify({
          type: "daemon:embedding_repair_linker_failed",
          path: note.path,
          error: messageOf(error),
        }),
      );
    }
  }
}

export async function runEmbeddingRepair(
  options: EmbeddingRepairOptions,
): Promise<EmbeddingRepairResult> {
  const log = options.log ?? defaultLog;
  const pendingAtStart = await listPendingNotes(options.db);
  const result = emptyResult(pendingAtStart.length);
  if (pendingAtStart.length === 0) return result;
  if (isAborted(options.signal)) {
    result.aborted = true;
    return result;
  }

  // Enqueue the complete set before waiting. This makes the phase boundary
  // explicit and prevents an early linker call from observing a vault whose
  // neighbour vectors are only partially rebuilt.
  for (const note of pendingAtStart) {
    options.indexer.enqueue(note.path, REPAIR_PRIORITY, TIER2_ONLY);
  }
  await options.indexer.drain();

  if (isAborted(options.signal)) {
    result.aborted = true;
    return result;
  }

  // `indexNote` reports Tier 2 errors on the event bus and resolves so the
  // queue can continue. The durable stamp is therefore the authoritative
  // success check after drain, not the queue callback's return value.
  const pendingAfterTier2 = await listPendingNotes(options.db);
  result.tier2Incomplete = pendingAfterTier2
    .filter((note) => !isTier2Complete(note))
    .map((note) => note.path);
  if (result.tier2Incomplete.length > 0) {
    log(
      JSON.stringify({
        type: "daemon:embedding_repair_tier2_incomplete",
        paths: result.tier2Incomplete,
      }),
    );
    return result;
  }

  await refreshPendingLinkers(options, pendingAfterTier2, result, log);

  return result;
}
