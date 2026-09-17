import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { patchFrontmatter } from "../core/markdown/frontmatter";
import {
  type AtomicRecoveryRecord,
  type GuardedAtomicFs,
  atomicCreateIfAbsent,
  atomicMoveIfUnchanged,
  atomicRemoveIfUnchanged,
  atomicReplaceIfUnchanged,
  atomicWrite,
  interruptedClaimTargetName,
  interruptedRollbackTargetName,
  isAtomicWriteTempName,
} from "../core/utils/atomicWrite";
import type { VaultMutation } from "../core/vault/daemonMutationJournal";
import { vaultStateDir } from "../core/vault/identity";
import { isCanonicalPublicNotePath } from "../core/vault/publicPath";
import {
  type VaultAdapter,
  type VaultListing,
  VaultPathError,
  VaultReadLimitError,
} from "./vaultAdapter";

const DOT_PREFIXES = new Set([".notient", ".obsidian", ".git"]);
const HARD_SKIP = new Set(["node_modules"]);
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

interface AnchoredDirectory {
  handle: FileHandle;
  path: string;
}

interface AnchoredLeaf {
  parent: AnchoredDirectory;
  name: string;
  path: string;
}

function pathEscapes(): VaultPathError {
  return new VaultPathError("escape");
}

function hiddenPath(): VaultPathError {
  return new VaultPathError("hidden");
}

export interface FsVaultOptions {
  /**
   * Permit path segments that begin with a dot. The daemon's own
   * configuration plumbing needs `.notient/.env` and
   * `.notient/config.json`, so bootstrap builds one adapter with this set.
   * Every adapter reachable from an RPC handler or a chat tool must leave it
   * false: `listMarkdown` already skips dot-prefixed directories, so the
   * index never sees them, and without the check `notes.read` would happily
   * hand back the vault's endpoint credentials, `.git/config` or
   * `.obsidian/*`.
   */
  allowHiddenPaths?: boolean;
  /** Reserves watcher attribution before a mutation can become observable. */
  reserveMutation?: (mutation: VaultMutation) => () => void;
  /** Receives successful public vault mutations for watcher attribution. */
  onMutation?: (mutation: VaultMutation) => void;
  /** Private, non-vault directory that authorizes interrupted mutation recovery. */
  recoveryDir?: string;
  /** Connected editors/policy authority can veto an imminent public mutation. */
  beforeMutation?: (paths: string[]) => Promise<undefined | (() => void)>;
}

/** Is `candidate` the root itself or a descendant of it? */
export function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * `realpath` of the deepest existing ancestor of `absolute`, with the
 * not-yet-created tail re-appended. A plain `realpath` would throw ENOENT
 * for a file about to be written, and skipping the check for new files
 * would leave the symlink hole open for its parent directories.
 */
export function realpathOfNearestExisting(absolute: string): string {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export class FsVault implements VaultAdapter {
  private readonly atomic: GuardedAtomicFs;
  private readonly visibleMutations = new Map<string, Promise<void>>();
  private mutationGeneration = 0;
  private readonly mutationTurns = new Map<string, Promise<void>>();
  /**
   * Vault-relative paths that must never reach the indexer. Set from
   * `settings.indexer.excludePaths` / `excludeGlobs` in bootstrap, which
   * is the only place that has read the settings by the time the vault
   * is used. It excludes nothing until bootstrap installs the configured
   * predicate.
   */
  private exclude: (vaultPath: string) => boolean = () => false;
  private resolvedRootCache: string | null = null;
  private readonly recoveryDir: string;

  constructor(
    private readonly root: string,
    private readonly options: FsVaultOptions = {},
  ) {
    this.recoveryDir = options.recoveryDir ?? join(vaultStateDir(root), "vault-mutations");
    this.atomic = {
      writeBinary: (path, data, mode) => this.writeBinaryExclusive(path, data, mode),
      readText: (path) => this.readTextRaw(path),
      rename: (from, to) => this.renameRaw(from, to),
      remove: (path) => this.removeRaw(path),
      link: (from, to) => this.linkRaw(from, to),
      statMode: (path) => this.statModeRaw(path),
      chmod: (path, mode) => this.chmodRaw(path, mode),
      beginRecovery: (record) => this.beginRecovery(record),
      finishRecovery: (id) => this.finishRecovery(id),
      sameEntry: async (from, to) => {
        try {
          return await this.withRegularFile(from, READ_OPEN_FLAGS, async (a) =>
            this.withRegularFile(to, READ_OPEN_FLAGS, async (b) =>
              sameFile(await a.stat(), await b.stat()),
            ),
          );
        } catch (error) {
          if (isMissingFile(error)) return false;
          throw error;
        }
      },
    };
  }

  /** Install the indexer exclusion predicate. See `this.exclude`. */
  setExclusion(predicate: (vaultPath: string) => boolean): void {
    this.exclude = predicate;
  }

  isIndexablePath(path: string): boolean {
    return isCanonicalPublicNotePath(path) && !this.exclude(path);
  }

  /** Recover only artifacts authorized by the private per-vault journal. */
  async cleanupInterruptedWrites(): Promise<number> {
    const records = await readRecoveryRecords(this.recoveryDir, (path) =>
      this.lexicalAbsolute(path),
    );
    let recovered = 0;
    for (const record of records) recovered += await recoverRecord(record, this.atomic);
    return recovered;
  }

  private async beginRecovery(record: AtomicRecoveryRecord): Promise<void> {
    await mkdir(this.recoveryDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.recoveryDir, 0o700);
    const journalPath = join(this.recoveryDir, `${record.id}.json`);
    const handle = await open(journalPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(this.recoveryDir);
  }

  private async finishRecovery(id: string): Promise<void> {
    try {
      await rm(join(this.recoveryDir, `${id}.json`), { force: true });
      await syncDirectory(this.recoveryDir);
    } catch {
      // The authenticated record is intentionally retained for the next boot.
    }
  }

  async listMarkdown(): Promise<{ path: string; mtime: number }[]> {
    return this.readVisible(null, () => this.listMarkdownRaw());
  }

  private async listMarkdownRaw(): Promise<{ path: string; mtime: number }[]> {
    const results: { path: string; mtime: number }[] = [];
    const root = await this.openDirectorySegments([], false);
    try {
      await this.walk(root, "", results);
    } finally {
      await root.handle.close();
    }
    return results;
  }

  async read(path: string): Promise<string> {
    return await this.readVisible(path, () => this.readTextRaw(path));
  }

  async readBounded(path: string, maxBytes: number): Promise<string> {
    assertValidReadLimit(maxBytes);
    return await this.readVisible(path, () =>
      this.withRegularFile(path, READ_OPEN_FLAGS, async (handle) => {
        if ((await handle.stat()).size > maxBytes) throw new VaultReadLimitError(maxBytes);

        const bytes = Buffer.allocUnsafe(maxBytes + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > maxBytes) throw new VaultReadLimitError(maxBytes);
        return bytes.subarray(0, offset).toString("utf8");
      }),
    );
  }

  async write(path: string, content: string): Promise<void> {
    await this.withMutationTurn(path, async () => {
      await this.commitWrite(path, content);
    });
  }

  async createIfAbsent(
    path: string,
    content: string,
    beforeEffect?: () => Promise<void>,
  ): Promise<boolean> {
    return await this.withMutationTurn(path, async () => {
      const releaseHost = await this.options.beforeMutation?.([path]);
      const mutation = writeMutation(path, content);
      const cancel = this.reserveMutation(mutation);
      try {
        await this.ensureParent(path);
        await beforeEffect?.();
        const written = await this.publishVisible([path], () =>
          atomicCreateIfAbsent(this.atomic, path, content),
        );
        if (!written) {
          cancel();
          return false;
        }
        this.options.onMutation?.(mutation);
        return true;
      } catch (error) {
        cancel();
        throw error;
      } finally {
        releaseHost?.();
      }
    });
  }

  async writeIfUnchanged(
    path: string,
    expected: string,
    content: string,
    beforeEffect?: () => Promise<void>,
  ): Promise<boolean> {
    return await this.withMutationTurn(path, async () => {
      const releaseHost = await this.options.beforeMutation?.([path]);
      const mutation = writeMutation(path, content);
      const cancel = this.reserveMutation(mutation);
      try {
        await this.ensureParent(path);
        await beforeEffect?.();
        const written = await this.publishVisible([path], () =>
          atomicReplaceIfUnchanged(this.atomic, path, expected, content),
        );
        if (!written) {
          cancel();
          return false;
        }
        this.options.onMutation?.(mutation);
        return true;
      } catch (error) {
        cancel();
        throw error;
      } finally {
        releaseHost?.();
      }
    });
  }

  async updateFrontmatter(path: string, patch: Record<string, unknown>): Promise<void> {
    const attempts = 5;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let before: string;
      try {
        before = await this.read(path);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        const created = await this.createIfAbsent(path, patchFrontmatter("", patch));
        if (created) return;
        continue;
      }
      const next = patchFrontmatter(before, patch);
      if (next === before) return;
      if (await this.writeIfUnchanged(path, before, next)) return;
    }
    throw new VaultMutationConflict(path);
  }

  async remove(path: string): Promise<void> {
    await this.withMutationTurn(path, async () => {
      const releaseHost = await this.options.beforeMutation?.([path]);
      const mutation = { kind: "remove", path } as const;
      const cancel = this.reserveMutation(mutation);
      try {
        await this.removeRaw(path);
        this.options.onMutation?.(mutation);
      } catch (error) {
        cancel();
        throw error;
      } finally {
        releaseHost?.();
      }
    });
  }

  async removeIfUnchanged(
    path: string,
    expected: string,
    beforeEffect?: () => Promise<void>,
  ): Promise<boolean> {
    return await this.withMutationTurn(path, async () => {
      const releaseHost = await this.options.beforeMutation?.([path]);
      const mutation = { kind: "remove", path } as const;
      const cancel = this.reserveMutation(mutation);
      try {
        await beforeEffect?.();
        const removed = await this.publishVisible([path], () =>
          atomicRemoveIfUnchanged(this.atomic, path, expected),
        );
        if (!removed) {
          cancel();
          return false;
        }
        this.options.onMutation?.(mutation);
        return true;
      } catch (error) {
        cancel();
        throw error;
      } finally {
        releaseHost?.();
      }
    });
  }

  private async commitWrite(path: string, content: string): Promise<void> {
    const releaseHost = await this.options.beforeMutation?.([path]);
    const mutation = writeMutation(path, content);
    const cancel = this.reserveMutation(mutation);
    try {
      await this.ensureParent(path);
      await this.publishVisible([path], () => atomicWrite(this.atomic, path, content));
      this.options.onMutation?.(mutation);
    } catch (error) {
      cancel();
      throw error;
    } finally {
      releaseHost?.();
    }
  }

  private reserveMutation(mutation: VaultMutation): () => void {
    return this.options.reserveMutation?.(mutation) ?? (() => {});
  }

  /** The guarded claim/publish interval can temporarily remove a pathname.
   * Public readers wait only for that filesystem interval, never for editor
   * permission or before-effect checks (which themselves read the vault). */
  private async publishVisible<T>(paths: string[], action: () => Promise<T>): Promise<T> {
    let release = (): void => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const keys = paths.map((path) => this.lexicalAbsolute(path));
    for (const key of keys) this.visibleMutations.set(key, pending);
    this.mutationGeneration++;
    try {
      return await action();
    } finally {
      this.mutationGeneration++;
      for (const key of keys)
        if (this.visibleMutations.get(key) === pending) this.visibleMutations.delete(key);
      release();
    }
  }

  private async readVisible<T>(
    path: string | null,
    read: () => Promise<T>,
    absent: (value: T) => boolean = () => false,
  ): Promise<T> {
    const key = path === null ? null : this.lexicalAbsolute(path);
    for (let attempt = 0; attempt < 4; attempt++) {
      const generation = this.mutationGeneration;
      if (key === null) await Promise.all(this.visibleMutations.values());
      else await this.visibleMutations.get(key);
      try {
        const value = await read();
        if (absent(value) && generation !== this.mutationGeneration) continue;
        return value;
      } catch (error) {
        // An owned write can start after the wait and before the OS read.
        // Retry only an observed absence across that known mutation interval.
        if (!isMissingFile(error) || generation === this.mutationGeneration) throw error;
      }
    }
    throw new VaultMutationConflict(path ?? "vault listing");
  }

  private async withMutationTurn<T>(path: string, action: () => Promise<T>): Promise<T> {
    const key = this.lexicalAbsolute(path);
    const previous = this.mutationTurns.get(key);
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationTurns.set(key, current);
    if (previous !== undefined) await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.mutationTurns.get(key) === current) this.mutationTurns.delete(key);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.readVisible(
      path,
      () => this.existsRaw(path),
      (value) => !value,
    );
  }

  private async existsRaw(path: string): Promise<boolean> {
    const segments = this.pathSegments(path);
    if (segments.length === 0) {
      try {
        const root = await this.openDirectorySegments([], false);
        await root.handle.close();
        return true;
      } catch (error) {
        if (isMissingFile(error)) return false;
        throw error;
      }
    }

    let leaf: AnchoredLeaf;
    try {
      leaf = await this.openParent(path, false);
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
    try {
      let entry: Stats;
      try {
        entry = await lstat(leaf.path);
      } catch (error) {
        if (isMissingFile(error)) return false;
        throwPathRefusal(error);
      }
      if (!entry.isFile() && !entry.isDirectory()) throw pathEscapes();
      return true;
    } finally {
      await leaf.parent.handle.close();
    }
  }

  async createFolder(path: string): Promise<void> {
    const directory = await this.openDirectorySegments(this.pathSegments(path), true);
    await directory.handle.close();
  }

  async list(folder: string): Promise<VaultListing> {
    let directory: AnchoredDirectory;
    try {
      directory = await this.openDirectorySegments(this.pathSegments(folder), false);
    } catch (error) {
      if (isMissingFile(error)) return { files: [], folders: [] };
      throw error;
    }
    try {
      const entries = await readdir(directory.path, { withFileTypes: true });
      const files: string[] = [];
      const folders: string[] = [];
      for (const entry of entries) {
        const childPath = folder === "" ? entry.name : `${folder}/${entry.name}`;
        if (entry.isDirectory()) folders.push(childPath);
        else if (entry.isFile()) files.push(childPath);
      }
      return { files, folders };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return { files: [], folders: [] };
    } finally {
      await directory.handle.close();
    }
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    try {
      const buffer = await this.withRegularFile(
        path,
        READ_OPEN_FLAGS,
        async (handle) => await handle.readFile(),
      );
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const leaf = await this.openParent(path, true);
    try {
      let handle: FileHandle;
      try {
        handle = await open(
          leaf.path,
          constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if (!isMissingFile(error)) throwPathRefusal(error);
        handle = await open(
          leaf.path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
      }
      try {
        await assertRegularFile(handle);
        await handle.truncate(0);
        await handle.writeFile(new Uint8Array(data));
      } finally {
        await handle.close();
      }
    } finally {
      await leaf.parent.handle.close();
    }
  }

  private async writeBinaryExclusive(path: string, data: ArrayBuffer, mode: number): Promise<void> {
    const leaf = await this.openParent(path, true);
    try {
      const handle = await open(
        leaf.path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        mode,
      );
      try {
        await assertRegularFile(handle);
        await handle.writeFile(new Uint8Array(data));
      } finally {
        await handle.close();
      }
    } catch (error) {
      throwPathRefusal(error);
    } finally {
      await leaf.parent.handle.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const releaseHost = await this.options.beforeMutation?.([from, to]);
    const mutation = { kind: "rename", fromPath: from, toPath: to } as const;
    const cancel = this.reserveMutation(mutation);
    try {
      await this.renameRaw(from, to);
      this.options.onMutation?.(mutation);
    } catch (error) {
      cancel();
      throw error;
    } finally {
      releaseHost?.();
    }
  }

  async moveIfUnchanged(
    from: string,
    to: string,
    expected: string,
    beforeEffect?: () => Promise<void>,
  ): Promise<boolean> {
    if (from === to) throw new Error("move source and destination must differ");
    const [first, second] = [from, to].sort();
    return this.withMutationTurn(first, () =>
      this.withMutationTurn(second, async () => {
        const releaseHost = await this.options.beforeMutation?.([from, to]);
        const mutation = { kind: "rename", fromPath: from, toPath: to } as const;
        const cancel = this.reserveMutation(mutation);
        try {
          await this.ensureParent(to);
          await beforeEffect?.();
          const applied = await this.publishVisible([from, to], () =>
            atomicMoveIfUnchanged(this.atomic, from, to, expected),
          );
          if (!applied) cancel();
          else this.options.onMutation?.(mutation);
          return applied;
        } catch (error) {
          cancel();
          throw error;
        } finally {
          releaseHost?.();
        }
      }),
    );
  }

  private async renameRaw(from: string, to: string): Promise<void> {
    const source = await this.openParent(from, false);
    let destination: AnchoredLeaf | null = null;
    let sourceHandle: FileHandle | null = null;
    let destinationHandle: FileHandle | null = null;
    let renamedHandle: FileHandle | null = null;
    try {
      destination = await this.openParent(to, true);
      sourceHandle = await this.openSupportedEntry(source, true);
      const sourceIdentity = await sourceHandle.stat();
      destinationHandle = await this.openOptionalSupportedEntry(destination, true);
      await rename(source.path, destination.path);
      // DrvFS completes the rename but can report ENOENT when the renamed
      // pathname is reopened through the anchored /proc directory while a
      // descriptor to the pre-rename name is still live. Close that source
      // descriptor after the namespace transition and before verification.
      // The captured device/inode identity remains the verification authority.
      await sourceHandle.close();
      sourceHandle = null;
      renamedHandle = await this.openSupportedEntry(destination, sourceIdentity.isDirectory());
      if (!sameFile(sourceIdentity, await renamedHandle.stat())) {
        throw new Error("vault entry changed during descriptor-anchored rename");
      }
    } catch (error) {
      throwPathRefusal(error);
    } finally {
      await renamedHandle?.close();
      await destinationHandle?.close();
      await sourceHandle?.close();
      await destination?.parent.handle.close();
      await source.parent.handle.close();
    }
  }

  private async removeRaw(path: string): Promise<void> {
    let leaf: AnchoredLeaf;
    try {
      leaf = await this.openParent(path, false);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    let handle: FileHandle | null = null;
    try {
      handle = await this.openOptionalSupportedEntry(leaf, false);
      if (handle === null) return;
      await rm(leaf.path);
    } catch (error) {
      throwPathRefusal(error);
    } finally {
      await handle?.close();
      await leaf.parent.handle.close();
    }
  }

  /** Validate and canonicalize only the caller-controlled lexical path. */
  private pathSegments(path: string): string[] {
    if (isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) throw pathEscapes();
    const segments = path.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
    if (segments.some((segment) => segment === ".." || segment.includes("\0"))) {
      throw pathEscapes();
    }
    if (!this.options.allowHiddenPaths && segments.some((segment) => segment.startsWith("."))) {
      throw hiddenPath();
    }
    return segments;
  }

  /**
   * Stable lexical identity for mutation serialization and recovery-record
   * validation. Filesystem I/O never uses this pathname: every operation
   * below traverses from an open vault-root descriptor instead.
   */
  private lexicalAbsolute(path: string): string {
    const segments = this.pathSegments(path);
    const absolute = resolve(this.root, ...segments);
    if (!isWithin(this.resolvedRoot, absolute)) throw pathEscapes();
    return absolute;
  }

  /** `this.root` with lexical `.`/`..` components collapsed. */
  private get resolvedRoot(): string {
    this.resolvedRootCache ??= resolve(this.root);
    return this.resolvedRootCache;
  }

  private async ensureParent(path: string): Promise<void> {
    const leaf = await this.openParent(path, true);
    await leaf.parent.handle.close();
  }

  /**
   * Open the vault root without following a final symlink, then prove that
   * the OS descriptor capability path resolves to that exact directory.
   * Linux exposes this through `/proc/self/fd`; Darwin may expose it through
   * `/dev/fd`. Other platforms fail closed instead of falling back to a
   * check-then-use pathname.
   */
  private async openRootDirectory(create: boolean): Promise<AnchoredDirectory> {
    descriptorRoot();
    if (create) await mkdir(this.resolvedRoot, { recursive: true });

    let handle: FileHandle;
    try {
      handle = await open(this.resolvedRoot, DIRECTORY_OPEN_FLAGS);
    } catch (error) {
      throwPathRefusal(error);
    }
    try {
      return await verifyDirectoryHandle(handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /** Traverse one vault segment at a time while its parent descriptor lives. */
  private async openDirectorySegments(
    segments: readonly string[],
    create: boolean,
  ): Promise<AnchoredDirectory> {
    let current = await this.openRootDirectory(create);
    try {
      for (const segment of segments) {
        const next = await this.openChildDirectory(current, segment, create);
        await current.handle.close();
        current = next;
      }
      return current;
    } catch (error) {
      await current.handle.close();
      throw error;
    }
  }

  private async openChildDirectory(
    parent: AnchoredDirectory,
    name: string,
    create: boolean,
  ): Promise<AnchoredDirectory> {
    const path = `${parent.path}/${name}`;
    const handle = await this.openDirectoryHandle(path, create);
    try {
      return await verifyDirectoryHandle(handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async openDirectoryHandle(path: string, create: boolean): Promise<FileHandle> {
    try {
      return await open(path, DIRECTORY_OPEN_FLAGS);
    } catch (error) {
      if (!create || !isMissingFile(error)) throwPathRefusal(error);
    }
    try {
      await mkdir(path);
    } catch (error) {
      if (!isAlreadyExists(error)) throwPathRefusal(error);
    }
    try {
      return await open(path, DIRECTORY_OPEN_FLAGS);
    } catch (error) {
      throwPathRefusal(error);
    }
  }

  /** Resolve only the parent directory and keep its descriptor live. */
  private async openParent(path: string, create: boolean): Promise<AnchoredLeaf> {
    const segments = this.pathSegments(path);
    const name = segments.at(-1);
    if (name === undefined) throw pathEscapes();
    const parent = await this.openDirectorySegments(segments.slice(0, -1), create);
    return { parent, name, path: `${parent.path}/${name}` };
  }

  private async withRegularFile<T>(
    path: string,
    flags: number,
    action: (handle: FileHandle) => Promise<T>,
  ): Promise<T> {
    const leaf = await this.openParent(path, false);
    let handle: FileHandle | null = null;
    try {
      handle = await open(leaf.path, flags);
      await assertRegularFile(handle);
      return await action(handle);
    } catch (error) {
      return throwPathRefusal(error);
    } finally {
      await handle?.close();
      await leaf.parent.handle.close();
    }
  }

  private async readTextRaw(path: string): Promise<string> {
    return await this.withRegularFile(
      path,
      READ_OPEN_FLAGS,
      async (handle) => await handle.readFile("utf8"),
    );
  }

  private async statModeRaw(path: string): Promise<number> {
    return await this.withRegularFile(
      path,
      READ_OPEN_FLAGS,
      async (handle) => (await handle.stat()).mode,
    );
  }

  private async chmodRaw(path: string, mode: number): Promise<void> {
    await this.withRegularFile(path, READ_OPEN_FLAGS, async (handle) => {
      await handle.chmod(mode);
    });
  }

  private async openSupportedEntry(
    leaf: AnchoredLeaf,
    allowDirectory: boolean,
  ): Promise<FileHandle> {
    let handle: FileHandle;
    try {
      handle = await open(leaf.path, READ_OPEN_FLAGS);
    } catch (error) {
      throwPathRefusal(error);
    }
    try {
      const entry = await handle.stat();
      if (!entry.isFile() && !(allowDirectory && entry.isDirectory())) throw pathEscapes();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async openOptionalSupportedEntry(
    leaf: AnchoredLeaf,
    allowDirectory: boolean,
  ): Promise<FileHandle | null> {
    try {
      return await this.openSupportedEntry(leaf, allowDirectory);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  private async linkRaw(from: string, to: string): Promise<void> {
    const source = await this.openParent(from, false);
    let destination: AnchoredLeaf | null = null;
    let sourceHandle: FileHandle | null = null;
    let linkedHandle: FileHandle | null = null;
    try {
      destination = await this.openParent(to, true);
      sourceHandle = await this.openSupportedEntry(source, false);
      const sourceIdentity = await sourceHandle.stat();
      await link(source.path, destination.path);
      linkedHandle = await this.openSupportedEntry(destination, false);
      if (!sameFile(sourceIdentity, await linkedHandle.stat())) {
        throw new Error("vault entry changed during descriptor-anchored link");
      }
    } catch (error) {
      throwPathRefusal(error);
    } finally {
      await linkedHandle?.close();
      await sourceHandle?.close();
      await destination?.parent.handle.close();
      await source.parent.handle.close();
    }
  }

  private async walk(
    directory: AnchoredDirectory,
    parentPath: string,
    results: { path: string; mtime: number }[],
  ): Promise<void> {
    const entries = await readdir(directory.path, { withFileTypes: true });
    for (const entry of entries) {
      await this.walkEntry(directory, parentPath, entry, results);
    }
  }

  private async walkEntry(
    directory: AnchoredDirectory,
    parentPath: string,
    entry: Dirent,
    results: { path: string; mtime: number }[],
  ): Promise<void> {
    const vaultPath = parentPath === "" ? entry.name : `${parentPath}/${entry.name}`;
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) return;
      const child = await this.openChildDirectory(directory, entry.name, false);
      try {
        await this.walk(child, vaultPath, results);
      } finally {
        await child.handle.close();
      }
      return;
    }
    if (!isIndexableMarkdownEntry(entry, vaultPath, this.exclude)) return;
    const leaf: AnchoredLeaf = {
      parent: directory,
      name: entry.name,
      path: `${directory.path}/${entry.name}`,
    };
    const handle = await this.openSupportedEntry(leaf, false);
    try {
      results.push({ path: vaultPath, mtime: (await handle.stat()).mtimeMs });
    } finally {
      await handle.close();
    }
  }
}

function descriptorRoot(): string {
  if (process.platform === "linux") return "/proc/self/fd";
  if (process.platform === "darwin") return "/dev/fd";
  throw new Error(
    `secure descriptor-relative vault I/O is unavailable on platform '${process.platform}'`,
  );
}

function assertValidReadLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= bufferConstants.MAX_LENGTH) {
    throw new RangeError(`maxBytes must be an integer from 0 to ${bufferConstants.MAX_LENGTH - 1}`);
  }
}

function shouldSkipDirectory(name: string): boolean {
  return DOT_PREFIXES.has(name) || HARD_SKIP.has(name) || name.startsWith(".");
}

function isIndexableMarkdownEntry(
  entry: Dirent,
  vaultPath: string,
  exclude: (path: string) => boolean,
): boolean {
  return (
    entry.isFile() &&
    !entry.name.startsWith(".") &&
    entry.name.endsWith(".md") &&
    isCanonicalPublicNotePath(vaultPath) &&
    !exclude(vaultPath)
  );
}

async function verifyDirectoryHandle(handle: FileHandle): Promise<AnchoredDirectory> {
  const path = `${descriptorRoot()}/${handle.fd}`;
  try {
    const [opened, capability, traversed] = await Promise.all([
      handle.stat(),
      stat(path),
      stat(`${path}/.`),
    ]);
    if (
      !opened.isDirectory() ||
      !capability.isDirectory() ||
      !traversed.isDirectory() ||
      !sameFile(opened, capability) ||
      !sameFile(opened, traversed)
    ) {
      throw new Error("descriptor capability did not resolve to the opened vault directory");
    }
    return { handle, path };
  } catch (error) {
    throw new Error("secure descriptor-relative vault I/O is unavailable", { cause: error });
  }
}

async function assertRegularFile(handle: FileHandle): Promise<void> {
  if (!(await handle.stat()).isFile()) throw pathEscapes();
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function throwPathRefusal(error: unknown): never {
  if (error instanceof VaultPathError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (
    code === "ELOOP" ||
    code === "ENOTDIR" ||
    code === "EISDIR" ||
    code === "ENXIO" ||
    code === "ENODEV" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP"
  ) {
    throw pathEscapes();
  }
  throw error;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

async function readRecoveryRecords(
  recoveryDir: string,
  resolveVaultPath: (path: string) => string,
): Promise<AtomicRecoveryRecord[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(recoveryDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const records: AtomicRecoveryRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw new Error(`vault recovery journal contains an unexpected entry: ${entry.name}`);
    }
    const id = entry.name.slice(0, -".json".length);
    if (!UUID_V4.test(id)) {
      throw new Error(`vault recovery journal filename is invalid: ${entry.name}`);
    }
    const raw = await readFile(join(recoveryDir, entry.name), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`vault recovery journal is corrupt: ${entry.name}`, { cause: error });
    }
    records.push(parseRecoveryRecord(parsed, id, resolveVaultPath));
  }
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

function parseRecoveryRecord(
  raw: unknown,
  journalId: string,
  resolveVaultPath: (path: string) => string,
): AtomicRecoveryRecord {
  if (!isObject(raw) || raw.version !== 1 || raw.id !== journalId) {
    throw new Error(`vault recovery journal identity is invalid: ${journalId}`);
  }
  if (
    raw.operation !== "write" &&
    raw.operation !== "create" &&
    raw.operation !== "replace" &&
    raw.operation !== "remove" &&
    raw.operation !== "move"
  ) {
    throw new Error(`vault recovery journal operation is invalid: ${journalId}`);
  }
  const target = requireRecoveryPath(raw.target, "target", journalId, resolveVaultPath);
  const prepared = optionalRecoveryPath(raw.prepared, "prepared", journalId, resolveVaultPath);
  const claim = optionalRecoveryPath(raw.claim, "claim", journalId, resolveVaultPath);
  const rollback = optionalRecoveryPath(raw.rollback, "rollback", journalId, resolveVaultPath);
  const expectedSha256 = optionalRecoveryHash(raw.expectedSha256, "expected", journalId);
  const replacementSha256 = optionalRecoveryHash(raw.replacementSha256, "replacement", journalId);

  const hasPrepared = raw.operation !== "remove" && raw.operation !== "move";
  const hasClaim =
    raw.operation === "replace" || raw.operation === "remove" || raw.operation === "move";
  const hasRollback = raw.operation === "replace";
  if (
    (prepared !== null) !== hasPrepared ||
    (claim !== null) !== hasClaim ||
    (rollback !== null) !== hasRollback ||
    (expectedSha256 !== null) !== hasClaim ||
    (replacementSha256 !== null) !== hasPrepared
  ) {
    throw new Error(`vault recovery journal shape is invalid: ${journalId}`);
  }
  if (prepared !== null && !isPreparedFor(prepared, target, journalId)) {
    throw new Error(`vault recovery prepared path is invalid: ${journalId}`);
  }
  if (claim !== null && !isClaimFor(claim, target, journalId)) {
    throw new Error(`vault recovery claim path is invalid: ${journalId}`);
  }
  if (rollback !== null && !isRollbackFor(rollback, target, journalId)) {
    throw new Error(`vault recovery rollback path is invalid: ${journalId}`);
  }
  return {
    version: 1,
    id: journalId,
    operation: raw.operation,
    target,
    prepared,
    claim,
    rollback,
    expectedSha256,
    replacementSha256,
    ...(raw.operation === "move"
      ? {
          destination: requireRecoveryPath(
            raw.destination,
            "destination",
            journalId,
            resolveVaultPath,
          ),
        }
      : {}),
  };
}

async function recoverRecord(record: AtomicRecoveryRecord, fs: GuardedAtomicFs): Promise<number> {
  if (record.operation === "move" && record.claim && record.destination) {
    if (!fs.sameEntry) throw new Error("move recovery requires filesystem identity checks");
    if (await fs.sameEntry(record.claim, record.destination)) {
      await fs.remove(record.claim);
      await fs.finishRecovery(record.id);
      return 1;
    }
  }
  await assertNoInterruptedRollback(record, fs);
  const recovered = (await recoverClaim(record, fs)) + (await removePrepared(record, fs));
  await fs.finishRecovery(record.id);
  return recovered;
}

async function assertNoInterruptedRollback(
  record: AtomicRecoveryRecord,
  fs: GuardedAtomicFs,
): Promise<void> {
  if (record.rollback === null || (await readOptionalText(fs, record.rollback)) === null) return;
  throw new Error(
    `vault recovery conflict: interrupted rollback for '${record.target}' requires operator review`,
  );
}

async function recoverClaim(record: AtomicRecoveryRecord, fs: GuardedAtomicFs): Promise<number> {
  if (record.claim === null) return 0;
  const claimBody = await readOptionalText(fs, record.claim);
  if (claimBody === null) return 0;
  const targetBody = await readOptionalText(fs, record.target);
  if (targetBody === null) {
    const restored = await restoreInterruptedClaim(record, fs);
    // An external writer may win after the absence check. In that case the
    // claim is not linked at the canonical path; re-verify it immediately
    // before discarding so a write through an already-open descriptor is not
    // silently lost.
    if (!restored) {
      const currentClaim = await readOptionalText(fs, record.claim);
      if (currentClaim === null) return 0;
      assertUnchangedClaim(record, currentClaim);
    }
  } else {
    assertUnchangedClaim(record, claimBody);
  }
  await fs.remove(record.claim);
  return 1;
}

async function restoreInterruptedClaim(
  record: AtomicRecoveryRecord,
  fs: GuardedAtomicFs,
): Promise<boolean> {
  if (record.claim === null) throw new Error("vault recovery claim unexpectedly absent");
  try {
    await fs.link(record.claim, record.target);
    return true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return false;
  }
}

function assertUnchangedClaim(record: AtomicRecoveryRecord, claimBody: string): void {
  if (sha256(claimBody) === record.expectedSha256) return;
  throw new Error(
    `vault recovery conflict: claimed bytes for '${record.target}' changed after comparison`,
  );
}

async function removePrepared(record: AtomicRecoveryRecord, fs: GuardedAtomicFs): Promise<number> {
  if (record.prepared === null) return 0;
  const preparedBody = await readOptionalText(fs, record.prepared);
  if (preparedBody === null) return 0;
  if (sha256(preparedBody) !== record.replacementSha256) {
    throw new Error(
      `vault recovery conflict: prepared bytes for '${record.target}' were externally changed`,
    );
  }
  await fs.remove(record.prepared);
  return 1;
}

function requireRecoveryPath(
  raw: unknown,
  label: string,
  id: string,
  resolveVaultPath: (path: string) => string,
): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`vault recovery ${label} path is invalid: ${id}`);
  }
  resolveVaultPath(raw);
  return raw;
}

function optionalRecoveryPath(
  raw: unknown,
  label: string,
  id: string,
  resolveVaultPath: (path: string) => string,
): string | null {
  if (raw === null) return null;
  return requireRecoveryPath(raw, label, id, resolveVaultPath);
}

function optionalRecoveryHash(raw: unknown, label: string, id: string): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || !SHA256.test(raw)) {
    throw new Error(`vault recovery ${label} hash is invalid: ${id}`);
  }
  return raw;
}

function isPreparedFor(path: string, target: string, id: string): boolean {
  return (
    dirname(path) === dirname(target) &&
    path.startsWith(`${target}.notient-tmp-`) &&
    path.endsWith(`-${id}`) &&
    isAtomicWriteTempName(basename(path))
  );
}

function isClaimFor(path: string, target: string, id: string): boolean {
  return (
    dirname(path) === dirname(target) &&
    path.endsWith(`-${id}`) &&
    interruptedClaimTargetName(basename(path)) === basename(target)
  );
}

function isRollbackFor(path: string, target: string, id: string): boolean {
  return (
    dirname(path) === dirname(target) &&
    path.endsWith(`-${id}`) &&
    interruptedRollbackTargetName(basename(path)) === basename(target)
  );
}

async function readOptionalText(fs: GuardedAtomicFs, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeMutation(path: string, content: string): VaultMutation {
  return { kind: "write", path, sha: sha256(content) };
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class VaultMutationConflict extends Error {
  constructor(readonly path: string) {
    super(`vault note changed repeatedly during guarded update: ${path}`);
    this.name = "VaultMutationConflict";
  }
}
