/**
 * Obsidian Facade - Thin wrapper for Obsidian APIs
 *
 * Allows core logic to be tested without Obsidian runtime.
 * All vault operations go through this facade.
 */

import {
  type App,
  type CachedMetadata,
  type EventRef,
  type MetadataCache,
  Notice,
  TFile,
  TFolder,
  type Vault,
  type Workspace,
  normalizePath,
} from "obsidian";

const SUPPORTED_EXTENSIONS = new Set(["md", "canvas", "base"]);

export interface NoteInfo {
  path: string;
  name: string;
  basename: string;
  extension: string;
  stat: {
    ctime: number;
    mtime: number;
    size: number;
  };
}

export interface NoteFrontmatter {
  tags?: string[];
  [key: string]: unknown;
}

export interface NoteMetadata {
  frontmatter: NoteFrontmatter | null;
  tags: string[];
  links: string[];
  headings: { level: number; heading: string }[];
}

/**
 * Result of a write operation
 */
export interface WriteResult {
  success: boolean;
  error?: string;
}

/**
 * Facade over Obsidian's App, Vault, MetadataCache, and Workspace
 */
export class ObsidianFacade {
  constructor(private app: App) {}

  /**
   * Get the Obsidian App instance
   */
  getApp(): App {
    return this.app;
  }

  /**
   * Get the vault instance
   */
  get vault(): Vault {
    return this.app.vault;
  }

  /**
   * Get the metadata cache
   */
  get metadataCache(): MetadataCache {
    return this.app.metadataCache;
  }

  /**
   * Get the workspace
   */
  get workspace(): Workspace {
    return this.app.workspace;
  }

  // ============ File Operations ============

  /**
   * Get all markdown files in the vault
   */
  getMarkdownFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  /**
   * Get all supported files (md, canvas, base) in the vault
   */
  getSupportedFiles(): TFile[] {
    return this.app.vault.getFiles().filter((f) => SUPPORTED_EXTENSIONS.has(f.extension));
  }

  /**
   * Get file info without reading content
   */
  getFileInfo(file: TFile): NoteInfo {
    return {
      path: file.path,
      name: file.name,
      basename: file.basename,
      extension: file.extension,
      stat: {
        ctime: file.stat.ctime,
        mtime: file.stat.mtime,
        size: file.stat.size,
      },
    };
  }

  /**
   * Read file content as string
   */
  async readFile(file: TFile): Promise<string> {
    return this.app.vault.read(file);
  }

  /**
   * Read file content by path
   */
  async readFileByPath(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return this.app.vault.read(file);
    }
    return null;
  }

  /**
   * Get file by path
   */
  getFileByPath(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  /**
   * Get folder by path
   */
  getFolderByPath(path: string): TFolder | null {
    const folder = this.app.vault.getAbstractFileByPath(path);
    return folder instanceof TFolder ? folder : null;
  }

  /**
   * Check if path exists
   */
  async pathExists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(path) !== null;
  }

  // ============ Metadata Operations ============

  /**
   * Get cached metadata for a file
   */
  getFileMetadata(file: TFile): NoteMetadata {
    const cache = this.app.metadataCache.getFileCache(file);
    return this.parseMetadata(cache);
  }

  /**
   * Get cached metadata by path
   */
  getMetadataByPath(path: string): NoteMetadata | null {
    const file = this.getFileByPath(path);
    if (!file) return null;
    return this.getFileMetadata(file);
  }

  private parseMetadata(cache: CachedMetadata | null): NoteMetadata {
    if (!cache) {
      return { frontmatter: null, tags: [], links: [], headings: [] };
    }

    const tags: string[] = [];

    // Get frontmatter tags
    if (cache.frontmatter?.tags) {
      const fmTags = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        tags.push(...fmTags);
      } else if (typeof fmTags === "string") {
        tags.push(fmTags);
      }
    }

    // Get inline tags
    if (cache.tags) {
      tags.push(...cache.tags.map((t) => t.tag.replace(/^#/, "")));
    }

    const links: string[] = [];
    if (cache.links) {
      links.push(...cache.links.map((l) => l.link));
    }
    if (cache.embeds) {
      links.push(...cache.embeds.map((e) => e.link));
    }

    const headings =
      cache.headings?.map((h) => ({
        level: h.level,
        heading: h.heading,
      })) ?? [];

    return {
      frontmatter: cache.frontmatter ? { ...cache.frontmatter } : null,
      tags: [...new Set(tags)], // Dedupe
      links: [...new Set(links)],
      headings,
    };
  }

  // ============ Write Operations (Phase 2) ============

  /**
   * Process a file atomically - read, transform, write
   * Preferred method for most content edits.
   * @param path - Normalized path to the file
   * @param fn - Transform function applied to file content
   */
  async processFile(path: string, fn: (data: string) => string): Promise<WriteResult> {
    try {
      const normalizedPath = normalizePath(path);
      const file = this.getFileByPath(normalizedPath);
      if (!file) {
        return { success: false, error: `File not found: ${normalizedPath}` };
      }

      await this.app.vault.process(file, fn);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ObsidianFacade] processFile error:", message);
      return { success: false, error: message };
    }
  }

  /**
   * Modify file content directly
   * Use processFile for atomic read-transform-write when possible.
   * @param path - Normalized path to the file
   * @param content - New content to write
   */
  async modifyFile(path: string, content: string): Promise<WriteResult> {
    try {
      const normalizedPath = normalizePath(path);
      const file = this.getFileByPath(normalizedPath);
      if (!file) {
        return { success: false, error: `File not found: ${normalizedPath}` };
      }

      await this.app.vault.modify(file, content);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ObsidianFacade] modifyFile error:", message);
      return { success: false, error: message };
    }
  }

  /**
   * Rename or move a file
   * Automatically creates destination folder if it doesn't exist.
   * @param from - Current path
   * @param to - New path
   */
  async renameFile(from: string, to: string): Promise<WriteResult> {
    try {
      const normalizedFrom = normalizePath(from);
      const normalizedTo = normalizePath(to);
      const file = this.getFileByPath(normalizedFrom);
      if (!file) {
        return { success: false, error: `File not found: ${normalizedFrom}` };
      }

      // Check if destination already exists
      if (this.getFileByPath(normalizedTo)) {
        return { success: false, error: `Destination already exists: ${normalizedTo}` };
      }

      // Ensure destination folder exists (create if needed)
      const destFolder = normalizedTo.split("/").slice(0, -1).join("/");
      if (destFolder && !this.app.vault.getAbstractFileByPath(destFolder)) {
        await this.app.vault.createFolder(destFolder);
      }

      await this.app.fileManager.renameFile(file, normalizedTo);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ObsidianFacade] renameFile error:", message);
      return { success: false, error: message };
    }
  }

  /**
   * Send a file to trash
   * @param path - Path to the file
   * @param useSystemTrash - If true, uses system trash; otherwise vault trash
   */
  async trashFile(path: string, useSystemTrash = false): Promise<WriteResult> {
    try {
      const normalizedPath = normalizePath(path);
      const file = this.getFileByPath(normalizedPath);
      if (!file) {
        return { success: false, error: `File not found: ${normalizedPath}` };
      }

      await this.app.vault.trash(file, useSystemTrash);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ObsidianFacade] trashFile error:", message);
      return { success: false, error: message };
    }
  }

  /**
   * Process frontmatter using Obsidian's built-in YAML parser
   * Avoids manual YAML parsing which can be error-prone.
   * @param path - Path to the file
   * @param updater - Function to modify frontmatter object in-place
   */
  async processFrontMatter(
    path: string,
    updater: (frontmatter: Record<string, unknown>) => void,
  ): Promise<WriteResult> {
    try {
      const normalizedPath = normalizePath(path);
      const file = this.getFileByPath(normalizedPath);
      if (!file) {
        return { success: false, error: `File not found: ${normalizedPath}` };
      }

      await this.app.fileManager.processFrontMatter(file, updater);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ObsidianFacade] processFrontMatter error:", message);
      return { success: false, error: message };
    }
  }

  /**
   * Create a folder if it doesn't exist
   * Required before renameFile when moving to a new folder.
   * @param folderPath - Path to the folder to create
   */
  async createFolderIfNeeded(folderPath: string): Promise<WriteResult> {
    try {
      const normalizedPath = normalizePath(folderPath);

      // Check if already exists
      const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (existing) {
        if (existing instanceof TFolder) {
          return { success: true }; // Already exists as folder
        }
        return { success: false, error: `Path exists but is not a folder: ${normalizedPath}` };
      }

      // Create folder (creates parent folders as needed)
      await this.app.vault.createFolder(normalizedPath);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Obsidian may throw if folder already exists (race condition)
      if (message.includes("Folder already exists")) {
        return { success: true };
      }
      console.error("[ObsidianFacade] createFolderIfNeeded error:", message);
      return { success: false, error: message };
    }
  }

  /**
   * Get the parent folder path from a file path
   * @param filePath - Path to the file
   */
  getParentFolderPath(filePath: string): string {
    const normalized = normalizePath(filePath);
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash === -1) {
      return ""; // Root level
    }
    return normalized.substring(0, lastSlash);
  }

  /**
   * Create a new file with content
   * @param path - Path for the new file
   * @param content - Content to write
   */
  async createFile(path: string, content: string): Promise<WriteResult> {
    try {
      const normalizedPath = normalizePath(path);

      // Check if file already exists
      if (this.getFileByPath(normalizedPath)) {
        return { success: false, error: `File already exists: ${normalizedPath}` };
      }

      // Ensure parent folder exists
      const parentPath = this.getParentFolderPath(normalizedPath);
      if (parentPath) {
        const folderResult = await this.createFolderIfNeeded(parentPath);
        if (!folderResult.success) {
          return folderResult;
        }
      }

      // Create the file
      await this.app.vault.create(normalizedPath, content);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ObsidianFacade] createFile error:", message);
      return { success: false, error: message };
    }
  }

  // ============ Event Subscriptions ============

  /**
   * Subscribe to file creation events
   */
  onFileCreate(callback: (file: TFile) => void): EventRef {
    return this.app.vault.on("create", (file) => {
      if (file instanceof TFile && SUPPORTED_EXTENSIONS.has(file.extension)) {
        callback(file);
      }
    });
  }

  /**
   * Subscribe to file modification events
   */
  onFileModify(callback: (file: TFile) => void): EventRef {
    return this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && SUPPORTED_EXTENSIONS.has(file.extension)) {
        callback(file);
      }
    });
  }

  /**
   * Subscribe to file rename events
   */
  onFileRename(callback: (file: TFile, oldPath: string) => void): EventRef {
    return this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile && SUPPORTED_EXTENSIONS.has(file.extension)) {
        callback(file, oldPath);
      }
    });
  }

  /**
   * Subscribe to file deletion events
   */
  onFileDelete(callback: (file: TFile) => void): EventRef {
    return this.app.vault.on("delete", (file) => {
      if (file instanceof TFile && SUPPORTED_EXTENSIONS.has(file.extension)) {
        callback(file);
      }
    });
  }

  /**
   * Subscribe to active file change
   */
  onActiveFileChange(callback: (file: TFile | null) => void): EventRef {
    return this.app.workspace.on("active-leaf-change", () => {
      const file = this.app.workspace.getActiveFile();
      callback(file);
    });
  }

  /**
   * Unsubscribe from an event
   */
  offEvent(ref: EventRef): void {
    this.app.vault.offref(ref);
  }

  // ============ UI Operations ============

  /**
   * Show a notice to the user
   */
  notice(message: string, timeout?: number): void {
    new Notice(message, timeout);
  }

  /**
   * Open a file in the workspace
   * @param path - Path to the file to open
   * @returns true if file was opened, false if file not found
   */
  async openFile(path: string): Promise<boolean> {
    const file = this.getFileByPath(path);
    if (!file) {
      console.warn(`[ObsidianFacade] Cannot open file - not found: ${path}`);
      return false;
    }

    try {
      await this.app.workspace.openLinkText(path, "", true);
      return true;
    } catch (error) {
      console.error(`[ObsidianFacade] Failed to open file ${path}:`, error);
      return false;
    }
  }

  /**
   * Get the currently active file
   */
  getActiveFile(): TFile | null {
    return this.app.workspace.getActiveFile();
  }
}
