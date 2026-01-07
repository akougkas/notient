/**
 * Phase 3: Intelligence DB (file-backed JSON)
 *
 * Stores derived note intelligence (summaries, health, suggestions) per note.
 * Local-only, portable JSON, model-key scoped.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { IntelligenceFile, IntelligenceRecord } from "./types";

const INTELLIGENCE_VERSION = 1;

export class IntelligenceDb {
  private records: Map<string, IntelligenceRecord> = new Map();
  private createdAt = Date.now();
  private dirty = false;
  private disposed = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private pluginRoot: string,
    private modelKey: string,
  ) {}

  getModelKey(): string {
    return this.modelKey;
  }

  getFilePath(): string {
    return path.join(this.pluginRoot, `intelligence-${this.modelKey}.json`);
  }

  async load(): Promise<void> {
    if (this.disposed) return;

    const filePath = this.getFilePath();
    const exists = await fs.promises
      .access(filePath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      this.records.clear();
      this.createdAt = Date.now();
      return;
    }

    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as IntelligenceFile;

      if (data.modelKey !== this.modelKey) {
        // Wrong file for this modelKey; keep it but start fresh
        console.warn(
          `[IntelligenceDb] Model key mismatch: file=${data.modelKey}, current=${this.modelKey}. Starting fresh.`,
        );
        this.records.clear();
        this.createdAt = Date.now();
        return;
      }

      if (data.version !== INTELLIGENCE_VERSION) {
        console.warn(
          `[IntelligenceDb] Version mismatch: file=${data.version}, expected=${INTELLIGENCE_VERSION}. Moving aside.`,
        );
        await this.moveToDeleted(filePath, `v${data.version ?? "unknown"}`);
        this.records.clear();
        this.createdAt = Date.now();
        return;
      }

      this.createdAt = typeof data.createdAt === "number" ? data.createdAt : Date.now();
      this.records.clear();
      for (const [notePath, record] of Object.entries(data.records ?? {})) {
        this.records.set(notePath, record);
      }

      console.log(`[IntelligenceDb] Loaded ${this.records.size} records`);
    } catch (error) {
      console.warn("[IntelligenceDb] Failed to load (moving aside):", error);
      try {
        await this.moveToDeleted(filePath, "corrupt");
      } catch {
        // ignore
      }
      this.records.clear();
      this.createdAt = Date.now();
    }
  }

  get(notePath: string): IntelligenceRecord | null {
    return this.records.get(notePath) ?? null;
  }

  getAll(): IntelligenceRecord[] {
    return Array.from(this.records.values());
  }

  upsert(notePath: string, record: IntelligenceRecord): void {
    if (this.disposed) return;
    this.records.set(notePath, record);
    this.dirty = true;
    this.scheduleSave();
  }

  delete(notePath: string): void {
    if (this.disposed) return;
    if (this.records.delete(notePath)) {
      this.dirty = true;
      this.scheduleSave();
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty || this.disposed) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveToDisk();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flush();
    this.records.clear();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveToDisk();
    }, 2000);
  }

  private async saveToDisk(): Promise<void> {
    if (!this.dirty || this.disposed) return;

    const filePath = this.getFilePath();
    const data: IntelligenceFile = {
      version: INTELLIGENCE_VERSION,
      modelKey: this.modelKey,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      records: Object.fromEntries(this.records),
    };

    try {
      await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
      this.dirty = false;
    } catch (error) {
      console.error("[IntelligenceDb] Failed to save:", error);
    }
  }

  private async moveToDeleted(filePath: string, reason: string): Promise<void> {
    const deletedDir = path.join(this.pluginRoot, ".deleted");
    await fs.promises.mkdir(deletedDir, { recursive: true });

    const base = path.basename(filePath).replace(/\.json$/, "");
    const target = path.join(deletedDir, `${base}-${reason}-${Date.now()}.json`);
    await fs.promises.rename(filePath, target);
    console.log(`[IntelligenceDb] Moved ${filePath} -> ${target}`);
  }
}
