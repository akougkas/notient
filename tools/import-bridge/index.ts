#!/usr/bin/env bun
/**
 * Import Bridge CLI
 *
 * Imports markdown files from external sources into an Obsidian vault,
 * normalizing links to wikilink format.
 *
 * Usage:
 *   bun tools/import-bridge/index.ts --source ~/exports --vault ~/vaults/my-vault
 *
 * Options:
 *   --source, -s   Source directory containing markdown files (required)
 *   --vault, -v    Target Obsidian vault path (required)
 *   --output, -o   Subfolder name for imports (default: "imports")
 *   --dry-run      Preview changes without writing files
 *   --no-recursive Don't process subdirectories
 *   --help, -h     Show this help message
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { normalizeMarkdownFile } from "./normalizer";
import type { ImportOptions, ImportResult, ImportSummary } from "./types";

// ANSI colors for terminal output
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message: string): void {
  console.log(message);
}

function success(message: string): void {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function warn(message: string): void {
  console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
}

function error(message: string): void {
  console.error(`${colors.red}✗${colors.reset} ${message}`);
}

function printHelp(): void {
  log(`
${colors.bold}Import Bridge${colors.reset} - Convert markdown to Obsidian format

${colors.cyan}USAGE${colors.reset}
  bun tools/import-bridge/index.ts [options]

${colors.cyan}OPTIONS${colors.reset}
  --source, -s <path>   Source directory with markdown files (required)
  --vault, -v <path>    Target Obsidian vault path (required)
  --output, -o <name>   Subfolder for imports (default: "imports")
  --dry-run             Preview changes without writing
  --no-recursive        Don't process subdirectories
  --help, -h            Show this help

${colors.cyan}EXAMPLES${colors.reset}
  # Import from Downloads
  bun tools/import-bridge/index.ts -s ~/Downloads/export -v ~/vaults/notes

  # Dry run to preview
  bun tools/import-bridge/index.ts -s ./markdown -v ./vault --dry-run

  # Custom output folder
  bun tools/import-bridge/index.ts -s ./source -v ./vault -o "imported-notes"
`);
}

function parseArgs(args: string[]): ImportOptions | null {
  const options: ImportOptions = {
    source: "",
    vault: "",
    output: "imports",
    dryRun: false,
    recursive: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--source":
      case "-s":
        options.source = next || "";
        i++;
        break;
      case "--vault":
      case "-v":
        options.vault = next || "";
        i++;
        break;
      case "--output":
      case "-o":
        options.output = next || "imports";
        i++;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-recursive":
        options.recursive = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        return null;
    }
  }

  // Validate required options
  if (!options.source) {
    error("Missing required option: --source");
    printHelp();
    return null;
  }
  if (!options.vault) {
    error("Missing required option: --vault");
    printHelp();
    return null;
  }

  return options;
}

/**
 * Recursively find all markdown files in a directory
 */
function findMarkdownFiles(dir: string, recursive: boolean): string[] {
  const files: string[] = [];

  if (!existsSync(dir)) {
    return files;
  }

  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory() && recursive) {
      files.push(...findMarkdownFiles(fullPath, recursive));
    } else if (stat.isFile() && entry.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Process a single markdown file
 */
function processFile(
  sourcePath: string,
  sourceRoot: string,
  targetRoot: string,
  dryRun: boolean
): ImportResult {
  const relativePath = relative(sourceRoot, sourcePath);
  const targetPath = join(targetRoot, relativePath);

  try {
    // Read source file
    const content = readFileSync(sourcePath, "utf-8");

    // Normalize links
    const result = normalizeMarkdownFile(content);

    // Check if target exists
    const isUpdate = existsSync(targetPath);

    // Write file (unless dry run)
    if (!dryRun) {
      // Ensure target directory exists
      const targetDir = join(targetPath, "..");
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      writeFileSync(targetPath, result.normalized, "utf-8");
    }

    return {
      sourcePath,
      targetPath,
      success: true,
      linksConverted: result.conversions.length,
      isUpdate,
    };
  } catch (err) {
    return {
      sourcePath,
      targetPath,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      linksConverted: 0,
      isUpdate: false,
    };
  }
}

/**
 * Run the import process
 */
function runImport(options: ImportOptions): ImportSummary {
  const { source, vault, output, dryRun, recursive } = options;

  // Validate paths
  if (!existsSync(source)) {
    error(`Source directory not found: ${source}`);
    process.exit(1);
  }

  if (!existsSync(vault)) {
    error(`Vault directory not found: ${vault}`);
    process.exit(1);
  }

  const targetRoot = join(vault, output);

  log("");
  log(`${colors.bold}Import Bridge${colors.reset}`);
  log(`${colors.dim}─────────────${colors.reset}`);
  log(`Source:  ${source}`);
  log(`Target:  ${targetRoot}`);
  log(`Mode:    ${dryRun ? colors.yellow + "DRY RUN" + colors.reset : "Live"}`);
  log("");

  // Find all markdown files
  const files = findMarkdownFiles(source, recursive);

  if (files.length === 0) {
    warn("No markdown files found in source directory");
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

  log(`Found ${files.length} markdown file(s)`);
  log("");

  // Process each file
  const results: ImportResult[] = [];

  for (const file of files) {
    const result = processFile(file, source, targetRoot, dryRun);
    results.push(result);

    const relativeName = relative(source, file);
    if (result.success) {
      const linkInfo = result.linksConverted > 0 
        ? `${colors.dim}(${result.linksConverted} links)${colors.reset}` 
        : "";
      const action = result.isUpdate ? "update" : "create";
      success(`${relativeName} → ${action} ${linkInfo}`);
    } else {
      error(`${relativeName}: ${result.error}`);
    }
  }

  // Calculate summary
  const summary: ImportSummary = {
    totalFiles: files.length,
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    totalLinksConverted: results.reduce((sum, r) => sum + r.linksConverted, 0),
    created: results.filter((r) => r.success && !r.isUpdate).length,
    updated: results.filter((r) => r.success && r.isUpdate).length,
    results,
  };

  // Print summary
  log("");
  log(`${colors.bold}Summary${colors.reset}`);
  log(`${colors.dim}───────${colors.reset}`);
  log(`Total:    ${summary.totalFiles}`);
  log(`Created:  ${colors.green}${summary.created}${colors.reset}`);
  log(`Updated:  ${colors.cyan}${summary.updated}${colors.reset}`);
  if (summary.failed > 0) {
    log(`Failed:   ${colors.red}${summary.failed}${colors.reset}`);
  }
  log(`Links:    ${summary.totalLinksConverted} converted`);
  log("");

  if (dryRun) {
    warn("Dry run complete. No files were written.");
    log(`Run without ${colors.bold}--dry-run${colors.reset} to apply changes.`);
  } else {
    success("Import complete!");
    log(`Files saved to: ${targetRoot}`);
  }

  return summary;
}

// Main entry point
const args = process.argv.slice(2);
const options = parseArgs(args);

if (options) {
  runImport(options);
}
