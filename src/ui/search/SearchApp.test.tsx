import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { SearchEvent, SearchHit, SearchQuery } from "../../core/search/types";
import { SearchApp } from "./SearchApp";
import {
  dispatchSearch,
  resetSearchState,
  searchError,
  searchFilters,
  searchHits,
  searchMode,
  searchPreviewPath,
  searchQuery,
  searchResult,
  searchSynthesis,
  setSearchRunner,
} from "./state";

function fakeHit(notePath: string, snippet: string, score: number): SearchHit {
  return {
    notePath,
    chunkId: null,
    snippet,
    score,
    matchedText: snippet,
  };
}

describe("SearchApp", () => {
  test("renders empty state with no hits", () => {
    resetSearchState();
    const html = render(<SearchApp />);
    expect(html).toContain("notient-search-app");
    expect(html).toContain("notient-search-empty");
    expect(html).toContain("Quick");
    expect(html).toContain("Balanced");
    expect(html).toContain("Deep");
  });

  test("renders synthesis card when synthesis is present", () => {
    resetSearchState();
    searchSynthesis.value = {
      bullets: [{ text: "first claim", citations: ["[[a]]"] }],
      rawText: "",
    };
    const html = render(<SearchApp />);
    expect(html).toContain("notient-synthesis-card");
    expect(html).toContain("first claim");
    expect(html).toContain("[[a]]");
  });

  test("renders results when hits are present", () => {
    resetSearchState();
    searchSynthesis.value = null;
    searchHits.value = [fakeHit("notes/a.md", "matched body", 0.42)];
    const html = render(<SearchApp />);
    expect(html).toContain("notes/a.md");
    expect(html).toContain("matched body");
    expect(html).toContain("notient-result-row");
  });

  test("highlights query terms in the preview pane", () => {
    resetSearchState();
    searchQuery.value = "alpha";
    searchHits.value = [fakeHit("notes/a.md", "alpha and beta", 0.5)];
    searchPreviewPath.value = "notes/a.md";
    const html = render(<SearchApp />);
    expect(html).toContain("notient-search-preview__mark");
    expect(html).toContain(">alpha<");
  });

  test("filter chips reflect active maturity filter", () => {
    resetSearchState();
    searchFilters.value = { maturity: ["draft"] };
    const html = render(<SearchApp />);
    const draftActive = /data-value="draft"[^>]*notient-filter-chip--active/.test(html);
    const matureActive = /data-value="mature"[^>]*notient-filter-chip--active/.test(html);
    expect(draftActive).toBe(true);
    expect(matureActive).toBe(false);
  });
});

describe("search state dispatch", () => {
  test("dispatchSearch routes events through the injected runner", async () => {
    resetSearchState();
    const captured: SearchQuery[] = [];
    const events: SearchEvent[] = [
      { type: "search:retrieving", mode: "quick" },
      { type: "search:hits", hits: [fakeHit("notes/x.md", "snippet x", 0.7)] },
      {
        type: "search:done",
        result: {
          query: "alpha",
          mode: "quick",
          hits: [fakeHit("notes/x.md", "snippet x", 0.7)],
          durationMs: 1,
        },
      },
    ];
    setSearchRunner(async function* (query: SearchQuery): AsyncIterable<SearchEvent> {
      captured.push(query);
      for (const event of events) {
        yield event;
      }
    });
    searchQuery.value = "alpha";
    searchMode.value = "quick";
    await dispatchSearch();
    expect(captured.length).toBe(1);
    expect(captured[0]?.query).toBe("alpha");
    expect(searchHits.value.length).toBe(1);
    expect(searchResult.value?.hits[0]?.notePath).toBe("notes/x.md");
    expect(searchError.value).toBeNull();
    setSearchRunner(null);
  });

  test("dispatchSearch surfaces errors via searchError", async () => {
    resetSearchState();
    setSearchRunner(async function* (): AsyncIterable<SearchEvent> {
      yield { type: "search:error", message: "boom" };
    });
    searchQuery.value = "alpha";
    await dispatchSearch();
    expect(searchError.value).toBe("boom");
    setSearchRunner(null);
  });

  test("dispatchSearch clears state when query is empty", async () => {
    resetSearchState();
    let calls = 0;
    setSearchRunner(async function* (): AsyncIterable<SearchEvent> {
      calls += 1;
      yield {
        type: "search:done",
        result: { query: "", mode: "quick", hits: [], durationMs: 0 },
      };
    });
    searchQuery.value = "   ";
    await dispatchSearch();
    expect(calls).toBe(0);
    expect(searchHits.value).toEqual([]);
    setSearchRunner(null);
  });
});
