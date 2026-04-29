# Notient Vault Enrichment — Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Each task lands in one commit. Conventional Commits, no `git add -A`, stage files by name.

**Goal:** Ship the final cutover. Every consumer that still talks to sql.js migrates to SurrealDB or is stripped from production wiring. The SQLite substrate (`database.ts`, `migrations.ts`, `schema.ts`, `graphStore.ts`, the orphan `vectorIndex.ts`) and the `sql.js` / `@types/sql.js` dependencies are deleted. Ten new CLI verbs land (`graph dump`, `graph stats`, `links sync`, `links audit`, `backup`, `restore`, `nuke`, `migrate-vault`, `awaken --tier`, `reindex --tier`). The `daemon_write` SHA producer is fixed so Tier 1 attribution fires in production without the Phase 4 smoke's hash shim. `ApprovalService` is registered on the kernel and replays in-flight writebacks on boot. The orphan `NotientSettings.nativeGraph` field is removed. Once Phase 5 lands, the redesign is done.

**Architecture:** The phase sequences three threads of work, ordered by dependency:

1. **Substrate-blocking fixes (Tasks 1-2).** The SHA-alignment fix has to land before any other end-to-end behaviour shifts because Tier 1 attribution depends on it; ApprovalService kernel registration depends on the SHA fix because the boot-time reconciliation pass must produce the same SHA the watcher will compute. Both ship before any consumer migration so subsequent tasks inherit a wired-correctly approval flow.

2. **SQLite consumer migrations (Tasks 3-8).** Coordinator (`agent_runs`), `agentBrief` (`graph_nodes`, `notes.updated_at`), `VitalsService` + `MaturityAdvancer` (`notes`, `chunks`, `graph_edges`), and the chat/agent tooling surface (`ContextManager`, `buildAgentToolRegistry`, the `chat/tools/*` consumers) each migrate in their own commit. `Synthesizer` and `ContradictionHunter` are stripped from production wiring because their SQLite source has been frozen since Phase 3 and no SurrealDB replacement query is in scope; the Coordinator agent map keeps the existing no-op fallback shape. The orphan `nativeGraph` settings field is removed.

3. **CLI verbs and substrate deletion (Tasks 9-13).** With every consumer off SQLite, the four file-deletion sets (`db/`, `graph/`, `indexer/vectorIndex.ts`, the `sql.js` / `@types/sql.js` dependency entries) land in one substrate-delete commit. The new CLI verbs are bundled into three commits by domain (graph + links read verbs, backup family, awaken/reindex tier filters). Phase 5 closes with the smoke harness and the handoff doc.

**Tech Stack:** SurrealDB 3.0.5 server mode (already supervised). `surreal export` and `surreal import` via `Bun.spawn` for backup/restore. unified/remark pipeline (already in Phase 2). No new substrate. No new dependencies.

**Source of truth:**
- `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md` §11.1 (new CLI verbs), §12 (files-to-delete punch list), §15 (phase plan).
- `docs/superpowers/handoffs/2026-04-29-phase-4-vault-enrichment-handoff.md` (carry-forward gaps, the daemon_write SHA-alignment note, the ApprovalService kernel-registration gap, the Coordinator + agentBrief migration carryovers).
- `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-{1..4}.md` — read section headings only; this plan is self-contained for executing tasks.

---

## Locked decisions (Phase 5, 2026-04-29)

These contracts are non-negotiable for Phase 5 execution. Tasks must not relitigate them; they are the constants the implementer subagents work against.

1. **PENDING-STATE failure-semantics for the approval flow stays.** Phase 4 Locked Decision 3 chose pending-state. Edges carry `approved` and `applied` bools; writeback is idempotent; reconciliation re-runs from `approved=true AND applied=false` on boot. Phase 5 must not flip to inverted-order. The contract is documented at the top of `src/core/markdown/writeback.ts`.

2. **All edges live in actual edge tables with `approved`/`applied` provenance fields.** No staging_edges table. No staging_node table. The only ancillary unresolved-target tables are `wikilink_unresolved` and `embed_unresolved`, both `TYPE NORMAL` and `SCHEMAFULL` (Phase 2 closeout).

3. **`daemon_write` rows are immutable; insert-only audit.** Provenance flows through them via `findRecentDaemonWrite`. The 5-second window in the lookup tolerates clock skew between writer and watcher. Task 1 changes only the SHA producer, not the table semantics.

4. **The awaken worker checks status BETWEEN notes only, never mid-note.** Pause is graceful; SIGTERM does the same. Mid-note pause leaves Tier 2/3 in inconsistent state.

5. **`<vault>/.notient/config.toml` is read once at daemon start.** No live reload. Daemon restart picks up changes. `notient init` writes a default file if absent.

6. **SurrealDB server mode only.** No embedded SDK. `surreal start` runs as a supervised child process on `127.0.0.1:<port>`, and the bound port is written to `~/.notient/<vault-id>/surreal.port`.

7. **Edge provenance fields are generated at runtime via `edgeTables.ts::provenanceFields()`.** `schema.surql` is partially generated; do not inline provenance blocks per table. The `EDGE_TABLES` list is the single source of truth.

8. **Tier 1 cleanup filters by `class = 'EXTRACTED'`, not by source allowlist.** `source` can be overridden to `<agent>` (e.g. `'linker'`) by the `daemon_write` cross-reference. Re-running Tier 1 on overridden edges must not orphan them.

9. **All `option<...>` fields: omit on undefined; never null.** SurrealDB 3.0.5 SCHEMAFULL hard-rejects unknown fields and rejects null on `option<>`. Every DAL writer respects the CONTENT-build conditional pattern.

10. **`INFO FOR DB` table count is 30 entering Phase 5.** Tasks that add or remove tables must update the Phase 1 / Phase 4 / Phase 5 smoke assertions in lockstep. Phase 5 does not change the count: no SurrealDB tables are added or removed. (Task 5 may add fields to the existing `note` table for vitals storage; field additions do not change the table count.)

11. **`Synthesizer` and `ContradictionHunter` are stripped from production wiring, not migrated.** Both have read frozen/empty SQLite state since Phase 3. The Coordinator's `agents` map keeps the existing no-op fallback shape so the swarm dispatch loop runs unchanged for the remaining two agents (`linker`, `maturityAdvancer`). Restoring either is a future feature task, not a Phase 5 obligation.

12. **One commit per logical task; stage files by name.** Conventional Commits prefix matches existing history (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`). Never `git add -A`.

---

## Hard rules (carry forward)

TS strict, no `any` without inline justification. No identifier abbreviations: `context` not `ctx`, `error` not `err`, `vector` not `vec`, `chunk` not `ch`, `index` not `idx`, `database` not `db` in product surfaces (the `db` shorthand for the SurrealDB connection variable is fine internally). No `[noun] - [parenthetical clause]` dash-clause prose anywhere. No emojis. Kernel is the only place new DAL slots get registered. No mocks beyond `src/core/__fakes__/`.

Verification gates per task: `bun run typecheck` clean. `bun test` holding 838 pass / 254 skip / 0 fail across 136 files at the entering baseline (the pass count moves as tests migrate to smoke-gated SurrealDB harnesses; verify net coverage does not regress). `NOTIENT_SMOKE=1 bun run test:smoke` holding 17 pass / 0 fail entering Phase 5 and ending higher (Phase 5 adds one smoke file). Lint must show no NEW errors attributable to the change; the repo carries pre-existing warnings that are not Phase 5's job.

---

## File structure

### Files created

| Path | Responsibility |
|---|---|
| `src/cli/commands/graphDump.ts` | `notient graph dump [--tier 1\|2\|3] [--format json\|graphml\|cypher]` |
| `src/cli/commands/graphStats.ts` | `notient graph stats` per-table per-source counts |
| `src/cli/commands/linksSync.ts` | `notient links sync` — CLI handle to `reconcilePendingApplications()` |
| `src/cli/commands/linksAudit.ts` | `notient links audit` — NDJSON unresolved/dangling/orphan report |
| `src/cli/commands/backup.ts` | `notient backup [--out <path>]` shells out to `surreal export` |
| `src/cli/commands/restore.ts` | `notient restore <path>` shells out to `surreal import`; refuses on non-empty DB |
| `src/cli/commands/nuke.ts` | `notient nuke [--yes]` stops daemon, deletes data dir, restarts |
| `src/cli/commands/migrateVault.ts` | `notient migrate-vault <new-absolute-path>` backup → stop → re-id → start → restore |
| `src/cli/commands/graphDump.test.ts`, `graphStats.test.ts`, `linksSync.test.ts`, `linksAudit.test.ts`, `backup.test.ts`, `restore.test.ts`, `nuke.test.ts`, `migrateVault.test.ts` | Per-command unit tests |
| `src/daemon/__smoke__/phase5.smoke.test.ts` | Phase 5 end-to-end smoke covering Tasks 9-12 |
| `docs/superpowers/handoffs/2026-04-29-phase-5-vault-enrichment-handoff.md` | Phase 5 handoff (under 80 lines) |

### Files modified

| Path | Change |
|---|---|
| `src/core/indexer/tier1.ts` | Compute and persist FILE body SHA (raw file body, not joined-block text) into `note.sha` and the SHA the daemon_write cross-reference matches against |
| `src/core/approvals/approvalService.ts` | Compute `daemon_write.sha` as the FILE body SHA via `crypto.subtle.digest("SHA-256", afterBody)` so producer agreement holds without a smoke shim |
| `src/daemon/__smoke__/phase4.smoke.test.ts` | Drop the `ApprovalService.hash` shim now that producers agree |
| `src/daemon/bootstrap.ts` | Register `approvalService` on the kernel; call `reconcilePendingApplications()` after the SurrealDB connection seals; drop the SQLite `Database` construction (after every consumer migrates); remove `GraphStore`; drop `WASM_PATH`/`DB_PATH` constants and the `database.persist()`/`close()` calls in `makeClose`; drop the Synthesizer/ContradictionHunter SQLite injections (Task 6) |
| `src/core/kernel.ts` | Add the `approvalService` slot; remove `database` and `graph` slots after Task 13 |
| `src/core/coordinator/coordinator.ts` | Insert/update `agent_run` rows in SurrealDB via the existing `seq` int pattern (Phase 4 Task 12 established this for `agent_event` and `agent_session`) |
| `src/core/coordinator/coordinator.test.ts` | Migrate to the SurrealDB fixture pattern from Phase 2/3/4 smokes |
| `src/daemon/handlers/agentBrief.ts` | `lastTouchedAt` reads `note.updated_at` from SurrealDB; claim/question collection reads `claim`/`question` rows joined via `asserts`/`asks` edges instead of SQLite `graph_nodes` |
| `src/daemon/handlers/agentBrief.test.ts` | Migrate fixture |
| `src/core/vitals/vitalsService.ts` | Read `note.word_count`, `note.maturity`, `note.updated_at` from `note`; chunk count via `SELECT count() FROM chunk WHERE note = $note GROUP ALL`; edge count via `SELECT count() FROM wikilink WHERE in = $note OR out = $note GROUP ALL` (`approved AND applied` only); writes go to new fields on `note` (`health`, `freshness`) |
| `src/core/vitals/vitalsService.test.ts` | Migrate fixture |
| `src/core/agents/maturityAdvancer.ts` | Read note set via `SELECT path, word_count, maturity, updated_at FROM note;`; per-direction edge count queries replace the SQLite `graph_edges` aggregation; `UPDATE note SET maturity = $next WHERE path = $path;` for the maturity write; the inline frontmatter mutation via `yaml` is unchanged |
| `src/core/agents/maturityAdvancer.test.ts` | Migrate fixture |
| `src/core/db/schema.surql` | Add `note.health` and `note.freshness` (and confirm `note.maturity` exists — it is the `option<int>` field VitalsService and MaturityAdvancer share); these are field additions; the table count stays at 30 |
| `src/core/chat/contextManager.ts` | Replace SQLite count queries (`SELECT COUNT(*) AS count FROM notes;` and friends) with SurrealDB `SELECT count() FROM <table> GROUP ALL` reads; drop the `Database` import |
| `src/core/chat/contextManager.test.ts` | Migrate fixture |
| `src/agent/toolBundle.ts` | The four `database`-bound tool factories — `makeListNeighborsTool`, `makeListProposalsTool`, `makeGetProposalTool`, `makeFindPathTool` — migrate; their underlying queries against `graph_nodes` / `graph_edges` / proposals data move to the SurrealDB graph schema |
| `src/agent/toolBundle.test.ts` | Migrate fixture |
| `src/core/chat/tools/graph.ts`, `proposals.ts`, `notes.ts` and their `.test.ts` peers | DAL-only swap to SurrealDB; tool result shapes unchanged |
| `src/core/stream/streamService.ts`, `streamService.test.ts` | Implementer evaluates whether the surface still has a live driver after the chat tooling migration; either migrate to SurrealDB or strip the file (record the call in the commit message) |
| `src/core/indexer/indexNote.ts` | Drop `database` and `graph` parameters; the indexer is purely SurrealDB-bound after Phase 3 |
| `src/core/indexer/indexNote.test.ts` | Drop `database`/`graph` injections; remove the `InMemoryVectorIndex` construction |
| `src/core/settings/types.ts` | Delete the `nativeGraph` field (`writeRelatedSection`, `writeFrontmatterRelations`, `relatedSectionHeading`) and its DEFAULT_SETTINGS entry |
| `src/core/settings/settingsService.ts` | Drop the `nativeGraph` deep-merge entry |
| `src/cli/commands/awaken.ts` | Wire `--tier 1\|2\|3` flag through to the awaken worker; passes through to the existing `awaken_run.tier_filter` array |
| `src/cli/commands/reindex.ts` | Wire `--tier 1\|2\|3` flag; only the specified tier re-runs |
| `src/cli/index.ts` | Wire dispatch for `graph` (`dump`/`stats`), `links` (`sync`/`audit`), `backup`, `restore`, `nuke`, `migrate-vault`; drop the WASM_PATH resolver and the `sql-wasm.wasm` reference; update help-list text |
| `src/cli/commands/init.ts` | Drop the WASM cold-start writer; the SQLite WASM file is never copied into the vault again |
| `package.json` | Remove `sql.js` from `dependencies`, `@types/sql.js` from `devDependencies` |

### Files deleted

- `src/core/db/database.ts`
- `src/core/db/database.test.ts`
- `src/core/db/migrations.ts`
- `src/core/db/migrations.test.ts`
- `src/core/db/schema.ts`
- `src/core/graph/graphStore.ts`
- `src/core/graph/graphStore.test.ts`
- `src/core/graph/types.ts` (last consumer goes with `graphStore`)
- `src/core/indexer/vectorIndex.ts`
- `src/core/indexer/vectorIndex.test.ts`

`bun.lockb` regenerates clean after dependency removal (no manual edit).

### Files NOT touched (out of Phase 5 scope)

- `src/core/db/edgeTables.ts`, `schemaApplier.ts`, `schemaApplier.test.ts`, `schema.surql`, `surreal.ts`, `surreal.test.ts` — the SurrealDB DAL is already the substrate; no further work beyond the field additions in Task 5.
- `src/core/agents/synthesizer.ts`, `synthesizer.test.ts`, `contradictionHunter.ts`, `contradictionHunter.test.ts` — Locked Decision 11. The agent files stay on disk; the bootstrap construction drops their SQLite `db` injection and Coordinator wiring uses the no-op fallback shape that already exists for the linker case.

---

## Tasks

### Task 1: Align `daemon_write` SHA producer with the watcher's body SHA

**Files:**
- Modify: `src/core/indexer/tier1.ts` — the SHA persisted into `note.sha` and the SHA cross-referenced against `daemon_write` rows must be the FILE body SHA, computed via `crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawFileBody))`, not the joined-block-text SHA.
- Modify: `src/core/approvals/approvalService.ts` — the `hash` option becomes a closure that defaults to `crypto.subtle.digest("SHA-256", utf8(afterBody))`; production wiring stops passing a custom hash function. Remove the option from the constructor signature if no caller still passes one.
- Modify: `src/core/indexer/tier1.test.ts` — assert `note.sha` equals the raw body SHA.
- Modify: `src/daemon/__smoke__/phase4.smoke.test.ts` — drop the `ApprovalService.hash` shim that previously rewrote the post-write SHA to the joined-block form; the smoke now relies on producer agreement, no shim.

**Objective:** Both producers agree on the SHA contract: the SHA stored in `note.sha`, the SHA `daemon_write` records, and the SHA Tier 1's `findRecentDaemonWrite` cross-reference uses are all the FILE body SHA. The simpler fix listed in the Phase 4 handoff: have Tier 1 record the file body SHA (which already matches what `ApprovalService` computes post-write).

**Invariants:**
- `note.sha` after Tier 1 commit equals `crypto.subtle.digest("SHA-256", utf8(rawFileBody))`. Frontmatter is included in the SHA (the Phase 2 frontmatter-stripped variant is dropped here; raw body wins because the watcher's SHA is the authoritative one and it is computed over the raw file body).
- `daemon_write.sha` equals the FILE body SHA of the post-writeback file content. `findRecentDaemonWrite` matches on this value.
- The Phase 4 smoke's `ApprovalService.hash` shim is gone; the smoke passes via producer agreement alone.

**Acceptance:**
- `bun test src/core/indexer/tier1.test.ts src/core/approvals/approvalService.test.ts` green.
- `NOTIENT_SMOKE=1 bun test src/daemon/__smoke__/phase4.smoke.test.ts` green with the shim removed.

**Commit:** `fix(provenance): align daemon_write SHA producer with file body SHA`

---

### Task 2: Register `ApprovalService` on the kernel and reconcile pending applications on boot

**Files:**
- Modify: `src/daemon/bootstrap.ts` — construct `ApprovalService` from the kernel-resolved `surrealConnection`, `bus`, vault root, fs adapter, and `readFile` closure; register it under a new kernel slot `approvalService`; after `applySchema` returns and the kernel seals (Phase B/C section), call `approvalService.reconcilePendingApplications()` and log the `{ replayed, failed }` summary as a structured stderr line.
- Modify: `src/core/kernel.ts` — add the `approvalService` slot to the typed registry. Position it alongside `historyService`.
- Modify: `src/daemon/bootstrap.test.ts` — assert kernel has the slot; assert reconcile runs once on boot. The test does not need to inject a half-applied edge row; that is Task 12's smoke.

**Objective:** Wire `ApprovalService` for production. Phase 4 shipped the service and the reconciliation method but never registered the service on the kernel and never called the reconciliation pass on boot. Without this, an in-flight writeback that crashed mid-flow stays as `approved=true, applied=false` until the next manual approve touches the same row. Production needs the boot-time replay.

**Invariants:**
- `ApprovalService` is constructed with the same `{ db, bus, vaultRoot, fs, readFile, hash? }` shape it currently takes; `hash` defaults to the file-body SHA-256 closure introduced in Task 1.
- The reconciliation call runs after schema application, after the kernel seals, before `health.start()`. Failures inside reconciliation must not crash bootstrap; the supervisor logs `{ replayed, failed }` to stderr and the daemon proceeds.
- Subsequent `approveEdge` calls go through the kernel-resolved instance, not a freshly constructed one (chat handlers and the `links sync` CLI verb both read `kernel.get("approvalService")`).

**Acceptance:**
- `bun test src/daemon/bootstrap.test.ts` green.
- The Phase 5 smoke (Task 12) covers the half-applied-row replay end-to-end.

**Commit:** `feat(approvals): register ApprovalService on kernel and reconcile on boot`

---

### Task 3: Migrate `Coordinator` to write `agent_run` rows in SurrealDB

**Files:**
- Modify: `src/core/coordinator/coordinator.ts` — replace the two SQLite statements (`INSERT INTO agent_runs ...` and `UPDATE agent_runs SET ...`) with SurrealDB `CREATE agent_run` and `UPDATE agent_run` queries; preserve the wire-shape numeric id by using the `seq` int pattern Phase 4 Task 12 established for `agent_event` and `agent_session`. Drop the `db: Database` constructor field; replace with `db: Surreal`.
- Modify: `src/core/coordinator/coordinator.test.ts` — migrate to the SurrealDB fixture pattern.
- Modify: `src/core/coordinator/types.ts` — `agentRunId` stays a `number` because consumers read the `seq` integer, not the SurrealDB record id; update the doc comment to name the convention.
- Modify: `src/daemon/bootstrap.ts` — pass `surrealConnection.db` to the `Coordinator` constructor instead of `database`.

**Objective:** Coordinator was the last consumer producing `agent_run`-shaped rows in SQLite. The schema table `agent_run` has been live since Phase 4 Task 12 but with zero producers. Migrate so the audit trail starts populating.

**Invariants:**
- The wire shape (`{ id: number, agent: string, ok: boolean, error: string | null, proposals_count: number, started_at: string, finished_at: string | null }`) is unchanged. Internal SurrealDB `record<agent_run>` ids are not exposed.
- The `seq` allocation follows Phase 4 Task 12's pattern: a SurrealQL transaction increments a counter row (or uses `math::max(seq) + 1` over the existing rows) and stamps the new `agent_run.seq` in one round trip.
- Coordinator runs that fail mid-execution still record a row with `ok=false, error=<message>`. Idempotency: a retry does not double-insert (the dispatch loop owns retry semantics; the Coordinator does not implement exactly-once on its own).

**Acceptance:**
- `bun test src/core/coordinator/` green.
- `SELECT * FROM agent_run ORDER BY started_at DESC LIMIT 1;` against a test database returns the most recent run after a scripted swarm cycle.

**Commit:** `feat(coordinator): write agent_run rows to SurrealDB`

---

### Task 4: Migrate `agentBrief` hybrid SQLite reads to SurrealDB

**Files:**
- Modify: `src/daemon/handlers/agentBrief.ts` — `lastTouchedAt` derives from `SELECT updated_at FROM note WHERE path = $path;` instead of the SQLite `notes` table; the claim/question collection reads `claim` and `question` rows via the `asserts` and `asks` edge tables: `SELECT VALUE out FROM asserts WHERE in = $note OR in.note = $note;` plus `SELECT VALUE out FROM asks WHERE in = $note OR in.note = $note;`. Drop the `database` constructor field if it becomes unused.
- Modify: `src/daemon/handlers/agentBrief.test.ts` — migrate fixture.
- Optionally modify: `src/core/db/surreal.ts` — add typed DAL helpers (`lastTouchedAt(path)`, `claimsForNote(path)`, `questionsForNote(path)`) if it makes the call site cleaner. Implementer's choice.

**Objective:** Phase 4 left two hybrid SQLite reads in `agentBrief` (Phase 4 handoff: "agentBrief retains hybrid SQLite reads for `notes.updated_at` and `graph_nodes`"). Both move to SurrealDB. The handler's RPC contract is unchanged — only the queries inside change.

**Invariants:**
- The brief response shape is unchanged. The `lastTouchedAt` field is a `string` ISO timestamp formatted exactly as it was in the SQLite read.
- Claim and question text comes from the `claim.text` / `question.text` columns; identity is the SHA-derived index from Phase 1 schema. The brief lists at most the same N items it listed in Phase 4 (no new pagination behaviour).
- If a note has zero claims or zero questions, the brief omits the section the same way the SQLite path did.

**Acceptance:**
- `bun test src/daemon/handlers/agentBrief.test.ts` green.
- Manual smoke against a seeded vault: `bun run src/cli/index.ts brief <topic>` returns a structurally-identical response shape to the Phase 4 baseline.

**Commit:** `feat(handlers): agentBrief reads SurrealDB for last_touched and claims`

---

### Task 5: Migrate `VitalsService` and `MaturityAdvancer` to SurrealDB

**Files:**
- Modify: `src/core/db/schema.surql` — add `DEFINE FIELD health ON note TYPE option<int>;`, `DEFINE FIELD freshness ON note TYPE option<int>;`, and confirm `DEFINE FIELD maturity ON note TYPE option<int>;` exists. These are field additions; the table count stays at 30.
- Modify: `src/core/vitals/vitalsService.ts` — read `note.word_count`, `note.maturity`, `note.updated_at` from `note`; chunk count via `SELECT count() FROM chunk WHERE note = $note GROUP ALL`; edge count via `SELECT count() FROM wikilink WHERE (in = $note OR out = $note) AND approved = true AND applied = true GROUP ALL`. Writes go to `UPDATE note SET health = $health, freshness = $freshness WHERE path = $path;`.
- Modify: `src/core/vitals/vitalsService.test.ts` — migrate fixture.
- Modify: `src/core/agents/maturityAdvancer.ts` — read the note set via `SELECT path, word_count, maturity, updated_at FROM note;`; per-direction edge count queries replace the SQLite `graph_edges` aggregation; the maturity write becomes `UPDATE note SET maturity = $next WHERE path = $path;`. The inline frontmatter mutation via the `yaml` package (`upsertMaturityFrontmatter` from Phase 4 Task 5) is unchanged.
- Modify: `src/core/agents/maturityAdvancer.test.ts` — migrate fixture.
- Modify: `src/daemon/bootstrap.ts` — pass `surrealConnection.db` to both services instead of `database`.

**Objective:** Both services were on SQLite. Both need to keep working: vitals is the live `notient vitals` CLI surface; the maturity advancer is one of the four swarm agents. Migrate the queries; preserve behaviour exactly.

**Invariants:**
- `VitalsBlock` shape (`{ health: number, maturity: number | string, freshness: number }`) is unchanged.
- Edge counts include only `approved AND applied` edges (matches Phase 4's pending-state contract; an unapplied edge does not contribute to maturity).
- Tier dependency: `VitalsService` consumes `note.word_count` set by Tier 1; both consumers must verify that `word_count` is populated before computing health (a note that has not been Tier-1-indexed returns a default vitals block with `health = 0`).

**Acceptance:**
- `bun test src/core/vitals/ src/core/agents/maturityAdvancer.test.ts` green.
- A scripted run of `bun run src/cli/index.ts vitals <path>` against a seeded vault returns a vitals block with non-zero counts.

**Commit:** `feat(vitals): VitalsService and MaturityAdvancer read SurrealDB`

---

### Task 6: Strip `Synthesizer` and `ContradictionHunter` SQLite wiring from production

**Files:**
- Modify: `src/daemon/bootstrap.ts` — drop the `new Synthesizer({ db: database, ... })` construction; drop the `new ContradictionHunter({ db: database, neighbors: ..., ... })` construction; the Coordinator's `agents` map keeps `synthesizer` and `contradictionHunter` keys but assigns the no-op fallback shape that already exists for the linker case (`{ name, usesReasoningModel: false, run: async () => ({ proposals: 0 }) }`).
- Modify: `src/daemon/bootstrap.test.ts` — assert the swarm dispatches without errors when these two agents are no-ops; assert `agent_run` rows are still recorded for them.

**Objective:** Locked Decision 11. Both agents have read frozen/empty SQLite state since Phase 3 (Phase 3 handoff: "ContradictionHunter produces zero contradictions ... Synthesizer ... clusters embeddings via SQL directly"). After Phase 5 deletes SQLite, the constructors would fail. Migrating both agents to SurrealDB is feature work, not Phase 5 cutover work. Strip the production wiring; leave the `.ts` files in place so a future feature task can re-introduce them.

**Invariants:**
- The Coordinator's swarm dispatch loop runs unchanged. The `proposals: 0` returns from the no-ops register as agent runs in `agent_run` with `ok=true, proposals_count=0` so the audit trail is honest about which agents ran.
- The agent `.ts` files stay on disk. Their tests stay on disk and continue to pass against in-process fixtures (they don't need a database connection in test mode).

**Acceptance:**
- `bun test src/daemon/bootstrap.test.ts` green; the swarm dispatches with all four agent slots filled.
- The Coordinator audit trail records four `agent_run` rows on a swarm cycle.

**Commit:** `refactor(swarm): strip Synthesizer and ContradictionHunter SQLite wiring`

---

### Task 7: Migrate chat tooling and ContextManager to SurrealDB

**Files:**
- Modify: `src/core/chat/contextManager.ts` — replace the `readCountSafe(database, "SELECT COUNT(*) ...")` calls with SurrealDB `SELECT count() FROM <table> GROUP ALL` reads against the `note`, `chunk`, `block`, `tag` tables; drop the `Database` import and the `database` constructor field.
- Modify: `src/core/chat/contextManager.test.ts` — migrate fixture.
- Modify: `src/agent/toolBundle.ts` — the four `database`-bound tool factories (`makeListNeighborsTool`, `makeListProposalsTool`, `makeGetProposalTool`, `makeFindPathTool`) migrate; their underlying queries against `graph_nodes` / `graph_edges` / proposals data move to the SurrealDB graph schema. The `findPath` tool walks the recursive `note->wikilink->note` traversal SurrealQL pattern Phase 4 used in `graphExpansion`.
- Modify: `src/agent/toolBundle.test.ts` — migrate fixture.
- Modify: `src/core/chat/tools/graph.ts`, `proposals.ts`, `notes.ts` and their `.test.ts` peers — DAL-only swap; tool result shapes unchanged.
- Modify: `src/core/stream/streamService.ts`, `streamService.test.ts` — implementer reads the file, decides whether the surface still has a live driver after the chat tooling migration; either migrates to SurrealDB or strips the file. The decision is recorded in the commit message. If stripped, the deletion lands as part of Task 13's substrate sweep.

**Objective:** The chat surface (`/chat`, `notient ask`, `notient brief`) consumes these via the kernel-injected toolbundle. They cannot break. The migration is mechanical: each SQLite query maps to a SurrealDB equivalent against the entity tables (`note`, `block`, `chunk`, `tag`, `concept`, `claim`, `question`) and the edge tables (the six wikilink-family + the Tier 3 inferred set).

**Invariants:**
- Tool result shapes are unchanged. The chat handler does not re-render tool output; the LLM consumes the same JSON structure.
- Pagination, ordering, and filter semantics match the SQLite versions exactly. Tests that were tied to SQLite `ORDER BY id` semantics now bind to `ORDER BY created_at` (the closest SurrealDB equivalent for monotonic ordering); the implementer documents any drift in the commit message.
- ContextManager's count statistics drive the chat header. The values must be non-zero on a non-empty seeded vault; a zero from a count query means a real bug, not a migration bug.

**Acceptance:**
- `bun test src/core/chat/ src/agent/toolBundle.test.ts` green.
- `bun run src/cli/index.ts chat` against a seeded vault renders the chat header with non-zero counts.

**Commit:** `feat(chat): ContextManager and tool registry read SurrealDB`

---

### Task 8: Delete `NotientSettings.nativeGraph` orphan

**Files:**
- Modify: `src/core/settings/types.ts` — remove the `nativeGraph: { writeRelatedSection, writeFrontmatterRelations, relatedSectionHeading }` block from `NotientSettings` and the `DEFAULT_SETTINGS` literal.
- Modify: `src/core/settings/settingsService.ts` — drop the `nativeGraph: { ...base.nativeGraph, ...(patch.nativeGraph ?? {}) }` deep-merge entry.
- Verify: `grep -rn "nativeGraph" src/` returns empty after the change.

**Objective:** The setting was orphaned in Phase 4 when `nativeGraphBridge`, `relatedSection`, and `frontmatterWriter` were deleted. The field stayed in the settings shape because no consumer was driving its removal. Phase 5 cleans it up.

**Invariants:**
- Settings deserialisation tolerates older config files that still carry a `nativeGraph` key — silently drop it via the existing unknown-keys-ignored deserialisation path.
- No new settings field is added; this is a pure deletion.

**Acceptance:**
- `bun test src/core/settings/` green.
- `grep -rn "nativeGraph" src/` returns empty.

**Commit:** `refactor(settings): delete orphaned nativeGraph field`

---

### Task 9: New CLI verbs — `graph dump`, `graph stats`, `links sync`, `links audit`

**Files:**
- Create: `src/cli/commands/graphDump.ts`, `graphStats.ts`, `linksSync.ts`, `linksAudit.ts`
- Create: `src/cli/commands/graphDump.test.ts`, `graphStats.test.ts`, `linksSync.test.ts`, `linksAudit.test.ts`
- Modify: `src/cli/index.ts` — wire `dispatchGraph` for `dump`/`stats` subcommands and `dispatchLinks` for `sync`/`audit`; add the verbs to the help list.

**Objective:** Land the four read-mostly graph and links verbs from spec §11.1. Each shells through the existing `awakenSurrealClient` helper or constructs its own short-lived SurrealDB connection over the per-vault socket. Each emits NDJSON or structured JSON per the existing CLI emitter pattern.

**Behaviour:**
- `graph dump [--tier 1|2|3] [--format json|graphml|cypher]` selects entity + edge rows filtered by the highest non-NONE tier (default) or by the requested tier. Default format is `json`. Tier 1 = entities + `class='EXTRACTED'` edges. Tier 2 = additionally include chunk metadata as node attributes. Tier 3 = full graph including `INFERRED` edges. Output is deterministic for a given seeded vault.
- `graph stats` runs one `SELECT count() FROM <table> GROUP BY source` per edge table and `SELECT count() FROM <table> GROUP ALL` per entity table. Emits one line per `(table, source)` pair in fixed-width text format.
- `links sync` is the CLI handle to `ApprovalService.reconcilePendingApplications()`. Connects, calls reconcile, prints `{ replayed, failed }`, exits.
- `links audit` selects from `wikilink_unresolved`, `embed_unresolved`; runs a follow-up dangling-block-ref pass against `block` ids referenced by `wikilink.in.block_id` that have no matching `block` row; lists orphan `tag` rows (no incoming `tagged` edges). Emits NDJSON, one JSON object per finding, each with a `kind` discriminator.

**Invariants:**
- All four verbs are read-only against the running daemon's database; `links sync` is the one exception (it triggers writes via reconcile, but the writes are the same idempotent writebacks Phase 4 shipped).
- Output formats match the existing CLI emitter conventions: `--json` toggles JSON, default is `pretty` on a TTY and `ndjson` otherwise.

**Acceptance:**
- `bun test src/cli/commands/graphDump.test.ts src/cli/commands/graphStats.test.ts src/cli/commands/linksSync.test.ts src/cli/commands/linksAudit.test.ts` green.
- Manual smoke: `bun run src/cli/index.ts graph stats` against a seeded vault prints non-empty per-table counts.

**Commit:** `feat(cli): graph dump/stats and links sync/audit verbs`

---

### Task 10: New CLI verbs — `backup`, `restore`, `nuke`, `migrate-vault`

**Files:**
- Create: `src/cli/commands/backup.ts`, `restore.ts`, `nuke.ts`, `migrateVault.ts`
- Create: `src/cli/commands/backup.test.ts`, `restore.test.ts`, `nuke.test.ts`, `migrateVault.test.ts`
- Modify: `src/cli/index.ts` — wire dispatchers for `backup`, `restore`, `nuke`, `migrate-vault`; add to help list.

**Objective:** Ship the operator escape hatches. Each verb shells out to the SurrealDB binary or to filesystem operations; none introduce a new daemon-side handler.

**Behaviour:**
- `backup [--out <path>]`: spawns `surreal export --endpoint ws://127.0.0.1:<port> --ns notient --db vault --user root --pass <secret> <out>` via `Bun.spawn`. Default `--out` is `~/.notient/<vault-id>/backups/<ISO-timestamp>.surql`. Returns the path on success. Propagates the underlying `surreal` exit code.
- `restore <path>`: spawns `surreal import` against the running daemon. **Refuses to run if any tracked table has any rows.** The check is one `SELECT count() FROM <table> GROUP ALL` per table from the entity + edge + ops table list; the operator must `notient nuke` first if they want to overwrite. Error message includes the exact `notient nuke` instruction.
- `nuke [--yes]`: stops the daemon (existing daemon stop path), deletes `~/.notient/<vault-id>/data/`, restarts the daemon. Confirmation prompt unless `--yes` is passed (read from stdin; refuse if not a TTY and `--yes` was not passed). After restart, schema re-applies via the existing bootstrap path.
- `migrate-vault <new-absolute-path>` performs five operations in order:
   1. `surreal export` from the source daemon to a temporary `.surql` file under `/tmp/`.
   2. Verify the export by reading its first and last bytes and confirming non-zero size.
   3. Stop the source daemon gracefully (existing daemon stop path; 10s SIGTERM, then SIGKILL).
   4. Compute the new `<vault-id>` from `<new-absolute-path>`; create `~/.notient/<new-vault-id>/`; copy `secret.key` from the old to the new directory; start the target daemon at the new vault-id.
   5. `surreal import` from the temp file into the target.

  Failure handling is explicit:
   - If step 1 or 2 fails: source daemon stays up, no state changes, verb exits non-zero.
   - If step 3 fails: source daemon is left in whatever state it ended in, verb exits non-zero with diagnostic.
   - If step 4 fails: source daemon is restarted, verb exits non-zero.
   - If step 5 fails: target daemon is stopped, target data dir is removed, source daemon is restarted, verb exits non-zero with the restore error. The temp `.surql` file is preserved on failure for operator inspection; deleted only on full success.

**Invariants:**
- `backup` reads the daemon's bound port from `~/.notient/<vault-id>/surreal.port` and the secret from `~/.notient/<vault-id>/secret.key`.
- `restore` uses the same port and secret as `backup`. The non-empty-DB check is the entirety of the safety story; no diff or merge mode.
- `nuke` is idempotent: running it on an already-empty data dir succeeds and prints a no-op message.
- `migrate-vault` does not delete the source `~/.notient/<old-vault-id>/` directory after success; the operator owns that cleanup. Default behaviour preserves the source data dir for rollback.

**Acceptance:**
- `bun test src/cli/commands/backup.test.ts src/cli/commands/restore.test.ts src/cli/commands/nuke.test.ts src/cli/commands/migrateVault.test.ts` green.
- The `migrateVault.test.ts` includes a happy-path test (asserting `note` row count parity between source pre-migration and target post-migration) AND a failure-injection test that corrupts the temp `.surql` before step 5 and asserts: source daemon is running, target data dir is gone, verb exit code is non-zero, the temp file is preserved.
- The Phase 5 smoke harness (Task 12) round-trips `backup → nuke → restore` end-to-end against a fixture vault.

**Commit:** `feat(cli): backup, restore, nuke, migrate-vault verbs`

---

### Task 11: Wire `awaken --tier` and `reindex --tier` flags

**Files:**
- Modify: `src/cli/commands/awaken.ts` — parse `--tier <csv>` where `<csv>` is one or more of `1,2,3`; pass through to the awaken worker as the `tier_filter` array; default stays `[1, 2, 3]`. Invalid tier values are silently dropped; an empty resulting set falls back to all tiers.
- Modify: `src/cli/commands/awaken.test.ts` — cover flag parsing including invalid values and CSV.
- Modify: `src/cli/commands/reindex.ts` — parse `--tier <csv>`; only the specified tier(s) re-run against matching notes. `reindex --tier 2` clears `note.tier2_at` for matching notes before enqueueing so the worker actually re-runs that tier; the watcher does not re-trigger Tier 1 or Tier 3.
- Modify: `src/cli/commands/reindex.test.ts` — cover the timestamp-clearing behaviour.
- Modify: `src/core/awaken/awakenWorker.ts` IF the existing `tier_filter` handling does not honour single-element arrays end-to-end (Phase 4 shipped the array; verify no path treats a single-element filter as "no filter").

**Objective:** Spec §11.2 lists both flag additions. Phase 4 shipped the underlying state machine (`awaken_run.tier_filter` array); Phase 5 adds the CLI flag plumbing.

**Invariants:**
- `awaken --tier 1` enqueues only the Tier 1 work for each note. The priority queue's existing tier ordering means Tier 1 still drains first for the included notes.
- `reindex <glob> --tier 2` re-runs only the embed step on matching notes; the watcher does not re-trigger Tier 1 or Tier 3.

**Acceptance:**
- `bun test src/cli/commands/awaken.test.ts src/cli/commands/reindex.test.ts` green.
- Phase 5 smoke covers `reindex --tier 2` only re-embedding without re-running Tier 1 or Tier 3.

**Commit:** `feat(cli): awaken --tier and reindex --tier filters`

---

### Task 12: Phase 5 smoke harness

**Files:**
- Create: `src/daemon/__smoke__/phase5.smoke.test.ts`

**Objective:** End-to-end coverage of the new behaviour. The smoke runs against a real SurrealDB instance using the same fixture pattern from Phase 2/3/4 smokes.

The smoke must:
1. Seed a fixture vault, run an awaken pass, then assert `graph dump --tier 1` returns deterministic JSON.
2. Seed unresolved wikilinks and assert `links audit` reports them all as NDJSON findings with `kind: "unresolved-wikilink"`.
3. Round-trip `backup → nuke → restore` and assert table row counts match before and after for at least three tables: `note`, `wikilink`, `daemon_write`.
4. Run `reindex --tier 2` and assert only the embed step ran (no extractor invocation, no linker invocation; verifiable by snapshot comparison: `chunk` rows changed but `concept` / `claim` / `question` rows unchanged).
5. Approve a linker proposal via `kernel.get("approvalService").approveEdge(...)` with the corrected daemon_write SHA producer wiring (no smoke shim); read the source note and assert the wikilink lands in `## Related`; assert `daemon_write` row exists with the correct file body SHA, agent, targets; save the note again to simulate a user save and assert Tier 1 attributes the wikilink with `source = 'linker'` end-to-end.
6. Insert a row with `approved=true, applied=false`; restart the daemon; assert `applied` flips to `true` and the file lands at the expected SHA (covers Task 2's reconciliation pass).

**Invariants:**
- The smoke runs against a real SurrealDB instance, not a mock.
- The smoke is hermetic: each run uses a fresh fixture vault and a fresh DB.
- The smoke does NOT depend on any sql.js / SQLite path; if the substrate delete in Task 13 breaks it, that is a Task 13 bug, not a Task 12 bug.

**Acceptance:**
- `NOTIENT_SMOKE=1 bun test src/daemon/__smoke__/phase5.smoke.test.ts` green.
- Combined smoke pass: 5 files (surrealServer, tier1, tier23, phase4, phase5), all green.

**Commit:** `test(smoke): Phase 5 substrate cutover end-to-end`

---

### Task 13: SQLite substrate deletion

**Files:**
- Delete: `src/core/db/database.ts`, `src/core/db/database.test.ts`, `src/core/db/migrations.ts`, `src/core/db/migrations.test.ts`, `src/core/db/schema.ts`
- Delete: `src/core/graph/graphStore.ts`, `src/core/graph/graphStore.test.ts`, `src/core/graph/types.ts`
- Delete: `src/core/indexer/vectorIndex.ts`, `src/core/indexer/vectorIndex.test.ts`
- Modify: `src/core/indexer/indexNote.ts` — drop `database` and `graph` parameters; the indexer is purely SurrealDB-bound.
- Modify: `src/core/indexer/indexNote.test.ts` — drop `database` / `graph` injections; remove the `InMemoryVectorIndex` construction.
- Modify: `src/daemon/bootstrap.ts` — drop the `Database` construction; drop `new GraphStore(database)`; drop the `database` and `graph` kernel slots; drop the `WASM_PATH` and `DB_PATH` constants; remove `database.persist()` and `database.close()` from `makeClose`; drop the `database` and `graph` injections to indexer, vitalsService, contextManager, toolRegistry, etc.
- Modify: `src/core/kernel.ts` — remove the `database` and `graph` slot type entries.
- Modify: `src/cli/index.ts` — drop the WASM path resolver and the `sql-wasm.wasm` reference.
- Modify: `src/cli/commands/init.ts` — drop the WASM cold-start writer; `notient init` no longer copies the wasm file into the vault.
- Modify: `package.json` — remove `sql.js` from `dependencies` and `@types/sql.js` from `devDependencies`.
- Run: `bun install` to regenerate `bun.lockb`; verify the lockfile no longer references sql.js.
- Verify (grep over `src/` returns empty): `sql\.js`, `sql-wasm`, `hnswlib-wasm`, `database\.persist`, `GraphStore`, `InMemoryVectorIndex`. The references to `nativeGraphBridge`, `relatedSection`, `frontmatterWriter`, `echoGuard` should already be gone from Phase 4; if any survive, delete in this task.

**Objective:** The substrate cutover. Every consumer migrated in Tasks 3-7. The orphan field cleanup landed in Task 8. The new CLI verbs landed in Tasks 9-11. The smoke harness in Task 12 verified the new behaviour. This task removes the dead substrate.

**Invariants:**
- Spec §12.1 / §12.2 / §12.4 / §12.7 are satisfied.
- `INFO FOR DB` table count stays at 30. No SurrealDB tables are added or removed by this task.
- `bun.lockb` regenerates clean. No version drift on unrelated dependencies.

**Acceptance:**
- `bun run typecheck` clean.
- `bun test` green at no fewer than the entering pass count (some test files may relocate from default-bun-test to smoke-gated; that is expected — verify net coverage does not regress).
- `NOTIENT_SMOKE=1 bun run test:smoke` green: 5 files, all passing.
- The verify-grep above returns empty.

**Commit:** `refactor(substrate): delete sql.js, GraphStore, vectorIndex, sql.js dependency`

---

### Task 14: Phase 5 handoff doc — the redesign is done

**Files:**
- Create: `docs/superpowers/handoffs/2026-04-29-phase-5-vault-enrichment-handoff.md`

**Objective:** Write a handoff under 80 lines. Name what shipped (the consumer migrations, the substrate deletion, the ten new CLI verbs, the SHA fix, the kernel registration, the orphan settings cleanup). Confirm the redesign is complete: no Phase 6. Confirm what is deferred — should be: nothing of substance. Anything still hybrid or stub-shaped after Phase 5 is a future feature task, not a redesign task.

**Invariants:**
- The handoff explicitly names the chosen failure-semantics contract (PENDING-STATE) for posterity.
- The handoff explicitly names the chosen action on `Synthesizer` and `ContradictionHunter` (stripped from production wiring; restoration is a future feature task).
- The handoff lists the final test posture: `bun test` pass count, `bun run test:smoke` 5 files / N passing.

**Acceptance:**
- File exists, under 80 lines, names PENDING-STATE explicitly, lists final test posture.

**Commit:** `docs(handoff): Phase 5 substrate cutover summary — redesign complete`

---

## Self-review

**Spec coverage:** §11.1 new CLI verbs (Tasks 9, 10, 11). §12.1 SQLite substrate deletion (Task 13). §12.2 vector-index deletion (Task 13). §12.4 graph subsystem deletion (Task 13). §12.7 dependency removal (Task 13). §15 phase plan: this is Phase 5. Phase 4 carry-forwards: daemon_write SHA-alignment (Task 1), `ApprovalService` kernel registration (Task 2), `agent_run` producer (Task 3), `agentBrief` hybrid reads (Task 4), `nativeGraph` orphan cleanup (Task 8).

**Type consistency:** The SHA contract (Task 1) flows through `note.sha` (Tier 1), `daemon_write.sha` (ApprovalService), and the `findRecentDaemonWrite` cross-reference (Tier 1) — one definition of truth, one closure for hashing. The kernel slot for `approvalService` (Task 2) is added once, consumed by chat handlers and `links sync`. The `agent_run.seq` int (Task 3) is the same shape used by `agent_event` and `agent_session` from Phase 4 Task 12.

**Known transient state during phase:** Between Task 6 (Synthesizer / ContradictionHunter strip) and Task 13 (substrate delete), the `.ts` files for both agents are unreferenced from the production bootstrap but still on disk. Their tests still pass in isolation. This is intentional: a future feature task migrates them rather than re-writing them from scratch.

**Risk: ContextManager and toolBundle migration scope (Task 7) is the largest single task.** If the implementer hits unforeseen scope (e.g. the `streamService` evaluation lands on "migrate, not delete" and pulls in two more files), the task may split into 7a (ContextManager + toolBundle) and 7b (chat tools graph/proposals/notes + streamService). The decision is recorded in the commit message.

**Risk: `agent_run.seq` allocation contention.** If two Coordinator runs race the increment, the `seq` field could double-allocate. Phase 4 Task 12's pattern uses a SurrealQL transaction to increment-and-stamp atomically. The implementer of Task 3 must verify the pattern before the consumer migration commits.

**Risk: `migrate-vault` failure-injection test (Task 10).** The failure-injection test inside the `migrate-vault` command must not leave a half-migrated state on the test filesystem. The test's cleanup hook owns the rollback. Phase 5 smoke (Task 12) does not cover this case because it would slow the smoke unacceptably; the unit test owns it.

---

## Execution

Phase 5 plan saved to `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-5.md`. Execute via `superpowers:subagent-driven-development`. After Task 14 lands, the redesign is done. Stop. Do not start a Phase 6.
