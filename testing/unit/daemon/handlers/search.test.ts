import { describe, expect, test } from "bun:test";
import type { SearchPipeline } from "../../../../src/core/search/searchPipeline";
import type { SearchEvent } from "../../../../src/core/search/types";
import { makeSearchHandler } from "../../../../src/daemon/handlers/search";
import { currentCoverageFixture } from "../../../indexingFixture";
import { rpcRequest } from "../../../rpcRequest";

function done(query: string, mode: "quick" | "balanced" | "deep"): SearchEvent {
  return {
    type: "search:done",
    result: { coverage: currentCoverageFixture(), query, mode, hits: [], durationMs: 1 },
  };
}

function makeFakePipeline(events: SearchEvent[]): SearchPipeline {
  return {
    run: async function* () {
      for (const event of events) yield event;
    },
  } as unknown as SearchPipeline;
}

describe("search handler", () => {
  test("forwards balanced mode events", async () => {
    const pipeline = makeFakePipeline([
      { type: "search:retrieving", mode: "balanced" },
      { type: "search:hits", hits: [] },
      done("hello", "balanced"),
    ]);
    const handler = makeSearchHandler({ pipeline, defaultMode: () => "quick" });
    const lines: string[] = [];
    const result = await handler(
      rpcRequest(
        { query: "hello", mode: "balanced" },
        { emit: (line) => lines.push(line), requestId: "req-1" },
      ),
    );
    expect(result.ok).toBe(true);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]).event).toBe("search:retrieving");
  });

  test("runs quick mode without a bridge", async () => {
    const handler = makeSearchHandler({
      pipeline: makeFakePipeline([done("x", "quick")]),
      defaultMode: () => "quick",
    });
    const result = await handler(rpcRequest({ query: "x", mode: "quick" }));
    expect(result.ok).toBe(true);
  });

  test("uses the live settings default mode when mode is absent", async () => {
    const seen: string[] = [];
    const pipeline = {
      run: async function* (query: { mode: string }) {
        seen.push(query.mode);
        yield done("x", "deep");
      },
    } as unknown as SearchPipeline;
    const handler = makeSearchHandler({ pipeline, defaultMode: () => "deep" });
    await handler(rpcRequest({ query: "x" }));
    expect(seen).toEqual(["deep"]);
  });

  test("rejects an unknown mode instead of passing it through", async () => {
    const handler = makeSearchHandler({
      pipeline: makeFakePipeline([]),
      defaultMode: () => "quick",
    });
    let thrown: unknown = null;
    try {
      await handler(rpcRequest({ query: "x", mode: "banana" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test("rejects empty query", async () => {
    const handler = makeSearchHandler({
      pipeline: makeFakePipeline([]),
      defaultMode: () => "quick",
    });
    let thrown: unknown = null;
    try {
      await handler(rpcRequest({ mode: "balanced" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test("rejects null, fractional, oversized, and non-number limits", async () => {
    const handler = makeSearchHandler({
      pipeline: makeFakePipeline([]),
      defaultMode: () => "quick",
    });
    for (const limit of [null, "5", 0, 1.5, 51, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        Promise.resolve().then(() => handler(rpcRequest({ query: "x", limit }))),
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    }
  });

  test("rejects malformed filter aliases and unknown parameters", async () => {
    const handler = makeSearchHandler({
      pipeline: makeFakePipeline([]),
      defaultMode: () => "quick",
    });
    for (const params of [
      { query: "x", mode: null },
      { query: "x", filters: null },
      { query: "x", filters: {} },
      { query: "x", filters: { hasPendingProposals: false } },
      { query: "x", filters: { folders: ["Notes/", "Notes/"] } },
      { query: "x", filters: { maturity: ["future"] } },
      { query: "x", filters: { fromDate: 2, toDate: 1 } },
      { query: "x", legacyMode: "quick" },
    ]) {
      await expect(Promise.resolve().then(() => handler(rpcRequest(params)))).rejects.toMatchObject(
        { code: "INVALID_PARAMS" },
      );
    }
  });

  test("fails when the pipeline omits or duplicates its terminal result", async () => {
    const missing = makeSearchHandler({
      pipeline: makeFakePipeline([{ type: "search:retrieving", mode: "quick" }]),
      defaultMode: () => "quick",
    });
    await expect(missing(rpcRequest({ query: "x" }))).rejects.toThrow("ended without search:done");

    const duplicate = makeSearchHandler({
      pipeline: makeFakePipeline([done("x", "quick"), done("x", "quick")]),
      defaultMode: () => "quick",
    });
    await expect(duplicate(rpcRequest({ query: "x" }))).rejects.toThrow(
      "search:done more than once",
    );
  });

  test("fails on malformed or duplicate terminal hits", async () => {
    const malformed = makeSearchHandler({
      pipeline: makeFakePipeline([
        {
          type: "search:done",
          result: {
            coverage: currentCoverageFixture(),
            query: "x",
            mode: "quick",
            durationMs: 1,
            hits: [
              {
                notePath: "a.md",
                chunkId: null,
                snippet: "a",
                score: 1,
                matchedText: "a",
              },
              {
                notePath: "a.md",
                chunkId: null,
                snippet: "duplicate",
                score: 0.5,
                matchedText: "a",
              },
            ],
          },
        },
      ]),
      defaultMode: () => "quick",
    });
    await expect(malformed(rpcRequest({ query: "x" }))).rejects.toThrow("duplicate note hits");
  });

  test.each([".hidden.md", "notes/private.txt", "notes/../secret.md"])(
    "refuses non-public result path %s at the wire boundary",
    async (notePath) => {
      const handler = makeSearchHandler({
        pipeline: makeFakePipeline([
          {
            type: "search:done",
            result: {
              coverage: currentCoverageFixture(),
              query: "x",
              mode: "quick",
              durationMs: 1,
              hits: [
                {
                  notePath,
                  chunkId: null,
                  snippet: "cached private text",
                  score: 1,
                  matchedText: "private",
                },
              ],
            },
          },
        ]),
        defaultMode: () => "quick",
      });
      await expect(handler(rpcRequest({ query: "x" }))).rejects.toThrow("malformed hit");
    },
  );
});
