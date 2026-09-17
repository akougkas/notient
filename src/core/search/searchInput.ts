import type { SearchFilters } from "./types";

const MATURITY_VALUES = ["raw", "adolescent", "mature", "synthesis-ready"] as const;
const CONNECTIVITY_VALUES = ["isolated", "sparse", "connected", "hub"] as const;
const FILTER_FIELDS = [
  "maturity",
  "folders",
  "fromDate",
  "toDate",
  "connectivityTiers",
  "hasPendingProposals",
] as const;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

export const MAX_SEARCH_LIMIT = 50;

export function parseCanonicalSearchLimit(raw: unknown, label = "limit"): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > MAX_SEARCH_LIMIT) {
    throw new Error(`${label} must be a positive safe integer at most ${MAX_SEARCH_LIMIT}`);
  }
  return raw;
}

export function parseCanonicalSearchFilters(raw: unknown): SearchFilters | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !hasOnlyKeys(raw, FILTER_FIELDS) || Object.keys(raw).length === 0) {
    throw new Error("filters must be a nonempty canonical filter object");
  }
  const filters: SearchFilters = {};
  if (Object.hasOwn(raw, "maturity")) {
    filters.maturity = parseUniqueEnumArray(raw.maturity, MATURITY_VALUES, "filters.maturity");
  }
  if (Object.hasOwn(raw, "folders")) {
    filters.folders = parseFolderArray(raw.folders);
  }
  if (Object.hasOwn(raw, "connectivityTiers")) {
    filters.connectivityTiers = parseUniqueEnumArray(
      raw.connectivityTiers,
      CONNECTIVITY_VALUES,
      "filters.connectivityTiers",
    );
  }
  if (Object.hasOwn(raw, "fromDate")) {
    filters.fromDate = parseDateMilliseconds(raw.fromDate, "filters.fromDate");
  }
  if (Object.hasOwn(raw, "toDate")) {
    filters.toDate = parseDateMilliseconds(raw.toDate, "filters.toDate");
  }
  if (
    filters.fromDate !== undefined &&
    filters.toDate !== undefined &&
    filters.fromDate > filters.toDate
  ) {
    throw new Error("filters.fromDate must not be after filters.toDate");
  }
  if (Object.hasOwn(raw, "hasPendingProposals")) {
    if (raw.hasPendingProposals !== true) {
      throw new Error("filters.hasPendingProposals only accepts true");
    }
    filters.hasPendingProposals = true;
  }
  return filters;
}

function parseUniqueEnumArray<const Value extends string>(
  raw: unknown,
  allowed: readonly Value[],
  label: string,
): Value[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${label} must be a nonempty array`);
  }
  const values: Value[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !allowed.includes(entry as Value)) {
      throw new Error(`${label} contains an unsupported value`);
    }
    if (values.includes(entry as Value)) {
      throw new Error(`${label} must not contain duplicates`);
    }
    values.push(entry as Value);
  }
  return values;
}

function parseFolderArray(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("filters.folders must be a nonempty array");
  }
  const folders: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !isCanonicalFolder(entry)) {
      throw new Error(
        "filters.folders must contain canonical vault-relative folders without a trailing slash",
      );
    }
    if (folders.includes(entry)) {
      throw new Error("filters.folders must not contain duplicates");
    }
    folders.push(entry);
  }
  return folders;
}

function isCanonicalFolder(raw: string): boolean {
  if (
    raw.length === 0 ||
    raw.trim() !== raw ||
    raw.startsWith("/") ||
    raw.endsWith("/") ||
    raw.includes("\\") ||
    containsControlCharacter(raw)
  ) {
    return false;
  }
  return raw
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function parseDateMilliseconds(raw: unknown, label: string): number {
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw < 0 ||
    raw > MAX_DATE_MILLISECONDS
  ) {
    throw new Error(`${label} must be a supported nonnegative epoch millisecond`);
  }
  return raw;
}

function containsControlCharacter(raw: string): boolean {
  for (const character of raw) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function hasOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(raw).every((key) => allowed.includes(key));
}
