import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsVault } from "../../../src/adapters/fsVault";
import { VaultPathError, VaultReadLimitError } from "../../../src/adapters/vaultAdapter";

interface RecoveryFixture {
  id: string;
  operation: "write" | "create" | "replace" | "remove";
  target: string;
  prepared: string | null;
  claim: string | null;
  rollback: string | null;
  expected: string | null;
  replacement: string | null;
}

async function writeRecoveryRecord(dir: string, fixture: RecoveryFixture): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const hash = (value: string | null): string | null =>
    value === null ? null : createHash("sha256").update(value).digest("hex");
  await writeFile(
    join(dir, `${fixture.id}.json`),
    `${JSON.stringify({
      version: 1,
      id: fixture.id,
      operation: fixture.operation,
      target: fixture.target,
      prepared: fixture.prepared,
      claim: fixture.claim,
      rollback: fixture.rollback,
      expectedSha256: hash(fixture.expected),
      replacementSha256: hash(fixture.replacement),
    })}\n`,
    { mode: 0o600 },
  );
}

interface PausedParentAnchor {
  reached: Promise<void>;
  release: () => void;
  restore: () => void;
}

/** Pause a public operation immediately after its parent directory is anchored. */
function pauseNextParentAnchor(vault: FsVault): PausedParentAnchor {
  const target = vault as unknown as {
    openParent: (path: string, create: boolean) => Promise<unknown>;
  };
  const original = target.openParent.bind(vault);
  let announce = (): void => {};
  let resume = (): void => {};
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const anchorSpy = spyOn(target, "openParent").mockImplementation(async (path, create) => {
    const anchored = await original(path, create);
    announce();
    await gate;
    return anchored;
  });
  return {
    reached,
    release: resume,
    restore: () => anchorSpy.mockRestore(),
  };
}

describe("FsVault", () => {
  let root: string;
  let recoveryRoot: string;
  let recoveryDir: string;
  let vault: FsVault;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-fsvault-"));
    recoveryRoot = await mkdtemp(join(tmpdir(), "notient-fsvault-recovery-"));
    recoveryDir = join(recoveryRoot, "journal");
    vault = new FsVault(root, { recoveryDir });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(recoveryRoot, { recursive: true, force: true });
  });

  test("read/write roundtrip preserves bytes", async () => {
    await vault.write("notes/hello.md", "# Hello\n\nworld\n");
    const content = await vault.read("notes/hello.md");
    expect(content).toBe("# Hello\n\nworld\n");
  });

  test("bounded reads accept the exact byte ceiling and reject its sentinel byte", async () => {
    await writeFile(join(root, "exact.md"), "1234", "utf8");
    await writeFile(join(root, "over.md"), "12345", "utf8");

    expect(await vault.readBounded("exact.md", 4)).toBe("1234");
    await expect(vault.readBounded("over.md", 4)).rejects.toBeInstanceOf(VaultReadLimitError);
  });

  test("readers never observe the temporary absence inside a guarded replacement", async () => {
    await vault.write("consistent.md", "before");
    let entered = (): void => {};
    let resume = (): void => {};
    const claimed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const target = vault as unknown as { renameRaw: (from: string, to: string) => Promise<void> };
    const original = target.renameRaw.bind(vault);
    const renamed = spyOn(target, "renameRaw").mockImplementation(async (from, to) => {
      await original(from, to);
      if (from === "consistent.md" && to.includes(".notient-claim-")) {
        entered();
        await release;
      }
    });
    const mutation = vault.writeIfUnchanged("consistent.md", "before", "after", async () => {
      // Editor/permission callbacks can still read before the publication interval.
      expect(await vault.read("consistent.md")).toBe("before");
    });
    try {
      await claimed;
      let settled = false;
      const reads = Promise.all([
        vault.read("consistent.md"),
        vault.readBounded("consistent.md", 100),
        vault.exists("consistent.md"),
        vault.listMarkdown(),
      ]);
      void reads.then(() => {
        settled = true;
      });
      await Bun.sleep(10);
      expect(settled).toBe(false);
      resume();
      expect(await mutation).toBe(true);
      const [body, bounded, exists, listing] = await reads;
      expect(body).toBe("after");
      expect(bounded).toBe("after");
      expect(exists).toBe(true);
      expect(listing.map((entry) => entry.path)).toContain("consistent.md");
    } finally {
      resume();
      renamed.mockRestore();
      await mutation;
    }
  });

  test("write is atomic: tmp file does not survive on success", async () => {
    await vault.write("notes/atomic.md", "ok");
    const dirEntries = await import("node:fs/promises").then((module) =>
      module.readdir(join(root, "notes")),
    );
    expect(dirEntries.some((entry) => entry.endsWith(".md"))).toBe(true);
    expect(dirEntries.some((entry) => entry.includes("notient-tmp"))).toBe(false);
  });

  test("startup recovery ignores forgeable temp filenames without a private journal", async () => {
    const interrupted = join(
      root,
      "nested",
      "note.md.notient-tmp-123-123e4567-e89b-42d3-a456-426614174000",
    );
    const lookalike = join(root, "nested", "note.md.notient-tmp-123-user-file");
    const ordinary = join(root, "nested", "note.md");
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(interrupted, "prepared bytes");
    await writeFile(lookalike, "user bytes");
    await writeFile(ordinary, "note bytes");

    expect(await vault.cleanupInterruptedWrites()).toBe(0);
    expect(await vault.exists("nested/note.md")).toBe(true);
    expect(await readFile(lookalike, "utf8")).toBe("user bytes");
    expect(await readFile(interrupted, "utf8")).toBe("prepared bytes");
    expect(await vault.cleanupInterruptedWrites()).toBe(0);
  });

  test("startup recovery cannot promote or delete planted control-file lookalikes", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const controlDir = join(root, ".notient");
    const plantedClaim = join(controlDir, `.env.notient-claim-1-${id}`);
    const plantedTemp = join(controlDir, `config.json.notient-tmp-1-${id}`);
    await mkdir(controlDir, { recursive: true });
    await writeFile(plantedClaim, "NOTIENT_LLM_BASE_URL=https://attacker.invalid/v1\n");
    await writeFile(plantedTemp, "attacker config");

    expect(await vault.cleanupInterruptedWrites()).toBe(0);
    await expect(readFile(join(controlDir, ".env"), "utf8")).rejects.toThrow();
    expect(await readFile(plantedClaim, "utf8")).toContain("attacker.invalid");
    expect(await readFile(plantedTemp, "utf8")).toBe("attacker config");
  });

  test("startup recovery restores an interrupted guarded claim when its target is absent", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const claim = join(root, "nested", `claimed.md.notient-claim-123-${id}`);
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(claim, "exact preimage", { mode: 0o600 });
    await writeRecoveryRecord(recoveryDir, {
      id,
      operation: "remove",
      target: "nested/claimed.md",
      prepared: null,
      claim: `nested/claimed.md.notient-claim-123-${id}`,
      rollback: null,
      expected: "exact preimage",
      replacement: null,
    });

    expect(await vault.cleanupInterruptedWrites()).toBe(1);
    expect(await readFile(join(root, "nested", "claimed.md"), "utf8")).toBe("exact preimage");
    await expect(readFile(claim, "utf8")).rejects.toThrow();
    if (process.platform !== "win32") {
      expect((await stat(join(root, "nested", "claimed.md"))).mode & 0o777).toBe(0o600);
    }
  });

  test("startup recovery never overwrites a pathname recreated after an interrupted claim", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const target = join(root, "nested", "claimed.md");
    const claim = `${target}.notient-claim-123-${id}`;
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(claim, "old preimage");
    await writeFile(target, "external recreation");
    await writeRecoveryRecord(recoveryDir, {
      id,
      operation: "remove",
      target: "nested/claimed.md",
      prepared: null,
      claim: `nested/claimed.md.notient-claim-123-${id}`,
      rollback: null,
      expected: "old preimage",
      replacement: null,
    });

    expect(await vault.cleanupInterruptedWrites()).toBe(1);
    expect(await readFile(target, "utf8")).toBe("external recreation");
    await expect(readFile(claim, "utf8")).rejects.toThrow();
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

  test("writeIfUnchanged replaces only exact expected bytes", async () => {
    const mutations: Array<{ kind: string; path?: string }> = [];
    vault = new FsVault(root, {
      recoveryDir,
      onMutation: (mutation) => mutations.push(mutation),
    });
    await vault.write("notes/cas.md", "before");
    mutations.length = 0;

    expect(await vault.writeIfUnchanged("notes/cas.md", "before", "after")).toBe(true);
    expect(await vault.read("notes/cas.md")).toBe("after");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ kind: "write", path: "notes/cas.md" });
  });

  test("guarded rename closes its source descriptor before destination verification", async () => {
    await vault.write("notes/cas.md", "before");
    type AnchoredLeafForTest = { name: string; path: string };
    type OpenSupportedEntry = (
      leaf: AnchoredLeafForTest,
      allowDirectory: boolean,
    ) => Promise<FileHandle>;
    const target = vault as unknown as { openSupportedEntry: OpenSupportedEntry };
    const original = target.openSupportedEntry.bind(vault);
    let sourceDescriptorOpen = false;
    let simulatedDrvFsFailures = 0;
    const entrySpy = spyOn(target, "openSupportedEntry").mockImplementation(
      async (leaf, allowDirectory) => {
        if (leaf.name === "cas.md") {
          const handle = await original(leaf, allowDirectory);
          const close = handle.close.bind(handle);
          sourceDescriptorOpen = true;
          handle.close = async (): Promise<void> => {
            sourceDescriptorOpen = false;
            await close();
          };
          return handle;
        }
        if (leaf.name.includes(".notient-claim-") && sourceDescriptorOpen) {
          try {
            await stat(leaf.path);
          } catch {
            return await original(leaf, allowDirectory);
          }
          simulatedDrvFsFailures += 1;
          throw Object.assign(
            new Error("simulated DrvFS ENOENT while the source descriptor is open"),
            { code: "ENOENT" },
          );
        }
        return await original(leaf, allowDirectory);
      },
    );

    try {
      expect(await vault.writeIfUnchanged("notes/cas.md", "before", "after")).toBe(true);
      expect(await vault.read("notes/cas.md")).toBe("after");
      expect(simulatedDrvFsFailures).toBe(0);
    } finally {
      entrySpy.mockRestore();
    }
  });

  test("createIfAbsent never overwrites an existing note", async () => {
    await vault.write("notes/new.md", "human");

    expect(await vault.createIfAbsent("notes/new.md", "notient")).toBe(false);
    expect(await vault.read("notes/new.md")).toBe("human");
    expect(await vault.createIfAbsent("notes/other.md", "notient")).toBe(true);
    expect(await vault.read("notes/other.md")).toBe("notient");
  });

  test("writeIfUnchanged preserves conflicting bytes without a journal event or temp leak", async () => {
    const mutations: Array<{ kind: string; path?: string }> = [];
    vault = new FsVault(root, {
      recoveryDir,
      onMutation: (mutation) => mutations.push(mutation),
    });
    await vault.write("notes/cas.md", "human edit");
    mutations.length = 0;

    expect(await vault.writeIfUnchanged("notes/cas.md", "stale bytes", "notient")).toBe(false);
    expect(await vault.read("notes/cas.md")).toBe("human edit");
    expect(mutations).toEqual([]);
    const entries = await import("node:fs/promises").then((module) =>
      module.readdir(join(root, "notes")),
    );
    expect(entries.some((entry) => entry.includes("notient-tmp"))).toBe(false);
  });

  test("removeIfUnchanged deletes only exact expected bytes", async () => {
    const mutations: Array<{ kind: string; path?: string }> = [];
    vault = new FsVault(root, {
      recoveryDir,
      onMutation: (mutation) => mutations.push(mutation),
    });
    await vault.write("notes/remove.md", "current");
    mutations.length = 0;

    expect(await vault.removeIfUnchanged("notes/remove.md", "stale")).toBe(false);
    expect(await vault.read("notes/remove.md")).toBe("current");
    expect(mutations).toEqual([]);

    expect(await vault.removeIfUnchanged("notes/remove.md", "current")).toBe(true);
    expect(await vault.exists("notes/remove.md")).toBe(false);
    expect(mutations).toEqual([{ kind: "remove", path: "notes/remove.md" }]);
  });

  test("guarded removal rechecks authority after the native editor guard", async () => {
    await vault.write("Created.md", "keep this");
    let authorized = true;
    let released = false;
    vault = new FsVault(root, {
      recoveryDir,
      beforeMutation: async () => {
        authorized = false;
        return () => {
          released = true;
        };
      },
    });
    await expect(
      vault.removeIfUnchanged("Created.md", "keep this", async () => {
        if (!authorized) throw new Error("authority revoked while editor guard was pending");
      }),
    ).rejects.toThrow("authority revoked");
    expect(await vault.read("Created.md")).toBe("keep this");
    expect(released).toBe(true);
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

  test("listMarkdown skips dot-prefixed Markdown files at every depth", async () => {
    await writeFile(join(root, ".secret.md"), "root secret");
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested", ".secret.md"), "nested secret");
    await vault.write("nested/public.md", "public");

    expect(await vault.listMarkdown()).toEqual([
      expect.objectContaining({ path: "nested/public.md" }),
    ]);
  });

  test("the injected exclusion predicate solely decides whether Excalidraw is indexed", async () => {
    await vault.write("diagram.excalidraw.md", "plain test fixture");
    expect((await vault.listMarkdown()).map((entry) => entry.path)).toEqual([
      "diagram.excalidraw.md",
    ]);

    vault.setExclusion((path) => path.endsWith(".excalidraw.md"));
    expect(await vault.listMarkdown()).toEqual([]);
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

  test("updateFrontmatter preserves block-form lists and body bytes", async () => {
    const before = [
      "---",
      "title: Real",
      "aliases:",
      "  - alpha",
      "  - beta",
      "tags:",
      "  - homelab",
      "---",
      "",
      "- [ ] buy milk",
      "- [x] done",
      "",
      "> [!note] Callout",
      "",
      "Math $a_i$, 5 * 3, escaped \\* star.",
      "",
    ].join("\n");
    await vault.write("real.md", before);
    await vault.updateFrontmatter("real.md", { notient: { health: 0.5 } });
    const after = await vault.read("real.md");
    expect(after).toContain("aliases:\n  - alpha\n  - beta\n");
    expect(after).toContain("tags:\n  - homelab\n");
    expect(after).toContain("notient:\n  health: 0.5\n");
    const body = (text: string) => text.slice(text.indexOf("\n---\n") + 5);
    expect(body(after)).toBe(body(before));
    expect(after).toContain("- [ ] buy milk");
    expect(after).toContain("> [!note] Callout");
    expect(after).toContain("5 * 3");
  });

  test("updateFrontmatter is a no-op when the patch changes nothing", async () => {
    const before = "---\ntitle: Same\n---\n\nbody\n";
    await vault.write("same.md", before);
    await vault.updateFrontmatter("same.md", { title: "Same" });
    expect(await vault.read("same.md")).toBe(before);
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

describe("FsVault path containment", () => {
  let root: string;
  let vault: FsVault;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-fsvault-esc-"));
    vault = new FsVault(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("rejects '..' traversal on read and write", async () => {
    expect(vault.read("../outside.md")).rejects.toThrow("path escapes vault");
    expect(vault.read("notes/../../outside.md")).rejects.toThrow("path escapes vault");
    expect(vault.write("../outside.md", "nope")).rejects.toThrow("path escapes vault");
  });

  test("security refusals are typed domain errors without wire-code prefixes", async () => {
    const operations = [() => vault.read("../outside.md"), () => vault.exists(".notient/.env")];
    for (const operation of operations) {
      try {
        await operation();
        throw new Error("expected vault path refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(VaultPathError);
        expect((error as Error).message).not.toContain("INVALID_PARAMS");
      }
    }
  });

  test("rejects an absolute path", async () => {
    expect(vault.read("/etc/passwd")).rejects.toThrow("path escapes vault");
    expect(vault.write("/tmp/notient-escape.md", "nope")).rejects.toThrow("path escapes vault");
  });

  test("rejects a symlink inside the vault that points outside it", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "notient-fsvault-out-"));
    try {
      const secret = join(outsideDir, "secret.md");
      await writeFile(secret, "top secret", "utf-8");
      await symlink(secret, join(root, "linked.md"));
      expect(vault.read("linked.md")).rejects.toThrow("path escapes vault");
      await symlink(outsideDir, join(root, "linkeddir"));
      expect(vault.read("linkeddir/secret.md")).rejects.toThrow("path escapes vault");
      expect(vault.write("linkeddir/planted.md", "nope")).rejects.toThrow("path escapes vault");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("refuses final and intermediate symlinks even when they stay inside the vault", async () => {
    await vault.write("inside/target.md", "ok");
    await symlink(join(root, "inside", "target.md"), join(root, "alias.md"));
    await symlink(join(root, "inside"), join(root, "aliasdir"));

    expect(vault.read("alias.md")).rejects.toThrow("path escapes vault");
    expect(vault.read("aliasdir/target.md")).rejects.toThrow("path escapes vault");
  });

  test("refuses final directories and special files instead of reading or truncating them", async () => {
    await vault.createFolder("directory.md");
    expect(vault.read("directory.md")).rejects.toThrow("path escapes vault");
    expect(vault.readBinary("directory.md")).rejects.toThrow("path escapes vault");

    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const fifoPath = join(root, "pipe.md");
    const mkfifo = Bun.spawn(["mkfifo", fifoPath], { stderr: "pipe", stdout: "pipe" });
    expect(await mkfifo.exited).toBe(0);
    expect(vault.read("pipe.md")).rejects.toThrow("path escapes vault");
    expect(vault.writeBinary("pipe.md", new Uint8Array([1]).buffer)).rejects.toThrow(
      "path escapes vault",
    );
  });

  test("read remains bound to its opened parent when the pathname is swapped to outside", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const outsideDir = await mkdtemp(join(tmpdir(), "notient-fsvault-race-out-"));
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes", "secret.md"), "inside");
    await writeFile(join(outsideDir, "secret.md"), "outside");
    const paused = pauseNextParentAnchor(vault);
    const reading = vault.read("notes/secret.md");
    try {
      await paused.reached;
      await rename(join(root, "notes"), join(root, "anchored-notes"));
      await symlink(outsideDir, join(root, "notes"));
      paused.release();

      expect(await reading).toBe("inside");
      expect(await readFile(join(outsideDir, "secret.md"), "utf8")).toBe("outside");
    } finally {
      paused.release();
      paused.restore();
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("remove remains bound to its opened parent when the pathname is swapped to outside", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const outsideDir = await mkdtemp(join(tmpdir(), "notient-fsvault-race-out-"));
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes", "victim.md"), "inside");
    await writeFile(join(outsideDir, "victim.md"), "outside");
    const paused = pauseNextParentAnchor(vault);
    const removal = vault.remove("notes/victim.md");
    try {
      await paused.reached;
      await rename(join(root, "notes"), join(root, "anchored-notes"));
      await symlink(outsideDir, join(root, "notes"));
      paused.release();

      await removal;
      await expect(readFile(join(root, "anchored-notes", "victim.md"), "utf8")).rejects.toThrow();
      expect(await readFile(join(outsideDir, "victim.md"), "utf8")).toBe("outside");
    } finally {
      paused.release();
      paused.restore();
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("refuses dot-prefixed segments so vault internals stay unreachable", async () => {
    await mkdir(join(root, ".notient"), { recursive: true });
    await writeFile(join(root, ".notient", ".env"), "NOTIENT_LLM_BASE_URL=http://x/v1", "utf-8");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "[core]\n", "utf-8");
    await mkdir(join(root, "a", ".hidden"), { recursive: true });
    await writeFile(join(root, "a", ".hidden", "x.md"), "hidden", "utf-8");

    expect(vault.read(".notient/.env")).rejects.toThrow("hidden path");
    expect(vault.read(".git/config")).rejects.toThrow("hidden path");
    expect(vault.read("a/.hidden/x.md")).rejects.toThrow("hidden path");
    expect(vault.write(".notient/planted.md", "nope")).rejects.toThrow("hidden path");
    expect(vault.exists(".notient/.env")).rejects.toThrow("hidden path");
  });

  test("allows a dot inside a segment and ordinary vault paths", async () => {
    await vault.write("Notient/x.md", "ok");
    expect(await vault.read("Notient/x.md")).toBe("ok");
    await vault.write("a.b/c.md", "fine");
    expect(await vault.read("a.b/c.md")).toBe("fine");
  });

  test("allowHiddenPaths opens dot-prefixed segments for daemon-owned config", async () => {
    const internal = new FsVault(root, { allowHiddenPaths: true });
    await internal.write(".notient/config.json", "{}");
    expect(await internal.read(".notient/config.json")).toBe("{}");
    expect(internal.read("../outside.md")).rejects.toThrow("path escapes vault");
  });

  test("exists refuses escaping paths instead of disguising them as missing", async () => {
    expect(vault.exists("../outside.md")).rejects.toThrow("path escapes vault");
    expect(vault.exists("/etc/passwd")).rejects.toThrow("path escapes vault");
  });
});
