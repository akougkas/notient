# Project State

## EMERGENCY STOP

**Status:** IN PROGRESS - Foundation repair underway
**See:** `.planning/EMERGENCY-STOP.md` for full details

**Symptoms:**
- CPU 100%, laptop overheating
- UI frozen, 1+ minute load time
- All agents fail to produce output
- Reranker makes 13+ blocking LLM calls per search

**Root Causes:**
1. thinkingParser.ts destroys JSON from reasoning models
2. ollamaReranker.ts blocks UI with sequential LLM calls
3. ~~No async/streaming for heavy operations~~ ✓ FIXED (00-01)
4. ~~29K chunks loaded synchronously into memory~~ ✓ FIXED (00-01)

**Remaining Work:**
1. Fix LLM response parsing (thinkingParser.ts, openai-compatible.ts)
2. Fix or remove reranker blocking calls
3. Validate basic functionality before ANY new features

---

## Project Reference

See: .planning/PROJECT.md (updated 2025-01-11)

**Core value:** Reliability — Actions complete or fail gracefully. No crashes. Clear errors.
**Current focus:** **Phase 0: Foundation Repair** (EMERGENCY)

## Current Position

Phase: **Phase 0: Foundation Repair** (EMERGENCY)
Plan: 1/TBD complete
Status: **IN PROGRESS** - Async loading fixed, more plans may follow
Last activity: 2026-01-11 — Completed 00-01-PLAN.md (async loading bottlenecks)

Progress: ██░░░░░░░░ ~15% (1 plan complete, more root causes remain)

## Critical Issues (P0)

1. **LLM Pipeline Broken** ❌
   - `[lmstudio] Using reasoning_content text (no JSON found)` - repeated
   - `[Note Editor] JSON parse error` → `Generated 0 edit proposals`
   - Thinking models return JSON in `reasoning_content`, parser destroys it

2. **Reranker CPU Spin** ❌
   - 13+ sequential blocking LLM calls per search
   - Each waits for response before next
   - Freezes UI completely

3. ~~**Memory Exhaustion**~~ ✓ FIXED
   - Now uses parallel batched loading with yields
   - Progress logged during startup

4. ~~**UI Frozen on Startup**~~ ✓ FIXED
   - Now yields to event loop during heavy operations
   - Stage-based progress logging

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
| 00-01 | Batch size 50 for parallel loading | Balance throughput vs FD exhaustion |
| 00-01 | setTimeout(0) yields vs streaming parser | Simpler, no new deps |

## Files Requiring Surgery

| File | Issue | Priority | Status |
|------|-------|----------|--------|
| `src/core/chat/thinkingParser.ts` | Destroys JSON from thinking models | P0 | ❌ |
| `src/services/ollamaReranker.ts` | 13+ blocking calls per search | P0 | ❌ |
| `src/core/llm/providers/openai-compatible.ts` | Doesn't handle reasoning_content | P0 | ❌ |
| `src/services/chunkStore.ts` | Sequential file loading | P0 | ✓ FIXED |
| `src/services/indexManager.ts` | Blocking JSON.parse | P0 | ✓ FIXED |

## Session Continuity

Last session: 2026-01-12
Stopped at: **BLOCKED - UI freeze persists. Option C failed. SDK migration required.**
Resume file: `.planning/phases/00-foundation-repair/.continue-here.md`

**What happened this session:**
1. Structured output works (logs prove it: 435 chars, project confidence 0.95)
2. UI freeze happens AFTER classification completes
3. Option C (setTimeout) FAILED - freeze still occurs
4. Conducted 8-round architecture interview (SDK migration decided)
5. Created SDK migration plan in .continue-here.md

**Next session MUST:**
1. Execute SDK migration (Option B) - no more debugging REST API
2. `bun add @lmstudio/sdk ollama`
3. Create `lmstudio-sdk.ts` and `ollama-sdk.ts` per plan in .continue-here.md
4. Delete old REST-based provider code

## Validation Checklist (Must Pass Before Continuing)

- [ ] Plugin loads in <3 seconds
- [ ] CPU stays <20% at idle
- [ ] Chat produces actual responses
- [ ] Search completes in <2 seconds
- [ ] Agents generate valid output (not empty/error)
- [ ] No "JSON parse error" in console
- [ ] No repeated "no JSON found" messages
