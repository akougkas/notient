import { describe, expect, test } from "bun:test";
import {
  SavedQueries,
  type SavedQueriesFacade,
  parseSavedQueryMarkdown,
  renderSavedQueryMarkdown,
} from "./savedQueries";
import type { SearchFilters } from "./types";

class InMemoryFacade implements SavedQueriesFacade {
  readonly files = new Map<string, string>();

  async list(folder: string): Promise<string[]> {
    const prefix = `${folder}/`;
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix) && path.endsWith(".md"))
      .sort();
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`missing: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
}

function makeStore(now: () => number = () => 1_000): {
  store: SavedQueries;
  facade: InMemoryFacade;
} {
  const facade = new InMemoryFacade();
  const store = new SavedQueries({ facade, folder: "Notient/searches", now });
  return { store, facade };
}

describe("SavedQueries", () => {
  test("save → list → load roundtrip preserves filters and mode", async () => {
    let nowValue = 5_000;
    const { store, facade } = makeStore(() => nowValue);
    const filters: SearchFilters = {
      maturity: ["draft"],
      folders: ["Projects/"],
      minConfidence: 0.4,
    };

    const saved = await store.save({ query: "career arc", mode: "balanced", filters });
    expect(saved.notePath).toBe("Notient/searches/career-arc.md");
    expect(saved.id).toBe("career-arc");
    expect(saved.savedAt).toBe(5_000);
    expect(saved.lastRunAt).toBeNull();

    nowValue = 7_500;
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.query).toBe("career arc");
    expect(list[0]?.mode).toBe("balanced");
    expect(list[0]?.filters).toEqual(filters);

    // Re-run touches the file.
    await store.touch(saved.id);
    const after = await store.list();
    expect(after[0]?.lastRunAt).toBe(7_500);

    // Stored markdown body keeps the human-readable query for Obsidian search.
    const raw = facade.files.get(saved.notePath) ?? "";
    expect(raw).toContain("# Search · career arc");
    expect(raw).toContain("notient-saved-query");
  });

  test("dedupes by slug so saving the same query overwrites the prior file", async () => {
    let nowValue = 1_000;
    const { store, facade } = makeStore(() => nowValue);
    await store.save({ query: "Career Arc!", mode: "quick", filters: {} });
    nowValue = 2_000;
    await store.save({ query: "career-arc", mode: "deep", filters: {} });

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.mode).toBe("deep");
    expect(list[0]?.savedAt).toBe(2_000);
    expect([...facade.files.keys()]).toEqual(["Notient/searches/career-arc.md"]);
  });

  test("malformed files are skipped without throwing", async () => {
    const { store, facade } = makeStore();
    await store.save({ query: "good", mode: "quick", filters: {} });
    facade.files.set("Notient/searches/broken.md", "no frontmatter here");
    facade.files.set("Notient/searches/half.md", "---\nquery: only\n---\n");

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("good");
  });

  test("filter shape with arrays and JSON-significant chars survives YAML emit", () => {
    const rendered = renderSavedQueryMarkdown({
      id: "tricky",
      query: 'a: "b" and #tag',
      mode: "deep",
      filters: {
        agents: ["chief-of-staff", "note-editor"],
        connectivityTiers: ["sparse", "hub"],
        minConfidence: 0.25,
      },
      savedAt: 12_345,
      lastRunAt: 67_890,
      notePath: "Notient/searches/tricky.md",
    });
    const parsed = parseSavedQueryMarkdown(rendered, "Notient/searches/tricky.md");
    expect(parsed).not.toBeNull();
    expect(parsed?.query).toBe('a: "b" and #tag');
    expect(parsed?.mode).toBe("deep");
    expect(parsed?.filters.agents).toEqual(["chief-of-staff", "note-editor"]);
    expect(parsed?.filters.connectivityTiers).toEqual(["sparse", "hub"]);
    expect(parsed?.filters.minConfidence).toBe(0.25);
    expect(parsed?.lastRunAt).toBe(67_890);
  });

  test("remove deletes the underlying file", async () => {
    const { store, facade } = makeStore();
    const saved = await store.save({ query: "to delete", mode: "quick", filters: {} });
    expect(facade.files.has(saved.notePath)).toBe(true);
    await store.remove(saved.id);
    expect(facade.files.has(saved.notePath)).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });
});
