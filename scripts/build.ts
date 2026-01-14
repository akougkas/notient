#!/usr/bin/env bun
/**
 * Notient Build System
 *
 * Professional build script for development and production.
 * Supports the Phase 1/2 storage restructure with separated chunks and embeddings.
 *
 * Commands:
 *   bun run build              Production build (typecheck + minify)
 *   bun run build:dev          Dev build (no minify, sourcemaps)
 *   bun run dev                Dev build + copy to vault
 *   bun run dev:watch          Watch mode with auto-copy
 *   bun run dev:clean          Legacy clean (preserves data/, removes old flat files)
 *   bun run dev:reset          Soft reset (settings + operational data only)
 *   bun run dev:hard-reset     Hard reset (wipe ALL plugin data including data/)
 *   bun run analyze            Bundle size analysis
 */

import esbuild from "esbuild";
import { existsSync, readdirSync, statSync, watch } from "fs";
import { cp, readdir, rm, mkdir, stat } from "fs/promises";
import { basename, join } from "path";

// ============ Configuration ============

const VAULT_PLUGIN = "/mnt/c/Users/akougk/Projects/vaultex/.obsidian/plugins/notient";
const PROJECT_ROOT = process.cwd();

// Files to deploy to vault
const DEPLOY_FILES = ["main.js", "vector.worker.js", "embed.worker.js", "manifest.json", "styles.css"];

// Core plugin files (never deleted)
const CORE_FILES = new Set(["main.js", "vector.worker.js", "embed.worker.js", "manifest.json", "styles.css", "data.json"]);

// New structure directories (Phase 1/2)
const NEW_STRUCTURE = {
  DATA: "data",
  CHUNKS: "data/chunks",
  EMBEDDINGS: "data/embeddings",
  INTELLIGENCE: "data/intelligence",
  CONVERSATIONS: "data/conversations",
  ACTIONS: "data/actions",
  PROFILE: "data/profile",
  OPERATIONAL: "data/_operational",
};

// Legacy files (Phase 1/2 migration targets)
const LEGACY_FILES = [
  "index-state.json",
  "conversations.json",
  "actions.json",
  "profile.json",
  "cache",
  "locks",
  "logs",
  ".deleted",
];

// Operational data (can be safely deleted for soft reset)
const OPERATIONAL_DATA = [
  "data/_operational",
  "locks",
  "cache",
  "logs",
  ".deleted",
];

// External modules provided by Obsidian runtime
const EXTERNALS = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
];

// ============ Argument Parsing ============

const args = process.argv.slice(2);
const command = args[0] || "build";
const flags = new Set(args.slice(1));

const isDev = command === "dev" || command === "fast";
const isFast = command === "fast" || flags.has("--fast") || flags.has("-f");
const isWatch = flags.has("--watch") || flags.has("-w");
const isClean = flags.has("--clean") || flags.has("-c");
const isReset = command === "reset";
const isHardReset = command === "hard-reset";
const isAnalyze = command === "analyze";

// ============ Terminal Colors ============

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

function log(message: string, color: keyof typeof colors = "reset"): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title: string): void {
  console.log(`\n${colors.bright}${colors.cyan}━━━ ${title} ━━━${colors.reset}\n`);
}

function logSuccess(message: string): void {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function logInfo(message: string): void {
  console.log(`${colors.blue}ℹ${colors.reset} ${message}`);
}

function logWarn(message: string): void {
  console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
}

function logError(message: string): void {
  console.log(`${colors.red}✗${colors.reset} ${message}`);
}

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

// ============ Build Configuration ============

function getBuildOptions(dev: boolean): esbuild.BuildOptions {
  const mode = dev ? "development" : "production";
  const version = process.env.npm_package_version || "0.3.1";

  const banner = `/*
 * Notient v${version}
 * Build: ${mode} | ${new Date().toISOString().split("T")[0]}
 * Storage: Phase 2 (chunk/embedding separation)
 */`;

  return {
    entryPoints: ["src/main.ts"],
    bundle: true,
    outfile: "main.js",
    external: EXTERNALS,
    format: "cjs",
    target: "es2022",
    platform: "node",
    treeShaking: true,
    logLevel: "info",
    banner: { js: banner },
    define: {
      "process.env.NODE_ENV": JSON.stringify(mode),
    },
    sourcemap: dev ? "inline" : false,
    minify: !dev,
    minifyIdentifiers: !dev,
    minifySyntax: !dev,
    minifyWhitespace: false,
    metafile: isAnalyze,
    jsx: "automatic",
    jsxImportSource: "preact",
    loader: { ".tsx": "tsx", ".ts": "ts" },
  };
}

const cssBuildOptions: esbuild.BuildOptions = {
  entryPoints: ["src/ui/styles/index.css"],
  bundle: true,
  outfile: "styles.css",
  logLevel: "info",
  minify: !isDev && !isClean && !isReset && !isHardReset,
};

const vectorWorkerBuildOptions: esbuild.BuildOptions = {
  entryPoints: ["src/workers/vector.worker.ts"],
  bundle: true,
  outfile: "vector.worker.js",
  format: "esm",
  target: "es2022",
  platform: "browser",
  logLevel: "info",
  minify: !isDev,
  sourcemap: isDev ? "inline" : false,
};

const embedWorkerBuildOptions: esbuild.BuildOptions = {
  entryPoints: ["src/workers/embed.worker.ts"],
  bundle: true,
  outfile: "embed.worker.js",
  format: "esm",
  target: "es2022",
  platform: "browser",
  logLevel: "info",
  minify: !isDev,
  sourcemap: isDev ? "inline" : false,
};

// ============ Build Functions ============

async function build(dev: boolean): Promise<esbuild.BuildResult | null> {
  const start = Date.now();
  const mode = dev ? "development" : "production";

  logSection(`Building (${mode})`);

  try {
    const [jsResult] = await Promise.all([
      esbuild.build(getBuildOptions(dev)),
      esbuild.build(cssBuildOptions),
      esbuild.build(vectorWorkerBuildOptions),
      esbuild.build(embedWorkerBuildOptions),
    ]);

    const duration = Date.now() - start;
    console.log();
    logSuccess(`Build complete in ${duration}ms`);

    return jsResult;
  } catch (error) {
    logError(`Build failed: ${error}`);
    return null;
  }
}

async function watchBuild(): Promise<void> {
  const [jsCtx, cssCtx, vectorWorkerCtx, embedWorkerCtx] = await Promise.all([
    esbuild.context(getBuildOptions(true)),
    esbuild.context(cssBuildOptions),
    esbuild.context(vectorWorkerBuildOptions),
    esbuild.context(embedWorkerBuildOptions),
  ]);

  await Promise.all([jsCtx.watch(), cssCtx.watch(), vectorWorkerCtx.watch(), embedWorkerCtx.watch()]);

  logSection("Watch Mode");
  logInfo("Watching src/ for changes...");
  logInfo(`Vault: ${VAULT_PLUGIN}`);
  console.log();

  // Initial copy
  await copyToVault();

  // Watch for changes and copy
  let timeout: Timer | null = null;
  const watcher = watch(join(PROJECT_ROOT, "src"), { recursive: true }, (_, filename) => {
    if (!filename?.match(/\.(ts|tsx|css)$/)) return;

    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(async () => {
      log(`${timestamp()} Rebuilt, copying...`, "dim");
      await copyToVault();
    }, 150);
  });

  process.on("SIGINT", () => {
    watcher.close();
    jsCtx.dispose();
    cssCtx.dispose();
    vectorWorkerCtx.dispose();
    embedWorkerCtx.dispose();
    console.log();
    logInfo("Watch mode stopped");
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

// ============ Vault Operations ============

async function copyToVault(): Promise<void> {
  await mkdir(VAULT_PLUGIN, { recursive: true });

  for (const file of DEPLOY_FILES) {
    const src = join(PROJECT_ROOT, file);
    if (existsSync(src)) {
      await cp(src, join(VAULT_PLUGIN, file));
    }
  }

  // Copy sql-wasm.wasm
  const wasmSrc = join(PROJECT_ROOT, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  if (existsSync(wasmSrc)) {
    await cp(wasmSrc, join(VAULT_PLUGIN, "sql-wasm.wasm"));
  } else {
    logWarn("sql-wasm.wasm not found in node_modules");
  }

  logSuccess(`${timestamp()} Copied to vault`);
}

/**
 * Enable dev mode in plugin settings (skip auto-indexing for faster testing)
 */
async function enableDevMode(): Promise<void> {
  const dataJsonPath = join(VAULT_PLUGIN, "data.json");

  if (!existsSync(dataJsonPath)) {
    logWarn("No data.json found, skipping dev mode setup");
    return;
  }

  try {
    const content = await Bun.file(dataJsonPath).text();
    const settings = JSON.parse(content);

    // Ensure advanced section exists
    if (!settings.advanced) {
      settings.advanced = {};
    }

    // Enable dev mode
    if (!settings.advanced.devSkipAutoIndex) {
      settings.advanced.devSkipAutoIndex = true;
      await Bun.write(dataJsonPath, JSON.stringify(settings, null, 2));
      logSuccess("Dev mode enabled: auto-indexing disabled for faster testing");
    }
  } catch (error) {
    logWarn(`Could not update settings: ${error}`);
  }
}

/**
 * Calculate directory size recursively
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await getDirectorySize(fullPath);
      } else {
        const stats = await stat(fullPath);
        totalSize += stats.size;
      }
    }
  } catch {
    // Ignore errors
  }

  return totalSize;
}

/**
 * Legacy clean: Remove old flat files, preserve new data/ structure
 * Used for: bun run dev --clean or bun run dev:clean
 */
async function cleanLegacy(): Promise<void> {
  if (!existsSync(VAULT_PLUGIN)) {
    logWarn("Vault plugin directory doesn't exist, skipping clean");
    return;
  }

  logSection("Legacy Clean");
  logInfo("Removing old flat files (preserving data/ structure)");
  console.log();

  const entries = readdirSync(VAULT_PLUGIN);
  let totalSize = 0;
  let deletedCount = 0;

  for (const entry of entries) {
    // Keep core files
    if (CORE_FILES.has(entry)) continue;

    // Keep new structure
    if (entry === "data") continue;

    // Delete legacy files and idx_*.json files
    const isLegacy = LEGACY_FILES.includes(entry) || entry.startsWith("idx_") || entry.startsWith("index-");

    if (isLegacy) {
      const fullPath = join(VAULT_PLUGIN, entry);
      try {
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          totalSize += await getDirectorySize(fullPath);
        } else {
          totalSize += stats.size;
        }
        await rm(fullPath, { recursive: true, force: true });
        deletedCount++;
        logSuccess(`Deleted: ${entry}`);
      } catch {
        // Ignore errors
      }
    }
  }

  if (deletedCount === 0) {
    logInfo("No legacy files to clean");
  } else {
    console.log();
    logSuccess(`Cleaned ${deletedCount} items (${formatSize(totalSize)})`);
  }
}

/**
 * Soft reset: Clear settings + operational data only
 * Preserves: chunks, embeddings, conversations, intelligence, actions, profile
 * Used for: bun run dev:reset
 */
async function softReset(): Promise<void> {
  if (!existsSync(VAULT_PLUGIN)) {
    logWarn("Vault plugin directory doesn't exist, skipping reset");
    return;
  }

  logSection("Soft Reset");
  logInfo("Clearing settings + operational data");
  logInfo("Preserving: chunks, embeddings, conversations, intelligence, actions, profile");
  console.log();

  let totalSize = 0;
  let deletedCount = 0;

  // Delete data.json (settings)
  const dataJsonPath = join(VAULT_PLUGIN, "data.json");
  if (existsSync(dataJsonPath)) {
    try {
      const stats = statSync(dataJsonPath);
      totalSize += stats.size;
      await rm(dataJsonPath, { force: true });
      deletedCount++;
      logSuccess("Deleted: data.json (settings)");
    } catch {
      // Ignore
    }
  }

  // Delete operational data
  for (const opPath of OPERATIONAL_DATA) {
    const fullPath = join(VAULT_PLUGIN, opPath);
    if (existsSync(fullPath)) {
      try {
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          totalSize += await getDirectorySize(fullPath);
        } else {
          totalSize += stats.size;
        }
        await rm(fullPath, { recursive: true, force: true });
        deletedCount++;
        logSuccess(`Deleted: ${opPath}`);
      } catch {
        // Ignore
      }
    }
  }

  // Delete legacy files too
  for (const entry of LEGACY_FILES) {
    const fullPath = join(VAULT_PLUGIN, entry);
    if (existsSync(fullPath)) {
      try {
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          totalSize += await getDirectorySize(fullPath);
        } else {
          totalSize += stats.size;
        }
        await rm(fullPath, { recursive: true, force: true });
        deletedCount++;
        logSuccess(`Deleted: ${entry} (legacy)`);
      } catch {
        // Ignore
      }
    }
  }

  if (deletedCount === 0) {
    logInfo("Nothing to reset");
  } else {
    console.log();
    logSuccess(`Reset complete: ${deletedCount} items (${formatSize(totalSize)})`);
  }
}

/**
 * Hard reset: Wipe ALL plugin data
 * Used for: bun run dev:hard-reset
 */
async function hardReset(): Promise<void> {
  if (!existsSync(VAULT_PLUGIN)) {
    logWarn("Vault plugin directory doesn't exist, skipping reset");
    return;
  }

  logSection("Hard Reset");
  logWarn("This will delete ALL plugin data including indexed content!");
  console.log();

  const entries = readdirSync(VAULT_PLUGIN);
  let totalSize = 0;
  let deletedCount = 0;

  // Calculate total size first
  for (const entry of entries) {
    if (CORE_FILES.has(entry) && entry !== "data.json") continue; // Keep main.js, manifest, styles

    const fullPath = join(VAULT_PLUGIN, entry);
    try {
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        totalSize += await getDirectorySize(fullPath);
      } else {
        totalSize += stats.size;
      }
    } catch {
      // Ignore
    }
  }

  // Now delete
  for (const entry of entries) {
    if (entry === "main.js" || entry === "manifest.json" || entry === "styles.css") continue;

    const fullPath = join(VAULT_PLUGIN, entry);
    try {
      await rm(fullPath, { recursive: true, force: true });
      deletedCount++;

      // Show what was deleted with type
      if (entry === "data") {
        logSuccess(`Deleted: ${entry}/ (new structure - chunks, embeddings, etc.)`);
      } else if (entry === "data.json") {
        logSuccess(`Deleted: ${entry} (settings)`);
      } else if (entry.startsWith("idx_")) {
        logSuccess(`Deleted: ${entry} (legacy index)`);
      } else {
        logSuccess(`Deleted: ${entry}`);
      }
    } catch {
      // Ignore errors
    }
  }

  if (deletedCount === 0) {
    logInfo("Nothing to delete");
  } else {
    console.log();
    logSuccess(`Hard reset complete: ${deletedCount} items (${formatSize(totalSize)})`);
    logWarn("Plugin will need to re-index vault on next load");
  }
}

/**
 * Show storage status
 */
async function showStorageStatus(): Promise<void> {
  if (!existsSync(VAULT_PLUGIN)) {
    logInfo("No plugin directory found");
    return;
  }

  logSection("Storage Status");

  const entries = readdirSync(VAULT_PLUGIN);

  // Check for new structure
  const hasNewStructure = existsSync(join(VAULT_PLUGIN, "data"));

  // Check for legacy files
  const legacyFiles = entries.filter(
    (e) => LEGACY_FILES.includes(e) || e.startsWith("idx_") || e.startsWith("index-")
  );

  if (hasNewStructure) {
    logSuccess("Using new storage structure (Phase 2)");

    // Show data directory sizes
    const dataDir = join(VAULT_PLUGIN, "data");
    if (existsSync(dataDir)) {
      const dataDirs = readdirSync(dataDir);
      for (const subdir of dataDirs) {
        const subdirPath = join(dataDir, subdir);
        if (statSync(subdirPath).isDirectory()) {
          const size = await getDirectorySize(subdirPath);
          logInfo(`  data/${subdir}/: ${formatSize(size)}`);
        }
      }
    }
  } else {
    logWarn("Using legacy storage structure");
  }

  if (legacyFiles.length > 0) {
    console.log();
    logWarn(`Found ${legacyFiles.length} legacy files:`);
    for (const f of legacyFiles) {
      const fullPath = join(VAULT_PLUGIN, f);
      const stats = statSync(fullPath);
      const size = stats.isDirectory() ? await getDirectorySize(fullPath) : stats.size;
      logInfo(`  ${f}: ${formatSize(size)}`);
    }
    logInfo("Run 'bun run dev:clean' to remove legacy files");
  }
}

// ============ Main ============

async function main() {
  console.log(`\n${colors.bright}${colors.magenta}Notient Build System${colors.reset}\n`);

  switch (command) {
    case "build": {
      // Production build
      const result = await build(false);
      if (!result) process.exit(1);
      break;
    }

    case "fast":
    case "dev": {
      // Clean if requested
      if (isClean) {
        await cleanLegacy();
      }

      // Watch mode or single build
      if (isWatch) {
        const result = await build(true);
        if (!result) process.exit(1);
        await watchBuild();
      } else {
        const result = await build(true);
        if (!result) process.exit(1);
        await copyToVault();

        // Fast mode: enable dev settings (skip auto-indexing)
        if (isFast) {
          await enableDevMode();
        }

        console.log();
        logInfo("Reload Obsidian to see changes");
        logInfo(`Vault: ${VAULT_PLUGIN}`);
      }
      break;
    }

    case "reset": {
      await softReset();
      console.log();
      const result = await build(true);
      if (!result) process.exit(1);
      await copyToVault();
      console.log();
      logInfo("Reload Obsidian with fresh settings");
      break;
    }

    case "hard-reset": {
      await hardReset();
      console.log();
      const result = await build(true);
      if (!result) process.exit(1);
      await copyToVault();
      console.log();
      logInfo("Reload Obsidian - plugin will re-index vault");
      break;
    }

    case "status": {
      await showStorageStatus();
      break;
    }

    case "analyze": {
      const result = await build(false);
      if (result?.metafile) {
        logSection("Bundle Analysis");
        const analysis = await esbuild.analyzeMetafile(result.metafile);
        console.log(analysis);
      }
      break;
    }

    default:
      logSection("Usage");
      console.log("  bun run build              Production build (typecheck + minify)");
      console.log("  bun run build:dev          Dev build (sourcemaps, no minify)");
      console.log("  bun run dev                Dev build + copy to vault");
      console.log("  bun run dev:watch          Watch mode with auto-copy");
      console.log("  bun run dev:clean          Remove legacy files, preserve data/");
      console.log("  bun run dev:reset          Soft reset (settings + operational)");
      console.log("  bun run dev:hard-reset     Hard reset (ALL plugin data)");
      console.log("  bun run analyze            Bundle size analysis");
      console.log();
      logSection("Storage Commands");
      console.log("  bun scripts/build.ts status    Show storage structure status");
      process.exit(1);
  }
}

main();
