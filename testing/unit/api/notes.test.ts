import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { NoteReadService, contentRevision, inspectMarkdown } from "../../../src/api/notes";
import {
  noteReadRequestSchema,
  noteReadResultSchema,
  sourceReferenceSchema,
} from "../../../src/api/schema";

const fixture = (path: string) =>
  readFile(new URL(`../../fixtures/v0.1.0/${path}`, import.meta.url), "utf8");

describe("canonical note reads", () => {
  test("preserves BOM/CRLF and resolves UTF-16 source offsets after Unicode", async () => {
    const body = await fixture("Formats.md");
    const service = new NoteReadService({ read: async () => body });
    const result = await service.read({
      path: "Formats.md",
      selector: { kind: "block", id: "format" },
    });
    expect(noteReadResultSchema.safeParse(result).success).toBe(true);
    expect(result.body).toBe(body);
    expect(result.body.startsWith("\ufeff---\r\n")).toBe(true);
    expect(result.note.revision).toBe(contentRevision(body));
    expect(result.structure.frontmatter.properties?.custom).toBe("keep this");
    expect(result.structure.aliases).toEqual(["Byte preservation"]);
    expect(result.selected?.quote).toBe("Unicode café and CRLF bytes. ^format");
    expect(sourceReferenceSchema.safeParse(result.selected).success).toBe(true);
    expect(result.structure.headings.map((heading) => heading.text)).toEqual([
      "Formatting 😀",
      "Repeat",
      "Repeat",
    ]);
  });

  test("duplicate headings conflict and occurrence selects the exact section", async () => {
    const body = await fixture("Projects/Storage.md");
    const service = new NoteReadService({ read: async () => body });
    await expect(
      service.read({
        path: "Projects/Storage.md",
        selector: { kind: "heading", text: "Decision" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const result = await service.read({
      path: "Projects/Storage.md",
      selector: { kind: "heading", text: "Decision", occurrence: 2 },
    });
    expect(result.selected?.quote.startsWith("## Decision\nDerived indexes")).toBe(true);
    expect(result.selected?.quote).not.toContain("Use local Markdown");
  });

  test("exposes real structure and links without inventing fenced-code references", async () => {
    const body = await fixture("Projects/Storage.md");
    const structure = inspectMarkdown(body);
    expect(structure.headings).toHaveLength(3);
    expect(structure.blocks.map((block) => block.id)).toEqual(["replicas"]);
    expect(structure.tasks.map((task) => task.checked)).toEqual([false, true]);
    expect(structure.callouts[0]).toMatchObject({ kind: "warning", title: "Recovery" });
    expect(structure.tags).toEqual(["systems", "design/storage", "durability"]);
    expect(structure.links).toHaveLength(4);
    for (const link of structure.links) {
      expect(body.slice(link.range.start, link.range.end)).toContain(link.target);
    }
    expect(structure.links[0]).toMatchObject({
      target: "History/Storage",
      heading: "Policy",
      alias: "previous policy",
    });
    expect(structure.links[1].block).toBe("replicas");
    expect(structure.links[2].embed).toBe(true);
  });

  test("read reflects new file bytes, marks index lag and refuses stale range requests", async () => {
    let body = "# Current\nOld evidence.";
    const old = contentRevision(body);
    const service = new NoteReadService({ read: async () => body }, async () => old);
    expect((await service.read({ path: "Note.md" })).freshness.state).toBe("current");
    body = "# Current\nNew evidence.";
    const current = await service.read({ path: "Note.md" });
    expect(current.body).toContain("New evidence");
    expect(current.freshness).toMatchObject({ state: "lagging", indexedRevision: old });
    await expect(
      service.read({
        path: "Note.md",
        revision: old,
        selector: { kind: "range", start: 0, end: 5 },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      noteReadRequestSchema.safeParse({
        path: "Note.md",
        selector: { kind: "range", start: 0, end: 5 },
      }).success,
    ).toBe(false);
  });

  test("refuses invalid paths, selectors and duplicate explicit IDs without arbitrary selection", async () => {
    let reads = 0;
    const service = new NoteReadService({
      read: async () => {
        reads++;
        return "First ^same\n\nSecond ^same\n";
      },
    });
    for (const path of [
      "../secret.md",
      "a/../b.md",
      ".private.md",
      "Notient/conversations/a.md",
      "/a.md",
    ]) {
      await expect(service.read({ path })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    }
    expect(reads).toBe(0);
    await expect(
      service.read({ path: "Note.md", selector: { kind: "block", id: "same" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      service.read({ path: "Note.md", selector: { kind: "heading", text: "Absent" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("tags follow Obsidian's grammar across properties, headings and body text", () => {
    const body =
      '---\ntags: [Project, "#alpha", "not a tag", "-dash"]\n---\n# Plan #HeadTag\n\nSee #Café, #日本語 and #📚reading. \\#escaped #123 `#code` https://x.org/#frag word#no\n';
    expect(inspectMarkdown(body).tags).toEqual([
      "Project",
      "alpha",
      "HeadTag",
      "Café",
      "日本語",
      "📚reading",
    ]);
  });

  test("an absent note is NOT_FOUND while other read failures propagate", async () => {
    const missing = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    await expect(
      new NoteReadService({ read: async () => Promise.reject(missing) }).read({ path: "Gone.md" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "note does not exist" });
    const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    await expect(
      new NoteReadService({ read: async () => Promise.reject(denied) }).read({ path: "Locked.md" }),
    ).rejects.toBe(denied);
  });

  test("malformed frontmatter remains readable with a visible parse error", () => {
    const structure = inspectMarkdown("---\ninvalid: [\n---\n# Authored\nKeep these bytes.\n");
    expect(structure.frontmatter.error).not.toBeNull();
    expect(structure.frontmatter.raw).toBe("invalid: [\n");
    expect(structure.headings[0].text).toBe("Authored");
  });
});
