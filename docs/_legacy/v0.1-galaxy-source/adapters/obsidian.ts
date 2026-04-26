/**
 * ObsidianFacade - Wraps Obsidian APIs for workspace integration
 * Provides a clean interface for reading/writing notes, subscribing to events,
 * and accessing vault metadata.
 */

import type { App, CachedMetadata, EventRef, TAbstractFile, TFile } from "obsidian";

/**
 * Facade for Obsidian's App APIs
 * Isolates plugin code from direct Obsidian API usage
 */
export class ObsidianFacade {
  private eventRefs: EventRef[] = [];

  constructor(private app: App) {}

  /**
   * Get currently active markdown file
   * @returns Active TFile or null if no file is open
   */
  getActiveFile(): TFile | null {
    return this.app.workspace.getActiveFile();
  }

  /**
   * Read note content by path
   * @param path - Vault-relative path to the note
   * @returns Note content as string
   * @throws Error if file not found or not a file
   */
  async readNote(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    if (!this.isFile(file)) {
      throw new Error(`Not a file: ${path}`);
    }
    return this.app.vault.read(file);
  }

  /**
   * Write note content
   * @param path - Vault-relative path to the note
   * @param content - New content to write
   * @throws Error if file not found or not a file
   */
  async writeNote(path: string, content: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    if (!this.isFile(file)) {
      throw new Error(`Not a file: ${path}`);
    }
    await this.app.vault.modify(file, content);
  }

  /**
   * Get note metadata from cache
   * @param file - TFile to get metadata for
   * @returns Cached metadata or null if not cached
   */
  getNoteMetadata(file: TFile): CachedMetadata | null {
    return this.app.metadataCache.getFileCache(file);
  }

  /**
   * Get all markdown files in the vault
   * @returns Array of TFile objects
   */
  getAllNotes(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  /**
   * Subscribe to active leaf changes
   * @param callback - Called when active file changes
   * @returns Unsubscribe function
   */
  onActiveLeafChange(callback: (file: TFile | null) => void): () => void {
    const eventRef = this.app.workspace.on("active-leaf-change", (leaf) => {
      const file =
        leaf?.view?.getViewType() === "markdown" ? this.app.workspace.getActiveFile() : null;
      callback(file);
    });
    this.eventRefs.push(eventRef);

    return () => {
      this.app.workspace.offref(eventRef);
      const index = this.eventRefs.indexOf(eventRef);
      if (index > -1) {
        this.eventRefs.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to file modifications
   * @param callback - Called when a file is modified
   * @returns Unsubscribe function
   */
  onFileModify(callback: (file: TFile) => void): () => void {
    const eventRef = this.app.vault.on("modify", (file: TAbstractFile) => {
      if (this.isFile(file)) {
        callback(file);
      }
    });
    this.eventRefs.push(eventRef);

    return () => {
      this.app.vault.offref(eventRef);
      const index = this.eventRefs.indexOf(eventRef);
      if (index > -1) {
        this.eventRefs.splice(index, 1);
      }
    };
  }

  /**
   * Get resolved links (inbound and outbound) for a file
   * @param file - TFile to get links for
   * @returns Object with inbound and outbound link arrays
   */
  getLinks(file: TFile): { inbound: string[]; outbound: string[] } {
    const cache = this.app.metadataCache;
    const resolvedLinks = cache.resolvedLinks;

    // Outbound: links from this file to others
    const outboundLinks = resolvedLinks[file.path];
    const outbound = outboundLinks ? Object.keys(outboundLinks) : [];

    // Inbound: links from other files to this file
    const inbound: string[] = [];
    for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
      if (sourcePath !== file.path && targets[file.path]) {
        inbound.push(sourcePath);
      }
    }

    return { inbound, outbound };
  }

  /**
   * Cleanup all event subscriptions
   * Called during plugin unload
   */
  dispose(): void {
    for (const ref of this.eventRefs) {
      this.app.workspace.offref(ref);
    }
    this.eventRefs = [];
  }

  /**
   * Type guard to check if TAbstractFile is TFile
   */
  private isFile(file: TAbstractFile): file is TFile {
    return "extension" in file;
  }
}
