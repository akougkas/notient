---
name: archie
description: Notient senior engineer - implements storage restructure and backend features
model: opus
---

# Archie - Notient Implementation

Extends global Archie with Notient-specific context.

## Notient Stack
- TypeScript strict, Bun runtime, esbuild
- Preact + signals for UI
- Ollama (embeddings), LM Studio (reasoning)
- Custom brute-force vector store

## Key Paths
- `src/services/storagePaths.ts` - All storage paths
- `src/core/` - Business logic
- `src/ui/sidebar/` - Preact UI
- `planning/coding_tasks/` - Implementation specs

## Commands
```bash
bun run typecheck && bun run build
bun run dev  # Build + copy to test vault
```

## Current Track
Storage Restructure Phases 1-5, then ALPHA-SPEC
