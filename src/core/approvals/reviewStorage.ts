import { createHash } from "node:crypto";
import { RecordId, type Surreal } from "surrealdb";
import { z } from "zod";
import { operationInputs } from "../../api/operations";
import { type ReviewProposal, reviewProposalSchema } from "../../api/proposals";
import { NoteApiError } from "../../api/schema";

export function reviewRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function record(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new NoteApiError("INVALID_PARAMS", "invalid review proposal id");
  return new RecordId("proposal_review", id);
}
export async function readReview(db: Surreal, id: string): Promise<ReviewProposal | null> {
  const [rows] = await db
    .query<[Array<{ payload: string }>]>("SELECT payload FROM proposal_review WHERE id = $id;", {
      id: record(id),
    })
    .collect();
  return rows.length ? reviewProposalSchema.parse(JSON.parse(rows[0].payload)) : null;
}
const cursorSchema = z
  .object({ snapshot: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().nonnegative() })
  .strict();
/** Pages bind the stored proposal inventory and filters. Evidence freshness is
 * rechecked for this page against live files; a cursor never freezes file bytes.
 * Scan at most one page of documents, even when live state/path filters match none. */
export async function pageReviews(
  db: Surreal,
  raw: unknown,
  fresh: (proposal: ReviewProposal) => Promise<ReviewProposal>,
) {
  const parsed = operationInputs["proposals.list"].safeParse(raw);
  if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
  const input = parsed.data;
  const filters = { path: input.path ?? null, state: input.state ?? null, limit: input.limit };
  const state = input.state === "stale" ? "pending" : input.state;
  const inventory = async () => {
    const [rows] = await db
      .query<[Array<{ id: RecordId; revision: string; created_ms: number }>]>(
        "SELECT id, revision, created_ms FROM proposal_review WHERE $state = NONE OR state = $state ORDER BY created_ms DESC, id DESC LIMIT 10001;",
        { state },
      )
      .collect();
    if (rows.length > 10000)
      throw new NoteApiError(
        "LIMIT_EXCEEDED",
        "proposal inventory exceeds 10000 entries; narrow the state filter",
      );
    return {
      rows,
      snapshot: reviewRevision([
        filters,
        rows.map((row) => [String(row.id), row.revision, row.created_ms]),
      ]),
    };
  };
  const { rows, snapshot } = await inventory();
  let offset = 0;
  if (input.cursor !== undefined) {
    let cursor: z.infer<typeof cursorSchema>;
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
      );
    } catch {
      throw new NoteApiError("INVALID_PARAMS", "invalid proposal cursor");
    }
    if (cursor.snapshot !== snapshot)
      throw new NoteApiError("CONFLICT", "proposal inventory or filters changed; refresh the list");
    offset = cursor.offset;
    if (offset >= rows.length)
      throw new NoteApiError("INVALID_PARAMS", "proposal cursor is outside the inventory");
  }
  const selected = rows.slice(offset, offset + input.limit);
  const [documents] = await db
    .query<[Array<{ payload: string }>]>("SELECT payload FROM proposal_review WHERE id IN $ids;", {
      ids: selected.map((row) => row.id),
    })
    .collect();
  const byId = new Map(
    documents.map((row) => {
      const proposal = reviewProposalSchema.parse(JSON.parse(row.payload));
      return [String(record(proposal.id)), proposal];
    }),
  );
  const proposals: ReviewProposal[] = [];
  for (const row of selected) {
    const stored = byId.get(String(row.id));
    if (!stored || stored.revision !== row.revision)
      throw new NoteApiError("CONFLICT", "proposal changed while listing; refresh the list");
    if (input.path && !stored.provenance.sources.some((source) => source.path === input.path))
      continue;
    const proposal = await fresh(stored);
    if (!input.state || proposal.state === input.state) proposals.push(proposal);
  }
  if ((await inventory()).snapshot !== snapshot)
    throw new NoteApiError(
      "CONFLICT",
      "proposal inventory changed while listing; refresh the list",
    );
  const next = offset + selected.length;
  return {
    ok: true as const,
    proposals,
    snapshot,
    nextCursor:
      next < rows.length
        ? Buffer.from(JSON.stringify({ snapshot, offset: next })).toString("base64url")
        : null,
  };
}
export async function saveReview(
  db: Surreal,
  proposal: ReviewProposal,
  expected: string | null,
): Promise<ReviewProposal> {
  const { revision: _revision, ...content } = proposal;
  const next = reviewProposalSchema.parse({ ...content, revision: reviewRevision(content) });
  const bindings = {
    id: record(next.id),
    revision: next.revision,
    state: next.state,
    created: next.createdAt,
    payload: JSON.stringify(next),
    expected,
    preview: next.previewId,
    edges: next.edgeIds,
  };
  if (expected === null)
    await db
      .query(
        "CREATE ONLY $id CONTENT { revision: $revision, state: $state, created_ms: $created, payload: $payload, preview_id: $preview, edge_ids: $edges };",
        bindings,
      )
      .collect();
  else {
    const [rows] = await db
      .query<[unknown[]]>(
        "UPDATE $id SET revision = $revision, state = $state, payload = $payload, preview_id = $preview, edge_ids = $edges WHERE revision = $expected RETURN id;",
        bindings,
      )
      .collect();
    if (rows.length !== 1)
      throw new NoteApiError("CONFLICT", "review proposal changed; refresh before deciding");
  }
  return next;
}

/** Add indexed preview bindings without changing existing decisions or revisions. */
export async function backfillReviewPreviews(db: Surreal): Promise<void> {
  while (true) {
    const [rows] = await db
      .query<[Array<{ id: RecordId; payload: string }>]>(
        "SELECT id, payload FROM proposal_review WHERE preview_id IS NONE OR edge_ids IS NONE LIMIT 200;",
      )
      .collect();
    if (!rows.length) return;
    for (const row of rows) {
      const proposal = reviewProposalSchema.parse(JSON.parse(row.payload));
      if (String(record(proposal.id)) !== String(row.id))
        throw new Error("review storage identity mismatch");
      await db
        .query(
          "UPDATE ONLY $id SET preview_id = $preview, edge_ids = $edges WHERE payload = $payload RETURN NONE;",
          {
            id: row.id,
            preview: proposal.previewId,
            edges: proposal.edgeIds,
            payload: row.payload,
          },
        )
        .collect();
    }
  }
}

export async function reviewsForEdge(db: Surreal, edge: string): Promise<ReviewProposal[]> {
  const [rows] = await db
    .query<[Array<{ payload: string }>]>(
      "SELECT payload FROM proposal_review WHERE edge_ids CONTAINS $edge;",
      { edge },
    )
    .collect();
  return rows.map((row) => reviewProposalSchema.parse(JSON.parse(row.payload)));
}
