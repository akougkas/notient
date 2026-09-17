/**
 * SurrealDB-backed mutation journal and guarded undo service.
 *
 * Snapshots are stored as native values inside SurrealDB flexible-object
 * envelopes. Undo retains the original mutation and a durable completion
 * receipt. A lost response can be recovered without replaying the inverter.
 */

import { DateTime, RecordId, type Surreal } from "surrealdb";
import { z } from "zod";
import { type VaultAdapter, VaultMutationBlockedError } from "../../adapters/vaultAdapter";
import {
  type HistoryCaller,
  type HistoryEntry,
  historyDetailSchema,
  historyEntrySchema,
  historyListSchema,
  historyUndoResultSchema,
} from "../../api/history";
import { NoteReadService, contentRevision } from "../../api/notes";
import { operationInputs } from "../../api/operations";
import { NoteApiError } from "../../api/schema";
import { WRITEBACK_EDGE_TABLES } from "../db/edgeTables";
import { unwrapNativeValue, wrapNativeValue } from "../db/nativeValue";
import {
  createUuidRecordId,
  parseStoredUuidRecordId,
  parseSurrealRelationRecordId,
  parseUuidRecordId,
  stringifyUuidRecordId,
} from "../db/recordId";
import { withSurrealRetry } from "../db/retry";
import { isCanonicalPublicNotePath } from "../vault/publicPath";
import { HistoryOperationError } from "./errors";
import { bindMutationRequest } from "./mutationRequest";
import {
  HISTORY_KINDS,
  type HistoryKind,
  type HistoryRetention,
  type HistoryRow,
  type InverterRegistry,
  type RecordHistoryInput,
  type UndoResult,
} from "./types";

export interface HistoryServiceOptions {
  db: Surreal;
  inverters: InverterRegistry;
  retention: HistoryRetention;
  now?: () => number;
  vault?: Pick<VaultAdapter, "read" | "readBounded">;
  authorizeCaller?: (caller: HistoryCaller) => void | Promise<void>;
}

const HISTORY_ROW_PROJECTION =
  "id, kind, target, before, after, created_at, client_identity, proposal_edge, proposal_created_at, undo_started_at, undone_at, undo_client_identity";

export class HistoryService {
  private readonly db: Surreal;
  private readonly inverters: InverterRegistry;
  private readonly retention: HistoryRetention;
  private readonly now: () => number;
  private undoTail: Promise<unknown> = Promise.resolve();
  private readonly options: HistoryServiceOptions;

  constructor(options: HistoryServiceOptions) {
    this.options = options;
    assertPositiveSafeInteger(options.retention.max, "history retention max");
    assertPositiveSafeInteger(options.retention.maxPerTarget, "history retention maxPerTarget");
    this.db = options.db;
    this.inverters = options.inverters;
    this.retention = options.retention;
    this.now = options.now ?? (() => Date.now());
  }

  async record(input: RecordHistoryInput): Promise<string> {
    const kind = parseHistoryKind(input.kind);
    const target = parseNonBlankString(input.target, "history target");
    if (input.before === undefined || input.after === undefined) {
      throw new Error("history snapshots must use null, not undefined, for an absent value");
    }
    const clientIdentity =
      input.clientIdentity === undefined
        ? "human"
        : parseNonBlankString(input.clientIdentity, "history client identity");
    // The schema stamps `created_at` via DEFAULT time::now(); we pass an
    // explicit value so tests with an injected `now` see a deterministic
    // timestamp on the row. Production calls inject `Date.now()`.
    const now = this.now();
    assertNonNegativeSafeInteger(now, "history clock");
    const createdAtIso = new Date(now).toISOString();
    // Optional fields stay NONE when their corresponding snapshot is null.
    const setClauses: string[] = [
      "kind: $kind",
      "target: $target",
      "client_identity: $clientIdentity",
      "created_at: <datetime>$createdAt",
    ];
    const bindings: Record<string, unknown> = {
      kind,
      target,
      clientIdentity,
      createdAt: createdAtIso,
    };
    if (input.before !== null) {
      setClauses.push("before: $before");
      bindings.before = wrapNativeValue(input.before);
    }
    if (input.after !== null) {
      setClauses.push("after: $after");
      bindings.after = wrapNativeValue(input.after);
    }
    // The idempotency key is also the record id. Replaying an operation whose
    // first CREATE committed skips the write and selects that exact row.
    const sql = [
      "BEGIN;",
      "IF !record::exists($rowId) {",
      `  CREATE ONLY $rowId CONTENT { ${setClauses.join(", ")} };`,
      "};",
      "COMMIT;",
      "SELECT id FROM $rowId;",
    ].join("\n");
    const results: unknown = await withSurrealRetry(
      ({ idempotencyKey }) =>
        this.db
          .query(sql, {
            ...bindings,
            rowId: createUuidRecordId("history", idempotencyKey),
          })
          .collect(),
      { idempotencyKey: Bun.randomUUIDv7() },
    );
    const rows = readFinalStatementRows(results, "record");
    if (rows.length !== 1) {
      throw new Error(`history storage integrity: record returned ${rows.length} rows`);
    }
    return storedHistoryId(parseHistoryIdRow(rows[0], "record"));
  }

  /** Bounded metadata pages never return full note snapshots in a listing. */
  async list(input: unknown, caller: HistoryCaller) {
    await this.authorize(caller);
    const parsed = operationInputs["history.list"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const args = parsed.data;
    const filter = { path: args.path ?? null, owner: caller.kind === "human" ? null : caller.id };
    const [rows] = await this.db
      .query<[Array<Record<string, unknown>>]>(
        `SELECT id, kind, target, created_at, client_identity, undo_started_at, undone_at, undo_client_identity
       FROM history WHERE ($path = NONE OR target = $path OR (kind = 'notes.move' AND after.data.path = $path)) AND ($owner = NONE OR client_identity = $owner)
       ORDER BY created_at DESC, id DESC LIMIT 10001 TIMEOUT 5s;`,
        { path: filter.path ?? undefined, owner: filter.owner ?? undefined },
      )
      .collect();
    if (rows.length > 10000)
      throw new NoteApiError(
        "LIMIT_EXCEEDED",
        "history exceeds 10000 entries; filter by note path",
      );
    const entries = rows.map((row) => this.entry(mapRow(row)));
    const snapshot = contentRevision(JSON.stringify([filter, entries]));
    let offset = 0;
    if (args.cursor) {
      let cursor: { snapshot: string; offset: number };
      try {
        cursor = z
          .strictObject({ snapshot: z.string(), offset: z.number().int().min(0) })
          .parse(JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")));
      } catch {
        throw new NoteApiError("INVALID_PARAMS", "invalid history cursor");
      }
      if (cursor.snapshot !== snapshot)
        throw new NoteApiError("CONFLICT", "history changed; reload its first page");
      if (cursor.offset > entries.length)
        throw new NoteApiError("INVALID_PARAMS", "history cursor exceeds the inventory");
      offset = cursor.offset;
    }
    const page = entries.slice(offset, offset + args.limit);
    const next = offset + page.length;
    return historyListSchema.parse({
      ok: true,
      entries: page,
      snapshot,
      nextCursor:
        next < entries.length
          ? Buffer.from(JSON.stringify({ snapshot, offset: next })).toString("base64url")
          : null,
    });
  }

  async detail(input: unknown, caller: HistoryCaller) {
    await this.authorize(caller);
    const parsed = operationInputs["history.get"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const row = await this.visibleRow(parsed.data.id, caller);
    const move = row.kind === "notes.move" && isRecord(row.after) ? row.after : null;
    const before = typeof row.before === "string" ? row.before : null;
    const after =
      typeof row.after === "string" ? row.after : typeof move?.body === "string" ? move.body : null;
    const destination = typeof move?.path === "string" ? move.path : null;
    if (Buffer.byteLength(before ?? "") + Buffer.byteLength(after ?? "") > 2 * 1024 * 1024)
      throw new NoteApiError("LIMIT_EXCEEDED", "history snapshots exceed the 2 MiB review limit");
    return historyDetailSchema.parse({
      ok: true,
      entry: this.entry(row),
      before,
      after,
      destination,
      sources:
        after !== null && isCanonicalPublicNotePath(destination ?? row.target)
          ? [{ path: destination ?? row.target, revision: contentRevision(after) }]
          : [],
    });
  }

  async undoRequest(input: unknown, caller: HistoryCaller, signal?: AbortSignal) {
    await this.authorize(caller, true);
    const parsed = operationInputs["history.undo"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const args = parsed.data;
    const detail = await this.detail({ id: args.id }, caller);
    if (!detail.entry.reversible || !detail.sources.length)
      throw new NoteApiError("FORBIDDEN", "this audit entry has no reversible note effect");
    if (JSON.stringify(args.sources) !== JSON.stringify(detail.sources))
      throw new NoteApiError("CONFLICT", "undo must name the exact recorded after revision");
    await bindMutationRequest(this.db, "history.undo", caller, args.idempotencyKey, args);
    const authorize = async () => {
      signal?.throwIfAborted();
      await this.authorize(caller, true);
      // Interrupted operations may already have reached their before image.
      // The inverter recognizes it; a completed receipt never runs it again.
      const current = await this.visibleRow(args.id, caller);
      if (current.undo === null) {
        if (!this.options.vault) throw new Error("history vault authority is unavailable");
        await new NoteReadService(this.options.vault).read(detail.sources[0]);
      }
    };
    const result = await this.undo(args.id, { clientIdentity: caller.id, authorize }).catch(
      (error) => {
        if (error instanceof VaultMutationBlockedError)
          throw new NoteApiError("CONFLICT", error.message);
        throw error;
      },
    );
    if (!result.ok)
      throw new NoteApiError(
        result.code === "HISTORY_NOT_FOUND" ? "NOT_FOUND" : "CONFLICT",
        result.message,
      );
    return historyUndoResultSchema.parse({ ok: true, entry: this.entry(result.reversed) });
  }

  private entry(row: HistoryRow): HistoryEntry {
    return historyEntrySchema.parse({
      id: row.id,
      kind: row.kind,
      target: row.target,
      createdAt: row.createdAt,
      clientIdentity: row.clientIdentity,
      undo: row.undo,
      reversible: Boolean(this.inverters[row.kind]) && isCanonicalPublicNotePath(row.target),
    });
  }
  private async visibleRow(id: string, caller: HistoryCaller): Promise<HistoryRow> {
    const row = await this.get(id);
    if (!row || (caller.kind !== "human" && row.clientIdentity !== caller.id))
      throw new NoteApiError("NOT_FOUND", "history entry is unavailable");
    return row;
  }
  private async authorize(caller: HistoryCaller, write = false): Promise<void> {
    if (
      !caller.scopes.includes("read") ||
      (write && (caller.kind !== "human" || !caller.scopes.includes("admin")))
    )
      throw new NoteApiError(
        "FORBIDDEN",
        write ? "undo requires human administration authority" : "history requires read authority",
      );
    if (this.options.authorizeCaller) await this.options.authorizeCaller(caller);
    else if (caller.id.startsWith("paired-"))
      throw new NoteApiError("FORBIDDEN", "paired history caller cannot be validated");
  }

  async getRecent(limit = 50, clientIdentity?: string): Promise<HistoryRow[]> {
    assertPositiveSafeInteger(limit, "history recent limit");
    const owner =
      clientIdentity === undefined
        ? undefined
        : parseNonBlankString(clientIdentity, "history client identity");
    // SurrealDB 3.x requires every ORDER BY field to appear in the
    // projection. `id` is the lexicographic tiebreaker for rows that
    // share a `created_at` (rapid-succession inserts in tests with an
    // injected static clock).
    const sql = `SELECT ${HISTORY_ROW_PROJECTION} FROM history${owner === undefined ? "" : " WHERE client_identity = $clientIdentity"} ORDER BY created_at DESC, id DESC LIMIT $limit;`;
    const bindings = owner === undefined ? { limit } : { limit, clientIdentity: owner };
    const result: unknown = await this.db.query(sql, bindings).collect();
    const rows = readSingleStatementRows(result, "recent history");
    return rows.map((row) => mapRow(row));
  }

  async undo(
    historyId?: string,
    options: { clientIdentity?: string; authorize?: () => Promise<void> } = {},
  ): Promise<UndoResult> {
    const run = this.undoTail.then(() => this.undoSelected(historyId, options));
    this.undoTail = run.catch(() => {});
    return run;
  }

  private async undoSelected(
    historyId: string | undefined,
    options: { clientIdentity?: string; authorize?: () => Promise<void> },
  ): Promise<UndoResult> {
    const authorize = options.authorize ?? (async () => {});
    await authorize();
    const row =
      historyId === undefined ? await this.getLatestReversible() : await this.get(historyId);
    if (row === null) {
      return historyId === undefined
        ? { ok: false, code: "HISTORY_EMPTY", message: "no reversible history" }
        : {
            ok: false,
            code: "HISTORY_NOT_FOUND",
            message: "history row not found",
          };
    }
    if (row.undo?.completedAt !== null && row.undo?.completedAt !== undefined)
      return { ok: true, reversed: row };
    const inverter = this.inverters[row.kind];
    if (!inverter) {
      return {
        ok: false,
        code: "HISTORY_NOT_REVERSIBLE",
        message: `history row ${row.id} is not reversible`,
      };
    }
    try {
      const recordId = parseHistoryRecordId(row.id);
      const clientIdentity = parseNonBlankString(
        options.clientIdentity ?? "human",
        "undo client identity",
      );
      await this.db
        .query(
          "UPDATE $id SET undo_started_at = time::now(), undo_client_identity = $actor WHERE undo_started_at = NONE;",
          { id: recordId, actor: clientIdentity },
        )
        .collect();
      const started = await this.get(row.id);
      if (!started?.undo) throw new Error("undo intent could not be persisted");
      if (started.undo.completedAt !== null) return { ok: true, reversed: started };
      await authorize();
      await inverter(row, { authorize });
      await this.db
        .query("UPDATE $id SET undone_at = time::now() WHERE undone_at = NONE;", { id: recordId })
        .collect();
      const completed = await this.get(row.id);
      if (completed?.undo?.completedAt == null)
        throw new Error("undo completion receipt is unavailable");
      return { ok: true, reversed: completed };
    } catch (error) {
      if (!(error instanceof HistoryOperationError)) throw error;
      return { ok: false, code: error.code, message: error.message };
    }
  }

  private async getLatestReversible(): Promise<HistoryRow | null> {
    const kinds = Object.keys(this.inverters);
    if (kinds.length === 0) return null;
    const result: unknown = await this.db
      .query(
        `SELECT ${HISTORY_ROW_PROJECTION} FROM history WHERE kind IN $kinds AND undone_at = NONE ORDER BY created_at DESC, id DESC LIMIT 1;`,
        { kinds },
      )
      .collect();
    const rows = readSingleStatementRows(result, "latest reversible history");
    assertAtMostOneRow(rows, "latest reversible history");
    const row = rows[0];
    return row === undefined ? null : mapRow(row);
  }

  async get(historyId: string): Promise<HistoryRow | null> {
    const recordId = parseHistoryRecordId(historyId);
    const result: unknown = await this.db
      .query(`SELECT ${HISTORY_ROW_PROJECTION} FROM history WHERE id = $id;`, {
        id: recordId,
      })
      .collect();
    const rows = readSingleStatementRows(result, "history by id");
    assertAtMostOneRow(rows, "history by id");
    const row = rows[0];
    return row === undefined ? null : mapRow(row);
  }

  /**
   * Prune rows so the table holds at most `retention.max` rows globally
   * and at most `retention.maxPerTarget` rows per target. Newest rows
   * (by `created_at` DESC) are retained.
   */
  async prune(): Promise<void> {
    await this.deleteBeyondGlobalRetention(this.retention.max);
    await this.deleteBeyondPerTargetRetention(this.retention.maxPerTarget);
  }

  private async deleteBeyondGlobalRetention(keep: number): Promise<void> {
    // SurrealDB 3.x has no LIMIT/OFFSET on DELETE; select the ids of the
    // rows to drop and delete them one at a time.
    const result: unknown = await this.db
      .query(
        "SELECT id, created_at, undone_at, (IF undone_at = NONE { created_at } ELSE { undone_at }) AS retained_at FROM history WHERE undo_started_at = NONE OR undone_at != NONE ORDER BY retained_at DESC, id DESC START $start;",
        {
          start: keep,
        },
      )
      .collect();
    const rows = readSingleStatementRows(result, "global history retention");
    await this.deleteRowsById(rows);
  }

  private async deleteBeyondPerTargetRetention(keep: number): Promise<void> {
    const targets = await this.distinctTargets();
    for (const target of targets) {
      const result: unknown = await this.db
        .query(
          "SELECT id, created_at, undone_at, (IF undone_at = NONE { created_at } ELSE { undone_at }) AS retained_at FROM history WHERE target = $target AND (undo_started_at = NONE OR undone_at != NONE) ORDER BY retained_at DESC, id DESC START $start;",
          { target, start: keep },
        )
        .collect();
      const rows = readSingleStatementRows(result, `history retention for ${target}`);
      await this.deleteRowsById(rows);
    }
  }

  private async distinctTargets(): Promise<string[]> {
    const result: unknown = await this.db
      .query("SELECT VALUE target FROM history GROUP BY target;")
      .collect();
    const response = readSingleStatementRows(result, "distinct history targets");
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const entry of response) {
      const value = parseNonBlankString(entry, "history target from storage");
      if (seen.has(value)) {
        throw new Error("history storage integrity: distinct target query returned a duplicate");
      }
      seen.add(value);
      targets.push(value);
    }
    return targets;
  }

  private async deleteRowsById(rows: unknown[]): Promise<void> {
    for (const row of rows) {
      const parsed = parsePruneRow(row);
      await this.db
        .query(
          "DELETE $id WHERE (undo_started_at = NONE OR undone_at != NONE) AND undone_at = $undoneAt;",
          { id: parsed.id, undoneAt: parsed.undone_at },
        )
        .collect();
    }
  }
}

interface PruneRow {
  id: RecordId<"history">;
  created_at: DateTime;
  undone_at?: DateTime;
}

function mapRow(raw: unknown): HistoryRow {
  if (!isRecord(raw)) {
    throw new Error("history storage integrity: row is not an object");
  }
  const id = storedHistoryId(raw.id);
  const kind = parseHistoryKind(raw.kind);
  const target = parseNonBlankString(raw.target, `history ${id} target`);
  const clientIdentity = parseNonBlankString(raw.client_identity, `history ${id} client identity`);
  const createdAt = parseStoredDateTime(raw.created_at, `history ${id} created_at`);
  const proposal = parseProposalRevision(raw, id);
  return {
    id,
    kind,
    target,
    before: unwrapStoredSnapshot(raw.before, `history ${id} before`),
    after: unwrapStoredSnapshot(raw.after, `history ${id} after`),
    createdAt,
    clientIdentity,
    proposalEdge: proposal.edge,
    proposalCreatedAt: proposal.createdAt,
    undo: readUndo(raw, id),
  };
}

function readUndo(raw: Record<string, unknown>, id: string): HistoryRow["undo"] {
  if (
    raw.undo_started_at === undefined &&
    raw.undone_at === undefined &&
    raw.undo_client_identity === undefined
  )
    return null;
  return {
    startedAt: parseStoredDateTime(raw.undo_started_at, `history ${id} undo_started_at`),
    completedAt:
      raw.undone_at === undefined
        ? null
        : parseStoredDateTime(raw.undone_at, `history ${id} undone_at`),
    clientIdentity: parseNonBlankString(
      raw.undo_client_identity,
      `history ${id} undo client identity`,
    ),
  };
}

function parseProposalRevision(
  raw: Record<string, unknown>,
  historyId: string,
): { edge: string | null; createdAt: string | null } {
  const edgeMissing = raw.proposal_edge === undefined;
  const createdAtMissing = raw.proposal_created_at === undefined;
  if (edgeMissing && createdAtMissing) return { edge: null, createdAt: null };
  if (edgeMissing || createdAtMissing || !(raw.proposal_edge instanceof RecordId)) {
    throw new Error(
      `history ${historyId} proposal revision must contain a native edge and datetime`,
    );
  }
  const edge = parseSurrealRelationRecordId(
    raw.proposal_edge.toString(),
    WRITEBACK_EDGE_TABLES,
    `history ${historyId} proposal edge`,
  ).id;
  return {
    edge,
    createdAt: parseStoredDateTimeString(
      raw.proposal_created_at,
      `history ${historyId} proposal_created_at`,
    ),
  };
}

function parsePruneRow(raw: unknown): PruneRow {
  if (!isRecord(raw)) {
    throw new Error("history storage integrity: retention row is not an object");
  }
  const id = parseStoredUuidRecordId(raw.id, "history", "history retention id");
  parseStoredDateTime(raw.created_at, `history ${id.toString()} retention created_at`);
  if (raw.undone_at !== undefined)
    parseStoredDateTime(raw.undone_at, `history ${id.toString()} undone_at`);
  return {
    id,
    created_at: raw.created_at as DateTime,
    undone_at: raw.undone_at as DateTime | undefined,
  };
}

function parseHistoryIdRow(raw: unknown, label: string): RecordId<"history"> {
  if (!isRecord(raw)) {
    throw new Error(`history storage integrity: ${label} row is not an object`);
  }
  return parseStoredUuidRecordId(raw.id, "history", `${label} history id`);
}

function parseHistoryKind(raw: unknown): HistoryKind {
  if (typeof raw !== "string" || !HISTORY_KINDS.includes(raw as HistoryKind)) {
    throw new Error("history storage integrity: kind is not supported");
  }
  return raw as HistoryKind;
}

function unwrapStoredSnapshot(raw: unknown, label: string): unknown | null {
  if (raw === undefined) return null;
  if (raw === null) {
    throw new Error(`${label}: null is not the canonical NONE representation`);
  }
  return unwrapNativeValue(raw, label);
}

function parseStoredDateTime(raw: unknown, label: string): number {
  if (!(raw instanceof DateTime)) {
    throw new Error(`${label} must be a native SurrealDB datetime`);
  }
  const milliseconds = raw.toDate().getTime();
  assertNonNegativeSafeInteger(milliseconds, label);
  return milliseconds;
}

function parseStoredDateTimeString(raw: unknown, label: string): string {
  if (!(raw instanceof DateTime)) {
    throw new Error(`${label} must be a native SurrealDB datetime`);
  }
  const milliseconds = raw.toDate().getTime();
  assertNonNegativeSafeInteger(milliseconds, label);
  return raw.toString();
}

function readSingleStatementRows(raw: unknown, operation: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(
      `history storage integrity: ${operation} returned an invalid statement envelope`,
    );
  }
  return raw[0];
}

function readFinalStatementRows(raw: unknown, operation: string): unknown[] {
  if (!Array.isArray(raw) || raw.length === 0 || !Array.isArray(raw[raw.length - 1])) {
    throw new Error(
      `history storage integrity: ${operation} returned an invalid statement envelope`,
    );
  }
  return raw[raw.length - 1] as unknown[];
}

function assertAtMostOneRow(rows: unknown[], operation: string): void {
  if (rows.length > 1) {
    throw new Error(`history storage integrity: ${operation} returned ${rows.length} rows`);
  }
}

function assertPositiveSafeInteger(raw: unknown, label: string): asserts raw is number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(raw: unknown, label: string): asserts raw is number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function parseNonBlankString(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.trim() !== raw) {
    throw new Error(`${label} must be a non-blank string`);
  }
  return raw;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function storedHistoryId(raw: unknown): string {
  try {
    return stringifyUuidRecordId(raw, "history", "history storage id");
  } catch {
    throw new Error(
      "history storage integrity failure: id must be a native history UUID record id",
    );
  }
}

export function parseHistoryRecordId(raw: unknown): RecordId<"history"> {
  return parseUuidRecordId(raw, "history", "historyId");
}
