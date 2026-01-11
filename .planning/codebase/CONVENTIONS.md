# Coding Conventions

**Analysis Date:** 2026-01-11

## Naming Patterns

**Files:**
- camelCase for source files (`simpleIndexer.ts`, `healthMonitor.ts`, `chatAgent.ts`)
- PascalCase.tsx for Preact components (`App.tsx`, `NoteCard.tsx`, `RichChatView.tsx`)
- index.ts for barrel exports and module entry points
- UPPERCASE.md for important docs (README, CLAUDE)

**Functions:**
- camelCase for all functions (`buildBaseIdentity`, `initialize`, `execute`)
- No special prefix for async functions
- handle* for event handlers (`handleSubmit`, `handleClick`)

**Variables:**
- camelCase for variables (`noteVitals`, `searchResults`)
- UPPER_SNAKE_CASE for constants (`PLUGIN_ID`, `STORAGE_PATHS`, `AGENT_CONFIGS`)
- No underscore prefix (TypeScript private keyword handles it)

**Types:**
- PascalCase for interfaces (`NotientSettings`, `AgentContext`, `UserProfile`)
- PascalCase for type aliases (`AgentType`, `SearchPreset`, `InitializationState`)
- No I prefix for interfaces (`User`, not `IUser`)

## Code Style

**Formatting (via Biome):**
- 2 spaces indentation (no tabs)
- Double quotes for strings (`"string"` not `'string'`)
- Semicolons always required
- 100 character line width
- Config: `biome.json`

**Linting (via Biome 1.9.0):**
- Recommended rules enabled
- `noExplicitAny`: warn (allowed with justification comment)
- `useConst`: error (enforce const over let)
- Complexity exceptions for large files
- Run: `bun run lint`

## Import Organization

**Order:**
1. External packages (`obsidian`, `preact`, `marked`)
2. Internal modules via path aliases (`@core/*`, `@services/*`)
3. Relative imports (`./utils`, `../types`)
4. Type imports (`import type { ... }`)

**Grouping:**
- Blank line between groups
- Biome auto-sorts on format
- Type-only imports use `import type {}`

**Path Aliases:**
- `@/*` → `src/*`
- `@core/*` → `src/core/*`
- `@services/*` → `src/services/*`
- `@types/*` → `src/types/*`
- `@ui/*` → `src/ui/*`
- `@views/*` → `src/views/*`

## Error Handling

**Patterns:**
- Throw errors at point of failure
- Catch at boundaries (UI, service entry points)
- Graceful degradation with fallback values

**Error Types:**
- Standard Error for recoverable failures
- Descriptive messages: `new Error("LM Studio connection required for agent tasks")`
- Chain errors when wrapping: Not commonly used (direct re-throw)

**LLM Response Handling:**
- Sanitize control characters before JSON.parse
- Return empty/fallback output on parse failures
- Log warnings but continue execution

## Logging

**Framework:**
- console.log with `[ComponentName]` prefixes
- console.error for errors
- console.warn for recoverable issues

**Patterns:**
- Log initialization and lifecycle events
- No debug logging in production code
- Prefix format: `[Kernel]`, `[SearchPipeline]`, `[OllamaRerankerService]`

**When to Log:**
- Service initialization: `"[Notient] Loading plugin..."`
- State transitions: `"[Notient] Init state:", ctx.state`
- Errors: `"[AgentTaskQueue] Cannot enqueue task - LLM agent not available"`

## Comments

**When to Comment:**
- Explain why, not what
- Document business logic and edge cases
- Architecture notes for complex systems

**JSDoc/TSDoc:**
- Required for public API functions
- Use `@param`, `@returns`, `@throws` tags
- Multi-line blocks at file level

**Section Headers:**
```typescript
// ===========================================================================
// Section Name
// ===========================================================================
```

**Biome Directives:**
- `// biome-ignore lint/rule: explanation` when suppressing rules
- Always include justification

## Function Design

**Size:**
- Keep under 50 lines when possible
- Extract helpers for complex logic
- Large files acknowledged in biome.json exceptions

**Parameters:**
- Max 3-4 parameters
- Use options object for more: `function create(options: CreateOptions)`
- Destructure in parameter list when appropriate

**Return Values:**
- Explicit return statements
- Return early for guard clauses
- Use `| null` or `| undefined` for optional returns

## Module Design

**Exports:**
- Named exports preferred
- Default exports only for Preact components
- Barrel files (index.ts) for public API

**Barrel Files:**
- Re-export public API from index.ts
- Keep internal helpers private
- Avoid circular dependencies

**Service Pattern:**
- Classes with constructor DI
- `initialize()` for async setup
- `dispose()` for cleanup
- Register in Kernel

---

*Convention analysis: 2026-01-11*
*Update when patterns change*
