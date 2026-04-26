# Notient v1.0 Project State

**Current phase:** Phase 1 (Foundation) — COMPLETE
**Tag:** `v1.0.0-foundation` on `beta-spec` (merge commit `881928b`)
**Date completed:** 2026-04-25
**Next phase:** Phase 2 (Graph)
**AI substrate:** dynamo (`192.168.86.143:1234`, LM Studio, primary) + mini (`192.168.86.141:8080`, llama-server, deep)
**Test vault:** `/mnt/c/Users/akougk/Projects/vaultex/` (894 markdown notes in PARA structure)

## Reviewer status (post-merge, before user smoke)

- **Spec compliance:** ✅ APPROVED. All 14 plan tasks implemented to spec; 38/38 tests pass; tag at merge commit.
- **Code quality:** ✅ APPROVED WITH CONCERNS. Five items to fix at the start of Phase 2 (see "Tech debt" below).

## What works (verified by 38 unit tests + first interactive load)

- Plugin scaffold + manifest 1.0.0-foundation + build pipeline
- Typed event bus with handler-error isolation
- Settings service + Obsidian SettingsTab (defaults point at dynamo + mini)
- Atomic writes (Windows EPERM/EBUSY retry)
- Vault lock (single-instance, stale-takeover, heartbeat)
- SQLite database + v1 schema (notes, chunks, embeddings, graph_nodes, graph_edges, history, schema_version)
- Graph store CRUD with typed nodes/edges (10 edge types per spec §4.2)
- Frontmatter writer with Notient-block round-trip
- ObsidianFacade wrapping vault.adapter via atomic writes
- LMStudioProvider (OpenAI-compatible: chat / chatStream SSE / embed / isAvailable)
- Health monitor (periodic probe, emits llm:health events)
- Kernel + DI with fail-loud seal (Phase Galaxy regression structurally impossible)
- Sidebar shell + status footer (ribbon icon `brain-circuit`)
- on-save SHA → notes table

## Known runtime issues (from first interactive load)

- **First-load migration crash on reload-over-old-state:** When a stale `notient.db` is on disk (from a prior plugin version or wipe race), `applyMigrations` may throw "no such column: updated_at" because `CREATE TABLE IF NOT EXISTS` is a no-op against the old schema. Workaround: delete `.obsidian/plugins/notient/notient.db` and reload. Real fix in Phase 2: detect schema mismatch and either migrate or reset, with user-visible Notice. **NOT a bug on clean installs.**

## Tech debt to fix at the start of Phase 2 (from code reviewer)

1. **YAML parser will eat user data.** `frontmatterWriter.parseYaml` silently corrupts arrays (`tags`, `aliases`). Switch to Obsidian's built-in `parseYaml` from the API, OR make the writer merge-only (preserve original frontmatter string verbatim, only inject the `notient:` block).
2. **Add `Database.transaction(fn)` helper.** Phase 2's chunker/extractor will batch-write nodes + edges per note. No transactions = partial graph on failure.
3. **Echo guard on `vault.modify` handler.** When Phase 3 agents call `facade.write`, the modify event will fire — currently re-hashes and re-emits, risking infinite loops. Add a "writes-by-us" path+sha set the handler skips.
4. **Health probe timeout.** `LLMProvider.isAvailable()` has no AbortSignal; a hung dynamo will stack probes. Pass a `setTimeout(intervalMs / 2)` AbortController.
5. **`LLMProvider.chatJson<T>(messages, schema, opts)` interface addition.** Phase 3 agents need structured output. Adding it now (even as `unknown`-typed) is cheap; retrofitting after agents exist is painful.

## Lower-priority debt (address opportunistically)

- `atomicWrite` is process-crash-safe, NOT OS-crash-safe (no fsync available via Obsidian DataAdapter). Update comments to reflect.
- `Database.persist()` is called after every save — will thrash with large graphs. Add debounced batch persist in Phase 2.
- `GraphStore.edgesByType` lacks `limit/offset`. Add before corpus grows.
- `HealthMonitor` event payload should widen: `{ ok, latencyMs, modelId?, contextLength? }`.
- `Kernel` lacks `startAll()/stopAll()` lifecycle methods — `main.ts` will balloon as services accumulate.
- `data:` URL handling in build script doesn't deploy `sql-wasm.wasm` to plugin dir on clean install (currently inherited from old build).
- Banned `[noun] - [parenthetical]` prose pattern: monitor commit messages and code comments going forward.

## What does not exist yet

- Chunker, embedder, entity/claim/question extractor (Phase 2)
- HNSW vector index + persistence (Phase 2)
- Awaken Vault onboarding modal with live graph visualization (Phase 2)
- Coordinator + 4 agents: Linker / Synthesizer / Contradiction Hunter / Maturity Advancer (Phase 3)
- Continuous Co-author panel (Phase 3)
- Stream feed + editor decorations + Vitals panel + Graph view overlay (Phase 4)
- Chat MVP (Phase 4)
- Multi-strategy search (Quick + Balanced) (Phase 4)
- Trust gate UI / approvals UI / universal undo (Phase 4)
- Hardening + telemetry + docs site + notient.com landing (Phase 5)

## Files of note

- Spec: `docs/superpowers/specs/2026-04-25-notient-v1-design.md` (505 lines, 17 sections)
- Phase 1 plan: `docs/superpowers/plans/2026-04-25-phase-1-foundation.md` (14 tasks)
- Phase 1 source: all of `src/` (32 files)
- Legacy reference: `docs/_legacy/` (v0.1 Galaxy, v0.3 Helios, all phase docs) — DO NOT IMPORT
- Project conventions: `.claude/CLAUDE.md` and `~/.claude/CLAUDE.md`
- Worktree role config: `.claude/agents/dispatch.py`, `.claude/agents/git-prepare.sh`

## How to resume in next session

1. Read this file + spec §13 row 2 (Phase 2 Graph)
2. Address the 5 tech-debt items above as Phase 2 Task 0 (debt cleanup) before adding new features
3. Invoke `superpowers:writing-plans` to draft the full Phase 2 plan
4. Phase 2 deliverables (per spec §13): senses pipeline (chunker, embedder, extractor, HNSW vector index) + Awaken Vault onboarding modal that animates 894 notes lighting up over 3-5 minutes
5. Use `superpowers:subagent-driven-development` with Opus 4.7 implementer subagents in `_worktrees/notient-implementer/` (reset via `.claude/agents/git-prepare.sh implementer implementer/p2-graph beta-spec`)
6. Reviewer subagents are optional per current preference — user prefers fast implementation rounds, defer review/quality passes for batched optimization sessions
