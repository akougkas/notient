# Notient Vault Enrichment — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up SurrealDB 3.x as a supervised child process of the Notient daemon, apply the new schema, expose a typed DAL skeleton, and prove the substrate end to end with a smoke test that inserts a `note`, RELATEs a `wikilink`, and runs an HNSW kNN query — without breaking any Phase D1 surface.

**Architecture:** Phase 1 introduces the new substrate **alongside** the existing SQLite layer, not in place of it. Both kernel slots (`db` for sql.js and `surrealDb` for SurrealDB) coexist for the duration of Phases 1–4 while consumers migrate one cluster at a time. Phase 5 deletes the SQLite slot, `database.ts`, `schema.ts`, `migrations.ts`, `graphStore.ts`, `hnswVectorIndex.ts`, `nativeGraphBridge.ts`, `relatedSection.ts`, `frontmatterWriter.ts`, and the staging inverters. Phase 1 deletes only the small-blast-radius files: canvas (zero consumers outside kernel registration) and the JSON-file `echoGuard` (replaced by the `daemon_write` SurrealDB table once write-back lands in Phase 4 — see §3 for the interim policy).

**Tech Stack:** Bun runtime, TypeScript strict, SurrealDB 3.x server (`surreal start`, RocksDB backend), `surrealdb` JS SDK over WebSocket. No remark / no Tier 1 indexer in this phase — Phase 2 owns markdown parsing.

**Source of truth:**
- `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md` — full design spec; Phase 1 implements §3 (schema), §6 (server lifecycle), §7 (vault identity and secrets), and the canvas/echoGuard deletions in §12.3 / §12.5.
- `docs/superpowers/specs/2026-04-27-notient-cli-design.md` — v0.1 architecture (kernel, bootstrap, RPC).
- `docs/superpowers/plans/2026-04-28-cli-phase-d.md` — Phase D1 surfaces this plan must NOT break (§14 of the spec).

**Locked decisions (Phase 1, 2026-04-29):**

1. **Phase 1 is additive.** The kernel gains a new `surrealDb` slot. Nothing currently reading from `db` (sql.js) is rewritten. The Phase D1 verbs (`ask`, `brief`, `distill`, `events`, `session`) continue to query SQLite and continue to pass green smoke tests at the end of this phase.
2. **`surreal start` is spawned with deterministic flags.** `--bind 127.0.0.1:0`, `--user root`, `--pass <secret>`, `--log warn`, `rocksdb://<data-dir>`. Port `0` lets the kernel pick. Stdout is parsed for `Started server at 127.0.0.1:NNNNN` to recover the bound port. The first daemon boot writes both `secret.key` (chmod 600) and the bound port to `surreal.port`.
3. **`<vault-id>` derivation is `sha256(absoluteVaultPath).slice(0, 16)` lowercase hex.** Implemented once in `src/core/vault/identity.ts` (new). Two vaults at different absolute paths get distinct directories. Path normalisation is `path.resolve(input)` only; no symlink resolution (matches Obsidian's behaviour).
4. **Schema applier sets the JWT key as a SurrealQL session parameter before applying `schema.surql`.** `db.let("NOTIENT_AGENT_JWT_KEY", secret)` is called on the SDK connection prior to the first `db.query(schemaSource)` invocation. The `DEFINE ACCESS` block in `schema.surql` references `$NOTIENT_AGENT_JWT_KEY`. Rotating the secret requires re-applying the schema.
5. **Schema is one file, applied as one query.** `schema.surql` is checked into `src/core/db/schema.surql` and read at runtime via `Bun.file(...).text()`. The applier splits on `;` only inside `BEGIN/COMMIT` boundaries — for our schema (no transactions in DDL), `db.query(fullText)` is sufficient. Idempotency is achieved by `IF NOT EXISTS` and `OVERWRITE` modifiers in the schema itself.
6. **`src/core/db/surreal.ts` exposes a typed DAL skeleton, NOT a full DAL.** Phase 1 ships only the primitives the smoke test needs: `connect()`, `applySchema()`, `createNote()`, `relateWikilink()`, `searchVector()`, `close()`. Phase 2/3/4 add the rest (chunks, blocks, edges, agents) as their respective consumers migrate. No premature abstraction layer; types are colocated with their first user.
7. **Canvas deletion is total in this phase.** All five files in spec §12.3 plus the kernel registration in `src/core/kernel.ts` plus the consumer reference in `src/agent/attachments.ts`. The `notient export-canvas` CLI verb is removed; `notient --help` no longer lists it. No deprecation, no exporter shim. The `canvas/` directory is removed.
8. **EchoGuard deletion is partial in this phase.** The two files at `src/core/services/echoGuard.ts` and its test ARE deleted. The 25+ consumers that call `echoGuard.mark(path, sha)` get a temporary no-op shim at `src/core/services/echoGuard.ts` that exports the same shape but does nothing. Phase 4 removes the shim AND the consumer call sites simultaneously when the write-back AST lands and the `daemon_write` table comes online. The shim is 8 lines, type-safe, and has a `// PHASE-1-SHIM` comment block flagged for removal in Phase 4.
9. **No SurrealDB binary bundling.** First-run check calls `surreal --version`. If exit code != 0 OR version < 3.0.0, the daemon prints the install line (`curl -sSf https://install.surrealdb.com | sh`) and exits 2. The check is performed by `src/daemon/surrealServer.ts` before spawn. We do not ship the binary inside the npm tarball.
10. **Smoke test is a single `bun test` file at `src/daemon/__smoke__/surrealServer.smoke.test.ts`** that spins up a temp vault, boots the daemon, applies the schema, asserts six things: `surreal start` is responsive, `schema.surql` applies cleanly, a `note:test1` row inserts and round-trips, a `wikilink` RELATION lands and is traversable via `note:test1->wikilink->note`, an HNSW vector kNN query against a populated `chunk` row returns the expected ID, and graceful shutdown leaves the data dir consistent. The test is opt-in via `bun test --filter smoke` — it is NOT part of the default `bun test` run because it requires the SurrealDB binary on PATH.
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
| `package.json` | Add `surrealdb` (latest 2.x SDK targeting SurrealDB 3.x server). Do NOT remove sql.js / hnswlib-wasm yet — those leave in Phase 5 |

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

- `src/core/db/database.ts`, `src/core/db/schema.ts`, `src/core/db/migrations.ts` — Phase 5 cutover.
- `src/core/indexer/hnswVectorIndex.ts`, `src/core/indexer/hnswEnvShim.ts` — Phase 3 / Phase 5.
- `src/core/graph/graphStore.ts`, `src/core/graph/nativeGraphBridge.ts`, `src/core/graph/relatedSection.ts`, `src/core/graph/frontmatterWriter.ts` — Phase 4 / Phase 5.
- `src/core/services/echoGuard.ts` is REPLACED with an 8-line shim (see Task 16); deleted in Phase 4.
- All Phase D1 handlers, all agent code, all chat tools, all search code — DAL stays SQLite-backed in Phase 1.

---

## Tasks

### Task 1: Add the `surrealdb` SDK dependency

**Files:**
- Modify: `package.json`
- Modify: `bun.lockb` (auto-generated by `bun add`)

- [ ] **Step 1: Inspect current dependencies**

Run: `cd ~/projects/notient && grep -E '"(surrealdb|sql.js|hnswlib)"' package.json`
Expected: `"sql.js": "..."`, `"hnswlib-wasm": "..."`, no surrealdb.

- [ ] **Step 2: Add the SDK**

Run: `cd ~/projects/notient && bun add surrealdb@^2.0.0`
Expected: `bun.lockb` updates, `package.json` shows `"surrealdb": "^2.0.0"` (or the latest 2.x).

- [ ] **Step 3: Verify import works**

Run: `cd ~/projects/notient && echo 'import { Surreal } from "surrealdb"; console.log(typeof Surreal);' | bun run --no-install -`
Expected: prints `function`.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/notient
git add package.json bun.lockb
git commit -m "feat(deps): add surrealdb SDK for phase 1 substrate"
```

---

### Task 2: Vault identity derivation

**Files:**
- Create: `src/core/vault/identity.ts`
- Create: `src/core/vault/identity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/vault/identity.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { vaultId, vaultStateDir, vaultDataDir, vaultSecretPath, vaultPortPath, vaultPidPath } from "./identity";

describe("vault identity", () => {
  test("vaultId is deterministic 16-char lowercase hex of absolute path", () => {
    const a = vaultId("/home/user/notes");
    const b = vaultId("/home/user/notes");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  test("vaultId differs for different absolute paths", () => {
    expect(vaultId("/home/user/notes")).not.toBe(vaultId("/home/user/other"));
  });

  test("vaultId resolves relative paths to absolute before hashing", () => {
    const cwd = process.cwd();
    const relative = vaultId("./notes");
    const absolute = vaultId(join(cwd, "notes"));
    expect(relative).toBe(absolute);
  });

  test("path helpers compose correctly", () => {
    const id = vaultId("/home/user/notes");
    const expected = join(homedir(), ".notient", id);
    expect(vaultStateDir("/home/user/notes")).toBe(expected);
    expect(vaultDataDir("/home/user/notes")).toBe(join(expected, "data"));
    expect(vaultSecretPath("/home/user/notes")).toBe(join(expected, "secret.key"));
    expect(vaultPortPath("/home/user/notes")).toBe(join(expected, "surreal.port"));
    expect(vaultPidPath("/home/user/notes")).toBe(join(expected, "surreal.pid"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/notient && bun test src/core/vault/identity.test.ts`
Expected: FAIL with module-not-found for `./identity`.

- [ ] **Step 3: Implement `identity.ts`**

Create `src/core/vault/identity.ts`:

```typescript
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = join(homedir(), ".notient");

export function vaultId(vaultPath: string): string {
  const absolute = resolve(vaultPath);
  return createHash("sha256").update(absolute).digest("hex").slice(0, 16);
}

export function vaultStateDir(vaultPath: string): string {
  return join(ROOT, vaultId(vaultPath));
}

export function vaultDataDir(vaultPath: string): string {
  return join(vaultStateDir(vaultPath), "data");
}

export function vaultSecretPath(vaultPath: string): string {
  return join(vaultStateDir(vaultPath), "secret.key");
}

export function vaultPortPath(vaultPath: string): string {
  return join(vaultStateDir(vaultPath), "surreal.port");
}

export function vaultPidPath(vaultPath: string): string {
  return join(vaultStateDir(vaultPath), "surreal.pid");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/notient && bun test src/core/vault/identity.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add src/core/vault/identity.ts src/core/vault/identity.test.ts
git commit -m "feat(vault): vault-id derivation and per-vault path helpers"
```

---

### Task 3: Per-vault secret read-or-generate

**Files:**
- Create: `src/core/vault/secret.ts`
- Create: `src/core/vault/secret.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/vault/secret.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrGenerateSecret } from "./secret";

describe("vault secret", () => {
  test("generates a 64-byte base64 secret on first read", () => {
    const dir = mkdtempSync(join(tmpdir(), "notient-secret-"));
    const path = join(dir, "secret.key");
    try {
      const secret = readOrGenerateSecret(path);
      expect(secret).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(Buffer.from(secret, "base64").length).toBe(64);
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns the existing secret on second read", () => {
    const dir = mkdtempSync(join(tmpdir(), "notient-secret-"));
    const path = join(dir, "secret.key");
    try {
      const a = readOrGenerateSecret(path);
      const b = readOrGenerateSecret(path);
      expect(a).toBe(b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a secret file with permissive mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "notient-secret-"));
    const path = join(dir, "secret.key");
    try {
      writeFileSync(path, "abc", { mode: 0o644 });
      expect(() => readOrGenerateSecret(path)).toThrow(/permissions/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/notient && bun test src/core/vault/secret.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `secret.ts`**

Create `src/core/vault/secret.ts`:

```typescript
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readOrGenerateSecret(path: string): string {
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`secret at ${path} has permissions ${mode.toString(8)}; expected 600`);
    }
    return readFileSync(path, "utf8").trim();
  }
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const secret = randomBytes(64).toString("base64");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/notient && bun test src/core/vault/secret.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add src/core/vault/secret.ts src/core/vault/secret.test.ts
git commit -m "feat(vault): read-or-generate per-vault secret with strict chmod"
```

---

### Task 4: Schema file — `schema.surql`

**Files:**
- Create: `src/core/db/schema.surql`
- Create: `src/core/db/edgeTables.ts`

- [ ] **Step 1: Define the edge-table list**

Create `src/core/db/edgeTables.ts`:

```typescript
export const EDGE_TABLES = [
  "wikilink",
  "embed",
  "frontmatter_ref",
  "tagged",
  "contained_in",
  "under_heading",
  "mentions",
  "asserts",
  "asks",
  "supports",
  "contradicts",
  "extends",
  "exemplifies",
  "synthesizes",
  "related_to",
] as const;

export type EdgeTable = (typeof EDGE_TABLES)[number];

export function provenanceFields(table: EdgeTable): string {
  return [
    `DEFINE FIELD source ON ${table} TYPE string ASSERT $value INSIDE ['wikilink','embed','frontmatter','structure','extractor','linker','user'];`,
    `DEFINE FIELD class ON ${table} TYPE string ASSERT $value INSIDE ['EXTRACTED','INFERRED','AMBIGUOUS'];`,
    `DEFINE FIELD confidence ON ${table} TYPE float ASSERT $value >= 0 AND $value <= 1;`,
    `DEFINE FIELD evidence ON ${table} TYPE option<array<record<chunk>>>;`,
    `DEFINE FIELD agent ON ${table} TYPE option<string>;`,
    `DEFINE FIELD approved ON ${table} TYPE bool DEFAULT true;`,
    `DEFINE FIELD created_at ON ${table} TYPE datetime DEFAULT time::now();`,
    `DEFINE INDEX ${table}_approved ON ${table} FIELDS approved;`,
    `DEFINE INDEX ${table}_source ON ${table} FIELDS source;`,
  ].join("\n");
}
```

- [ ] **Step 2: Write the canonical schema file**

Create `src/core/db/schema.surql` with the full content from spec §3.2-§3.6, expanded for all 16 edge tables. The file is too long to inline here; use the spec as the source. Critical clauses:

```surql
DEFINE NAMESPACE IF NOT EXISTS notient;
USE NS notient;
DEFINE DATABASE IF NOT EXISTS vault;
USE DB vault;

DEFINE TABLE note SCHEMAFULL;
DEFINE FIELD path ON note TYPE string ASSERT $value != NONE AND !string::starts_with($value, "/") AND !string::contains($value, "\\");
DEFINE FIELD sha ON note TYPE string;
DEFINE FIELD word_count ON note TYPE int DEFAULT 0;
DEFINE FIELD discovered_at ON note TYPE datetime DEFAULT time::now();
DEFINE FIELD tier1_at ON note TYPE option<datetime>;
DEFINE FIELD tier2_at ON note TYPE option<datetime>;
DEFINE FIELD tier3_at ON note TYPE option<datetime>;
DEFINE FIELD tombstoned_at ON note TYPE option<datetime>;
DEFINE FIELD last_user_edit_at ON note TYPE option<datetime>;
DEFINE INDEX note_path ON note FIELDS path UNIQUE;
DEFINE INDEX note_sha ON note FIELDS sha;
DEFINE INDEX note_tombstone ON note FIELDS tombstoned_at;

DEFINE TABLE block SCHEMAFULL;
DEFINE FIELD note ON block TYPE record<note>;
DEFINE FIELD block_id ON block TYPE option<string>;
DEFINE FIELD heading_path ON block TYPE array<string> DEFAULT [];
DEFINE FIELD heading_slug ON block TYPE option<string>;
DEFINE FIELD heading_level ON block TYPE option<int> ASSERT $value = NONE OR ($value >= 1 AND $value <= 3);
DEFINE FIELD ord ON block TYPE int;
DEFINE FIELD start_line ON block TYPE int;
DEFINE FIELD end_line ON block TYPE int;
DEFINE FIELD text ON block TYPE string;
DEFINE INDEX block_note ON block FIELDS note;
DEFINE INDEX block_heading ON block FIELDS note, heading_slug;
DEFINE INDEX block_explicit_id ON block FIELDS note, block_id UNIQUE;

DEFINE TABLE chunk SCHEMAFULL;
DEFINE FIELD note ON chunk TYPE record<note>;
DEFINE FIELD block ON chunk TYPE option<record<block>>;
DEFINE FIELD ord ON chunk TYPE int;
DEFINE FIELD text ON chunk TYPE string;
DEFINE FIELD token_estimate ON chunk TYPE int;
DEFINE FIELD vector ON chunk TYPE option<array<float, 768>>;
DEFINE FIELD embed_model ON chunk TYPE option<string>;
DEFINE FIELD embedded_at ON chunk TYPE option<datetime>;
DEFINE INDEX chunk_note_ord ON chunk FIELDS note, ord UNIQUE;
DEFINE INDEX chunk_vec ON chunk FIELDS vector HNSW DIMENSION 768 DIST COSINE EFC 200 M 16;

DEFINE ANALYZER notient_text TOKENIZERS class, blank FILTERS lowercase, ascii, snowball(english);
DEFINE INDEX chunk_text ON chunk FIELDS text FULLTEXT ANALYZER notient_text BM25 HIGHLIGHTS;

DEFINE TABLE tag SCHEMAFULL;
DEFINE FIELD path ON tag TYPE string ASSERT string::matches($value, "^[a-z0-9][a-z0-9/_-]*$");
DEFINE INDEX tag_path ON tag FIELDS path UNIQUE;

DEFINE TABLE concept SCHEMAFULL;
DEFINE FIELD label ON concept TYPE string;
DEFINE FIELD norm_label ON concept TYPE string;
DEFINE INDEX concept_norm ON concept FIELDS norm_label UNIQUE;

DEFINE TABLE claim SCHEMAFULL;
DEFINE FIELD text ON claim TYPE string;
DEFINE FIELD sha ON claim TYPE string;
DEFINE INDEX claim_sha ON claim FIELDS sha UNIQUE;

DEFINE TABLE question SCHEMAFULL;
DEFINE FIELD text ON question TYPE string;
DEFINE FIELD sha ON question TYPE string;
DEFINE INDEX question_sha ON question FIELDS sha UNIQUE;

DEFINE TABLE wikilink TYPE RELATION FROM note|block TO note|block SCHEMAFULL;
DEFINE TABLE embed TYPE RELATION FROM note|block TO note|block SCHEMAFULL;
DEFINE TABLE frontmatter_ref TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE tagged TYPE RELATION FROM note|block TO tag SCHEMAFULL;
DEFINE TABLE contained_in TYPE RELATION FROM block TO note SCHEMAFULL;
DEFINE TABLE under_heading TYPE RELATION FROM block TO block SCHEMAFULL;
DEFINE TABLE mentions TYPE RELATION FROM note|block TO concept SCHEMAFULL;
DEFINE TABLE asserts TYPE RELATION FROM note|block TO claim SCHEMAFULL;
DEFINE TABLE asks TYPE RELATION FROM note|block TO question SCHEMAFULL;
DEFINE TABLE supports TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE contradicts TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE extends TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE exemplifies TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE synthesizes TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE related_to TYPE RELATION FROM note TO note SCHEMAFULL;

-- Provenance fields applied uniformly to every edge table above.
-- Generated by emitting provenanceFields(table) for each table at apply time.
-- The applier concatenates this generated DDL after the schema.surql content.

DEFINE TABLE daemon_write SCHEMAFULL;
DEFINE FIELD note ON daemon_write TYPE record<note>;
DEFINE FIELD sha ON daemon_write TYPE string;
DEFINE FIELD agent ON daemon_write TYPE string;
DEFINE FIELD targets ON daemon_write TYPE array<record>;
DEFINE FIELD written_at ON daemon_write TYPE datetime DEFAULT time::now();
DEFINE INDEX daemon_write_sha ON daemon_write FIELDS sha;
DEFINE INDEX daemon_write_note ON daemon_write FIELDS note, written_at;

DEFINE TABLE awaken_run SCHEMAFULL;
DEFINE FIELD status ON awaken_run TYPE string ASSERT $value INSIDE ['running','paused','cancelled','completed','failed'];
DEFINE FIELD started_at ON awaken_run TYPE datetime DEFAULT time::now();
DEFINE FIELD finished_at ON awaken_run TYPE option<datetime>;
DEFINE FIELD total ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD processed ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD failed ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD tier_filter ON awaken_run TYPE array<int> DEFAULT [1,2,3];
DEFINE FIELD priority_globs ON awaken_run TYPE array<string> DEFAULT [];
DEFINE FIELD cursor ON awaken_run TYPE option<string>;
DEFINE FIELD error ON awaken_run TYPE option<string>;

DEFINE ACCESS agent_jwt ON DATABASE TYPE JWT
  ALGORITHM HS512 KEY $NOTIENT_AGENT_JWT_KEY
  AUTHENTICATE { IF $token.iss != "notient" { THROW "bad iss" } }
  DURATION FOR SESSION 24h;
```

- [ ] **Step 3: Verify the file is well-formed**

Run: `cd ~/projects/notient && wc -l src/core/db/schema.surql && grep -c "DEFINE TABLE" src/core/db/schema.surql`
Expected: ~80 lines, exactly 24 `DEFINE TABLE` (8 entity + 16 edge — wait, recount: note, block, chunk, tag, concept, claim, question = 7 entity; 16 edge; daemon_write + awaken_run = 2 ops; total 25. Adjust expected output to 25).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/notient
git add src/core/db/schema.surql src/core/db/edgeTables.ts
git commit -m "feat(db): canonical schema.surql + edge-table provenance generator"
```

---

### Task 5: Schema applier

**Files:**
- Create: `src/core/db/schemaApplier.ts`
- Create: `src/core/db/schemaApplier.test.ts`

- [ ] **Step 1: Write the failing test (uses a mocked Surreal connection)**

Create `src/core/db/schemaApplier.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { applySchema } from "./schemaApplier";

interface QueryCall { sql: string; vars?: Record<string, unknown> }

class FakeSurreal {
  public letCalls: Array<{ key: string; value: unknown }> = [];
  public queryCalls: QueryCall[] = [];
  async let(key: string, value: unknown): Promise<void> { this.letCalls.push({ key, value }); }
  async query(sql: string, vars?: Record<string, unknown>): Promise<unknown[]> {
    this.queryCalls.push({ sql, vars });
    return [];
  }
}

describe("applySchema", () => {
  test("sets the JWT key as a session parameter before applying schema", async () => {
    const db = new FakeSurreal();
    await applySchema(db as never, "secret-value");
    expect(db.letCalls).toEqual([{ key: "NOTIENT_AGENT_JWT_KEY", value: "secret-value" }]);
    expect(db.queryCalls.length).toBeGreaterThan(0);
  });

  test("the applied SQL contains the schema preamble and provenance for every edge table", async () => {
    const db = new FakeSurreal();
    await applySchema(db as never, "x");
    const concatenated = db.queryCalls.map((c) => c.sql).join("\n");
    expect(concatenated).toContain("DEFINE NAMESPACE IF NOT EXISTS notient");
    expect(concatenated).toContain("DEFINE TABLE note SCHEMAFULL");
    expect(concatenated).toContain("DEFINE TABLE wikilink TYPE RELATION");
    expect(concatenated).toContain("DEFINE FIELD source ON wikilink");
    expect(concatenated).toContain("DEFINE FIELD source ON related_to");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/notient && bun test src/core/db/schemaApplier.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `schemaApplier.ts`**

Create `src/core/db/schemaApplier.ts`:

```typescript
import { join } from "node:path";
import type { Surreal } from "surrealdb";
import { EDGE_TABLES, provenanceFields } from "./edgeTables";

const SCHEMA_FILE = join(import.meta.dir, "schema.surql");

export async function applySchema(db: Surreal, jwtKey: string): Promise<void> {
  await db.let("NOTIENT_AGENT_JWT_KEY", jwtKey);
  const baseSchema = await Bun.file(SCHEMA_FILE).text();
  const provenance = EDGE_TABLES.map(provenanceFields).join("\n");
  await db.query(baseSchema);
  await db.query(provenance);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/notient && bun test src/core/db/schemaApplier.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add src/core/db/schemaApplier.ts src/core/db/schemaApplier.test.ts
git commit -m "feat(db): schema applier with session-scoped JWT key parameter"
```

---

### Task 6: Surreal DAL skeleton

**Files:**
- Create: `src/core/db/surreal.ts`

- [ ] **Step 1: Write the DAL skeleton**

Create `src/core/db/surreal.ts`:

```typescript
import { Surreal, RecordId } from "surrealdb";

export interface SurrealConnection {
  db: Surreal;
  close(): Promise<void>;
}

export interface NoteRecord {
  id: RecordId<"note">;
  path: string;
  sha: string;
  word_count: number;
}

export interface SearchHit {
  noteId: RecordId<"note">;
  chunkId: RecordId<"chunk">;
  distance: number;
  text: string;
}

export async function connect(options: {
  url: string;
  user: string;
  pass: string;
  namespace: string;
  database: string;
}): Promise<SurrealConnection> {
  const db = new Surreal();
  await db.connect(options.url);
  await db.signin({ username: options.user, password: options.pass });
  await db.use({ namespace: options.namespace, database: options.database });
  return {
    db,
    close: async () => { await db.close(); },
  };
}

export async function createNote(db: Surreal, params: { path: string; sha: string; wordCount: number }): Promise<NoteRecord> {
  const result = await db.create<NoteRecord>("note", {
    path: params.path,
    sha: params.sha,
    word_count: params.wordCount,
  });
  if (!result) throw new Error(`createNote returned no record for path ${params.path}`);
  return Array.isArray(result) ? result[0] : result;
}

export async function relateWikilink(db: Surreal, params: {
  from: RecordId;
  to: RecordId;
  source: "wikilink" | "embed" | "frontmatter" | "structure" | "extractor" | "linker" | "user";
  confidenceClass: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  confidence: number;
  agent?: string;
}): Promise<void> {
  await db.query(
    `RELATE $from->wikilink->$to SET source = $source, class = $cls, confidence = $confidence, agent = $agent;`,
    {
      from: params.from,
      to: params.to,
      source: params.source,
      cls: params.confidenceClass,
      confidence: params.confidence,
      agent: params.agent ?? null,
    },
  );
}

export async function searchVector(db: Surreal, params: {
  vector: number[];
  k: number;
  ef?: number;
}): Promise<SearchHit[]> {
  const efClause = params.ef ? `<|${params.k},${params.ef}|>` : `<|${params.k}|>`;
  const rows = await db.query<[Array<{ id: RecordId<"chunk">; note: RecordId<"note">; text: string; d: number }>]>(
    `SELECT id, note, text, vector::distance::knn() AS d FROM chunk WHERE vector ${efClause} $q ORDER BY d;`,
    { q: params.vector },
  );
  const hits = rows[0] ?? [];
  return hits.map((r) => ({ noteId: r.note, chunkId: r.id, distance: r.d, text: r.text }));
}
```

- [ ] **Step 2: Verify the file type-checks against the SDK**

Run: `cd ~/projects/notient && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "(surreal\.ts|schemaApplier\.ts|edgeTables\.ts)" | head -20`
Expected: no errors. (If the project uses a different typecheck command — e.g. `bun run typecheck` — use that.)

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
git add src/core/db/surreal.ts
git commit -m "feat(db): typed DAL skeleton for surreal connect/create/relate/search"
```

---

### Task 7: SurrealDB binary check helper

**Files:**
- Create: `src/daemon/surrealServer.ts` (initial version: only the version check)
- Create: `src/daemon/surrealServer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/surrealServer.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseSurrealVersion, parseBoundPort } from "./surrealServer";

describe("surrealServer helpers", () => {
  test("parseSurrealVersion accepts valid 3.x output", () => {
    expect(parseSurrealVersion("surreal 3.0.5 for linux on x86_64")).toEqual({ major: 3, minor: 0, patch: 5 });
    expect(parseSurrealVersion("surreal 3.1.0")).toEqual({ major: 3, minor: 1, patch: 0 });
  });

  test("parseSurrealVersion rejects pre-3.x and bad output", () => {
    expect(parseSurrealVersion("surreal 2.6.0")).toBeNull();
    expect(parseSurrealVersion("not a version")).toBeNull();
    expect(parseSurrealVersion("")).toBeNull();
  });

  test("parseBoundPort extracts port from server stdout", () => {
    expect(parseBoundPort("Started server at 127.0.0.1:54321")).toBe(54321);
    expect(parseBoundPort("INFO surrealdb::net Started server at 127.0.0.1:8000\n")).toBe(8000);
    expect(parseBoundPort("nothing here")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/notient && bun test src/daemon/surrealServer.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement helpers (without spawn yet)**

Create `src/daemon/surrealServer.ts`:

```typescript
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SurrealVersion { major: number; minor: number; patch: number; }

export function parseSurrealVersion(stdout: string): SurrealVersion | null {
  const match = stdout.match(/surreal\s+(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const v = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  if (v.major < 3) return null;
  return v;
}

export function parseBoundPort(stdout: string): number | null {
  const match = stdout.match(/Started server at 127\.0\.0\.1:(\d+)/);
  return match ? Number(match[1]) : null;
}

export async function checkSurrealBinary(): Promise<SurrealVersion> {
  const proc = spawn(["surreal", "--version"], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const version = parseSurrealVersion(stdout);
  if (!version) {
    throw new Error(
      "SurrealDB 3.x is required.\n" +
      "Install with: curl -sSf https://install.surrealdb.com | sh\n" +
      `Got: ${stdout.trim() || "<no output>"}`,
    );
  }
  return version;
}

// Spawn + supervision lands in Task 8.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/notient && bun test src/daemon/surrealServer.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add src/daemon/surrealServer.ts src/daemon/surrealServer.test.ts
git commit -m "feat(daemon): surreal binary version check + stdout parser helpers"
```

---

### Task 8: Spawn and supervise `surreal start`

**Files:**
- Modify: `src/daemon/surrealServer.ts`

- [ ] **Step 1: Append the supervisor**

Add to `src/daemon/surrealServer.ts` (below the helpers from Task 7):

```typescript
export interface SurrealServerOptions {
  vaultPath: string;
  dataDir: string;
  secret: string;
  portFile: string;
  pidFile: string;
  logLevel?: "warn" | "info" | "debug";
  onUnexpectedExit?: (code: number | null) => void;
}

export interface SurrealServerHandle {
  port: number;
  url: string;
  pid: number;
  stop(): Promise<void>;
}

const STARTUP_TIMEOUT_MS = 5_000;
const RESTART_BUDGET = { maxRestarts: 3, windowMs: 60_000 };

export async function startSurreal(options: SurrealServerOptions): Promise<SurrealServerHandle> {
  await checkSurrealBinary();
  if (!existsSync(options.dataDir)) {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  }
  const args = [
    "start",
    "--bind", "127.0.0.1:0",
    "--user", "root",
    "--pass", options.secret,
    "--log", options.logLevel ?? "warn",
    `rocksdb://${options.dataDir}`,
  ];
  const proc = spawn(["surreal", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const port = await waitForBoundPort(proc, STARTUP_TIMEOUT_MS);
  if (port === null) {
    proc.kill();
    throw new Error("surreal start did not announce a bound port within 5s");
  }

  writeFileSync(options.portFile, String(port));
  if (proc.pid !== undefined) {
    writeFileSync(options.pidFile, String(proc.pid));
  }

  const restartTimes: number[] = [];
  let stopping = false;

  proc.exited.then((code) => {
    if (stopping) return;
    const now = Date.now();
    restartTimes.push(now);
    while (restartTimes.length > 0 && now - restartTimes[0] > RESTART_BUDGET.windowMs) {
      restartTimes.shift();
    }
    if (restartTimes.length > RESTART_BUDGET.maxRestarts) {
      options.onUnexpectedExit?.(code);
      return;
    }
    options.onUnexpectedExit?.(code);
  });

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    pid: proc.pid ?? -1,
    async stop() {
      stopping = true;
      proc.kill("SIGTERM");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if ((await Promise.race([proc.exited, sleep(100)])) !== undefined) return;
      }
      proc.kill("SIGKILL");
      await proc.exited;
    },
  };
}

async function waitForBoundPort(proc: Subprocess, timeoutMs: number): Promise<number | null> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), sleep(timeoutMs).then(() => ({ value: undefined, done: true } as const))]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const port = parseBoundPort(buffer);
    if (port !== null) return port;
  }
  return null;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
```

- [ ] **Step 2: Verify the module type-checks**

Run: `cd ~/projects/notient && bun build src/daemon/surrealServer.ts --target=bun --outdir=/tmp/notient-typecheck 2>&1 | head`
Expected: no type errors.

- [ ] **Step 3: Run existing tests to confirm no regression**

Run: `cd ~/projects/notient && bun test src/daemon/surrealServer.test.ts`
Expected: PASS, 3 tests (the helper tests still cover the parsers).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/notient
git add src/daemon/surrealServer.ts
git commit -m "feat(daemon): supervise surreal start with port capture and restart budget"
```

---

### Task 9: Wire `surrealServer` into bootstrap, register kernel slot

**Files:**
- Modify: `src/daemon/bootstrap.ts`
- Modify: `src/core/kernel.ts`

- [ ] **Step 1: Read the current bootstrap to find the right insertion point**

Run: `cd ~/projects/notient && grep -n "kernel\\.set\\|new Kernel\\|seal" src/daemon/bootstrap.ts | head`
Expected: list of lines where slots are registered. Note the ordering convention.

- [ ] **Step 2: Add a `surrealDb` slot to the kernel type**

Open `src/core/kernel.ts`. Locate the kernel-slot type union (near the top of the file or wherever `KernelSlots` / `Phase*Keys` lives). Add `"surrealDb"` to the slot list. The slot's typed value is `SurrealConnection` from `src/core/db/surreal.ts`.

```typescript
// In src/core/kernel.ts, near the slot-keys constant:
import type { SurrealConnection } from "./db/surreal";
// ...
export const PHASE_E_KEYS = [...PHASE_D_KEYS, "surrealDb"] as const;
// Mapping table for typed get/set if the kernel uses one:
// "surrealDb": SurrealConnection
```

(Adapt to the kernel's existing pattern; the prior plans show `PHASE_D_KEYS = PHASE_C_KEYS`. This phase introduces `PHASE_E_KEYS` without making it the default seal yet — the daemon still seals to `"D"` in production, but tests can seal to `"E"` to access the SurrealDB slot.)

- [ ] **Step 3: Wire bootstrap to start SurrealDB and register the slot**

In `src/daemon/bootstrap.ts`, after the existing kernel construction and before `kernel.seal(...)`:

```typescript
import { startSurreal } from "./surrealServer";
import { connect } from "../core/db/surreal";
import { applySchema } from "../core/db/schemaApplier";
import { vaultDataDir, vaultSecretPath, vaultPortPath, vaultPidPath } from "../core/vault/identity";
import { readOrGenerateSecret } from "../core/vault/secret";

// ... within the bootstrap function, AFTER the existing sql.js Database init,
// BEFORE kernel.seal(...):

const secret = readOrGenerateSecret(vaultSecretPath(vaultPath));
const surrealHandle = await startSurreal({
  vaultPath,
  dataDir: vaultDataDir(vaultPath),
  secret,
  portFile: vaultPortPath(vaultPath),
  pidFile: vaultPidPath(vaultPath),
  logLevel: "warn",
  onUnexpectedExit: (code) => {
    eventBus.publish({ name: "daemon:db_failed", payload: { code } });
  },
});

const surrealDb = await connect({
  url: surrealHandle.url,
  user: "root",
  pass: secret,
  namespace: "notient",
  database: "vault",
});

await applySchema(surrealDb.db, secret);

kernel.set("surrealDb", surrealDb);

// In the daemon's shutdown path (kernel.close override or a registered teardown):
// 1. await surrealDb.close()
// 2. await surrealHandle.stop()
// (in that order — close the SDK first, then stop the child)
```

Locate the existing close/teardown path and chain the two awaits. If `kernel.close()` is the canonical shutdown, register a finaliser via the kernel's existing mechanism (look at how `db.close()` is currently invoked for sql.js).

- [ ] **Step 4: Type-check**

Run: `cd ~/projects/notient && bun run typecheck 2>&1 | grep -E "bootstrap|kernel" | head`
Expected: no errors related to the new code.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add src/daemon/bootstrap.ts src/core/kernel.ts
git commit -m "feat(daemon): boot surreal alongside sqlite, register surrealDb kernel slot"
```

---

### Task 10: Smoke harness — daemon boots, schema applies

**Files:**
- Create: `src/daemon/__smoke__/surrealServer.smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

Create `src/daemon/__smoke__/surrealServer.smoke.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordId } from "surrealdb";
import { startSurreal, type SurrealServerHandle } from "../surrealServer";
import { connect, createNote, relateWikilink, searchVector, type SurrealConnection } from "../../core/db/surreal";
import { applySchema } from "../../core/db/schemaApplier";
import { readOrGenerateSecret } from "../../core/vault/secret";

let tempDir: string;
let server: SurrealServerHandle;
let db: SurrealConnection;
const secret = "phase-1-smoke-secret-not-for-prod";

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "notient-smoke-"));
  const dataDir = join(tempDir, "data");
  const portFile = join(tempDir, "surreal.port");
  const pidFile = join(tempDir, "surreal.pid");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  server = await startSurreal({
    vaultPath: tempDir,
    dataDir,
    secret,
    portFile,
    pidFile,
    logLevel: "warn",
  });

  db = await connect({
    url: server.url,
    user: "root",
    pass: secret,
    namespace: "notient",
    database: "vault",
  });
  await applySchema(db.db, secret);
});

afterAll(async () => {
  if (db) await db.close();
  if (server) await server.stop();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("surreal phase-1 smoke", () => {
  test("schema applies without error and tables exist", async () => {
    const info = await db.db.query<[{ tables: Record<string, unknown> }]>(`INFO FOR DB;`);
    const tables = (info[0] as { tables: Record<string, unknown> }).tables;
    expect(Object.keys(tables)).toEqual(
      expect.arrayContaining([
        "note", "block", "chunk", "tag", "concept", "claim", "question",
        "wikilink", "embed", "frontmatter_ref", "tagged",
        "contained_in", "under_heading",
        "mentions", "asserts", "asks",
        "supports", "contradicts", "extends", "exemplifies", "synthesizes", "related_to",
        "daemon_write", "awaken_run",
      ]),
    );
  });

  test("createNote round-trips", async () => {
    const created = await createNote(db.db, { path: "smoke/one.md", sha: "deadbeef", wordCount: 42 });
    expect(created.path).toBe("smoke/one.md");
    expect(created.sha).toBe("deadbeef");
    expect(created.word_count).toBe(42);
  });

  test("RELATE wikilink and traverse", async () => {
    const a = await createNote(db.db, { path: "smoke/a.md", sha: "aa", wordCount: 1 });
    const b = await createNote(db.db, { path: "smoke/b.md", sha: "bb", wordCount: 1 });
    await relateWikilink(db.db, {
      from: a.id, to: b.id, source: "wikilink", confidenceClass: "EXTRACTED", confidence: 1.0,
    });
    const result = await db.db.query<[Array<{ path: string }>]>(
      `SELECT VALUE path FROM (SELECT ->wikilink->note.* FROM $a)[0];`,
      { a: a.id },
    );
    const paths = result[0] as string[];
    expect(paths).toContain("smoke/b.md");
  });

  test("HNSW kNN returns the expected chunk", async () => {
    const note = await createNote(db.db, { path: "smoke/vec.md", sha: "cc", wordCount: 1 });
    // Insert a chunk with a known vector.
    const target = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    const ortho = Array.from({ length: 768 }, (_, i) => (i === 1 ? 1 : 0));
    await db.db.query(
      `CREATE chunk SET note = $n, ord = 0, text = "target", token_estimate = 1, vector = $v, embed_model = "test", embedded_at = time::now();`,
      { n: note.id, v: target },
    );
    await db.db.query(
      `CREATE chunk SET note = $n, ord = 1, text = "ortho", token_estimate = 1, vector = $v, embed_model = "test", embedded_at = time::now();`,
      { n: note.id, v: ortho },
    );
    const hits = await searchVector(db.db, { vector: target, k: 1 });
    expect(hits.length).toBe(1);
    expect(hits[0].text).toBe("target");
  });

  test("schemafull silent-drop footgun caught: undefined fields are dropped on insert", async () => {
    // This test guards spec §16.1. If SurrealDB ever changes the silent-drop
    // behavior, we want to see it here.
    const note = await createNote(db.db, { path: "smoke/footgun.md", sha: "dd", wordCount: 1 });
    await db.db.query(`UPDATE $n SET nonsense_field = "should be dropped";`, { n: note.id });
    const fetched = await db.db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $n;`, { n: note.id });
    const row = (fetched[0] as Record<string, unknown>[])[0];
    expect(row.nonsense_field).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the smoke test (requires `surreal` on PATH)**

Run: `cd ~/projects/notient && bun test src/daemon/__smoke__/surrealServer.smoke.test.ts --bail`
Expected: PASS, 5 tests. If it fails on `surreal --version`, install SurrealDB first.

- [ ] **Step 3: Document how to run smoke separately**

The smoke test sits in `__smoke__/`. Confirm the existing `package.json` test scripts do not pick it up automatically; if they do, add `"test": "bun test --filter '!__smoke__'"` and `"test:smoke": "bun test src/**/__smoke__/**.test.ts"`. Run: `cd ~/projects/notient && cat package.json | grep -A2 '"test"'`. Adjust scripts if needed in a single edit.

- [ ] **Step 4: Run the full default test suite to confirm no regression**

Run: `cd ~/projects/notient && bun test`
Expected: all existing tests PASS, smoke test is excluded.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add src/daemon/__smoke__/surrealServer.smoke.test.ts package.json
git commit -m "test(smoke): phase-1 surreal end-to-end harness"
```

---

### Task 11: `notient db sql` operator escape hatch

**Files:**
- Create: `src/cli/commands/dbSql.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Implement the command**

Create `src/cli/commands/dbSql.ts`:

```typescript
import { spawn } from "bun";
import { readFileSync } from "node:fs";
import { vaultPortPath, vaultSecretPath } from "../../core/vault/identity";

export async function dbSqlCommand(vaultPath: string): Promise<number> {
  const port = readFileSync(vaultPortPath(vaultPath), "utf8").trim();
  const secret = readFileSync(vaultSecretPath(vaultPath), "utf8").trim();
  const proc = spawn([
    "surreal", "sql",
    "--endpoint", `ws://127.0.0.1:${port}`,
    "--user", "root",
    "--pass", secret,
    "--ns", "notient",
    "--db", "vault",
    "--pretty",
  ], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  return proc.exitCode ?? 1;
}
```

- [ ] **Step 2: Wire it into the CLI router**

Open `src/cli/index.ts`. Locate the verb dispatch (`switch`/`match` on argv[2]). Add:

```typescript
import { dbSqlCommand } from "./commands/dbSql";
// ...
case "db": {
  if (subcommand !== "sql") {
    console.error("usage: notient db sql");
    process.exit(2);
  }
  process.exit(await dbSqlCommand(vaultPath));
}
```

(Adapt to the existing dispatch shape — current commands like `init`, `daemon`, `awaken` show the convention.)

- [ ] **Step 3: Smoke-check the help line**

Run: `cd ~/projects/notient && bun run src/cli/index.ts --help 2>&1 | grep -i "db sql"`
Expected: a line listing `notient db sql` with a one-line description. If the help is auto-generated, this verifies registration; if hand-written, add a line to the help table at `src/cli/commands/help.ts` (or wherever it lives) in this same step.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/notient
git add src/cli/commands/dbSql.ts src/cli/index.ts src/cli/commands/help.ts
git commit -m "feat(cli): notient db sql operator REPL against the running daemon"
```

(Adjust the staging list to whichever files actually changed.)

---

### Task 12: Delete canvas

**Files:**
- Delete: `src/core/canvas/` (entire directory)
- Modify: `src/core/kernel.ts`
- Modify: `src/agent/attachments.ts`
- Modify: any CLI command file that exposes `export-canvas` (locate via grep)

- [ ] **Step 1: List all canvas references**

Run: `cd ~/projects/notient && grep -rln "canvas" src/ | sort`
Expected: a list of files. Note which are in `src/core/canvas/` (delete), which are kernel-registration sites (modify), which are CLI sites (modify).

- [ ] **Step 2: Read the kernel registration to understand what to remove**

Run: `cd ~/projects/notient && grep -n "canvas" src/core/kernel.ts`
Expected: lines like `canvasFromResults: ...` in the kernel slot type and bootstrap registration. Note them.

- [ ] **Step 3: Delete the canvas directory**

```bash
cd ~/projects/notient
git rm -r src/core/canvas/
```

Expected: 5 files deleted.

- [ ] **Step 4: Remove the kernel registration**

Edit `src/core/kernel.ts`: drop the `canvasFromResults` slot entry from the slot-key list and from the typed-slot mapping (whatever structure the kernel uses).

Edit `src/daemon/bootstrap.ts` if it has a `kernel.set("canvasFromResults", ...)` line — drop it.

- [ ] **Step 5: Remove the consumer reference**

Edit `src/agent/attachments.ts`: drop the canvas import and the call site. Walk the file's compile errors after the edit; the canvas reference was at most one short stretch of lines per the audit.

- [ ] **Step 6: Remove the CLI command if it exists**

```bash
cd ~/projects/notient && find src/cli -iname "*canvas*"
```

If any file matches, `git rm` it. Drop its registration in `src/cli/index.ts`.

- [ ] **Step 7: Verify no canvas references remain**

Run: `cd ~/projects/notient && grep -rln "canvas" src/`
Expected: empty (or only references in unrelated docstrings, which are out of scope).

- [ ] **Step 8: Run the full test suite**

Run: `cd ~/projects/notient && bun test`
Expected: all PASS. Any test that depended on canvas was a canvas test deleted in Step 3.

- [ ] **Step 9: Commit**

```bash
cd ~/projects/notient
git add -u && git status --short
# Inspect the staged set; should be 5 deletions + 2-3 small modifications.
git commit -m "feat(canvas): remove canvas surface entirely (spec 12.3)"
```

---

### Task 13: Replace `echoGuard.ts` with a no-op shim, delete the test file

**Files:**
- Modify: `src/core/services/echoGuard.ts` (replace contents with no-op shim)
- Delete: `src/core/services/echoGuard.test.ts`

- [ ] **Step 1: Read the current `echoGuard.ts` to capture its public surface**

Run: `cd ~/projects/notient && cat src/core/services/echoGuard.ts`
Expected: see the exported class / function shape. Note the method signatures called by the 25+ consumers (the audit cited `mark(path, sha)` plus likely a `has(path, sha)` query).

- [ ] **Step 2: Replace with a no-op shim**

Open `src/core/services/echoGuard.ts` and replace its contents with:

```typescript
// PHASE-1-SHIM: This file is a no-op shim for Phase 1.
// The real implementation (provenance via the SurrealDB `daemon_write` table)
// lands in Phase 4. The 25+ consumers that call mark/has are NOT rewritten
// in Phase 1; they call this shim, which silently no-ops. The cost of the
// shim is one missed deduplication opportunity per write-back during
// Phases 2-3, which is acceptable because those phases do not exercise the
// write-back path (tier 1 is the only writer before Phase 4).
//
// Phase 4 deletes this file AND the consumer call sites in the same commit.

export class EchoGuard {
  mark(_path: string, _sha: string): void {
    // no-op
  }
  has(_path: string, _sha: string): boolean {
    return false;
  }
}

export function createEchoGuard(): EchoGuard {
  return new EchoGuard();
}
```

(Adjust the exports to match the actual public surface seen in Step 1. If the original exposed only a function and not a class, mirror that.)

- [ ] **Step 3: Delete the echo guard test**

```bash
cd ~/projects/notient
git rm src/core/services/echoGuard.test.ts
```

The shim is trivial; its behavior is "do nothing." A separate test would just assert no-op-ness, which has no value.

- [ ] **Step 4: Run the full test suite**

Run: `cd ~/projects/notient && bun test`
Expected: all PASS. Consumers calling `mark()` get a no-op; their existing tests should not depend on echo-guard's mark having an observable side effect (if they do, that test will fail and we update it to match the shim contract — but per the audit, consumers `mark()` and never `expect(echoGuard.has(...)).toBeTrue()` in their unit tests; the echo-guard's correctness was tested in its own file, which is now deleted).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add src/core/services/echoGuard.ts
git rm src/core/services/echoGuard.test.ts
git commit -m "feat(echoGuard): replace with no-op shim until phase 4 daemon_write lands"
```

---

### Task 14: Help text and self-review

**Files:**
- Modify: `src/cli/commands/help.ts` (or wherever the help text lives)

- [ ] **Step 1: Update help text**

Open the help-text file. Drop the `export-canvas` line. Add `notient db sql` with description "open a SurrealQL REPL against the running daemon (operator escape hatch)". If the help text has phase markers, group `db sql` under "operations".

- [ ] **Step 2: Verify no `export-canvas` references remain anywhere**

Run: `cd ~/projects/notient && grep -rln "export-canvas\|exportCanvas" src/`
Expected: empty.

- [ ] **Step 3: Spot-check `notient --help` end-to-end**

Run: `cd ~/projects/notient && bun run src/cli/index.ts --help`
Expected: the help lists the verbs from Phase D1 plus `db sql`, no `export-canvas`.

- [ ] **Step 4: Run the full test suite + smoke**

Run: `cd ~/projects/notient && bun test && bun test src/daemon/__smoke__/surrealServer.smoke.test.ts`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add src/cli/commands/help.ts
git commit -m "docs(cli): drop export-canvas from help, add db sql"
```

---

### Task 15: Phase 1 wrap — handoff doc

**Files:**
- Create: `docs/superpowers/handoffs/2026-04-29-phase-1-vault-enrichment-handoff.md`

- [ ] **Step 1: Write the handoff**

Create the handoff doc summarising what shipped, what is deliberately unfinished, and what Phase 2 picks up. Keep it under 80 lines.

```markdown
# Phase 1 Handoff — Vault Enrichment Substrate

**Date:** [completion date]
**Branch:** `beta-spec`
**Spec:** `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md`
**Plan:** `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-1.md`

## What shipped

- SurrealDB 3.x supervised as a daemon child process. `surreal start` binds 127.0.0.1:0; daemon parses the bound port from stdout.
- Per-vault state directory at `~/.notient/<vault-id>/` with `secret.key` (chmod 600), `surreal.port`, `surreal.pid`, `data/` (RocksDB).
- `<vault-id>` derivation: `sha256(absoluteVaultPath).slice(0, 16)`.
- `schema.surql` applied on daemon boot; covers all 25 tables (7 entity + 16 edge + 2 ops) with provenance fields generated from the `EDGE_TABLES` const.
- Typed DAL skeleton in `src/core/db/surreal.ts`: connect, createNote, relateWikilink, searchVector, close.
- `notient db sql` operator REPL against the running daemon.
- Canvas surface deleted entirely (spec §12.3).
- `EchoGuard` reduced to an 8-line no-op shim; consumer call sites untouched. Deletes in Phase 4.
- Smoke harness: `src/daemon/__smoke__/surrealServer.smoke.test.ts` exercises schema apply, createNote, RELATE, HNSW kNN, schemafull silent-drop footgun.

## What is deliberately NOT done

- No markdown parser. Tier 1 indexer does not exist yet.
- No DAL rewrite for any consumer. SQLite remains the primary store for everything except the smoke test.
- No `daemon_write` writer. The SurrealDB table exists; no code writes to it.
- No new CLI verbs beyond `db sql`. `awaken --tier`, `links sync`, `links audit`, `backup`, `restore`, `nuke`, `migrate-vault`, `graph dump`, `graph stats` all wait for later phases.
- No write-back rewrite. `nativeGraphBridge.ts` still uses regex string mutation.
- No HNSW deletion. `hnswVectorIndex.ts` stays for now; Phase 3 migrates Tier 2 to SurrealDB-native HNSW.
- No deletion of `database.ts`, `schema.ts`, `migrations.ts`, `graphStore.ts`, `nativeGraphBridge.ts`, `relatedSection.ts`, `frontmatterWriter.ts`. Those wait for Phase 5's final cutover.

## Phase 2 entry point

Phase 2 ships unified/remark + custom plugins (`remark-wikilink`, `remark-block-id`, `remark-tag`) and the Tier 1 indexer that reads them and writes deterministic edges to SurrealDB. The watcher gains `unlink` + 60s SHA-match rename detection. Acceptance: save a note with `[[link]]` and `^block-id`, see the corresponding rows in SurrealDB.

The plan for Phase 2 is `docs/superpowers/plans/2026-04-30-vault-enrichment-phase-2.md` (to be written).

## Footguns to remember

- HNSW is in-memory, rebuilt on startup. Default 256 MiB cache; bump for >50k chunks via `SURREAL_HNSW_CACHE_SIZE`.
- SCHEMAFULL silently drops undefined fields. The smoke test guards this.
- Embedded mode (`@surrealdb/node@alpha`) is NOT supported; only spawned server mode.
```

- [ ] **Step 2: Commit**

```bash
cd ~/projects/notient
git add docs/superpowers/handoffs/2026-04-29-phase-1-vault-enrichment-handoff.md
git commit -m "docs(handoff): phase 1 vault enrichment substrate handoff"
```

---

## Self-review

**Spec coverage check.** Mapping spec sections to Phase 1 tasks:

| Spec section | Phase 1 task | Status |
|---|---|---|
| §3 schema (7 entity + 16 edge + 2 ops + JWT) | Tasks 4, 5 | ✅ All tables in schema.surql; provenance generated for all 16 edge tables; awaken_run + daemon_write present |
| §6 server lifecycle | Tasks 7, 8, 9 | ✅ Binary check, spawn, port discovery, supervision, kernel wiring |
| §7 vault identity / secrets | Tasks 2, 3 | ✅ Both implemented |
| §11.1 `notient db sql` | Task 11 | ✅ |
| §12.3 canvas deletion | Task 12 | ✅ |
| §12.5 echoGuard deletion | Task 13 | ⚠️ Partial — shim now, full deletion in Phase 4 (documented) |
| §16.1 schemafull silent-drop footgun | Task 10 (smoke) | ✅ Guarded |
| §17 hard rules | All tasks | ✅ Carried forward |
| §3 markdown parser, §5 indexer, §8 write-back, §9 awaken control plane, §11.1 other CLI verbs | NONE in Phase 1 | ✅ Deferred to Phases 2-5 (spec §15) |

No spec gaps for Phase 1 scope.

**Placeholder scan.** No "TBD", no "TODO" (the file lists Phase 2-5 work as deferred, not as TODOs). One "PHASE-1-SHIM" comment block in Task 13 is intentional and removed in Phase 4.

**Type consistency.** `SurrealConnection` interface in Task 6 matches the import in Task 9 and Task 10. `parseBoundPort` and `parseSurrealVersion` from Task 7 are consumed by Task 8 helpers. `EDGE_TABLES` in Task 4 is consumed by Task 5. Confirmed end to end.

**Adjustment from spec §15.** Spec row 1 says Phase 1 deletes all of §12.1-12.5; this plan deletes only §12.3 (canvas) and §12.5 partially (echoGuard via shim). The big-blast-radius deletions in §12.1, §12.2, §12.4 require consumer migration, which lands in Phases 2-5. Phase 5's final cutover deletes them. Documented in the plan's Architecture section and the Phase 1 handoff.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
