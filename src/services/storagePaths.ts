/**
 * Storage paths management
 *
 * Provides the single source of truth for all disk paths used by Notient.
 * Uses the Obsidian FileSystemAdapter to get the absolute vault path (desktop only).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type App, FileSystemAdapter } from "obsidian";
import { PLUGIN_ID, STORAGE_PATHS } from "../core/constants";

/**
 * Generate a short vault hash (4 hex chars) for use in index filenames.
 * Deterministic: same vault path always produces same hash.
 */
function computeVaultHash(vaultPath: string): string {
  return crypto.createHash("sha256").update(vaultPath).digest("hex").slice(0, 4);
}

/**
 * Format a timestamp for index filename: YYYYMMDDTHHMMSS
 * Uses UTC to ensure consistency across timezones.
 */
export function formatIndexTimestamp(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}T${h}${min}${s}`;
}

/**
 * Parse index timestamp from filename back to Date.
 * Returns null if format doesn't match.
 */
export function parseIndexTimestamp(ts: string): Date | null {
  const match = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, y, m, d, h, min, s] = match;
  return new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +s));
}

/** Type derived from STORAGE_PATHS keys (camelCase versions) */
type StoragePathKey = keyof typeof STORAGE_PATHS;

/** Converts SCREAMING_SNAKE to camelCase */
function toCamelCase(key: string): string {
  return key.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Core paths not derived from STORAGE_PATHS */
interface CorePaths {
  vaultRoot: string;
  vaultHash: string;
  pluginRoot: string;
  systemIndex: string;
}

/** Full config: core paths + all STORAGE_PATHS as absolute paths */
export type StoragePathsConfig = CorePaths & {
  [K in StoragePathKey as ReturnType<typeof toCamelCase>]: string;
};

/**
 * Resolves and manages all storage paths for the plugin
 */
export class StoragePaths {
  readonly vaultRoot: string;
  readonly vaultHash: string;
  readonly pluginRoot: string;
  readonly systemIndex: string;

  // New structure paths
  readonly data: string;
  readonly dbFile: string;
  readonly embeddings: string;
  readonly intelligence: string;
  readonly intelligenceMeta: string;
  readonly intelligenceTopics: string;
  readonly conversations: string;
  readonly conversationsNotes: string;
  readonly conversationsRollups: string;
  readonly conversationsRoot: string;
  readonly actions: string;
  readonly actionsHot: string;
  readonly actionsCurrent: string;
  readonly actionsArchive: string;
  readonly profile: string;
  readonly profileFile: string;
  readonly operational: string;
  readonly locks: string;
  readonly cache: string;
  readonly temp: string;
  readonly tempIncomplete: string;
  readonly tempInvalid: string;
  readonly tempDeleted: string;
  readonly logs: string;

  constructor(app: App) {
    const adapter = app.vault.adapter;

    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Notient requires desktop Obsidian with file system access");
    }

    this.vaultRoot = adapter.getBasePath();
    this.vaultHash = computeVaultHash(this.vaultRoot);
    this.pluginRoot = path.join(this.vaultRoot, ".obsidian", "plugins", PLUGIN_ID);
    this.systemIndex = path.join(this.vaultRoot, "system", "index");

    // Build all paths from STORAGE_PATHS constant
    const p = (key: keyof typeof STORAGE_PATHS): string =>
      path.join(this.pluginRoot, STORAGE_PATHS[key]);

    // New structure
    this.data = p("DATA");
    this.dbFile = p("DB_FILE");
    this.embeddings = p("EMBEDDINGS");
    this.intelligence = p("INTELLIGENCE");
    this.intelligenceMeta = p("INTELLIGENCE_META");
    this.intelligenceTopics = p("INTELLIGENCE_TOPICS");
    this.conversations = p("CONVERSATIONS");
    this.conversationsNotes = p("CONVERSATIONS_NOTES");
    this.conversationsRollups = p("CONVERSATIONS_ROLLUPS");
    this.conversationsRoot = p("CONVERSATIONS_ROOT");
    this.actions = p("ACTIONS");
    this.actionsHot = p("ACTIONS_HOT");
    this.actionsCurrent = p("ACTIONS_CURRENT");
    this.actionsArchive = p("ACTIONS_ARCHIVE");
    this.profile = p("PROFILE");
    this.profileFile = p("PROFILE_FILE");
    this.operational = p("OPERATIONAL");
    this.locks = p("LOCKS");
    this.cache = p("CACHE");
    this.temp = p("TEMP");
    this.tempIncomplete = p("TEMP_INCOMPLETE");
    this.tempInvalid = p("TEMP_INVALID");
    this.tempDeleted = p("TEMP_DELETED");
    this.logs = p("LOGS");
  }

  /**
   * Ensure all required directories exist
   */
  async ensureDirectories(): Promise<void> {
    const dirs = [
      this.data,
      this.embeddings,
      this.intelligence,
      this.intelligenceTopics,
      this.conversations,
      this.conversationsNotes,
      this.conversationsRollups,
      this.actions,
      this.actionsHot,
      this.actionsArchive,
      this.profile,
      this.operational,
      this.locks,
      this.cache,
      this.temp,
      this.tempIncomplete,
      this.tempInvalid,
      this.tempDeleted,
      this.logs,
    ];

    for (const dir of dirs) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Dynamic Path Builders
  // ─────────────────────────────────────────────────────────────────────────────

  /** Get path for an intelligence topic file */
  getIntelligenceTopicPath(tag: string): string {
    const sanitized = tag.replace(/^#/, "").replace(/[/\\:*?"<>|]/g, "-");
    return path.join(this.intelligenceTopics, `${sanitized}.json`);
  }

  /** Get path for a specific note's conversation file */
  getConversationPath(noteId: string): string {
    return path.join(this.conversationsNotes, `${noteId}.json`);
  }

  /** Get path for a conversation rollup (PARA folder) */
  getConversationRollupPath(paraFolder: string): string {
    const sanitized = paraFolder.replace(/[/\\]/g, "-").replace(/^-|-$/g, "");
    return path.join(this.conversationsRollups, `${sanitized}.json`);
  }

  /** Get path for monthly action archive */
  getActionArchivePath(yearMonth: string): string {
    return path.join(this.actionsArchive, `${yearMonth}.json`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utility Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /** Convert a vault-relative path to absolute path */
  toAbsolute(vaultPath: string): string {
    return path.join(this.vaultRoot, vaultPath);
  }

  /** Convert an absolute path to vault-relative path */
  toVaultPath(absolutePath: string): string {
    return path.relative(this.vaultRoot, absolutePath);
  }

  /** Get all paths as config object */
  getConfig(): StoragePathsConfig {
    return {
      vaultRoot: this.vaultRoot,
      vaultHash: this.vaultHash,
      pluginRoot: this.pluginRoot,
      systemIndex: this.systemIndex,
      data: this.data,
      dbFile: this.dbFile,
      embeddings: this.embeddings,
      intelligence: this.intelligence,
      intelligenceMeta: this.intelligenceMeta,
      intelligenceTopics: this.intelligenceTopics,
      conversations: this.conversations,
      conversationsNotes: this.conversationsNotes,
      conversationsRollups: this.conversationsRollups,
      conversationsRoot: this.conversationsRoot,
      actions: this.actions,
      actionsHot: this.actionsHot,
      actionsCurrent: this.actionsCurrent,
      actionsArchive: this.actionsArchive,
      profile: this.profile,
      profileFile: this.profileFile,
      operational: this.operational,
      locks: this.locks,
      cache: this.cache,
      temp: this.temp,
      tempIncomplete: this.tempIncomplete,
      tempInvalid: this.tempInvalid,
      tempDeleted: this.tempDeleted,
      logs: this.logs,
    };
  }
}
