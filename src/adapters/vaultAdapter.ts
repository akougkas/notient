/**
 * VaultAdapter is the substrate's only door to vault content.
 *
 * The interface extracts the contract previously embedded in
 * ObsidianFacade so the substrate stays IO-agnostic. FsVault implements
 * it over node:fs for the daemon. A future ObsidianBridgeAdapter will
 * implement a subset of it via the obsidian CLI when the editor is
 * running.
 */

export interface VaultListing {
  files: string[];
  folders: string[];
}

export interface VaultAdapter {
  /** Returns markdown files in the entire vault with their mtimes. */
  listMarkdown(): Promise<{ path: string; mtime: number }[]>;

  /** Read a UTF-8 markdown file by vault-relative path. */
  read(path: string): Promise<string>;

  /** Phase 4 alias for read; kept for substrate consumer parity. */
  readNote(path: string): Promise<string>;

  /** Atomic write of a UTF-8 markdown file. */
  write(path: string, content: string): Promise<void>;

  /** Phase 4 alias for write. */
  writeNote(path: string, content: string): Promise<void>;

  /**
   * Read-modify-atomic-write of YAML frontmatter. Implementations must
   * use the same mergeFrontmatter semantics so VitalsService and
   * NativeGraphBridge produce identical bytes regardless of adapter.
   */
  updateFrontmatter(path: string, patch: Record<string, unknown>): Promise<void>;

  /** Delete a file. Implementations decide trash vs permanent. */
  remove(path: string): Promise<void>;

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
}
