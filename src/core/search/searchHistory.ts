import type { SearchMode } from "./types";

/**
 * Search history is a bounded ring buffer persisted in the vault sidecar
 * `<vault>/Notient/.index.json` under the `searchHistory` key. Task 10 owns
 * the broader sidecar (conversation index, etc.); this module reads and
 * writes only the `searchHistory` slice through an injected facade so the
 * two features stay decoupled until main.ts wires them in Task 16.
 */
export interface SearchHistoryEntry {
  query: string;
  mode: SearchMode;
  ranAt: number;
}

export interface SearchHistoryFacade {
  /** Returns null when the sidecar does not yet exist. */
  readSidecar(): Promise<Record<string, unknown> | null>;
  writeSidecar(value: Record<string, unknown>): Promise<void>;
}

export interface SearchHistoryOptions {
  facade: SearchHistoryFacade;
  maxQueries: number;
}

const SIDECAR_KEY = "searchHistory";

export class SearchHistory {
  constructor(private readonly options: SearchHistoryOptions) {}

  async list(): Promise<SearchHistoryEntry[]> {
    const sidecar = (await this.options.facade.readSidecar()) ?? {};
    const raw = sidecar[SIDECAR_KEY];
    if (!Array.isArray(raw)) return [];
    const entries: SearchHistoryEntry[] = [];
    for (const item of raw) {
      const entry = coerceEntry(item);
      if (entry) entries.push(entry);
    }
    return entries.slice(0, this.options.maxQueries);
  }

  async record(entry: SearchHistoryEntry): Promise<SearchHistoryEntry[]> {
    const trimmed = entry.query.trim();
    if (trimmed.length === 0) {
      return await this.list();
    }
    const sidecar = (await this.options.facade.readSidecar()) ?? {};
    const previous = Array.isArray(sidecar[SIDECAR_KEY])
      ? (sidecar[SIDECAR_KEY] as unknown[]).map(coerceEntry).filter(isEntry)
      : [];

    const next: SearchHistoryEntry[] = [];
    const head: SearchHistoryEntry = { query: trimmed, mode: entry.mode, ranAt: entry.ranAt };
    next.push(head);
    for (const candidate of previous) {
      if (candidate.query === head.query && candidate.mode === head.mode) continue;
      next.push(candidate);
      if (next.length >= this.options.maxQueries) break;
    }

    const updated = { ...sidecar, [SIDECAR_KEY]: next };
    await this.options.facade.writeSidecar(updated);
    return next;
  }

  async clear(): Promise<void> {
    const sidecar = (await this.options.facade.readSidecar()) ?? {};
    const updated = { ...sidecar, [SIDECAR_KEY]: [] };
    await this.options.facade.writeSidecar(updated);
  }
}

function coerceEntry(value: unknown): SearchHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query : null;
  const mode = normalizeMode(record.mode);
  const ranAt =
    typeof record.ranAt === "number" && Number.isFinite(record.ranAt) ? record.ranAt : null;
  if (query === null || mode === null || ranAt === null) return null;
  return { query, mode, ranAt };
}

function isEntry(value: SearchHistoryEntry | null): value is SearchHistoryEntry {
  return value !== null;
}

function normalizeMode(value: unknown): SearchMode | null {
  if (value === "quick" || value === "balanced" || value === "deep") return value;
  return null;
}
