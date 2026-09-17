import { expect, test } from "bun:test";
import { unknownIndexingReadiness } from "../../../../src/api/indexing";
import { contentRevision, sourceRange } from "../../../../src/api/notes";
import type { SourceReference } from "../../../../src/api/schema";
import { conversationSources, sourceLabel } from "../../../../src/cli/tui/sources";
import { initialState, reducer } from "../../../../src/cli/tui/store";
import { exploreOpenTarget } from "../../../../src/cli/tui/viewModels";
import type { ChatMessage } from "../../../../src/core/chat/types";

const body = "# Journal\r\n\r\nKeep accepted decisions.\r\nRecover once.";
const source: SourceReference = {
  path: "Research/Journal.md",
  revision: contentRevision(body),
  range: sourceRange(body, 0, body.length),
  quote: body,
};
function result(name: string, data: unknown): ChatMessage {
  return {
    role: "assistant",
    id: "a",
    content: "[[Fabricated.md]]",
    createdAt: 1,
    toolCalls: [{ id: "r", name, args: {} }],
    toolResults: [{ callId: "r", data, status: "ok", durationMs: 1 }],
  };
}
function read(evidence = source): ChatMessage {
  return result("vault.read_note", {
    notePath: evidence.path,
    body: evidence.quote,
    evidence,
    totalLines: 4,
    lineRange: { start: evidence.range.startLine, end: evidence.range.endLine },
    truncated: false,
    structure: null,
    structureOmitted: true,
  });
}
function search(evidence: SourceReference | null, freshness = "current"): ChatMessage {
  return result("vault.search_notes", {
    ok: true,
    mode: "lexical",
    query: "journal",
    durationMs: 1,
    omitted: 0,
    coverage: { state: "unknown", indexing: unknownIndexingReadiness(), message: null },
    hits: [
      {
        note: { path: source.path, revision: source.revision },
        evidence,
        score: 1,
        scoreKind: "bm25",
        freshness: { indexedRevision: source.revision, state: freshness, reason: null },
      },
    ],
  });
}

test("sources keep actual paired reads, replacing contained snippets but retaining separate passages", () => {
  const snippet = { ...source, range: sourceRange(body, 13, 37), quote: body.slice(13, 37) };
  const otherRevision = { ...source, revision: "b".repeat(64) };
  expect(conversationSources([search(snippet), read(), read(), read(otherRevision)])).toEqual([
    source,
    otherRevision,
  ]);
  const second = { ...source, range: sourceRange(body, 39, body.length), quote: body.slice(39) };
  expect(conversationSources([search(snippet), search(second)])).toEqual([snippet, second]);
});

test("model text, unpaired or failed calls, stale search, altered excerpts and previous turns supply no evidence", () => {
  const user: ChatMessage = { role: "user", id: "u", content: "A new question", createdAt: 2 };
  const unpaired = read();
  unpaired.toolResults = [];
  const failed = read();
  if (failed.toolResults?.[0]) failed.toolResults[0].status = "error";
  const wrongTool = read();
  if (wrongTool.toolCalls?.[0]) wrongTool.toolCalls[0].name = "notes.prepare_draft";
  const mismatch = read({ ...source, range: { ...source.range, end: 4 } });
  const duplicate = read();
  duplicate.toolResults?.push({ ...duplicate.toolResults[0]! });
  expect(
    conversationSources([
      read(),
      user,
      unpaired,
      failed,
      wrongTool,
      mismatch,
      duplicate,
      search(source, "lagging"),
      search(null),
      search({ ...source, revision: "c".repeat(64) }),
    ]),
  ).toEqual([]);
});

test("source navigation binds the revision and range, spans more than six items and clears on a new turn", () => {
  const sources = Array.from({ length: 9 }, (_, index) => ({
    ...source,
    path: `Source ${index}.md`,
  }));
  let state = reducer(initialState("/vault"), { type: "ask/sources", sources });
  state = reducer(state, { type: "ask/citationMove", delta: 6 });
  expect(exploreOpenTarget(state)).toEqual({ kind: "source", source: sources[6] });
  state = reducer(state, { type: "ask/line", line: { kind: "user", text: "Next question" } });
  expect(exploreOpenTarget(state)).toBeNull();
  expect(state.ask.sources).toEqual([]);
  expect(sourceLabel({ ...source, path: `${"long".repeat(40)}.md` }, 30)).toEndWith(" · L1–4");
  expect(sourceLabel({ ...source, path: `${"long".repeat(40)}.md` }, 30)).toHaveLength(30);
});
