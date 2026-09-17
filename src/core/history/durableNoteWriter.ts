/**
 * Recoverable ordinary-note mutation boundary.
 *
 * SurrealDB and a vault rename cannot commit atomically. Every operation
 * therefore stores its exact before/after bytes and deterministic history id
 * in `note_write_intent` before touching the filesystem. The terminal DB
 * transaction creates the history receipt and deletes that intent together.
 */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DateTime, type RecordId, type Surreal } from "surrealdb";
import { type VaultAdapter, VaultMutationBlockedError } from "../../adapters/vaultAdapter";
import { type ToolApproval, assertToolTarget, toolApprovalSchema } from "../chat/toolAuthority";
import { unwrapNativeValue, wrapNativeValue } from "../db/nativeValue";
import { readSingleStatementRows } from "../db/queryResult";
import { createUuidRecordId, parseStoredUuidRecordId, stringifyUuidRecordId } from "../db/recordId";
import { withSurrealRetry } from "../db/retry";
import { isCanonicalPublicNotePath } from "../vault/publicPath";
import { EffectAuthorityRevoked } from "./effectAuthority";
import type { HistoryKind } from "./types";

const WRITE_KINDS = [
  "notes.move",
  "notes.create",
  "notes.append",
  "notes.replace_section",
  "notes.update_frontmatter",
] as const satisfies readonly HistoryKind[];

export type DurableNoteWriteKind = (typeof WRITE_KINDS)[number];

export interface DurableNoteWriteInput {
  kind: DurableNoteWriteKind;
  target: string;
  destination?: string;
  before: string | null;
  after: string;
  clientIdentity: string;
  /** Stable effect key supplied by the durable change/job authority. */
  idempotencyKey?: string;
  /** Stored preview authority to recheck when an interrupted effect resumes. */
  previewId?: string;
  toolApproval?: ToolApproval;
  /** Recheck current caller/policy/editor authority immediately before effects. */
  authorize?: () => Promise<void>;
}

export type DurableNoteWriteResult =
  | { applied: true; historyId: string }
  | { applied: false; reason: "conflict" };

export interface NoteWriteReconcileResult {
  replayed: number;
  abandoned: number;
  failed: number;
  deferred: number;
}

export interface DurableNoteWriterOptions {
  db: Surreal;
  vault: Pick<
    VaultAdapter,
    "read" | "exists" | "createIfAbsent" | "writeIfUnchanged" | "moveIfUnchanged"
  >;
  hash: (content: string) => Promise<string>;
  /** Retention maintenance runs only after a verified terminal receipt. */
  pruneHistory?: () => Promise<void>;
  onMaintenanceError?: (error: unknown) => void;
  authorizeRecovery?: (
    intent: Pick<
      DurableNoteWriteInput,
      | "previewId"
      | "toolApproval"
      | "clientIdentity"
      | "target"
      | "destination"
      | "before"
      | "after"
    >,
  ) => Promise<void>;
  now?: () => number;
}

interface NoteWriteIntent {
  id: RecordId<"note_write_intent">;
  kind: DurableNoteWriteKind;
  target: string;
  destination?: string;
  before: string | null;
  after: string;
  beforeSha: string;
  afterSha: string;
  historyId: RecordId<"history">;
  clientIdentity: string;
  previewId?: string;
  toolApproval?: ToolApproval;
  preparedAt: DateTime;
  writeStartedAt: DateTime | null;
  abandonedAt: DateTime | null;
}

const INTENT_PROJECTION =
  "id, kind, target, destination, before_exists, before_body, after_body, before_sha, after_sha, history_id, client_identity, preview_id, tool_approval, prepared_at, write_started_at, abandoned_at";

const RECEIPT_PROJECTION = "id, kind, target, before, after, client_identity";
class RejectedWriteIntent extends Error {}

export class DurableNoteWriter {
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private reconciliationFailure: Error | null = null;

  constructor(private readonly options: DurableNoteWriterOptions) {
    this.now = options.now ?? Date.now;
  }

  async apply(input: DurableNoteWriteInput): Promise<DurableNoteWriteResult> {
    if (this.reconciliationFailure !== null) {
      throw new Error(
        `note write mutation admission is closed after unsuccessful reconciliation: ${this.reconciliationFailure.message}`,
        { cause: this.reconciliationFailure },
      );
    }
    const draft = await this.prepareDraft(input);
    return await this.withTargetTurn(draft.target, async () => {
      if (input.idempotencyKey !== undefined) {
        const receipt = await this.readReceipt(draft);
        if (receipt !== null) return { applied: true, historyId: receipt };
      }
      const existing = input.idempotencyKey === undefined ? null : await this.readIntent(draft.id);
      if (
        existing !== null &&
        (existing.target !== draft.target ||
          existing.destination !== draft.destination ||
          existing.kind !== draft.kind ||
          existing.beforeSha !== draft.beforeSha ||
          existing.afterSha !== draft.afterSha ||
          existing.clientIdentity !== draft.clientIdentity ||
          JSON.stringify(existing.toolApproval) !== JSON.stringify(draft.toolApproval))
      ) {
        throw new Error("note write idempotency key was reused with different input");
      }
      await this.authorizeIntent(existing, input.authorize);
      const intent = existing ?? (await this.persistIntent(draft));
      const started = await this.markWriteStarted(intent);
      const authorize = () => this.authorizeIntent(started, input.authorize);
      await authorize();
      if (
        existing?.writeStartedAt !== null &&
        existing !== null &&
        (await this.transitionAlreadyApplied(started))
      ) {
        await this.finalize(started);
        return { applied: true, historyId: started.historyId.toString() };
      }
      const applied = await this.applyFilesystemTransition(started, authorize);
      if (!applied) {
        await this.abandonAndDelete(started);
        return { applied: false, reason: "conflict" };
      }
      await this.finalize(started);
      return { applied: true, historyId: started.historyId.toString() };
    });
  }

  private async authorizeIntent(
    intent: NoteWriteIntent | null,
    authorize?: () => Promise<void>,
  ): Promise<void> {
    try {
      await authorize?.();
    } catch (error) {
      // A refused effect must not become authorized merely by restarting. If a
      // previous attempt already landed, retain its receipt instead of replaying.
      if (intent) {
        if (intent.writeStartedAt !== null && (await this.transitionAlreadyApplied(intent)))
          await this.finalize(intent);
        else await this.abandonAndDelete(intent);
      }
      throw error;
    }
  }

  /** Reconcile every durable intent at startup; third values are terminally abandoned. */
  async reconcilePendingWrites(): Promise<NoteWriteReconcileResult> {
    let intents: NoteWriteIntent[];
    try {
      intents = await this.readAllIntents();
    } catch (error) {
      this.closeMutationAdmission(error);
      throw error;
    }
    let replayed = 0;
    let abandoned = 0;
    let failed = 0;
    let deferred = 0;
    for (const intent of intents) {
      try {
        const outcome = await this.withTargetTurn(intent.target, () =>
          this.reconcileIntent(intent),
        );
        if (outcome === "replayed") replayed += 1;
        else abandoned += 1;
      } catch (error) {
        if (error instanceof VaultMutationBlockedError) {
          deferred += 1;
          continue;
        }
        if (error instanceof RejectedWriteIntent) {
          abandoned += 1;
          continue;
        }
        failed += 1;
        this.closeMutationAdmission(error);
      }
    }
    return { replayed, abandoned, failed, deferred };
  }

  private closeMutationAdmission(error: unknown): void {
    if (this.reconciliationFailure !== null) return;
    this.reconciliationFailure = error instanceof Error ? error : new Error(String(error));
  }

  private async prepareDraft(input: DurableNoteWriteInput): Promise<NoteWriteIntent> {
    assertWriteInput(input);
    if (input.toolApproval)
      assertToolTarget(input.toolApproval, input.clientIdentity, { path: input.target });
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("note write clock must be a non-negative safe integer");
    }
    const beforeBody = input.before ?? "";
    const [beforeSha, afterSha] = await Promise.all([
      this.options.hash(beforeBody),
      this.options.hash(input.after),
    ]);
    assertSha256(beforeSha, "note write before hash");
    assertSha256(afterSha, "note write after hash");
    return {
      id:
        input.idempotencyKey === undefined
          ? createUuidRecordId("note_write_intent")
          : stableWriteId("note_write_intent", input.clientIdentity, input.idempotencyKey),
      kind: input.kind,
      target: input.target,
      ...(input.destination === undefined ? {} : { destination: input.destination }),
      before: input.before,
      after: input.after,
      beforeSha,
      afterSha,
      historyId:
        input.idempotencyKey === undefined
          ? createUuidRecordId("history")
          : stableWriteId("history", input.clientIdentity, input.idempotencyKey),
      clientIdentity: input.clientIdentity,
      previewId: input.previewId,
      toolApproval:
        input.toolApproval === undefined ? undefined : toolApprovalSchema.parse(input.toolApproval),
      preparedAt: new DateTime(new Date(now)),
      writeStartedAt: null,
      abandonedAt: null,
    };
  }

  private async persistIntent(draft: NoteWriteIntent): Promise<NoteWriteIntent> {
    const sql = `/* note-write:prepare */
BEGIN;
IF !record::exists($intentId) AND !record::exists($historyId) {
  CREATE ONLY $intentId CONTENT {
    kind: $kind,
    target: $target,
    destination: $destination,
    before_exists: $beforeExists,
    before_body: $beforeBody,
    after_body: $afterBody,
    before_sha: $beforeSha,
    after_sha: $afterSha,
    history_id: $historyId,
    client_identity: $clientIdentity,
    preview_id: $previewId,
    tool_approval: $toolApproval,
    prepared_at: $preparedAt
  } RETURN NONE;
};
COMMIT;`;
    await withSurrealRetry(() => this.options.db.query(sql, intentBindings(draft)).collect(), {
      idempotencyKey: recordUuidKey(draft.id),
    });
    const stored = await this.readIntent(draft.id);
    if (stored === null) throw new Error("note write storage integrity: intent was not persisted");
    assertSameIntent(stored, draft);
    return stored;
  }

  private async markWriteStarted(intent: NoteWriteIntent): Promise<NoteWriteIntent> {
    if (intent.writeStartedAt !== null) return intent;
    if (intent.abandonedAt !== null) {
      throw new Error("note write storage integrity: abandoned intent cannot start a write");
    }
    await withSurrealRetry(
      () =>
        this.options.db
          .query(
            `/* note-write:start */
UPDATE ONLY $intentId SET write_started_at = time::now()
WHERE history_id = $historyId AND before_sha = $beforeSha AND after_sha = $afterSha
  AND write_started_at IS NONE AND abandoned_at IS NONE RETURN NONE;`,
            intentBindings(intent),
          )
          .collect(),
      { idempotencyKey: recordUuidKey(intent.id) },
    );
    const stored = await this.readIntent(intent.id);
    if (stored === null)
      throw new Error("note write storage integrity: intent vanished before write");
    assertSameIntent(stored, intent);
    if (stored.writeStartedAt === null) {
      throw new Error("note write storage integrity: write-start stamp did not persist");
    }
    return stored;
  }

  private async transitionAlreadyApplied(intent: NoteWriteIntent): Promise<boolean> {
    if (intent.destination !== undefined) {
      return (
        (await this.readVaultBodyOrMissing(intent.target)) === null &&
        (await this.readVaultBodyOrMissing(intent.destination)) === intent.after
      );
    }
    return (await this.readVaultBodyOrMissing(intent.target)) === intent.after;
  }

  private async applyFilesystemTransition(
    intent: NoteWriteIntent,
    authorize?: () => Promise<void>,
  ): Promise<boolean> {
    if (intent.destination !== undefined) {
      if (!this.options.vault.moveIfUnchanged || intent.before === null)
        throw new Error("durable move requires guarded vault move support");
      return this.options.vault.moveIfUnchanged(
        intent.target,
        intent.destination,
        intent.before,
        authorize,
      );
    }
    return intent.before === null
      ? await this.options.vault.createIfAbsent(intent.target, intent.after, authorize)
      : await this.options.vault.writeIfUnchanged(
          intent.target,
          intent.before,
          intent.after,
          authorize,
        );
  }

  private async reconcileIntent(original: NoteWriteIntent): Promise<"replayed" | "abandoned"> {
    const intent = await this.readIntent(original.id);
    if (intent === null) {
      if ((await this.readReceipt(original)) === null) {
        throw new Error("note write storage integrity: intent vanished without its receipt");
      }
      return "replayed";
    }
    assertSameIntent(intent, original);
    await this.validateIntentHashes(intent);

    if (intent.abandonedAt !== null) {
      await this.deleteIntent(intent);
      return "abandoned";
    }

    const receipt = await this.readReceipt(intent);
    if (receipt !== null) {
      await this.deleteIntent(intent);
      return "replayed";
    }

    const observed = await this.readVaultBodyOrMissing(intent.target);
    if (intent.writeStartedAt !== null && (await this.transitionAlreadyApplied(intent))) {
      await this.finalize(intent);
      return "replayed";
    }
    if (observed !== intent.before) {
      await this.abandonAndDelete(intent);
      return "abandoned";
    }

    const started = await this.markWriteStarted(intent);
    if (intent.destination === undefined && intent.before === intent.after) {
      await this.finalize(started);
      return "replayed";
    }
    const authorize = async () => {
      try {
        await this.options.authorizeRecovery?.(intent);
      } catch (error) {
        if (error instanceof EffectAuthorityRevoked) {
          await this.abandonAndDelete(started);
          throw new RejectedWriteIntent(error.message);
        }
        throw error;
      }
      if (!intent.previewId) return;
      const [rejected] = await this.options.db
        .query<[unknown[]]>(
          "SELECT id FROM proposal_review WHERE preview_id = $preview AND state = 'rejected' LIMIT 1;",
          { preview: intent.previewId },
        )
        .collect();
      if (rejected.length) {
        await this.abandonAndDelete(started);
        throw new RejectedWriteIntent("review was rejected before recovery");
      }
    };
    await authorize();
    if (await this.applyFilesystemTransition(started, authorize)) {
      await this.finalize(started);
      return "replayed";
    }
    if (!(await this.transitionAlreadyApplied(intent))) {
      await this.abandonAndDelete(started);
      return "abandoned";
    }
    await this.finalize(started);
    return "replayed";
  }

  private async finalize(intent: NoteWriteIntent): Promise<void> {
    const beforeClause = intent.before === null ? "" : "    before: $before,\n";
    const sql = `/* note-write:close */
BEGIN;
LET $intentReady = (SELECT VALUE id FROM ONLY $intentId
  WHERE history_id = $historyId AND kind = $kind AND target = $target
    AND before_sha = $beforeSha AND after_sha = $afterSha
    AND client_identity = $clientIdentity AND write_started_at IS NOT NONE
    AND abandoned_at IS NONE);
LET $ready = $intentReady = $intentId AND !record::exists($historyId);
IF $ready {
  CREATE ONLY $historyId CONTENT {
    kind: $kind,
    target: $target,
${beforeClause}    after: $after,
    client_identity: $clientIdentity,
    tool_approval: $toolApproval,
    created_at: $preparedAt
  } RETURN NONE;
  DELETE ONLY $intentId RETURN NONE;
};
COMMIT;
RETURN $ready;`;
    let closeError: unknown;
    try {
      await withSurrealRetry(
        () =>
          this.options.db
            .query(sql, {
              ...intentBindings(intent),
              ...(intent.before === null ? {} : { before: wrapNativeValue(intent.before) }),
              after: wrapNativeValue(
                intent.destination === undefined
                  ? intent.after
                  : { path: intent.destination, body: intent.after },
              ),
            })
            .collect(),
        { idempotencyKey: recordUuidKey(intent.historyId) },
      );
    } catch (error) {
      closeError = error;
    }
    const receipt = await this.readReceipt(intent);
    if (receipt === null) {
      if (closeError !== undefined) throw closeError;
      throw new Error("note write storage integrity: close committed no history receipt");
    }
    if ((await this.readIntent(intent.id)) !== null) await this.deleteIntent(intent);
    await this.pruneHistoryAfterReceipt();
  }

  private async readReceipt(intent: NoteWriteIntent): Promise<string | null> {
    const raw: unknown = await this.options.db
      .query(
        `/* note-write:receipt */ SELECT ${RECEIPT_PROJECTION} FROM history WHERE id = $historyId LIMIT 1;`,
        { historyId: intent.historyId },
      )
      .collect();
    const rows = readSingleStatementRows(raw, "note write receipt");
    if (rows.length === 0) return null;
    if (rows.length !== 1 || !isRecord(rows[0])) {
      throw new Error("note write storage integrity: receipt lookup returned malformed rows");
    }
    const row = rows[0];
    const id = stringifyUuidRecordId(row.id, "history", "note write receipt id");
    if (
      id !== intent.historyId.toString() ||
      row.kind !== intent.kind ||
      row.target !== intent.target ||
      row.client_identity !== intent.clientIdentity ||
      readSnapshot(row.before, "note write receipt before") !== intent.before ||
      !isDeepStrictEqual(
        unwrapNativeValue(row.after, "note write receipt after"),
        intent.destination === undefined
          ? intent.after
          : { path: intent.destination, body: intent.after },
      )
    ) {
      throw new Error("note write storage integrity: receipt differs from its intent");
    }
    return id;
  }

  private async readAllIntents(): Promise<NoteWriteIntent[]> {
    const raw: unknown = await this.options.db
      .query(`/* note-write:list */ SELECT ${INTENT_PROJECTION} FROM note_write_intent;`)
      .collect();
    return readSingleStatementRows(raw, "note write intent list")
      .map(parseIntent)
      .sort((left, right) => left.id.toString().localeCompare(right.id.toString()));
  }

  private async readIntent(id: RecordId<"note_write_intent">): Promise<NoteWriteIntent | null> {
    const raw: unknown = await this.options.db
      .query(
        `/* note-write:intent */ SELECT ${INTENT_PROJECTION} FROM note_write_intent WHERE id = $intentId LIMIT 1;`,
        { intentId: id },
      )
      .collect();
    const rows = readSingleStatementRows(raw, "note write intent lookup");
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new Error("note write storage integrity: intent lookup returned multiple rows");
    }
    return parseIntent(rows[0]);
  }

  private async deleteIntent(intent: NoteWriteIntent): Promise<void> {
    await withSurrealRetry(
      () =>
        this.options.db
          .query(
            `/* note-write:delete */ DELETE ONLY $intentId
WHERE history_id = $historyId AND kind = $kind AND target = $target
  AND before_sha = $beforeSha AND after_sha = $afterSha
  AND client_identity = $clientIdentity RETURN NONE;`,
            intentBindings(intent),
          )
          .collect(),
      { idempotencyKey: recordUuidKey(intent.id) },
    );
    const remaining = await this.readIntent(intent.id);
    if (remaining !== null) {
      assertSameIntent(remaining, intent);
      throw new Error("note write storage integrity: exact intent deletion did not apply");
    }
  }

  private async abandonAndDelete(intent: NoteWriteIntent): Promise<void> {
    const abandoned = await this.markAbandoned(intent);
    await this.deleteIntent(abandoned);
  }

  private async markAbandoned(intent: NoteWriteIntent): Promise<NoteWriteIntent> {
    if (intent.abandonedAt !== null) return intent;
    await withSurrealRetry(
      () =>
        this.options.db
          .query(
            `/* note-write:abandon */ UPDATE ONLY $intentId SET abandoned_at = time::now()
WHERE history_id = $historyId AND kind = $kind AND target = $target
  AND before_sha = $beforeSha AND after_sha = $afterSha
  AND client_identity = $clientIdentity AND abandoned_at IS NONE RETURN NONE;`,
            intentBindings(intent),
          )
          .collect(),
      { idempotencyKey: recordUuidKey(intent.id) },
    );
    const stored = await this.readIntent(intent.id);
    if (stored === null) {
      throw new Error("note write storage integrity: intent vanished while abandoning it");
    }
    assertSameIntent(stored, intent);
    if (stored.abandonedAt === null) {
      throw new Error("note write storage integrity: abandonment stamp did not persist");
    }
    return stored;
  }

  private async pruneHistoryAfterReceipt(): Promise<void> {
    if (this.options.pruneHistory === undefined) return;
    try {
      await this.options.pruneHistory();
    } catch (error) {
      try {
        this.options.onMaintenanceError?.(error);
      } catch {
        // Receipt success is authoritative; diagnostics cannot reverse it.
      }
    }
  }

  private async validateIntentHashes(intent: NoteWriteIntent): Promise<void> {
    const [beforeSha, afterSha] = await Promise.all([
      this.options.hash(intent.before ?? ""),
      this.options.hash(intent.after),
    ]);
    if (beforeSha !== intent.beforeSha || afterSha !== intent.afterSha) {
      throw new Error("note write storage integrity: intent body hash mismatch");
    }
  }

  private async readVaultBodyOrMissing(path: string): Promise<string | null> {
    if (!(await this.options.vault.exists(path))) return null;
    try {
      return await this.options.vault.read(path);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  private async withTargetTurn<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(target) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationTails.set(target, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationTails.get(target) === current) this.mutationTails.delete(target);
    }
  }
}

function intentBindings(intent: NoteWriteIntent): Record<string, unknown> {
  return {
    intentId: intent.id,
    kind: intent.kind,
    target: intent.target,
    destination: intent.destination,
    beforeExists: intent.before !== null,
    beforeBody: intent.before ?? "",
    afterBody: intent.after,
    beforeSha: intent.beforeSha,
    afterSha: intent.afterSha,
    historyId: intent.historyId,
    clientIdentity: intent.clientIdentity,
    previewId: intent.previewId,
    toolApproval:
      intent.toolApproval === undefined ? undefined : JSON.stringify(intent.toolApproval),
    preparedAt: intent.preparedAt,
  };
}

function parseIntent(raw: unknown): NoteWriteIntent {
  if (!isRecord(raw)) throw new Error("note write storage integrity: intent is not an object");
  const id = parseStoredUuidRecordId(raw.id, "note_write_intent", "note write intent id");
  const kind = parseWriteKind(raw.kind);
  const target = raw.target;
  if (!isCanonicalPublicNotePath(target)) {
    throw new Error("note write storage integrity: intent target is not a public note path");
  }
  if (
    (kind === "notes.move") !== (raw.destination !== undefined) ||
    (raw.destination !== undefined &&
      (!isCanonicalPublicNotePath(raw.destination) || raw.destination === target))
  )
    throw new Error("note move intent destination is invalid");
  if (typeof raw.before_exists !== "boolean" || typeof raw.before_body !== "string") {
    throw new Error("note write storage integrity: intent before image is malformed");
  }
  if (kind === "notes.create" ? raw.before_exists : !raw.before_exists) {
    throw new Error("note write storage integrity: intent kind disagrees with before image");
  }
  if (!raw.before_exists && raw.before_body !== "") {
    throw new Error("note write storage integrity: absent before image must have empty bytes");
  }
  if (typeof raw.after_body !== "string") {
    throw new Error("note write storage integrity: intent after image is malformed");
  }
  const beforeSha = parseSha(raw.before_sha, "note write stored before hash");
  const afterSha = parseSha(raw.after_sha, "note write stored after hash");
  const historyId = parseStoredUuidRecordId(raw.history_id, "history", "note write history id");
  const clientIdentity = parseNonBlank(raw.client_identity, "note write client identity");
  const previewId =
    raw.preview_id === undefined ? undefined : parseSha(raw.preview_id, "note write preview id");
  const preparedAt = parseDateTime(raw.prepared_at, "note write prepared_at");
  const writeStartedAt =
    raw.write_started_at === undefined
      ? null
      : parseDateTime(raw.write_started_at, "note write write_started_at");
  const abandonedAt =
    raw.abandoned_at === undefined
      ? null
      : parseDateTime(raw.abandoned_at, "note write abandoned_at");
  return {
    id,
    kind,
    target,
    ...(typeof raw.destination === "string" ? { destination: raw.destination } : {}),
    before: raw.before_exists ? raw.before_body : null,
    after: raw.after_body,
    beforeSha,
    afterSha,
    historyId,
    clientIdentity,
    previewId,
    toolApproval:
      raw.tool_approval === undefined
        ? undefined
        : toolApprovalSchema.parse(JSON.parse(String(raw.tool_approval))),
    preparedAt,
    writeStartedAt,
    abandonedAt,
  };
}

function assertWriteInput(input: DurableNoteWriteInput): void {
  if (input.previewId !== undefined) parseSha(input.previewId, "note write preview id");
  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 512)
  )
    throw new Error("invalid note write idempotency key");
  if (!WRITE_KINDS.includes(input.kind)) throw new Error("note write kind is not supported");
  if (!isCanonicalPublicNotePath(input.target)) {
    throw new Error("note write target must be an exact public vault-relative Markdown path");
  }
  if (
    (input.kind === "notes.move") !== (input.destination !== undefined) ||
    (input.destination !== undefined &&
      (!isCanonicalPublicNotePath(input.destination) ||
        input.destination === input.target ||
        input.before !== input.after))
  )
    throw new Error("invalid durable move transition");
  if (typeof input.after !== "string") throw new Error("note write after image must be a string");
  if (input.before !== null && typeof input.before !== "string") {
    throw new Error("note write before image must be a string or null");
  }
  if ((input.kind === "notes.create") !== (input.before === null)) {
    throw new Error("note write create kind must exactly match an absent before image");
  }
  parseNonBlank(input.clientIdentity, "note write client identity");
}

function stableWriteId<Table extends string>(
  table: Table,
  principal: string,
  key: string,
): RecordId<Table> {
  const bytes = createHash("sha256")
    .update(JSON.stringify([table, principal, key]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return createUuidRecordId(
    table,
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

function assertSameIntent(actual: NoteWriteIntent, expected: NoteWriteIntent): void {
  if (intentIdentity(actual) !== intentIdentity(expected)) {
    const actualFields = JSON.parse(intentIdentity(actual));
    const expectedFields = JSON.parse(intentIdentity(expected));
    const changed = Object.keys(expectedFields).filter(
      (key) => JSON.stringify(actualFields[key]) !== JSON.stringify(expectedFields[key]),
    );
    throw new Error(
      `note write storage integrity: stored intent changed identity (${changed.join(", ")})`,
    );
  }
}

function intentIdentity(intent: NoteWriteIntent): string {
  return JSON.stringify({
    id: intent.id.toString(),
    kind: intent.kind,
    target: intent.target,
    destination: intent.destination,
    before: intent.before,
    after: intent.after,
    beforeSha: intent.beforeSha,
    afterSha: intent.afterSha,
    historyId: intent.historyId.toString(),
    clientIdentity: intent.clientIdentity,
    previewId: intent.previewId,
    toolApproval:
      intent.toolApproval === undefined ? undefined : JSON.stringify(intent.toolApproval),
    preparedAt: intent.preparedAt.toString(),
  });
}

function parseWriteKind(raw: unknown): DurableNoteWriteKind {
  if (typeof raw !== "string" || !WRITE_KINDS.includes(raw as DurableNoteWriteKind)) {
    throw new Error("note write storage integrity: kind is not supported");
  }
  return raw as DurableNoteWriteKind;
}

function readSnapshot(raw: unknown, label: string): string | null {
  if (raw === undefined) return null;
  if (raw === null) throw new Error(`${label} uses null instead of NONE`);
  const value = unwrapNativeValue(raw, label);
  if (typeof value !== "string") throw new Error(`${label} is not a string`);
  return value;
}

function parseDateTime(raw: unknown, label: string): DateTime {
  if (!(raw instanceof DateTime) || !Number.isFinite(raw.toDate().getTime())) {
    throw new Error(`${label} must be a native valid datetime`);
  }
  return raw;
}

function parseNonBlank(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${label} must be a non-blank string`);
  }
  return raw;
}

function assertSha256(raw: unknown, label: string): asserts raw is string {
  parseSha(raw, label);
}

function parseSha(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return raw;
}

function recordUuidKey(id: RecordId): string {
  const raw = id.toString();
  const start = raw.indexOf('u"');
  if (start < 0 || !raw.endsWith('"')) throw new Error("note write record id lost UUID key");
  return raw.slice(start + 2, -1);
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isMissingFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  return code === "ENOENT" || /ENOENT|not found|missing:/i.test(message);
}
