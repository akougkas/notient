import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { type SurrealConnection, clearTierAtByPath } from "../../core/db/surreal";
import type { EventBus } from "../../core/events/eventBus";
import type { IndexerQueue } from "../../core/indexer/indexerQueue";
import { encodeEvent } from "../rpc";

const DEFAULT_TIER_FILTER: ReadonlyArray<number> = [1, 2, 3];

export interface AwakenHandlerDeps {
  bus: EventBus;
  indexer: IndexerQueue;
  vault: VaultAdapter;
  /**
   * Optional SurrealDB connection. Required for the `reindex.glob` flow
   * to clear `tier{N}_at` timestamps before enqueueing matched notes;
   * the legacy `awaken.run` path does not need it because awaken's
   * tier filter flows down to `indexNote` via the per-path queue
   * context rather than through DB state.
   */
  surreal?: SurrealConnection;
}

/**
 * Parse a tier filter param. Accepts a `number[]` (preferred wire form
 * from the CLI), a CSV string (forgiving), or `undefined` (default to
 * all tiers). Invalid entries silently drop; an empty resulting set
 * falls back to `[1, 2, 3]` so the daemon never enqueues with an
 * empty filter.
 */
function parseTierFilterParam(value: unknown): number[] {
  const candidates: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",").map((token) => token.trim())
      : [];
  const result = new Set<number>();
  for (const candidate of candidates) {
    const numeric =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && /^\d+$/.test(candidate)
          ? Number(candidate)
          : Number.NaN;
    if (numeric === 1 || numeric === 2 || numeric === 3) {
      result.add(numeric);
    }
  }
  if (result.size === 0) return [...DEFAULT_TIER_FILTER];
  return Array.from(result).sort((a, b) => a - b);
}

function isFullTierFilter(filter: ReadonlyArray<number>): boolean {
  return filter.length === DEFAULT_TIER_FILTER.length;
}

export function makeAwakenHandler(deps: AwakenHandlerDeps) {
  return async (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const since = typeof params.since === "number" ? params.since : null;
    const tierFilter = parseTierFilterParam(params.tier);
    const all = await deps.vault.listMarkdown();
    const filtered = since === null ? all : all.filter((entry) => entry.mtime >= since);

    const forwardEvents = subscribeIndexerEvents(deps.bus, emit, envelopeId);
    try {
      const enqueueFilter = isFullTierFilter(tierFilter) ? undefined : tierFilter;
      for (const entry of filtered) {
        deps.indexer.enqueue(entry.path, undefined, enqueueFilter);
      }
      await deps.indexer.drain();
      return { ok: true, queued: filtered.length, tier: tierFilter };
    } finally {
      forwardEvents();
    }
  };
}

export function makeReindexHandler(deps: AwakenHandlerDeps) {
  return async (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const pattern = typeof params.pattern === "string" ? params.pattern : "**/*.md";
    const tierFilter = parseTierFilterParam(params.tier);
    const matcher = compileGlob(pattern);
    const all = await deps.vault.listMarkdown();
    const matches = all.filter((entry) => matcher(entry.path));

    // Phase 5 Task 11: `reindex --tier <csv>` re-runs the named tiers by
    // clearing the matching `tier{N}_at` timestamps for each matched
    // note before enqueueing. The indexer's per-tier orchestrator
    // (`indexNote`) consults the queue-supplied tier filter when
    // deciding which tiers to execute. Tiers outside the filter are
    // left as-is so already-completed work stays untouched.
    if (deps.surreal !== undefined) {
      for (const entry of matches) {
        await clearTierAtByPath(deps.surreal.db, entry.path, tierFilter);
      }
    }

    const forwardEvents = subscribeIndexerEvents(deps.bus, emit, envelopeId);
    try {
      const enqueueFilter = isFullTierFilter(tierFilter) ? undefined : tierFilter;
      for (const entry of matches) {
        deps.indexer.enqueue(entry.path, undefined, enqueueFilter);
      }
      await deps.indexer.drain();
      return { ok: true, queued: matches.length, tier: tierFilter };
    } finally {
      forwardEvents();
    }
  };
}

function subscribeIndexerEvents(
  bus: EventBus,
  emit: (line: string) => void,
  envelopeId: string,
): () => void {
  const unsubs: Array<() => void> = [];
  for (const eventName of [
    "indexer:progress",
    "indexer:note-indexed",
    "indexer:complete",
    "indexer:error",
  ] as const) {
    unsubs.push(
      bus.on(eventName, (event) => {
        emit(encodeEvent(envelopeId, eventName, event as unknown as Record<string, unknown>));
      }),
    );
  }
  return () => {
    for (const off of unsubs) off();
  };
}

/**
 * Minimal glob matcher. Supports `*` (any non-slash chars), `**` (any chars
 * including slashes), and literal segments. Sufficient for the
 * `notient reindex "notes/*.md"` use case in Phase B; richer glob semantics
 * land in Phase E.
 */
function compileGlob(pattern: string): (path: string) => boolean {
  const regex = patternToRegExp(pattern);
  return (path: string) => regex.test(path);
}

function patternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index++;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (".+()|^$[]{}\\".includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  source += "$";
  return new RegExp(source);
}
