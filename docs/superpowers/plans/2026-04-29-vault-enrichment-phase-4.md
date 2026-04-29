# Notient Vault Enrichment — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex-based `nativeGraphBridge` with an AST-aware writeback module, populate the `daemon_write` provenance table on every approved write, delete the no-op `echoGuard` shim and its 25+ call sites, ship the awaken control plane (pause/resume/cancel/status), and introduce the per-vault TOML configuration file. Migrate the consumers that still read SQLite (`approvalService`, `historyService`, search) to SurrealDB so the daemon is fully on the new substrate.

**Architecture:** Three concurrent threads of work in this phase. (1) Markdown writeback: a single `src/core/markdown/writeback.ts` module replaces `nativeGraphBridge`, `relatedSection`, and `frontmatterWriter`. Both `applyApprovedLink` and `applyApprovedRelation` parse → mutate AST → stringify, with provenance recorded in `daemon_write` so Tier 1's wikilink reader can attribute the resulting wikilink to the agent that wrote it. The approval-and-write flow has documented failure semantics (see Locked Decision #3). (2) Awaken control plane: the `awaken_run` table from Phase 1's schema becomes the source of truth for an in-flight awaken. Pause/resume/cancel are writes to the row's `status` field that the worker subscribes to via `LIVE SELECT`. (3) Consumer DAL migration: `approvalService` writes `UPDATE supports SET approved = true` instead of moving a row from `staging_edges` to `graph_edges`. `historyService` and search consumers move to SurrealDB queries.

**Tech Stack:** unified/remark (already in Phase 2). SurrealDB live queries. Bun's `Bun.file` for atomic writes. `@iarna/toml` for parsing config (or `smol-toml` if smaller). No new substrate.

**Source of truth:**
- `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md` — §3.5 daemon_write + awaken_run, §8.4 AST writeback, §9 awaken control plane, §10 configuration.
- `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-2.md` — markdown pipeline must be live and round-trip-stable before writeback can use it.
- `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-3.md` — Tier 2/3 must write to SurrealDB before approval flow can promote.

**Locked decisions (Phase 4, 2026-04-29):**

1. **Single `src/core/markdown/writeback.ts` module replaces three.** Both `applyApprovedLink({ notePath, target, heading?, block? })` and `applyApprovedRelation({ notePath, key, target })` live in one file with a shared internal parse-mutate-stringify helper. `relatedSection.ts`, `frontmatterWriter.ts`, `nativeGraphBridge.ts` are deleted in the same phase; their consumers update imports.
2. **The writeback round-trips through the unified pipeline.** No string regex mutation. The `## Related` section becomes a list-of-wikilinks AST node; frontmatter relations land as YAML strings under `notient.<key>` arrays. Idempotent: applying the same approved edge twice is a no-op.
3. **Approval-and-write flow has documented failure semantics.** The flow involves four side-effects in this order: (1) UPDATE edge approved=true, (2) compute new file body via AST writeback, (3) atomic file write, (4) record history. Crashes between any two steps must not leave inconsistent state visible to consumers. The implementation MUST satisfy at least one of these contracts:

   - **Pending-state contract:** the edge starts as `approved=true, applied=false`. The writeback runs; only after history is recorded does `applied=true` flip. Consumers query `approved AND applied`. A reconciliation job clears stale `applied=false` rows on daemon start by re-running the writeback. OR
   - **Inverted-order contract:** compute the new body and write the file first (atomic + fsync), then UPDATE edge approved=true within a single SurrealDB transaction that also INSERTs the daemon_write and history rows. If the transaction fails, the file write is reverted by reading the previous content from history. (This contract requires the file's previous content to be in history, OR a tombstoned-content table.)

   The plan does not pick between contracts; the executing agent picks one and documents the choice in the writeback module's top-level comment. Either way, acceptance tests inject failures (kill the process, force the transaction to fail) at every step boundary and verify the system reaches a consistent state on recovery.
4. **EchoGuard shim is DELETED in this phase.** All 25+ consumer call sites (`echoGuard.mark(path, sha)`, `echoGuard.has(path, sha)`) are removed simultaneously. The replacement is implicit: Tier 1's wikilink reader cross-references `daemon_write` to attribute the wikilink's `source` field. Consumers that previously called `echoGuard.mark` now do nothing — the `daemon_write` insert in the writeback function covers it.
5. **Awaken control plane uses one row per run, never deleted.** `awaken_run` rows accumulate as a history log. The "current" run is identified by `status IN ('running','paused')`; at most one row matches at any time. `notient awaken --resume` finds the latest `paused` or `failed` row and updates it to `running`. `notient awaken --cancel` is destructive only of in-progress work; the row stays as `cancelled`.
6. **The awaken worker subscribes to the run's status via `LIVE SELECT`.** A single live query `LIVE SELECT status FROM $runId` notifies the worker of pause/cancel writes. The worker checks `status` between notes, not mid-note (mid-note pause would leave Tier 2/3 in inconsistent state).
7. **Pause is graceful, not forceful.** When the worker observes `status = 'paused'`, it finishes the current note's tier-3 if already started, then exits the work loop. SIGTERM on the daemon does the same: the worker notices the daemon is shutting down and writes `status = 'paused'` before exiting.
8. **Configuration file is per-vault, TOML, read once at daemon start.** `<vault>/.notient/config.toml`. No live-reload. Daemon restart picks up changes. Defaults from `concurrencyDefaults.ts` (Phase 3) override-able by the file.
9. **`notient init` writes a default config.toml** if one does not exist. Existing vaults already have `<vault>/.notient/`; the file is created on the first `notient awaken` if missing.
10. **Consumer migrations are split per file, one commit each.** `approvalService`, `historyService`, search consumers each get their own commit. Tests are migrated in the same commit as the consumer.
11. **Search consumers query SurrealDB's HNSW + full-text.** The vector search uses `<|K,EF|>`; full-text uses the `chunk_text` BM25 index defined in Phase 1's schema. Hybrid scoring (vector + BM25) is one SurrealQL with both predicates; the existing search-strategy code (quick/balanced/deep) keeps its public API but replaces SQL with SurrealQL.
12. **No new test scaffolding for migration.** Existing tests are updated to use the SurrealDB DAL (via the same fixture pattern from Phase 2/3 smokes). Tests that mocked the SQLite DB now mock the SurrealDB connection via the same fake pattern. No new mock framework.

---

## Hard rules (carry forward)

Same as prior phases. TS strict, no `any`, no abbreviations, no dash-clause prose, no emojis, one commit per logical step, kernel-only DAL slots.

---

## File structure

### Files created

| Path | Responsibility |
|---|---|
| `src/core/markdown/writeback.ts` | `applyApprovedLink`, `applyApprovedRelation`, both AST-round-trip |
| `src/core/markdown/writeback.test.ts` | Round-trip + idempotency on golden fixtures |
| `src/core/awaken/awakenRun.ts` | `createRun`, `findCurrent`, `updateStatus`, `subscribeToStatus` (live query helper) |
| `src/core/awaken/awakenRun.test.ts` | DAL tests against real SurrealDB |
| `src/core/awaken/awakenWorker.ts` | The actual run loop: walk vault, enqueue per tier, observe status changes |
| `src/core/awaken/awakenWorker.test.ts` | Smoke against fixture vault |
| `src/core/config/configFile.ts` | Read `<vault>/.notient/config.toml`, validate against TS schema, merge with defaults |
| `src/core/config/configFile.test.ts` | TOML parse + validation + default merging |
| `src/cli/commands/awakenStatus.ts` | `notient awaken --status` NDJSON tail |
| `src/cli/commands/awakenPause.ts` | `notient awaken --pause` writes `status='paused'` |
| `src/cli/commands/awakenResume.ts` | `notient awaken --resume` finds the latest non-completed run, updates status to `running` |
| `src/cli/commands/awakenCancel.ts` | `notient awaken --cancel` writes `status='cancelled'` |

### Files modified

| Path | Change |
|---|---|
| `src/core/db/surreal.ts` | Add `recordDaemonWrite`, `findRecentDaemonWrite`, awaken DAL helpers |
| `src/core/indexer/tier1.ts` | Cross-reference `daemon_write` when classifying wikilink edges; assign `source = '<agent>'` if the edge was just written by us |
| `src/core/approvals/approvalService.ts` | UPDATE row `approved = true` (was: move staging row to live table) |
| `src/core/approvals/approvalService.test.ts` | Migrate to SurrealDB |
| `src/core/history/historyService.ts` | Read/write `history` table via SurrealDB DAL |
| `src/core/history/historyService.test.ts` | Migrate |
| `src/core/history/inverters/noteCreate.ts`, `noteAppendSection.ts`, `noteFrontmatter.ts`, `noteMaturity.ts` | Each rewritten to operate on SurrealDB rows |
| `src/core/search/searchPipeline.ts`, `strategies/quick.ts`, `strategies/balanced.ts`, `strategies/deep.ts` | SurrealQL kNN + BM25 instead of sql.js + HNSW |
| `src/core/search/graphExpansion.ts` | Recursive `note.{..1}->wikilink->note` instead of recursive CTE |
| `src/cli/commands/awaken.ts` | Become the entry point that dispatches `--pause`/`--resume`/`--cancel`/`--status` to their handlers |
| `src/daemon/handlers/*.ts` | The five Phase D1 handlers (`agentAsk`, `agentBrief`, `agentDistill`, `agentEvents`, `session`) — DAL only, surface unchanged |
| All ~25 consumer files calling `echoGuard.mark` / `.has` | Remove the calls (no replacement) |

### Files deleted

- `src/core/services/echoGuard.ts` (the no-op shim from Phase 1)
- `src/core/graph/nativeGraphBridge.ts`
- `src/core/graph/nativeGraphBridge.test.ts`
- `src/core/graph/relatedSection.ts`
- `src/core/graph/relatedSection.test.ts`
- `src/core/graph/frontmatterWriter.ts`
- `src/core/graph/frontmatterWriter.test.ts`
- `src/core/history/inverters/edgeApprove.ts`, `edgeReject.ts`, `nodeApprove.ts`, `nodeReject.ts` (replaced by direct UPDATE/DELETE in `approvalService`)

### Files NOT touched (deferred to Phase 5)

- `src/core/db/database.ts`, `schema.ts`, `migrations.ts` — final SQLite cutover.
- `src/core/graph/graphStore.ts` — last consumer migrates in Phase 5; the file disappears with sql.js.

---

## Tasks

### Task 1: AST writeback module — `applyApprovedLink` and `applyApprovedRelation`

**Files:**
- Create: `src/core/markdown/writeback.ts`
- Create: `src/core/markdown/writeback.test.ts`
- Create: `src/core/markdown/__fixtures__/writeback-input.md`

**Objective:** Implement a single writeback module exposing `applyApprovedLink(source, { target, heading?, block? })` and `applyApprovedRelation(source, { key, target })`. Both round-trip through the unified/remark pipeline (no regex mutation): parse → mutate AST → stringify. Links land as list items under `## Related` (creating the section if absent); relations land as YAML wikilink strings under `frontmatter.notient.<key>` (creating frontmatter if absent).

**Invariants:**
- The writeback round-trip is byte-deterministic for a given AST input. Applying the same approved edge twice MUST be a no-op (returns the input string unchanged).
- The functions are pure: input string in, output string in. They do not touch the filesystem and do not record provenance — those are the caller's responsibility (see Task 3 and Locked Decision #3).
- Wikilink formatting follows: `[[target]]`, `[[target#heading]]`, or `[[target#^block]]` depending on which optional qualifier is set.

**Acceptance:** Tests in `writeback.test.ts` cover (a) appending under existing `## Related`, (b) creating `## Related` when absent, (c) idempotency for both functions, (d) heading and block qualifier formatting, (e) merging into existing `notient.<key>` frontmatter array, (f) creating frontmatter from scratch. All tests green via `bun test src/core/markdown/writeback.test.ts`. Commit as one logical unit.

---

### Task 2: `daemon_write` DAL + Tier 1 cross-reference

**Files:**
- Modify: `src/core/db/surreal.ts`
- Modify: `src/core/indexer/tier1.ts`
- Modify: `src/core/indexer/tier1.test.ts`

**Objective:** Add two DAL helpers to `surreal.ts`: `recordDaemonWrite({ noteId, sha, agent, targets })` returns the new row's id; `findRecentDaemonWrite({ noteId, sha, withinSeconds? })` returns `{ agent, targets } | null` for the most recent row matching the (note, sha) pair within the window (default 5s). Update `runTier1` so that, after upserting the note row, it queries `findRecentDaemonWrite` for the current body sha and uses the returned `agent`/`targets` to override the `source` field on matching wikilink edges (otherwise `source = 'wikilink' | 'embed'`).

**Invariants:**
- `daemon_write` rows are immutable once inserted; they are the audit trail.
- The 5-second window in `findRecentDaemonWrite` tolerates the race between the writeback's atomic file write and the filesystem watcher firing a re-index.
- Tier 1 only overrides `source` when both the SHA and the target id match a recent row. A SHA collision alone is not sufficient.

**Acceptance:** Unit tests cover `recordDaemonWrite` returning a typed `RecordId<"daemon_write">`, `findRecentDaemonWrite` filtering by the time window, and Tier 1 attributing `source = '<agent>'` (e.g. `'linker'`) when the daemon wrote the wikilink in the last 5s versus `source = 'wikilink'` when no match. `bun test src/core/db/surreal.test.ts src/core/indexer/tier1.test.ts` green. One commit.

---

### Task 3: Migrate `approvalService` to SurrealDB with documented failure semantics

**Files:**
- Modify: `src/core/approvals/approvalService.ts`
- Modify: `src/core/approvals/approvalService.test.ts`
- Delete: `src/core/history/inverters/edgeApprove.ts`
- Delete: `src/core/history/inverters/edgeReject.ts`
- Delete: `src/core/history/inverters/nodeApprove.ts`
- Delete: `src/core/history/inverters/nodeReject.ts`
- Modify: `src/core/history/inverters/index.ts` (drop deleted entries)

**Objective:** Replace the SQLite-based staging-promotion path with direct SurrealDB writes. `approveEdge(edgeRecord, edgeTable)` resolves the source/target paths from the edge row, calls `applyApprovedLink` or `applyApprovedRelation` (per `edgeTable`), records `daemon_write`, writes the file, and records history — all subject to the chosen failure-semantics contract from Locked Decision #3. `rejectEdge(edgeRecord, edgeTable)` simply deletes the row. The four deleted inverters are replaced by direct UPDATE/DELETE in this service.

**Invariants:**
- `daemon_write` rows are inserted as part of the same atomic boundary as the file write — see Locked Decision #3 for the chosen contract.
- The chosen contract (pending-state or inverted-order) is named in the writeback module's top-level comment so the executing agent's choice is discoverable from code.
- A no-op writeback (idempotent re-application) MUST NOT insert a duplicate `daemon_write` row and MUST NOT record an empty history entry.
- `rejectEdge` is total: deleting an already-deleted edge is not an error.

**Acceptance:**
- Unit tests cover the happy path (approve → file mutated → daemon_write present → history present) and the reject path.
- **Failure-injection tests cover at least three scenarios: crash between edge UPDATE and file write; crash between file write and history INSERT; crash between history INSERT and the consumer reading the result. After each crash, daemon restart must result in consistent state (no `approved` rows without applied writeback, no orphan `daemon_write` rows, no file-vs-history divergence).**
- **The chosen contract (pending-state or inverted-order) is named in the writeback module's top-level comment.**
- The four removed inverters are unreferenced (`grep -rn "edgeApprove\|edgeReject\|nodeApprove\|nodeReject" src/` returns empty).
- `bun test src/core/approvals/` green. One commit.

---

### Task 4: Migrate `historyService` to SurrealDB

**Files:**
- Modify: `src/core/history/historyService.ts`, `historyService.test.ts`
- Modify: `src/core/history/inverters/noteCreate.ts`, `noteAppendSection.ts`, `noteFrontmatter.ts`, `noteMaturity.ts`
- Modify: corresponding `.test.ts` files

**Objective:** Replace SQLite queries in `historyService` with SurrealDB queries against the `history` table (already in `schema.surql` from Phase 1). Public API stays the same: `record(input)`, `getRecent(limit)`, `undoLast()`. The four remaining inverters get DAL-only updates: their `before`/`after` body is applied through the markdown facade (unchanged) and the SurrealDB `note` row's `sha` field is updated to match the new body.

**Invariants:**
- The `history` row's `kind`, `target`, `before`, `after`, `client_identity`, and `created_at` semantics are unchanged from the SQLite version. Only the storage backend changes.
- `undoLast()` is atomic: either the inverter applies cleanly and the history row is consumed, or nothing happens.

**Acceptance:** All existing `historyService` and inverter tests pass after migration to SurrealDB fakes, with no test-shape changes beyond the DAL swap. `bun test src/core/history/` green. One commit.

---

### Task 5: Delete `nativeGraphBridge`, `relatedSection`, `frontmatterWriter`

**Files:**
- Delete: `src/core/graph/nativeGraphBridge.ts`, `nativeGraphBridge.test.ts`
- Delete: `src/core/graph/relatedSection.ts`, `relatedSection.test.ts`
- Delete: `src/core/graph/frontmatterWriter.ts`, `frontmatterWriter.test.ts`
- Modify: importing files (e.g. `chatStream.ts`, `bootstrap.ts`, `synthesis.ts`)

**Objective:** Remove the three legacy modules and update all importers to call the new `markdown/writeback.ts` functions directly. Importers that currently wrap the bridge in their own logic move to invoking `applyApprovedLink` / `applyApprovedRelation` and handling the file write inline (or via the approvalService for approved edges).

**Invariants:**
- After this task, `grep -rln "nativeGraphBridge\|relatedSection\|frontmatterWriter" src/` returns empty.
- No regression in the existing approval-write tests (covered by Task 3's tests, which exercise the writeback functions end-to-end).

**Acceptance:** Full `bun test` green. The three modules and their tests are gone. Importers compile against the new writeback module. One commit.

---

### Task 6: Delete the `echoGuard` shim and all consumer call sites

**Files:**
- Delete: `src/core/services/echoGuard.ts`
- Modify: ~25 consumer files (mechanical removals)

**Objective:** Remove the `echoGuard` shim and every `echoGuard.mark(...)` / `echoGuard.has(...)` invocation across the codebase, plus any constructor-injection plumbing and the kernel registration. The replacement (Tier 1 cross-referencing `daemon_write`) is already in place from Task 2.

**Invariants:**
- After this task, `grep -rln "echoGuard\|EchoGuard" src/` returns empty.
- No behavioral regression: callers that previously marked a SHA simply do nothing now; callers that previously checked `echoGuard.has` are removed entirely (the check moved into Tier 1's `daemon_write` lookup).

**Acceptance:** Full `bun test` green. The shim file and all 25+ call sites are gone. One commit.

---

### Task 7: Awaken DAL + run state machine

**Files:**
- Create: `src/core/awaken/awakenRun.ts`
- Create: `src/core/awaken/awakenRun.test.ts`

**Objective:** Implement the `awaken_run` DAL: `createRun({ tierFilter, priorityGlobs, total })`, `findCurrent()` (status in running|paused), `findLatestResumable()` (status in paused|failed), `updateStatus(runId, status, extra?)` (sets `finished_at` on terminal states), and `subscribeToStatus(runId, onChange)` returning a `StatusSubscription` with a `close()` method. The status type is `"running" | "paused" | "cancelled" | "completed" | "failed"`.

**Invariants:**
- At most one row matches `status IN ('running','paused')` at any time. The CLI commands enforce this by refusing to start a fresh run when one is active.
- `awaken_run` rows are append-only history; never deleted, only updated.
- `subscribeToStatus` filters live-query notifications to the specific `runId`; other rows' updates are ignored.

**Acceptance:** Unit tests cover create returning a typed id, `findCurrent` returning null when empty, `findLatestResumable` returning the right row, `updateStatus` advancing state and stamping `finished_at` on terminal transitions. Live-query behavior is covered by Task 8's worker smoke. `bun test src/core/awaken/awakenRun.test.ts` green. One commit.

---

### Task 8: Awaken worker

**Files:**
- Create: `src/core/awaken/awakenWorker.ts`
- Create: `src/core/awaken/awakenWorker.test.ts`

**Objective:** Implement `runAwakenWorker({ db, vaultFacade, indexerQueue, tierFilter, priorityGlobs, resume })` that either creates a new run or resumes the latest resumable one, walks the vault sorted by priority globs, enqueues each path into the indexer queue, awaits per-path completion, checkpoints `processed`/`failed`/`cursor` every 10 notes, and respects pause/cancel via the live-query subscription.

**Invariants:**
- **Awaken worker checks status between notes, never mid-note (mid-note pause leaves Tier 2/3 inconsistent).**
- On `paused` or `cancelled` observation between notes, the worker breaks the loop, persists the final `processed`/`failed` counters, and closes the live subscription cleanly in a `finally`.
- On natural completion, terminal status is `completed`. The worker does not overwrite a `paused`/`cancelled` status with `completed` if the user paused mid-flight.

**Acceptance:** Smoke test against a fixture vault with a mocked indexer queue exercises pause-mid-flight, resume-from-paused, and cancel transitions; asserts the row's status, processed counter, and cursor reflect the observed transitions. `bun test src/core/awaken/awakenWorker.test.ts` green. One commit.

---

### Task 9: CLI commands for awaken control

**Files:**
- Create: `src/cli/commands/awakenStatus.ts`, `awakenPause.ts`, `awakenResume.ts`, `awakenCancel.ts`
- Modify: `src/cli/commands/awaken.ts` (dispatch on flags)
- Modify: `src/cli/index.ts` (wire dispatcher)

**Objective:** Each of the four control commands is a thin client over the awaken DAL: `--pause` calls `findCurrent` + `updateStatus(paused)`; `--resume` calls `findLatestResumable` + dispatches into `runAwakenWorker({ resume: true })`; `--cancel` calls `findCurrent` + `updateStatus(cancelled)`; `--status` polls the run row at 1Hz and emits NDJSON until the status reaches a terminal state. `awaken.ts` dispatches on the flag set; default (no flag) starts a fresh run.

**Invariants:**
- `--pause` and `--cancel` are no-ops with exit code 1 and a stderr message when no current run exists. Process never crashes on missing rows.
- `--status` exits 0 on terminal status, never blocks indefinitely if the daemon is gone (a connect failure is a clear exit code).
- The CLI never invokes the worker loop directly for `--pause`/`--resume`/`--cancel`/`--status`; only the default `awaken` invocation runs the loop.

**Acceptance:** Manual smoke `bun run src/cli/index.ts awaken --status` against a running daemon emits NDJSON status lines. Pause/resume cycle is exercised by the Task 13 smoke harness. One commit.

---

### Task 10: Per-vault TOML config

**Files:**
- Create: `src/core/config/configFile.ts`
- Create: `src/core/config/configFile.test.ts`
- Add dep: `smol-toml` (or `@iarna/toml`)
- Modify: `src/daemon/bootstrap.ts`, `src/cli/commands/init.ts`, plus consumers of `concurrencyDefaults` in `src/core/indexer/`

**Objective:** Implement `loadVaultConfig(vaultPath): VaultConfig` that reads `<vault>/.notient/config.toml`, parses with `smol-toml`, and deep-merges over the defaults sourced from `concurrencyDefaults.ts`. The schema covers `indexer` (debounce, concurrency, chunk sizing), `awaken` (default tier filter and priority globs), and `surrealdb` (HNSW cache MiB, log level). Bootstrap reads the config once and threads values into the indexer queue, embedder, awaken worker, and the `surreal start` env.

**Invariants:**
- No live reload. Daemon restart picks up changes. This is a deliberate simplicity choice.
- Missing file falls back to defaults silently. Malformed TOML logs a warning and falls back to defaults; it does not crash boot.
- `notient init` writes a default `config.toml` only if one does not exist; existing files are never overwritten.

**Acceptance:** Tests cover the missing-file fallback, the malformed-TOML fallback, and the deep merge (overriding one nested field leaves siblings at default). Bootstrap smoke verifies overrides take effect (e.g. setting `indexer.concurrency.embed = 1` and observing the embedder's parallelism). `bun test src/core/config/` green. One commit.

---

### Task 11: Migrate search consumers to SurrealDB

**Files:**
- Modify: `src/core/search/searchPipeline.ts`, `src/core/search/strategies/{quick,balanced,deep}.ts`, `src/core/search/graphExpansion.ts`, `src/core/search/filters.ts`, `src/core/search/synthesis.ts`
- Modify: corresponding `.test.ts` files

**Objective:** Replace `hnswVectorIndex.search(...)` + sql.js follow-ups in the strategy files with single SurrealQL queries: kNN via `vector <|K,EF|> $q`, BM25 via the `chunk_text` index, hybrid scoring (deep strategy) in one query with both predicates. Replace `graphExpansion`'s recursive CTE with recursive SurrealQL traversal (`note.{..1}->wikilink->note`). Public APIs of the strategies stay intact.

**Invariants:**
- Result shape per strategy is unchanged so downstream synthesis does not need to migrate.
- Filters (date ranges, tag filters) compose as additional WHERE predicates inside the same query rather than as a Node-side filter pass.

**Acceptance:** All existing search tests pass against the SurrealDB-backed strategies. `bun test src/core/search/` green. May be split into 2-3 commits if the change spans many files.

---

### Task 12: Migrate Phase D1 handlers' DAL

**Files:**
- Modify: `src/daemon/handlers/agentAsk.ts`, `agentBrief.ts`, `agentDistill.ts`, `agentEvents.ts`, `session.ts`, `sessionGrant.ts`, `sessionList.ts`, `sessionRevoke.ts`
- Modify: corresponding tests

**Objective:** Swap each handler's SQLite DAL calls for SurrealDB equivalents against `agent_event`, `agent_session`, `agent_run` (already present in `schema.surql`). RPC shapes are unchanged; only the queries inside each handler change.

**Invariants:**
- No RPC contract change. Phase D1 smoke tests pass without modification.
- Pagination, filtering, and ordering behavior of each handler is preserved exactly.

**Acceptance:** `bun test src/daemon/handlers/` green; the Phase D1 smoke (`bun run smoke:cli:phaseD` if present, otherwise its equivalent) green. One commit per handler family or one big commit if changes are mechanical.

---

### Task 13: Phase 4 smoke harness

**Files:**
- Create: `src/daemon/__smoke__/phase4.smoke.test.ts`

**Objective:** End-to-end smoke that exercises the awaken control plane, AST writeback, daemon_write provenance, and the failure-semantics contract from Locked Decision #3.

The smoke must (1) start a fresh awaken run, (2) pause mid-flight via a separate `awaken --pause` CLI invocation and assert `status='paused'` with `processed > 0`, (3) resume via `awaken --resume` and assert the run reaches `completed`, (4) approve a linker proposal via the approval service, (5) read the source note and assert the new wikilink lands in `## Related`, (6) read `daemon_write` and assert a row exists with the right SHA, agent, and targets, (7) save the note again to simulate a user save and assert Tier 1 attributes the wikilink with `source = 'linker'` because of the `daemon_write` match.

**Invariants:**
- The smoke runs against a real SurrealDB instance (the same fixture pattern from Phase 2/3 smokes), not a mock.
- The smoke is hermetic: each run uses a fresh fixture vault and a fresh DB.

**Acceptance:** `bun test src/daemon/__smoke__/phase4.smoke.test.ts` green. One commit.

---

### Task 14: Phase 4 handoff doc

**Files:**
- Create: `docs/superpowers/handoffs/2026-04-29-phase-4-vault-enrichment-handoff.md`

**Objective:** Write a handoff under 80 lines documenting what shipped: AST writeback, daemon_write provenance, echoGuard removal, awaken control plane, search migration, Phase D1 verbs on new schema, config file. Name the chosen failure-semantics contract (pending-state or inverted-order) so Phase 5 inherits the constraint. Phase 5 entry point: new CLI verbs (graph dump/stats, links sync/audit, backup/restore/nuke, migrate-vault), final SQLite cutover (delete `database.ts`, `schema.ts`, `migrations.ts`, `hnswVectorIndex.ts`, `graphStore.ts`; remove sql.js dep).

**Invariants:**
- The chosen failure-semantics contract is named explicitly. Phase 5 must not silently flip contracts.

**Acceptance:** File exists, under 80 lines, names the chosen contract. One commit.

---

## Self-review

**Spec coverage:** §3.5 daemon_write + awaken_run (Tasks 2, 7), §8.4 AST writeback (Task 1), §9 awaken control plane (Tasks 7, 8, 9), §10 configuration (Task 10). Consumer migrations (Tasks 3, 4, 11, 12). EchoGuard removal (Task 6). Failure semantics for the approval flow encoded in Locked Decision #3 and exercised in Task 3's acceptance and Task 13's smoke.

**Type consistency:** `applyApprovedLink` / `applyApprovedRelation` return strings consumed by the approvalService write path (Task 3). `daemon_write` row structure consistent across `recordDaemonWrite` (Task 2) and `findRecentDaemonWrite` (Task 2 / Tier 1). `AwakenStatus` enum consistent across DAL (Task 7), worker (Task 8), and CLI (Task 9).

**Known transient state during phase:** Between Tasks 3 and 5, `nativeGraphBridge` is unused but not yet deleted. This is one-commit-distance, so the executor merges Tasks 3-5 into a contiguous PR.

---

## Execution

Phase 4 plan complete and saved to `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-4.md`. Execute via `superpowers:subagent-driven-development` after Phase 3 ships green.
