import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsVault } from "../../../src/adapters/fsVault";
import { NoteCatalogService } from "../../../src/api/catalog";
import { scopeSchema } from "../../../src/api/operations";
import { scopeAllows } from "../../../src/api/scope";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "notient-catalog-"));
  roots.push(root);
  await cp(new URL("../../fixtures/v0.1.0/", import.meta.url), root, { recursive: true });
  return { root, catalog: new NoteCatalogService(new FsVault(root)) };
}
describe("canonical live catalog", () => {
  test("Obsidian tag casing agrees across listing, candidate filtering and permission checks", async () => {
    const { root, catalog } = await fixture();
    await writeFile(
      join(root, "Tagged.md"),
      "---\ntags: [Work, PRIVATE, 日本語]\n---\n# Keep\n#KEEP\n",
    );
    await writeFile(join(root, "Child.md"), "---\ntags: [work/personal]\n---\nChild note.\n");
    const scope = scopeSchema.parse({ tags: ["#wOrK", "日本語"] });
    const listed = await catalog.list({ scope });
    expect(listed.notes.map((note) => note.path)).toEqual(["Tagged.md"]);
    expect(listed.notes[0].tags).toContain("Work");
    expect(scopeAllows(scope, "Tagged.md", listed.notes[0].tags)).toBe(true);
    expect(scopeAllows(scope, "Child.md", ["work/personal", "日本語"])).toBe(false);
    expect(
      await catalog.filterCandidates(
        ["Tagged.md", "Child.md"],
        scope,
        new AbortController().signal,
      ),
    ).toEqual(["Tagged.md"]);
    const excluded = scopeSchema.parse({ ...scope, excludeTags: ["#private"] });
    expect((await catalog.list({ scope: excluded })).notes).toEqual([]);
    expect(
      await catalog.filterCandidates(["Tagged.md"], excluded, new AbortController().signal),
    ).toEqual([]);
    expect(scopeAllows(excluded, "Tagged.md", listed.notes[0].tags)).toBe(false);
    expect(
      scopeAllows(scopeSchema.parse({ tags: ["keep"] }), "Tagged.md", listed.notes[0].tags),
    ).toBe(true);
  });
  test("retrieval inventories paths without parsing unrelated bodies and checks live tag scopes", async () => {
    const { root } = await fixture();
    const vault = new FsVault(root);
    const reads = spyOn(vault, "readBounded");
    const catalog = new NoteCatalogService(vault);
    const signal = new AbortController().signal;
    const candidates = (await vault.listMarkdown()).map((entry) => entry.path);
    expect(
      await catalog.filterCandidates(
        candidates,
        { folders: ["Projects"], excludeFolders: ["History"] },
        signal,
      ),
    ).toEqual(["Projects/Storage.md"]);
    expect(reads).not.toHaveBeenCalled();
    expect(
      await catalog.filterCandidates(
        candidates,
        { folders: ["Projects"], tags: ["systems"] },
        signal,
      ),
    ).toEqual(["Projects/Storage.md"]);
    expect(reads).toHaveBeenCalledTimes(1);
    await writeFile(
      join(root, "Projects/Storage.md"),
      "---\ntags: [private]\n---\nChanged live tags.\n",
    );
    expect(
      await catalog.filterCandidates(
        candidates,
        { folders: ["Projects"], excludeTags: ["private"] },
        signal,
      ),
    ).toEqual([]);
    await expect(catalog.filterCandidates(candidates, {}, AbortSignal.abort())).rejects.toThrow();
    reads.mockRestore();
  });
  test("pages duplicate filenames by canonical path without skips", async () => {
    const { catalog } = await fixture();
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await catalog.list({ limit: 2, ...(cursor ? { cursor } : {}) });
      paths.push(...result.notes.map((note) => note.path));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(paths).toHaveLength(7);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain("Projects/Storage.md");
    expect(paths).toContain("History/Storage.md");
  });
  test("intersects folders, tags and typed properties and honors exclusions", async () => {
    const { catalog } = await fixture();
    const selected = await catalog.list({
      scope: { folders: ["Projects"], tags: ["systems"] },
      properties: { reviewed: false },
    });
    expect(selected.notes.map((note) => note.path)).toEqual(["Projects/Storage.md"]);
    expect(selected.notes[0].revision).toMatch(/^[a-f0-9]{64}$/);
    const excluded = await catalog.list({
      scope: { folders: ["Projects"], excludeTags: ["systems"] },
    });
    expect(excluded.notes).toHaveLength(0);
  });
  test("finds nested filenames without knowing their folder, and intersects query terms with scope", async () => {
    const { catalog } = await fixture();
    const matches = await catalog.list({ query: "sToRaGe" });
    expect(matches.notes.map((note) => note.path)).toEqual([
      "History/Storage.md",
      "Projects/Storage.md",
    ]);
    const scoped = await catalog.list({
      query: "storage  PROJECTS",
      scope: { excludeFolders: ["History"] },
    });
    expect(scoped.notes.map((note) => note.path)).toEqual(["Projects/Storage.md"]);
    expect((await catalog.list({ query: "no matching filename" })).notes).toEqual([]);
    const page = await catalog.list({ query: "storage", limit: 1 });
    await expect(
      catalog.list({ query: "Projects", limit: 1, cursor: page.nextCursor }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  test("rejects changed-inventory and changed-filter cursors", async () => {
    const { root, catalog } = await fixture();
    const first = await catalog.list({ limit: 2 });
    await expect(
      catalog.list({ limit: 2, cursor: first.nextCursor, scope: { folders: ["Projects"] } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await writeFile(join(root, "Added.md"), "# New entry\n");
    await expect(catalog.list({ limit: 2, cursor: first.nextCursor })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
