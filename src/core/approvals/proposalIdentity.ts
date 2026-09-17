import { createHash } from "node:crypto";
import { RecordId } from "surrealdb";
import type { WritebackEdgeTable } from "../db/edgeTables";
import { createUuidRecordId } from "../db/recordId";

/** Stable 80-bit identity for one directed, typed note relation. */
export function proposalRelationRecordId(
  relation: WritebackEdgeTable,
  from: RecordId<"note">,
  to: RecordId<"note">,
  evidenceRevision?: string,
): RecordId<WritebackEdgeTable> {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        relation,
        from.toString(),
        to.toString(),
        ...(evidenceRevision === undefined ? [] : [evidenceRevision]),
      ]),
    )
    .digest("hex")
    .slice(0, 20);
  // The alphabetic prefix is semantic, not entropy. It prevents an all-digit
  // digest from being serialized by SurrealDB as a bracketed numeric key.
  return new RecordId(relation, `p${digest}`);
}

/** Durable write-ahead intent for one accepted canonical proposal relation. */
export async function proposalApprovalIntentId(
  edgeId: RecordId,
): Promise<RecordId<"approval_intent">> {
  return await deterministicProposalUuid("approval_intent", "approve.intent", edgeId);
}

/** Deterministic acceptance receipt for one canonical proposal relation. */
export async function proposalAcceptanceHistoryId(edgeId: RecordId): Promise<RecordId<"history">> {
  return await deterministicProposalUuid("history", "approve.history", edgeId);
}

/** One watcher-attribution row for every approval write attempt. */
export async function proposalDaemonWriteId(edgeId: RecordId): Promise<RecordId<"daemon_write">> {
  return await deterministicProposalUuid("daemon_write", "approve.daemon_write", edgeId);
}

/** Deterministic rejection tombstone for one canonical proposal relation. */
export async function proposalRejectionHistoryId(edgeId: RecordId): Promise<RecordId<"history">> {
  return await deterministicProposalUuid("history", "reject", edgeId);
}

async function deterministicProposalUuid<TableName extends string>(
  table: TableName,
  operation: string,
  edgeId: RecordId,
): Promise<RecordId<TableName>> {
  // RFC 9562 UUIDv5 under the standard URL namespace.
  const namespace = new Uint8Array([
    0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
  ]);
  const name = new TextEncoder().encode(`notient:proposal.${operation}:${edgeId.toString()}`);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return createUuidRecordId(
    table,
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}
