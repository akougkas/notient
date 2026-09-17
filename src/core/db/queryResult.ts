/** Strict decoders for the exact result shapes returned by SurrealDB queries. */

export function readSingleStatementRows(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(`${label} storage integrity: invalid single-statement result envelope`);
  }
  return raw[0];
}

/**
 * Decode `SELECT count() AS count ... GROUP ALL`. SurrealDB returns no row for
 * an empty aggregate and exactly one `{ count }` row otherwise.
 */
export function readAggregateCount(raw: unknown, label: string): number {
  const rows = readSingleStatementRows(raw, label);
  if (rows.length === 0) return 0;
  if (rows.length !== 1 || !isExactRecord(rows[0], ["count"])) {
    throw new Error(`${label} storage integrity: invalid aggregate count row`);
  }
  const count = rows[0].count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} storage integrity: count must be a nonnegative safe integer`);
  }
  return count;
}

export function isExactRecord(
  raw: unknown,
  expectedKeys: readonly string[],
): raw is Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const keys = Object.keys(raw).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
