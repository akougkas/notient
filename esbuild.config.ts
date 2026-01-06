import esbuild from "esbuild";
import process from "process";

const banner = `/*
Notient - AI-powered vault management for Obsidian
https://github.com/akougkas/notient
*/`;

const isWatch = process.argv.includes("--watch");

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
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
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: "inline",
  treeShaking: true,
  outfile: "main.js",
  platform: "node",
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      isWatch ? "development" : "production"
    ),
  },
});

if (isWatch) {
  await context.watch();
  console.log("Watching for changes...");
} else {
  await context.rebuild();
  await context.dispose();
}
