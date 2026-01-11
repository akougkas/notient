# Archie - Backend Wiring Fixes (Round 2)
status: ready
phase: p1-s3.5
branch: ALPHA-SPEC-SPRINT

## context
Previous fixes (commit f82965e) addressed Classifier, NoteEditor, Reranker.
Retest revealed: LinkFinderAgent also needs JSON fix, chat prompt too delegation-happy.

## do

### 1. Fix JSON parsing in LinkFinder (P0)
- src/core/agents/linkFinderAgent.ts
  - Same pattern as ClassifierAgent (from your previous fix)
  - LLM outputs markdown `**` inside JSON: `"reason": **"Data-ce"...`
  - Sanitize control chars and markdown before parsing
  - Return `{ links: [] }` on parse failure
  - Log warning but don't throw

### 2. Tune chat prompt to reduce delegation (P1)
- src/core/agents/agentIdentity.ts (chat specialization)
  - Current: LLM outputs `[DELEGATE:link-finder]` too eagerly for summaries
  - Add to chat agent prompt: "Only use [DELEGATE:agent] for EXPLICIT user requests to edit/link/classify. For summaries, analysis, or questions, respond directly."
  - Goal: Delegation for "find links" requests, NOT for "summarize this" requests

### 3. (Optional) Increase embedding timeout for large files
- src/services/ollama.ts
  - Current: 30000ms timeout causing failures on large IOWarp docs
  - Consider: increase to 60000ms OR chunk text before embedding
  - Low priority - only affects initial indexing

## anti-patterns
- Don't remove `[DELEGATE:]` support entirely - it's useful for explicit requests
- Don't add complex markdown stripping - simple sanitization is enough
- Don't break the existing parseRerankerScore() logic you already fixed

## verify
- `bun run typecheck` → pass
- `bun run build` → pass
- manual: click "Find Links" → LinkFinder works even if LLM returns malformed JSON
- manual: click "Summary" → Chat responds directly WITHOUT delegating to link-finder
- manual: type "find connections for this note" in Chat → Chat DOES delegate to link-finder

## git
files: src/core/agents/linkFinderAgent.ts, src/core/agents/agentIdentity.ts, planning/orchestration/archie/REPORT.md
msg: "fix(agents): Add LinkFinder JSON sanitization, tune chat delegation prompt"
