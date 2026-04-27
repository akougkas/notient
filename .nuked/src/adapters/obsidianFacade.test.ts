import { describe, expect, test } from "bun:test";
import { ObsidianFacade } from "./obsidianFacade";

function fakeApp(initial: Map<string, string>) {
  const renames: Array<[string, string]> = [];
  const writes: Array<[string, ArrayBuffer]> = [];
  const adapter = {
    async exists(path: string) {
      return initial.has(path);
    },
    async writeBinary(path: string, data: ArrayBuffer) {
      writes.push([path, data]);
      initial.set(path, new TextDecoder().decode(data));
    },
    async rename(from: string, to: string) {
      renames.push([from, to]);
      initial.set(to, initial.get(from) ?? "");
      initial.delete(from);
    },
    async remove(path: string) {
      initial.delete(path);
    },
  };
  const files = Array.from(initial.keys()).map((p) => ({ path: p, stat: { mtime: 1 } }));
  return {
    app: {
      vault: {
        adapter,
        getMarkdownFiles: () => files,
        getAbstractFileByPath: (p: string) => files.find((f) => f.path === p),
        async read(file: { path: string }) {
          return initial.get(file.path) ?? "";
        },
        async delete(file: { path: string }) {
          initial.delete(file.path);
        },
      },
    },
    renames,
    writes,
  };
}

describe("ObsidianFacade", () => {
  test("listMarkdown returns paths and mtimes", () => {
    const env = fakeApp(
      new Map([
        ["a.md", "x"],
        ["b.md", "y"],
      ]),
    );
    const facade = new ObsidianFacade(env.app as never);
    const list = facade.listMarkdown();
    expect(list.map((f) => f.path).sort()).toEqual(["a.md", "b.md"]);
  });

  test("write performs atomic temp + rename via adapter", async () => {
    const env = fakeApp(new Map([["a.md", "old"]]));
    const facade = new ObsidianFacade(env.app as never);
    await facade.write("a.md", "new content");
    expect(env.renames.length).toBe(1);
    const [from, to] = env.renames[0];
    expect(to).toBe("a.md");
    expect(from.startsWith("a.md.notient-tmp-")).toBe(true);
  });

  test("read returns file contents", async () => {
    const env = fakeApp(new Map([["a.md", "hello"]]));
    const facade = new ObsidianFacade(env.app as never);
    expect(await facade.read("a.md")).toBe("hello");
  });
});
