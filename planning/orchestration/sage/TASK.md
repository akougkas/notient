# Sage - Holistic Codebase Review + Simplification
status: complete
phase: code-red-final
branch: ALPHA-SPEC-SPRINT

## context
Archie and Faye completed CODE RED Round 2 fixes:
- Archie: Chat model decoupling, HNSW race fix, abort indexing on reinit
- Faye: Agent Streams wiring, Insights flow, event emission fixes

Now need holistic review of ENTIRE codebase using code-simplifier. Not just recent changes - the full src/ directory needs audit for consistency, dead code, and architectural issues.

## do

### 1. Review Archie's Changes
Files: `src/main.ts`, `src/services/hnswVectorStore.ts`, `src/services/indexManager.ts`, `src/core/indexer/simpleIndexer.ts`

Check for:
- `reinitializeChatOnly()` is minimal and correct
- HNSW `waitForReady()` pattern is clean
- Abort signal propagation is complete
- No memory leaks from disposed services

### 2. Review Faye's Changes
Files: `src/ui/sidebar/hooks/useAppEvents.ts`, `src/ui/sidebar/state/appHandlers.ts`, `src/core/agent/taskQueue.ts`, `src/ui/sidebar/state.ts`

Check for:
- Event emission/reception is symmetric
- Signal updates use immutable patterns
- No duplicate event handlers
- InsightStream wiring is complete

### 3. Holistic Backend Audit
Use code-simplifier on:
- `src/core/agents/*.ts` - Agent implementations
- `src/core/chat/*.ts` - Chat service
- `src/core/agentic/*.ts` - Action system
- `src/services/*.ts` - All services

Look for:
- Dead code (unused exports, unreachable branches)
- Duplicate logic that can be extracted
- Inconsistent error handling patterns
- Over-complicated abstractions
- Missing TypeScript types (any without justification)

### 4. Holistic Frontend Audit
Use code-simplifier on:
- `src/ui/sidebar/components/*.tsx` - All components
- `src/ui/sidebar/hooks/*.ts` - All hooks
- `src/ui/sidebar/state/*.ts` - All state

Look for:
- Unused imports
- Redundant signal subscriptions
- Components that could be simpler
- CSS classes without styles (or vice versa)

### 5. Cross-Cutting Issues
Look for:
- Inconsistent logging patterns (`[Service]` prefix everywhere?)
- Hardcoded strings that should be constants
- Promise chains that could be async/await
- Error messages that don't help debugging

## rules
- Use `code-simplifier` subagent EXCLUSIVELY
- Do NOT write code directly - only via code-simplifier
- Run `bun run typecheck` after EACH simplification batch
- Run `bun run build` before final commit
- Small commits - one concern per commit
- Document ALL changes in REPORT.md with file:line references

## commit-format
```
refactor(scope): what was simplified

- file:lines: change description
- file:lines: change description
```

Examples:
- `refactor(agents): Remove dead code from chatAgent`
- `refactor(ui): Extract duplicate event handlers`
- `refactor(services): Standardize error logging`

## verify
- `bun run typecheck` → pass (zero errors)
- `bun run build` → pass (no warnings)
- No behavioral changes (refactor only)
- All simplifications documented in REPORT.md

## deliverables
1. Clean commits for each simplification area
2. Comprehensive REPORT.md with:
   - Summary of changes
   - Files modified with line numbers
   - Issues found but NOT fixed (backlog)
   - Recommendations for future cleanup

## git
files: Multiple (documented in REPORT.md)
msg: See commit-format above (multiple commits expected)
