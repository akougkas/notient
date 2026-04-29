/**
 * SessionGrants — scoped trust grants for unattended writes (Phase D1 T7).
 *
 * A user authorizes an external client (Claude Code, Cursor, ...) to perform
 * vault writes that fit a (folders, tools, maxWrites) scope for a bounded
 * window. While the grant is active, ApprovalGate (T8 wiring) can auto-approve
 * matching writes without prompting. Expired, revoked, or exhausted grants
 * degrade gracefully to the global per-tool policy.
 *
 * Phase 4 Task 12 migrated the storage backend from SQLite to SurrealDB.
 * The wire-shape contract (`SessionGrant.id` is a numeric `seq`) is
 * preserved by stamping each row with a monotonically-assigned `seq`
 * inside a `BEGIN; ...; COMMIT;` block. The `incrementWriteCount` UPDATE
 * stays atomic at the SurrealDB level (`SET used_writes = used_writes + 1`)
 * so concurrent calls cannot lose an increment.
 *
 * Folder match: each entry in `allowed_folders` is normalized at insert time
 * so it ends with `/`. The find query uses `String#startsWith` against the
 * incoming folder argument, which gives prefix matching with no possibility
 * of `Inbox` accidentally matching `Inbox-archive/`.
 *
 * Tool match: an empty `allowed_tools` JSON array is the explicit "all writes"
 * sentinel. Otherwise the tool name must appear in the array exactly.
 */

import type { RecordId, Surreal } from "surrealdb";
import { normalizeAgentId } from "../../cli/identity";

export interface SessionGrant {
  id: number;
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

export interface SessionGrantFindQuery {
  client: string;
  tool: string;
  folder: string;
  now: number;
}

export interface SessionListFilter {
  client?: string;
  activeOnly?: boolean;
}

export interface SessionGrantsOptions {
  db: Surreal;
}

export const SESSION_GRANT_TTL_MAX_MINUTES = 24 * 60;

interface SessionGrantRow {
  id: RecordId<"agent_session">;
  seq: number;
  client: string;
  granted_at: number;
  expires_at: number;
  allowed_folders: string;
  allowed_tools: string;
  max_writes: number | null | undefined;
  used_writes: number;
  revoked_at: number | null | undefined;
}

interface SeqRow {
  seq: number;
}

const ROW_PROJECTION =
  "id, seq, client, granted_at, expires_at, allowed_folders, allowed_tools, max_writes, used_writes, revoked_at";

export class SessionGrants {
  private readonly db: Surreal;

  constructor(options: SessionGrantsOptions) {
    this.db = options.db;
  }

  async grant(options: SessionGrantOptions): Promise<SessionGrant> {
    const client = normalizeAgentId(options.client);
    const allowedFolders = normalizeAllowedFolders(options.allowedFolders);
    const allowedTools = options.allowedTools ?? [];
    validateAllowedTools(allowedTools);
    const maxWrites = validateMaxWrites(options.maxWrites);
    const ttlMinutes = clampTtlMinutes(options.ttlMinutes);

    const grantedAt = Date.now();
    const expiresAt = grantedAt + ttlMinutes * 60_000;
    // Multi-statement BEGIN/COMMIT; the post-commit SELECT reads the row
    // back so the caller sees the assigned seq without a second roundtrip.
    const setClauses: string[] = [
      "seq: ($next ?? 0) + 1",
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
      allowedFolders: JSON.stringify(allowedFolders),
      allowedTools: JSON.stringify(allowedTools),
    };
    if (maxWrites !== null) {
      setClauses.push("max_writes: $maxWrites");
      bindings.maxWrites = maxWrites;
    }
    const sql = [
      "BEGIN;",
      "LET $next = (SELECT VALUE seq FROM agent_session ORDER BY seq DESC LIMIT 1)[0];",
      `LET $row = CREATE ONLY agent_session CONTENT { ${setClauses.join(", ")} };`,
      "COMMIT;",
      `SELECT ${ROW_PROJECTION} FROM agent_session WHERE granted_at = $grantedAt AND client = $client ORDER BY seq DESC LIMIT 1;`,
    ].join("\n");
    const results = await this.db.query(sql, bindings).collect<unknown[]>();
    const lastSlice = results[results.length - 1];
    const rows = (
      Array.isArray(lastSlice) ? (lastSlice as SessionGrantRow[]) : []
    ) as SessionGrantRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("SessionGrants.grant: SurrealDB returned no row");
    }
    return rowToGrant(row);
  }

  async revoke(seq: number): Promise<SessionGrant | null> {
    const existing = await this.findBySeq(seq);
    if (existing === null) return null;
    if (existing.revokedAt !== null) return existing;
    const revokedAt = Date.now();
    await this.db
      .query("UPDATE agent_session SET revoked_at = $revokedAt WHERE seq = $seq;", {
        revokedAt,
        seq,
      })
      .collect();
    return { ...existing, revokedAt };
  }

  async list(filter: SessionListFilter): Promise<SessionGrant[]> {
    const activeOnly = filter.activeOnly !== false;
    const conditions: string[] = [];
    const bindings: Record<string, unknown> = {};
    if (filter.client !== undefined) {
      conditions.push("client = $client");
      bindings.client = filter.client;
    }
    if (activeOnly) {
      conditions.push("revoked_at = NONE");
      conditions.push("expires_at > $now");
      bindings.now = Date.now();
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const sql = `SELECT ${ROW_PROJECTION} FROM agent_session ${where} ORDER BY granted_at DESC, seq DESC;`;
    const [rows] = await this.db
      .query<[SessionGrantRow[]]>(sql, bindings)
      .collect<[SessionGrantRow[]]>();
    return rows.map(rowToGrant);
  }

  async find(query: SessionGrantFindQuery): Promise<SessionGrant | null> {
    const sql = `SELECT ${ROW_PROJECTION} FROM agent_session
       WHERE client = $client
         AND revoked_at = NONE
         AND expires_at > $now
         AND (max_writes = NONE OR used_writes < max_writes)
       ORDER BY granted_at DESC, seq DESC;`;
    const [rows] = await this.db
      .query<[SessionGrantRow[]]>(sql, { client: query.client, now: query.now })
      .collect<[SessionGrantRow[]]>();
    for (const row of rows) {
      const grant = rowToGrant(row);
      if (!toolMatches(grant.allowedTools, query.tool)) continue;
      if (!folderMatches(grant.allowedFolders, query.folder)) continue;
      return grant;
    }
    return null;
  }

  async incrementWriteCount(seq: number): Promise<void> {
    await this.db
      .query("UPDATE agent_session SET used_writes = used_writes + 1 WHERE seq = $seq;", { seq })
      .collect();
  }

  async latestSeq(): Promise<number> {
    const [rows] = await this.db
      .query<[SeqRow[]]>("SELECT seq FROM agent_session ORDER BY seq DESC LIMIT 1;")
      .collect<[SeqRow[]]>();
    return rows[0]?.seq ?? 0;
  }

  private async findBySeq(seq: number): Promise<SessionGrant | null> {
    const [rows] = await this.db
      .query<[SessionGrantRow[]]>(
        `SELECT ${ROW_PROJECTION} FROM agent_session WHERE seq = $seq LIMIT 1;`,
        { seq },
      )
      .collect<[SessionGrantRow[]]>();
    if (rows.length === 0) return null;
    return rowToGrant(rows[0]);
  }
}

function normalizeAllowedFolders(input: string[]): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("allowedFolders must be a non-empty array of vault-relative folder prefixes");
  }
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") {
      throw new Error("allowedFolders entries must be strings");
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new Error("allowedFolders entries must not be empty");
    }
    out.push(trimmed.endsWith("/") ? trimmed : `${trimmed}/`);
  }
  return out;
}

function validateAllowedTools(input: string[]): void {
  if (!Array.isArray(input)) {
    throw new Error("allowedTools must be an array of tool names");
  }
  for (const entry of input) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error("allowedTools entries must be non-empty strings");
    }
  }
}

function validateMaxWrites(raw: number | undefined): number | null {
  if (raw === undefined) return null;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new Error("maxWrites must be a positive integer when provided");
  }
  return raw;
}

function clampTtlMinutes(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error("ttlMinutes must be a positive number");
  }
  if (raw > SESSION_GRANT_TTL_MAX_MINUTES) return SESSION_GRANT_TTL_MAX_MINUTES;
  return raw;
}

function rowToGrant(row: SessionGrantRow): SessionGrant {
  return {
    id: row.seq,
    client: row.client,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    allowedFolders: parseStringArray(row.allowed_folders),
    allowedTools: parseStringArray(row.allowed_tools),
    maxWrites: row.max_writes ?? null,
    usedWrites: row.used_writes,
    revokedAt: row.revoked_at ?? null,
  };
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry === "string") out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

function toolMatches(allowedTools: string[], tool: string): boolean {
  if (allowedTools.length === 0) return true;
  return allowedTools.includes(tool);
}

function folderMatches(allowedFolders: string[], folder: string): boolean {
  for (const prefix of allowedFolders) {
    if (folder.startsWith(prefix)) return true;
  }
  return false;
}
