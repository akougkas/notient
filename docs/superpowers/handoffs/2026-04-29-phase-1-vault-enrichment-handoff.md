# Phase 1 — Vault Enrichment Handoff

Date: 2026-04-29. Branch: `beta-spec`. Plan: `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-1.md`. Spec: `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md`.

## What shipped

- SurrealDB 3.x supervised as a daemon child via `src/daemon/surrealServer.ts` (`startSurreal`, `checkSurrealBinary`, `parseSurrealVersion`, `parseBoundPort`, `STARTUP_TIMEOUT_MS`, `STOP_TIMEOUT_MS`, `RESTART_BUDGET`).
- Per-vault state at `~/.notient/<vault-id>/` with `secret.key` (chmod 600), `surreal.port`, `surreal.pid`, `data/` (RocksDB).
- `<vault-id> = sha256(path.resolve(input))[..16]` in `src/core/vault/identity.ts`. `readOrGenerateSecret` in `src/core/vault/secret.ts`.
- `src/core/db/schema.surql` covering 24 tables (7 entity + 15 edge + 2 ops) with `OVERWRITE` idempotency. Provenance fields generated at apply time from `EDGE_TABLES` in `src/core/db/edgeTables.ts`.
- `src/core/db/schemaApplier.ts` sets `NOTIENT_AGENT_JWT_KEY` via `db.set` before applying schema and provenance.
- Typed DAL skeleton in `src/core/db/surreal.ts`: `connect`, `createNote`, `relateWikilink`, `searchVector`, `close`. `RecordId` everywhere; no string ids in public types.
- Bootstrap wiring: secret → start server → SDK connect → applySchema → `kernel.register("surrealDb", ...)`. Optional `skipSurreal` opt-out for tests. Two-step teardown (SDK close, then child stop) ahead of existing sql.js teardown.
- `notient db sql` operator REPL in `src/cli/commands/dbSql.ts` plus dispatcher and help-list entry in `src/cli/index.ts`.
- Canvas surface deleted (5 files + kernel slot + attachments dispatch).
- `EchoGuard` reduced to a no-op shim with the original public surface; `echoGuard.test.ts` deleted; one consumer test (`maturityAdvancer.test.ts:83`) flipped to expect the shim's `false`. Every change tagged `PHASE-1-SHIM`.
- Smoke harness at `src/daemon/__smoke__/surrealServer.smoke.test.ts` with five cases: `INFO FOR DB` table count, `createNote` round-trip, RELATE+traversal, HNSW kNN, schemafull rejection of unknown fields. Gated by `NOTIENT_SMOKE=1`; run via `bun run test:smoke`. Default `bun test` is unaffected (smoke describe block reports as skipped).

Test posture at end of phase: 886 pass / 7 skip / 0 fail / 2186 expects across 119 files. Smoke 5/5.

## What is deliberately NOT done

- No markdown parser. No remark, no `remark-wikilink`/`remark-block-id`/`remark-tag`, no Tier 1 indexer.
- No DAL rewrite for any consumer. Phase D1 verbs (`ask`, `brief`, `distill`, `events`, `session`) still query SQLite.
- No `daemon_write` writer. Echo provenance is unimplemented; the shim makes `take` always return `false`.
- No new CLI verbs beyond `db sql`. `awaken --tier`, `links sync`, `links audit`, `backup`, `restore`, `nuke`, `migrate-vault`, `graph dump`, `graph stats` all wait.
- No write-back rewrite, no AST-aware writer, no HNSW deletion.
- No deletion of `database.ts` / `schema.ts` / `migrations.ts` / `graphStore.ts` / `nativeGraphBridge.ts` / `relatedSection.ts` / `frontmatterWriter.ts`. Phase 5 owns the final cutover.
- No `PHASE_D_KEYS` / `PHASE_E_KEYS` introduced. The plan referenced them, but production today seals at phase `"C"` and the new `surrealDb` slot is registered as optional alongside `visionLLM`. Smoke test bypasses the kernel entirely, so phase keys did not need extending.

## Phase 2 entry point

Phase 2 ships the unified/remark pipeline (`remark-parse`, `remark-frontmatter`, `remark-gfm`, plus `remark-wikilink`, `remark-block-id`, `remark-tag`) and the Tier 1 indexer that writes deterministic edges to SurrealDB. The watcher gains `unlink` plus 60s SHA-match rename detection. Acceptance: save a note with `[[link]]` and `^block-id`; the corresponding rows land in SurrealDB. Plan path: `docs/superpowers/plans/2026-04-30-vault-enrichment-phase-2.md` (to be written).

## Footguns

- HNSW is in-memory and rebuilt on startup. Default cache is 256 MiB; bump `SURREAL_HNSW_CACHE_SIZE` for vaults beyond ~50k chunks.
- SurrealDB 3.0.5 hardened SCHEMAFULL: undefined fields now error rather than silently drop. Spec §16.1 anticipated silent drops; the smoke test was adapted to assert the rejection. The footgun is now a guardrail.
- `surreal start --bind 127.0.0.1:0` does not log the OS-assigned port at `--log warn` (and the log message changed from "Started server at" to "Started web server on" with the bind argument echoed). `startSurreal` pre-allocates a port via `node:net` and passes it to surreal explicitly, then polls TCP connect for readiness. The `parseBoundPort` helper remains exported but is dead code under current surreal versions.
- Embedded SurrealDB (`@surrealdb/node@alpha`) is not supported. Server mode only.
- The DAL's `relateWikilink` omits the `agent` field when `undefined`; passing it as `null` would fail because the schema's `option<string>` rejects `NULL`. New DAL methods should follow the same pattern when writing optional fields.
- HNSW kNN against the cosine index requires the `<|k,ef|>` operator form. The unparameterised `<|k|>` form errors with "KNN operators nested in OR/NOT...". Always pass `ef` (the smoke test uses `ef: 200`).
