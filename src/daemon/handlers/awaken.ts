import { createHash } from "node:crypto";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { type SurrealConnection, clearTierAtByPath } from "../../core/db/surreal";
import type { EventBus } from "../../core/events/eventBus";
import type { IndexerQueue } from "../../core/indexer/indexerQueue";
import { prepareNoteRow } from "../../core/indexer/tier1";
import { encodeEvent } from "../rpc";

const DEFAULT_TIER_FILTER: ReadonlyArray<number> = [1, 2, 3];

export interface AwakenHandlerDeps {
  bus: EventBus;
  indexer: IndexerQueue;
  vault: VaultAdapter;
  /**
   * Optional SurrealDB connection. Two roles:
   *
   * 1. The `reindex.glob` flow uses it to clear `tier{N}_at` timestamps
   *    on matched notes before enqueueing.
   * 2. Both `awaken.run` and `reindex.glob` use it to pre-create the
   *    `note` row for every queued path so Tier 1's cross-note edge
   *    resolution (`lookupNoteByPath`) succeeds on a single awaken
   *    pass. Without this pre-pass, a note linking to a sibling that
   *    sits later in the queue silently drops its frontmatter_ref.
   *
   * When `undefined` (early-exit and unit-test paths) both behaviours
   * are skipped; the indexer still drains and Tier 1 falls back to
   * the legacy multi-pass convergence.
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

function quickWordCount(body: string): number {
  const trimmed = body.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Walk every queued path and pre-create its `note` row before the indexer
 * drains. Tier 1 resolves cross-note edges (wikilinks and frontmatter_refs)
 * via `lookupNoteByPath`; without this pre-pass, a note that links to a
 * not-yet-indexed sibling resolves the target to null and Tier 1 silently
 * drops the frontmatter_ref. Pre-creating with the body sha and a quick
 * whitespace-split word_count guarantees every cross-note lookup finds
 * its target on the first awaken pass. Tier 1 overwrites both scalars
 * with the freshly extracted values when it runs against the same path.
 *
 * Read failures are tolerated: the path is skipped, the indexer queue
 * still receives it (Tier 1 will surface the read error through the
 * normal error path), and other notes still benefit from pre-creation.
 */
async function preCreateNoteRows(
  surreal: SurrealConnection,
  vault: VaultAdapter,
  paths: ReadonlyArray<string>,
): Promise<void> {
  for (const path of paths) {
    let body: string;
    try {
      body = await vault.read(path);
    } catch {
      continue;
    }
    const sha = createHash("sha256").update(body).digest("hex");
    const wordCount = quickWordCount(body);
    await prepareNoteRow(surreal.db, { path, sha, wordCount });
  }
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

    // Phase 5 cross-note edge fix. Pre-create every queued note row so
    // Tier 1's `lookupNoteByPath` calls during edge resolution find a
    // target. Without this pass, the first awaken over a fresh vault
    // silently drops frontmatter_refs whose target sits later in the
    // queue. Pre-create runs synchronously before the enqueue loop so
    // every path has a row by the time the indexer worker spins up.
    if (deps.surreal !== undefined) {
      await preCreateNoteRows(
        deps.surreal,
        deps.vault,
        filtered.map((entry) => entry.path),
      );
    }

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
      // Pre-create note rows for the same reason awaken does: Tier 1's
      // cross-note edge resolution needs every target row visible before
      // the per-note loop starts. Run before clearTierAtByPath so every
      // matched path has a row to clear, including any path added since
      // the last awaken.
      await preCreateNoteRows(
        deps.surreal,
        deps.vault,
        matches.map((entry) => entry.path),
      );
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
