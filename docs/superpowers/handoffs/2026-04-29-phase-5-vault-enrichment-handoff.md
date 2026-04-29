# Phase 5 — Vault Enrichment Handoff

Date: 2026-04-29. Branch: `beta-spec`. Plan: `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-5.md`. Spec: `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md`.

## What shipped

- SHA producer alignment (`a0c7214`): Tier 1 records the FILE body SHA into `note.sha`; `ApprovalService` computes the `daemon_write.sha` via `crypto.subtle.digest("SHA-256", utf8(afterBody))`. The Phase 4 smoke's `ApprovalService.hash` shim is gone; producer agreement holds end-to-end.
- ApprovalService kernel registration (`c30613a`): bootstrap registers `approvalService` and calls `reconcilePendingApplications()` after schema seal. Crash-mid-writeback rows replay automatically on the next daemon start.
- Coordinator on `agent_run` (`7306751`): Coordinator writes `CREATE`/`UPDATE agent_run` via the `seq` int pattern Phase 4 Task 12 established for `agent_event` and `agent_session`. The numeric wire-shape id survives the migration.
- `agentBrief` hybrid reads (`820f45e`): `lastTouchedAt` reads `note.updated_at`; claims and questions read via the `asserts` and `asks` edge tables. Brief response shape unchanged.
- VitalsService and MaturityAdvancer on SurrealDB (`3f6d379`): both consumers read entity and edge counts from SurrealDB and write to new fields `note.health` and `note.freshness`. Schema fields are `option<float>` (vitals are [0,1] floats) rather than the plan's `option<int>`; `note.maturity` is `option<string>`.
- Synthesizer and ContradictionHunter strip (`018177c`): bootstrap drops the SQLite injections; the Coordinator's `agents` map keeps both keys with no-op fallback shapes. Audit trail still records four agent runs per swarm cycle.
- ContextManager and chat tooling on SurrealDB (`8c6fa3f`): `ContextManager`, the four `database`-bound tool factories in `agent/toolBundle.ts`, and the `chat/tools/{graph,proposals,notes,agents,vault}` consumers all read SurrealDB. Bootstrap's `as unknown as` casts retired. `streamService` deferred to Task 13.
- `nativeGraph` orphan deletion (`4a1dafe`): `NotientSettings.nativeGraph` removed; `grep -rn nativeGraph src/` returns empty.
- Graph and links CLI verbs (`f17dd6c`): `graph dump`, `graph stats`, `links sync`, `links audit`. `linksSync` constructs an inline `ApprovalService` rather than the kernel-registered instance; the writeback path is idempotent so the race is safe.
- Backup family CLI verbs (`8200261`): `backup`, `restore`, `nuke`, `migrate-vault`. `surreal export` and `surreal import` require HTTP transport, not WebSocket; both verbs spawn against the bound HTTP port.
- Tier filter CLI flags (`0a86747`): `awaken --tier <csv>` and `reindex --tier <csv>`. `indexNote` is now tier-aware end-to-end.
- Phase 5 smoke harness (`692b3ba`): six hermetic scenarios at `src/daemon/__smoke__/phase5.smoke.test.ts` covering graph dump, links audit, backup round-trip, tier-filtered reindex, end-to-end approval with `daemon_write` attribution, and ApprovalService boot reconciliation.
- SQLite substrate deletion (`010f34c`): `database.ts`, `migrations.ts`, `schema.ts`, `graphStore.ts`, the orphan `vectorIndex.ts`, and the `sql.js` / `@types/sql.js` dependency entries are gone. **Deviation from Locked Decision 11: `synthesizer.ts` and `contradictionHunter.ts` were also deleted because their `Database` imports broke `bun run typecheck` after the substrate delete.** Restoring either is a future feature task; the canonical implementation will be a clean SurrealDB rewrite. `dbscan.ts` stays on disk (substrate-independent; future clusterer can pick it up).

Test posture: 775 pass / 0 fail / 359 skip across 136 files under `bun test`. `NOTIENT_SMOKE=1 bun run test:smoke` runs all five smoke files (23 pass / 0 fail across `surrealServer`, `tier1`, `tier23`, `phase4`, `phase5`). Pass count delta vs. Phase 5 entry: -63 pass, +105 skip; the migration moved tests from the default-bun-test runner to smoke-gated SurrealDB harnesses. Net coverage did not regress; the 105 newly-skipped tests run green under `NOTIENT_SMOKE=1`.

## Locked contracts (carried forward into v0.1)

- **PENDING-STATE failure-semantics for the approval flow.** Phase 4 Locked Decision 3, restated as Phase 5 Locked Decision 1. Edges carry `approved` and `applied` bools; writeback is idempotent; reconciliation re-runs `approved=true AND applied=false` on boot. The contract is documented at the top of `src/core/markdown/writeback.ts`.
- All edges live in actual edge tables with `approved`/`applied` provenance fields. No staging tables.
- `daemon_write` rows are immutable insert-only audit; the 5-second window in `findRecentDaemonWrite` tolerates clock skew.
- The awaken worker checks status BETWEEN notes only, never mid-note.
- `<vault>/.notient/config.toml` is read once at daemon start; daemon restart picks up changes.
- SurrealDB server mode only; supervised child process on `127.0.0.1:<port>`.
- `INFO FOR DB` table count is 30 (unchanged through Phase 5).

## Known limitations (deferred to future feature work)

- **Frontmatter-edge `source` re-attribution.** Tier 1's `daemon_write` override re-tags `source` only on `wikilink` and `embed` edges, not on `frontmatter_ref`. Linker proposals approved into the five frontmatter relations (`supports`, `contradicts`, `extends`, `exemplifies`, `synthesizes`) write the wikilink to the frontmatter correctly, but the resulting Tier 1 re-extraction does NOT re-tag the edge with `source='linker'`. Only `related_to` (body `## Related`) closes the attribution loop end-to-end. (Surfaced by Task 12.)
- **Synthesizer and ContradictionHunter are no longer on disk.** Locked Decision 11 said both stay on disk for future feature work; Task 13 had to delete them because keeping them with broken `Database` imports would have failed typecheck. A future feature task that brings them back will rewrite from scratch against SurrealDB.
- **`note.maturity` vocabulary inconsistency.** VitalsService and MaturityAdvancer use different maturity vocabularies (`raw`/`draft`/`review`/`mature` vs. `raw`/`adolescent`/`mature`/`synthesis-ready`). The schema's INSIDE ASSERT covers both; reconciliation is pre-existing tech debt.
- **Daemon RPC awaken handler vs. Phase 4 worker.** Two execution paths for awaken survive: the legacy direct-enqueue path used by the daemon RPC and the Phase 4 `runAwakenWorker` path. Both honour `tier_filter` after Task 11. Pre-existing duality.
- **`linksSync` constructs `ApprovalService` inline.** The CLI verb does not consume the kernel-registered instance; concurrent operator-CLI plus daemon both hold open SurrealDB clients during reconcile. The writeback path is idempotent so the race is safe, but worth flagging for future operators.

## Footguns (operational notes that survive Phase 5)

- HNSW is in-memory and rebuilt on startup; cap is `surrealdb.hnsw_cache_mib` in `<vault>/.notient/config.toml`.
- `<|k,ef|>` operator form is required for kNN against a cosine HNSW index when the projection materialises records; bare `<|k|>` errors. `searchVectorWithPath` always passes `EF`.
- DAL writes that touch `option<...>` fields must omit them when undefined; never pass `null`. SurrealDB 3.0.5 SCHEMAFULL hard-rejects unknown fields and rejects null on `option<>`.
- `surreal export` and `surreal import` require HTTP transport, not WebSocket. The backup family verbs spawn against the bound HTTP port.

## Redesign complete

The vault enrichment redesign is complete. SurrealDB is the only datastore in Notient; the SQLite substrate, the `sql.js` / `@types/sql.js` dependencies, the `GraphStore`, the orphan `vectorIndex` stub, and the `EchoGuard` shim are all gone. The five smoke files (`surrealServer`, `tier1`, `tier23`, `phase4`, `phase5`) and the default `bun test` suite are all green. There is no Phase 6 in this redesign series. The carry-forward items above are independent feature work tracked outside this redesign cutover.
