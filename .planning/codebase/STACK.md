# Technology Stack

**Analysis Date:** 2026-01-11

## Languages

**Primary:**
- TypeScript 5.6 - All application code (`package.json`, `tsconfig.json`)

**Secondary:**
- JavaScript (ES2022 target) - Build scripts, config files
- JSX/TSX - Preact component files via `jsxImportSource: "preact"` (`tsconfig.json`)

## Runtime

**Environment:**
- Bun 1.3.5 - Runtime and package manager (`package.json`)
- Obsidian Plugin Runtime - Plugin system for vault management (`manifest.json`)
- Minimum Obsidian version: 1.4.0

**Package Manager:**
- Bun
- Lockfile: `bun.lock` present

## Frameworks

**Core:**
- Preact 10.28.2 - Lightweight React-like UI framework (`package.json`, `src/ui/sidebar/App.tsx`)
- @preact/signals 2.5.1 - Reactive state management (`src/ui/sidebar/state.ts`)

**Testing:**
- Bun built-in test runner - `bun test` command (`package.json`)
- No vitest/jest configuration (tests via manual benchmarking in `/testbench/`)

**Build/Dev:**
- esbuild 0.19.8 - Bundle building (`scripts/build.ts`)
- TypeScript Compiler (tsc) - Type checking (`package.json` scripts)
- Biome 1.9.0 - Linting and formatting (`biome.json`)

## Key Dependencies

**Critical:**
- @lmstudio/sdk 0.3.0 - LM Studio client SDK for local LLM reasoning (`src/core/llm/providers/lmstudio.ts`, `src/services/lmstudio.ts`)
- ollama 0.5.0 - Ollama embeddings and reranking client (`src/services/ollama.ts`, `src/services/ollamaReranker.ts`)
- hnswlib-wasm 0.8.2 - High-dimensional vector search via WASM (`src/services/hnswVectorStore.ts`)
- marked 17.0.1 - Markdown parsing and rendering (`src/ui/sidebar/components/chat/MarkdownRenderer.tsx`)
- prismjs 1.30.0 - Syntax highlighting for code blocks

**Infrastructure:**
- obsidian 1.4.11 - Obsidian API (`src/main.ts`, `src/adapters/obsidianFacade.ts`)
- tslib 2.6.2 - TypeScript helper library

## Configuration

**Environment:**
- No environment variables required
- Configuration via Obsidian plugin settings (`data.json`)
- LLM connections: LM Studio (localhost:1234), Ollama (localhost:11434)

**Build:**
- `tsconfig.json` - TypeScript configuration with strict mode
- `biome.json` - Code linting and formatting rules
- `scripts/build.ts` - Custom Bun-based build system
- Path aliases: `@/*`, `@core/*`, `@ui/*`, `@services/*`, `@types/*`, `@views/*`

## Platform Requirements

**Development:**
- macOS/Linux/Windows (any platform with Bun)
- WSL2 tested for Windows development
- No external Docker dependencies

**Production:**
- Distributed as Obsidian community plugin
- Runs within Obsidian desktop application
- Requires local LLM services: LM Studio + Ollama

---

*Stack analysis: 2026-01-11*
*Update after major dependency changes*
