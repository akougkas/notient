/**
 * Importer Service
 *
 * Plugin-side integration for the import bridge.
 * Uses Obsidian's Vault API for file operations.
 */

import type { TFile, Vault } from "obsidian";
import type { Kernel } from "../kernel";

/** Options for the plugin importer */
export interface PluginImportOptions {
  /** Source folder path (absolute or relative to vault) */
  sourcePath: string;
  /** Target subfolder name (default: "imports") */
  outputFolder: string;
  /** Whether to process subdirectories */
  recursive: boolean;
}

/** Result of importing a single file */
export interface PluginImportResult {
  sourcePath: string;
  targetPath: string;
  success: boolean;
  error?: string;
  linksConverted: number;
  isUpdate: boolean;
}

/** Summary of import operation */
export interface PluginImportSummary {
  totalFiles: number;
  successful: number;
  failed: number;
  totalLinksConverted: number;
  created: number;
  updated: number;
  results: PluginImportResult[];
}

/**
 * Link normalization patterns
 */
const PATTERNS = {
  // Standard markdown links: [text](url)
  markdown: /\[([^\]]+)\]\(([^)]+)\)/g,
  // External URL detection
  external: /^(https?|ftp|mailto):/i,
};

/**
 * Check if a URL is external
 */
function isExternalLink(url: string): boolean {
  return PATTERNS.external.test(url.trim());
}

/**
 * Extract note name from a path
 */
function extractNoteName(path: string): string {
  const cleaned = path.replace(/^\.\.?\//, "");
  const parts = cleaned.split("/");
  let filename = parts[parts.length - 1];
  filename = filename.replace(/\.md$/i, "");
  filename = filename.split("#")[0].split("?")[0];
  return filename;
}

/**
 * Convert to wikilink format
 */
function toWikilink(noteName: string, displayText: string): string {
  if (displayText.toLowerCase() === noteName.toLowerCase()) {
    return `[[${noteName}]]`;
  }
  return `[[${noteName}|${displayText}]]`;
}

/**
 * Extract frontmatter from content
 */
function extractFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (match) {
    return { frontmatter: match[0], body: content.slice(match[0].length) };
  }
  return { frontmatter: null, body: content };
}

/**
 * Normalize markdown content by converting links to wikilinks
 */
function normalizeContent(content: string): { normalized: string; conversions: number } {
  const { frontmatter, body } = extractFrontmatter(content);

  let conversions = 0;
  const normalizedBody = body.replace(PATTERNS.markdown, (match, text, target) => {
    // Skip external links
    if (isExternalLink(target)) {
      return match;
    }
    conversions++;
    const noteName = extractNoteName(target);
    return toWikilink(noteName, text);
  });

  return {
    normalized: frontmatter ? frontmatter + normalizedBody : normalizedBody,
    conversions,
  };
}

/**
 * ImporterService - handles importing markdown files via Obsidian's Vault API
 */
export class ImporterService {
  constructor(private kernel: Kernel) {}

  /**
   * Import files from an external source into the vault
   *
   * Note: This method works with files that are already accessible via the vault.
   * For importing from external directories, use the CLI tool.
   */
  async importFromVaultFolder(
    sourceFolderPath: string,
    options: Partial<PluginImportOptions> = {},
  ): Promise<PluginImportSummary> {
    const vault = this.kernel.obsidian.vault;
    const outputFolder = options.outputFolder || "imports";
    const recursive = options.recursive ?? true;

    const results: PluginImportResult[] = [];

    // Get source folder
    const sourceFolder = vault.getAbstractFileByPath(sourceFolderPath);
    if (!sourceFolder) {
      return {
        totalFiles: 0,
        successful: 0,
        failed: 0,
        totalLinksConverted: 0,
        created: 0,
        updated: 0,
        results: [],
      };
    }

    // Find all markdown files in source
    const markdownFiles = await this.findMarkdownFiles(vault, sourceFolderPath, recursive);

    // Ensure output folder exists
    const outputPath = outputFolder;
    const existingOutput = vault.getAbstractFileByPath(outputPath);
    if (!existingOutput) {
      await vault.createFolder(outputPath);
    }

    // Process each file
    for (const file of markdownFiles) {
      const result = await this.processFile(vault, file, sourceFolderPath, outputPath);
      results.push(result);
    }

    return {
      totalFiles: markdownFiles.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      totalLinksConverted: results.reduce((sum, r) => sum + r.linksConverted, 0),
      created: results.filter((r) => r.success && !r.isUpdate).length,
      updated: results.filter((r) => r.success && r.isUpdate).length,
      results,
    };
  }

  /**
   * Import content directly (for programmatic use)
   */
  async importContent(
    content: string,
    targetPath: string,
  ): Promise<{ success: boolean; linksConverted: number; error?: string }> {
    try {
      const vault = this.kernel.obsidian.vault;
      const { normalized, conversions } = normalizeContent(content);

      // Check if file exists
      const existing = vault.getAbstractFileByPath(targetPath);

      if (existing) {
        await vault.modify(existing as TFile, normalized);
      } else {
        // Ensure parent folder exists
        const parentPath = targetPath.split("/").slice(0, -1).join("/");
        if (parentPath) {
          const parentExists = vault.getAbstractFileByPath(parentPath);
          if (!parentExists) {
            await vault.createFolder(parentPath);
          }
        }
        await vault.create(targetPath, normalized);
      }

      return { success: true, linksConverted: conversions };
    } catch (err) {
      return {
        success: false,
        linksConverted: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Normalize a file in place (convert its links to wikilinks)
   */
  async normalizeFile(file: TFile): Promise<{ success: boolean; linksConverted: number }> {
    try {
      const vault = this.kernel.obsidian.vault;
      const content = await vault.read(file);
      const { normalized, conversions } = normalizeContent(content);

      if (conversions > 0) {
        await vault.modify(file, normalized);
      }

      return { success: true, linksConverted: conversions };
    } catch (err) {
      console.error("[ImporterService] Failed to normalize file:", err);
      return { success: false, linksConverted: 0 };
    }
  }

  /**
   * Find markdown files in a folder
   */
  private async findMarkdownFiles(
    vault: Vault,
    folderPath: string,
    recursive: boolean,
  ): Promise<TFile[]> {
    const files: TFile[] = [];
    const allFiles = vault.getMarkdownFiles();

    for (const file of allFiles) {
      if (file.path.startsWith(`${folderPath}/`)) {
        if (recursive || !file.path.slice(folderPath.length + 1).includes("/")) {
          files.push(file);
        }
      }
    }

    return files;
  }

  /**
   * Process a single file for import
   */
  private async processFile(
    vault: Vault,
    file: TFile,
    sourceRoot: string,
    targetRoot: string,
  ): Promise<PluginImportResult> {
    try {
      // Calculate relative path
      const relativePath = file.path.slice(sourceRoot.length + 1);
      const targetPath = `${targetRoot}/${relativePath}`;

      // Read and normalize content
      const content = await vault.read(file);
      const { normalized, conversions } = normalizeContent(content);

      // Check if target exists
      const existing = vault.getAbstractFileByPath(targetPath);
      const isUpdate = !!existing;

      // Write file
      if (existing) {
        await vault.modify(existing as TFile, normalized);
      } else {
        // Ensure parent folder exists
        const parentPath = targetPath.split("/").slice(0, -1).join("/");
        if (parentPath) {
          const parentExists = vault.getAbstractFileByPath(parentPath);
          if (!parentExists) {
            await vault.createFolder(parentPath);
          }
        }
        await vault.create(targetPath, normalized);
      }

      return {
        sourcePath: file.path,
        targetPath,
        success: true,
        linksConverted: conversions,
        isUpdate,
      };
    } catch (err) {
      return {
        sourcePath: file.path,
        targetPath: "",
        success: false,
        error: err instanceof Error ? err.message : String(err),
        linksConverted: 0,
        isUpdate: false,
      };
    }
  }
}
