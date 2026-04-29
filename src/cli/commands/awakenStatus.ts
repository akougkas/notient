/**
 * `notient awaken --status` thin-client handler.
 *
 * Spec: Phase 4 plan §Task 9. Polls the awaken_run table at 1Hz, emits one
 * NDJSON frame per tick, and exits 0 once the run reaches a terminal
 * status (`completed`, `cancelled`, `failed`). When no run exists the
 * helper emits a single `{"status":"none"}` frame and exits 0.
 *
 * Derived metrics:
 *   - `perSecond` = processed / elapsed_seconds. Reports 0 when elapsed is
 *     under one second to avoid division blow-ups on a freshly-created run.
 *   - `etaSeconds` = (total - processed) / perSecond. Reports null when
 *     `perSecond` is 0 or `processed >= total`. The JSON shape uses null
 *     instead of Infinity because Infinity is not a valid JSON number.
 */

import type { RecordId, Surreal } from "surrealdb";
import type { AwakenRunRow } from "../../core/awaken/awakenRun";
import { findById, findCurrent, findLatestResumable } from "../../core/awaken/awakenRun";
import { connectVaultSurreal } from "./awakenSurrealClient";

export interface AwakenStatusOptions {
  vaultPath: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Test seam. Defaults to a 1000ms timer; tests pass 0 to drive the loop
   * without waiting and inject their own pacing through the abort signal.
   */
  pollIntervalMs?: number;
  /**
   * Test seam. Aborts the polling loop between ticks. The loop checks the
   * signal both before each query and before sleeping.
   */
  signal?: AbortSignal;
}

interface StatusFrame {
  type: "awaken:status";
  runId: string;
  status: AwakenRunRow["status"];
  processed: number;
  failed: number;
  total: number;
  perSecond: number;
  etaSeconds: number | null;
}

function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

const TERMINAL_STATUSES: ReadonlySet<AwakenRunRow["status"]> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

export async function runAwakenStatus(options: AwakenStatusOptions): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  const intervalMs = options.pollIntervalMs ?? 1000;

  let connection: { close: () => Promise<void> } | undefined;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    return await pollUntilTerminal(opened, { stdout, stderr, intervalMs, signal: options.signal });
  } catch (error) {
    stderr(`awaken --status: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}

interface PollContext {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  intervalMs: number;
  signal: AbortSignal | undefined;
}

async function pollUntilTerminal(opened: { db: Surreal }, context: PollContext): Promise<number> {
  // First tick: locate the active run via the DAL search helpers. Once a
  // runId is locked we keep polling that specific row even after it
  // transitions to a terminal status; otherwise the search filters would
  // hide the row right when we want to emit its terminal frame.
  if (context.signal?.aborted === true) return 0;
  const initial = await readInitialRow(opened.db, context.stderr);
  if (initial === "error") return 1;
  if (initial === null) {
    context.stdout(JSON.stringify({ type: "awaken:status", status: "none" }));
    return 0;
  }
  context.stdout(JSON.stringify(buildFrame(initial)));
  if (TERMINAL_STATUSES.has(initial.status)) return 0;

  const lockedRunId = initial.id;
  while (true) {
    const aborted = await sleepOrAbort(context.intervalMs, context.signal);
    if (aborted) return 0;
    const row = await readRowById(opened.db, lockedRunId, context.stderr);
    if (row === "error") return 1;
    if (row === null) {
      // The row was deleted out from under us. Surface a final none-frame
      // so consumers see termination instead of a hung stream.
      context.stdout(JSON.stringify({ type: "awaken:status", status: "none" }));
      return 0;
    }
    context.stdout(JSON.stringify(buildFrame(row)));
    if (TERMINAL_STATUSES.has(row.status)) return 0;
  }
}

async function readInitialRow(
  db: Surreal,
  stderr: (line: string) => void,
): Promise<AwakenRunRow | null | "error"> {
  try {
    const current = await findCurrent(db);
    if (current !== null) return current;
    return await findLatestResumable(db);
  } catch (error) {
    stderr(
      `awaken --status: failed to read run state: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "error";
  }
}

async function readRowById(
  db: Surreal,
  runId: RecordId<"awaken_run">,
  stderr: (line: string) => void,
): Promise<AwakenRunRow | null | "error"> {
  try {
    return await findById(db, runId);
  } catch (error) {
    stderr(
      `awaken --status: failed to read run state: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "error";
  }
}

function buildFrame(row: AwakenRunRow): StatusFrame {
  const elapsedSeconds = (Date.now() - row.started_at.getTime()) / 1000;
  const perSecond = elapsedSeconds >= 1 && row.processed > 0 ? row.processed / elapsedSeconds : 0;
  const remaining = Math.max(row.total - row.processed, 0);
  const etaSeconds = perSecond > 0 && remaining > 0 ? remaining / perSecond : null;
  return {
    type: "awaken:status",
    runId: row.id.toString(),
    status: row.status,
    processed: row.processed,
    failed: row.failed,
    total: row.total,
    perSecond,
    etaSeconds,
  };
}

function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve(true);
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve(true);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
