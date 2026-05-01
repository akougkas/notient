import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsVault } from "../../../src/adapters/fsVault";

describe("FsVault", () => {
  let root: string;
  let vault: FsVault;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-fsvault-"));
    vault = new FsVault(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("read/write roundtrip preserves bytes", async () => {
    await vault.write("notes/hello.md", "# Hello\n\nworld\n");
    const content = await vault.read("notes/hello.md");
    expect(content).toBe("# Hello\n\nworld\n");
  });

  test("write is atomic: tmp file does not survive on success", async () => {
    await vault.write("notes/atomic.md", "ok");
    const dirEntries = await import("node:fs/promises").then((module) =>
      module.readdir(join(root, "notes")),
    );
    expect(dirEntries.some((entry) => entry.endsWith(".md"))).toBe(true);
    expect(dirEntries.some((entry) => entry.includes("notient-tmp"))).toBe(false);
  });

  test("write preserves existing file mode bits", async () => {
    if (process.platform === "win32") return;
    await vault.write("notes/script.md", "old");
    const absolute = join(root, "notes", "script.md");
    await chmod(absolute, 0o755);

    await vault.write("notes/script.md", "new");

    expect(await readFile(absolute, "utf8")).toBe("new");
    expect((await stat(absolute)).mode & 0o777).toBe(0o755);
  });

  test("listMarkdown skips dot-prefixed folders", async () => {
    await mkdir(join(root, ".notient"), { recursive: true });
    await writeFile(join(root, ".notient", "config.json"), "{}");
    await mkdir(join(root, ".obsidian"), { recursive: true });
    await writeFile(join(root, ".obsidian", "workspace.json"), "{}");
    await vault.write("a.md", "a");
    await vault.write("nested/b.md", "b");
    const listing = await vault.listMarkdown();
    const paths = listing.map((entry) => entry.path).sort();
    expect(paths).toEqual(["a.md", "nested/b.md"]);
  });

  test("exists is true for files and folders, false for missing", async () => {
    await vault.write("present.md", "p");
    expect(await vault.exists("present.md")).toBe(true);
    expect(await vault.exists("missing.md")).toBe(false);
    await vault.createFolder("folder");
    expect(await vault.exists("folder")).toBe(true);
  });

  test("updateFrontmatter merges YAML and rewrites atomically", async () => {
    await vault.write("note.md", "---\ntitle: Old\n---\n\nbody\n");
    await vault.updateFrontmatter("note.md", { title: "New", tag: "ok" });
    const after = await vault.read("note.md");
    expect(after).toContain("title: New");
    expect(after).toContain("tag: ok");
    expect(after).toContain("body");
  });

  test("readBinary returns null for missing path", async () => {
    expect(await vault.readBinary("missing.bin")).toBeNull();
  });

  test("readBinary roundtrip", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    await vault.writeBinary("blob.bin", payload.buffer);
    const back = await vault.readBinary("blob.bin");
    expect(back).not.toBeNull();
    expect(new Uint8Array(back as ArrayBuffer)).toEqual(payload);
  });

  test("list returns shallow files and folders", async () => {
    await vault.write("folder/a.md", "a");
    await vault.write("folder/b.md", "b");
    await vault.createFolder("folder/sub");
    const listing = await vault.list("folder");
    expect(listing.files.sort()).toEqual(["folder/a.md", "folder/b.md"]);
    expect(listing.folders).toEqual(["folder/sub"]);
  });
});
