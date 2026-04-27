# Notient v1.0 — Living Knowledge Graph for Obsidian

**Status**: Draft for user review
**Date**: 2026-04-25
**Launch target**: 2026-06-01 (5 weeks)
**Author**: Anthony Kougkas with Claude Code (Opus 4.7)
**Domain**: notient.com (purchased)
**Stack**: TypeScript • Bun • Preact • Obsidian Plugin API • SQLite (sql.js) • HNSW (WASM)
**AI substrate**: Local only — dynamo (LM Studio, primary) + mini (llama-server, deep work)

---

## 1. Vision

**Notient = Note + Sentient.** A personal vault that grows a knowledge graph of itself while you write, surfaces what you'd benefit from at the right moment, and never sends a byte to the cloud.

The promise: **your vault, alive.** The metaphor: a *Research Chief of Staff* — sees patterns you miss, drafts options, leaves the call to you.

Five pillars (non-negotiable):

1. **Local-only** — every model call hits a machine you own. No exceptions.
2. **Human steers, AI amplifies** — agents propose; humans approve or undo.
3. **Grounding** — every claim Notient makes cites a source note + heading. Zero hallucination tolerance.
4. **Sentience** — notes have lifecycles (raw → adolescent → mature → synthesis-ready), vitality (health, connectivity, freshness), origin (you wrote / you clipped / AI generated), and **agency** (they participate in your thinking via the graph).
5. **Obsidian-native symbiote** — uses `metadataCache`, `processFrontMatter`, and Editor Extensions as first-class integration points. Intelligence persists in **frontmatter**, not just SQLite. Notient is portable; uninstall the plugin and the graph survives in your markdown.

---

## 2. The Product Trifecta (the whole UX in three moments)

| When | Moment | Brand promise made true |
|------|--------|-------------------------|
| **First run** | **(a) The Vault Awakens.** New user clicks "Begin." Their existing vault — for the test vault, 894 notes — lights up over 3-5 minutes as entities, typed edges, contradictions, and clusters appear in real-time on a graph view. Spectacle. | "Your vault, alive." |
| **Every day** | **(c) The Continuous Co-author.** Open any note. A sidebar panel streams a real-time summary, link suggestions, and "what this note implies," in your own writing voice. Updates as you type. Cancellable. Throttled. | Research Chief of Staff |
| **Earned** | **(b) The Magic Moment.** Within minutes of opening any note, the Stream surfaces an unprompted connection or contradiction from a note you wrote months ago and forgot. *"How did it know?"* | The graph as moat |

**Design rule:** every feature in v1.0 must visibly serve at least one of (a), (b), or (c). Anything that doesn't is v1.x.

---

## 3. Architecture: Three Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                       PRESENCE (UI, never modal)                │
│  Stream · Co-author Panel · Editor Decorations · Vitals · Graph │
└─────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ subscribes to graph mutations
                                  │
┌─────────────────────────────────────────────────────────────────┐
│                      MIND (idle-triggered)                      │
│   Linker · Synthesizer · Contradiction Hunter · Maturity Adv.   │
│              (read graph → propose mutations w/ confidence)     │
└─────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ blackboard (shared graph)
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SENSES (always-on, ~50 ms/save)              │
│ vault save → chunker → embedder → entity/claim extractor → graph│
└─────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │
                          [ Obsidian vault ]
```

**Senses (continuous, lightweight):**
File-saved → debounced 500 ms → chunker → embedder (dynamo, batched) → entity/claim extractor (`qwen3.5-2b` on dynamo for speed) → graph writer. Hot path budget: <100 ms wall-clock for the user-visible portion (UI freeze prevention); embeddings/extraction off main thread via Web Workers.

**Mind (idle, blackboard):**
Specialist agents read graph state, propose graph mutations with provenance + confidence. They share the graph; they do **not** message each other. A coordinator (~50 lines, rule-based) decides what fires when:

- User idle 30 s → **Linker** runs on the active note's neighborhood
- User idle 5 min → **Synthesizer** + **Contradiction Hunter** run on recently-changed clusters
- User idle 30 min → **Maturity Advancer** scans the inbox for promotion candidates
- User explicit "Deepen" command → all four run sequentially on a single note

Mutations land in a staging table; user approves before they touch markdown.

**Presence (pull, not push):**
- **The Stream** — sidebar feed. Insights ranked by `relevance(active_note) × confidence × recency`. Pinnable. Dismissable.
- **Co-author Panel** — sidebar panel that streams a live take on the active note (the (c) experience).
- **Editor Decorations** — CodeMirror widgets at paragraph boundaries: small dots that expand on hover to show "this connects to [[X]]" or "this contradicts a claim in [[Y]]." Never popups, never modals.
- **Vitals** — per-note health score, maturity stage, connectivity, freshness. Always visible.
- **Graph View** — Obsidian's native graph + Notient overlay (typed edges color-coded, confidence shading).

---

## 4. The Graph (the moat)

The graph is the product. Schema:

### 4.1 Nodes

| Type | Source | Identity |
|------|--------|----------|
| `note` | Obsidian file | absolute vault path |
| `concept` | extracted entity (person, project, term, theme) | normalized canonical name |
| `claim` | atomic proposition asserted by a note | hash of (note_path, text) |
| `question` | open question raised by a note | hash of (note_path, text) |

### 4.2 Edges (typed)

| Type | Direction | Notes |
|------|-----------|-------|
| `mentions` | note → concept | from extractor; cheap |
| `asserts` | note → claim | extracted |
| `asks` | note → question | extracted |
| `links` | note → note | from Obsidian's `resolvedLinks` |
| `supports` | claim → claim or note → note | proposed by Linker, requires user approval |
| `contradicts` | claim → claim | proposed by Contradiction Hunter |
| `extends` | note → note | builds on |
| `exemplifies` | note → concept | concrete instance |
| `synthesizes` | note → {note,…} | a synthesis note that combines others |
| `related_to` | concept → concept | weak semantic relation |

Every edge carries `{ source: agent_name, confidence: 0..1, evidence: chunk_id[], created_at, approved_by_user: bool }`.

### 4.3 Dual-store persistence (the moat)

The graph lives in **two places simultaneously**:

1. **SQLite** (`.obsidian/plugins/notient/notient.db`) — hot cache for queries, embeddings, agent staging tables. Rebuildable from scratch.
2. **Frontmatter** (per-note) — durable. Every approved edge writes back to the source note's YAML:

```yaml
---
notient:
  vitals: { health: 78, maturity: adolescent, freshness: 0.92 }
  edges:
    - { type: supports, target: "[[Distributed Systems Notes]]", confidence: 0.84, evidence: "p3" }
    - { type: contradicts, target: "[[Old CAP Theorem Note#claim2]]", confidence: 0.71 }
  summary: "..."  # last AI-written summary
  updated: 2026-04-25T18:00:00Z
---
```

**Why dual-store:** uninstall the plugin, sync your vault to a new machine, share a folder with a collaborator — the intelligence travels in markdown. SQLite is a hot cache; frontmatter is the source of truth. This is the moat no SaaS product can match.

---

## 5. AI Substrate

| Tier | Endpoint | Model | Used for |
|------|----------|-------|----------|
| **Hot path (every save)** | `dynamo:1234` (LM Studio) | `qwen3.5-2b` | entity/claim/question extraction, fast |
| **Embeddings** | `dynamo:1234` | `text-embedding-nomic-embed-text-v2-moe` | chunk vectors |
| **Reasoning (interactive)** | `dynamo:1234` | `qwen3.6-35b-a3b` (or `nemotron-cascade-2-30b-a3b` as fallback) | Co-author, agents, chat |
| **Reranker** | `dynamo:1234` | `granite-4.0-h-350m` | semantic search reranking |
| **Deep synthesis (cron, v1.1)** | `mini:8080` (llama-server) | `qwen3.6-35b` w/ 262K ctx | nightly graph passes over the full vault |

Both endpoints speak OpenAI protocol → one `LMStudioProvider` class works for both. Settings expose endpoints + model overrides. Health monitor probes every 30 s and surfaces in the status footer.

**Failure modes:**
- Dynamo unreachable → degrade to Obsidian-native search; Stream shows "AI offline, graph paused"
- Embedding model unavailable → queue extractions, retry on reconnect
- Reasoning model OOM → fall back to next-smallest available model; surface a notice

---

## 6. The Agent Swarm (the Mind)

Four agents. No more in v1.0. Each is one file, ~150-300 lines.

### 6.1 Linker

**Trigger:** active-note save + user idle 30 s.
**Reads:** active note + its embedding neighborhood (top-20 cosine) + their existing edges.
**Proposes:** new typed edges (`supports`, `extends`, `exemplifies`, `related_to`) with confidence and `evidence: [chunk_id, …]`.
**Method:** vector neighbors → reranker (granite) → reasoning model (qwen3.6-35b-a3b) decides type and confidence with grounded justification quoting source chunks.
**Writes to graph:** edges with `approved_by_user=false`, awaiting user accept.

### 6.2 Synthesizer

**Trigger:** user idle 5 min OR user clicks "synthesize" on a folder/cluster.
**Reads:** a cluster of related notes (DBSCAN over the embedding space, or all notes under a folder).
**Proposes:** a *synthesis note* — drafted markdown summarizing themes, contradictions, open questions.
**Output:** lands in `0-inbox/notient-synthesis/`, opened in a new tab for user review.
**Brand fit:** the Chief of Staff drafts the briefing memo.

### 6.3 Contradiction Hunter

**Trigger:** any new `claim` node created (from extractor) OR user idle 5 min.
**Reads:** the new claim + the top-50 existing claims by embedding similarity.
**Proposes:** `contradicts` edges between claim pairs the reasoning model judges incompatible. Every edge carries `evidence: [chunk_id_a, chunk_id_b]` — the two chunks the contradiction was found in.
**Output:** edge proposal + Stream insight: *"`<new claim>` contradicts `<old claim>` from [[Note#heading]] (84% confidence)."*

### 6.4 Maturity Advancer

**Trigger:** user idle 30 min OR daily on first vault open.
**Reads:** all notes in `0-inbox/` + notes whose `vitals.maturity` is due review.
**Proposes:** maturity stage transitions (raw → adolescent on first edit; adolescent → mature on stable connectivity + word count + recent edits decay; mature → synthesis-ready on outbound link density).
**Output:** updated `notient.vitals.maturity` in frontmatter, surfaced in Vitals panel.

### 6.5 Coordinator (not an agent — a 50-line scheduler)

A small priority-queued event loop:
- listens to `vault-save`, `idle-detected`, `user-action` events
- maps each to the agents that should fire
- governs concurrency: **max 1 reasoning call in flight at a time** (to keep dynamo responsive for Co-author)
- backs off when the user is actively typing (AppEditor focus signal)

This is the "always-on" heart. ~50 lines of TypeScript, no LLM calls.

---

## 7. The Continuous Co-author (the (c) experience, in detail)

The hardest design problem. The architecture:

1. **Trigger:** `active-leaf-change` event from Obsidian.
2. **Cancel** any in-flight co-author stream from the previous note.
3. **Build context** (cheap, ~20 ms): note content + frontmatter + vitals + top-10 neighbors from the graph (titles + summaries).
4. **Stream** a structured response from `qwen3.6-35b-a3b` on dynamo with this rough prompt skeleton:
   ```
   You are the user's research chief of staff. The user writes in this voice:
   <3-shot examples from user's recent stable notes>
   They are now working on this note:
   <note content>
   This note connects to:
   <top-10 graph neighbors with summaries>
   Stream three sections: SUMMARY (1-2 sentences in their voice),
   IMPLIES (forward-looking 1-3 bullet inferences),
   CONNECTS (3-5 link suggestions with one-line reasons).
   Cite [[note]] for every claim.
   ```
5. **Render** as it streams into the Co-author Panel. Each section appears progressively.
6. **Throttle:** if the user keeps typing, debounce regen to 5 s after last keystroke. If they switch notes, abort.
7. **Persist** the final summary into `notient.summary` in frontmatter (so it's available offline + survives uninstall).

**Voice-mimicry strategy:** instead of fine-tuning, we prompt with 3 short examples from the user's most-edited mature notes (selected by maturity score + word count). Cheap, effective, no training pipeline needed for v1.0.

**Cost governor:** Co-author only runs on notes >100 words. Below that, the panel shows vitals + recent edits and waits.

---

## 8. The Onboarding Spectacle (the (a) experience)

**The first 5 minutes:**

1. User installs plugin, opens settings, points at dynamo (`http://192.168.86.143:1234`). Health check passes — green dot.
2. Click **"Awaken Vault."** Modal opens.
3. Modal shows a live graph view (Cytoscape.js, lightweight) starting empty.
4. Indexer spins up Web Workers: chunking → embedding → extraction → graph writes, in parallel batches of 10 notes.
5. Each note appears as a glowing node. Edges materialize as the extractor finds entities/claims; clusters self-organize via force-directed layout.
6. Counters tick: `Notes processed`, `Concepts found`, `Edges proposed`, `Contradictions detected`.
7. After ~3-5 min for 894 notes, modal shows "Your vault is awake. 894 notes • 2,431 concepts • 8,712 edges • 47 contradictions to review."
8. Click "Enter" — sidebar opens with the Stream pre-populated with the most interesting findings.

**Engineering implication:** the indexer isn't just batch processing. It must emit progress events at chunk granularity, and the modal renders an animated graph in real time. This is why (a) gets explicit phase budget — it's a **first-impression product feature**, not just infra.

---

## 9. Surfacing UI: The Stream + Decorations + Vitals

### 9.1 Sidebar layout (locked)

```
┌─ Notient ──────────────────────┐
│ [vitals] [stream] [graph] [⚙]  │  <- nav
├────────────────────────────────┤
│                                 │
│  ACTIVE TAB CONTENT             │
│                                 │
├────────────────────────────────┤
│  CO-AUTHOR PANEL               │  <- always visible when note open
│  Summary · Implies · Connects  │
├────────────────────────────────┤
│  CHAT (collapsible)            │  <- minimal: input + stream
└────────────────────────────────┘
│ ● dynamo • 894 notes • idle    │  <- status footer
└────────────────────────────────┘
```

### 9.2 The Stream tab

Vertical feed. Each card:

```
┌─ Connection · 2 min ago · 87% ──┐
│ "Distributed File Systems Notes" │
│ supports a claim in your active  │
│ note: "POSIX is leaky in HPC."   │
│ [view] [accept] [dismiss]        │
└──────────────────────────────────┘
```

Sort: `confidence × recency × relevance(active_note)`. Filter: type, confidence threshold, age.

### 9.3 Editor decorations

CodeMirror widgets at paragraph boundaries. Small colored dots (color = edge type). Hover → tooltip with target note + reason. Click → jump to target. **Never popups, never blocking.**

### 9.4 Vitals panel

Per-note: health (composite), maturity stage, connectivity (in/out edges), freshness (decay over time since edit), and a "recent agent activity" log.

### 9.5 Chat (minimal v1.0)

Sidebar input box. Streams responses from `qwen3.6-35b-a3b` with the active note + graph context as system prompt. Three commands: `/find <query>` (multi-strategy search MVP — runs Quick (Obsidian native) and Balanced (vector + rerank) in parallel, returns merged results), `/synthesize <folder>` (trigger Synthesizer), `/explain <[[note]]>` (deep read against full neighborhood). No conversation history persistence in v1.0 — fresh thread per session.

### 9.6 Approvals UI

Trust-level minimum viable: every proposed edge / mutation appears in a "Pending" list. User accepts → edge becomes `approved_by_user=true`, written to frontmatter. Rejects → marked `rejected`, agent learns to deprioritize that proposal type. Universal undo via SQLite history table.

---

## 10. Tech Stack & Cross-Cutting Concerns

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript strict | Obsidian plugin standard |
| Runtime | Bun | Fast build, native sqlite later |
| Build | esbuild via `scripts/build.ts` | already configured |
| Lint | Biome | already configured |
| UI framework | Preact + `@preact/signals` | small, reactive, works in Obsidian |
| Persistence | SQLite via `sql.js` (WASM) | zero-deploy, fits in plugin bundle |
| Vector index | HNSW via `hnswlib-wasm` | fast, persistable |
| Embeddings | dynamo OpenAI endpoint | nomic-embed-v2-moe, 768-dim |
| LLM client | OpenAI-compatible JSON over fetch | works for both dynamo + mini |
| Workers | Obsidian-compatible Web Workers | offload chunking/embedding/extraction |
| File I/O | `ObsidianFacade` wrapping vault.adapter | atomic write via temp+rename |

**Cross-cutting must-haves (from `_legacy` reference, redone clean):**

- **Atomic writes** — never write directly to a markdown file. Always temp + fsync + rename. Crash-safe, Windows EPERM-tolerant.
- **Vault lock** — single-instance guard per vault to prevent concurrent plugin runs from corrupting the DB.
- **Thinking-tag parser** — `<think>...</think>` extraction for streaming reasoning models, hide from user by default but expose in a "show reasoning" toggle.
- **Strongly-typed event bus** — every event has a TS type; emit/on are generic.
- **Kernel DI** — services registered once, retrieved by typed key. Phase Galaxy's bug (provider never instantiated) does not happen because the kernel verifies all required services on init.

---

## 11. v1.0 Scope (In / Out)

### IN (must ship Jun 1)

| Feature | Trifecta tie-in |
|---------|-----------------|
| Foundation: kernel, atomic writes, vault lock, dual-store graph (SQLite + frontmatter) | enables all |
| Senses pipeline: chunker, embedder, extractor, indexer, hot-path <100 ms | (a) |
| Onboarding "Awaken Vault" modal w/ live graph | (a) |
| Mind: 4 agents (Linker, Synthesizer, Contradiction Hunter, Maturity Advancer) + Coordinator | (b) |
| Continuous Co-author panel | (c) |
| The Stream (feed of insights with accept/reject) | (b), (c) |
| Editor decorations (typed dots at paragraphs) | (b), (c) |
| Vitals panel | (c) |
| Chat (minimal, single-thread, 3 commands) | (c) |
| Trust gate: nothing writes to markdown without user accept | brand pillar |
| Universal undo (SQLite history) | brand pillar |
| Multi-strategy search MVP: Quick (Obsidian-native) + Balanced (vector + rerank) | (b) |
| Markdown skill: clean writes, atomicity, link integrity | brand pillar |
| Settings: endpoints, model overrides, agent toggles, schedule | infra |
| Status footer: AI health, indexed count, agent activity | trust |
| Marketing: notient.com landing page (one-pager) | launch |
| Docs: install + first-run guide | launch |

### OUT (v1.1, ships ~Jun 22)

- **Canvas/Bases generation skills** — JSON Canvas spec is alone 4-5 days. Defer.
- **Deep search strategy** — agentic graph traversal. Defer.
- **Mini cron / nightly synthesis pass** — needs sync protocol. Defer.
- **Conversation history persistence in chat** — defer.
- **Trust manager full UI** (per-action-type trust levels, learning) — v1.0 is binary accept/reject; richer trust model in v1.1.
- **Voice-mimicry fine-tune** — v1.0 uses few-shot prompting; LoRA in v1.x maybe.
- **Multi-vault support** — v1.0 single vault per plugin instance.
- **Mobile/tablet** — v1.0 desktop only.
- **Cloud sync of graph between machines** — local-first, defer.

---

## 12. v1.1 Roadmap (target: 2026-06-22)

| Feature | Days |
|---------|------|
| Canvas skill (JSON Canvas generation) | 4 |
| Bases skill | 2 |
| Deep search strategy (agentic expansion) | 3 |
| Mini cron + headless runner + sync protocol | 3 |
| Conversation history + persistent chat threads | 2 |
| Full trust manager (per-type levels, learning) | 3 |
| **v1.1 total** | **17 days** |

---

## 13. Five-Week Phase Plan

| Week | Phase | Dates | Ships | Definition of done |
|------|-------|-------|-------|---------------------|
| 1 | **Foundation** | Apr 27 – May 3 | Clean rebuild: kernel + DI, settings, atomic writes, vault lock, SQLite + schema, frontmatter dual-store reader/writer, dynamo+mini providers, health monitor, status footer | Empty plugin loads, settings work, health monitor green, write a note → SHA logged in DB |
| 2 | **Graph** | May 4 – 10 | Senses pipeline: chunker, embedder (Web Worker), entity/claim/question extractor, vector index (HNSW), graph writes. Onboarding "Awaken Vault" modal w/ live graph. | Index 894 notes in <10 min, graph populated and queryable, modal renders animated growth |
| 3 | **Swarm** | May 11 – 17 | 4 agents + Coordinator + idle scheduler + provenance/confidence + staging tables + accept/reject flow. Continuous Co-author panel (the (c) feature) with voice-mimicry prompting + streaming + cancellation. | Open any note → Co-author streams in <2s, Linker/Synthesizer/Contradiction Hunter all produce real proposals on real vault |
| 4 | **Stream** | May 18 – 24 | Sidebar Stream + editor decorations + Vitals panel + Graph view overlay + Chat MVP + multi-strategy search MVP + approvals UI + universal undo | New user run-through: install → awaken vault → 60-second wow on a real note |
| 5 | **Launch** | May 25 – Jun 1 | Hardening (error recovery, OOM handling, offline graceful degrade), telemetry (local only, opt-in), docs site, notient.com landing, beta-tester loop, packaging, version bump to 1.0.0 | Deploy `main.js` ships on June 1; landing page live; beta cohort onboarded |

Each phase ends with a **demo to user** (you) and a **git tag** (`v1.0.0-foundation`, `-graph`, `-swarm`, `-stream`, `-rc1`, `1.0.0`).

---

## 14. Multi-Session Execution Model

This spec will be implemented across many Claude Code sessions over 5 weeks. The execution model:

### 14.1 Cross-session state

| Artifact | Purpose | Updated by |
|----------|---------|------------|
| `.planning/STATE.md` | what phase we're in, what's done, what's next | end of every session |
| `.planning/SESSION-LOG.md` | dated journal of what happened each session | end of every session |
| `.planning/ROADMAP.md` | high-level phase status (overwrites stale "deferred features" doc) | per phase |
| Per-phase `.planning/phase-N-<name>/PLAN.md` | the implementation plan from `writing-plans` | once per phase |
| Per-phase `.planning/phase-N-<name>/STATE.md` | task-level progress | per session in phase |
| `CLAUDE.md` | live project context for any Claude Code session | rewritten Phase 1 (Foundation) |

A new session's first action: `Read .planning/STATE.md` → `Read .planning/<current-phase>/STATE.md` → resume.

### 14.2 Agent-driven development

The repo already has scaffolding for parallel agent dispatch (`.claude/agents/dispatch.py`, role-based git worktrees). v1.0 reuses it. Roles:

| Role | Worktree | Responsibility |
|------|----------|----------------|
| **orchestrator** | main repo | strategic decisions, merges, code review, this plan |
| **implementer** | `_worktrees/notient-implementer/` | feature builds from PLAN.md tasks |
| **simplifier** | `_worktrees/notient-simplifier/` | post-implement cleanup pass |
| **validator** | `_worktrees/notient-validator/` | verification — run tests + manual smoke + report |
| **tester** | `_worktrees/notient-tester/` | dedicated test writer for new modules |
| **docs-fetcher** | `_worktrees/notient-docs-fetcher/` | research Obsidian/Preact API specifics |

Workflow per task:
1. Orchestrator (Claude Code main session) reads next task from `PLAN.md`, dispatches to implementer worktree via `dispatch.py`.
2. Implementer commits to its branch, signals "ready for review."
3. Validator runs `bun run typecheck && bun run lint && bun test`, reports.
4. If green, orchestrator merges to `beta-spec`. If red, dispatches fix to simplifier or back to implementer.
5. Manual smoke test in test vault before phase tag.

This is the existing `superpowers:subagent-driven-development` pattern, applied to Notient.

### 14.3 Branching

- `main` — clean. Only tagged releases (`v1.0.0` on Jun 1).
- `beta-spec` — integration branch, where Phase tags live.
- `phase-N/<feature>` — short-lived, one per task.

All current 80+ legacy branches will be **proposed for deletion in Foundation phase Day 1**: their names + last commit + 1-line summary exported to `docs/_legacy/branch-history.txt`, then user confirms a batch delete. Local-only branches (none of them are pushed); `git reflog` provides 90-day recovery.

---

## 15. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | Graph schema requires late refactor | Med | High | Lock schema in Foundation, write migration tests before agents land |
| 2 | Co-author latency too high to feel real-time | High | High | Stream chunks; pre-fetch context; cache last summary; show "thinking…" within 200ms |
| 3 | Agents propose bad mutations → user trust collapses | Med | High | Confidence threshold + every mutation requires explicit approval in v1.0; quoted evidence on all proposals |
| 4 | Background work hammers user CPU during typing | Med | High | Coordinator backs off on editor focus; max 1 reasoning call concurrent; Web Workers for embedding/extraction |
| 5 | Vault corruption from concurrent writes | Low | Critical | Atomic temp+rename, vault lock, one writer per vault |
| 6 | Dynamo unreachable mid-session | Med | Med | Status footer goes red, agents pause, UI shows "AI offline"; graph queries still work from SQLite |
| 7 | Beta testers without local AI | High | Med | Docs explicitly state: "Notient requires a local LLM endpoint. Recommended: Apple Silicon w/ Ollama, or homelab w/ LM Studio." |
| 8 | Obsidian API regression in 1.5+ | Low | Med | Pin minAppVersion in manifest; keep `ObsidianFacade` thin |
| 9 | Voice-mimicry produces uncanny-valley summaries | Med | Med | A/B test plain summaries vs. voice-mimicked in beta; allow user to disable in settings |
| 10 | 5-week timeline overrun | Med | High | Weekly demo gate; if a phase slips >2 days, cut a v1.0 feature (not a v1.1 promise) |

---

## 16. Launch Success Criteria (Jun 1, 2026)

A v1.0 launch is successful if:

1. **Functional:** A first-time beta tester can install, point at a local LLM endpoint, and see (a) within 5 minutes on a 500+ note vault.
2. **Performant:** Co-author streams its first token in <2s on the active note for 90% of opens.
3. **Trust:** Zero markdown corruption events in 5 beta vaults during the week before launch.
4. **Brand:** Landing page at notient.com, docs at notient.com/docs, install instructions, ≥1 demo video.
5. **Stable:** No P0 bugs open; lint + typecheck clean on `main`; tag `v1.0.0` lives on `main`.
6. **Ecosystem:** Submission to the Obsidian community-plugins repo opened on or before Jun 1 (community review queue takes weeks; "submitted" not "approved" is the launch criterion). BRAT-installable URL provided in install docs as the day-one path.

---

## 17. Glossary

| Term | Meaning |
|------|---------|
| **Notient** | Note + Sentient. The product. |
| **The graph** | Notient's typed, evidence-backed graph of notes/concepts/claims/questions and their relations. Lives in SQLite + frontmatter. |
| **Senses / Mind / Presence** | The three architectural layers. |
| **The Trifecta** | (a) Awaken Vault onboarding, (b) Magic Moment connections, (c) Continuous Co-author. The whole UX. |
| **The Stream** | Sidebar feed of agent-proposed insights, ranked. |
| **Vitals** | Per-note health/maturity/connectivity/freshness. |
| **Agent (Linker, Synthesizer, Contradiction Hunter, Maturity Advancer)** | Specialist functions in the Mind layer that propose graph mutations. |
| **Coordinator** | The 50-line scheduler that fires agents on idle/save/user-action triggers. |
| **Provenance** | Every edge records which agent created it, with what evidence. |
| **Approval** | Nothing touches markdown without user accept in v1.0. |
| **Dual-store** | SQLite (hot cache) + frontmatter (durable). Frontmatter is the source of truth. |
| **Awaken Vault** | The first-run modal that builds the initial graph with live visualization. |
| **dynamo / mini** | The user's homelab AI servers. dynamo = primary (LM Studio); mini = deep work (llama-server). |

---

## End of Spec

Next steps after user approval:
1. Invoke `superpowers:writing-plans` to produce `phase-1-foundation/PLAN.md`
2. Begin Foundation phase Mon Apr 27
3. Demo at end of week to user, tag `v1.0.0-foundation`, advance to Phase 2
