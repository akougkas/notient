# Notient Vault Enrichment — Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the new operator-facing CLI verbs (`graph dump`, `graph stats`, `links sync`, `links audit`, `backup`, `restore`, `nuke`, `migrate-vault`), the tier-aware flags on `awaken` and `reindex`, the tier coverage indicator on `search` and `health`. Then perform the final cutover: delete `sql.js`, the SQLite DAL files, `graphStore.ts`, the `db` kernel slot, and any remaining SQLite-bound code paths. After this phase, SurrealDB is the only datastore in Notient and the spec's vault enrichment redesign is complete.

**Architecture:** Phase 5 is split across two halves. The first half (Tasks 1-9) ships net-new operator verbs that exercise SurrealDB capabilities introduced earlier. The first half exercises recursive RELATE traversal for `graph dump`, edge-table aggregation for `graph stats`, AST round-trip for `links sync`, the `surreal export`/`import` CLI for `backup`/`restore`. The second half (Tasks 10-14) is the destructive final cleanup: delete `sql.js`, `database.ts`, `schema.ts`, `migrations.ts`, `graphStore.ts`, `graph/types.ts`, the `db` kernel slot, and every consumer reference to the SQLite layer. After Phase 5, the only datastore left is the SurrealDB child process; the daemon is one substrate, one schema.

**Tech Stack:** SurrealDB SDK + `surreal` CLI (already in Phase 1). No new substrate.

**Source of truth:**
- `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md` — §11 CLI surface, §12 file deletion punch list, §14 Phase D1 preservation checklist.
- `docs/superpowers/handoffs/2026-04-29-phase-4-vault-enrichment-handoff.md` — confirms all consumers are on SurrealDB before the cutover.

**Locked decisions (Phase 5, 2026-04-29):**

1. **`graph dump` produces a single file in one of three formats.** JSON (default, NetworkX node-link compatible), GraphML, Cypher. The default is JSON because it is the smallest dependency surface and round-trips through any graph tool. Implementation: one SurrealQL query per node table, one per edge table; the JSON serialiser walks the result. GraphML and Cypher reuse the JSON intermediate.
2. **`graph dump --tier N` filters edges by their `class` field.** Tier 1 = `class = 'EXTRACTED'` AND `source IN ['wikilink','embed','frontmatter','structure','tag']`. Tier 2 = additionally include chunk/embedding metadata (no chunks-as-nodes; just node attributes). Tier 3 = full graph including `INFERRED` edges. Default is the highest non-empty tier.
3. **`graph stats` is one SurrealQL aggregation per (table, source) pair.** Output is a fixed-format table: rows of `(table, source, count)` for every entity table and every edge table. No JSON, no NDJSON; human-readable.
4. **`links sync` is idempotent.** For every approved edge in the live tables, ensure the corresponding wikilink is present in the source note's body or frontmatter. If absent, apply the writeback (which is itself idempotent). The verb is safe to run repeatedly.
5. **`links audit` is read-only.** Lists unresolved wikilinks (where `target = NONE`), dangling block refs, and notes with no incoming or outgoing wikilinks (orphans). NDJSON output.
6. **`backup` shells out to `surreal export`.** The daemon's running port and root password are read from `~/.notient/<vault-id>/`. The export goes to `~/.notient/<vault-id>/backups/<ISO-timestamp>.surql` by default; `--out <path>` overrides.
7. **`restore` refuses to run unless the database is empty.** Safety: a restore against a populated DB would create duplicates. The user must `notient nuke` first. The verb prints the exact instruction if it refuses.
8. **`nuke` requires explicit confirmation.** Default behaviour prompts for `y/N`; `--yes` skips. After confirmation, the daemon stops, `~/.notient/<vault-id>/data/` is deleted, daemon restarts, schema is re-applied.
9. **`migrate-vault <new-absolute-path>` has explicit failure-recovery contract.** The verb performs five operations in order: (1) `surreal export` from the source daemon to a temporary `.surql` file, (2) verify the export by reading its first and last bytes and confirming non-zero size, (3) stop the source daemon gracefully, (4) start the target daemon at the new vault-id and apply the schema, (5) `surreal import` from the temp file into the target. Failure handling is non-negotiable:
   - If step 1 or 2 fails, source daemon stays up, no state changes; verb exits non-zero.
   - If step 3 fails (graceful stop times out), source daemon is left in whatever state it ended in; verb exits non-zero with diagnostic.
   - If step 4 fails, source daemon is restarted; verb exits non-zero.
   - If step 5 fails, target daemon is stopped, target data dir is removed, source daemon is restarted; verb exits non-zero with the restore error.
   - The verb only reports success when steps 1-5 all complete and the target's `note` table contains a row count equal to the source's pre-migration count.
10. **`db` kernel slot deletion is atomic with `database.ts` deletion.** The kernel-types change and the file deletion happen in the same commit. After this commit, `bun run typecheck` is green only because no consumer code references `db` anymore.
11. **Final smoke is the entire Phase D1 verb set + the new Phase 5 verbs against an empty + populated vault.** The smoke is the acceptance test for the redesign as a whole.
12. **Documentation update is part of this phase.** README's "data model" section, if any, is updated; the Phase 5 handoff documents the spec's deltas vs. the as-shipped state.

---

## Hard rules (carry forward)

Same as prior phases.

---

## File structure

### Files created

| Path | Responsibility |
|---|---|
| `src/cli/commands/graphDump.ts` | `notient graph dump` |
| `src/cli/commands/graphStats.ts` | `notient graph stats` |
| `src/cli/commands/linksSync.ts` | `notient links sync` |
| `src/cli/commands/linksAudit.ts` | `notient links audit` |
| `src/cli/commands/backup.ts` | `notient backup` |
| `src/cli/commands/restore.ts` | `notient restore` |
| `src/cli/commands/nuke.ts` | `notient nuke` |
| `src/cli/commands/migrateVault.ts` | `notient migrate-vault` |
| `src/cli/commands/graphDump.test.ts`, `graphStats.test.ts`, `linksSync.test.ts`, `linksAudit.test.ts` | One unit test per command |
| `src/daemon/__smoke__/phase5-final.smoke.test.ts` | End-to-end acceptance |
| `src/core/graph/exporters/json.ts`, `graphml.ts`, `cypher.ts` | Format converters reused by `graph dump` |

### Files modified

| Path | Change |
|---|---|
| `src/cli/commands/awaken.ts` | Add `--tier 1\|2\|3` flag |
| `src/cli/commands/reindex.ts` | Add `--tier 1\|2\|3` flag |
| `src/cli/commands/search.ts` | Add tier coverage line to header |
| `src/cli/commands/health.ts` | Probe SurrealDB child + emit per-tier coverage |
| `src/cli/index.ts` | Register the eight new verbs |
| `src/cli/commands/help.ts` | Update help text |
| `src/core/kernel.ts` | Drop `db` slot, drop `graphStore` slot |
| `src/daemon/bootstrap.ts` | Drop sql.js initialisation entirely |
| `package.json` | Remove `sql.js`, `@types/sql.js` |

### Files deleted (the final cutover)

- `src/core/db/database.ts`
- `src/core/db/database.test.ts`
- `src/core/db/schema.ts`
- `src/core/db/migrations.ts`
- `src/core/db/migrations.test.ts`
- `src/core/graph/graphStore.ts`
- `src/core/graph/graphStore.test.ts`
- `src/core/graph/types.ts` (unless it has consumers; verify in Task 12)
- (`src/core/graph/` directory if empty after deletions; remove)
- `src/cli/commands/exportCanvas.ts` if it still exists from Phase 1 (it should not)
- Any remaining test fixture that loads `sql-wasm.wasm`

### Files NOT touched

None. Phase 5 is the final phase; everything that was deferred from prior phases lands here.

---

## Tasks

### Task 1: `graph dump`

**Files:**
- Create: `src/cli/commands/graphDump.ts`
- Create: `src/core/graph/exporters/json.ts`, `graphml.ts`, `cypher.ts`

**Objective:** Implement `notient graph dump` to emit the full graph (nodes from every entity table, edges from every edge table) as JSON (default), GraphML, or Cypher, optionally filtered by `--tier {1,2,3}` and optionally written to `--out <path>` instead of stdout.

**Invariants:**
- `graph dump --tier N` filters edges by their `class` field (Tier 1 = `EXTRACTED` and source IN [`wikilink`,`embed`,`frontmatter`,`structure`,`tag`]; Tier 3 = full graph).
- Default tier is the highest non-empty tier present in the database.
- The JSON exporter is the canonical intermediate; GraphML and Cypher are pure transforms over `DumpedGraph`.
- All edge tables are enumerated via the existing `EDGE_TABLES` constant; no hard-coded table list.

**Acceptance:** `src/cli/commands/graphDump.test.ts` passes, covering tier filtering against a fixture vault and round-trip parity between JSON output and the in-database state.

---

### Task 2: `graph stats`

**Files:**
- Create: `src/cli/commands/graphStats.ts`

**Objective:** Implement `notient graph stats` to print one human-readable table with rows of `(table, source, count)` for every entity table and every edge table, using one SurrealQL aggregation per (table, source) pair.

**Invariants:**
- Output is a fixed-width text table written to stdout. No JSON, no NDJSON.
- Edge tables are enumerated via `EDGE_TABLES`; node tables are listed explicitly.
- Empty tables emit a row with `count = 0` rather than being omitted.

**Acceptance:** `src/cli/commands/graphStats.test.ts` passes, asserting the output shape and that aggregated counts match independently-queried row counts.

---

### Task 3: `links sync` and `links audit`

**Files:**
- Create: `src/cli/commands/linksSync.ts`, `linksAudit.ts`

**Objective:** Implement `links sync` (writeback every approved edge into the source note's markdown via `applyApprovedLink` / `applyApprovedRelation`) and `links audit` (NDJSON list of orphans, dangling targets, and unresolved wikilinks).

**Invariants:**
- `links sync` is idempotent: running it twice produces the same outcome as running it once.
- `links sync` records every successful write through `recordDaemonWrite` so the daemon's own write-back loop does not re-process the change.
- `links audit` is strictly read-only and never mutates the database or the vault.
- Audit output is NDJSON with one JSON object per finding, each including a `kind` discriminator.

**Acceptance:** `src/cli/commands/linksSync.test.ts` and `linksAudit.test.ts` pass; the sync test asserts second-run is a no-op against an unchanged DB.

---

### Task 4: `backup` and `restore`

**Files:**
- Create: `src/cli/commands/backup.ts`, `restore.ts`

**Objective:** Wrap the `surreal export` and `surreal import` CLIs. `backup` writes to `~/.notient/<vault-id>/backups/<ISO-timestamp>.surql` (or `--out <path>`). `restore` imports a `.surql` file into the running daemon.

**Invariants:**
- Daemon endpoint and root credentials are read from per-vault state files (`vaultPortPath`, `vaultSecretPath`).
- `restore` refuses to run unless the database is empty; user must `nuke` first. The error message includes the exact `notient nuke` instruction.
- Both verbs propagate the underlying `surreal` CLI exit code.

**Acceptance:** Unit tests assert the correct `surreal` argv is constructed for both verbs and that `restore` returns non-zero with the expected diagnostic when any tracked table is non-empty.

---

### Task 5: `nuke` and `migrate-vault`

**Files:**
- Create: `src/cli/commands/nuke.ts`, `migrateVault.ts`

**Objective:** Implement `nuke` (stop daemon, delete `~/.notient/<vault-id>/data/`, restart daemon, re-apply schema) and `migrate-vault` (move a vault's indexed state from one absolute path to another via export/import).

**Invariants:**
- `nuke` requires explicit confirmation; default prompts `y/N`, `--yes` skips.
- `migrate-vault` failure-recovery contract is documented in Locked Decision #9 and must be implemented in full: pre-export verification, ordered five-step sequence, per-step rollback, post-migration row-count parity check on the `note` table.
- The temp `.surql` file used by `migrate-vault` is preserved on failure for operator inspection and is only deleted on full success.

**Acceptance:**
- An integration test exercises the happy path and asserts row-count parity between source pre-migration and target post-migration for the `note` table.
- A second integration test injects a restore failure (e.g., corrupt the temp `.surql` file before step 5) and asserts: source daemon is running, target data dir is gone, verb exit code is non-zero, the temp file is preserved for inspection.
- A third integration test simulates step 4 failure (target daemon refuses to start) and asserts the source daemon is restarted and the verb exits non-zero.

---

### Task 6: Add `--tier` flag to `awaken` and `reindex`

**Files:**
- Modify: `src/cli/commands/awaken.ts`, `reindex.ts`

**Objective:** Accept `--tier <csv>` on both verbs, where `<csv>` is a comma-separated subset of `{1,2,3}`. The flag scopes which tier of the indexer pipeline runs.

**Invariants:**
- Omitted flag means all three tiers run (current behaviour).
- Invalid tier values are silently dropped; an empty resulting set falls back to all tiers.
- `reindex --tier N` clears the relevant per-note timestamp before enqueueing so the worker actually re-runs that tier.

**Acceptance:** Unit tests cover flag parsing and the timestamp-clearing behaviour for `reindex`.

---

### Task 7: Tier coverage in `search` and `health`

**Files:**
- Modify: `src/cli/commands/search.ts`, `health.ts`

**Objective:** Add a one-line tier coverage indicator to `search` results header (e.g., `(searchable: NN%, linkable: NN%)`) computed from per-note `tier{1,2,3}_at` timestamps. Extend `health` to probe the SurrealDB child process by PID and emit the same coverage breakdown.

**Invariants:**
- Coverage percentages are floor-rounded integers; zero-note vaults emit `0%` rather than dividing by zero.
- `health` reports `surrealdb: ok` only if the PID file exists and `process.kill(pid, 0)` succeeds.

**Acceptance:** Snapshot or string-match tests over the rendered output for both verbs against fixture coverage states.

---

### Task 8: Wire all new verbs into `src/cli/index.ts`

**Files:**
- Modify: `src/cli/index.ts`, `src/cli/commands/help.ts`

**Objective:** Register dispatch cases for `graph dump`, `graph stats`, `links sync`, `links audit`, `backup`, `restore`, `nuke`, `migrate-vault`, and update the help text to list all eight under the `graph` and `operations` groups.

**Invariants:**
- Unknown subcommands under `graph` or `links` print a usage line and exit 2.
- `notient --help` lists every new verb.

**Acceptance:** `bun run src/cli/index.ts --help` shows all eight verbs; dispatcher unit tests (if present) cover each case.

---

### Task 9: Phase D1 verbs smoke against new schema

**Files:**
- Modify: `src/daemon/__smoke__/phaseD-bridge.smoke.test.ts` (or whatever the existing Phase D1 smoke is named)

**Objective:** Confirm the existing Phase D1 verb smoke (`agent.ask`, `agent.brief`, `agent.distill`, `agent.events`, `session grant/revoke/list`) passes against the post-Phase-4 SurrealDB-only schema. Fix any residual gaps found.

**Invariants:** All D1 verbs return well-formed responses with no SQLite code path on the hot route.

**Acceptance:** The Phase D1 smoke file passes under `bun test`.

---

### Task 10: Final cutover — delete the SQLite DAL files

**Files:**
- Delete: `src/core/db/database.ts`, `database.test.ts`, `schema.ts`, `migrations.ts`, `migrations.test.ts`
- Delete: `src/core/graph/graphStore.ts`, `graphStore.test.ts`
- Delete: `src/core/graph/types.ts` (if no consumers)
- Modify: `src/core/kernel.ts`, `src/daemon/bootstrap.ts`

**Objective:** Delete every SQLite DAL file and the `graphStore` layer; drop the `db` and `graphStore` slots from the kernel; remove `initSqlJs()` and the `new Database(...)` plumbing from daemon bootstrap.

**Invariants:**
- Pre-deletion grep over `src/` for `db/database`, `db/schema`, `db/migrations`, `graphStore` returns zero hits in non-deleted files.
- `bun run typecheck` and `bun test` are green after the deletion commit.
- Kernel slot removal and the corresponding file deletion ship in the same commit.

**Acceptance:** Typecheck green, full test suite green, `git status` shows only the expected deletions and the kernel/bootstrap edits.

---

### Task 11: Remove the `sql.js` dependency

**Files:**
- Modify: `package.json`, `bun.lockb`

**Objective:** `bun remove sql.js @types/sql.js` and verify no `sql.js` or `sql-wasm` references remain anywhere in `src/`.

**Invariants:**
- `grep -rln "sql\.js\|sql-wasm" src/` returns empty.
- Typecheck and full test suite remain green.

**Acceptance:** Clean grep, green build, dependency removed from `package.json` and `bun.lockb`.

---

### Task 12: Final acceptance smoke

**Files:**
- Create: `src/daemon/__smoke__/phase5-final.smoke.test.ts`

**Objective:** End-to-end acceptance: boot daemon on a temp vault (SurrealDB only), awaken a 5-10 note fixture with wikilinks/block refs/tags/frontmatter refs, verify all three tier timestamps are set, exercise every new CLI verb, confirm `links sync` second-run is a no-op, run the full Phase D1 verb set, and assert the build has zero `sql.js` references.

**Invariants:**
- The test must drive each verb at least once and assert observable side effects (file written, rows mutated, output shape).
- The test must include a `nuke` -> `restore` round-trip and assert post-restore row counts match pre-nuke counts.

**Acceptance:** `bun test src/daemon/__smoke__/phase5-final.smoke.test.ts` passes.

---

### Task 13: Final dead-code sweep

**Files:**
- Repo-wide grep + cleanup

**Objective:** Scan `src/` for stale references to `sql.js`, `hnswlib`, `canvas`, `echoGuard`/`EchoGuard`, `nativeGraphBridge`, `relatedSection`, `frontmatterWriter` and delete any survivors. Clean up unused-import warnings surfaced by typecheck.

**Invariants:**
- All listed grep patterns return empty.
- No new typecheck warnings introduced.

**Acceptance:** Clean grep, clean typecheck. If no diff, skip the commit.

---

### Task 14: Phase 5 + project handoff

**Files:**
- Create: `docs/superpowers/handoffs/2026-04-29-phase-5-vault-enrichment-handoff.md`
- Modify: `README.md` (only if a "data model" or "storage" section exists; otherwise skip)

**Objective:** Write the Phase 5 handoff (under 100 lines) covering every new CLI verb shipped, the final SQLite cutover, deltas vs. spec, and known limitations. Append a "Vault Enrichment Redesign Complete" section to the README or a new `docs/REDESIGN-2026-04-29-COMPLETE.md` covering spec link, plan links 1-5, completion date, end-to-end working scope, and out-of-scope items.

**Invariants:** Handoff stays under 100 lines and references the spec sections (§11, §12, §14) it closes out.

**Acceptance:** Handoff file exists at the documented path; README delta (if any) lands in the same commit.

---

## Self-review

**Spec coverage:**
- §11 CLI surface — all new verbs in Tasks 1-7 (graph dump/stats, links sync/audit, backup/restore/nuke/migrate-vault). Tier flags in Task 6. Tier coverage in Task 7.
- §12 file deletion punch list — Tasks 10, 11, 13 cover §12.1 (storage substrate), §12.4 (graph subsystem), and §12.7 (deps). §12.2 (HNSW) and §12.3 (canvas) deleted in Phase 3 and Phase 1 respectively. §12.5 (echoGuard) and §12.6 (staging inverters) deleted in Phase 4.
- §14 Phase D1 preservation — Task 9 verifies all D1 verbs green.

**Type consistency:** `EDGE_TABLES` (Phase 1) consumed by `graph dump`, `graph stats`, `links sync`. `applyApprovedLink` / `applyApprovedRelation` (Phase 4) consumed by `links sync`. `vaultPortPath` / `vaultSecretPath` (Phase 1) consumed by `backup`, `restore`, `health`, `nuke`. All consistent.

**Coverage of the deferred deletions:** The plan from Phase 1's deviation (canvas + echoGuard partial vs. spec §12.1-12.5 all-at-once) is fully resolved by Task 10. After Phase 5, the spec's §12 is fully realised and the deviation is closed.

---

## Execution

Phase 5 plan complete and saved to `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-5.md`. Execute via `superpowers:subagent-driven-development` after Phase 4 ships green. After Phase 5 ships, the entire vault enrichment redesign is in production on `beta-spec`.
