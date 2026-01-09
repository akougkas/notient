#!/usr/bin/env bun
/**
 * Notient Build System
 *
 * Unified build script for development and production.
 *
 * Commands:
 *   bun run build              Production build (typecheck + minify)
 *   bun run dev                Dev build + copy to vault
 *   bun run dev --watch        Watch mode with auto-copy
 *   bun run dev --clean        Wipe all plugin data + fresh build
 *   bun run analyze            Bundle size analysis
 */

import esbuild from "esbuild";
import { existsSync, readdirSync, statSync, watch } from "fs";
import { cp, rm, mkdir } from "fs/promises";
import { join } from "path";

// ============ Configuration ============

const VAULT_PLUGIN = "/mnt/c/Users/akougk/Projects/vaultex/.obsidian/plugins/notient";
const PROJECT_ROOT = process.cwd();

// Files to deploy to vault
const DEPLOY_FILES = ["main.js", "manifest.json", "styles.css"];

// Files to keep during clean (everything else gets deleted)
const KEEP_ON_CLEAN = new Set(["main.js", "manifest.json", "styles.css"]);

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

const isDev = command === "dev";
const isWatch = flags.has("--watch") || flags.has("-w");
const isClean = flags.has("--clean") || flags.has("-c");
const isAnalyze = command === "analyze";

// ============ Build Configuration ============

function getBuildOptions(dev: boolean): esbuild.BuildOptions {
  const mode = dev ? "development" : "production";

  const banner = `/*
 * Notient v${process.env.npm_package_version || "0.2.0"}
 * Build: ${mode} | ${new Date().toISOString().split("T")[0]}
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
  minify: !isDev,
};

// ============ Build Functions ============

async function build(dev: boolean): Promise<esbuild.BuildResult | null> {
  const start = Date.now();

  try {
    const [jsResult] = await Promise.all([
      esbuild.build(getBuildOptions(dev)),
      esbuild.build(cssBuildOptions),
    ]);

    const mode = dev ? "development" : "production";
    console.log(`\nBuild complete (${mode}) in ${Date.now() - start}ms`);

    return jsResult;
  } catch (error) {
    console.error("Build failed:", error);
    return null;
  }
}

async function watchBuild(): Promise<void> {
  const [jsCtx, cssCtx] = await Promise.all([
    esbuild.context(getBuildOptions(true)),
    esbuild.context(cssBuildOptions),
  ]);

  await Promise.all([jsCtx.watch(), cssCtx.watch()]);
  console.log("\nWatch mode started. Watching src/ for changes...\n");

  // Initial copy
  await copyToVault();

  // Watch for changes and copy
  let timeout: Timer | null = null;
  const watcher = watch(join(PROJECT_ROOT, "src"), { recursive: true }, (_, filename) => {
    if (!filename?.match(/\.(ts|tsx|css)$/)) return;

    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(async () => {
      const time = new Date().toLocaleTimeString("en-US", { hour12: false });
      console.log(`${time} Rebuilt, copying to vault...`);
      await copyToVault();
    }, 150);
  });

  process.on("SIGINT", () => {
    watcher.close();
    jsCtx.dispose();
    cssCtx.dispose();
    console.log("\nWatch mode stopped");
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

  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`${time} Copied to vault`);
}

async function cleanVault(): Promise<void> {
  if (!existsSync(VAULT_PLUGIN)) {
    console.log("Vault plugin directory doesn't exist, skipping clean");
    return;
  }

  console.log("\nCleaning plugin data...");

  const entries = readdirSync(VAULT_PLUGIN);
  let totalSize = 0;
  let deletedCount = 0;

  for (const entry of entries) {
    if (KEEP_ON_CLEAN.has(entry)) continue;

    const fullPath = join(VAULT_PLUGIN, entry);
    try {
      const stat = statSync(fullPath);
      if (!stat.isDirectory()) {
        totalSize += stat.size;
      }
      await rm(fullPath, { recursive: true, force: true });
      deletedCount++;
    } catch {
      // Ignore errors
    }
  }

  const sizeStr = totalSize > 1024 * 1024
    ? `${(totalSize / (1024 * 1024)).toFixed(1)} MB`
    : `${(totalSize / 1024).toFixed(1)} KB`;

  console.log(`Deleted ${deletedCount} items (${sizeStr})\n`);
}

// ============ Main ============

async function main() {
  switch (command) {
    case "build": {
      // Production build
      const result = await build(false);
      if (!result) process.exit(1);
      break;
    }

    case "dev": {
      // Clean if requested
      if (isClean) {
        await cleanVault();
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
        console.log("\nReload Obsidian to see changes");
      }
      break;
    }

    case "analyze": {
      const result = await build(false);
      if (result?.metafile) {
        const analysis = await esbuild.analyzeMetafile(result.metafile);
        console.log("\nBundle Analysis:\n");
        console.log(analysis);
      }
      break;
    }

    default:
      console.log(`Unknown command: ${command}`);
      console.log("\nUsage:");
      console.log("  bun run build          Production build");
      console.log("  bun run dev            Dev build + copy to vault");
      console.log("  bun run dev --watch    Watch mode");
      console.log("  bun run dev --clean    Clean + fresh build");
      console.log("  bun run analyze        Bundle analysis");
      process.exit(1);
  }
}

main();
