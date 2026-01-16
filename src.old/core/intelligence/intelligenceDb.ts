/**
 * Phase 3: Intelligence DB (SQLite-backed with in-memory cache)
 *
 * Stores derived note intelligence using SQLite.
 * Maintains in-memory cache for synchronous reads.
 * Records are grouped by topic (derived from tags).
 */

import type { Kysely } from "kysely";
import type { Database } from "../db/schema";
import type { IntelligenceRecord } from "./types";

export class IntelligenceDb {
  /** In-memory cache for synchronous reads */
  private cache: Map<string, IntelligenceRecord> = new Map();
  private dirty: Set<string> = new Set();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private db: Kysely<Database>) {}

  /**
   * Load all records into memory cache
   */
  async load(): Promise<void> {
    if (this.disposed) return;

    try {
      const rows = await this.db.selectFrom("intelligence").selectAll().execute();

      for (const row of rows) {
        try {
          const record: IntelligenceRecord = JSON.parse(row.data);
          this.cache.set(row.note_path, record);
        } catch {
          console.warn(`[IntelligenceDb] Failed to parse record for ${row.note_path}`);
        }
      }

      console.log(`[IntelligenceDb] Loaded ${this.cache.size} records`);
    } catch (error) {
      console.warn("[IntelligenceDb] Failed to load:", error);
    }
  }

  /**
   * Get record for a note (synchronous from cache)
   */
  get(notePath: string): IntelligenceRecord | null {
    return this.cache.get(notePath) ?? null;
  }

  /**
   * Get all records
   */
  getAll(): IntelligenceRecord[] {
    return Array.from(this.cache.values());
  }

  /**
   * Get all records for a specific topic
   */
  getTopicRecords(topic: string): IntelligenceRecord[] {
    const results: IntelligenceRecord[] = [];
    for (const record of this.cache.values()) {
      // Check if record belongs to this topic based on its tags
      const recordTopic = this.getTopicForNote(record.path, this.getTagsFromRecord(record));
      if (recordTopic === topic) {
        results.push(record);
      }
    }
    return results;
  }

  /**
   * Get all topic names
   */
  getTopics(): string[] {
    const topics = new Set<string>();
    for (const record of this.cache.values()) {
      const topic = this.getTopicForNote(record.path, this.getTagsFromRecord(record));
      topics.add(topic);
    }
    return Array.from(topics);
  }

  /**
   * Upsert a record (updates cache and schedules SQLite write)
   */
  upsert(notePath: string, record: IntelligenceRecord, noteTags: string[]): void {
    if (this.disposed) return;

    // Update cache
    this.cache.set(notePath, record);
    this.dirty.add(notePath);
    this.scheduleSave();
  }

  /**
   * Delete a record
   */
  delete(notePath: string): void {
    if (this.disposed) return;

    this.cache.delete(notePath);
    this.dirty.add(notePath);
    this.scheduleSave();

    // Immediate delete from SQLite
    void this.db.deleteFrom("intelligence").where("note_path", "=", notePath).execute();
  }

  /**
   * Flush all dirty records to SQLite
   */
  async flush(): Promise<void> {
    if (this.dirty.size === 0 || this.disposed) return;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const toSave = Array.from(this.dirty);
    this.dirty.clear();

    for (const notePath of toSave) {
      const record = this.cache.get(notePath);
      if (record) {
        await this.saveRecord(notePath, record);
      }
    }
  }

  /**
   * Export a topic
   */
  exportTopic(topic: string): {
    topic: string;
    records: IntelligenceRecord[];
    exportedAt: number;
  } {
    return {
      topic,
      records: this.getTopicRecords(topic),
      exportedAt: Date.now(),
    };
  }

  /**
   * Export all intelligence
   */
  exportAll(): {
    topics: string[];
    records: IntelligenceRecord[];
    exportedAt: number;
  } {
    return {
      topics: this.getTopics(),
      records: this.getAll(),
      exportedAt: Date.now(),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flush();
    this.cache.clear();
  }

  // ============ Private Methods ============

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 2000);
  }

  private async saveRecord(notePath: string, record: IntelligenceRecord): Promise<void> {
    const tags = this.getTagsFromRecord(record);
    const topic = this.getTopicForNote(notePath, tags);

    await this.db
      .insertInto("intelligence")
      .values({
        note_path: notePath,
        topic,
        content_hash: record.contentHash,
        model_key: record.modelKey,
        data: JSON.stringify(record),
        updated_at: Date.now(),
      })
      .onConflict((oc) =>
        oc.column("note_path").doUpdateSet({
          topic,
          content_hash: record.contentHash,
          model_key: record.modelKey,
          data: JSON.stringify(record),
          updated_at: Date.now(),
        }),
      )
      .execute();
  }

  /**
   * Extract tags from a record's suggestedTags
   */
  private getTagsFromRecord(record: IntelligenceRecord): string[] {
    return record.suggestedTags?.map((t) => t.tag) ?? [];
  }

  /**
   * Determine which topic a note belongs to based on its tags.
   */
  private getTopicForNote(_notePath: string, noteTags: string[]): string {
    const validTags = noteTags.filter((t): t is string => typeof t === "string" && t.length > 0);
    if (validTags.length === 0) return "_uncategorized";

    const primaryTag = validTags[0]
      .replace(/^#/, "")
      .split("/")[0]
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    return primaryTag || "_uncategorized";
  }
}
