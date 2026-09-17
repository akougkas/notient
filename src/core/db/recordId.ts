import { RecordId, Uuid } from "surrealdb";

/**
 * Notient-owned operational rows use native UUID record keys. SurrealDB's
 * canonical text form for such a key is `table:u"<lowercase-uuid>"`.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * SurrealDB 3.0.5 emits a 20-character lowercase alphanumeric key when
 * `RELATE` creates a relation without an explicit id. Notient's canonical,
 * content-addressed proposal ids use `p` plus the full 80-bit lowercase hex
 * digest so their native text form can never be interpreted as a number.
 */
const SURREAL_RELATION_KEY = /^(?:[0-9a-z]{20}|p[0-9a-f]{20})$/;

export function createUuidRecordId<TableName extends string>(
  table: TableName,
  uuid = Bun.randomUUIDv7(),
): RecordId<TableName> {
  if (!CANONICAL_UUID.test(uuid)) {
    throw new Error(`cannot create ${table} record id from a non-canonical UUID key`);
  }
  return new RecordId(table, new Uuid(uuid));
}

export function parseUuidRecordId<TableName extends string>(
  raw: unknown,
  table: TableName,
  label = "record id",
): RecordId<TableName> {
  const prefix = `${table}:u\"`;
  if (
    typeof raw !== "string" ||
    !raw.startsWith(prefix) ||
    !raw.endsWith('"') ||
    raw.length !== prefix.length + 36 + 1
  ) {
    throw new Error(`${label} must be a canonical ${table} UUID record id`);
  }
  const uuid = raw.slice(prefix.length, -1);
  if (!CANONICAL_UUID.test(uuid)) {
    throw new Error(`${label} must be a canonical ${table} UUID record id`);
  }
  const recordId = new RecordId(table, new Uuid(uuid));
  if (recordId.toString() !== raw) {
    throw new Error(`${label} must be a canonical ${table} UUID record id`);
  }
  return recordId;
}

export function stringifyUuidRecordId<TableName extends string>(
  raw: unknown,
  table: TableName,
  label = "stored record id",
): string {
  if (!(raw instanceof RecordId)) {
    throw new Error(`${label} must be a native SurrealDB record id`);
  }
  return parseUuidRecordId(raw.toString(), table, label).toString();
}

export function parseStoredUuidRecordId<TableName extends string>(
  raw: unknown,
  table: TableName,
  label = "stored record id",
): RecordId<TableName> {
  if (!(raw instanceof RecordId)) {
    throw new Error(`${label} must be a native SurrealDB record id`);
  }
  return parseUuidRecordId(raw.toString(), table, label);
}

export interface ParsedSurrealRelationRecordId<TableName extends string> {
  table: TableName;
  recordId: RecordId<TableName>;
  id: string;
}

/**
 * Parse only a current canonical relation id: either SurrealDB 3.0.5's exact
 * implicit `RELATE` shape or Notient's `p`-prefixed deterministic proposal
 * shape. This deliberately excludes quoted, bracketed, numeric, UUID,
 * uppercase, and whitespace-normalized alternatives.
 */
export function parseSurrealRelationRecordId<TableName extends string>(
  raw: unknown,
  allowedTables: readonly TableName[],
  label = "relation id",
): ParsedSurrealRelationRecordId<TableName> {
  if (typeof raw !== "string") {
    throw new Error(`${label} must be a canonical SurrealDB relation record id`);
  }
  const colon = raw.indexOf(":");
  if (colon <= 0 || raw.indexOf(":", colon + 1) !== -1) {
    throw new Error(`${label} must be a canonical SurrealDB relation record id`);
  }
  const table = raw.slice(0, colon) as TableName;
  const key = raw.slice(colon + 1);
  if (!allowedTables.includes(table) || !SURREAL_RELATION_KEY.test(key)) {
    throw new Error(`${label} must be a canonical SurrealDB relation record id`);
  }
  const recordId = new RecordId(table, key);
  if (recordId.toString() !== raw) {
    throw new Error(`${label} must be a canonical SurrealDB relation record id`);
  }
  return { table, recordId, id: raw };
}
