# Notient Beta Vision - Interview Decisions

**Session**: `notient-beta-vision-1736617200`
**Date**: 2026-01-11
**Rounds**: 7
**Status**: Synthesized

---

## Executive Summary

Notient is a **Sentient Notes Platform** delivered as an Obsidian plugin. It transforms notes from passive files into living entities with pulse, intelligence, and agency - all powered by local LLMs.

The tagline is a **process**: `Vaults that breathe → Notes that think → Knowledge that evolves`

---

## Key Decisions

### Vision & Identity

| Decision | Answer | Rationale |
|----------|--------|-----------|
| **Core Identity** | Sentient Notes Platform | Foundation layer that enables all applications |
| **Delivery Vehicle** | Obsidian Plugin | Easy adoption, universal, lightweight |
| **User-Facing Value** | Research Chief of Staff | What users experience and benefit from |
| **Chief of Staff** | IS Notient | The orchestrator is the product identity |
| **Agents** | Capabilities, not personas | 13 expertise areas, no voice/personality |
| **Codebase** | Single (one branch) | No product/dev split yet, all experimental |

### Tagline Interpretation

**NOT** parallel features, but **sequential process**:

```
Vaults that breathe   →   Notes that think   →   Knowledge that evolves
    (awareness)              (intelligence)           (growth)
```

1. Vault awareness (holistic health, pulse) **enables**
2. Note intelligence (individual agency) which **produces**
3. Knowledge growth (learning, connecting, evolving)

### Scope & Quality

| Decision | Answer | Rationale |
|----------|--------|-----------|
| **Agent Count** | All 13 | Full capability, no MVP stripping |
| **Timeline** | When it's ready | Quality over speed |
| **Quality Bar** | Delightful UX | Premium feel: smooth animations, instant feedback |
| **Scale Target** | 10K-100K notes | WASM vector store mandatory |
| **UX Identity** | Warm & Alive | Sentient feel: shimmer effects, breathing UI |

### Priority Stack

```
1. RELIABILITY          ← CODE RED (in progress)
   Rock-solid stability, no crashes, clear errors

2. CONTEXT AWARENESS    ← Next after CODE RED
   Tag taxonomy understanding, vault-personalized AI

3. PERSONAL TRANSFORMATION  ← Success Gate
   CEO uses on real vault (not test vault)

4. COMMUNITY + RESEARCH  ← After personal validation
   GitHub release, paper, grant proposal
```

### Current State Assessment

| Component | Status | Action |
|-----------|--------|--------|
| **WASM Vector Store** | In Progress | Archie working (CODE RED) |
| **Error Boundaries** | In Progress | Faye working (CODE RED) |
| **App.tsx Refactor** | In Progress | Faye working (CODE RED) |
| **Insights Stream** | **BROKEN** | Phase 3 fix - wiring wrong |
| **Trust Levels** | Implemented | 3-tier system exists |
| **User Profile** | Sufficient | Good for this version |

### Obsidian Boundary

**Clear separation:**
- **Obsidian** = File system + Editor (stores, syncs, edits)
- **Notient** = Intelligence layer (sidecar that thinks)

No overlap. Notient doesn't duplicate Obsidian native features.

### Success Metric

**CEO's personal trust**: Willing to use on real vault (not test vault)

Indicators:
- Vault self-organizes
- Tasks complete reliably
- AI is maximized (context-aware)
- No crashes, clear errors

---

## Research Vision (Parallel Track)

### Core Insight

**Compositional architecture**, not a single technique:

```
Semantic Indexing
    + Idle-time Processing (Dreaming)
    + Human-AI Trust Models
    + Local-first AI
    = Novel Agentic File System
```

### Application Domains

- Distributed file systems
- HPC / Science applications
- Enterprise knowledge systems

### Dev Branch Priorities (Future)

1. **Shadow Layers** - Metadata overlay without touching raw text
2. **Vault Symbiosis** - Cross-note intelligence, contradiction detection

### Thesis Status

Not crystallized. Focus on product first. Thesis emerges from implementation learnings.

---

## What NOT to Do

1. ❌ Over-engineer agent personalities (they're capabilities)
2. ❌ Create branch splits prematurely (one codebase)
3. ❌ Focus on PhD group metrics (CEO's personal trust is the metric)
4. ❌ Ask theoretical questions without reviewing existing code
5. ❌ Strip features for MVP (ship all 13 agents)
6. ❌ Rush timeline (quality when ready)

---

## Next Steps

1. **Complete CODE RED** - Archie (WASM) + Faye (Error Boundaries)
2. **Fix Insights Stream** - Phase 3 wiring
3. **Add Tag Taxonomy Understanding** - Context awareness
4. **Create BETA-SPEC.md** - Clean product specification
5. **Update README.md** - Reflect Beta reality
6. **Update PRD.md** - Align with Beta scope

---

*Generated from 7-round interview on 2026-01-11*
