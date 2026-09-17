import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { proposalRelationRecordId } from "../../../../src/core/approvals/proposalIdentity";
import { parseProposalEdgeRecordId } from "../../../../src/core/approvals/proposalStorage";
import {
  createUuidRecordId,
  parseSurrealRelationRecordId,
  parseUuidRecordId,
  stringifyUuidRecordId,
} from "../../../../src/core/db/recordId";

const UUID = "018f05cd-3f7b-7cc2-89fc-0242ac120002";
const HISTORY_ID = `history:u"${UUID}"`;
const EDGE_ID = "supports:8z7li22oizca97c0mwo4";

describe("canonical UUID record ids", () => {
  test("creates and parses SurrealDB's native UUID text form", () => {
    const created = createUuidRecordId("history", UUID);
    expect(created).toBeInstanceOf(RecordId);
    expect(created.toString()).toBe(HISTORY_ID);
    expect(parseUuidRecordId(HISTORY_ID, "history", "historyId").toString()).toBe(HISTORY_ID);
    expect(stringifyUuidRecordId(created, "history")).toBe(HISTORY_ID);
  });

  test.each([
    "history:018f05cd-3f7b-7cc2-89fc-0242ac120002",
    "history:⟨018f05cd-3f7b-7cc2-89fc-0242ac120002⟩",
    'history:u"018F05CD-3F7B-7CC2-89FC-0242AC120002"',
    'note:u"018f05cd-3f7b-7cc2-89fc-0242ac120002"',
    ` ${HISTORY_ID}`,
    `${HISTORY_ID} `,
    'history:u"not-a-uuid"',
  ])("rejects alternate UUID record spelling %s", (raw) => {
    expect(() => parseUuidRecordId(raw, "history", "historyId")).toThrow(
      "canonical history UUID record id",
    );
  });
});

describe("canonical SurrealDB 3.0.5 relation ids", () => {
  const tables = ["supports", "related_to"] as const;

  test("parses the exact native implicit RELATE id", () => {
    const parsed = parseSurrealRelationRecordId(EDGE_ID, tables, "id");
    expect(parsed.table).toBe("supports");
    expect(parsed.recordId).toBeInstanceOf(RecordId);
    expect(parsed.recordId.toString()).toBe(EDGE_ID);
  });

  test("round-trips the deterministic proposal form even for an all-digit digest", () => {
    const id = proposalRelationRecordId(
      "related_to",
      new RecordId("note", "source00000000000001"),
      new RecordId("note", "target00000000003158"),
    );
    expect(id.toString()).toBe("related_to:p36134222559148272229");
    expect(parseSurrealRelationRecordId(id.toString(), tables, "id").recordId.toString()).toBe(
      id.toString(),
    );
    expect(parseProposalEdgeRecordId(id, "related_to").recordId.toString()).toBe(id.toString());
  });

  test.each([
    "supports:short",
    "supports:8Z7LI22OIZCA97C0MWO4",
    "supports:8z7li22oizca97c0mwo4:tail",
    "supports:⟨8z7li22oizca97c0mwo4⟩",
    "supports:`8z7li22oizca97c0mwo4`",
    "contradicts:8z7li22oizca97c0mwo4",
    ` ${EDGE_ID}`,
    `${EDGE_ID} `,
  ])("rejects alternate relation record spelling %s", (raw) => {
    expect(() => parseSurrealRelationRecordId(raw, tables, "id")).toThrow(
      "canonical SurrealDB relation record id",
    );
  });
});
