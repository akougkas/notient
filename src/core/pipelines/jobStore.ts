import { createHash } from "node:crypto";
import type { Surreal } from "surrealdb";
import { z } from "zod";
import type { OperationInput, operationInputs } from "../../api/operations";
import { jobListSchema, jobSummarySchema } from "../../api/pipelines";
import { type PipelineJob, pipelineJobSchema } from "../../api/pipelines";
import { NoteApiError } from "../../api/schema";
import { createUuidRecordId } from "../db/recordId";

export function stableJobId(owner: string, key: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["pipeline-job", owner, key]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function stamp(job: PipelineJob): PipelineJob {
  const { revision: _revision, ...content } = job;
  return pipelineJobSchema.parse({
    ...content,
    revision: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  });
}

/** Durable, revision-checked job documents in the existing per-vault database. */
export class JobStore {
  private readonly tails = new Map<string, Promise<unknown>>();
  constructor(private readonly db: Surreal) {}
  async get(id: string): Promise<PipelineJob | null> {
    const [rows] = await this.db
      .query<[Array<{ payload: string }>]>("SELECT payload FROM pipeline_job WHERE id = $id;", {
        id: createUuidRecordId("pipeline_job", id),
      })
      .collect();
    return rows.length ? pipelineJobSchema.parse(JSON.parse(rows[0].payload)) : null;
  }
  async create(input: PipelineJob): Promise<PipelineJob> {
    return this.serialize(input.id, async () => {
      const job = stamp(input);
      const prior = await this.get(job.id);
      if (prior) return prior;
      await this.db
        .query(
          "CREATE ONLY $id CONTENT { pipeline: $pipeline, state: $state, revision: $revision, updated_ms: $updated, payload: $payload };",
          this.bindings(job),
        )
        .collect();
      return job;
    });
  }
  async list(limit = 1000): Promise<PipelineJob[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
      throw new Error("invalid job inventory limit");
    const [rows] = await this.db
      .query<[Array<{ payload: string }>]>(
        "SELECT payload, updated_ms FROM pipeline_job ORDER BY updated_ms DESC LIMIT $limit;",
        { limit },
      )
      .collect();
    return rows.map((row) => pipelineJobSchema.parse(JSON.parse(row.payload)));
  }
  /** Snapshot-bound pages: changing jobs invalidate a cursor instead of silently
   * skipping or duplicating entries while ordering by most recent activity. */
  async page(input: z.infer<(typeof operationInputs)["jobs.list"]>) {
    const filter = { pipeline: input.pipeline ?? null, state: input.state ?? null };
    const inventory = async () => {
      const [rows] = await this.db
        .query<[Array<{ id: unknown; revision: string; updated_ms: number }>]>(
          "SELECT id, revision, updated_ms FROM pipeline_job WHERE ($pipeline = NONE OR pipeline = $pipeline) AND ($state = NONE OR state = $state) ORDER BY updated_ms DESC, id DESC LIMIT 10001;",
          { pipeline: filter.pipeline ?? undefined, state: filter.state ?? undefined },
        )
        .collect();
      if (rows.length > 10000)
        throw new NoteApiError(
          "LIMIT_EXCEEDED",
          "job inventory exceeds 10000 entries; narrow the pipeline/state filters",
        );
      const snapshot = createHash("sha256")
        .update(
          JSON.stringify([
            filter,
            rows.map((row) => [String(row.id), row.revision, row.updated_ms]),
          ]),
        )
        .digest("hex");
      return { rows, snapshot };
    };
    const { rows, snapshot } = await inventory();
    let offset = 0;
    if (input.cursor !== undefined) {
      let cursor: z.infer<typeof jobCursorSchema>;
      try {
        cursor = jobCursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        );
      } catch {
        throw new NoteApiError("INVALID_PARAMS", "invalid jobs cursor");
      }
      if (cursor.snapshot !== snapshot)
        throw new NoteApiError(
          "CONFLICT",
          "job inventory or filters changed; restart listing without a cursor",
        );
      offset = cursor.offset;
      if (offset >= rows.length)
        throw new NoteApiError("INVALID_PARAMS", "jobs cursor is outside the inventory");
    }
    const selected = rows.slice(offset, offset + input.limit);
    const [documents] = await this.db
      .query<[Array<{ payload: string }>]>("SELECT payload FROM pipeline_job WHERE id IN $ids;", {
        ids: selected.map((row) => row.id),
      })
      .collect();
    const jobs = documents.map((row) => pipelineJobSchema.parse(JSON.parse(row.payload)));
    const byId = new Map(
      jobs.map((job) => [String(createUuidRecordId("pipeline_job", job.id)), job]),
    );
    const page = selected.map((row) => {
      const job = byId.get(String(row.id));
      if (!job || job.revision !== row.revision)
        throw new NoteApiError("CONFLICT", "job changed while listing; refresh the list");
      return jobSummarySchema.parse({
        ...job,
        sourceCount: job.sourceRevisions.length,
        proposalCount: job.proposalIds.length,
        modelCalls: job.attempts.length,
        chargedTokens: job.attempts.reduce((total, attempt) => total + attempt.chargedTokens, 0),
      });
    });
    if ((await inventory()).snapshot !== snapshot)
      throw new NoteApiError("CONFLICT", "job inventory changed while listing; refresh the list");
    const nextOffset = offset + selected.length;
    return jobListSchema.parse({
      ok: true,
      jobs: page,
      snapshot,
      nextCursor:
        nextOffset < rows.length
          ? Buffer.from(JSON.stringify({ snapshot, offset: nextOffset })).toString("base64url")
          : null,
    });
  }
  update(
    id: string,
    mutate: (job: PipelineJob) => void,
    expectedRevision?: string,
  ): Promise<PipelineJob> {
    return this.serialize(id, async () => {
      const current = await this.get(id);
      if (!current) throw new NoteApiError("NOT_FOUND", "job does not exist");
      if (expectedRevision && current.revision !== expectedRevision)
        throw new NoteApiError("CONFLICT", "job changed; refresh before controlling it");
      const next = structuredClone(current);
      mutate(next);
      next.updatedAt = Math.max(Date.now(), current.updatedAt + 1);
      const job = stamp(next);
      const [rows] = await this.db
        .query<[Array<{ id: unknown }>]>(
          "UPDATE $id SET pipeline = $pipeline, state = $state, revision = $revision, updated_ms = $updated, payload = $payload WHERE revision = $expected RETURN id;",
          { ...this.bindings(job), expected: current.revision },
        )
        .collect();
      if (rows.length !== 1) throw new NoteApiError("CONFLICT", "job changed concurrently");
      return job;
    });
  }
  /** The transition and its receipt commit together. A lost reply may be retried
   * with exactly the same request, even after the job advances or a daemon restart. */
  control(
    caller: { id: string; kind: "human" | "agent" },
    request: OperationInput<"jobs.control">,
    mutate: (job: PipelineJob) => void,
  ): Promise<{ job: PipelineJob; replayed: boolean }> {
    const binding = JSON.stringify({ caller: { id: caller.id, kind: caller.kind }, request });
    const receiptId = createUuidRecordId(
      "job_control_receipt",
      stableJobId(caller.id, `control:${request.idempotencyKey}`),
    );
    const receipt = async () => {
      const [rows] = await this.db
        .query<[Array<{ payload: string }>]>(
          "SELECT payload FROM job_control_receipt WHERE id = $id;",
          { id: receiptId },
        )
        .collect();
      if (!rows.length) return null;
      const stored = controlReceiptSchema.parse(JSON.parse(rows[0].payload));
      if (stored.binding !== binding)
        throw new NoteApiError(
          "CONFLICT",
          "control idempotency key was reused with different inputs",
        );
      return { job: stored.job, replayed: true };
    };
    return this.serialize(request.id, async () => {
      const prior = await receipt();
      if (prior) return prior;
      const current = await this.get(request.id);
      if (!current) throw new NoteApiError("NOT_FOUND", "job does not exist");
      if (current.revision !== request.revision)
        throw new NoteApiError("CONFLICT", "job changed; refresh before controlling it");
      const next = structuredClone(current);
      mutate(next);
      next.updatedAt = Math.max(Date.now(), current.updatedAt + 1);
      const job = stamp(next);
      try {
        await this.db
          .query(
            `BEGIN TRANSACTION;
          LET $changed = (UPDATE $id SET pipeline = $pipeline, state = $state,
            revision = $revision, updated_ms = $updated, payload = $payload
            WHERE revision = $expected RETURN id);
          IF array::len($changed) != 1 { THROW "job changed concurrently"; };
          CREATE ONLY $receipt CONTENT { payload: $receiptPayload };
          COMMIT TRANSACTION;`,
            {
              ...this.bindings(job),
              expected: current.revision,
              receipt: receiptId,
              receiptPayload: JSON.stringify({ binding, job }),
            },
          )
          .collect();
      } catch (error) {
        // This also resolves an ambiguous database disconnect after commit. Never
        // replay the transition without first finding its durable receipt.
        const committed = await receipt();
        if (committed) return committed;
        const latest = await this.get(request.id);
        if (latest?.revision !== current.revision)
          throw new NoteApiError("CONFLICT", "job changed concurrently");
        throw error;
      }
      return { job, replayed: false };
    });
  }
  private serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.tails.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.tails.set(id, operation);
    void operation
      .finally(() => {
        if (this.tails.get(id) === operation) this.tails.delete(id);
      })
      .catch(() => {});
    return operation;
  }
  private bindings(job: PipelineJob) {
    return {
      id: createUuidRecordId("pipeline_job", job.id),
      pipeline: job.pipeline,
      state: job.state,
      revision: job.revision,
      updated: job.updatedAt,
      payload: JSON.stringify(job),
    };
  }
}

const controlReceiptSchema = z.object({ binding: z.string(), job: pipelineJobSchema });

const jobCursorSchema = z
  .object({
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().positive().max(10000),
  })
  .strict();
