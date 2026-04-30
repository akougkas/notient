/**
 * `notient reindex [<glob>] [--pattern <glob>]` command entrypoint.
 *
 * Phase 5 Task 11 adds `--tier <csv>` so the operator can re-run a
 * subset of tiers across matched notes. The CSV is parsed via
 * `parseTierCsv` (shared with `awaken --tier`) into a sorted array of
 * valid tier ids (1, 2, 3); invalid tokens drop and an empty result
 * falls back to `[1, 2, 3]`. The parsed array is forwarded as the
 * `tier` RPC parameter; the daemon clears the matching `tier{N}_at`
 * timestamps on every matched note before enqueueing so the indexer
 * only runs the requested tiers.
 */

import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export const DEFAULT_REINDEX_PATTERN = "**/*.md";
export const REINDEX_USAGE = "usage: notient reindex [<glob>] [--pattern <glob>] [--tier <csv>]";

export interface ReindexCommandOptions {
  vaultPath: string;
  pattern: string;
  /**
   * Tier filter forwarded as the `tier` RPC parameter. Defaults to
   * `[1, 2, 3]` when omitted. Callers should run the raw `--tier`
   * value through `parseTierCsv` so invalid tokens are stripped before
   * reaching the wire.
   */
  tier?: number[];
  emitter: Emitter;
  clientIdentity?: string;
}

export class ReindexPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReindexPatternError";
  }
}

export function resolveReindexPattern(options: {
  positionalPattern?: string;
  flagPattern?: string | boolean;
}): string {
  const flagPattern = normalizePatternFlag(options.flagPattern);
  const positionalPattern = options.positionalPattern;
  if (
    positionalPattern !== undefined &&
    flagPattern !== undefined &&
    positionalPattern !== flagPattern
  ) {
    throw new ReindexPatternError(
      `${REINDEX_USAGE}; positional glob and --pattern must match when both are supplied`,
    );
  }
  return flagPattern ?? positionalPattern ?? DEFAULT_REINDEX_PATTERN;
}

export async function runReindexCommand(options: ReindexCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });
  const params: Record<string, unknown> = { pattern: options.pattern };
  if (options.tier !== undefined) params.tier = options.tier;
  for await (const frame of client.call("reindex.glob", params)) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
}

function normalizePatternFlag(raw: string | boolean | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ReindexPatternError(`${REINDEX_USAGE}; --pattern requires a glob value`);
  }
  return raw;
}
