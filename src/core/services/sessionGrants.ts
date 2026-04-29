/**
 * SessionGrants — scoped trust grants for unattended writes (Phase D1 T7).
 *
 * A user authorizes an external client (Claude Code, Cursor, ...) to perform
 * vault writes that fit a (folders, tools, maxWrites) scope for a bounded
 * window. While the grant is active, ApprovalGate (T8 wiring) can auto-approve
 * matching writes without prompting. Expired, revoked, or exhausted grants
 * degrade gracefully to the global per-tool policy.
 *
 * T7 ships only the storage layer plus the RPC verbs. T8 wires the lookup
 * into ApprovalGate.
 *
 * Folder match: each entry in `allowed_folders` is normalized at insert time
 * so it ends with `/`. The find query uses `String#startsWith` against the
 * incoming folder argument, which gives prefix matching with no possibility
 * of `Inbox` accidentally matching `Inbox-archive/`.
 *
 * Tool match: an empty `allowed_tools` JSON array is the explicit "all writes"
 * sentinel. Otherwise the tool name must appear in the array exactly.
 *
 * Write counter: callers (ApprovalGate in T8) call `incrementWriteCount`
 * after a successful auto-approval. The UPDATE is atomic at the SQL level
 * (`SET used_writes = used_writes + 1`) so concurrent calls cannot lose an
 * increment even if SessionGrants instances are shared across handlers.
 */

import { normalizeAgentId } from "../../cli/identity";
import type { Database } from "../db/database";

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
  database: Database;
}

export const SESSION_GRANT_TTL_MAX_MINUTES = 24 * 60;

interface SessionGrantRow {
  id: number;
  client: string;
  granted_at: number;
  expires_at: number;
  allowed_folders: string;
  allowed_tools: string;
  max_writes: number | null;
  used_writes: number;
  revoked_at: number | null;
}

export class SessionGrants {
  private readonly database: Database;

  constructor(options: SessionGrantsOptions) {
    this.database = options.database;
  }

  grant(options: SessionGrantOptions): SessionGrant {
    const client = normalizeAgentId(options.client);
    const allowedFolders = normalizeAllowedFolders(options.allowedFolders);
    const allowedTools = options.allowedTools ?? [];
    validateAllowedTools(allowedTools);
    const maxWrites = validateMaxWrites(options.maxWrites);
    const ttlMinutes = clampTtlMinutes(options.ttlMinutes);

    const grantedAt = Date.now();
    const expiresAt = grantedAt + ttlMinutes * 60_000;
    this.database.run(
      `INSERT INTO agent_sessions
         (client, granted_at, expires_at, allowed_folders, allowed_tools,
          max_writes, used_writes, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL);`,
      [
        client,
        grantedAt,
        expiresAt,
        JSON.stringify(allowedFolders),
        JSON.stringify(allowedTools),
        maxWrites,
      ],
    );
    const idRow = this.database.query<{ id: number }>("SELECT last_insert_rowid() AS id;")[0];
    const id = idRow?.id ?? 0;
    return {
      id,
      client,
      grantedAt,
      expiresAt,
      allowedFolders,
      allowedTools,
      maxWrites,
      usedWrites: 0,
      revokedAt: null,
    };
  }

  revoke(id: number): SessionGrant | null {
    const existing = this.readOne(id);
    if (existing === null) return null;
    if (existing.revokedAt !== null) return existing;
    const revokedAt = Date.now();
    this.database.run("UPDATE agent_sessions SET revoked_at = ? WHERE id = ?;", [revokedAt, id]);
    return { ...existing, revokedAt };
  }

  list(filter: SessionListFilter): SessionGrant[] {
    const activeOnly = filter.activeOnly !== false;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.client !== undefined) {
      conditions.push("client = ?");
      params.push(filter.client);
    }
    if (activeOnly) {
      conditions.push("revoked_at IS NULL");
      conditions.push("expires_at > ?");
      params.push(Date.now());
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.database.query<SessionGrantRow>(
      `SELECT id, client, granted_at, expires_at, allowed_folders, allowed_tools,
              max_writes, used_writes, revoked_at
       FROM agent_sessions
       ${where}
       ORDER BY granted_at DESC;`,
      params,
    );
    return rows.map(rowToGrant);
  }

  find(query: SessionGrantFindQuery): SessionGrant | null {
    const rows = this.database.query<SessionGrantRow>(
      `SELECT id, client, granted_at, expires_at, allowed_folders, allowed_tools,
              max_writes, used_writes, revoked_at
       FROM agent_sessions
       WHERE client = ?
         AND revoked_at IS NULL
         AND expires_at > ?
         AND (max_writes IS NULL OR used_writes < max_writes)
       ORDER BY granted_at DESC;`,
      [query.client, query.now],
    );
    for (const row of rows) {
      const grant = rowToGrant(row);
      if (!toolMatches(grant.allowedTools, query.tool)) continue;
      if (!folderMatches(grant.allowedFolders, query.folder)) continue;
      return grant;
    }
    return null;
  }

  incrementWriteCount(id: number): void {
    this.database.run("UPDATE agent_sessions SET used_writes = used_writes + 1 WHERE id = ?;", [
      id,
    ]);
  }

  private readOne(id: number): SessionGrant | null {
    const rows = this.database.query<SessionGrantRow>(
      `SELECT id, client, granted_at, expires_at, allowed_folders, allowed_tools,
              max_writes, used_writes, revoked_at
       FROM agent_sessions
       WHERE id = ?
       LIMIT 1;`,
      [id],
    );
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
    id: row.id,
    client: row.client,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    allowedFolders: parseStringArray(row.allowed_folders),
    allowedTools: parseStringArray(row.allowed_tools),
    maxWrites: row.max_writes,
    usedWrites: row.used_writes,
    revokedAt: row.revoked_at,
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
