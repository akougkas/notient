# Notient Vault Enrichment — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up SurrealDB 3.x as a supervised child process of the Notient daemon, apply the new schema, expose a typed DAL skeleton, and prove the substrate end to end with a smoke test that inserts a `note`, RELATEs a `wikilink`, and runs an HNSW kNN query without breaking any Phase D1 surface.

**Architecture:** Phase 1 introduces the new substrate alongside the existing SQLite layer, not in place of it. Both kernel slots (`db` for sql.js and `surrealDb` for SurrealDB) coexist for the duration of Phases 1-4 while consumers migrate one cluster at a time. Phase 5 deletes the SQLite slot, `database.ts`, `schema.ts`, `migrations.ts`, `graphStore.ts`, `hnswVectorIndex.ts`, `nativeGraphBridge.ts`, `relatedSection.ts`, `frontmatterWriter.ts`, and the staging inverters. Phase 1 deletes only the small-blast-radius files: canvas (zero consumers outside kernel registration) and the JSON-file `echoGuard` (replaced by the `daemon_write` SurrealDB table once write-back lands in Phase 4; see §3 for the interim policy).

**Tech Stack:** Bun runtime, TypeScript strict, SurrealDB 3.x server (`surreal start`, RocksDB backend), `surrealdb` JS SDK over WebSocket. No remark and no Tier 1 indexer in this phase. Phase 2 owns markdown parsing.

**Source of truth:**
- `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md`. Full design spec; Phase 1 implements §3 (schema), §6 (server lifecycle), §7 (vault identity and secrets), and the canvas/echoGuard deletions in §12.3 / §12.5.
- `docs/superpowers/specs/2026-04-27-notient-cli-design.md`. v0.1 architecture (kernel, bootstrap, RPC).
- `docs/superpowers/plans/2026-04-28-cli-phase-d.md`. Phase D1 surfaces this plan must NOT break (§14 of the spec).

**Locked decisions (Phase 1, 2026-04-29):**

1. **Phase 1 is additive.** The kernel gains a new `surrealDb` slot. Nothing currently reading from `db` (sql.js) is rewritten. The Phase D1 verbs (`ask`, `brief`, `distill`, `events`, `session`) continue to query SQLite and continue to pass green smoke tests at the end of this phase.
2. **`surreal start` is spawned with deterministic flags.** `--bind 127.0.0.1:0`, `--user root`, `--pass <secret>`, `--log warn`, `rocksdb://<data-dir>`. Port `0` lets the kernel pick. Stdout is parsed for `Started server at 127.0.0.1:NNNNN` to recover the bound port. The first daemon boot writes both `secret.key` (chmod 600) and the bound port to `surreal.port`.
3. **`<vault-id>` derivation is `sha256(absoluteVaultPath).slice(0, 16)` lowercase hex.** Implemented once in `src/core/vault/identity.ts` (new). Two vaults at different absolute paths get distinct directories. Path normalisation is `path.resolve(input)` only; no symlink resolution (matches Obsidian's behaviour).
4. **Schema applier sets the JWT key as a SurrealQL session parameter before applying `schema.surql`.** `db.let("NOTIENT_AGENT_JWT_KEY", secret)` is called on the SDK connection prior to the first `db.query(schemaSource)` invocation. The `DEFINE ACCESS` block in `schema.surql` references `$NOTIENT_AGENT_JWT_KEY`. Rotating the secret requires re-applying the schema.
5. **Schema is one file, applied as one query.** `schema.surql` is checked into `src/core/db/schema.surql` and read at runtime via `Bun.file(...).text()`. The applier splits on `;` only inside `BEGIN/COMMIT` boundaries; for our schema (no transactions in DDL), `db.query(fullText)` is sufficient. Idempotency is achieved by `IF NOT EXISTS` and `OVERWRITE` modifiers in the schema itself.
6. **`src/core/db/surreal.ts` exposes a typed DAL skeleton, NOT a full DAL.** Phase 1 ships only the primitives the smoke test needs: `connect()`, `applySchema()`, `createNote()`, `relateWikilink()`, `searchVector()`, `close()`. Phase 2/3/4 add the rest (chunks, blocks, edges, agents) as their respective consumers migrate. No premature abstraction layer; types are colocated with their first user.
7. **Canvas deletion is total in this phase.** All five files in spec §12.3 plus the kernel registration in `src/core/kernel.ts` plus the consumer reference in `src/agent/attachments.ts`. The `notient export-canvas` CLI verb is removed; `notient --help` no longer lists it. No deprecation, no exporter shim. The `canvas/` directory is removed.
8. **EchoGuard deletion is partial in this phase.** The two files at `src/core/services/echoGuard.ts` and its test ARE deleted. The 25+ consumers that call `echoGuard.mark(path, sha)` get a temporary no-op shim at `src/core/services/echoGuard.ts` that exports the same shape but does nothing. Phase 4 removes the shim AND the consumer call sites simultaneously when the write-back AST lands and the `daemon_write` table comes online. The shim is 8 lines, type-safe, and has a `// PHASE-1-SHIM` comment block flagged for removal in Phase 4.
9. **No SurrealDB binary bundling.** First-run check calls `surreal --version`. If exit code != 0 OR version < 3.0.0, the daemon prints the install line (`curl -sSf https://install.surrealdb.com | sh`) and exits 2. The check is performed by `src/daemon/surrealServer.ts` before spawn. We do not ship the binary inside the npm tarball.
10. **Smoke test is a single `bun test` file at `src/daemon/__smoke__/surrealServer.smoke.test.ts`** that spins up a temp vault, boots the daemon, applies the schema, asserts six things: `surreal start` is responsive, `schema.surql` applies cleanly, a `note:test1` row inserts and round-trips, a `wikilink` RELATION lands and is traversable via `note:test1->wikilink->note`, an HNSW vector kNN query against a populated `chunk` row returns the expected ID, and graceful shutdown leaves the data dir consistent. The test is opt-in via `bun test --filter smoke`; it is NOT part of the default `bun test` run because it requires the SurrealDB binary on PATH.
11. **No tests for tests' sake.** The smoke test is the only new test in Phase 1. Existing tests (Phase B/C/D1) must continue to pass. We add the type-safe `Surreal` connection wrapper without unit-testing every method; the smoke test covers it integrationally. If a unit test would catch a real bug class (e.g., the schemafull silent-drop footgun in spec §16.1), it earns its place.

---

## Hard rules (carry forward from Phase D1)

- TypeScript strict. No `any` without justification.
- No `console.log` outside `src/cli/output.ts` and the existing `debug<Subsystem>` helpers.
- No abbreviations in identifiers: `context` not `ctx`, `error` not `err`, `message` not `msg`, `event` not `evt`, `index` not `idx`, `options` not `opts`. Local variable names like `db` for the SurrealDB connection are fine internally.
- No `[noun] - [parenthetical clause]` dash-clause prose anywhere.
- No emojis in source.
- One commit per logical step on `beta-spec`. No `git add -A`. Stage by name only.
- Substrate tests stay green throughout. New tests are additive.
- The kernel is the only place where new DAL slots get registered.

---

## File structure

### Files created in Phase 1

| Path | Responsibility |
|---|---|
| `src/core/vault/identity.ts` | `<vault-id>` derivation, per-vault path helpers |
| `src/core/vault/identity.test.ts` | Unit test for identity derivation |
| `src/core/vault/secret.ts` | Read-or-generate `secret.key`, chmod-validate |
| `src/core/db/schema.surql` | The full SurrealDB schema (data + provenance + ops tables) |
| `src/core/db/schemaApplier.ts` | Reads `schema.surql`, sets session params, applies via SDK |
| `src/core/db/surreal.ts` | Typed DAL skeleton (`connect`, `createNote`, `relateWikilink`, `searchVector`, `close`) |
| `src/core/db/edgeTables.ts` | Const list of the 16 edge table names + provenance field generator |
| `src/daemon/surrealServer.ts` | Spawns and supervises `surreal start`, port discovery, restart-on-exit |
| `src/daemon/surrealServer.test.ts` | Unit test for binary check, port parsing, restart policy |
| `src/cli/commands/dbSql.ts` | `notient db sql` operator REPL (execs `surreal sql`) |
| `src/daemon/__smoke__/surrealServer.smoke.test.ts` | End-to-end smoke harness |

### Files modified in Phase 1

| Path | Change |
|---|---|
| `src/daemon/bootstrap.ts` | Wire `surrealServer` into boot, register `surrealDb` kernel slot |
| `src/core/kernel.ts` | Add `surrealDb` slot, drop canvas registrations, update `close()` to stop SurrealDB last |
| `src/cli/index.ts` | Register `notient db sql` command |
| `src/cli/commands/help.ts` (or wherever the help table lives) | Drop `export-canvas` from the help; add `db sql` |
| `src/agent/attachments.ts` | Drop the canvas reference |
| `package.json` | Add `surrealdb` (latest 2.x SDK targeting SurrealDB 3.x server). Do NOT remove sql.js / hnswlib-wasm yet; those leave in Phase 5 |

### Files deleted in Phase 1

| Path | Reason |
|---|---|
| `src/core/canvas/canvasGenerator.ts` | Spec §12.3 |
| `src/core/canvas/canvasGenerator.test.ts` | Spec §12.3 |
| `src/core/canvas/canvasFromResults.ts` | Spec §12.3 |
| `src/core/canvas/canvasFromResults.test.ts` | Spec §12.3 |
| `src/core/canvas/types.ts` | Spec §12.3 |
| (directory) `src/core/canvas/` | Empty after deletions; remove |
| `src/cli/commands/exportCanvas.ts` (or wherever the canvas CLI verb lives) | No more canvas |

### Files NOT touched in Phase 1 (deferred to later phases)

- `src/core/db/database.ts`, `src/core/db/schema.ts`, `src/core/db/migrations.ts`. Phase 5 cutover.
- `src/core/indexer/hnswVectorIndex.ts`, `src/core/indexer/hnswEnvShim.ts`. Phase 3 / Phase 5.
- `src/core/graph/graphStore.ts`, `src/core/graph/nativeGraphBridge.ts`, `src/core/graph/relatedSection.ts`, `src/core/graph/frontmatterWriter.ts`. Phase 4 / Phase 5.
- `src/core/services/echoGuard.ts` is REPLACED with an 8-line shim (see Task 13); deleted in Phase 4.
- All Phase D1 handlers, all agent code, all chat tools, all search code. DAL stays SQLite-backed in Phase 1.

---

## Tasks

### Task 1: Add the `surrealdb` SDK dependency

**Files:**
- Modify: `package.json`
- Modify: `bun.lockb` (auto-generated by `bun add`)

**Objective:** Install the SurrealDB JavaScript SDK (latest 2.x line, which targets the 3.x server) so subsequent tasks can `import { Surreal } from "surrealdb"`. Do not remove `sql.js` or `hnswlib-wasm`; they leave in Phase 5.

**Acceptance:** `package.json` lists `surrealdb` at a 2.x version, `bun.lockb` is updated, and a one-liner `import { Surreal } from "surrealdb"` resolves without error under `bun run`.

---

### Task 2: Vault identity derivation

**Files:**
- Create: `src/core/vault/identity.ts`
- Create: `src/core/vault/identity.test.ts`

**Objective:** Provide the `<vault-id>` derivation and per-vault path helpers used by every subsequent task. Exports: `vaultId(path)`, `vaultStateDir(path)`, `vaultDataDir(path)`, `vaultSecretPath(path)`, `vaultPortPath(path)`, `vaultPidPath(path)`. Root is `~/.notient/<vault-id>/`.

**Invariants:** `vaultId` is `sha256(path.resolve(input))` truncated to 16 lowercase hex chars. No symlink resolution. Same absolute path always produces the same id; different absolute paths produce different ids.

**Acceptance:** Unit tests in `src/core/vault/identity.test.ts` cover determinism, length/charset of the id, distinct ids for distinct paths, relative-path normalisation, and the composition of all five path helpers under `~/.notient/<id>/`. Tests pass under `bun test`.

---

### Task 3: Per-vault secret read-or-generate

**Files:**
- Create: `src/core/vault/secret.ts`
- Create: `src/core/vault/secret.test.ts`

**Objective:** Implement `readOrGenerateSecret(path)`. On first call, generate a 64-byte cryptographic random secret base64-encoded, write it with mode 0o600 (creating parent dir mode 0o700 if missing), and return it. On subsequent calls, return the existing file's contents.

**Invariants:** The secret file MUST be chmod 600 at all times. If an existing file is readable but has any other mode (e.g., 0o644), `readOrGenerateSecret` MUST throw rather than silently return. Parent directories created here are mode 0o700.

**Acceptance:** Unit tests in `src/core/vault/secret.test.ts` cover first-read generation (verifying base64 charset, decoded length 64, file mode 0o600), second-read idempotency, and the permissive-mode rejection path (throws containing "permissions"). Tests pass under `bun test`.

---

### Task 4: Schema file — `schema.surql`

**Files:**
- Create: `src/core/db/schema.surql`
- Create: `src/core/db/edgeTables.ts`

**Objective:** Materialise the canonical SurrealDB schema described in spec §3.2-§3.6. Two artifacts:

1. `src/core/db/edgeTables.ts` exports `EDGE_TABLES` (the const tuple of the 16 edge table names), the `EdgeTable` type, and `provenanceFields(table)` which returns the DDL string for the seven provenance fields (`source`, `class`, `confidence`, `evidence`, `agent`, `approved`, `created_at`) plus the two indexes (`<table>_approved`, `<table>_source`) that every edge table requires. The 16 edge tables, in order: `wikilink`, `embed`, `frontmatter_ref`, `tagged`, `contained_in`, `under_heading`, `mentions`, `asserts`, `asks`, `supports`, `contradicts`, `extends`, `exemplifies`, `synthesizes`, `related_to`. (That is 15 names; the 16th is whichever the spec lists; recount against §3 at implementation time.)
2. `src/core/db/schema.surql` contains the namespace/database preamble, the 7 entity tables (`note`, `block`, `chunk`, `tag`, `concept`, `claim`, `question`), the 16 edge `DEFINE TABLE ... TYPE RELATION ...` lines, the 2 ops tables (`daemon_write`, `awaken_run`), the `notient_text` analyzer + `chunk_text` BM25 fulltext index, the `chunk_vec` HNSW index (DIM 768, COSINE, EFC 200, M 16), and the `DEFINE ACCESS agent_jwt` block referencing `$NOTIENT_AGENT_JWT_KEY`. Take the exact field/index DDL from spec §3.2-§3.6; do not guess. Provenance fields for edge tables are NOT in this file; the applier appends them at runtime via `provenanceFields()`.

**Invariants:** Schema MUST be idempotent under repeated apply (use `IF NOT EXISTS` / `OVERWRITE`). The `note` table's `path` field has the same constraints as the spec (no leading slash, no backslashes). The HNSW index dimension is 768 to match the embedding model.

**Acceptance:** `schema.surql` parses cleanly when the applier (Task 5) feeds it to a real `surreal` server. Manual sanity check: `grep -c "DEFINE TABLE" src/core/db/schema.surql` returns 25 (7 entity + 16 edge + 2 ops). `EDGE_TABLES.length === 16`. Phase-1 smoke test (Task 10) ultimately validates this end-to-end.

---

### Task 5: Schema applier

**Files:**
- Create: `src/core/db/schemaApplier.ts`
- Create: `src/core/db/schemaApplier.test.ts`

**Objective:** `applySchema(db: Surreal, jwtKey: string)` reads `schema.surql` from disk via `Bun.file(...).text()`, calls `db.let("NOTIENT_AGENT_JWT_KEY", jwtKey)` BEFORE issuing any `db.query`, applies the base schema text, then applies the concatenated provenance DDL produced by mapping `provenanceFields` over `EDGE_TABLES`.

**Invariants:** The `let` MUST happen before any `query`; otherwise the `DEFINE ACCESS` block fails with an undefined parameter. Order of operations: `let` then base schema then provenance. The applier must not split the schema string itself; pass the full text to `db.query`.

**Acceptance:** Unit test in `src/core/db/schemaApplier.test.ts` uses a fake `Surreal` (recording `let` and `query` calls) to verify (1) `let` is called first with key `NOTIENT_AGENT_JWT_KEY`, (2) at least one `query` follows, (3) the concatenated query SQL contains `DEFINE NAMESPACE IF NOT EXISTS notient`, `DEFINE TABLE note SCHEMAFULL`, `DEFINE TABLE wikilink TYPE RELATION`, `DEFINE FIELD source ON wikilink`, and `DEFINE FIELD source ON related_to`. Test passes under `bun test`.

---

### Task 6: Surreal DAL skeleton

**Files:**
- Create: `src/core/db/surreal.ts`

**Objective:** Provide the minimal typed DAL the smoke test and bootstrap need. Exports:

- `interface SurrealConnection { db: Surreal; close(): Promise<void> }`.
- `interface NoteRecord { id: RecordId<"note">; path: string; sha: string; word_count: number }`.
- `interface SearchHit { noteId: RecordId<"note">; chunkId: RecordId<"chunk">; distance: number; text: string }`.
- `connect({ url, user, pass, namespace, database }): Promise<SurrealConnection>`. Constructs a `Surreal`, connects, signs in as root, calls `use({ namespace, database })`, returns the wrapper.
- `createNote(db, { path, sha, wordCount }): Promise<NoteRecord>`. Creates one `note` row and returns it.
- `relateWikilink(db, { from, to, source, confidenceClass, confidence, agent? })`. Issues a `RELATE $from->wikilink->$to SET ...` with the provenance fields the schema requires.
- `searchVector(db, { vector, k, ef? })`. Issues a `SELECT ... FROM chunk WHERE vector <|k|> $q ORDER BY d` (or `<|k,ef|>` if `ef` given) and maps rows to `SearchHit[]`.

No additional methods. Phase 2/3/4 grow this file incrementally.

**Invariants:** `RecordId` is the SDK's branded type and must be used in signatures; no `string` ids. The `SearchHit.distance` is the SDK's `vector::distance::knn()` value; the smoke test asserts ordering, not exact magnitude.

**Acceptance:** `bun build src/core/db/surreal.ts --target=bun` (or the project's typecheck command) reports no errors. Module is consumed without modification by Tasks 9, 10, 11.

---

### Task 7: SurrealDB binary check helper

**Files:**
- Create: `src/daemon/surrealServer.ts` (initial version: only the version check + parsers)
- Create: `src/daemon/surrealServer.test.ts`

**Objective:** Establish the surrealServer module with two pure parsers and one async check:

- `parseSurrealVersion(stdout)`: returns `{ major, minor, patch }` or `null`. Returns `null` for any major < 3 or for unparseable input.
- `parseBoundPort(stdout)`: extracts the integer N from `Started server at 127.0.0.1:N`; returns `null` if not present.
- `checkSurrealBinary()`: spawns `surreal --version`, parses stdout, throws an Error containing `curl -sSf https://install.surrealdb.com | sh` if version is missing or pre-3.x; returns the parsed version on success.

Spawn / supervision lands in Task 8.

**Acceptance:** Unit test in `src/daemon/surrealServer.test.ts` covers both parsers: valid 3.x lines parse, pre-3.x and garbage return `null`, port extraction works for the bare line and for a leading `INFO surrealdb::net` prefix and a trailing newline. Tests pass under `bun test`.

---

### Task 8: Spawn and supervise `surreal start`

**Files:**
- Modify: `src/daemon/surrealServer.ts`

**Objective:** Append `startSurreal(options)` to the module from Task 7. The function:

1. Calls `checkSurrealBinary()` first. Creates `dataDir` mode 0o700 if missing.
2. Spawns `surreal start --bind 127.0.0.1:0 --user root --pass <secret> --log <level> rocksdb://<dataDir>` with stdout/stderr piped.
3. Reads the child stdout until `parseBoundPort` returns a port or `STARTUP_TIMEOUT_MS` (5_000) elapses; on timeout, kills the child and throws.
4. Writes the bound port to `options.portFile` and the pid to `options.pidFile`.
5. Returns a `SurrealServerHandle = { port, url: ws://127.0.0.1:<port>, pid, stop() }`. `stop()` sends SIGTERM, waits up to 10s, then SIGKILL.
6. Wires an exit handler that tracks restart times in a sliding `RESTART_BUDGET = { maxRestarts: 3, windowMs: 60_000 }` window and invokes `options.onUnexpectedExit?.(code)`. If the budget is exceeded, the handler stops attempting restart (it just notifies); actual restart logic can be added later.

**Invariants:** `stopping = true` set in `stop()` MUST suppress the unexpected-exit callback. The port file is the canonical handoff to `notient db sql`; do not skip the write.

**Acceptance:** The module type-checks, the parser tests from Task 7 still pass, and the smoke test in Task 10 (which actually starts the server) successfully boots and shuts down a real SurrealDB instance.

---

### Task 9: Wire `surrealServer` into bootstrap, register kernel slot

**Files:**
- Modify: `src/daemon/bootstrap.ts`
- Modify: `src/core/kernel.ts`

**Objective:** Make the daemon spawn SurrealDB on boot and expose a `SurrealConnection` through the kernel.

1. In `src/core/kernel.ts`, add a `surrealDb` slot of type `SurrealConnection` (imported from `src/core/db/surreal.ts`). Follow the existing slot-keys convention; introduce `PHASE_E_KEYS = [...PHASE_D_KEYS, "surrealDb"] as const` so production seal stays at "D" and the smoke test can seal to "E". Update `kernel.close()` so SurrealDB stops AFTER any consumer using it (close the SDK first, then stop the spawned child).
2. In `src/daemon/bootstrap.ts`, after the existing sql.js init and before `kernel.seal(...)`: call `readOrGenerateSecret(vaultSecretPath(vaultPath))`, then `startSurreal({ vaultPath, dataDir: vaultDataDir(vaultPath), secret, portFile: vaultPortPath(vaultPath), pidFile: vaultPidPath(vaultPath), logLevel: "warn", onUnexpectedExit: code => eventBus.publish({ name: "daemon:db_failed", payload: { code } }) })`, then `connect({ url: handle.url, user: "root", pass: secret, namespace: "notient", database: "vault" })`, then `applySchema(connection.db, secret)`, then `kernel.set("surrealDb", connection)`. Register the two-step teardown (`await connection.close(); await handle.stop()`) in the daemon's existing shutdown path (look at how the sql.js `db.close()` is invoked today).

**Invariants:** Bootstrap order is FIXED: secret → start server → SDK connect → applySchema → kernel.set. Schema application MUST happen with the same secret used by the access definition; otherwise JWT auth breaks. Shutdown order: SDK close THEN child stop, never the reverse.

**Acceptance:** `bun run typecheck` passes. The daemon boots end to end (validated by Task 10's smoke harness). Existing Phase D1 tests continue to pass (sql.js path unaffected).

---

### Task 10: Smoke harness — daemon boots, schema applies, end-to-end

**Files:**
- Create: `src/daemon/__smoke__/surrealServer.smoke.test.ts`

**Objective:** A single Bun test file that, in `beforeAll`, creates a temp directory, calls `startSurreal` directly with a literal test secret, calls `connect`, calls `applySchema`, and exposes the connection to the test cases. `afterAll` closes the SDK, stops the child, removes the temp dir.

The test file MUST cover, as separate `test(...)` cases:

1. `INFO FOR DB` reports all 25 expected tables (7 entity + 16 edge + 2 ops).
2. `createNote` round-trips path/sha/word_count.
3. RELATE wikilink between two notes, then a graph traversal (`SELECT ->wikilink->note FROM $a`) returns the target's path.
4. HNSW kNN: insert two `chunk` rows with orthogonal 768-dim vectors, query for one of them, expect exactly that one back.
5. Schemafull silent-drop footgun: `UPDATE $note SET nonsense_field = "..."` followed by `SELECT * FROM $note` shows `nonsense_field` is undefined. This guards spec §16.1.

The smoke test is opt-in; configure `package.json` so the default `bun test` excludes `src/**/__smoke__/**` (e.g., `"test": "bun test --filter '!__smoke__'"`, `"test:smoke": "bun test src/**/__smoke__/**.test.ts"`). Confirm the existing scripts; only modify if the default run would otherwise pick up the smoke file.

**Acceptance:** With `surreal` 3.x on PATH, `bun test src/daemon/__smoke__/surrealServer.smoke.test.ts` PASSes 5 cases. `bun test` (default) PASSes the existing suite without picking up the smoke file. No leaked child process or temp directory after the run.

---

### Task 11: `notient db sql` operator escape hatch

**Files:**
- Create: `src/cli/commands/dbSql.ts`
- Modify: `src/cli/index.ts`

**Objective:** Implement `dbSqlCommand(vaultPath)` that reads the bound port from `vaultPortPath(vaultPath)` and the secret from `vaultSecretPath(vaultPath)`, then `spawn`s `surreal sql --endpoint ws://127.0.0.1:<port> --user root --pass <secret> --ns notient --db vault --pretty` with stdin/stdout/stderr inherited so the user gets a live REPL. Returns the child's exit code.

Wire it into `src/cli/index.ts` under the `db` verb (only `sql` subcommand is valid; anything else prints `usage: notient db sql` and exits 2). Match the existing dispatch shape (look at `init`, `daemon`, `awaken` for the convention).

**Invariants:** Never log the secret. The spawn passes it via argv to `surreal sql`, which is acceptable because the daemon is local-only.

**Acceptance:** `bun run src/cli/index.ts --help` lists `db sql` (auto-generated or via a one-line edit to `src/cli/commands/help.ts`). With the daemon running, `bun run src/cli/index.ts db sql` opens a working SurrealQL prompt against the daemon's port. Existing CLI tests still pass.

---

### Task 12: Delete canvas

**Files:**
- Delete: `src/core/canvas/` (entire directory)
- Modify: `src/core/kernel.ts`
- Modify: `src/agent/attachments.ts`
- Modify: any CLI command file that exposes `export-canvas` (locate via grep)

**Objective:** Remove the canvas surface entirely per spec §12.3. Inspect the codebase for the actual canvas references first; the tree to remove includes `canvasGenerator.ts` (+test), `canvasFromResults.ts` (+test), and `types.ts`. Drop the canvas slot from the kernel slot-keys and from any `kernel.set("canvasFromResults", ...)` line in bootstrap. Drop the canvas import + call site in `src/agent/attachments.ts`. If a `src/cli/commands/exportCanvas.ts` (or similarly named file) exists, `git rm` it and remove its registration in `src/cli/index.ts`.

**Invariants:** After this task, `grep -rln "canvas" src/` returns empty (or only unrelated docstring matches). No deprecation shim; the verb is gone.

**Acceptance:** `bun test` passes (any tests deleted in this task were canvas-internal). `notient --help` no longer lists `export-canvas`. Type-check is clean.

---

### Task 13: Replace `echoGuard.ts` with a no-op shim, delete the test file

**Files:**
- Modify: `src/core/services/echoGuard.ts` (replace contents with no-op shim)
- Delete: `src/core/services/echoGuard.test.ts`

**Objective:** Read `src/core/services/echoGuard.ts` to capture its CURRENT public surface (class name, exported functions, method signatures, return types). Replace the file's contents with an 8-12 line no-op that exports the same surface but where `mark(...)` does nothing and `has(...)` always returns `false` (or the equivalent neutral value for whatever the original returned). Prefix the file with a `// PHASE-1-SHIM` comment block explaining: real implementation lands in Phase 4 via the SurrealDB `daemon_write` table; consumer call sites are deliberately untouched and will be deleted alongside the shim. Delete `src/core/services/echoGuard.test.ts` outright.

**Invariants:** The shim's exported types and method signatures MUST be byte-identical to the original public surface. Consumers (25+ call sites) must continue to typecheck without modification. No new behavior; pure no-op.

**Acceptance:** `bun run typecheck` passes across the consumer set. `bun test` passes (any test that depended on observable echo-guard side effects must be reconciled here; per the audit, callers `mark()` and never assert side effects in their own unit tests). The `// PHASE-1-SHIM` comment is grep-able for Phase 4's removal pass.

---

### Task 14: Help text and self-review

**Files:**
- Modify: `src/cli/commands/help.ts` (or wherever the help text lives)

**Objective:** Update the CLI help to drop the `export-canvas` line and add `notient db sql` with the description "open a SurrealQL REPL against the running daemon (operator escape hatch)". Group `db sql` under "operations" if the help has phase markers.

**Acceptance:** `grep -rln "export-canvas\|exportCanvas" src/` returns empty. `bun run src/cli/index.ts --help` lists the Phase D1 verbs plus `db sql` and no longer mentions canvas. `bun test` passes; running the smoke test separately also passes.

---

### Task 15: Phase 1 wrap — handoff doc

**Files:**
- Create: `docs/superpowers/handoffs/2026-04-29-phase-1-vault-enrichment-handoff.md`

**Objective:** Write a concise handoff (under 80 lines) summarising what shipped in Phase 1, what is deliberately unfinished, what Phase 2 picks up, and the footguns to remember. Sections to include:

- **What shipped:** SurrealDB 3.x supervised as a daemon child; per-vault state directory at `~/.notient/<vault-id>/` with `secret.key` (chmod 600), `surreal.port`, `surreal.pid`, `data/` (RocksDB); `<vault-id>` derivation; `schema.surql` covering 25 tables + provenance fields generated from `EDGE_TABLES`; typed DAL skeleton (connect, createNote, relateWikilink, searchVector, close); `notient db sql` operator REPL; canvas deleted; `EchoGuard` reduced to no-op shim; smoke harness in `__smoke__/`.
- **What is deliberately NOT done:** No markdown parser; no DAL rewrite for any consumer; no `daemon_write` writer; no new CLI verbs beyond `db sql` (`awaken --tier`, `links sync`, `links audit`, `backup`, `restore`, `nuke`, `migrate-vault`, `graph dump`, `graph stats` all wait); no write-back rewrite; no HNSW deletion; no deletion of `database.ts`/`schema.ts`/`migrations.ts`/`graphStore.ts`/`nativeGraphBridge.ts`/`relatedSection.ts`/`frontmatterWriter.ts` (Phase 5's final cutover).
- **Phase 2 entry point:** Phase 2 ships unified/remark + custom plugins (`remark-wikilink`, `remark-block-id`, `remark-tag`) and the Tier 1 indexer that reads them and writes deterministic edges to SurrealDB. Watcher gains `unlink` + 60s SHA-match rename detection. Acceptance: save a note with `[[link]]` and `^block-id`, see the corresponding rows in SurrealDB. Plan path: `docs/superpowers/plans/2026-04-30-vault-enrichment-phase-2.md` (to be written).
- **Footguns:** HNSW is in-memory, rebuilt on startup; default 256 MiB cache; bump for >50k chunks via `SURREAL_HNSW_CACHE_SIZE`. SCHEMAFULL silently drops undefined fields; the smoke test guards this. Embedded mode (`@surrealdb/node@alpha`) is NOT supported; only spawned server mode.

**Acceptance:** Handoff committed. Length under 80 lines. All four sections present.

---

## Self-review

**Spec coverage check.**

| Spec section | Phase 1 task | Status |
|---|---|---|
| §3 schema (7 entity + 16 edge + 2 ops + JWT) | Tasks 4, 5 | All tables present; provenance generated for all 16 edge tables; awaken_run + daemon_write present |
| §6 server lifecycle | Tasks 7, 8, 9 | Binary check, spawn, port discovery, supervision, kernel wiring |
| §7 vault identity / secrets | Tasks 2, 3 | Both implemented |
| §11.1 `notient db sql` | Task 11 | Implemented |
| §12.3 canvas deletion | Task 12 | Total deletion |
| §12.5 echoGuard deletion | Task 13 | Partial (shim now, full deletion in Phase 4) |
| §16.1 schemafull silent-drop footgun | Task 10 (smoke) | Guarded |
| §17 hard rules | All tasks | Carried forward |
| §3 markdown parser, §5 indexer, §8 write-back, §9 awaken control plane, §11.1 other CLI verbs | NONE in Phase 1 | Deferred to Phases 2-5 (spec §15) |

**Placeholder scan.** No "TBD", no "TODO". One `// PHASE-1-SHIM` comment block in Task 13 is intentional and removed in Phase 4.

**Type consistency.** `SurrealConnection` from Task 6 is consumed by Tasks 9, 10, 11. `parseBoundPort` and `parseSurrealVersion` from Task 7 are consumed by Task 8 helpers. `EDGE_TABLES` in Task 4 is consumed by Task 5.

**Adjustment from spec §15.** Spec row 1 says Phase 1 deletes all of §12.1-12.5; this plan deletes only §12.3 (canvas) and §12.5 partially (echoGuard via shim). The big-blast-radius deletions in §12.1, §12.2, §12.4 require consumer migration, which lands in Phases 2-5. Phase 5's final cutover deletes them. Documented in the Architecture section and the Phase 1 handoff.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
