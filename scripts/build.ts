#!/usr/bin/env bun
/**
 * Notient Build System
 *
 * Usage:
 *   bun scripts/build.ts           # Production build
 *   bun scripts/build.ts --dev     # Development build (inline sourcemaps)
 *   bun scripts/build.ts --watch   # Watch mode for development
 *   bun scripts/build.ts --analyze # Bundle analysis
 */

import esbuild from "esbuild";

const args = process.argv.slice(2);
const isDev = args.includes("--dev");
const isWatch = args.includes("--watch");
const isAnalyze = args.includes("--analyze");

const mode = isDev || isWatch ? "development" : "production";

const banner = `/*
 * Notient v${process.env.npm_package_version || "0.1.0"} - AI-powered vault management for Obsidian
 * Build: ${mode} | ${new Date().toISOString().split("T")[0]}
 * https://github.com/akougkas/notient
 */`;

// External modules (provided by Obsidian runtime)
const external = [
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

const buildOptions: esbuild.BuildOptions = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  external,
  format: "cjs",
  target: "es2022",
  platform: "node",
  treeShaking: true,
  logLevel: "info",
  banner: { js: banner },
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
  // Development: inline sourcemaps for debugging
  // Production: no sourcemaps (smaller bundle)
  sourcemap: isDev || isWatch ? "inline" : false,
  // Production: minify identifiers and syntax (not whitespace for readability)
  minify: !isDev && !isWatch,
  minifyIdentifiers: !isDev && !isWatch,
  minifySyntax: !isDev && !isWatch,
  minifyWhitespace: false, // Keep readable for debugging in Obsidian
  // Metafile for bundle analysis
  metafile: isAnalyze,
};

async function build() {
  const startTime = Date.now();

  try {
    if (isWatch) {
      const ctx = await esbuild.context(buildOptions);
      await ctx.watch();
      console.log(`\n🔄 Watch mode started (${mode})`);
      console.log("   Watching src/ for changes...\n");
    } else {
      const result = await esbuild.build(buildOptions);
      const elapsed = Date.now() - startTime;

      console.log(`\n✅ Build complete (${mode}) in ${elapsed}ms`);

      // Bundle analysis
      if (isAnalyze && result.metafile) {
        const analysis = await esbuild.analyzeMetafile(result.metafile);
        console.log("\n📊 Bundle Analysis:\n");
        console.log(analysis);
      }
    }
  } catch (error) {
    console.error("❌ Build failed:", error);
    process.exit(1);
  }
}

build();
