/**
 * Import Bridge Types
 *
 * Shared type definitions for the markdown import bridge.
 */

/** Options for the import bridge CLI/API */
export interface ImportOptions {
  /** Source directory containing markdown files */
  source: string;
  /** Target Obsidian vault path */
  vault: string;
  /** Subfolder name for imports (default: "imports") */
  output: string;
  /** Preview changes without writing */
  dryRun: boolean;
  /** Process subdirectories */
  recursive: boolean;
}

/** Result of processing a single file */
export interface ImportResult {
  /** Original source file path */
  sourcePath: string;
  /** Target path in vault */
  targetPath: string;
  /** Whether the file was successfully processed */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Number of links converted */
  linksConverted: number;
  /** Whether file already existed (update vs create) */
  isUpdate: boolean;
}

/** Summary of an import batch */
export interface ImportSummary {
  /** Total files processed */
  totalFiles: number;
  /** Successfully imported */
  successful: number;
  /** Failed imports */
  failed: number;
  /** Total links converted */
  totalLinksConverted: number;
  /** New files created */
  created: number;
  /** Existing files updated */
  updated: number;
  /** Individual file results */
  results: ImportResult[];
}

/** Represents a detected link in markdown content */
export interface DetectedLink {
  /** Full match text */
  fullMatch: string;
  /** Link text (display text) */
  text: string;
  /** Link target (URL or path) */
  target: string;
  /** Start position in content */
  start: number;
  /** End position in content */
  end: number;
  /** Type of link */
  type: "markdown" | "wikilink" | "external";
}

/** Normalization result for a single file's content */
export interface NormalizationResult {
  /** Original content */
  original: string;
  /** Normalized content */
  normalized: string;
  /** Links that were converted */
  conversions: Array<{
    from: string;
    to: string;
  }>;
  /** Links that were preserved (external/already wikilinks) */
  preserved: string[];
}
