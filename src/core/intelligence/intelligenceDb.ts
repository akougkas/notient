/**
 * Phase 3: Intelligence DB (tag-based sharding)
 *
 * Stores derived note intelligence per topic file based on note tags.
 * Replaces the old model-keyed single file approach.
 *
 * Structure:
 *   data/intelligence/
 *   ├── meta.json              # Topic index
 *   └── topics/
 *       ├── research.json      # Notes tagged #research
 *       ├── project.json       # Notes tagged #project/*
 *       └── _uncategorized.json # Notes without tags
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { StoragePaths } from "../../services/storagePaths";
import { atomicWriteFile } from "../../utils/atomicWrite";
import type {
  IntelligenceFile,
  IntelligenceMeta,
  IntelligenceRecord,
  IntelligenceTopicFile,
} from "./types";

const INTELLIGENCE_VERSION = 2;

export class IntelligenceDb {
  // Map: topic -> (Map: notePath -> record)
  private topics: Map<string, Map<string, IntelligenceRecord>> = new Map();
  private dirtyTopics: Set<string> = new Set();
  private disposed = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private storagePaths: StoragePaths) {}

  /**
   * Load all topic files (and migrate legacy if needed)
   */
  async load(): Promise<void> {
    if (this.disposed) return;

    // Check for and migrate legacy file first
    await this.checkAndMigrateLegacy();

    // Load topic files
    const topicsDir = this.storagePaths.intelligenceTopics;

    try {
      const files = await fs.promises.readdir(topicsDir);

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const topic = file.replace(".json", "");
        const filePath = path.join(topicsDir, file);

        try {
          const content = await fs.promises.readFile(filePath, "utf-8");
          const data: IntelligenceTopicFile = JSON.parse(content);

          const records = new Map<string, IntelligenceRecord>();
          for (const [notePath, record] of Object.entries(data.records ?? {})) {
            records.set(notePath, record);
          }

          this.topics.set(topic, records);
        } catch (error) {
          console.warn(`[IntelligenceDb] Failed to load topic ${topic}:`, error);
        }
      }

      console.log(`[IntelligenceDb] Loaded ${this.topics.size} topics`);
    } catch {
      // Directory might not exist yet
      console.log("[IntelligenceDb] No existing intelligence data");
    }
  }

  /**
   * Get record for a note (searches all topics)
   */
  get(notePath: string): IntelligenceRecord | null {
    for (const records of this.topics.values()) {
      const record = records.get(notePath);
      if (record) return record;
    }
    return null;
  }

  /**
   * Get all records across all topics
   */
  getAll(): IntelligenceRecord[] {
    const all: IntelligenceRecord[] = [];
    for (const records of this.topics.values()) {
      all.push(...records.values());
    }
    return all;
  }

  /**
   * Get all records for a specific topic
   */
  getTopicRecords(topic: string): IntelligenceRecord[] {
    const records = this.topics.get(topic);
    return records ? Array.from(records.values()) : [];
  }

  /**
   * Get all topic names
   */
  getTopics(): string[] {
    return Array.from(this.topics.keys());
  }

  /**
   * Upsert a record (determines topic from tags)
   */
  upsert(notePath: string, record: IntelligenceRecord, noteTags: string[]): void {
    if (this.disposed) return;

    const newTopic = this.getTopicForNote(notePath, noteTags);

    // Remove from old topic if exists elsewhere
    for (const [topic, records] of this.topics) {
      if (topic !== newTopic && records.has(notePath)) {
        records.delete(notePath);
        this.dirtyTopics.add(topic);
      }
    }

    // Add to new topic
    if (!this.topics.has(newTopic)) {
      this.topics.set(newTopic, new Map());
    }
    this.topics.get(newTopic)?.set(notePath, record);
    this.dirtyTopics.add(newTopic);

    this.scheduleSave();
  }

  /**
   * Delete a record from all topics
   */
  delete(notePath: string): void {
    if (this.disposed) return;

    for (const [topic, records] of this.topics) {
      if (records.delete(notePath)) {
        this.dirtyTopics.add(topic);
      }
    }

    this.scheduleSave();
  }

  /**
   * Flush all dirty topics to disk
   */
  async flush(): Promise<void> {
    if (this.dirtyTopics.size === 0 || this.disposed) return;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const topicsToSave = Array.from(this.dirtyTopics);
    this.dirtyTopics.clear();

    for (const topic of topicsToSave) {
      await this.saveTopicFile(topic);
    }

    await this.saveMetaFile();
  }

  /**
   * Export a topic to a backup file
   */
  async exportTopic(topic: string, outputPath: string): Promise<void> {
    const records = this.topics.get(topic);
    if (!records) {
      throw new Error(`Topic not found: ${topic}`);
    }

    const data: IntelligenceTopicFile = {
      version: INTELLIGENCE_VERSION,
      topic,
      criteria: { tags: [topic] },
      records: Object.fromEntries(records),
      noteCount: records.size,
      lastUpdated: Date.now(),
    };

    await atomicWriteFile(outputPath, JSON.stringify(data, null, 2));
  }

  /**
   * Export all intelligence to a single backup file
   */
  async exportAll(outputPath: string): Promise<void> {
    const allRecords: Record<string, IntelligenceRecord> = {};

    for (const records of this.topics.values()) {
      for (const [notePath, record] of records) {
        allRecords[notePath] = record;
      }
    }

    const backup = {
      version: INTELLIGENCE_VERSION,
      exportedAt: Date.now(),
      topics: Array.from(this.topics.keys()),
      records: allRecords,
    };

    await atomicWriteFile(outputPath, JSON.stringify(backup, null, 2));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flush();
    this.topics.clear();
  }

  // ============ Private Methods ============

  /**
   * Determine which topic a note belongs to based on its tags.
   * Uses the first tag's root segment as the topic name.
   */
  private getTopicForNote(_notePath: string, noteTags: string[]): string {
    if (noteTags.length === 0) return "_uncategorized";

    const primaryTag = noteTags[0]
      .replace(/^#/, "")
      .split("/")[0]
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    return primaryTag || "_uncategorized";
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 2000);
  }

  private async saveTopicFile(topic: string): Promise<void> {
    const records = this.topics.get(topic);
    if (!records) return;

    // Remove empty topics
    if (records.size === 0) {
      const filePath = this.storagePaths.getIntelligenceTopicPath(topic);
      try {
        await fs.promises.unlink(filePath);
      } catch {
        // File might not exist
      }
      this.topics.delete(topic);
      return;
    }

    // Ensure directory exists
    await fs.promises.mkdir(this.storagePaths.intelligenceTopics, { recursive: true });

    const filePath = this.storagePaths.getIntelligenceTopicPath(topic);
    const data: IntelligenceTopicFile = {
      version: INTELLIGENCE_VERSION,
      topic,
      criteria: { tags: [topic] },
      records: Object.fromEntries(records),
      noteCount: records.size,
      lastUpdated: Date.now(),
    };

    await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
  }

  private async saveMetaFile(): Promise<void> {
    await fs.promises.mkdir(this.storagePaths.intelligence, { recursive: true });

    const totalRecords = Array.from(this.topics.values()).reduce(
      (sum, records) => sum + records.size,
      0,
    );

    const meta: IntelligenceMeta = {
      version: INTELLIGENCE_VERSION,
      topics: Array.from(this.topics.keys()),
      totalNotes: totalRecords,
      totalRecords,
      lastUpdated: Date.now(),
    };

    await atomicWriteFile(this.storagePaths.intelligenceMeta, JSON.stringify(meta, null, 2));
  }

  // ============ Legacy Migration ============

  /**
   * Check for and migrate legacy intelligence-*.json file
   */
  private async checkAndMigrateLegacy(): Promise<void> {
    // Only migrate if new structure doesn't exist
    if (this.hasNewStructure()) return;

    try {
      const pluginRoot = this.storagePaths.pluginRoot;
      const files = await fs.promises.readdir(pluginRoot);

      // Find legacy intelligence file (intelligence-{modelKey}.json)
      const legacyFile = files.find((f) => /^intelligence-.*\.json$/.test(f));

      if (legacyFile) {
        const legacyPath = path.join(pluginRoot, legacyFile);
        console.log(`[IntelligenceDb] Migrating legacy file: ${legacyFile}`);
        await this.migrateLegacyFile(legacyPath);
      }
    } catch {
      // Ignore errors reading directory
    }
  }

  private hasNewStructure(): boolean {
    return fs.existsSync(this.storagePaths.intelligenceTopics);
  }

  private async migrateLegacyFile(legacyPath: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(legacyPath, "utf-8");
      const legacy = JSON.parse(content) as IntelligenceFile;

      // Ensure directories exist
      await fs.promises.mkdir(this.storagePaths.intelligenceTopics, { recursive: true });
      await fs.promises.mkdir(this.storagePaths.tempDeleted, { recursive: true });

      // Group records by topic based on suggestedTags
      for (const [notePath, record] of Object.entries(legacy.records ?? {})) {
        // Extract tags from suggestedTags if available
        const tags = record.suggestedTags?.map((t) => t.tag) ?? [];
        const topic = this.getTopicForNote(notePath, tags);

        if (!this.topics.has(topic)) {
          this.topics.set(topic, new Map());
        }
        this.topics.get(topic)?.set(notePath, record);
        this.dirtyTopics.add(topic);
      }

      // Save all migrated topics
      await this.flush();

      // Move legacy file to _deleted for safety
      const timestamp = Date.now();
      const deletedPath = path.join(
        this.storagePaths.tempDeleted,
        `intelligence-legacy-${timestamp}.json`,
      );
      await fs.promises.rename(legacyPath, deletedPath);

      console.log(
        `[IntelligenceDb] Migration complete: ${this.topics.size} topics, legacy moved to ${deletedPath}`,
      );
    } catch (error) {
      console.error("[IntelligenceDb] Migration failed:", error);
    }
  }
}
