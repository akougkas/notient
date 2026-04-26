import { describe, expect, test } from "bun:test";
import { NativeGraphBridge, type RelatedRelation } from "./nativeGraphBridge";

interface FacadeRecord {
  reads: string[];
  writes: { path: string; content: string }[];
  frontmatterPatches: { path: string; patch: Record<string, unknown> }[];
  echoMarks: { path: string; sha: string }[];
}

function makeFacade(initial: Record<string, string>) {
  const record: FacadeRecord = { reads: [], writes: [], frontmatterPatches: [], echoMarks: [] };
  const files = new Map(Object.entries(initial));
  return {
    record,
    facade: {
      readNote: async (path: string) => {
        record.reads.push(path);
        return files.get(path) ?? "";
      },
      writeNote: async (path: string, content: string) => {
        record.writes.push({ path, content });
        files.set(path, content);
      },
      updateFrontmatter: async (path: string, patch: Record<string, unknown>) => {
        record.frontmatterPatches.push({ path, patch });
      },
    },
    echoGuard: {
      mark: (path: string, sha: string) => {
        record.echoMarks.push({ path, sha });
      },
    },
    hash: async (content: string) => `sha-${content.length}`,
  };
}

describe("NativeGraphBridge", () => {
  test("LINKS_TO writeback adds a Related section + EchoGuard mark", async () => {
    const harness = makeFacade({ "/source.md": "# Source\n\nBody.\n" });
    const bridge = new NativeGraphBridge({
      facade: harness.facade,
      echoGuard: harness.echoGuard,
      hash: harness.hash,
      settings: () => ({
        writeRelatedSection: true,
        writeFrontmatterRelations: true,
        relatedSectionHeading: "Related",
      }),
    });
    await bridge.applyApprovedLink({
      sourcePath: "/source.md",
      targetPath: "/target.md",
      agent: "linker",
    });
    expect(harness.record.writes).toHaveLength(1);
    expect(harness.record.writes[0].content).toContain("## Related");
    expect(harness.record.writes[0].content).toContain("[[target]]");
    expect(harness.record.echoMarks).toHaveLength(1);
    expect(harness.record.echoMarks[0].path).toBe("/source.md");
  });

  test("Typed relation writeback patches frontmatter only", async () => {
    const harness = makeFacade({ "/source.md": "# Source\n\nBody.\n" });
    const bridge = new NativeGraphBridge({
      facade: harness.facade,
      echoGuard: harness.echoGuard,
      hash: harness.hash,
      settings: () => ({
        writeRelatedSection: true,
        writeFrontmatterRelations: true,
        relatedSectionHeading: "Related",
      }),
    });
    const relation: RelatedRelation = {
      sourcePath: "/source.md",
      targetPath: "/target.md",
      relation: "contradicts",
      agent: "contradictionHunter",
    };
    await bridge.applyApprovedRelation(relation);
    expect(harness.record.writes).toHaveLength(0);
    expect(harness.record.frontmatterPatches).toHaveLength(1);
    expect(harness.record.frontmatterPatches[0].patch).toMatchObject({
      notient: { contradicts: ["[[target]]"] },
    });
  });

  test("Setting toggles short-circuit each writeback path", async () => {
    const harness = makeFacade({ "/source.md": "# Source\n\nBody.\n" });
    const bridge = new NativeGraphBridge({
      facade: harness.facade,
      echoGuard: harness.echoGuard,
      hash: harness.hash,
      settings: () => ({
        writeRelatedSection: false,
        writeFrontmatterRelations: false,
        relatedSectionHeading: "Related",
      }),
    });
    await bridge.applyApprovedLink({
      sourcePath: "/source.md",
      targetPath: "/target.md",
      agent: "linker",
    });
    await bridge.applyApprovedRelation({
      sourcePath: "/source.md",
      targetPath: "/target.md",
      relation: "supports",
      agent: "linker",
    });
    expect(harness.record.writes).toHaveLength(0);
    expect(harness.record.frontmatterPatches).toHaveLength(0);
  });

  test("applyApprovedLink marks EchoGuard BEFORE the facade write", async () => {
    const order: string[] = [];
    const harness = makeFacade({ "/source.md": "# Source\n\nBody.\n" });
    const facade = {
      readNote: harness.facade.readNote,
      writeNote: async (path: string, content: string) => {
        order.push("write");
        await harness.facade.writeNote(path, content);
      },
      updateFrontmatter: harness.facade.updateFrontmatter,
    };
    const echoGuard = {
      mark: (path: string, sha: string) => {
        order.push("mark");
        harness.echoGuard.mark(path, sha);
      },
    };
    const bridge = new NativeGraphBridge({
      facade,
      echoGuard,
      hash: harness.hash,
      settings: () => ({
        writeRelatedSection: true,
        writeFrontmatterRelations: true,
        relatedSectionHeading: "Related",
      }),
    });
    await bridge.applyApprovedLink({
      sourcePath: "/source.md",
      targetPath: "/target.md",
      agent: "linker",
    });
    expect(order).toEqual(["mark", "write"]);
  });

  // Documents a known wiring gap: applyApprovedRelation goes through the
  // opaque facade.updateFrontmatter (Obsidian's processFrontMatter under
  // production wiring). The bridge cannot synchronously hash the post-write
  // content from inside this call, so EchoGuard is not marked here. The
  // production indexer-exclusion path covers Notient/* folders; for source
  // notes that receive typed-relation patches the indexer will re-enqueue,
  // but the patched content is byte-identical on a second pass so the
  // chunker short-circuits via sha equality. Task 16 wiring (or a follow-up)
  // should extend the facade contract to return the post-write content so
  // EchoGuard.mark can fire BEFORE the write, matching the contract used by
  // applyApprovedLink. Until then this test pins the current behavior.
  test("applyApprovedRelation currently bypasses EchoGuard (frontmatter facade is opaque)", async () => {
    const harness = makeFacade({ "/source.md": "# Source\n\nBody.\n" });
    const bridge = new NativeGraphBridge({
      facade: harness.facade,
      echoGuard: harness.echoGuard,
      hash: harness.hash,
      settings: () => ({
        writeRelatedSection: true,
        writeFrontmatterRelations: true,
        relatedSectionHeading: "Related",
      }),
    });
    await bridge.applyApprovedRelation({
      sourcePath: "/source.md",
      targetPath: "/target.md",
      relation: "extends",
      agent: "linker",
    });
    expect(harness.record.frontmatterPatches).toHaveLength(1);
    expect(harness.record.echoMarks).toHaveLength(0);
  });

  test("Repeated writeback is idempotent (no duplicate wikilink)", async () => {
    const harness = makeFacade({ "/source.md": "# Source\n\n## Related\n- [[target]]\n" });
    const bridge = new NativeGraphBridge({
      facade: harness.facade,
      echoGuard: harness.echoGuard,
      hash: harness.hash,
      settings: () => ({
        writeRelatedSection: true,
        writeFrontmatterRelations: true,
        relatedSectionHeading: "Related",
      }),
    });
    await bridge.applyApprovedLink({
      sourcePath: "/source.md",
      targetPath: "/target.md",
      agent: "linker",
    });
    expect(harness.record.writes).toHaveLength(0);
  });
});
