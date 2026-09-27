import { RecordId, type Surreal } from "surrealdb";
import { prepareIntelligenceAppend, parseIntelligenceRecords, intelligenceRecordId } from "../intelligence";
import type { GraphService } from "../graph/graphService";
import { WRITEBACK_EDGE_TABLES } from "../db/edgeTables";
import { parseSurrealRelationRecordId } from "../db/recordId";
import { NoteApiError, notePathSchema } from "../../api/schema";
import { contentRevision, type NoteReadService } from "../../api/notes";
import type { ChangeCaller, ChangeService } from "../history/changeService";
import type { ApprovalService } from "./approvalService";
import type { RelationshipRetentionResult } from "../../api/relationshipRetention";
import { type WritebackEdgeTable } from "../db/edgeTables";

interface RelationshipRow {
  id: unknown;
  fromPath: unknown;
  toPath: unknown;
  source: unknown;
  agent: unknown;
  approvedBy: unknown;
  approved: unknown;
  applied: unknown;
}

export interface RelationshipRetentionOptions {
  db: Surreal;
  graph: Pick<GraphService, "neighbors">;
  notes: NoteReadService;
  changes: ChangeService;
  approvals: Pick<ApprovalService, "submitReview">;
}

export async function stageRelationshipRetention(
  options: RelationshipRetentionOptions,
  input: { edgeId: string; idempotencyKey?: string },
  caller: ChangeCaller,
  section: string,
  signal?: AbortSignal,
): Promise<RelationshipRetentionResult> {
  if (!caller.scopes.includes("read") || !caller.scopes.includes("write"))
    throw new NoteApiError("FORBIDDEN", "relationship retention requires read and write scopes");
  signal?.throwIfAborted();
  const parsedEdge = parseSurrealRelationRecordId(input.edgeId, WRITEBACK_EDGE_TABLES);
  const row = await readAppliedRelationship(options.db, parsedEdge.table, parsedEdge.recordId);
  const sourcePath = notePathSchema.parse(row.fromPath);
  const targetPath = notePathSchema.parse(row.toPath);
  if (sourcePath === targetPath)
    throw new NoteApiError("CONFLICT", "a self-relationship cannot be retained");
  if (row.approved !== true || row.applied !== true)
    throw new NoteApiError("CONFLICT", "only an approved and applied relationship can be retained");
  if (
    typeof row.source !== "string" ||
    (row.agent !== null && row.agent !== undefined && typeof row.agent !== "string") ||
    (row.approvedBy !== null && row.approvedBy !== undefined && typeof row.approvedBy !== "string")
  )
    throw new NoteApiError("INTERNAL_ERROR", "stored relationship attribution is unavailable");

  const graph = await options.graph.neighbors(
    { path: sourcePath, includeProposed: false, limit: 200 },
    signal,
  );
  const connection = graph.connections.find(
    (candidate) =>
      candidate.id === parsedEdge.id &&
      candidate.relation === parsedEdge.table &&
      candidate.direction === "outgoing" &&
      candidate.state === "approved" &&
      candidate.note.path === targetPath,
  );
  if (!connection)
    throw new NoteApiError(
      "CONFLICT",
      "the approved relationship is not available in the current, indexed graph; refresh and retry",
    );
  signal?.throwIfAborted();
  const [source, target] = await Promise.all([
    options.notes.read({ path: sourcePath }),
    options.notes.read({ path: targetPath }),
  ]);
  const evidence = connection.evidenceState === "current" ? connection.evidence : [];
  const statement =
    connection.rationale ??
    `This note has a reviewed ${parsedEdge.table} relationship with ${targetPath}.`;
  const recordId = `legacy-edge:${parsedEdge.id}`;
  const recordsById = new Map(
    [section, ...(section === "Notient understanding" ? [] : ["Notient understanding"])]
      .flatMap((designation) => parseIntelligenceRecords(source.body, designation))
      .map((record) => [intelligenceRecordId(record), record]),
  );
  const records = [...recordsById.values()];
  const retainedRecord = records.find(
    (record) =>
      record.attribution.id === recordId ||
      (record.kind === "relationship" &&
        record.statement === statement &&
        record.relationships.some(
          (relationship) =>
            relationship.target === targetPath &&
            (relationship.relation === parsedEdge.table ||
              relationship.meaning === `${parsedEdge.table}: ${statement}`),
        )),
  );
  if (retainedRecord)
    return {
      ok: true,
      status: "already-retained",
      edgeId: parsedEdge.id,
      relation: parsedEdge.table,
      sourcePath,
      targetPath,
      evidenceState: connection.evidenceState,
      recordId: intelligenceRecordId(retainedRecord),
      previewId: null,
      previewRevision: null,
      proposal: null,
    };

  const dependencies = new Map([
    [source.note.path, source.note],
    [target.note.path, target.note],
    ...evidence.map((item) => [item.path, { path: item.path, revision: item.revision }] as const),
  ]);
  const qualifications = [
    "This record copies a previously approved graph edge; saving the note record still requires a separate review and does not independently verify the relationship.",
    `Legacy edge ${parsedEdge.id} was stored with source ${row.source}, contributor ${typeof row.agent === "string" ? row.agent : "unknown"}, and approver ${typeof row.approvedBy === "string" ? row.approvedBy : "unknown"}.`,
  ];
  if (evidence.length > 0)
    qualifications.push("Only the cited passages were current when this retention proposal was prepared.");
  else if (connection.evidenceState === "stale")
    qualifications.push("The previous exact evidence is stale and was not copied as current support.");
  else
    qualifications.push("No current exact source passage was available from the stored relationship.");
  const record = {
    kind: "relationship" as const,
    status: "provisional" as const,
    statement,
    attribution: {
      kind: "software" as const,
      id: recordId,
      label: "Notient legacy relationship retention",
    },
    evidence: evidence.map((source) => ({
      source,
      relation: "reports" as const,
      assessment: "source-assertion" as const,
    })),
    qualifications,
    relationships: [
      {
        target: targetPath,
        relation: parsedEdge.table,
        meaning: `${parsedEdge.table}: ${statement}`,
        provenance: row.source === "user" ? ("authored" as const) : ("inferred" as const),
        evidence,
      },
    ],
    dependencies: [...dependencies.values()],
    feedback: null,
  };
  const append = prepareIntelligenceAppend(source.body, section, [record]);
  if (!append.text)
    throw new NoteApiError("CONFLICT", "the relationship record is already present in the note");

  const requestKey =
    input.idempotencyKey ??
    contentRevision(`${caller.id}:${parsedEdge.id}:${source.note.revision}:${target.note.revision}`);
  const previewKey = contentRevision(`relationship-retention-preview:${caller.id}:${requestKey}`);
  const reviewKey = contentRevision(`relationship-retention-review:${caller.id}:${requestKey}`);
  const preview = await options.changes.preview(
    {
      idempotencyKey: previewKey,
      changes: [{ kind: "append", source: source.note, text: append.text }],
    },
    caller,
  );
  signal?.throwIfAborted();
  const proposal = await options.approvals.submitReview(
    {
      previewId: preview.previewId,
      previewRevision: preview.revision,
      rationale: `Retain the previously approved ${parsedEdge.table} graph edge as a durable note record. The note change remains subject to a separate review; no new relationship authority is granted.`,
      evidence,
      idempotencyKey: reviewKey,
    },
    caller,
    options.changes,
  );
  return {
    ok: true,
    status: "proposal-created",
    edgeId: parsedEdge.id,
    relation: parsedEdge.table,
    sourcePath,
    targetPath,
    evidenceState: connection.evidenceState,
    recordId: intelligenceRecordId(record),
    previewId: preview.previewId,
    previewRevision: preview.revision,
    proposal,
  };
}

async function readAppliedRelationship(
  db: Surreal,
  table: WritebackEdgeTable,
  id: RecordId<WritebackEdgeTable>,
): Promise<RelationshipRow> {
  const [rows] = await db
    .query<[Array<RelationshipRow>]>(
      `SELECT id, in.path AS fromPath, out.path AS toPath, source, agent, approved_by AS approvedBy, approved, applied FROM ${table} WHERE id = $id LIMIT 2;`,
      { id },
    )
    .collect<[Array<RelationshipRow>]>();
  if (rows.length === 0) throw new NoteApiError("NOT_FOUND", "relationship edge does not exist");
  if (
    rows.length !== 1 ||
    !(rows[0]?.id instanceof RecordId) ||
    rows[0].id.toString() !== id.toString()
  )
    throw new NoteApiError("INTERNAL_ERROR", "relationship storage returned an invalid edge row");
  return rows[0];
}
