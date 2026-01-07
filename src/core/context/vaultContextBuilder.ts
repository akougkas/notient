/**
 * Vault Context Builder
 *
 * Builds dynamic vault context for LLM prompts.
 * Context is relevant to the specific query/candidates.
 */

import type { SearchResult } from "../../types/search";
import type { Kernel } from "../kernel";
import { ParaDetector } from "../para/detector";

export interface VaultContext {
  // Structural context
  relevantFolders: string[];
  activeTags: string[];
  paraDistribution: Record<string, number>;

  // Graph context
  linkedNotes: string[];

  // Temporal context
  recentlyModified: string[];

  // Stats
  totalNotes: number;
  candidateCount: number;

  // Summary for LLM
  contextSummary: string;
}

/**
 * Builds dynamic vault context for LLM prompts
 */
export class VaultContextBuilder {
  private paraDetector: ParaDetector;

  constructor(private kernel: Kernel) {
    this.paraDetector = new ParaDetector(kernel.settings);
  }

  /**
   * Build context based on query and search candidates
   */
  buildForQuery(query: string, candidates: SearchResult[]): VaultContext {
    // Extract folders from candidates
    const folders = this.extractFolders(candidates);

    // Extract tags from candidates
    const tags = this.extractTags(candidates);

    // Get linked notes (1-hop from candidates)
    const linked = this.getLinkedNotes(candidates);

    // PARA distribution of candidates
    const para = this.getParaDistribution(candidates);

    // Recent notes in relevant folders
    const recent = this.getRecentInFolders(folders);

    // Total vault stats
    const totalNotes = this.kernel.obsidian.getMarkdownFiles().length;

    // Build summary
    const summary = this.buildSummary({
      folders,
      tags,
      para,
      candidateCount: candidates.length,
      totalNotes,
      query,
    });

    return {
      relevantFolders: folders,
      activeTags: tags,
      paraDistribution: para,
      linkedNotes: linked,
      recentlyModified: recent,
      totalNotes,
      candidateCount: candidates.length,
      contextSummary: summary,
    };
  }

  /**
   * Extract unique folders from candidates
   */
  private extractFolders(candidates: SearchResult[]): string[] {
    const folders = new Set<string>();

    for (const c of candidates) {
      const parts = c.path.split("/");
      if (parts.length > 1) {
        // Add immediate parent folder
        folders.add(parts.slice(0, -1).join("/"));
        // Add root folder if nested
        if (parts.length > 2) {
          folders.add(parts[0]);
        }
      }
    }

    return Array.from(folders).slice(0, 5);
  }

  /**
   * Extract unique tags from candidates
   */
  private extractTags(candidates: SearchResult[]): string[] {
    const tagCounts = new Map<string, number>();

    for (const c of candidates) {
      if (c.chunks?.[0]) {
        // Get tags from the chunk's metadata if available
        const metadata = this.kernel.obsidian.getMetadataByPath(c.path);
        const tags = metadata?.tags || [];
        for (const tag of tags) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
      }
    }

    // Sort by frequency and return top tags
    return Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag);
  }

  /**
   * Get notes linked from candidates (1-hop)
   */
  private getLinkedNotes(candidates: SearchResult[]): string[] {
    const linked = new Set<string>();
    const candidatePaths = new Set(candidates.map((c) => c.path));

    for (const c of candidates) {
      const metadata = this.kernel.obsidian.getMetadataByPath(c.path);
      const links = metadata?.links || [];

      for (const link of links) {
        // Resolve link to path
        const resolvedPath = this.resolveLink(link, c.path);
        if (resolvedPath && !candidatePaths.has(resolvedPath)) {
          linked.add(resolvedPath);
        }
      }
    }

    return Array.from(linked).slice(0, 10);
  }

  /**
   * Resolve a wiki-link to a file path
   */
  private resolveLink(link: string, fromPath: string): string | null {
    // Remove [[]] and #section references
    const cleanLink = link
      .replace(/^\[\[|\]\]$/g, "")
      .split("#")[0]
      .split("|")[0];

    // Try exact match
    const files = this.kernel.obsidian.getMarkdownFiles();
    const exact = files.find((f) => f.path === `${cleanLink}.md` || f.basename === cleanLink);
    if (exact) return exact.path;

    // Try relative path
    const fromDir = fromPath.split("/").slice(0, -1).join("/");
    const relative = files.find((f) => f.path === `${fromDir}/${cleanLink}.md`);
    if (relative) return relative.path;

    return null;
  }

  /**
   * Get PARA distribution of candidates
   */
  private getParaDistribution(candidates: SearchResult[]): Record<string, number> {
    const dist: Record<string, number> = {
      projects: 0,
      areas: 0,
      resources: 0,
      archives: 0,
      unknown: 0,
    };

    for (const c of candidates) {
      const type = c.paraType || this.paraDetector.detectType(c.path);
      if (type && type in dist) {
        dist[type]++;
      } else {
        dist.unknown++;
      }
    }

    return dist;
  }

  /**
   * Get recently modified notes in relevant folders
   */
  private getRecentInFolders(folders: string[]): string[] {
    if (folders.length === 0) return [];

    const files = this.kernel.obsidian.getMarkdownFiles();
    const recent: Array<{ path: string; mtime: number }> = [];

    for (const file of files) {
      const inFolder = folders.some((f) => file.path.startsWith(`${f}/`));
      if (inFolder) {
        recent.push({ path: file.path, mtime: file.stat.mtime });
      }
    }

    // Sort by modification time descending
    recent.sort((a, b) => b.mtime - a.mtime);

    return recent.slice(0, 5).map((r) => r.path);
  }

  /**
   * Build human-readable summary for LLM context
   */
  private buildSummary(params: {
    folders: string[];
    tags: string[];
    para: Record<string, number>;
    candidateCount: number;
    totalNotes: number;
    query: string;
  }): string {
    const parts: string[] = [];

    parts.push(
      `Found ${params.candidateCount} potentially relevant notes out of ${params.totalNotes} total.`,
    );

    if (params.folders.length > 0) {
      parts.push(`Relevant folders: ${params.folders.join(", ")}`);
    }

    if (params.tags.length > 0) {
      parts.push(`Common tags: #${params.tags.join(", #")}`);
    }

    // PARA summary
    const paraParts: string[] = [];
    if (params.para.projects > 0) paraParts.push(`${params.para.projects} projects`);
    if (params.para.areas > 0) paraParts.push(`${params.para.areas} areas`);
    if (params.para.resources > 0) paraParts.push(`${params.para.resources} resources`);
    if (params.para.archives > 0) paraParts.push(`${params.para.archives} archives`);

    if (paraParts.length > 0) {
      parts.push(`PARA: ${paraParts.join(", ")}`);
    }

    return parts.join(" ");
  }
}
