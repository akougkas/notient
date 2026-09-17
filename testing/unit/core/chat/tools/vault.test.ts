import { describe, expect, test } from "bun:test";
import { ToolValidationError } from "../../../../../src/core/chat/tools/registry";
import {
  type VaultFacade,
  makeGetVitalsTool,
  makeListNeighborsTool,
  makeReadNoteTool,
  makeVaultSearchTool,
} from "../../../../../src/core/chat/tools/vault";
import type { VitalsSnapshot } from "../../../../../src/core/vitals/types";
import type { VitalsService } from "../../../../../src/core/vitals/vitalsService";
import { currentCoverageFixture } from "../../../../indexingFixture";

const TEST_CONTEXT = { clientIdentity: "human" } as const;

class InMemoryFacade implements VaultFacade {
  isIndexablePath() {
    return true;
  }
  readBounded(path: string) {
    return this.read(path);
  }
  constructor(private readonly files: Map<string, string>) {}
  async read(filePath: string): Promise<string> {
    const value = this.files.get(filePath);
    if (value === undefined) throw new Error(`not found: ${filePath}`);
    return value;
  }
}

describe("vault.search_notes", () => {
  test("forwards trusted scope and cancellation through canonical retrieval", async () => {
    let seen: unknown;
    const controller = new AbortController();
    const tool = makeVaultSearchTool({
      retrieve: async (input, signal) => {
        expect(signal).toBe(controller.signal);
        seen = input;
        return {
          ok: true,
          query: "auth",
          mode: "lexical",
          hits: [],
          omitted: 0,
          durationMs: 1,
          coverage: currentCoverageFixture(),
        };
      },
    });
    await tool.invoke({ query: "auth", mode: "lexical" }, controller.signal, {
      ...TEST_CONTEXT,
      noteScope: { folders: ["Work"], excludeTags: ["private"] },
    });
    expect(seen).toEqual({
      query: "auth",
      mode: "lexical",
      limit: 8,
      scope: { folders: ["Work"], excludeTags: ["private"] },
    });
    for (const args of [
      { query: "x", mode: "deep" },
      { query: "x", mode: "lexical", scope: {} },
      { query: "x", mode: "lexical", limit: 21 },
    ])
      expect(() => tool.validate(args)).toThrow();
  });
  test("retrieval failure remains an error", async () => {
    const tool = makeVaultSearchTool({
      retrieve: async () => {
        throw new Error("index unavailable");
      },
    });
    await expect(
      tool.invoke({ query: "x", mode: "lexical" }, new AbortController().signal, TEST_CONTEXT),
    ).rejects.toThrow("index unavailable");
  });
});

describe("vault.read_note", () => {
  test("scope excludes paths before reading and checks live tags before releasing content", async () => {
    let reads = 0;
    const tool = makeReadNoteTool({
      isIndexablePath: () => true,
      read: async () => "",
      readBounded: async () => {
        reads++;
        return "---\ntags: [private]\n---\nsecret";
      },
    });
    const signal = new AbortController().signal;
    await expect(
      tool.invoke({ notePath: "Other/a.md" }, signal, {
        ...TEST_CONTEXT,
        noteScope: { folders: ["Work"] },
      }),
    ).rejects.toThrow("outside the allowed read scope");
    expect(reads).toBe(0);
    await expect(
      tool.invoke({ notePath: "Work/a.md" }, signal, {
        ...TEST_CONTEXT,
        noteScope: { excludeTags: ["private"] },
      }),
    ).rejects.toThrow("outside the allowed read scope");
    expect(reads).toBe(1);
  });
  test("preserves CRLF evidence offsets and bounds oversized notes without pretending completeness", async () => {
    const body = `# Title\r\nfirst\r\nsecond\r\n${"x".repeat(13000)}`;
    const tool = makeReadNoteTool(new InMemoryFacade(new Map([["a.md", body]])));
    const result = await tool.invoke(
      { notePath: "a.md", lineRange: { start: 2, end: 3 } },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.body).toBe("first\r\nsecond");
    expect(body.slice(result.evidence.range.start, result.evidence.range.end)).toBe(
      result.evidence.quote,
    );
    const bounded = await tool.invoke(
      { notePath: "a.md" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(bounded.body.length).toBe(12000);
    expect(bounded.truncated).toBe(true);
    await expect(
      tool.invoke(
        { notePath: "a.md", revision: "0".repeat(64) },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
    ).rejects.toThrow("revision changed");
  });

  test("returns full body when no lineRange is provided", async () => {
    const facade = new InMemoryFacade(new Map([["a.md", "line1\nline2\nline3"]]));
    const tool = makeReadNoteTool(facade);
    const result = await tool.invoke(
      { notePath: "a.md" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.body).toBe("line1\nline2\nline3");
    expect(result.totalLines).toBe(3);
    expect(result.lineRange).toEqual({ start: 1, end: 3 });
    expect(result.evidence.quote).toBe(result.body);
  });

  test("returns the requested 1-based inclusive lineRange", async () => {
    const facade = new InMemoryFacade(new Map([["a.md", "a\nb\nc\nd"]]));
    const tool = makeReadNoteTool(facade);
    const result = await tool.invoke(
      { notePath: "a.md", lineRange: { start: 2, end: 3 } },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.body).toBe("b\nc");
    expect(result.lineRange).toEqual({ start: 2, end: 3 });
    expect(result.totalLines).toBe(4);
  });

  test("rejects invalid lineRange", async () => {
    const facade = new InMemoryFacade(new Map([["a.md", "a\nb\nc"]]));
    const tool = makeReadNoteTool(facade);
    expect(() => tool.validate({ notePath: "a.md", lineRange: { start: 0, end: 2 } })).toThrow();
    expect(() => tool.validate({ notePath: "a.md", lineRange: { start: 5, end: 2 } })).toThrow();
    expect(() => tool.validate({ notePath: "a.md", lineRange: { start: 1.5, end: 2 } })).toThrow();
    expect(() => tool.validate({ notePath: "a.md", lineRange: "nope" })).toThrow();
    await expect(
      tool.invoke(
        { notePath: "a.md", lineRange: { start: 4, end: 6 } },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
    ).rejects.toThrow("exceeds the note's 3 lines");
  });

  test("a bounded read past EOF returns the available evidence and actual range", async () => {
    const tool = makeReadNoteTool(new InMemoryFacade(new Map([["a.md", "a\nb\nc"]])));
    const result = await tool.invoke(
      { notePath: "a.md", lineRange: { start: 2, end: 200 } },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result).toMatchObject({
      notePath: "a.md",
      body: "b\nc",
      totalLines: 3,
      lineRange: { start: 2, end: 3 },
    });
  });

  test.each(["/a.md", ".hidden.md", "notes/private.txt", "notes/../secret.md"])(
    "refuses non-public path %s before reading the facade",
    async (notePath) => {
      let reads = 0;
      const tool = makeReadNoteTool({
        isIndexablePath: () => true,
        read: async () => "",
        readBounded: async () => {
          reads += 1;
          return "private";
        },
      });
      expect(() => tool.validate({ notePath })).toThrow(
        "exact ordinary public vault-relative Markdown",
      );
      await expect(
        tool.invoke({ notePath }, new AbortController().signal, TEST_CONTEXT),
      ).rejects.toThrow("exact ordinary public vault-relative Markdown");
      expect(reads).toBe(0);
    },
  );

  test.each(["Notient/conversations/private.md", "notient/PROPOSALS/private.md"])(
    "refuses Notient-owned artifact %s before reading",
    async (notePath) => {
      let reads = 0;
      const tool = makeReadNoteTool({
        isIndexablePath: () => true,
        read: async () => "",
        readBounded: async () => {
          reads++;
          return "private";
        },
      });
      expect(() => tool.validate({ notePath })).toThrow("exact ordinary public");
      await expect(
        tool.invoke({ notePath }, new AbortController().signal, TEST_CONTEXT),
      ).rejects.toThrow("exact ordinary public");
      expect(reads).toBe(0);
    },
  );
});

describe("vault.list_neighbors validation", () => {
  test("rejects a non-public notePath", () => {
    const fakeDb = {} as Parameters<typeof makeListNeighborsTool>[0];
    const tool = makeListNeighborsTool(fakeDb);
    expect(() => tool.validate({ notePath: "" })).toThrow();
    expect(() => tool.validate({ notePath: ".hidden.md" })).toThrow();
    expect(() => tool.validate({ notePath: "notes.txt" })).toThrow();
    expect(() => tool.validate({ notePath: "Notient/conversations/private.md" })).toThrow();
  });
});

describe("vault.get_vitals", () => {
  test("returns the computed snapshot from VitalsService", async () => {
    const snapshot: VitalsSnapshot = {
      notePath: "a.md",
      freshness: 0.5,
      health: 0.6,
      connectivityCount: 2,
      connectivityTier: "sparse",
      maturity: "adolescent",
      wordCount: 200,
      computedAt: 100,
    };
    const calls: string[] = [];
    const fake: VitalsService = {
      async computeSnapshot(filePath: string): Promise<VitalsSnapshot | null> {
        calls.push(filePath);
        return snapshot;
      },
    } as unknown as VitalsService;
    const tool = makeGetVitalsTool(fake);
    const result = await tool.invoke(
      { notePath: "a.md" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.snapshot).toEqual(snapshot);
    expect(calls).toEqual(["a.md"]);
  });

  test("returns null snapshot when the note is unindexed", async () => {
    const fake: VitalsService = {
      async computeSnapshot(): Promise<VitalsSnapshot | null> {
        return null;
      },
    } as unknown as VitalsService;
    const tool = makeGetVitalsTool(fake);
    const result = await tool.invoke(
      { notePath: "missing.md" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.snapshot).toBeNull();
  });

  test("rejects hidden and non-Markdown paths before calling VitalsService", () => {
    const tool = makeGetVitalsTool({} as VitalsService);
    expect(() => tool.validate({ notePath: ".hidden.md" })).toThrow();
    expect(() => tool.validate({ notePath: "private.json" })).toThrow();
    expect(() => tool.validate({ notePath: "Notient/proposals/private.md" })).toThrow();
  });
});

describe("vault tool registry integration", () => {
  test("ToolValidationError surfaces the failing tool name through registry.invoke", async () => {
    const { ToolRegistry } = await import("../../../../../src/core/chat/tools/registry");
    const facade = new InMemoryFacade(new Map());
    const registry = new ToolRegistry();
    registry.register(makeReadNoteTool(facade));
    let captured: unknown;
    try {
      await registry.invoke(
        "vault.read_note",
        { notePath: "" },
        new AbortController().signal,
        TEST_CONTEXT,
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(ToolValidationError);
    expect((captured as ToolValidationError).toolName).toBe("vault.read_note");
  });
});
