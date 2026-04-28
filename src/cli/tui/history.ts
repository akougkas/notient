import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export interface HistoryNav {
  /** Entries oldest-first; the newest submitted entry is at the end. */
  readonly entries: readonly string[];
  /**
   * -1 means the user is at the live (unsubmitted) buffer; 0 means showing
   * the newest entry; N-1 means showing the oldest entry.
   */
  readonly index: number;
}

export interface HistoryStep {
  readonly nav: HistoryNav;
  readonly value: string | null;
}

export function createHistoryNav(entries: readonly string[]): HistoryNav {
  return { entries: [...entries], index: -1 };
}

export function historyPrev(nav: HistoryNav): HistoryStep {
  if (nav.entries.length === 0) {
    return { nav, value: null };
  }
  const nextIndex = Math.min(nav.entries.length - 1, nav.index + 1);
  const value = nav.entries[nav.entries.length - 1 - nextIndex] ?? null;
  return { nav: { entries: nav.entries, index: nextIndex }, value };
}

export function historyNext(nav: HistoryNav): HistoryStep {
  if (nav.index < 0) {
    return { nav, value: null };
  }
  const nextIndex = nav.index - 1;
  if (nextIndex < 0) {
    return { nav: { entries: nav.entries, index: -1 }, value: "" };
  }
  const value = nav.entries[nav.entries.length - 1 - nextIndex] ?? null;
  return { nav: { entries: nav.entries, index: nextIndex }, value };
}

export function historyAppend(nav: HistoryNav, entry: string, max: number): HistoryNav {
  const trimmed = entry.replace(/\r/g, "").trim();
  if (trimmed.length === 0) {
    return { entries: nav.entries, index: -1 };
  }
  const last = nav.entries[nav.entries.length - 1];
  if (last === trimmed) {
    return { entries: nav.entries, index: -1 };
  }
  const next = [...nav.entries, trimmed];
  while (next.length > max) next.shift();
  return { entries: next, index: -1 };
}

export function historyReset(nav: HistoryNav): HistoryNav {
  return { entries: nav.entries, index: -1 };
}

export type HistoryKeyName = "up" | "down" | "other";

export interface HistoryRouteInput {
  readonly keyName: HistoryKeyName;
  readonly nav: HistoryNav;
  readonly buffer: string;
  readonly inHistory: boolean;
}

export interface HistoryRouteResult {
  readonly nav: HistoryNav;
  readonly value: string;
  readonly anchor: string | null;
}

/**
 * Decide whether an Up/Down keypress should be claimed by history navigation
 * and, if so, what the new buffer/nav/anchor values should be. Returns null
 * when the key should fall through to the textarea.
 *
 * Up claims the key when the buffer is empty (first recall) or already in
 * history mode. Down only claims when in history mode. Anchor is the value
 * the consumer just wrote to the buffer; comparing the live buffer to the
 * anchor lets us detect user edits and exit history mode.
 */
export function routeHistoryKey(input: HistoryRouteInput): HistoryRouteResult | null {
  if (input.keyName === "up" && (input.buffer.length === 0 || input.inHistory)) {
    const step = historyPrev(input.nav);
    if (step.value === null) return null;
    return { nav: step.nav, value: step.value, anchor: step.value };
  }
  if (input.keyName === "down" && input.inHistory) {
    const step = historyNext(input.nav);
    if (step.value === null) return null;
    return { nav: step.nav, value: step.value, anchor: step.value === "" ? null : step.value };
  }
  return null;
}

export function loadHistoryFromFile(path: string, max: number): string[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (entries.length <= max) return entries;
  return entries.slice(entries.length - max);
}

export function appendHistoryToFile(path: string, entry: string, max: number): void {
  const trimmed = entry.replace(/\r/g, "").trim();
  if (trimmed.length === 0) return;
  const existing = loadHistoryFromFile(path, max + 1);
  const last = existing[existing.length - 1];
  if (last === trimmed) return;
  if (existing.length < max) {
    appendFileSync(path, `${trimmed}\n`);
    return;
  }
  const next = [...existing, trimmed];
  while (next.length > max) next.shift();
  writeFileSync(path, `${next.join("\n")}\n`);
}
