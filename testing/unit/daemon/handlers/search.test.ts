import { describe, expect, test } from "bun:test";
import type { SearchPipeline } from "../../../../src/core/search/searchPipeline";
import type { SearchEvent } from "../../../../src/core/search/types";
import { makeSearchHandler } from "../../../../src/daemon/handlers/search";

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
      { type: "search:done", result: { hits: [], synthesisCard: null } as never },
    ]);
    const handler = makeSearchHandler({
      pipeline,
      bridgeUp: () => true,
    });
    const lines: string[] = [];
    const result = await handler(
      { query: "hello", mode: "balanced" },
      (line) => lines.push(line),
      "req-1",
    );
    expect(result.ok).toBe(true);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]).event).toBe("search:retrieving");
  });

  test("returns BRIDGE_DOWN for quick mode without bridge", async () => {
    const handler = makeSearchHandler({
      pipeline: makeFakePipeline([]),
      bridgeUp: () => false,
    });
    let thrown: unknown = null;
    try {
      await handler({ query: "x", mode: "quick" }, () => {}, "req-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("BRIDGE_DOWN");
  });

  test("rejects empty query", async () => {
    const handler = makeSearchHandler({
      pipeline: makeFakePipeline([]),
      bridgeUp: () => true,
    });
    let thrown: unknown = null;
    try {
      await handler({ mode: "balanced" }, () => {}, "req-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});
