import { describe, expect, test } from "bun:test";
import { SearchHistory, type SearchHistoryFacade } from "./searchHistory";

class InMemorySidecar implements SearchHistoryFacade {
  private state: Record<string, unknown> | null = null;

  async readSidecar(): Promise<Record<string, unknown> | null> {
    return this.state ? { ...this.state } : null;
  }

  async writeSidecar(value: Record<string, unknown>): Promise<void> {
    this.state = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }

  raw(): Record<string, unknown> | null {
    return this.state;
  }
}

function makeHistory(maxQueries = 5): { history: SearchHistory; sidecar: InMemorySidecar } {
  const sidecar = new InMemorySidecar();
  const history = new SearchHistory({ facade: sidecar, maxQueries });
  return { history, sidecar };
}

describe("SearchHistory", () => {
  test("record pushes latest first and persists through reload", async () => {
    const { history, sidecar } = makeHistory();
    await history.record({ query: "alpha", mode: "quick", ranAt: 1 });
    await history.record({ query: "beta", mode: "balanced", ranAt: 2 });
    await history.record({ query: "gamma", mode: "deep", ranAt: 3 });

    const list = await history.list();
    expect(list.map((entry) => entry.query)).toEqual(["gamma", "beta", "alpha"]);

    // A fresh instance reading the same sidecar sees the same buffer.
    const reborn = new SearchHistory({ facade: sidecar, maxQueries: 5 });
    const after = await reborn.list();
    expect(after.map((entry) => entry.query)).toEqual(["gamma", "beta", "alpha"]);
    expect(after[0]?.mode).toBe("deep");
  });

  test("max-size cap drops the oldest entries", async () => {
    const { history } = makeHistory(3);
    for (let index = 0; index < 5; index += 1) {
      await history.record({ query: `q${index}`, mode: "quick", ranAt: index });
    }
    const list = await history.list();
    expect(list).toHaveLength(3);
    expect(list.map((entry) => entry.query)).toEqual(["q4", "q3", "q2"]);
  });

  test("dedupes immediate repeats by query+mode without losing distinct entries", async () => {
    const { history } = makeHistory();
    await history.record({ query: "career arc", mode: "quick", ranAt: 1 });
    await history.record({ query: "career arc", mode: "quick", ranAt: 2 });
    await history.record({ query: "career arc", mode: "balanced", ranAt: 3 });
    await history.record({ query: "career arc", mode: "balanced", ranAt: 4 });

    const list = await history.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ query: "career arc", mode: "balanced", ranAt: 4 });
    expect(list[1]).toEqual({ query: "career arc", mode: "quick", ranAt: 2 });
  });

  test("preserves unrelated sidecar keys when writing", async () => {
    const { history, sidecar } = makeHistory();
    await sidecar.writeSidecar({ conversationIndex: { foo: 1 }, searchHistory: [] });
    await history.record({ query: "alpha", mode: "deep", ranAt: 9 });
    const raw = sidecar.raw();
    expect(raw?.conversationIndex).toEqual({ foo: 1 });
    expect(Array.isArray(raw?.searchHistory)).toBe(true);
  });

  test("ignores malformed entries while loading", async () => {
    const { history, sidecar } = makeHistory();
    await sidecar.writeSidecar({
      searchHistory: [
        { query: "valid", mode: "quick", ranAt: 1 },
        { query: 42, mode: "quick", ranAt: 1 },
        { query: "no-mode", ranAt: 1 },
        "not even an object",
      ],
    });
    const list = await history.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.query).toBe("valid");
  });
});
