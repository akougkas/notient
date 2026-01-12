# Project State

## EMERGENCY STOP

**Status:** HALTED - Foundation broken
**See:** `.planning/EMERGENCY-STOP.md` for full details

**Symptoms:**
- CPU 100%, laptop overheating
- UI frozen, 1+ minute load time
- All agents fail to produce output
- Reranker makes 13+ blocking LLM calls per search

**Root Causes:**
1. thinkingParser.ts destroys JSON from reasoning models
2. ollamaReranker.ts blocks UI with sequential LLM calls
3. No async/streaming for heavy operations
4. 29K chunks loaded synchronously into memory

**Next Session Must:**
1. Fix LLM response parsing (thinkingParser.ts, openai-compatible.ts)
2. Fix or remove reranker blocking calls
3. Make index loading async
4. Validate basic functionality before ANY new features

---

## Project Reference

See: .planning/PROJECT.md (updated 2025-01-11)

**Core value:** Reliability — Actions complete or fail gracefully. No crashes. Clear errors.
**Current focus:** ~~Phase 2 (Insights Stream)~~ → **EMERGENCY: Fix foundations**

## Current Position

Phase: **Phase 0: Foundation Repair** (EMERGENCY)
Plan: 0/TBD - Ready for planning
Status: **ACTIVE** - External analysis complete, ready to plan fixes
Last activity: 2026-01-11 — Gemini audit verified, GPT fixes reviewed, Phase 0 formalized

Progress: ░░░░░░░░░░ 0% (ready to plan)

## Critical Issues (P0)

1. **LLM Pipeline Broken**
   - `[lmstudio] Using reasoning_content text (no JSON found)` - repeated
   - `[Note Editor] JSON parse error` → `Generated 0 edit proposals`
   - Thinking models return JSON in `reasoning_content`, parser destroys it

2. **Reranker CPU Spin**
   - 13+ sequential blocking LLM calls per search
   - Each waits for response before next
   - Freezes UI completely

3. **Memory Exhaustion**
   - 29,050 chunks loaded at startup
   - 22,313 embeddings in memory
   - No lazy loading, no pagination

4. **UI Frozen**
   - Synchronous index loading blocks thread
   - Preact re-render storms
   - Signal subscriptions may leak

## Files Requiring Surgery

| File | Issue | Priority |
|------|-------|----------|
| `src/core/chat/thinkingParser.ts` | Destroys JSON from thinking models | P0 |
| `src/services/ollamaReranker.ts` | 13+ blocking calls per search | P0 |
| `src/core/llm/providers/openai-compatible.ts` | Doesn't handle reasoning_content | P0 |
| `src/services/hnswVectorStore.ts` | Synchronous memory loading | P1 |
| `src/ui/sidebar/App.tsx` | Re-render storms | P1 |

## Session Continuity

Last session: 2026-01-11
Stopped at: **Phase 0 formalized** - Ready for `/gsd:plan-phase 0`
Resume file: N/A (no mid-plan checkpoint)

**What happened this session:**
1. Received Gemini deep audit (3 rounds) - confirmed all root causes
2. Received GPT fixes - native HNSW caching (good) + debug code (bad)
3. Verified 6 claims with parallel Explore agents - 5/6 TRUE, 1 PARTIAL
4. Created formal Phase 0 in roadmap with verified root causes
5. GPT's changes NOT committed (need cleanup first)

**Next:** Plan Phase 0 with `/gsd:plan-phase 0`

## Validation Checklist (Must Pass Before Continuing)

- [ ] Plugin loads in <3 seconds
- [ ] CPU stays <20% at idle
- [ ] Chat produces actual responses
- [ ] Search completes in <2 seconds
- [ ] Agents generate valid output (not empty/error)
- [ ] No "JSON parse error" in console
- [ ] No repeated "no JSON found" messages
