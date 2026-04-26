import { describe, expect, test } from "bun:test";
import { type AtomicFs, atomicWrite } from "./atomicWrite";

class FakeFs implements AtomicFs {
  files = new Map<string, ArrayBuffer>();
  renames: Array<[string, string]> = [];
  removed: string[] = [];
  renameFailUntilAttempt = 0;
  renameAttempt = 0;
  renameError: { code?: string; message: string } = { message: "EPERM: rename" };

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
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
    this.renames.push([from, to]);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.removed.push(path);
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
