import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import type { SearchChunkRow } from "../../../../../src/core/db/surreal";
import { dedupeVectorRowsByNote } from "../../../../../src/core/search/strategies/balanced";

function vectorRow(notePath: string, chunk: string, distance: number): SearchChunkRow {
  return {
    chunkId: new RecordId("chunk", chunk),
    noteId: new RecordId("note", notePath),
    notePath,
    text: `${notePath} ${chunk}`,
    distance,
    bm25Score: null,
  };
}

describe("dedupeVectorRowsByNote", () => {
  test("keeps the closest chunk per note in global distance order", () => {
    const rows = [
      vectorRow("long.md", "long-weaker", 0.4),
      vectorRow("other.md", "other-strongest", 0.2),
      vectorRow("long.md", "long-strongest", 0.1),
      vectorRow("third.md", "third", 0.3),
      vectorRow("other.md", "other-weaker", 0.5),
    ];

    const deduped = dedupeVectorRowsByNote(rows);

    expect(deduped.map((row) => row.notePath)).toEqual(["long.md", "other.md", "third.md"]);
    expect(deduped.map((row) => row.chunkId.toString())).toEqual([
      new RecordId("chunk", "long-strongest").toString(),
      new RecordId("chunk", "other-strongest").toString(),
      new RecordId("chunk", "third").toString(),
    ]);
  });
});
