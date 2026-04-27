import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { EventBus } from "../../core/events/eventBus";
import type { IndexerQueue } from "../../core/indexer/indexerQueue";
import { encodeEvent } from "../rpc";

export interface AwakenHandlerDeps {
  bus: EventBus;
  indexer: IndexerQueue;
  vault: VaultAdapter;
}

export function makeAwakenHandler(deps: AwakenHandlerDeps) {
  return async (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const since = typeof params.since === "number" ? params.since : null;
    const all = await deps.vault.listMarkdown();
    const filtered = since === null ? all : all.filter((entry) => entry.mtime >= since);

    const forwardEvents = subscribeIndexerEvents(deps.bus, emit, envelopeId);
    try {
      for (const entry of filtered) {
        deps.indexer.enqueue(entry.path);
      }
      await deps.indexer.drain();
      return { ok: true, queued: filtered.length };
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
    const matcher = compileGlob(pattern);
    const all = await deps.vault.listMarkdown();
    const matches = all.filter((entry) => matcher(entry.path));

    const forwardEvents = subscribeIndexerEvents(deps.bus, emit, envelopeId);
    try {
      for (const entry of matches) {
        deps.indexer.enqueue(entry.path);
      }
      await deps.indexer.drain();
      return { ok: true, queued: matches.length };
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
