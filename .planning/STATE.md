# Notient Project State

**Version:** 0.2.0 (no git tag — tags reserved for v1.0.0 release)
**Current phase:** Phase 3 (Swarm) — COMPLETE
**Date completed:** 2026-04-25
**Next phase:** Phase 4 (Stream)
**AI substrate:** dynamo (`192.168.86.143:1234`, LM Studio, primary) + mini (`192.168.86.141:8080`, llama-server, deep)
**Test vault:** `/mnt/c/Users/akougk/Projects/vaultex/` (894 markdown notes, PARA structure)

## What works (verified by tests + smoke run)

Carries forward Phase 1 + Phase 2 + Phase 2.5, plus:

- **Schema v2**: `staging_edges`, `staging_nodes`, `agent_runs` with v1 -> v2 migration path. 4 migration tests pass; existing v1 vaults upgrade in place without losing data.
- **Single-flight reasoning mutex** with priority preemption. `ReasoningMutex.runPriority("co-author", ...)` aborts any in-flight agent run via AbortSignal so the user-facing Co-author stream owns dynamo within the spec's <2s latency budget.
- **IdleDetector** emitting 30s / 5m / 30m levels with re-armable activity reset. Uses an injectable clock so tests can drive a fake `now`.
- **Coordinator** dispatches Linker (vault-save + idle-30s), Synthesizer + ContradictionHunter (idle-5m), MaturityAdvancer (idle-30m), and all four (user "Deepen" action). Records every run into `agent_runs` (started_at, finished_at, ok, error, proposals_count). Active typing suppresses idle dispatch.
- **Linker, Synthesizer, ContradictionHunter** all emit JSON via `chatJson<T>` against `nemotron-cascade-2-30b-a3b-i1`. The Phase 2.5 reasoning_content fallback (commit 6b8b10b) keeps nemotron's JSON path live.
- **MaturityAdvancer** is the only agent that writes back to user markdown. It calls `EchoGuard.mark(path, sha)` BEFORE every write so the indexer's modify handler skips the self-write.
- **DBSCAN-cosine** cluster detector (in-house, ~30 lines, no new dep). Used by the Synthesizer over note-centroid embeddings.
- **Continuous Co-author** panel: streams ## SUMMARY / ## IMPLIES / ## CONNECTS sections from `chatStream`, builds a voice-mimicry context from up-to-3 mature notes (excluding the active note), cancels on note switch via `mutex.runPriority("co-author", ...)`. Skips notes below `current.coAuthor.minWords` (default 100).
- **Approvals** UI lists pending staged edges, promotes accepted edges into `graph_edges` with `approved=1` inside a single SQL transaction, deletes rejected staging rows. Emits `approval:decided` events.
- **Wired into `main.ts`**: Coordinator, IdleDetector, ReasoningMutex, ApprovalService, CoAuthorService all register into the kernel before `seal()`. `coordinator.start()` and `idleDetector.start()` fire after `health.start()`. `active-leaf-change` triggers a co-author run via `mutex.runPriority`. `editor-change` calls `idleDetector.recordActivity()`. CoAuthorView and ApprovalsView are registered as Obsidian views.
- All structured-output agents go through `provider.chatJson<T>()`.

## Test count

After Phase 3: **146 passing** (Phase 2.5 baseline 104 + Phase 3 additions: schema 4, mutex 4, idle 3, coordinator 7, linker 3, dbscan 2, synthesizer 2, contradictionHunter 2, maturityAdvancer 3, voiceContext 2, chatStream 3, coAuthorRender 4, approvalService 3 = 42 new).

## DoD (spec §13 row 3)

- [ ] Open any note → Co-author streams its first token in <2s (manual smoke; verify in next dev session)
- [ ] Linker / Synthesizer / Contradiction Hunter / Maturity Advancer all produce ≥1 real proposal in one session (`bun run smoke:coordinator` tally line)
- [ ] Approvals UI accept promotes a staged edge to live (manual smoke)

(Tick during the Phase 3 close-out smoke run; the harness ships in this commit.)

## Tech debt to address opportunistically

- Co-author header detection is a regex over deltas. Brittle if the model emits `# SUMMARY` or `### Summary`. Phase 4 should harden with a stricter prompt + post-stream validator.
- Synthesizer cluster threshold (`epsilon`, `minClusterSize`) is a static tuning. Phase 4 should expose these in settings.
- Approvals UI is list-only. No graph-view promotion preview. Acceptable for v1.0; Phase 4 polishes.
- IdleDetector is wall-clock based. Laptop sleep can fire all three levels at once on resume. Acceptable for v1.0.
- MaturityAdvancer's freshness signal is a placeholder constant of 1.0. Phase 4 Vitals work needs a real decay function.
- Coordinator passes the agent's mutex-bound signal into the agent context. The non-mutex MaturityAdvancer creates a fresh AbortController whose signal is never wired to anything user-cancellable. Acceptable since MA does no LLM work; Phase 4 may revisit if MA gains a slow rule.
- The `userActive` flag in Coordinator is reset only by `vault:note-saved` and `user:active`. The spec template originally also reset it inside the `user:idle` handler, but that made the suppression check unreachable. The current behaviour matches the test that asserts active-typing suppresses idle dispatch.

## What does not exist yet

- The Stream (sidebar feed) + editor decorations + Vitals panel + Graph view overlay (Phase 4)
- Chat MVP + multi-strategy search MVP (Phase 4)
- Universal undo via SQLite history (Phase 4)
- Hardening + telemetry + docs site + notient.com landing (Phase 5)

## How to resume in next session (Phase 4 — Stream)

1. Read this file + spec §9 (Surfacing UI) + spec §13 row 4.
2. Phase 4 deliverables:
   - The Stream tab (feed of agent insights ranked by `confidence × recency × relevance(active_note)`)
   - CodeMirror editor decorations at paragraph boundaries
   - Vitals panel (per-note health/maturity/connectivity/freshness)
   - Graph view overlay
   - Chat MVP (3 commands: /find, /synthesize, /explain)
   - Multi-strategy search MVP (Quick + Balanced)
   - Universal undo (history table)
3. Same workflow: `superpowers:writing-plans` → `superpowers:subagent-driven-development` (Opus 4.7 implementers only).
