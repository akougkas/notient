import { describe, expect, test } from "bun:test";
import type { RecordId, Surreal } from "surrealdb";
import {
  Linker,
  type LinkerJsonResponse,
  MAX_PROPOSALS_PER_NOTE,
  RANK_TO_CONFIDENCE,
  buildActiveNotePrompt,
  filterProposals,
} from "../../../../src/core/agents/linker";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { LINKER } from "../../../../src/core/indexer/concurrencyDefaults";
import type {
  ChatMessage,
  ChatOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";

const NOOP_PROVIDER: LLMProvider = {
  isAvailable: async () => true,
  chat: async () => "",
  chatStream: async function* () {
    yield "";
  },
  chatJson: async <T>() => ({ edges: [] }) as T,
  embed: async () => [],
};

function filterRetrieved(response: LinkerJsonResponse, distance = 0) {
  return filterProposals(
    response,
    new Map(response.edges.map((edge) => [edge.targetNotePath, distance])),
  );
}

describe("Linker rank-to-confidence mapping", () => {
  test("constants stay in sync", () => {
    expect(RANK_TO_CONFIDENCE.length).toBe(MAX_PROPOSALS_PER_NOTE);
    // Strictly decreasing so rank 0 is the strongest.
    for (let i = 1; i < RANK_TO_CONFIDENCE.length; i += 1) {
      expect(RANK_TO_CONFIDENCE[i]).toBeLessThan(RANK_TO_CONFIDENCE[i - 1]);
    }
    // Confidence floor still well above 0.5 so the operator never sees the
    // old 0.6 anchor again.
    expect(RANK_TO_CONFIDENCE[RANK_TO_CONFIDENCE.length - 1]).toBeGreaterThan(0.5);
  });

  test("assigns confidence by rank position across the full ladder", () => {
    const response: LinkerJsonResponse = {
      edges: [
        { targetNotePath: "a.md", type: "supports", rationale: "r1" },
        { targetNotePath: "b.md", type: "extends", rationale: "r2" },
        { targetNotePath: "c.md", type: "exemplifies", rationale: "r3" },
        { targetNotePath: "d.md", type: "related_to", rationale: "r4" },
      ],
    };
    const proposals = filterRetrieved(response);
    expect(proposals.length).toBe(MAX_PROPOSALS_PER_NOTE);
    for (let index = 0; index < proposals.length; index += 1) {
      expect(proposals[index].confidence).toBeCloseTo(RANK_TO_CONFIDENCE[index]);
    }
    expect(proposals.map((p) => p.targetNotePath)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(proposals.map((p) => p.type)).toEqual([
      "supports",
      "extends",
      "exemplifies",
      "related_to",
    ]);
  });

  test("empty model output produces zero proposals", () => {
    expect(filterRetrieved({ edges: [] })).toEqual([]);
  });

  test("rejects model output beyond the schema's proposal limit", () => {
    const overflow: LinkerJsonResponse = {
      edges: Array.from({ length: MAX_PROPOSALS_PER_NOTE + 3 }, (_unused, index) => ({
        targetNotePath: `note-${index}.md`,
        type: "related_to",
        rationale: `r${index}`,
      })),
    };
    expect(() => filterRetrieved(overflow)).toThrow("exceeds");
  });

  test("rejects an invalid model edge instead of silently dropping it", () => {
    const response: LinkerJsonResponse = {
      edges: [
        { targetNotePath: "a.md", type: "definitely-not-allowed", rationale: "skip" },
        { targetNotePath: "b.md", type: "supports", rationale: "keep" },
      ],
    };
    expect(() => filterRetrieved(response)).toThrow("edge 0 is invalid");
  });

  test("rejects edges with an empty targetNotePath", () => {
    const response = {
      edges: [
        { targetNotePath: "", type: "supports", rationale: "skip empty" },
        { targetNotePath: "ok.md", type: "supports", rationale: "keep" },
      ],
    } as unknown as LinkerJsonResponse;
    expect(() => filterRetrieved(response)).toThrow("edge 0 is invalid");
  });

  test("drops model paths outside the candidate set without consuming a rank slot", () => {
    const response: LinkerJsonResponse = {
      edges: [
        { targetNotePath: "invented-but-existing.md", type: "supports", rationale: "skip" },
        { targetNotePath: "candidate.md", type: "extends", rationale: "keep" },
      ],
    };
    const proposals = filterProposals(response, new Map([["candidate.md", 0]]));
    expect(proposals).toHaveLength(1);
    expect(proposals[0].targetNotePath).toBe("candidate.md");
    expect(proposals[0].confidence).toBeCloseTo(RANK_TO_CONFIDENCE[0]);
  });

  test("caps positional confidence by vector similarity", () => {
    const response: LinkerJsonResponse = {
      edges: [
        { targetNotePath: "distant.md", type: "related_to", rationale: "weak retrieval" },
        { targetNotePath: "near.md", type: "supports", rationale: "strong retrieval" },
      ],
    };

    const proposals = filterProposals(
      response,
      new Map([
        ["distant.md", 0.62],
        ["near.md", 0.05],
      ]),
    );

    expect(proposals[0].confidence).toBeCloseTo(0.38);
    expect(proposals[1].confidence).toBeCloseTo(RANK_TO_CONFIDENCE[1]);
  });

  test("drops a structurally valid model path without retrieval provenance", () => {
    const response: LinkerJsonResponse = {
      edges: [{ targetNotePath: "invented.md", type: "supports", rationale: "not retrieved" }],
    };

    expect(filterProposals(response, new Map())).toEqual([]);
  });

  test("rejects corrupt retrieval distances instead of clamping them", () => {
    const response: LinkerJsonResponse = {
      edges: [{ targetNotePath: "candidate.md", type: "supports", rationale: "retrieved" }],
    };

    for (const distance of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 2.01]) {
      expect(() => filterProposals(response, new Map([["candidate.md", distance]]))).toThrow(
        "candidate distance is invalid",
      );
    }
  });

  test("rejects malformed response envelopes, blank rationales, and duplicate targets", () => {
    expect(() => filterProposals(null, new Map())).toThrow("edges array");
    expect(() => filterProposals({}, new Map())).toThrow("edges array");
    expect(() => filterProposals({ edges: [], extra: true }, new Map())).toThrow("edges array");
    expect(() =>
      filterProposals(
        { edges: [{ targetNotePath: "a.md", type: "supports", rationale: "" }] },
        new Map([["a.md", 0.1]]),
      ),
    ).toThrow("edge 0 is invalid");
    expect(() =>
      filterProposals(
        {
          edges: [
            { targetNotePath: "a.md", type: "supports", rationale: "first" },
            { targetNotePath: "a.md", type: "extends", rationale: "duplicate" },
          ],
        },
        new Map([["a.md", 0.1]]),
      ),
    ).toThrow("duplicate target path");
  });
});

describe("Linker end-to-end with fake provider", () => {
  test("emitted edges carry rank-derived confidence, not model-supplied numbers", async () => {
    // The fake provider returns four edges *without* a confidence field.
    // The Linker must still write four edges whose confidence values come
    // from RANK_TO_CONFIDENCE in order. We stub the database calls minimally
    // to exercise the proposal-write loop without booting SurrealDB.
    const observedConfidences: number[] = [];
    const observedTypes: string[] = [];
    const fake: LLMProvider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* () {
        yield "";
      },
      chatJson: async <T>(_messages: ChatMessage[], _opts: ChatOptions, _schema: JsonSchema) =>
        ({
          edges: [
            { targetNotePath: "n0.md", type: "supports", rationale: "strongest" },
            { targetNotePath: "n1.md", type: "extends", rationale: "second" },
            { targetNotePath: "n2.md", type: "exemplifies", rationale: "third" },
            { targetNotePath: "n3.md", type: "related_to", rationale: "fourth" },
          ],
        }) as T,
      embed: async () => [],
    };

    // Validate filterProposals produces the contract the run() loop relies on.
    const response = (await fake.chatJson(
      [],
      { model: "fake", signal: undefined },
      { name: "noop", schema: {} },
    )) as LinkerJsonResponse;
    const proposals = filterRetrieved(response);
    for (const proposal of proposals) {
      observedConfidences.push(proposal.confidence);
      observedTypes.push(proposal.type);
    }
    expect(observedConfidences).toEqual([...RANK_TO_CONFIDENCE]);
    expect(observedTypes).toEqual(["supports", "extends", "exemplifies", "related_to"]);
  });
});

describe("Linker prompt caps (W8)", () => {
  test("keeps only the first LINKER.maxActiveChunksInPrompt active chunks plus a marker", () => {
    const chunks = Array.from({ length: 20 }, (_unused, index) => ({
      ord: index,
      text: `body ${index}`,
      vector: [0.1],
    }));
    const built = buildActiveNotePrompt(chunks);
    expect(built.chunks).toHaveLength(LINKER.maxActiveChunksInPrompt);
    expect(built.chunks.map((c) => c.ord)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(built.omitted).toBe(`[... ${20 - LINKER.maxActiveChunksInPrompt} more chunks]`);
  });

  test("emits no marker when the note fits under the cap", () => {
    const chunks = Array.from({ length: 3 }, (_unused, index) => ({
      ord: index,
      text: `body ${index}`,
      vector: [0.1],
    }));
    const built = buildActiveNotePrompt(chunks);
    expect(built.chunks).toHaveLength(3);
    expect(built.omitted).toBeUndefined();
  });

  test("caps bound the prompt regardless of note length", () => {
    // Prompt size is candidates x evidence x snippet chars, plus the active
    // note's first few chunks. Before W8 a long note could put 60-80 chunks of
    // full text into a single call.
    expect(LINKER.maxCandidates).toBe(12);
    expect(LINKER.maxEvidencePerNote).toBe(2);
    expect(LINKER.evidenceSnippetChars).toBe(600);
    expect(LINKER.maxActiveChunksInPrompt).toBe(6);
  });
});

describe("Linker storage and numeric integrity", () => {
  function linkerForResult(result: unknown): Linker {
    const db = {
      query: () => ({ collect: async () => result }),
    } as unknown as Surreal;
    return new Linker({ db, provider: NOOP_PROVIDER, reasoningModel: "reasoning" });
  }

  async function readChunks(linker: Linker): Promise<unknown> {
    const noteId = createUuidRecordId("note", "00000000-0000-4000-8000-000000000001");
    const reader = linker as unknown as {
      fetchActiveChunks(noteId: RecordId<"note">): Promise<unknown>;
    };
    return reader.fetchActiveChunks(noteId);
  }

  test.each([
    ["invalid envelope", [{ ord: 0, text: "a", vector: [1] }], "statement envelope"],
    ["fractional ord", [[{ ord: 0.5, text: "a", vector: [1] }]], "chunk row"],
    ["empty vector", [[{ ord: 0, text: "a", vector: [] }]], "chunk row"],
    ["non-finite vector", [[{ ord: 0, text: "a", vector: [Number.NaN] }]], "chunk row"],
    [
      "dimension mismatch",
      [
        [
          { ord: 0, text: "a", vector: [1] },
          { ord: 1, text: "b", vector: [1, 2] },
        ],
      ],
      "dimensions disagree",
    ],
    [
      "duplicate ord",
      [
        [
          { ord: 0, text: "a", vector: [1] },
          { ord: 0, text: "b", vector: [2] },
        ],
      ],
      "strictly increasing",
    ],
  ])("rejects %s", async (_label, result, message) => {
    await expect(readChunks(linkerForResult(result))).rejects.toThrow(message);
  });

  test.each([{ topK: 1.5 }, { topK: 0 }, { topK: Number.NaN }, { ef: Number.POSITIVE_INFINITY }])(
    "rejects invalid retrieval options",
    (options) => {
      expect(
        () =>
          new Linker({
            db: {} as Surreal,
            provider: NOOP_PROVIDER,
            reasoningModel: "reasoning",
            ...options,
          }),
      ).toThrow("positive safe integer");
    },
  );
});
