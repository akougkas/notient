import { searchCoverageSchema } from "../../api/indexing";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export type SearchCommandMode = "quick" | "balanced" | "deep";

const SEARCH_MODES: readonly SearchCommandMode[] = ["quick", "balanced", "deep"];

/**
 * Validates the `--mode` flag.
 *
 * Returns `undefined` when the flag was not given so the caller omits `mode`
 * from the RPC and the daemon applies the vault's configured default. An
 * unrecognised value is a usage error rather than a cast that reaches the
 * search pipeline as an unknown mode.
 */
export function parseSearchMode(value: unknown): SearchCommandMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SEARCH_MODES.includes(value as SearchCommandMode)) {
    throw new Error("INVALID_PARAMS: --mode must be one of quick|balanced|deep");
  }
  return value as SearchCommandMode;
}

export interface SearchCommandOptions {
  vaultPath: string;
  query: string;
  /** Omitted when `--mode` was not given, letting the daemon pick the default. */
  mode?: SearchCommandMode;
  limit?: number;
  emitter: Emitter;
  clientIdentity?: string;
}

export async function runSearchCommand(options: SearchCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });
  const params: Record<string, unknown> = { query: options.query };
  if (options.mode !== undefined) params.mode = options.mode;
  if (options.limit !== undefined) params.limit = options.limit;
  try {
    for await (const frame of client.call("search.run", params)) {
      if (frame.type === "result") {
        const result = frame.result as Record<string, unknown> | undefined;
        const coverage = searchCoverageSchema.parse(result?.coverage);
        if (coverage.message)
          options.emitter.emit({ type: "search:coverage", message: coverage.message, coverage });
      }
      options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
      if (frame.type === "result" || frame.type === "error") break;
    }
  } finally {
    await client.close();
  }
}
