import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  rename as nodeRename,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AtomicFs, atomicWrite } from "../../../../src/core/utils/atomicWrite";

class FakeFs implements AtomicFs {
  files = new Map<string, ArrayBuffer>();
  modes = new Map<string, number>();
  renames: Array<[string, string]> = [];
  chmods: Array<[string, number]> = [];
  removed: string[] = [];
  renameFailUntilAttempt = 0;
  renameAttempt = 0;
  renameError: { code?: string; message: string } = { message: "EPERM: rename" };

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
    this.modes.set(path, 0o644);
  }
  async rename(from: string, to: string): Promise<void> {
    this.renameAttempt++;
    if (this.renameAttempt <= this.renameFailUntilAttempt) {
      const err = new Error(this.renameError.message) as Error & { code?: string };
      err.code = this.renameError.code;
      throw err;
    }
    this.files.set(to, this.files.get(from) as ArrayBuffer);
    this.files.delete(from);
    const mode = this.modes.get(from);
    if (mode === undefined) {
      this.modes.delete(to);
    } else {
      this.modes.set(to, mode);
    }
    this.modes.delete(from);
    this.renames.push([from, to]);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.modes.delete(path);
    this.removed.push(path);
  }
  async statMode(path: string): Promise<number | null> {
    if (!this.files.has(path)) {
      const err = new Error("ENOENT: no such file") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    }
    return this.modes.get(path) ?? null;
  }
  async chmod(path: string, mode: number): Promise<void> {
    if (!this.files.has(path)) {
      const err = new Error("ENOENT: no such file") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    }
    this.modes.set(path, mode);
    this.chmods.push([path, mode]);
  }
}

describe("atomicWrite", () => {
  test("writes via temp file then renames to target", async () => {
    const fs = new FakeFs();
    await atomicWrite(fs, "/vault/note.md", "hello");
    const written = fs.files.get("/vault/note.md");
    expect(written).toBeDefined();
    expect(new TextDecoder().decode(written as ArrayBuffer)).toBe("hello");
    expect(fs.renames.length).toBe(1);
    const [from, to] = fs.renames[0];
    expect(to).toBe("/vault/note.md");
    expect(from.startsWith("/vault/note.md.notient-tmp-")).toBe(true);
    expect(fs.modes.get("/vault/note.md")).toBe(0o644);
    expect(fs.chmods).toEqual([]);
  });

  test("preserves existing target mode bits after rename", async () => {
    const fs = new FakeFs();
    const path = "/vault/script.md";
    fs.files.set(path, new TextEncoder().encode("old").buffer);
    fs.modes.set(path, 0o755);

    await atomicWrite(fs, path, "new");

    const written = fs.files.get(path);
    expect(written).toBeDefined();
    expect(new TextDecoder().decode(written as ArrayBuffer)).toBe("new");
    expect(fs.modes.get(path)).toBe(0o755);
    expect(fs.chmods).toEqual([[path, 0o755]]);
  });

  test("preserves existing target mode bits with the node fs adapter", async () => {
    if (process.platform === "win32") return;

    const dir = await mkdtemp(join(tmpdir(), "notient-atomic-"));
    const path = join(dir, "script.md");
    const fs: AtomicFs = {
      writeBinary: async (filePath, data) => {
        await writeFile(filePath, new Uint8Array(data));
      },
      rename: async (from, to) => {
        await nodeRename(from, to);
      },
      remove: async (filePath) => {
        await unlink(filePath).catch(() => {
          // missing-file is not an error for cleanup
        });
      },
    };

    try {
      await writeFile(path, "old", { mode: 0o755 });
      await chmod(path, 0o755);

      await atomicWrite(fs, path, "new");

      expect(await readFile(path, "utf8")).toBe("new");
      expect((await stat(path)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retries on EPERM (Windows file lock) and eventually succeeds", async () => {
    const fs = new FakeFs();
    fs.renameFailUntilAttempt = 2;
    fs.renameError = { code: "EPERM", message: "EPERM" };
    await atomicWrite(fs, "/vault/note.md", "x", { retries: 4, retryDelayMs: 1 });
    expect(fs.renames.length).toBe(1);
    expect(fs.renameAttempt).toBe(3);
  });

  test("non-retryable error throws and cleans up temp file", async () => {
    const fs = new FakeFs();
    fs.renameFailUntilAttempt = 99;
    fs.renameError = { code: "ENOSPC", message: "no space left" };
    await expect(
      atomicWrite(fs, "/vault/note.md", "x", { retries: 2, retryDelayMs: 1 }),
    ).rejects.toThrow(/no space left/);
    expect(fs.removed.length).toBe(1);
    expect(fs.removed[0].startsWith("/vault/note.md.notient-tmp-")).toBe(true);
  });
});
