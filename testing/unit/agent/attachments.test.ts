import { describe, expect, test } from "bun:test";
import type { VaultAdapter } from "../../../src/adapters/vaultAdapter";
import { extractMentions, resolveAttachments } from "../../../src/agent/attachments";

function makeVault(files: Record<string, string>): VaultAdapter {
  return {
    isIndexablePath: () => true,
    listMarkdown: async () =>
      Object.keys(files)
        .filter((path) => path.endsWith(".md"))
        .map((path) => ({ path, mtime: 0 })),
    read: async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    readBounded: async (path: string, maxBytes: number) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      if (Buffer.byteLength(content) > maxBytes) throw new Error("byte limit exceeded");
      return content;
    },
    write: async () => {},
    createIfAbsent: async () => true,
    writeIfUnchanged: async () => true,
    updateFrontmatter: async () => {},
    remove: async () => {},
    removeIfUnchanged: async () => true,
    exists: async (path) => path in files,
    createFolder: async () => {},
    list: async () => ({ files: Object.keys(files), folders: [] }),
    readBinary: async () => null,
    writeBinary: async () => {},
    rename: async () => {},
  };
}

describe("extractMentions", () => {
  test("captures @-prefixed paths up to whitespace", () => {
    const mentions = extractMentions("read @notes/a.md and @docs/b.md please");
    expect(mentions).toEqual(["notes/a.md", "docs/b.md"]);
  });

  test("ignores email-style @ tokens", () => {
    expect(extractMentions("contact a@example.com about it")).toEqual([]);
  });

  test("captures @-prefixed quoted paths with spaces", () => {
    expect(extractMentions('look at @"notes/Phase 4.md" today')).toEqual(["notes/Phase 4.md"]);
  });
});

describe("resolveAttachments", () => {
  test("inlines markdown content", async () => {
    const vault = makeVault({ "notes/a.md": "hello\nworld" });
    const result = await resolveAttachments({
      vault,
      message: "see @notes/a.md",
      maxTokens: 1000,
      resolveImage: async () => {
        throw new Error("vision should not be called");
      },
    });
    expect(result.pinnedContext.length).toBe(1);
    expect(result.pinnedContext[0]).toContain("hello");
    expect(result.visionImages).toEqual([]);
  });

  test("routes images through resolveImage", async () => {
    const vault = makeVault({});
    Object.defineProperty(vault, "exists", {
      value: async () => true,
      writable: true,
    });
    Object.defineProperty(vault, "readBinary", {
      value: async () => new Uint8Array([0, 1, 2]).buffer,
      writable: true,
    });
    const result = await resolveAttachments({
      vault,
      message: "describe @img/cat.png",
      maxTokens: 1000,
      resolveImage: async (path) => `a cat in ${path}`,
    });
    expect(result.pinnedContext.length).toBe(1);
    expect(result.pinnedContext[0]).toMatch(/^\[image: img\/cat\.png\] a cat/);
    expect(result.visionImages.length).toBe(1);
  });

  test("fails the turn when an image references but vision is unavailable", async () => {
    const vault = makeVault({});
    Object.defineProperty(vault, "exists", {
      value: async () => true,
      writable: true,
    });
    Object.defineProperty(vault, "readBinary", {
      value: async () => new Uint8Array().buffer,
      writable: true,
    });
    let thrown: unknown = null;
    try {
      await resolveAttachments({
        vault,
        message: "describe @img/cat.png",
        maxTokens: 1000,
        resolveImage: async () => {
          throw new Error("VISION_UNAVAILABLE: load a multimodal primary model");
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("VISION_UNAVAILABLE");
  });

  test("skips missing paths silently with a placeholder", async () => {
    const vault = makeVault({});
    const result = await resolveAttachments({
      vault,
      message: "@notes/missing.md is gone",
      maxTokens: 1000,
      resolveImage: async () => "",
    });
    expect(result.pinnedContext[0]).toContain("not found");
  });

  test("refuses Notient-owned artifacts without probing the vault", async () => {
    let touches = 0;
    const vault = makeVault({
      "Notient/conversations/private.md": "private transcript",
      "Notient/proposals/private.md": "private proposal",
    });
    vault.exists = async () => {
      touches++;
      return true;
    };
    vault.read = async () => {
      touches++;
      return "private";
    };

    const result = await resolveAttachments({
      vault,
      message: "@Notient/conversations/private.md @notient/PROPOSALS/private.md",
      maxTokens: 1000,
      resolveImage: async () => "",
    });

    expect(result.pinnedContext).toEqual([
      "[attachment: Notient/conversations/private.md] (not accessible)",
      "[attachment: notient/PROPOSALS/private.md] (not accessible)",
    ]);
    expect(touches).toBe(0);
  });
});
