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
import {
  type AtomicFs,
  type AtomicRecoveryRecord,
  type GuardedAtomicFs,
  atomicCreateIfAbsent,
  atomicRemoveIfUnchanged,
  atomicReplaceIfUnchanged,
  atomicWrite,
  isAtomicWriteTempName,
} from "../../../../src/core/utils/atomicWrite";

class FakeFs implements GuardedAtomicFs {
  files = new Map<string, ArrayBuffer>();
  modes = new Map<string, number>();
  renames: Array<[string, string]> = [];
  chmods: Array<[string, number]> = [];
  removed: string[] = [];
  renameFailUntilAttempt = 0;
  renameAttempt = 0;
  renameError: { code?: string; message: string } = { message: "EPERM: rename" };
  beforeRename: ((from: string, to: string) => void) | undefined;
  beforeLink: ((from: string, to: string) => void) | undefined;
  chmodError: Error | undefined;
  recovery = new Map<string, AtomicRecoveryRecord>();

  async writeBinary(path: string, data: ArrayBuffer, mode: number): Promise<void> {
    if (this.files.has(path)) throw errno("EEXIST");
    this.files.set(path, data);
    this.modes.set(path, mode);
  }
  async rename(from: string, to: string): Promise<void> {
    this.renameAttempt++;
    if (this.renameAttempt <= this.renameFailUntilAttempt) {
      const err = new Error(this.renameError.message) as Error & { code?: string };
      err.code = this.renameError.code;
      throw err;
    }
    this.beforeRename?.(from, to);
    if (!this.files.has(from)) throw errno("ENOENT");
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
    if (this.chmodError !== undefined) throw this.chmodError;
    if (!this.files.has(path)) {
      const err = new Error("ENOENT: no such file") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    }
    this.modes.set(path, mode);
    this.chmods.push([path, mode]);
  }
  async readText(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw errno("ENOENT");
    return new TextDecoder().decode(value);
  }
  async link(from: string, to: string): Promise<void> {
    this.beforeLink?.(from, to);
    if (this.files.has(to)) throw errno("EEXIST");
    const value = this.files.get(from);
    if (value === undefined) throw errno("ENOENT");
    this.files.set(to, value);
    const mode = this.modes.get(from);
    if (mode !== undefined) this.modes.set(to, mode);
  }
  async beginRecovery(record: AtomicRecoveryRecord): Promise<void> {
    if (this.recovery.has(record.id)) throw errno("EEXIST");
    this.recovery.set(record.id, record);
  }
  async finishRecovery(id: string): Promise<void> {
    this.recovery.delete(id);
  }
}

function errno(code: string): Error & { code: string } {
  const error = new Error(`${code}: test filesystem`) as Error & { code: string };
  error.code = code;
  return error;
}

describe("atomicWrite", () => {
  test("recognizes only the current crash-recovery temp identity", () => {
    expect(
      isAtomicWriteTempName("note.md.notient-tmp-123-123e4567-e89b-42d3-a456-426614174000"),
    ).toBe(true);
    expect(isAtomicWriteTempName("note.md.notient-tmp-123-user-file")).toBe(false);
    expect(
      isAtomicWriteTempName("note.md.notient-tmp-123-123e4567-e89b-12d3-a456-426614174000"),
    ).toBe(false);
  });

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
    expect(fs.chmods).toEqual([[from, 0o644]]);
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
    const prepared = fs.renames[0]?.[0];
    expect(prepared).toBeDefined();
    expect(fs.chmods).toEqual([[prepared as string, 0o755]]);
  });

  test("preserves existing target mode bits with the node fs adapter", async () => {
    if (process.platform === "win32") return;

    const dir = await mkdtemp(join(tmpdir(), "notient-atomic-"));
    const path = join(dir, "script.md");
    const fs: AtomicFs = {
      writeBinary: async (filePath, data, mode) => {
        await writeFile(filePath, new Uint8Array(data), { flag: "wx", mode });
      },
      rename: async (from, to) => {
        await nodeRename(from, to);
      },
      remove: async (filePath) => {
        await unlink(filePath).catch(() => {
          // missing-file is not an error for cleanup
        });
      },
      beginRecovery: async () => {},
      finishRecovery: async () => {},
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

  test("preserved mode is applied before rename", async () => {
    const fs = new FakeFs();
    const path = "/vault/note.md";
    fs.files.set(path, new TextEncoder().encode("expected").buffer);
    fs.modes.set(path, 0o600);
    let modeAtRename: number | undefined;
    fs.beforeRename = (from) => {
      modeAtRename = fs.modes.get(from);
    };

    await atomicWrite(fs, path, "notient");

    expect(modeAtRename).toBe(0o600);
    expect(fs.modes.get(path)).toBe(0o600);
  });

  test("chmod failure leaves the existing target untouched and cleans the prepared file", async () => {
    const fs = new FakeFs();
    const path = "/vault/note.md";
    fs.files.set(path, new TextEncoder().encode("private").buffer);
    fs.modes.set(path, 0o600);
    fs.chmodError = new Error("chmod refused");

    await expect(atomicWrite(fs, path, "new private")).rejects.toThrow("chmod refused");

    expect(await fs.readText(path)).toBe("private");
    expect(fs.renames).toEqual([]);
    expect(fs.removed).toHaveLength(1);
    expect(fs.removed[0]).toContain(".notient-tmp-");
  });

  test("retries an unconditional Windows rename without changing the prepared mode", async () => {
    const fs = new FakeFs();
    fs.renameFailUntilAttempt = 1;
    fs.renameError = { code: "EPERM", message: "EPERM" };

    await atomicWrite(fs, "/vault/note.md", "notient", { retries: 2, retryDelayMs: 1 });

    expect(fs.renameAttempt).toBe(2);
    expect(await fs.readText("/vault/note.md")).toBe("notient");
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

  test("create-if-absent never overwrites a path claimed by an external writer", async () => {
    const fs = new FakeFs();
    const path = "/vault/new.md";
    fs.beforeLink = (_from, to) => {
      if (to === path) fs.files.set(path, new TextEncoder().encode("human").buffer);
    };

    expect(await atomicCreateIfAbsent(fs, path, "notient")).toBe(false);
    expect(await fs.readText(path)).toBe("human");
    expect([...fs.files.keys()].some((entry) => entry.includes(".notient-tmp-"))).toBe(false);
  });

  test("replace catches an external edit in the compare-to-claim gap", async () => {
    const fs = new FakeFs();
    const path = "/vault/note.md";
    fs.files.set(path, new TextEncoder().encode("expected").buffer);
    fs.modes.set(path, 0o644);
    fs.beforeRename = (from) => {
      if (from === path) fs.files.set(path, new TextEncoder().encode("human-before-claim").buffer);
    };

    expect(await atomicReplaceIfUnchanged(fs, path, "expected", "notient")).toBe(false);
    expect(await fs.readText(path)).toBe("human-before-claim");
    expect([...fs.files.keys()]).toEqual([path]);
  });

  test("replace never overwrites an external writer in the claim-to-publish gap", async () => {
    const fs = new FakeFs();
    const path = "/vault/note.md";
    fs.files.set(path, new TextEncoder().encode("expected").buffer);
    fs.modes.set(path, 0o600);
    fs.beforeLink = (from, to) => {
      if (to === path && from.includes(".notient-tmp-")) {
        fs.files.set(path, new TextEncoder().encode("human-after-claim").buffer);
        fs.modes.set(path, 0o644);
      }
    };

    expect(await atomicReplaceIfUnchanged(fs, path, "expected", "notient")).toBe(false);
    expect(await fs.readText(path)).toBe("human-after-claim");
    expect(fs.modes.get(path)).toBe(0o644);
    expect([...fs.files.keys()]).toEqual([path]);
  });

  test("replace rolls back when an already-open writer changes the claimed inode", async () => {
    const fs = new FakeFs();
    const path = "/vault/note.md";
    fs.files.set(path, new TextEncoder().encode("expected").buffer);
    fs.modes.set(path, 0o644);
    fs.beforeLink = (from, to) => {
      if (to !== path || !from.includes(".notient-tmp-")) return;
      const claim = [...fs.files.keys()].find((entry) => entry.includes(".notient-claim-"));
      if (claim === undefined) throw new Error("expected active claim");
      fs.files.set(claim, new TextEncoder().encode("late-open-fd-write").buffer);
    };

    expect(await atomicReplaceIfUnchanged(fs, path, "expected", "notient")).toBe(false);
    expect(await fs.readText(path)).toBe("late-open-fd-write");
    expect([...fs.files.keys()]).toEqual([path]);
  });

  test("guarded replace publishes exact bytes and preserves mode", async () => {
    const fs = new FakeFs();
    const path = "/vault/note.md";
    fs.files.set(path, new TextEncoder().encode("expected").buffer);
    fs.modes.set(path, 0o600);

    expect(await atomicReplaceIfUnchanged(fs, path, "expected", "notient")).toBe(true);
    expect(await fs.readText(path)).toBe("notient");
    expect(fs.modes.get(path)).toBe(0o600);
    expect([...fs.files.keys()]).toEqual([path]);
  });

  test("guarded removal restores an external edit captured at claim time", async () => {
    const fs = new FakeFs();
    const path = "/vault/note.md";
    fs.files.set(path, new TextEncoder().encode("expected").buffer);
    fs.modes.set(path, 0o644);
    fs.beforeRename = (from) => {
      if (from === path) fs.files.set(path, new TextEncoder().encode("human").buffer);
    };

    expect(await atomicRemoveIfUnchanged(fs, path, "expected")).toBe(false);
    expect(await fs.readText(path)).toBe("human");
    expect([...fs.files.keys()]).toEqual([path]);
  });

  test("guarded removal deletes expected bytes but leaves a later external recreation", async () => {
    const fs = new FakeFs();
    const path = "/vault/note.md";
    fs.files.set(path, new TextEncoder().encode("expected").buffer);
    fs.modes.set(path, 0o644);
    const originalRead = fs.readText.bind(fs);
    fs.readText = async (readPath) => {
      const value = await originalRead(readPath);
      if (readPath.includes(".notient-claim-")) {
        fs.files.set(path, new TextEncoder().encode("human-after-claim").buffer);
      }
      return value;
    };

    expect(await atomicRemoveIfUnchanged(fs, path, "expected")).toBe(true);
    expect(await fs.readText(path)).toBe("human-after-claim");
  });
});
