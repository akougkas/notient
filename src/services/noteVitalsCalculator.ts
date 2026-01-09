/**
 * NoteVitalsCalculator - Business logic for calculating note health and vitals
 *
 * Extracted from sidebar.ts to separate business logic from view rendering.
 */

import type { App, CachedMetadata, TFile } from "obsidian";
import type { ParaDetector } from "../core/para/detector";

export interface NoteVitals {
  health: {
    score: number;
    status: "healthy" | "attention" | "unhealthy";
  };
  links: {
    backlinks: number;
    outlinks: number;
  };
  freshness: {
    lastModified: Date;
    displayText: string;
  };
  /** Note lifecycle timestamps for Pulse Timeline */
  lifecycle: {
    createdAt: Date;
    modifiedAt: Date;
    /** Age in days since creation */
    ageDays: number;
  };
  title: string;
  path: string;
  paraType: string;
  tags: string[];
  isIndexed: boolean;
}

export interface IndexManagerLike {
  isNoteIndexed(path: string): boolean;
}

export class NoteVitalsCalculator {
  constructor(
    private app: App,
    private paraDetector: ParaDetector,
  ) {}

  /**
   * Calculate complete vitals for a given file
   */
  async calculate(file: TFile, indexManager: IndexManagerLike | null): Promise<NoteVitals> {
    const metadata = this.app.metadataCache.getFileCache(file);
    const healthScore = this.calculateHealthScore(file, metadata);

    // Get backlinks
    const backlinks = this.getBacklinks(file);

    // Get outlinks
    const outlinks = this.getOutlinks(file);

    // Extract tags
    const tags = metadata?.tags?.map((t) => t.tag) || [];
    const frontmatterTags = (metadata?.frontmatter?.tags as string[]) || [];
    const allTags = [...new Set([...tags, ...frontmatterTags])];

    // Freshness
    const mtime = file.stat.mtime;
    const ctime = file.stat.ctime;
    const freshness = this.formatFreshness(mtime);

    // Lifecycle data for Pulse Timeline
    const createdAt = new Date(ctime);
    const modifiedAt = new Date(mtime);
    const ageDays = Math.floor((Date.now() - ctime) / (1000 * 60 * 60 * 24));

    // Check if indexed
    const isIndexed = indexManager?.isNoteIndexed(file.path) ?? false;

    return {
      health: {
        score: healthScore,
        status: healthScore >= 70 ? "healthy" : healthScore >= 40 ? "attention" : "unhealthy",
      },
      links: {
        backlinks: backlinks.length,
        outlinks: outlinks.length,
      },
      freshness: {
        lastModified: modifiedAt,
        displayText: freshness,
      },
      lifecycle: {
        createdAt,
        modifiedAt,
        ageDays,
      },
      title: file.basename,
      path: file.path,
      paraType: this.paraDetector.detectType(file.path),
      tags: allTags,
      isIndexed,
    };
  }

  /**
   * Calculate health score based on various factors
   */
  calculateHealthScore(file: TFile, metadata: CachedMetadata | null): number {
    let score = 50; // Base score

    // Freshness factor (up to +20)
    const daysSinceModified = Math.floor((Date.now() - file.stat.mtime) / (1000 * 60 * 60 * 24));
    if (daysSinceModified <= 7) score += 20;
    else if (daysSinceModified <= 30) score += 10;
    else if (daysSinceModified > 90) score -= 10;

    // Tags factor (up to +10)
    const tagCount =
      (metadata?.tags?.length || 0) + ((metadata?.frontmatter?.tags as string[])?.length || 0);
    if (tagCount >= 3) score += 10;
    else if (tagCount >= 1) score += 5;

    // Links factor (up to +20)
    const backlinks = this.getBacklinks(file);
    const outlinks = this.getOutlinks(file);

    if (backlinks.length >= 5) score += 10;
    else if (backlinks.length >= 1) score += 5;

    if (outlinks.length >= 5) score += 10;
    else if (outlinks.length >= 1) score += 5;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get all backlinks for a file
   */
  private getBacklinks(file: TFile): string[] {
    const backlinks: string[] = [];
    const resolvedLinks = this.app.metadataCache.resolvedLinks;

    for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
      if (links[file.path]) {
        backlinks.push(sourcePath);
      }
    }

    return backlinks;
  }

  /**
   * Get all outlinks for a file
   */
  private getOutlinks(file: TFile): string[] {
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const fileLinks = resolvedLinks[file.path] || {};
    return Object.keys(fileLinks);
  }

  /**
   * Get first backlink title as preview
   */
  getBacklinkPreview(file: TFile): string {
    const resolvedLinks = this.app.metadataCache.resolvedLinks;

    for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
      if (links[file.path]) {
        const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
        if (sourceFile && "basename" in sourceFile) {
          return `${(sourceFile as TFile).basename}...`;
        }
      }
    }

    return "";
  }

  /**
   * Format modification time as human-readable freshness
   */
  formatFreshness(mtime: number): string {
    const now = Date.now();
    const diff = now - mtime;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
      const hours = Math.floor(diff / (1000 * 60 * 60));
      if (hours === 0) {
        return "Just now";
      }
      return `${hours}h ago`;
    }
    if (days === 1) {
      return "Yesterday";
    }
    if (days < 7) {
      return `${days} days ago`;
    }
    if (days < 30) {
      const weeks = Math.floor(days / 7);
      return `${weeks} week${weeks > 1 ? "s" : ""} ago`;
    }
    const date = new Date(mtime);
    return date.toLocaleDateString();
  }
}
