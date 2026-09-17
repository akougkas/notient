/**
 * Scoped, expiring authority for unattended writes.
 *
 * Folder prefixes end in `/`, so `Inbox/` cannot match `Inbox-archive/`.
 * Tool scope is always non-empty; `["*"]` is the one explicit all-tools
 * representation. Claiming a grant and consuming its write allowance happen
 * in one conditional update, so concurrent calls cannot exceed `maxWrites`.
 */

import type { RecordId, Surreal } from "surrealdb";
import { normalizeAgentId } from "../auth/agentIdentity";
import { createUuidRecordId, parseStoredUuidRecordId, parseUuidRecordId } from "../db/recordId";
import { withSurrealRetry } from "../db/retry";

export interface SessionGrant {
  id: string;
  client: string;
  grantedAt: number;
  expiresAt: number;
  allowedFolders: string[];
  allowedTools: string[];
  maxWrites: number | null;
  usedWrites: number;
  revokedAt: number | null;
}

export interface SessionGrantOptions {
  client: string;
  allowedFolders: string[];
  allowedTools?: string[];
  maxWrites?: number;
  ttlMinutes: number;
}

export interface SessionGrantClaimQuery {
  client: string;
  tool: string;
  folder: string;
  now: number;
  /** Reserve every planned effect atomically; omitted for a single write. */
  writeCount?: number;
}

export interface SessionListFilter {
  client?: string;
  activeOnly?: boolean;
}

export interface SessionGrantsOptions {
  db: Surreal;
  now: () => number;
}

export const ALL_SESSION_TOOLS = "*" as const;

export class SessionGrantIntegrityError extends Error {
  constructor(message: string) {
    super(`session grant storage integrity failure: ${message}`);
    this.name = "SessionGrantIntegrityError";
  }
}

export const SESSION_GRANT_TTL_MAX_MINUTES = 24 * 60;

const SESSION_ROW_FIELDS = [
  "id",
  "client",
  "granted_at",
  "expires_at",
  "allowed_folders",
  "allowed_tools",
  "max_writes",
  "used_writes",
  "revoked_at",
] as const;

const SESSION_CREATED_REQUIRED_FIELDS = [
  "id",
  "client",
  "granted_at",
  "expires_at",
  "allowed_folders",
  "allowed_tools",
  "used_writes",
] as const;

const ROW_PROJECTION = SESSION_ROW_FIELDS.join(", ");
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

interface DecodedGrant {
  grant: SessionGrant;
  recordId: RecordId<"agent_session">;
}

export class SessionGrants {
  private readonly db: Surreal;
  private readonly now: () => number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: SessionGrantsOptions) {
    if (!isObject(options) || !isObject(options.db) || typeof options.db.query !== "function") {
      throw new Error("SessionGrants requires a SurrealDB client");
    }
    if (typeof options.now !== "function") {
      throw new Error("SessionGrants requires a clock function");
    }
    this.db = options.db;
    this.now = options.now;
  }

  async grant(options: SessionGrantOptions): Promise<SessionGrant> {
    assertOnlyInputFields(
      options,
      ["client", "allowedFolders", "allowedTools", "maxWrites", "ttlMinutes"],
      "grant options",
    );
    const client = canonicalClient(options.client, "client");
    const allowedFolders = validateAllowedFolders(options.allowedFolders);
    const allowedTools = validateAllowedTools(options.allowedTools);
    const maxWrites = validateMaxWrites(options.maxWrites);
    const ttlMinutes = validateTtlMinutes(options.ttlMinutes);

    return this.serializeMutation(async () => {
      const grantedAt = readClock(this.now, "grant");
      const lifetimeMs = ttlMinutes * 60_000;
      const expiresAt = grantedAt + lifetimeMs;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= grantedAt) {
        throw new Error("SessionGrants grant expiry must be a safe integer after its grant clock");
      }
      const setClauses: string[] = [
        "client: $client",
        "granted_at: $grantedAt",
        "expires_at: $expiresAt",
        "allowed_folders: $allowedFolders",
        "allowed_tools: $allowedTools",
        "used_writes: 0",
      ];
      const bindings: Record<string, unknown> = {
        client,
        grantedAt,
        expiresAt,
        allowedFolders,
        allowedTools,
      };
      if (maxWrites !== null) {
        setClauses.push("max_writes: $maxWrites");
        bindings.maxWrites = maxWrites;
      }
      const sql = [
        "BEGIN;",
        "IF !record::exists($rowId) {",
        `  CREATE ONLY $rowId CONTENT { ${setClauses.join(", ")} };`,
        "};",
        "COMMIT;",
        `SELECT ${ROW_PROJECTION} FROM $rowId;`,
      ].join("\n");
      const operationId = Bun.randomUUIDv7();
      const recordId = createUuidRecordId("agent_session", operationId);
      const results = await withSurrealRetry(
        () => this.db.query(sql, { ...bindings, rowId: recordId }).collect<unknown[]>(),
        { idempotencyKey: operationId },
      );
      const { created, selected } = readCreateEnvelope(results);
      const expected: SessionGrant = {
        id: recordId.toString(),
        client,
        grantedAt,
        expiresAt,
        allowedFolders,
        allowedTools,
        maxWrites,
        usedWrites: 0,
        revokedAt: null,
      };
      if (created !== undefined) {
        assertGrantEqual(readCreatedGrantRow(created).grant, expected, "created row");
      }
      const selectedGrant = readProjectedGrantRow(selected).grant;
      assertGrantEqual(selectedGrant, expected, "selected row");
      return selectedGrant;
    });
  }

  async get(id: string): Promise<SessionGrant | null> {
    return (await this.findById(parseSessionGrantRecordId(id)))?.grant ?? null;
  }

  async revoke(id: string): Promise<SessionGrant | null> {
    return this.serializeMutation(async () => {
      const recordId = parseSessionGrantRecordId(id);
      const existing = await this.findById(recordId);
      if (existing === null) return null;
      if (existing.grant.revokedAt !== null) return existing.grant;
      const revokedAt = readClock(this.now, "revoke");
      if (revokedAt < existing.grant.grantedAt) {
        throw new Error("SessionGrants revoke clock must not precede grantedAt");
      }
      const results = await this.db
        .query(
          `UPDATE $id
             SET revoked_at = $revokedAt
           WHERE revoked_at = NONE
           RETURN AFTER;`,
          { id: recordId, revokedAt },
        )
        .collect<unknown[]>();
      const row = readExactlyOneRow(results, "revoke");
      const revoked = readMutationGrantRow(row, "revoke").grant;
      assertGrantEqual(revoked, { ...existing.grant, revokedAt }, "revoked row");
      return revoked;
    });
  }

  async list(filter: SessionListFilter): Promise<SessionGrant[]> {
    assertOnlyInputFields(filter, ["client", "activeOnly"], "list filter");
    if (filter.activeOnly !== undefined && typeof filter.activeOnly !== "boolean") {
      throw new Error("SessionGrants list activeOnly must be boolean");
    }
    const client =
      filter.client === undefined ? undefined : canonicalClient(filter.client, "list client");
    const activeOnly = filter.activeOnly ?? true;
    const conditions: string[] = [];
    const bindings: Record<string, unknown> = {};
    if (client !== undefined) {
      conditions.push("client = $client");
      bindings.client = client;
    }
    let activeAt: number | undefined;
    if (activeOnly) {
      activeAt = readClock(this.now, "list");
      conditions.push("revoked_at = NONE");
      conditions.push("expires_at > $now");
      bindings.now = activeAt;
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const sql = `SELECT ${ROW_PROJECTION} FROM agent_session ${where} ORDER BY granted_at DESC, id DESC;`;
    const results = await this.db.query(sql, bindings).collect<unknown[]>();
    const rows = readStatementRows(results, "list");
    const grants = readUniqueGrantRows(rows, "list").map((decoded) => decoded.grant);
    for (const grant of grants) {
      if (client !== undefined && grant.client !== client) {
        throw new SessionGrantIntegrityError("list returned a row for another client");
      }
      if (activeAt !== undefined && (grant.revokedAt !== null || grant.expiresAt <= activeAt)) {
        throw new SessionGrantIntegrityError("list returned a row outside its active filter");
      }
    }
    return grants;
  }

  async claim(query: SessionGrantClaimQuery): Promise<SessionGrant | null> {
    const validated = validateClaimQuery(query);
    return this.serializeMutation(async () => {
      const sql = `SELECT ${ROW_PROJECTION} FROM agent_session
         WHERE client = $client
           AND revoked_at = NONE
           AND expires_at > $now
           AND (max_writes = NONE OR used_writes < max_writes)
         ORDER BY granted_at DESC, id DESC;`;
      const results = await this.db
        .query(sql, { client: validated.client, now: validated.now })
        .collect<unknown[]>();
      const candidates = readUniqueGrantRows(readStatementRows(results, "claim lookup"), "claim");
      for (const candidate of candidates) {
        assertClaimCandidate(candidate.grant, validated);
        if (!toolMatches(candidate.grant.allowedTools, validated.tool)) continue;
        if (!folderMatches(candidate.grant.allowedFolders, validated.folder)) continue;
        const nextWrites = candidate.grant.usedWrites + validated.writeCount;
        if (!Number.isSafeInteger(nextWrites)) {
          throw new SessionGrantIntegrityError("used_writes cannot be incremented safely");
        }
        if (candidate.grant.maxWrites !== null && nextWrites > candidate.grant.maxWrites) continue;
        const updatedResults = await this.db
          .query(
            `UPDATE $id
               SET used_writes = used_writes + $writeCount
             WHERE client = $client
               AND revoked_at = NONE
               AND expires_at > $now
               AND used_writes = $expectedWrites
               AND (max_writes = NONE OR used_writes + $writeCount <= max_writes)
             RETURN AFTER;`,
            {
              id: candidate.recordId,
              client: validated.client,
              now: validated.now,
              writeCount: validated.writeCount,
              expectedWrites: candidate.grant.usedWrites,
            },
          )
          .collect<unknown[]>();
        const claimedRow = readZeroOrOneRow(updatedResults, "claim update");
        if (claimedRow === undefined) continue;
        const claimed = readMutationGrantRow(claimedRow, "claim update").grant;
        assertGrantEqual(claimed, { ...candidate.grant, usedWrites: nextWrites }, "claimed row");
        return claimed;
      }
      return null;
    });
  }

  /**
   * One daemon owns one SessionGrants instance. Serializing its mutations
   * gives claims a stable FIFO order and avoids SurrealDB write conflicts
   * without retrying a possibly committed allowance increment.
   */
  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async findById(id: RecordId<"agent_session">): Promise<DecodedGrant | null> {
    const results = await this.db
      .query(`SELECT ${ROW_PROJECTION} FROM agent_session WHERE id = $id LIMIT 1;`, { id })
      .collect<unknown[]>();
    const row = readZeroOrOneRow(results, "findById");
    if (row === undefined) return null;
    const decoded = readProjectedGrantRow(row);
    if (decoded.recordId.toString() !== id.toString()) {
      throw new SessionGrantIntegrityError("findById returned a different record id");
    }
    return decoded;
  }
}

function validateAllowedFolders(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("allowedFolders must be a non-empty array of vault-relative folder prefixes");
  }
  const out: string[] = [];
  for (const raw of input) {
    assertCanonicalFolderPrefix(raw, false, "allowedFolders entry");
    if (out.includes(raw)) {
      throw new Error("allowedFolders must not contain duplicates");
    }
    out.push(raw);
  }
  return out;
}

function validateAllowedTools(input: unknown): string[] {
  if (input === undefined) return [ALL_SESSION_TOOLS];
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("allowedTools must be a non-empty array of tool names");
  }
  const out: string[] = [];
  for (const entry of input) {
    assertCanonicalTool(entry, true, "allowedTools entry");
    if (out.includes(entry)) {
      throw new Error("allowedTools must not contain duplicates");
    }
    out.push(entry);
  }
  if (out.includes(ALL_SESSION_TOOLS) && out.length !== 1) {
    throw new Error("allowedTools '*' wildcard cannot be combined with named tools");
  }
  return out;
}

function validateMaxWrites(raw: unknown): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error("maxWrites must be a positive safe integer when provided");
  }
  return raw;
}

function validateTtlMinutes(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error("ttlMinutes must be a positive safe integer");
  }
  if (raw > SESSION_GRANT_TTL_MAX_MINUTES) {
    throw new Error(`ttlMinutes must not exceed ${SESSION_GRANT_TTL_MAX_MINUTES}`);
  }
  return raw;
}

function validateClaimQuery(raw: unknown): SessionGrantClaimQuery & { writeCount: number } {
  assertOnlyInputFields(raw, ["client", "tool", "folder", "now", "writeCount"], "claim query");
  const client = canonicalClient(raw.client, "claim client");
  assertCanonicalTool(raw.tool, false, "claim tool");
  assertCanonicalFolderPrefix(raw.folder, true, "claim folder");
  if (typeof raw.now !== "number" || !Number.isSafeInteger(raw.now) || raw.now < 0) {
    throw new Error("SessionGrants claim now must be a non-negative safe integer");
  }
  const writeCount = raw.writeCount === undefined ? 1 : raw.writeCount;
  if (typeof writeCount !== "number" || !Number.isSafeInteger(writeCount) || writeCount < 1)
    throw new Error("SessionGrants claim writeCount must be a positive safe integer");
  return { client, tool: raw.tool, folder: raw.folder, now: raw.now, writeCount };
}

function readProjectedGrantRow(raw: unknown): DecodedGrant {
  if (!isObject(raw) || !hasExactKeys(raw, SESSION_ROW_FIELDS)) {
    throw new SessionGrantIntegrityError(
      "row must contain exactly the canonical agent_session projection",
    );
  }
  return decodeGrantRow(raw);
}

function readCreatedGrantRow(raw: unknown): DecodedGrant {
  return readMutationGrantRow(raw, "grant create");
}

function readMutationGrantRow(raw: unknown, operation: string): DecodedGrant {
  if (!isObject(raw)) {
    throw new SessionGrantIntegrityError(`${operation} value must be a row object`);
  }
  const keys = Object.keys(raw);
  if (
    keys.some((key) => !SESSION_ROW_FIELDS.includes(key as (typeof SESSION_ROW_FIELDS)[number]))
  ) {
    throw new SessionGrantIntegrityError(`${operation} row contains non-canonical fields`);
  }
  for (const field of SESSION_CREATED_REQUIRED_FIELDS) {
    if (!Object.hasOwn(raw, field)) {
      throw new SessionGrantIntegrityError(`${operation} row is missing ${field}`);
    }
  }
  for (const field of ["max_writes", "revoked_at"] as const) {
    const present = Object.hasOwn(raw, field);
    if ((present && raw[field] === undefined) || (!present && raw[field] !== undefined)) {
      throw new SessionGrantIntegrityError(
        `${operation} row must omit ${field} exactly when it is NONE`,
      );
    }
  }
  return decodeGrantRow(raw);
}

function decodeGrantRow(row: Record<string, unknown>): DecodedGrant {
  const recordId = storedSessionGrantId(row.id);
  const client = storedClient(row.client);
  const grantedAt = storedNonNegativeInteger(row.granted_at, "granted_at");
  const expiresAt = storedNonNegativeInteger(row.expires_at, "expires_at");
  if (expiresAt <= grantedAt) {
    throw new SessionGrantIntegrityError("expires_at must be after granted_at");
  }
  const allowedFolders = storedStringArray(row.allowed_folders, "allowed_folders");
  for (const folder of allowedFolders) {
    try {
      assertCanonicalFolderPrefix(folder, false, "allowed_folders entry");
    } catch {
      throw new SessionGrantIntegrityError(
        "allowed_folders entries must be canonical vault-relative prefixes",
      );
    }
  }
  const allowedTools = storedStringArray(row.allowed_tools, "allowed_tools");
  for (const tool of allowedTools) {
    try {
      assertCanonicalTool(tool, true, "allowed_tools entry");
    } catch {
      throw new SessionGrantIntegrityError("allowed_tools entries must be canonical tool names");
    }
  }
  if (allowedTools.includes(ALL_SESSION_TOOLS) && allowedTools.length !== 1) {
    throw new SessionGrantIntegrityError("allowed_tools wildcard must be the sole entry");
  }
  const maxWrites = storedOptionalPositiveInteger(row.max_writes, "max_writes");
  const usedWrites = storedNonNegativeInteger(row.used_writes, "used_writes");
  if (maxWrites !== null && usedWrites > maxWrites) {
    throw new SessionGrantIntegrityError("used_writes must not exceed max_writes");
  }
  const revokedAt = storedOptionalNonNegativeInteger(row.revoked_at, "revoked_at");
  if (revokedAt !== null && revokedAt < grantedAt) {
    throw new SessionGrantIntegrityError("revoked_at must not precede granted_at");
  }
  return {
    recordId,
    grant: {
      id: recordId.toString(),
      client,
      grantedAt,
      expiresAt,
      allowedFolders,
      allowedTools,
      maxWrites,
      usedWrites,
      revokedAt,
    },
  };
}

function storedSessionGrantId(raw: unknown): RecordId<"agent_session"> {
  try {
    return parseStoredUuidRecordId(raw, "agent_session", "session grant storage id");
  } catch {
    throw new SessionGrantIntegrityError("id must be a native agent_session UUID record id");
  }
}

export function parseSessionGrantRecordId(raw: unknown): RecordId<"agent_session"> {
  return parseUuidRecordId(raw, "agent_session", "sessionId");
}

function storedStringArray(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SessionGrantIntegrityError(`${field} must be a non-empty native array`);
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0 || entry.trim() !== entry) {
      throw new SessionGrantIntegrityError(`${field} entries must be canonical strings`);
    }
    if (out.includes(entry)) {
      throw new SessionGrantIntegrityError(`${field} must not contain duplicates`);
    }
    out.push(entry);
  }
  return out;
}

function storedClient(raw: unknown): string {
  try {
    return canonicalClient(raw, "stored client");
  } catch {
    throw new SessionGrantIntegrityError("client must be a canonical agent id");
  }
}

function canonicalClient(raw: unknown, label: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${label} must be a canonical agent id`);
  }
  const normalized = normalizeAgentId(raw);
  if (normalized !== raw) {
    throw new Error(`${label} must be a canonical agent id`);
  }
  return raw;
}

function storedPositiveInteger(raw: unknown, field: string): number {
  const value = storedNonNegativeInteger(raw, field);
  if (value === 0) throw new SessionGrantIntegrityError(`${field} must be positive`);
  return value;
}

function storedNonNegativeInteger(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new SessionGrantIntegrityError(`${field} must be a non-negative safe integer`);
  }
  return raw;
}

function storedOptionalPositiveInteger(raw: unknown, field: string): number | null {
  if (raw === undefined) return null;
  if (raw === null) {
    throw new SessionGrantIntegrityError(`${field} NONE must use the SDK undefined shape`);
  }
  return storedPositiveInteger(raw, field);
}

function storedOptionalNonNegativeInteger(raw: unknown, field: string): number | null {
  if (raw === undefined) return null;
  if (raw === null) {
    throw new SessionGrantIntegrityError(`${field} NONE must use the SDK undefined shape`);
  }
  return storedNonNegativeInteger(raw, field);
}

function readCreateEnvelope(raw: unknown): { created: unknown; selected: unknown } {
  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new SessionGrantIntegrityError("grant create must return four statement results");
  }
  if (raw[0] !== undefined || raw[2] !== undefined) {
    throw new SessionGrantIntegrityError("grant BEGIN and COMMIT results must be undefined");
  }
  const created = raw[1];
  if (created !== undefined && !isObject(created)) {
    throw new SessionGrantIntegrityError("grant create guard must return a row or undefined");
  }
  const selectedRows = raw[3];
  if (!Array.isArray(selectedRows) || selectedRows.length !== 1) {
    throw new SessionGrantIntegrityError("grant create SELECT must return exactly one row");
  }
  return { created, selected: selectedRows[0] };
}

function readStatementRows(raw: unknown, operation: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new SessionGrantIntegrityError(`${operation} must return one statement result`);
  }
  return raw[0];
}

function readZeroOrOneRow(raw: unknown, operation: string): unknown | undefined {
  const rows = readStatementRows(raw, operation);
  if (rows.length > 1) {
    throw new SessionGrantIntegrityError(`${operation} must return at most one row`);
  }
  return rows[0];
}

function readExactlyOneRow(raw: unknown, operation: string): unknown {
  const row = readZeroOrOneRow(raw, operation);
  if (row === undefined) {
    throw new SessionGrantIntegrityError(`${operation} must return exactly one row`);
  }
  return row;
}

function readUniqueGrantRows(rows: unknown[], operation: string): DecodedGrant[] {
  const decoded = rows.map(readProjectedGrantRow);
  const ids = new Set<string>();
  for (const row of decoded) {
    if (ids.has(row.grant.id)) {
      throw new SessionGrantIntegrityError(`${operation} returned a duplicate record id`);
    }
    ids.add(row.grant.id);
  }
  return decoded;
}

function assertClaimCandidate(grant: SessionGrant, query: SessionGrantClaimQuery): void {
  if (grant.client !== query.client) {
    throw new SessionGrantIntegrityError("claim lookup returned a row for another client");
  }
  if (grant.revokedAt !== null || grant.expiresAt <= query.now) {
    throw new SessionGrantIntegrityError("claim lookup returned an inactive row");
  }
  if (grant.maxWrites !== null && grant.usedWrites >= grant.maxWrites) {
    throw new SessionGrantIntegrityError("claim lookup returned an exhausted row");
  }
}

function assertGrantEqual(actual: SessionGrant, expected: SessionGrant, label: string): void {
  const scalarEqual =
    actual.id === expected.id &&
    actual.client === expected.client &&
    actual.grantedAt === expected.grantedAt &&
    actual.expiresAt === expected.expiresAt &&
    actual.maxWrites === expected.maxWrites &&
    actual.usedWrites === expected.usedWrites &&
    actual.revokedAt === expected.revokedAt;
  if (
    !scalarEqual ||
    !sameStringArray(actual.allowedFolders, expected.allowedFolders) ||
    !sameStringArray(actual.allowedTools, expected.allowedTools)
  ) {
    throw new SessionGrantIntegrityError(`${label} does not match the requested mutation`);
  }
}

function assertCanonicalFolderPrefix(
  raw: unknown,
  allowRoot: boolean,
  label: string,
): asserts raw is string {
  if (typeof raw !== "string") {
    throw new Error(`${label} must be a canonical vault-relative folder prefix`);
  }
  if (allowRoot && raw === "") return;
  if (
    raw.length === 0 ||
    raw.trim() !== raw ||
    raw.startsWith("/") ||
    !raw.endsWith("/") ||
    raw.includes("\\") ||
    hasControlCharacter(raw)
  ) {
    throw new Error(`${label} must be a canonical vault-relative folder prefix ending in '/'`);
  }
  const segments = raw.slice(0, -1).split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment.trim() !== segment,
    )
  ) {
    throw new Error(`${label} must be a canonical vault-relative folder prefix ending in '/'`);
  }
}

function assertCanonicalTool(
  raw: unknown,
  allowWildcard: boolean,
  label: string,
): asserts raw is string {
  if (
    typeof raw !== "string" ||
    !((allowWildcard && raw === ALL_SESSION_TOOLS) || TOOL_NAME_PATTERN.test(raw))
  ) {
    throw new Error(`${label} must be a canonical dotted tool name`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}

function toolMatches(allowedTools: string[], tool: string): boolean {
  return allowedTools[0] === ALL_SESSION_TOOLS || allowedTools.includes(tool);
}

function folderMatches(allowedFolders: string[], folder: string): boolean {
  return allowedFolders.some((prefix) => folder.startsWith(prefix));
}

function readClock(now: () => number, operation: string): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SessionGrants ${operation} clock must be a non-negative safe integer`);
  }
  return value;
}

function assertOnlyInputFields(
  raw: unknown,
  allowedFields: readonly string[],
  label: string,
): asserts raw is Record<string, unknown> {
  if (!isObject(raw)) {
    throw new Error(`SessionGrants ${label} must be an object`);
  }
  if (Object.keys(raw).some((key) => !allowedFields.includes(key))) {
    throw new Error(`SessionGrants ${label} contains an unknown field`);
  }
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
