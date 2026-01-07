/**
 * Phase 3: Note Intelligence Service
 *
 * Background, local-only derived intelligence per note:
 * - Summary (short + structured)
 * - Health score (heuristic)
 *
 * This deliberately keeps the first pass small and safe: it only writes to the
 * plugin data folder and emits events for UI surfaces.
 */

import type { EventBus } from "../events/eventBus";
import { generateNoteId } from "../indexer/simpleChunker";
import type { Kernel } from "../kernel";
import type { LLMProvider } from "../llm/provider";
import { IntelligenceDb } from "./intelligenceDb";
import type {
  IntelligenceHealth,
  IntelligenceRecord,
  IntelligenceSummaryStructured,
} from "./types";

const NOTE_TEXT_MAX_CHARS = 12_000;

export class NoteIntelligenceService {
  private db: IntelligenceDb | null = null;
  private disposed = false;
  private queue: string[] = [];
  private running = false;
  private linkStats: {
    backlinks: Map<string, number>;
    outlinks: Map<string, number>;
  } | null = null;

  constructor(
    private kernel: Kernel,
    private eventBus: EventBus,
  ) {}

  async initialize(): Promise<void> {
    if (this.disposed) return;

    const ollama = this.kernel.getService<{ getModelKey(): string }>("ollama");
    if (!ollama) {
      console.warn("[NoteIntelligence] Ollama service unavailable; skipping intelligence init");
      return;
    }

    const modelKey = ollama.getModelKey();
    this.db = new IntelligenceDb(this.kernel.storagePaths.pluginRoot, modelKey);
    await this.db.load();

    // After indexing completes, refresh stale intelligence records.
    this.eventBus.on("index:complete", () => {
      void this.enqueueStaleFromIndex();
    });

    // Also kick a best-effort refresh shortly after startup (non-blocking).
    setTimeout(() => {
      void this.enqueueStaleFromIndex();
    }, 2000);
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.running = false;
    void this.db?.dispose();
    this.db = null;
    this.linkStats = null;
  }

  getRecord(path: string): IntelligenceRecord | null {
    return this.db?.get(path) ?? null;
  }

  async regenerate(path: string): Promise<void> {
    if (this.disposed) return;
    this.enqueue(path);
    await this.runQueue();
  }

  private enqueue(path: string): void {
    if (this.queue.includes(path)) return;
    this.queue.push(path);
  }

  private async enqueueStaleFromIndex(): Promise<void> {
    if (this.disposed) return;

    const indexManager = this.kernel.getService<{
      getIndexedPaths(): string[];
      getNoteState(path: string): { mtimeMs: number; contentHash: string } | null;
    }>("indexManager");
    if (!indexManager) return;

    const paths = indexManager.getIndexedPaths();
    for (const p of paths) {
      const state = indexManager.getNoteState(p);
      if (!state) continue;

      const existing = this.db?.get(p);
      if (
        !existing ||
        existing.contentHash !== state.contentHash ||
        existing.mtimeMs !== state.mtimeMs
      ) {
        this.enqueue(p);
      }
    }

    await this.runQueue();
  }

  private async runQueue(): Promise<void> {
    if (this.running || this.disposed) return;
    if (!this.db || this.queue.length === 0) return;

    this.running = true;

    try {
      // Refresh link stats once per run (used for health scoring)
      this.linkStats = this.computeLinkStats();

      while (this.queue.length > 0 && !this.disposed) {
        const next = this.queue.shift();
        if (!next) break;
        await this.processNote(next);
        await this.yieldToUI();
      }

      await this.db.flush();
    } finally {
      this.running = false;
      this.linkStats = null;
    }
  }

  private async processNote(notePath: string): Promise<void> {
    if (!this.db) return;

    const indexManager = this.kernel.getService<{
      getNoteState(path: string): { mtimeMs: number; contentHash: string } | null;
      getActiveModelKey(): string;
    }>("indexManager");
    const state = indexManager?.getNoteState(notePath);
    if (!state) return;

    const file = this.kernel.obsidian.getFileByPath(notePath);
    if (!file) return;

    const metadata = this.kernel.obsidian.getMetadataByPath(notePath);
    const title =
      (metadata?.frontmatter?.title as string | undefined) ||
      (metadata?.frontmatter?.name as string | undefined) ||
      file.basename;

    const content = await this.kernel.obsidian.readFileByPath(notePath);
    if (content === null) return;

    const health = this.computeHealth(
      notePath,
      metadata?.tags ?? [],
      metadata?.headings?.length ?? 0,
      state.mtimeMs,
    );
    const summary = await this.generateSummary(
      title,
      notePath,
      content,
      metadata?.tags ?? [],
      metadata?.headings ?? [],
    );

    const record: IntelligenceRecord = {
      noteId: generateNoteId(notePath),
      path: notePath,
      mtimeMs: state.mtimeMs,
      contentHash: state.contentHash,
      modelKey: indexManager?.getActiveModelKey?.() ?? this.db.getModelKey(),
      generatedAt: Date.now(),
      summaryShort: summary?.summaryShort ?? null,
      summaryStructured: summary?.summaryStructured ?? null,
      health,
    };

    this.db.upsert(notePath, record);

    this.eventBus.emit("intelligence:updated", { path: notePath, record });
  }

  private getLLM(): LLMProvider | null {
    return this.kernel.getService<LLMProvider>("llmProvider");
  }

  private async generateSummary(
    title: string,
    notePath: string,
    content: string,
    tags: string[],
    headings: Array<{ level: number; heading: string }>,
  ): Promise<{ summaryShort: string; summaryStructured: IntelligenceSummaryStructured } | null> {
    const llm = this.getLLM();
    if (!llm?.isReady) return null;

    const cleaned = this.prepareNoteText(content);
    const headingsText = headings
      .slice(0, 24)
      .map((h) => `${"#".repeat(Math.min(6, Math.max(1, h.level)))} ${h.heading}`)
      .join("\n");

    const system = `You write compact note intelligence for an Obsidian vault. Output ONLY valid JSON.

Schema:
{
  "summaryShort": "1-2 sentences",
  "keyPoints": ["bullet", "..."],
  "purpose": "what this note is for (string or null)"
}

Rules:
- Be concrete, avoid fluff.
- keyPoints: 3-7 items, short.
- Never include markdown fences.`;

    const user = `Title: ${title}
Path: ${notePath}
Tags: ${tags.slice(0, 16).join(", ") || "(none)"}

Headings:
${headingsText || "(none)"}

Note:
${cleaned}`;

    try {
      const response = await llm.complete(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        { temperature: 0.2, maxTokens: 500 },
      );

      const parsed = this.parseSummaryJson(response);
      return parsed;
    } catch (error) {
      console.warn("[NoteIntelligence] Summary generation failed:", error);
      return null;
    }
  }

  private prepareNoteText(content: string): string {
    // Strip YAML frontmatter (no custom YAML parsing; just remove the block)
    const lines = content.split("\n");
    let startIdx = 0;
    if ((lines[0] ?? "").trim() === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") {
          startIdx = i + 1;
          break;
        }
      }
    }

    const body = lines.slice(startIdx).join("\n");

    // Remove large code fences to keep summaries semantic
    const withoutCode = body.replace(/```[\s\S]*?```/g, "\n[code block omitted]\n");

    return withoutCode.trim().slice(0, NOTE_TEXT_MAX_CHARS);
  }

  private parseSummaryJson(
    raw: string,
  ): { summaryShort: string; summaryStructured: IntelligenceSummaryStructured } | null {
    if (!raw || raw.trim().length < 2) return null;

    let jsonStr = raw.trim();

    const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      jsonStr = fenced[1].trim();
    }

    const obj = jsonStr.match(/\{[\s\S]*\}/);
    if (!obj) return null;
    jsonStr = obj[0];

    try {
      const parsed = JSON.parse(jsonStr) as {
        summaryShort?: unknown;
        keyPoints?: unknown;
        purpose?: unknown;
      };

      const summaryShort =
        typeof parsed.summaryShort === "string" ? parsed.summaryShort.trim() : "";
      const keyPoints = Array.isArray(parsed.keyPoints)
        ? parsed.keyPoints
            .filter((p): p is string => typeof p === "string")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const purpose = typeof parsed.purpose === "string" ? parsed.purpose.trim() : null;

      if (!summaryShort) return null;

      return {
        summaryShort,
        summaryStructured: {
          keyPoints: keyPoints.slice(0, 10),
          purpose: purpose || null,
        },
      };
    } catch {
      return null;
    }
  }

  private computeLinkStats(): { backlinks: Map<string, number>; outlinks: Map<string, number> } {
    const app = this.kernel.obsidian.getApp();
    const resolved = app.metadataCache.resolvedLinks as Record<string, Record<string, number>>;

    const backlinks = new Map<string, number>();
    const outlinks = new Map<string, number>();

    for (const [sourcePath, targets] of Object.entries(resolved)) {
      outlinks.set(sourcePath, Object.keys(targets ?? {}).length);
      for (const targetPath of Object.keys(targets ?? {})) {
        backlinks.set(targetPath, (backlinks.get(targetPath) ?? 0) + 1);
      }
    }

    return { backlinks, outlinks };
  }

  private computeHealth(
    notePath: string,
    tags: string[],
    headingCount: number,
    mtimeMs: number,
  ): IntelligenceHealth {
    const now = Date.now();
    const days = Math.floor((now - mtimeMs) / (1000 * 60 * 60 * 24));

    const freshness = days <= 7 ? 100 : days <= 30 ? 75 : days <= 90 ? 55 : days <= 180 ? 35 : 20;

    const backlinks = this.linkStats?.backlinks.get(notePath) ?? 0;
    const outlinks = this.linkStats?.outlinks.get(notePath) ?? 0;
    const totalLinks = backlinks + outlinks;
    const connectivity =
      totalLinks >= 12
        ? 100
        : totalLinks >= 6
          ? 80
          : totalLinks >= 2
            ? 55
            : totalLinks === 1
              ? 40
              : 15;

    const structure = headingCount >= 6 ? 95 : headingCount >= 3 ? 80 : headingCount >= 1 ? 55 : 30;

    const metadataScore =
      tags.length >= 5 ? 90 : tags.length >= 2 ? 70 : tags.length >= 1 ? 50 : 25;

    const score = Math.round(
      freshness * 0.25 + connectivity * 0.35 + structure * 0.2 + metadataScore * 0.2,
    );

    return {
      score: Math.max(0, Math.min(100, score)),
      breakdown: {
        freshness,
        connectivity,
        structure,
        metadata: metadataScore,
      },
      computedAt: now,
    };
  }

  private yieldToUI(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 10));
  }
}
