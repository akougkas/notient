import { RecordId, type Surreal } from "surrealdb";
import { z } from "zod";
import { type ContributionRecord, contributionRecordSchema } from "../../api/contributions";
import { NoteApiError, revisionSchema } from "../../api/schema";
import { contentRevision } from "../../api/notes";
import { createUuidRecordId, parseUuidRecordId, stringifyUuidRecordId } from "../db/recordId";

export interface ContributionSubmission {
  idempotencyKey: string;
  requestHash: string;
  principalId: string;
  kind: "contribution" | "feedback";
  contributionKind: ContributionRecord["contributionKind"];
  target: ContributionRecord["target"];
  statement: string;
  evidence: ContributionRecord["evidence"];
  attribution: ContributionRecord["attribution"];
  origin: ContributionRecord["origin"];
  feedback: ContributionRecord["feedback"];
}

export interface StoredContribution {
  record: ContributionRecord;
  principalId: string;
  requestHash: string;
  stageKey: string | null;
  dismissKey: string | null;
}

interface PersistedContribution {
  id: RecordId;
  revision: string;
  created_ms: number;
  principal_id: string;
  request_hash: string;
  stage_key: string | null;
  dismiss_key: string | null;
  payload: string;
}

const cursorSchema = z
  .object({ snapshot: revisionSchema, offset: z.number().int().nonnegative() })
  .strict();

export class ContributionStore {
  constructor(private readonly db: Surreal) {}

  async findReplay(
    principalId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<StoredContribution | null> {
    const existing = await this.findByKey(principalId, idempotencyKey);
    if (!existing) return null;
    if (existing.requestHash !== requestHash)
      throw new NoteApiError("CONFLICT", "idempotency key was reused for a different contribution");
    return existing;
  }

  async submit(input: ContributionSubmission): Promise<{ value: StoredContribution; replayed: boolean }> {
    const requestHash = input.requestHash;
    const existing = await this.findByKey(input.principalId, input.idempotencyKey);
    if (existing) return this.replay(existing, requestHash);
    const id = createUuidRecordId("contribution");
    const now = Date.now();
    const withoutRevision = {
      id: stringifyUuidRecordId(id, "contribution"),
      kind: input.kind,
      contributionKind: input.contributionKind,
      target: input.target,
      statement: input.statement,
      evidence: input.evidence,
      attribution: input.attribution,
      origin: input.origin,
      feedback: input.feedback,
      status: "pending" as const,
      proposalId: null,
      dispositionReason: null,
      createdAt: now,
      updatedAt: now,
    };
    const record = contributionRecordSchema.parse({
      ...withoutRevision,
      revision: contentRevision(JSON.stringify(withoutRevision)),
    });
    try {
      await this.db
        .query(
          "CREATE ONLY $id CONTENT { principal_id: $principal, idempotency_key: $key, request_hash: $requestHash, status: 'pending', target_path: $targetPath, kind: $kind, created_ms: $created, updated_ms: $created, revision: $revision, stage_key: NONE, dismiss_key: NONE, proposal_id: NONE, disposition_reason: NONE, payload: $payload };",
          {
            id,
            principal: input.principalId,
            key: input.idempotencyKey,
            requestHash,
            targetPath: input.target.path,
            kind: input.kind,
            created: now,
            revision: record.revision,
            payload: JSON.stringify(record),
          },
        )
        .collect();
      return {
        value: { record, principalId: input.principalId, requestHash, stageKey: null, dismissKey: null },
        replayed: false,
      };
    } catch (error) {
      const raced = await this.findByKey(input.principalId, input.idempotencyKey);
      if (raced) return this.replay(raced, requestHash);
      throw error;
    }
  }

  async get(id: string): Promise<StoredContribution | null> {
    let recordId: RecordId;
    try {
      recordId = parseUuidRecordId(id, "contribution");
    } catch {
      throw new NoteApiError("INVALID_PARAMS", "contribution id is invalid");
    }
    const [rows] = await this.db
      .query<[PersistedContribution[]]>(
        "SELECT id, revision, created_ms, principal_id, request_hash, stage_key, dismiss_key, payload FROM contribution WHERE id = $id;",
        { id: recordId },
      )
      .collect();
    return rows.length ? decodeRow(rows[0]) : null;
  }

  async list(input: {
    principalId: string | null;
    kind?: "contribution" | "feedback";
    state?: ContributionRecord["status"];
    limit: number;
    cursor?: string;
  }): Promise<{ contributions: StoredContribution[]; snapshot: string; nextCursor: string | null }> {
    const storedState =
      input.state === "retained" || input.state === "rejected" || input.state === "stale"
        ? "awaiting-review"
        : input.state ?? null;
    const filterRevision = contentRevision(
      JSON.stringify([input.principalId, input.kind ?? null, input.state ?? null]),
    );
    const inventory = async () => {
      const filters: string[] = [];
      const variables: Record<string, unknown> = {};
      if (input.principalId !== null) {
        filters.push("principal_id = $owner");
        variables.owner = input.principalId;
      }
      if (input.kind !== undefined) {
        filters.push("kind = $kind");
        variables.kind = input.kind;
      }
      if (storedState !== null) {
        filters.push("status = $state");
        variables.state = storedState;
      }
      const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
      const [rows] = await this.db
        .query<[{ id: RecordId; revision: string; created_ms: number }[]]>(
          `SELECT id, revision, created_ms FROM contribution${where} ORDER BY created_ms DESC, id DESC LIMIT 10001;`,
          variables,
        )
        .collect();
      if (rows.length > 10000)
        throw new NoteApiError(
          "LIMIT_EXCEEDED",
          "contribution inventory exceeds 10000 entries; narrow the state or kind filter",
        );
      return {
        rows,
        snapshot: contentRevision(
          JSON.stringify([filterRevision, rows.map((row) => [String(row.id), row.revision, row.created_ms])]),
        ),
      };
    };
    const { rows, snapshot } = await inventory();
    let offset = 0;
    if (input.cursor !== undefined) {
      let cursor: z.infer<typeof cursorSchema>;
      try {
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
      } catch {
        throw new NoteApiError("INVALID_PARAMS", "invalid contribution cursor");
      }
      if (cursor.snapshot !== snapshot)
        throw new NoteApiError("CONFLICT", "contribution inventory changed; refresh the list");
      offset = cursor.offset;
      if (offset >= rows.length)
        throw new NoteApiError("INVALID_PARAMS", "contribution cursor is outside the inventory");
    }
    const selected = rows.slice(offset, offset + input.limit);
    const ids = selected.map((row) => row.id);
    const documents = ids.length
      ? (await this.db
          .query<[PersistedContribution[]]>(
            "SELECT id, revision, created_ms, principal_id, request_hash, stage_key, dismiss_key, payload FROM contribution WHERE id IN $ids;",
            { ids },
          )
          .collect())[0]
      : [];
    const byId = new Map(documents.map((row) => [String(row.id), decodeRow(row)]));
    const contributions = selected.map((row) => {
      const stored = byId.get(String(row.id));
      if (!stored || stored.record.revision !== row.revision)
        throw new NoteApiError("CONFLICT", "contribution changed while listing; refresh the list");
      return stored;
    });
    if ((await inventory()).snapshot !== snapshot)
      throw new NoteApiError("CONFLICT", "contribution inventory changed while listing; refresh the list");
    const next = offset + selected.length;
    return {
      contributions,
      snapshot,
      nextCursor:
        next < rows.length
          ? Buffer.from(JSON.stringify({ snapshot, offset: next })).toString("base64url")
          : null,
    };
  }

  async stage(
    id: string,
    expectedRevision: string,
    stageKey: string,
    proposalId: string,
  ): Promise<StoredContribution> {
    const current = await this.get(id);
    if (!current) throw new NoteApiError("NOT_FOUND", "contribution does not exist");
    if (current.record.status === "awaiting-review") {
      if (current.stageKey === stageKey) return current;
      throw new NoteApiError("CONFLICT", "contribution was already staged under another request");
    }
    if (current.record.status !== "pending")
      throw new NoteApiError("CONFLICT", "contribution is no longer pending");
    if (current.record.revision !== expectedRevision)
      throw new NoteApiError("CONFLICT", "contribution changed; refresh before staging");
    const now = Date.now();
    const body = {
      ...current.record,
      status: "awaiting-review" as const,
      proposalId,
      updatedAt: now,
    };
    const record = contributionRecordSchema.parse({
      ...body,
      revision: contentRevision(JSON.stringify({ ...body, revision: undefined })),
    });
    const [rows] = await this.db
      .query<[unknown[]]>(
        "UPDATE ONLY $id SET status = 'awaiting-review', proposal_id = $proposal, stage_key = $stageKey, updated_ms = $updated, revision = $revision, payload = $payload WHERE revision = $expected AND status = 'pending' RETURN id;",
        {
          id: parseUuidRecordId(id, "contribution"),
          proposal: proposalId,
          stageKey,
          updated: now,
          revision: record.revision,
          payload: JSON.stringify(record),
          expected: expectedRevision,
        },
      )
      .collect();
    if (rows.length !== 1) {
      const raced = await this.get(id);
      if (raced?.record.proposalId === proposalId) return raced;
      throw new NoteApiError("CONFLICT", "contribution changed before staging completed");
    }
    return { ...current, record, stageKey };
  }

  async dismiss(
    id: string,
    expectedRevision: string,
    dismissKey: string,
    reason: string,
  ): Promise<StoredContribution> {
    const current = await this.get(id);
    if (!current) throw new NoteApiError("NOT_FOUND", "contribution does not exist");
    if (current.record.status === "dismissed") {
      if (current.dismissKey === dismissKey && current.record.dispositionReason === reason) return current;
      throw new NoteApiError("CONFLICT", "contribution was already dismissed");
    }
    if (current.record.status !== "pending")
      throw new NoteApiError("CONFLICT", "only a pending contribution can be dismissed");
    if (current.record.revision !== expectedRevision)
      throw new NoteApiError("CONFLICT", "contribution changed; refresh before dismissing");
    const now = Date.now();
    const body = {
      ...current.record,
      status: "dismissed" as const,
      dispositionReason: reason,
      updatedAt: now,
    };
    const record = contributionRecordSchema.parse({
      ...body,
      revision: contentRevision(JSON.stringify({ ...body, revision: undefined })),
    });
    const [rows] = await this.db
      .query<[unknown[]]>(
        "UPDATE ONLY $id SET status = 'dismissed', disposition_reason = $reason, dismiss_key = $dismissKey, updated_ms = $updated, revision = $revision, payload = $payload WHERE revision = $expected AND status = 'pending' RETURN id;",
        {
          id: parseUuidRecordId(id, "contribution"),
          reason,
          dismissKey,
          updated: now,
          revision: record.revision,
          payload: JSON.stringify(record),
          expected: expectedRevision,
        },
      )
      .collect();
    if (rows.length !== 1) {
      const raced = await this.get(id);
      if (raced?.dismissKey === dismissKey && raced.record.dispositionReason === reason) return raced;
      throw new NoteApiError("CONFLICT", "contribution changed before dismissal completed");
    }
    return { ...current, record, dismissKey };
  }

  private async findByKey(principalId: string, key: string): Promise<StoredContribution | null> {
    const [rows] = await this.db
      .query<[PersistedContribution[]]>(
        "SELECT id, revision, created_ms, principal_id, request_hash, stage_key, dismiss_key, payload FROM contribution WHERE principal_id = $principal AND idempotency_key = $key LIMIT 1;",
        { principal: principalId, key },
      )
      .collect();
    return rows.length ? decodeRow(rows[0]) : null;
  }

  private replay(
    current: StoredContribution,
    requestHash: string,
  ): { value: StoredContribution; replayed: boolean } {
    if (current.requestHash !== requestHash)
      throw new NoteApiError("CONFLICT", "idempotency key was reused for a different contribution");
    return { value: current, replayed: true };
  }
}

function decodeRow(row: PersistedContribution): StoredContribution {
  const id = stringifyUuidRecordId(row.id, "contribution");
  const record = contributionRecordSchema.parse(JSON.parse(row.payload));
  if (record.id !== id || record.revision !== row.revision)
    throw new Error("contribution storage identity or revision mismatch");
  return {
    record,
    principalId: row.principal_id,
    requestHash: row.request_hash,
    stageKey: row.stage_key ?? null,
    dismissKey: row.dismiss_key ?? null,
  };
}
