# Testing Patterns

**Analysis Date:** 2026-01-11

## Test Framework

**Runner:**
- Bun built-in test runner
- Config: No separate config file (uses package.json)

**Assertion Library:**
- Bun built-in expect (if tests existed)
- Currently: manual benchmarking only

**Run Commands:**
```bash
bun run test                              # Run all tests (none currently)
bun run typecheck                         # TypeScript type checking
bun run lint                              # Biome linting
bun run verify                            # typecheck + lint + build
```

## Test File Organization

**Location:**
- No unit tests found in `src/`
- Benchmarking scripts in `testbench/`

**Naming:**
- Would use `*.test.ts` pattern (not implemented)
- Benchmarks use descriptive names: `reranking-benchmark.ts`

**Structure:**
```
testbench/
├── reranking/
│   ├── reranking-benchmark.ts    # Model latency/quality tests
│   └── test-integration.ts       # Integration tests
└── embedding/
    └── embedding-benchmark.ts    # Embedding performance tests
```

## Test Structure

**Benchmarking Pattern:**
```typescript
interface BenchmarkResult {
  model: string;
  queryLatencies: number[];
  scores: { query: string; doc: string; score: number; expected: "relevant" | "irrelevant" }[];
  errors: string[];
}

interface TestCase {
  query: string;
  instruction?: string;
  relevantDocs: string[];
  irrelevantDocs: string[];
}

const TEST_CASES: TestCase[] = [/* manually curated */];
```

**Patterns:**
- Manual test case curation for LLM benchmarks
- Metrics: latency (p50, p95, mean), score distribution, ranking quality
- Tests run against live LLM services (Ollama, LM Studio)

## Mocking

**Framework:**
- No mocking framework detected
- Tests use real services

**What Would Be Mocked (if tests existed):**
- LLM responses
- File system operations
- Obsidian APIs

**Current Approach:**
- Integration testing against live services
- Manual verification in Obsidian

## Fixtures and Factories

**Test Data:**
- Hardcoded test cases in benchmark files
- Curated query/document pairs for reranking
- No shared fixtures directory

**Location:**
- Inline in benchmark scripts
- No `tests/fixtures/` directory

## Coverage

**Requirements:**
- No coverage requirements
- No coverage tooling configured

**Current Status:**
- No unit test coverage
- Critical paths untested:
  - `src/core/indexer/tieredSemanticChunker.ts` (TSI v2 chunking)
  - `src/core/agentic/actionApplier.ts` (file modifications)
  - `src/services/indexManager.ts` (index persistence)
  - `src/core/agents/chiefOfStaff.ts` (agent routing)

## Test Types

**Unit Tests:**
- Not implemented
- Would test individual functions in isolation
- Would mock external dependencies

**Integration Tests:**
- Benchmarks serve as partial integration tests
- Test LLM service connections
- Test reranking quality

**E2E Tests:**
- Not implemented
- Manual testing in Obsidian vault

## Common Patterns

**Quality Gates (Build Pipeline):**
```bash
bun run verify        # typecheck + lint + build
bun run build         # typecheck + lint + esbuild
bun run dev           # typecheck + lint + esbuild (with copy)
bun run dev:fast      # esbuild only (skips checks)
```

**Verification Strategy (per CLAUDE.md):**
1. State how change will be verified before implementing
2. Write verification step first (if test-based)
3. Implement the code
4. Run verification and iterate

**Manual Testing:**
- Test vault: `/mnt/c/Users/akougk/Projects/vaultex`
- `bun run dev` copies to vault for testing
- Obsidian reload to pick up changes

## Recommendations for Future Tests

**Priority Test Targets:**
1. Chunking logic (`tieredSemanticChunker.ts`)
2. Action application (`actionApplier.ts`)
3. Agent routing (`chiefOfStaff.ts`)
4. Index persistence (`indexManager.ts`)
5. Search strategies (`pipeline.ts`)

**Suggested Patterns:**
- Co-locate tests: `module.test.ts` alongside `module.ts`
- Use Bun's built-in testing
- Mock LLM responses for deterministic tests
- Integration tests against test vault

---

*Testing analysis: 2026-01-11*
*Update when test patterns change*
