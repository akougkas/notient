import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { buildDecorationSet } from "./insightsPlugin";

const doc =
  "First paragraph about apples.\n\nSecond paragraph about oranges and bananas in detail.";

describe("buildDecorationSet", () => {
  test("places one widget at the end of each matched paragraph", () => {
    const state = EditorState.create({ doc });
    const set = buildDecorationSet({
      state,
      proposals: [
        {
          id: "p1",
          agent: "linker",
          rationale: "linker matched apples",
          score: 0.9,
          chunkText: "First paragraph about apples.",
        },
        {
          id: "p2",
          agent: "synthesizer",
          rationale: "cluster around oranges",
          score: 0.8,
          chunkText: "Second paragraph about oranges and bananas in detail.",
        },
      ],
      maxPerViewport: 5,
      onClick: () => undefined,
    });
    expect(set.size).toBe(2);
  });

  test("respects maxPerViewport by ranking proposals descending", () => {
    const state = EditorState.create({ doc });
    const proposals = [
      {
        id: "p1",
        agent: "linker",
        rationale: "low",
        score: 0.1,
        chunkText: "First paragraph about apples.",
      },
      {
        id: "p2",
        agent: "synthesizer",
        rationale: "high",
        score: 0.9,
        chunkText: "Second paragraph about oranges and bananas in detail.",
      },
    ];
    const set = buildDecorationSet({
      state,
      proposals,
      maxPerViewport: 1,
      onClick: () => undefined,
    });
    expect(set.size).toBe(1);
  });

  test("returns empty set when no proposals match the document", () => {
    const state = EditorState.create({ doc });
    const set = buildDecorationSet({
      state,
      proposals: [
        {
          id: "p1",
          agent: "linker",
          rationale: "drift",
          score: 0.9,
          chunkText: "TEXT THAT IS NOT IN THE DOC",
        },
      ],
      maxPerViewport: 5,
      onClick: () => undefined,
    });
    expect(set.size).toBe(0);
  });

  test("groups multiple proposals on the same paragraph into a single dot", () => {
    const state = EditorState.create({ doc });
    const proposals = [
      {
        id: "p1",
        agent: "linker",
        rationale: "first",
        score: 0.9,
        chunkText: "First paragraph about apples.",
      },
      {
        id: "p2",
        agent: "synthesizer",
        rationale: "second",
        score: 0.8,
        chunkText: "First paragraph about apples.",
      },
    ];
    const set = buildDecorationSet({
      state,
      proposals,
      maxPerViewport: 5,
      onClick: () => undefined,
    });
    expect(set.size).toBe(1);
  });
});
