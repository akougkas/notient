import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import type { SearchChunkRow } from "../../../../../src/core/db/surreal";
import { dedupeByNote, fuseHybridRows } from "../../../../../src/core/search/strategies/deep";

function chunkRow(notePath: string, ord: number): SearchChunkRow {
  return {
    chunkId: new RecordId("chunk", `${notePath}-${ord}`),
    noteId: new RecordId("note", notePath),
    notePath,
    text: `${notePath} chunk ${ord}`,
    distance: ord / 100,
    bm25Score: null,
  };
}

describe("dedupeByNote", () => {
  test("one long note cannot fill every slot", () => {
    // A long note contributes the top five fused candidates; a second note
    // only reaches rank six. Deduping by chunk id alone let the first note
    // occupy the whole topK window and hide every other note in the vault.
    const knn = [
      chunkRow("long.md", 0),
      chunkRow("long.md", 1),
      chunkRow("long.md", 2),
      chunkRow("long.md", 3),
      chunkRow("long.md", 4),
      chunkRow("other.md", 0),
    ];
    const fused = fuseHybridRows(knn, []);
    expect(fused).toHaveLength(6);

    const deduped = dedupeByNote(fused);
    expect(deduped.map((row) => row.notePath)).toEqual(["long.md", "other.md"]);
    // The surviving chunk for the long note is its best-scoring one.
    expect(deduped[0].chunkId.toString()).toBe(fused[0].chunkId.toString());
  });
});
