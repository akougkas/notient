/**
 * Storage paths management
 * 
 * Provides the single source of truth for all disk paths used by Notient.
 * Uses the Obsidian FileSystemAdapter to get the absolute vault path (desktop only).
 */

import { App, FileSystemAdapter } from "obsidian";
import * as path from "path";
import * as fs from "fs";
import { STORAGE_PATHS, PLUGIN_ID } from "../core/constants";

export interface StoragePathsConfig {
  /** Vault root absolute path */
  vaultRoot: string;
  /** Plugin data folder */
  pluginRoot: string;
  /** Cache folder */
  cache: string;
  /** Lock files folder */
  locks: string;
  /** Logs folder */
  logs: string;
  /** Index state file path (legacy, kept for migration) */
  indexState: string;
  // Phase 2 additions
  /** Conversations storage file path */
  conversations: string;
  /** Action history storage file path */
  actions: string;
}

/**
 * Resolves and manages all storage paths for the plugin
 */
export class StoragePaths {
  private config: StoragePathsConfig;

  constructor(app: App) {
    const adapter = app.vault.adapter;
    
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error(
        "Notient requires desktop Obsidian with file system access"
      );
    }

    const vaultRoot = adapter.getBasePath();
    const pluginRoot = path.join(
      vaultRoot,
      ".obsidian",
      "plugins",
      PLUGIN_ID
    );

    this.config = {
      vaultRoot,
      pluginRoot,
      cache: path.join(pluginRoot, STORAGE_PATHS.CACHE),
      locks: path.join(pluginRoot, STORAGE_PATHS.LOCKS),
      logs: path.join(pluginRoot, STORAGE_PATHS.LOGS),
      indexState: path.join(pluginRoot, STORAGE_PATHS.INDEX_STATE),
      // Phase 2 additions
      conversations: path.join(pluginRoot, STORAGE_PATHS.CONVERSATIONS),
      actions: path.join(pluginRoot, STORAGE_PATHS.ACTIONS),
    };
  }

  /**
   * Ensure all required directories exist
   */
  async ensureDirectories(): Promise<void> {
    const dirs = [
      this.config.cache,
      this.config.locks,
      this.config.logs,
    ];

    for (const dir of dirs) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  /**
   * Get the vault root path
   */
  get vaultRoot(): string {
    return this.config.vaultRoot;
  }

  /**
   * Get the plugin root path
   */
  get pluginRoot(): string {
    return this.config.pluginRoot;
  }

  /**
   * Get the cache directory path
   */
  get cache(): string {
    return this.config.cache;
  }

  /**
   * Get the locks directory path
   */
  get locks(): string {
    return this.config.locks;
  }

  /**
   * Get the logs directory path
   */
  get logs(): string {
    return this.config.logs;
  }

  /**
   * Get the index state file path
   */
  get indexState(): string {
    return this.config.indexState;
  }

  /**
   * Get the conversations storage file path (Phase 2)
   */
  get conversations(): string {
    return this.config.conversations;
  }

  /**
   * Get the actions history file path (Phase 2)
   */
  get actions(): string {
    return this.config.actions;
  }

  /**
   * Convert a vault-relative path to absolute path
   */
  toAbsolute(vaultPath: string): string {
    return path.join(this.config.vaultRoot, vaultPath);
  }

  /**
   * Convert an absolute path to vault-relative path
   */
  toVaultPath(absolutePath: string): string {
    return path.relative(this.config.vaultRoot, absolutePath);
  }

  /**
   * Get all paths as config object
   */
  getConfig(): Readonly<StoragePathsConfig> {
    return { ...this.config };
  }
}
