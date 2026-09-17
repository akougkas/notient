/**
 * VaultAdapter is the substrate's only door to vault content.
 *
 * The interface keeps the substrate I/O-agnostic. `FsVault` implements the
 * contract over `node:fs` for the daemon.
 */

export interface VaultListing {
  files: string[];
  folders: string[];
}

/** A caller supplied a path that the vault security boundary refuses. */
export class VaultPathError extends Error {
  constructor(readonly reason: "escape" | "hidden") {
    super(reason === "escape" ? "path escapes vault" : "hidden path");
    this.name = "VaultPathError";
  }
}

/** A descriptor read reached the caller's exact byte ceiling plus one. */
export class VaultReadLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`vault file exceeds ${maxBytes} byte limit`);
    this.name = "VaultReadLimitError";
  }
}

/** An editor refused admission before any filesystem effect. Unlike an I/O
 * failure, this is a recoverable availability/conflict condition. */
export class VaultMutationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultMutationBlockedError";
  }
}

export interface VaultAdapter {
  /** Returns markdown files in the entire vault with their mtimes. */
  listMarkdown(): Promise<{ path: string; mtime: number }[]>;

  /** Current indexing exclusion policy for an exact path; does not access the file. */
  isIndexablePath(path: string): boolean;

  /** Read a UTF-8 markdown file by vault-relative path. */
  read(path: string): Promise<string>;

  /**
   * Read at most `maxBytes` from one regular file. Implementations must bind
   * containment and the byte ceiling to the same opened file descriptor and
   * must detect growth by attempting to read one sentinel byte beyond max.
   */
  readBounded(path: string, maxBytes: number): Promise<string>;

  /** Atomic write of a UTF-8 markdown file. */
  write(path: string, content: string): Promise<void>;

  /** Atomically create a UTF-8 markdown file only while the path is absent. */
  createIfAbsent(
    path: string,
    content: string,
    beforeEffect?: () => Promise<void>,
  ): Promise<boolean>;

  /**
   * Atomically replace a UTF-8 markdown file only when its current bytes
   * still equal `expected`. Returns false without changing the file when the
   * comparison fails.
   */
  writeIfUnchanged(
    path: string,
    expected: string,
    content: string,
    beforeEffect?: () => Promise<void>,
  ): Promise<boolean>;

  /**
   * Read-modify-atomic-write of YAML frontmatter. Implementations must
   * use `patchFrontmatter` semantics so VitalsService produces
   * identical bytes regardless of adapter.
   */
  updateFrontmatter(path: string, patch: Record<string, unknown>): Promise<void>;

  /** Delete a file. Implementations decide trash vs permanent. */
  remove(path: string): Promise<void>;

  /** Delete a file only while its current UTF-8 bytes still equal `expected`. */
  removeIfUnchanged(
    path: string,
    expected: string,
    beforeEffect?: () => Promise<void>,
  ): Promise<boolean>;

  /** True iff the vault-relative path resolves to an existing entry. */
  exists(path: string): Promise<boolean>;

  /** Create a folder at the vault-relative path. No-op if it exists. */
  createFolder(path: string): Promise<void>;

  /** Shallow listing of a folder. Files and folders carry vault-relative paths. */
  list(folder: string): Promise<VaultListing>;

  /** Read raw bytes for sidecars, wasm, vector index, lock files. */
  readBinary(path: string): Promise<ArrayBuffer | null>;

  /** Write raw bytes atomically. */
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;

  /** Rename a file or folder. Used by atomicWrite tmp→final swap. */
  rename(from: string, to: string): Promise<void>;
  /** Non-overwriting, journaled move with exact source-byte precondition. */
  moveIfUnchanged?(
    from: string,
    to: string,
    expected: string,
    beforeEffect?: () => Promise<void>,
  ): Promise<boolean>;
}
