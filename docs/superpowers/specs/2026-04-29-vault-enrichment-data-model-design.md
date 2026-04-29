# Notient Vault Enrichment — Data Model, Lifecycle, and Pipeline

> Design spec. Date: 2026-04-29. Branch: `beta-spec`. Supersedes the SQLite + HNSW WASM storage layer shipped through Phase D1, the regex-based `nativeGraphBridge`, the radial `canvasGenerator`, and the JSON-file `echoGuard`. The Phase D1 agent-to-agent surface (`ask`, `brief`, `distill`, `events`, `session`, `--as`) is preserved end to end; only its DAL is rewritten.

---

## 1. Frame

Notient is a vault enrichment daemon. It reads everything Obsidian already considers a graph signal, builds a richer graph in SurrealDB, proposes new edges via the local LLM, and writes approved edges back as wikilinks and frontmatter so that **Obsidian's native graph view becomes Notient's renderer**. There is no custom canvas surface, no graph UI to build, no third-party visualisation library. The daemon's job is to make the vault denser and more navigable; the rendering is whatever Obsidian and the user's editor already do.

This spec replaces the entire storage substrate (sql.js + hnswlib-wasm + JSON sidecars) with a single SurrealDB process supervised by the daemon. It introduces a deterministic markdown parsing layer (unified/remark) that reads `[[wikilink]]`, `![[embed]]`, `^block-id`, `#tag`, and frontmatter refs as ground-truth edges before any LLM extraction runs. It defines an explicit per-note lifecycle with three indexing tiers and a priority-based queue so that the cheap deterministic work always lands first and the expensive LLM work runs in the background without blocking save-time feedback.

### Non-goals for this redesign

- No custom graph UI, no canvas export as primary surface, no third-party visualisation.
- No schema migrations, no schema versioning, no backwards compatibility with the current SQLite tables. The vault is reindexed clean against the new schema.
- No embedded SurrealDB. Server mode only, supervised as a child process.
- No cloud storage, no remote LLM, no telemetry. The substrate axiom from the v0.1 CLI design holds.
- No new node types beyond the seven listed in §3. No new edge types beyond the sixteen listed in §3.
- No bulk import / export tooling beyond what `surreal export` and `surreal import` already give us.
- No web surface, no HTTP API, no MCP server. The CLI plus the existing Phase D1 RPC over Unix socket are the only surfaces.

---

## 2. Locked decisions

1. **Datastore is SurrealDB 3.x, server mode, RocksDB backend.** The daemon spawns `surreal start --bind 127.0.0.1:0 --user root --pass <secret> rocksdb://<data-dir>` as a supervised child process and connects via WebSocket through the official `surrealdb` JS SDK. No embedded mode. No fallback. RocksDB is chosen over SurrealKV because SurrealKV is documented as "under active development" and "not for production critical workloads" in the official 3.x docs; RocksDB is the documented default for persistent server storage.
2. **Vault identity is `<vault-id> = sha256(absolute_vault_path)[..16]`.** Per-vault state lives at `~/.notient/<vault-id>/`. The data directory is `~/.notient/<vault-id>/data/`. The JWT secret is `~/.notient/<vault-id>/secret.key` (chmod 600, generated on first run via `crypto.randomBytes(64).toString("base64")`). The bound port is written to `~/.notient/<vault-id>/surreal.port` for external `surreal sql` debugging sessions.
3. **Heading nodes cap at H3.** Every `# H1`, `## H2`, `### H3` becomes a `block` node. H4-H6 are not their own nodes; they become content within the nearest H3 ancestor block. Wikilinks of the form `[[note#H4]]` resolve to the H3 ancestor block plus a `heading_path: ["H1","H2","H3","H4"]` annotation so the resolution is recoverable without an extra node.
4. **Markdown parser is unified/remark.** `remark-parse`, `remark-frontmatter`, `remark-gfm`, plus three custom plugins shipped under `src/core/markdown/plugins/`: `remark-wikilink` (parses `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target#^block]]`, `![[target]]`), `remark-block-id` (parses `^block-id` markers), `remark-tag` (parses `#tag/sub` outside of code spans). Frontmatter parsed by `remark-frontmatter` and post-processed for wikilink-typed values.
5. **No migrations infrastructure.** `schema.surql` is applied on daemon start via the SDK with `IF NOT EXISTS` and `OVERWRITE` modifiers per `DEFINE` statement. Existing developers wipe their `~/.notient/<vault-id>/` directory and re-`awaken`. The `applySchema` runner from the prior schema layer is deleted.
6. **Block nodes for headings always.** Storage cost is acceptable in exchange for query-time clarity. `[[note#Heading]]` resolves deterministically to a `block` node by `(note, heading_slug)` lookup. There is no fallback path to whole-note resolution for heading-qualified wikilinks.
7. **Awaken blocks until done by default, with an opt-in `--background` flag and full pause/resume/cancel control plane.** State persists in the `awaken_run` table so that a SIGTERM during awaken resumes cleanly on next start. Pause/resume/cancel are implemented as writes to `awaken_run.status` that the worker reads via a `LIVE SELECT` subscription, not as in-memory signals.
8. **Echo guard is replaced by the `daemon_write` provenance table.** When the AST-aware write-back applies an approved edge to a note, it inserts a `daemon_write` row recording `(note, sha, agent, targets[], written_at)`. Tier 1 cross-references this table when classifying wikilink edges so that links Notient wrote get `source = '<agent>'` and links the user wrote get `source = 'wikilink'`. The JSON file at `~/.notient/<vault-id>/echo-marks.json` is deleted; no compatibility shim.
9. **Single source for edge-table provenance fields.** `schema.surql` defines `source`, `class`, `confidence`, `evidence`, `agent`, `approved`, `created_at` once via a SurrealQL helper expression that loops over every edge table name. There is no copy-paste of provenance fields across sixteen tables.
10. **Phase D1 surface is preserved.** Every CLI verb (`ask`, `brief`, `distill`, `events`, `session grant/revoke/list`), the `--as <agent-id>` flag plumbing, the `agent_run` / `agent_event` / `agent_session` tables, the `EventBus` facade, and the `historyService` contract continue to work. Their DAL is rewritten; their public shapes do not change.
11. **`canvasGenerator` and all canvas code is deleted entirely.** No deprecation, no exporter, no compatibility flag. Section 14 lists the files.
12. **`echoGuard.ts`, `relatedSection.ts`, `frontmatterWriter.ts`, the JSON-file echo marks, and the regex-based `nativeGraphBridge` are deleted entirely.** The replacement is one module, `src/core/markdown/writeback.ts`, that round-trips through the remark AST.

---

## 3. Data model — `schema.surql`

The schema lives at `src/core/db/schema.surql` and is applied on daemon start. The full file is checked in; this section is the canonical excerpt with one representative edge-table provenance block. Provenance fields apply uniformly to every edge table named in §3.4.

### 3.1 Namespace and database

```surql
DEFINE NAMESPACE IF NOT EXISTS notient;
USE NS notient;
DEFINE DATABASE IF NOT EXISTS vault;
USE DB vault;
```

The namespace is fixed. The database name is `vault` (singular). One namespace, one database, per vault data directory.

### 3.2 Core entity tables

```surql
DEFINE TABLE note SCHEMAFULL;
DEFINE FIELD path ON note TYPE string
  ASSERT $value != NONE
  AND !string::starts_with($value, "/")
  AND !string::contains($value, "\\");
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
DEFINE FIELD heading_level ON block TYPE option<int>
  ASSERT $value = NONE OR ($value >= 1 AND $value <= 3);
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
DEFINE INDEX chunk_vec ON chunk FIELDS vector
  HNSW DIMENSION 768 DIST COSINE EFC 200 M 16;

DEFINE ANALYZER notient_text TOKENIZERS class, blank
  FILTERS lowercase, ascii, snowball(english);
DEFINE INDEX chunk_text ON chunk FIELDS text
  FULLTEXT ANALYZER notient_text BM25 HIGHLIGHTS;

DEFINE TABLE tag SCHEMAFULL;
DEFINE FIELD path ON tag TYPE string
  ASSERT string::matches($value, "^[a-z0-9][a-z0-9/_-]*$");
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
```

The HNSW dimension `768` matches the locked Ollama embedder (`text-embedding-nomic-embed-text-v2-moe`). Changing the embedder requires dropping and rebuilding the index; this is documented in §16 as a footgun.

### 3.3 Note canonicalisation

Path values are vault-relative POSIX, no leading slash, no Windows backslashes. The DAL canonicalises before insert: `path.toPosix().replace(/^\.?\/+/, "")`. The `ASSERT` clauses on `note.path` enforce the rule at the DB layer. There is no separate validation library; the schema is the validator.

### 3.4 Edge tables

Sixteen edge tables, partitioned by provenance class:

**Deterministic (Tier 1 emits these; `class = 'EXTRACTED'`):**
- `wikilink`: `RELATION FROM note|block TO note|block`
- `embed`: `RELATION FROM note|block TO note|block`
- `frontmatter_ref`: `RELATION FROM note TO note`
- `tagged`: `RELATION FROM note|block TO tag`
- `contained_in`: `RELATION FROM block TO note`
- `under_heading`: `RELATION FROM block TO block`

**Extracted semantic (Tier 3 extractor emits these; `class = 'INFERRED'`):**
- `mentions`: `RELATION FROM note|block TO concept`
- `asserts`: `RELATION FROM note|block TO claim`
- `asks`: `RELATION FROM note|block TO question`

**Proposed semantic (Tier 3 linker emits these via staging; `class = 'INFERRED'`):**
- `supports`, `contradicts`, `extends`, `exemplifies`, `synthesizes`, `related_to`, all `RELATION FROM note TO note`

Provenance fields, applied uniformly:

```surql
-- Provenance fields applied to every edge table; the runner loops over the
-- table list and emits one DEFINE FIELD per (table, field) pair.
-- One representative block (substitute "wikilink" for the others):
DEFINE FIELD source ON wikilink TYPE string
  ASSERT $value INSIDE ['wikilink','embed','frontmatter','structure','extractor','linker','user'];
DEFINE FIELD class ON wikilink TYPE string
  ASSERT $value INSIDE ['EXTRACTED','INFERRED','AMBIGUOUS'];
DEFINE FIELD confidence ON wikilink TYPE float
  ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD evidence ON wikilink TYPE option<array<record<chunk>>>;
DEFINE FIELD agent ON wikilink TYPE option<string>;
DEFINE FIELD approved ON wikilink TYPE bool DEFAULT true;
DEFINE FIELD created_at ON wikilink TYPE datetime DEFAULT time::now();
DEFINE INDEX wikilink_approved ON wikilink FIELDS approved;
DEFINE INDEX wikilink_source ON wikilink FIELDS source;
```

The DAL's schema applier reads the edge-table list from `src/core/db/edgeTables.ts` (a typed const) and emits one provenance block per table on first run. The applier is idempotent.

Deterministic edges insert with `approved = true` directly. Linker proposals insert with `approved = false` and are promoted by the existing approval flow (Phase D1's `approvalService` adapted to the new shape).

### 3.5 Operational tables

```surql
DEFINE TABLE daemon_write SCHEMAFULL;
DEFINE FIELD note ON daemon_write TYPE record<note>;
DEFINE FIELD sha ON daemon_write TYPE string;
DEFINE FIELD agent ON daemon_write TYPE string;
DEFINE FIELD targets ON daemon_write TYPE array<record>;
DEFINE FIELD written_at ON daemon_write TYPE datetime DEFAULT time::now();
DEFINE INDEX daemon_write_sha ON daemon_write FIELDS sha;
DEFINE INDEX daemon_write_note ON daemon_write FIELDS note, written_at;

DEFINE TABLE awaken_run SCHEMAFULL;
DEFINE FIELD status ON awaken_run TYPE string
  ASSERT $value INSIDE ['running','paused','cancelled','completed','failed'];
DEFINE FIELD started_at ON awaken_run TYPE datetime DEFAULT time::now();
DEFINE FIELD finished_at ON awaken_run TYPE option<datetime>;
DEFINE FIELD total ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD processed ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD failed ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD tier_filter ON awaken_run TYPE array<int> DEFAULT [1,2,3];
DEFINE FIELD priority_globs ON awaken_run TYPE array<string> DEFAULT [];
DEFINE FIELD cursor ON awaken_run TYPE option<string>;
DEFINE FIELD error ON awaken_run TYPE option<string>;
```

Phase D1's existing tables (`agent_run`, `agent_event`, `agent_session`, `history`, `staging_node`) are recreated with their current shape; Phase D1 DAL is rewritten to query SurrealDB instead of sql.js. `staging_edge` is deleted because the new edge tables carry an `approved` field directly; staging becomes a filter rather than a separate table.

### 3.6 Agent identity

```surql
DEFINE ACCESS agent_jwt ON DATABASE TYPE JWT
  ALGORITHM HS512 KEY $NOTIENT_AGENT_JWT_KEY
  AUTHENTICATE { IF $token.iss != "notient" { THROW "bad iss" } }
  DURATION FOR SESSION 24h;
```

`$NOTIENT_AGENT_JWT_KEY` is a SurrealQL session parameter set on the DAL connection before the schema is applied, via `db.let("NOTIENT_AGENT_JWT_KEY", secret)`. The secret is read from `~/.notient/<vault-id>/secret.key` (§7). The `DEFINE ACCESS` is therefore re-applied with the same key on every daemon boot; rotating the secret requires re-applying the schema.

The daemon issues JWTs with claim `{ iss: "notient", sub: "<agent-id>" }` signed by the per-vault secret. Agents authenticate with the token; `$auth.id` is available in permission predicates and live-query filters. This is the SurrealDB-native equivalent of the Phase D1 `--as <agent-id>` plumbing. The flag continues to exist on the CLI; it is now plumbed by minting a JWT from the secret rather than a string passed through every RPC.

---

## 4. Note lifecycle

A note progresses through five recorded states, three forward and two terminal. State is derived from the timestamp columns on the `note` table.

```
[discovered_at] -> [tier1_at] -> [tier2_at] -> [tier3_at]
                                                    ^
                                                    |
                                              fully indexed
```

Terminal exits:

```
[any]  -> [tombstoned_at]   on file unlink (kept 60s for rename detection)
[any]  -> [tier1_at = NONE] on stale (file changed since last tier1)
```

State semantics:
- `discovered_at != NONE, tier1_at = NONE`: scanner saw it, parser has not run.
- `tier1_at != NONE`: deterministic edges committed. Note is **queryable** (graph traversals work).
- `tier2_at != NONE`: chunked + embedded. Note is **searchable** (vector + full-text).
- `tier3_at != NONE`: extractor + linker ran. Note is **linkable** (semantic edges proposed).
- `tombstoned_at != NONE`: file was unlinked. Rows remain for 60 seconds; on `add(path')` with matching `sha` within the window, treat as rename (update `path`, clear tombstone). After 60s, cascade delete.
- `last_user_edit_at`: last `sha` change attributable to user authorship (i.e. the previous `sha` is not present in `daemon_write` within the past 5 seconds).

A note is **stale** when its on-disk SHA differs from `note.sha`. Stale notes are re-tiered: `tier1_at` is cleared, then tier 2 and tier 3 follow per priority queue.

Consumer policy:
- `notient search` runs on tier 2; surfaces "X notes still indexing" if `count(tier2_at = NONE) > 0`.
- `notient ask` triggers tier 3 on the retrieval set if any retrieved note has `tier3_at = NONE` and the call is not `--fast`.
- `notient graph dump --tier 1` returns the deterministic skeleton instantly without waiting for tier 2/3.

---

## 5. Indexing pipeline

### 5.1 Priority queue

`src/core/indexer/indexerQueue.ts` is rewritten as a min-heap keyed by `(priority, enqueuedAt)`. Three priorities:

- `0` — Tier 1, sync-fast. Drains before any tier 2 work begins.
- `1` — Tier 2, background. Embeds via Ollama.
- `2` — Tier 3, idle. Extracts and links via LM Studio.

Worker is single-threaded by design; concurrency comes from awaiting Ollama / LM Studio in parallel within a tier 2 / tier 3 step (see §11 config). The `pendingCount(priority?)` API surfaces per-tier backlog so the CLI can render `searchable: 92%, linkable: 71%` accurately.

### 5.2 Tier 1 — deterministic, sync-fast

Triggered by `chokidar` `add` and `change` events; debounced 500ms per path; enqueued at priority 0.

Steps:

1. Read the file. Compute body SHA (frontmatter stripped from SHA so YAML changes that do not affect body do not invalidate the parse cache).
2. If `note.sha` matches: skip.
3. Parse with the unified pipeline. Emit blocks (one per H1/H2/H3, one per top-level paragraph that contains a `^block-id`), wikilinks, embeds, tags, frontmatter refs, structural edges (`contained_in`, `under_heading`).
4. Open a SurrealDB transaction. Upsert the `note`, replace its `block` rows by `note` link, replace its tier 1 edges by `(source IN ['wikilink','embed','frontmatter','structure'], FROM = $note OR FROM IN $note's blocks)`, set `tier1_at = time::now()`. Commit.
5. Cross-reference `daemon_write` by `(note, sha)`: if the inserted SHA matches a recent daemon write, override `source = '<agent>'` for the wikilink/embed edges that match `daemon_write.targets`. This is the echoGuard replacement.
6. Emit `indexer:tier1-done` on the EventBus.
7. Enqueue priority 1 and priority 2 work for this note path unless `--fast` was set.

Tier 1 budget: 50ms median, 200ms p99 on a 50KB note. The work is purely CPU-bound parsing plus a single SurrealDB transaction; no LLM.

### 5.3 Tier 2 — background embed

Triggered by tier 1 completion; enqueued at priority 1.

Steps:

1. Load `block` rows for the note. Group adjacent blocks by heading section into chunks of `<= chunk_target_tokens` (default 400, max 800). One chunk corresponds to one `chunk` row with a `block` reference.
2. For each chunk, call Ollama embeddings. Insert `chunk` row with `vector`, `embed_model`, `embedded_at`. Concurrency capped by config (`indexer.concurrency.embed`, default 4).
3. Set `note.tier2_at = time::now()`.
4. Emit `indexer:tier2-done`.

Tier 2 reuses the existing `chunker` strategy (paragraph + size bound), but it now runs over AST-derived blocks instead of regex-split paragraphs. Chunks carry a `block` reference so retrieval can resolve "which heading section did this match come from."

### 5.4 Tier 3 — idle extract + link

Triggered by tier 2 completion; enqueued at priority 2.

Steps:

1. Run the extractor on the note's chunks. The extractor's prompt and output schema (`{entities, claims, questions}`) are unchanged; only its DAL changes. Insert `concept` / `claim` / `question` rows (idempotent by norm_label / sha). RELATE `mentions`, `asserts`, `asks` edges with `class = 'INFERRED'`, `confidence` from the extractor's score, `approved = true` (these are content-derived, not user-targeted, so no approval gate).
2. Run the linker:
   - Compute the active note's chunk vectors. SurrealDB query: `SELECT note, vector::distance::knn() AS d FROM chunk WHERE vector <|20,40|> $q AND note != $active AND note.tier3_at != NONE FETCH note;` returns top-K candidate notes.
   - Skip candidates that already have a `wikilink` edge to/from the active note: `SELECT id FROM $candidates WHERE id NOT IN (SELECT ->wikilink->note FROM $active) AND id NOT IN (SELECT <-wikilink<-note FROM $active);`. The linker proposes only edges that are not already deterministic.
   - LLM proposes typed edges (`supports`, `extends`, `exemplifies`, `related_to`, optionally `contradicts`) with confidence and evidence chunk IDs.
   - RELATE the edges with `approved = false`, `class = 'INFERRED'`, `agent = 'linker'`. The Phase D1 `approvalService` flow promotes them to `approved = true` on user accept.
3. Set `note.tier3_at = time::now()`.
4. Emit `indexer:tier3-done`.

The skip-already-wikilinked filter is the load-bearing change: the linker's signal-to-noise improves dramatically because user-authored links are no longer re-proposed.

### 5.5 Watcher

`src/daemon/watcher.ts` is updated to listen for `unlink` and to handle rename approximation:

- On `unlink(path)`: set `note.tombstoned_at = time::now()` for that path. Schedule a cleanup task that runs at `tombstoned_at + 60s` and cascade-deletes if the row has not been resurrected.
- On `add(path)`: read the file, compute SHA. If a tombstoned `note` row exists with the same SHA within the 60s window, treat as rename: update its `path`, clear `tombstoned_at`, re-queue tier 1 (because path-based wikilinks pointing to it may have changed semantics). Otherwise, normal new-note flow.

`change` events are unchanged; existing 500ms debounce is unchanged.

---

## 6. SurrealDB server lifecycle

`src/daemon/surrealServer.ts` (new) owns the SurrealDB child process.

### 6.1 Bootstrap

1. Resolve `<vault-id> = sha256(absoluteVaultPath).slice(0, 16)`. Ensure `~/.notient/<vault-id>/` exists (mkdir 700).
2. Check `surreal --version`. If exit code != 0 or version < 3.0.0, print install instructions (`curl -sSf https://install.surrealdb.com | sh`) and exit 2 with a clear message that SurrealDB 3.x is required.
3. Read or generate `~/.notient/<vault-id>/secret.key`:
   - If it exists, read it (chmod-validate: must be 600).
   - If it does not exist, generate `crypto.randomBytes(64).toString("base64")`, write with `mode: 0o600`.
4. Read or pick a port. If `~/.notient/<vault-id>/surreal.port` exists, attempt to reuse; if the port is bound but unresponsive, kill via PID file. Otherwise pick `127.0.0.1:0` (kernel-assigned).
5. Spawn `surreal start --bind 127.0.0.1:<port> --user root --pass <secret> --log warn rocksdb://~/.notient/<vault-id>/data` with `stdio: ['ignore', 'pipe', 'pipe']`.
6. Parse stdout for `Started server at 127.0.0.1:NNNNN`. Write the resolved port to `~/.notient/<vault-id>/surreal.port` and the child PID to `~/.notient/<vault-id>/surreal.pid`.
7. Poll `GET /health` until 200 OK; cap at 5 seconds.
8. Connect via `surrealdb` JS SDK over `ws://127.0.0.1:<port>` using `signin({ user: "root", pass: secret })`.
9. Apply `schema.surql` via the SDK. Idempotent on subsequent boots.
10. Hand the connection to the rest of the daemon via `kernel.set("db", surrealConnection)`.

### 6.2 Supervision

- `child.on("exit", code)`: if the daemon is shutting down, ignore. Otherwise log, wait 1 second, restart. After 3 unexpected exits within 60 seconds, alert on the EventBus (`daemon:db_failed`) and exit the daemon with code 4.
- `daemon shutdown`: `kernel.close()` first (drains queues, persists awaken_run state), then SIGTERM the child, wait 10s, SIGKILL.

### 6.3 Operator access

`notient db sql` execs `surreal sql --endpoint ws://127.0.0.1:<port> --user root --pass <secret> --ns notient --db vault` for an interactive REPL. The secret is read from disk; the user does not see it. This is the operator escape hatch for debugging without touching the daemon's code.

---

## 7. Vault identity and secrets

| Path | Purpose | Mode |
|---|---|---|
| `~/.notient/<vault-id>/` | Per-vault state directory | 700 |
| `~/.notient/<vault-id>/data/` | RocksDB data files | 700 |
| `~/.notient/<vault-id>/secret.key` | Root password and JWT signing key (same secret) | 600 |
| `~/.notient/<vault-id>/surreal.port` | Last-bound port for operator `surreal sql` | 644 |
| `~/.notient/<vault-id>/surreal.pid` | SurrealDB child PID | 644 |
| `<vault>/.notient/config.toml` | Per-vault user-editable configuration | 644 |
| `<vault>/.notient/notient.sock` | Daemon RPC socket (Phase A unchanged) | 600 |

`<vault-id>` is `sha256(absoluteVaultPath).slice(0, 16)` (lowercase hex). Two vaults at different paths get distinct directories. Renaming a vault on disk produces a new `<vault-id>` and a fresh awaken; this is acceptable because rename is a manual operation and the old data dir can be deleted by the user.

---

## 8. Markdown parser and AST-aware write-back

### 8.1 Parser pipeline

`src/core/markdown/pipeline.ts` (new) constructs the unified pipeline once and exposes `parse(source: string): MarkdownAst` and `stringify(ast: MarkdownAst): string`. Plugins:

1. `remark-parse` — base CommonMark parser.
2. `remark-frontmatter` — YAML frontmatter as an AST node.
3. `remark-gfm` — GFM tables, strikethrough, task list items.
4. `src/core/markdown/plugins/remark-wikilink.ts` (new) — parses `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target#^block]]`, and `![[target]]` (embed). Produces `wikiLink` and `wikiEmbed` AST node types with `target`, `alias?`, `heading?`, `block?` fields.
5. `src/core/markdown/plugins/remark-block-id.ts` (new) — parses inline `^block-id` markers per Obsidian convention (end of paragraph or list item). Annotates the parent block node with `blockId`.
6. `src/core/markdown/plugins/remark-tag.ts` (new) — scans text nodes outside code spans and code blocks for `#tag/sub` patterns. Produces `tagRef` AST nodes.

The pipeline is deterministic, idempotent over `parse → stringify → parse`, and round-trips on every fixture vault note. A single test fixture (`src/core/markdown/__fixtures__/golden.md`) exercises every node type and is round-trip checked.

### 8.2 Tier 1 extractor

`src/core/markdown/extractor.ts` (new) walks the AST and emits a `MarkdownExtraction` shape:

```typescript
export interface MarkdownExtraction {
  blocks: BlockSpec[];        // one per H1/H2/H3 + every block with explicit ^id
  wikilinks: WikilinkSpec[];  // FROM = note or block, TO = note|block, with heading_slug for resolution
  embeds: EmbedSpec[];        // same but for ![[...]]
  tags: TagSpec[];            // FROM = note or block, TO = tag path
  frontmatterRefs: FrontmatterRefSpec[]; // FROM = note, TO = note, key (e.g. "supports", "related")
  frontmatter: Record<string, unknown>;  // canonical YAML object
}
```

The extractor is pure: no DB, no IO. The Tier 1 indexer turns the extraction into SurrealDB writes inside one transaction.

### 8.3 Wikilink resolution

`[[target]]` resolves to a `note` row. `[[target#heading]]` resolves to a `block` row with `(note, heading_slug)`. `[[target#^id]]` resolves to a `block` row with `(note, block_id)`. `[[target#H4]]` resolves to the H3 ancestor `block` plus a `heading_path` annotation on the wikilink edge so the original anchor is recoverable.

Resolution proceeds in two passes per note:

1. Same-vault target lookup. `target` is matched first against `note.path` exact-match (modulo `.md` extension), then against the basename if no folder is given. Ambiguous basename matches resolve to the closest by edit distance to the active note's folder.
2. Block lookup if `#heading` or `#^id` is present.

Unresolved wikilinks are still inserted with `target = NONE` and a `target_unresolved: string` annotation. The `links audit` CLI verb surfaces unresolved links.

### 8.4 Write-back via AST stringify

`src/core/markdown/writeback.ts` (new) replaces `src/core/graph/nativeGraphBridge.ts`. Two write modes:

- `applyApprovedLink({ notePath, target, heading?, block? })`: parses the note, ensures a `## Related` section, appends a `[[target]]` (or `[[target#heading]]`) wikilink as a list item if not already present, stringifies. Idempotent.
- `applyApprovedRelation({ notePath, key, target })`: parses the note, ensures a `notient.<key>` array in YAML frontmatter, appends `[[target]]` if not already present, stringifies. Idempotent.

Both functions:
1. Read the file body.
2. Parse to AST.
3. Apply the AST mutation.
4. Stringify with the same pipeline. The stringified output is byte-deterministic for a given AST.
5. Compute SHA of the new body.
6. Insert a `daemon_write` row recording `(note, sha, agent, targets[])` BEFORE writing to disk.
7. Atomic write the file via the existing facade.
8. Record the change in `history` (Phase D1 contract preserved).

The daemon-write insert before the file write ensures Tier 1's reader cannot race ahead of the provenance record. The 5-second window in `last_user_edit_at` derivation tolerates clock skew.

---

## 9. Awaken control plane

### 9.1 State

`awaken_run` table records every awaken invocation. The daemon holds one "current" run id in memory; on restart it resolves the latest non-completed run.

### 9.2 Commands

- `notient awaken [--tier 1|2|3] [--priority "<glob>,<glob>"] [--background]`: start a new run. Inserts `awaken_run` with `status = 'running'`. Walks the vault, enqueues each note at the requested tier filter. Blocks until `status` becomes `completed`, `paused`, `cancelled`, or `failed`, unless `--background` is set in which case it returns after the enqueue phase and the daemon continues processing.
- `notient awaken --pause`: writes `UPDATE awaken_run:current SET status = 'paused';`. The worker subscribes via `LIVE SELECT status FROM awaken_run:current` and gracefully drains in-flight notes, persists state, exits the work loop.
- `notient awaken --resume`: finds the latest run with `status IN ['paused','failed']`, sets `status = 'running'`, re-derives the cursor from notes with the lowest tier timestamp, continues.
- `notient awaken --cancel`: writes `status = 'cancelled'`. Worker drains and exits without re-enqueueing.
- `notient awaken --status`: emits NDJSON status frames every 1s while the run is active: `{ runId, status, processed, total, failed, perSecond, etaSeconds }`.

### 9.3 Initial awaken on a fresh vault

`notient awaken` on an unindexed vault does the full Tier 1 → Tier 2 → Tier 3 pass per note. Tier 1 drains first across the whole vault; this gives the user a queryable graph quickly. Tier 2 runs second across all notes. Tier 3 runs last. This ordering is enforced by the priority queue; it is NOT enforced by sequencing the awaken loop, which simply enqueues everything at all three tiers and lets the priority discipline order the work.

The default mode is **block until done**. A 100k-note vault on the locked substrate is hours of LLM time; the user is informed and can pause at any moment.

---

## 10. Configuration

`<vault>/.notient/config.toml` is the only user-editable configuration. It is read on daemon start; changes require a daemon restart (no live-reload in this redesign).

```toml
[indexer]
debounce_ms = 500

[indexer.concurrency]
embed = 4              # parallel Ollama calls per tier 2 note
extract = 2            # parallel LM Studio calls per tier 3 note

[indexer.chunk]
target_tokens = 400
max_tokens = 800

[awaken]
default_tier_filter = [1, 2, 3]
default_priority_globs = ["daily/**", "MOCs/**"]

[surrealdb]
hnsw_cache_mib = 512   # SURREAL_HNSW_CACHE_SIZE; bump for vaults > ~50k chunks
log_level = "warn"
```

A minimal config is generated by `notient init` if absent. Keys not specified in the file fall back to the documented defaults.

---

## 11. CLI surface

### 11.1 New verbs

- `notient graph dump [--tier 1|2|3] [--format json|graphml|cypher]`: export the graph at the given tier. Default tier is the highest non-NONE tier across all notes.
- `notient graph stats`: print node and edge counts grouped by type and `source`. One line per (table, source) pair.
- `notient links sync`: idempotent reverse-sweep. For every approved edge that does not yet have a corresponding wikilink in the source note's body or frontmatter, apply the write-back. Useful after a manual frontmatter edit.
- `notient links audit`: report unresolved wikilinks, dangling block refs, orphan tags. NDJSON output.
- `notient backup [--out <path>]`: shell out to `surreal export --endpoint ws://127.0.0.1:<port> --ns notient --db vault <out>`. Default out is `~/.notient/<vault-id>/backups/<ISO-timestamp>.surql`.
- `notient restore <path>`: shell out to `surreal import` against the running daemon. Refuses to run if the database has any non-empty table; user must `notient nuke` first.
- `notient nuke`: stop the daemon, delete `~/.notient/<vault-id>/data/`, restart. Confirmation prompt unless `--yes`.
- `notient db sql`: open `surreal sql` REPL against the running daemon.
- `notient migrate-vault <new-absolute-path>`: backup, stop daemon, write new path mapping, start daemon at the new vault-id, restore. Single-step vault relocation.

### 11.2 Modified verbs

- `notient awaken` gains `--tier`, `--priority`, `--background`, `--pause`, `--resume`, `--cancel`, `--status` as documented in §9.
- `notient reindex <glob>` gains `--tier 1|2|3` (re-runs only the specified tier on matching notes).
- `notient search` adds a tier coverage line to its header: `(searchable: 92%, linkable: 71%)`.
- `notient health` checks the SurrealDB child process status alongside Ollama and LM Studio.

### 11.3 Phase D1 verbs preserved

`notient ask`, `notient brief`, `notient distill`, `notient events`, `notient session grant|revoke|list`, the `--as <agent-id>` global flag, `notient chat`, `notient init`, `notient daemon`, `notient vitals` — all preserved in shape and behaviour. Their internals query SurrealDB instead of sql.js. The JWT plumbing for `--as` replaces the per-RPC `clientIdentity` parameter passing for new code; existing parameter passing continues to work for backwards compatibility within Phase D1.

---

## 12. Files to delete

This is the punch list. The implementation plan executes deletes by name in a single commit per category.

### 12.1 Storage substrate (delete entirely)

- `src/core/db/database.ts`
- `src/core/db/database.test.ts`
- `src/core/db/migrations.ts`
- `src/core/db/migrations.test.ts`
- `src/core/db/schema.ts` (replaced by `schema.surql` + applier)

### 12.2 Vector index (delete entirely)

- `src/core/indexer/hnswVectorIndex.ts`
- `src/core/indexer/hnswEnvShim.ts`
- `src/core/indexer/vectorIndex.test.ts`

### 12.3 Canvas (delete entirely)

- `src/core/canvas/canvasGenerator.ts`
- `src/core/canvas/canvasGenerator.test.ts`
- `src/core/canvas/canvasFromResults.ts`
- `src/core/canvas/canvasFromResults.test.ts`
- `src/core/canvas/types.ts`

### 12.4 Graph subsystem (delete entirely)

- `src/core/graph/graphStore.ts`
- `src/core/graph/graphStore.test.ts`
- `src/core/graph/nativeGraphBridge.ts`
- `src/core/graph/nativeGraphBridge.test.ts`
- `src/core/graph/relatedSection.ts`
- `src/core/graph/relatedSection.test.ts`
- `src/core/graph/frontmatterWriter.ts`
- `src/core/graph/frontmatterWriter.test.ts`

### 12.5 Echo guard (delete entirely)

- `src/core/services/echoGuard.ts`
- `src/core/services/echoGuard.test.ts`

### 12.6 Staging inverters (delete entirely; staging is a filter on the live edge tables now)

- `src/core/history/inverters/edgeApprove.ts`
- `src/core/history/inverters/edgeReject.ts`
- `src/core/history/inverters/nodeApprove.ts`
- `src/core/history/inverters/nodeReject.ts`

### 12.7 Dependencies to remove from `package.json`

- `sql.js`
- `@types/sql.js`
- `hnswlib-wasm`

### 12.8 Dependencies to add to `package.json`

- `surrealdb` (latest 2.x SDK targeting SurrealDB 3.x server)
- `unified`
- `remark-parse`
- `remark-stringify`
- `remark-frontmatter`
- `remark-gfm`
- `mdast-util-to-string`
- `unist-util-visit`

The custom remark plugins are in-repo (`src/core/markdown/plugins/`); no external `remark-wiki-link` dependency.

---

## 13. Files to rewrite (logic preserved, DAL changed)

The list follows the audit. The rewrite is mechanical: replace `db.run(...)` / `db.query(...)` calls with `db.create()`, `db.relate()`, `db.select()`, `db.query()` against SurrealDB.

- `src/core/agents/linker.ts`, `linker.test.ts` — neighbor query becomes one SurrealQL with kNN + skip-already-linked filter.
- `src/core/agents/synthesizer.ts`, `synthesizer.test.ts`
- `src/core/agents/contradictionHunter.ts`, `contradictionHunter.test.ts`
- `src/core/agents/maturityAdvancer.ts`, `maturityAdvancer.test.ts`
- `src/core/approvals/approvalService.ts`, `approvalService.test.ts` — staging becomes `WHERE approved = false`.
- `src/core/history/historyService.ts`, `history*.test.ts`
- `src/core/history/inverters/noteCreate.ts`, `noteAppendSection.ts`, `noteFrontmatter.ts`, `noteMaturity.ts`
- `src/core/search/searchPipeline.ts`, all `search/strategies/*.ts`, `graphExpansion.ts`
- `src/core/chat/tools/notes.ts`, `proposals.ts`, `agents.ts`, `vault.ts`, `graph.ts`, `contextManager.ts`, `conversationStore.ts` and their tests
- `src/core/coAuthor/voiceContext.ts`, `chatStream.ts` and their tests
- `src/core/coordinator/coordinator.ts`
- `src/core/services/agentEventStore.ts`, `sessionGrants.ts`, plus tests
- `src/core/stream/streamService.ts` plus tests
- `src/core/vitals/vitalsService.ts` plus tests
- `src/core/indexer/indexNote.ts`, `indexerQueue.ts`, `chunker.ts`, `extractor.ts`, `embedder.ts`, `watcher.ts` and their tests
- `src/daemon/bootstrap.ts`, `daemon/handlers/*.ts` (Phase D1 handlers)
- `src/cli/commands/init.ts`, `awaken.ts`, `reindex.ts`, `search.ts`, `vitals.ts`, `health.ts`, `chat.ts`, `ask.ts`, `brief.ts`, `distill.ts`, `events.ts`, `session.ts`, `daemon.ts`

### 13.1 Files to patch only (remove imports / refs)

- `src/core/kernel.ts` — drop canvas registrations, drop graph store registration, register the new SurrealDB connection slot.
- `src/cli/index.ts` — drop the WASM path resolver.
- `src/cli/client.ts` — drop the IDBFS comment and any sql.js cold-start references.

---

## 14. Phase D1 preservation checklist

The following surfaces continue to work end to end. Their internals query SurrealDB; their public shape is unchanged. The implementation plan includes a smoke pass that exercises each.

- `notient ask <intent>` — read-only intent dispatch with structured response.
- `notient brief <topic>` — deterministic search + graph + summary.
- `notient distill --from <path>` — transcript ingestion to proposals.
- `notient events --since <id>` — long-poll `agent_event` table, NDJSON output.
- `notient session grant|revoke|list` — scoped trust grants in `agent_session`.
- `--as <agent-id>` global flag — now plumbed via JWT signed by the per-vault secret; the old per-RPC `clientIdentity` parameter continues to work as a fallback for any caller that has not adopted JWTs.
- `agent_run`, `agent_event`, `agent_session`, `history` tables — same shape, recreated under SurrealDB schemafull.
- `EventBus`, `historyService`, `approvalService` — same contract, new DAL.

---

## 15. Phase plan

Five phases, sequential, each reviewable as one PR-sized chunk against `beta-spec`. Each phase ends with a green smoke pass. No backwards-compatibility shims between phases; the branch is a working tree until the final merge. The phases are dependency-ordered, not effort-estimated.

The acceptance below describes the *capability* shipped per phase. Specific file deletions, dependency removals, and DAL rewrites are owned by the per-phase plan files in `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-{1..5}.md`. The deletion lists in §12 of this spec are the cumulative end-state, not a phase-1 mandate.

| # | Phase | Done when |
|---|---|---|
| 1 | Storage substrate swap | `surrealServer.ts` supervises `surreal start`, `schema.surql` applies cleanly, `src/core/db/surreal.ts` exposes the typed DAL, daemon boots green, smoke passes: insert a `note`, RELATE a `wikilink`, run an HNSW kNN query. SQLite consumers continue to work; their migration is incremental across subsequent phases. |
| 2 | Markdown parser + Tier 1 | unified/remark pipeline plus the three custom plugins (wikilink/embed, block-id, tag) land. AST round-trip golden test is green. Tier 1 indexer commits deterministic edges to SurrealDB on save. Unresolved wikilinks persist with a null target so `links audit` (Phase 5) can surface them. Watcher handles `unlink` and 60s SHA-match rename. |
| 3 | Tier 2 + Tier 3 + priority queue | `IndexerQueue` is a priority min-heap. Tier 2 chunks/embeds via Ollama into SurrealDB native HNSW. Tier 3 retargets the extractor and linker at the new schema; linker uses recursive SurrealQL with a skip-already-linked filter. The external HNSW library is no longer in the dependency graph. |
| 4 | Awaken control plane + AST write-back | `awaken --pause/--resume/--cancel/--status` are functional and `awaken_run` state survives daemon restart. AST-aware write-back replaces the regex-based bridge; round-trip is byte-deterministic. `daemon_write` provenance is recorded on every write; the JSON-file echoGuard is gone. The approval-and-write flow has documented failure semantics and rollback tests covering crashes after every step. |
| 5 | New CLI verbs + cleanup | `graph dump`, `graph stats`, `links sync`, `links audit`, `backup`, `restore`, `nuke`, `db sql`, `migrate-vault` are all functional with documented failure semantics (`migrate-vault` in particular: verified backup, checked restore exit, source-daemon restart on failure, target cleanup on failure, integration test that injects restore failure). `awaken --tier` and `reindex --tier` are plumbed. Phase D1 verbs are green against the new schema. Final dead-code sweep verifies no `sql.js` / `hnswlib-wasm` / canvas references remain anywhere in `src/`. |

The implementation plan in `docs/superpowers/plans/2026-04-29-vault-enrichment-data-model-plan.md` decomposes each phase into per-task checklist items with acceptance criteria.

---

## 16. Footguns and operational notes

These are known SurrealDB and pipeline traps the implementer must respect.

1. **`SCHEMAFULL` silently drops undefined fields on write.** No error, no warning. CI smoke must round-trip a record with an extra field and assert the field is missing on read; this catches regressions where the schema gets out of sync with the DAL types.
2. **HNSW is in-memory and rebuilt on startup.** Default cache is 256 MiB. For vaults with more than ~50k chunks at 768 dims, bump `SURREAL_HNSW_CACHE_SIZE` via the env var passed to `surreal start`. The config file's `surrealdb.hnsw_cache_mib` controls this.
3. **`MTREE` is removed in SurrealDB 3.0.** Use `HNSW` only. If the docs ever reference `MTREE`, ignore them; we target 3.x.
4. **`SEARCH ANALYZER` was renamed to `FULLTEXT ANALYZER` in 3.x.** `schema.surql` uses `FULLTEXT`. Do not copy older 2.x examples.
5. **`REMOVE FIELD` on a schemafull table breaks subsequent UPDATEs until the orphan data is unset.** Since we have no migrations, this only matters if a developer edits `schema.surql` mid-development; the answer is to `notient nuke` and re-`awaken`.
6. **Live queries are WebSocket-only.** The HTTP RPC endpoint does not stream. Awaken's `LIVE SELECT status FROM awaken_run` requires the WS connection that `surrealdb.js` uses by default.
7. **Edge tables are tables.** They can be indexed and full-text searched. We do not exploit this in the v1 of this redesign, but the schema preserves the option.
8. **Embedded mode is alpha.** Do not propose switching to `@surrealdb/node` until it ships stable. Server mode is the only supported deployment.
9. **Backup format is plain `.surql` text.** No binary or incremental backup is documented in stable. `notient backup` produces a SurrealQL dump; for very large vaults this can be slow. Acceptable for v1.
10. **Echo race window.** The 5-second window for `last_user_edit_at` derivation tolerates clock skew between the daemon-write insert and the chokidar `change` event. Do not shorten this without testing on a slow filesystem.

---

## 17. Hard rules (carry forward from v0.1 design)

- TypeScript strict. No `any` without justification.
- No `console.log` outside `src/cli/output.ts` and the existing `debug<Subsystem>` helpers.
- No abbreviations in identifiers: `context` not `ctx`, `error` not `err`, `message` not `msg`, `event` not `evt`, `index` not `idx`, `options` not `opts`, `database` not `db` in product surfaces (variable names like `db` for the SurrealDB connection are fine internally).
- No `[noun] - [parenthetical clause]` dash-clause prose anywhere in code, comments, commit messages, or docs.
- No emojis in source.
- One commit per logical step on `beta-spec`. Stage by name only; no `git add -A`.
- Substrate tests stay green throughout each phase. New tests are additive and targeted; no test scaffolding for tests' sake.
- The kernel is the only place where new DAL slots get registered.
- No mocks beyond what is already in `src/core/__fakes__/`. The fixture vault and the locked LM Studio + Ollama substrate are the test substrate.

---

## 18. Open questions resolved

| Question | Resolution |
|---|---|
| Embedded vs server SurrealDB | Server, supervised by daemon. §6. |
| Per-vault data location | `~/.notient/<vault-id>/`, `<vault-id>` is sha256-prefix of absolute vault path. §7. |
| JWT secret location | `~/.notient/<vault-id>/secret.key`, chmod 600, generated on first run. §7. |
| Heading node depth | Cap at H3; H4-H6 are content within nearest H3 ancestor. §3.2, §8.3. |
| Markdown parser | unified/remark with three custom plugins. §8.1. |
| Schema migrations | None. Wipe and re-awaken on schema changes during development. §2.5. |
| Rename detection | 60-second SHA-match window via `tombstoned_at`. §5.5. |
| Echo guard | Replaced by `daemon_write` provenance table. §3.5, §8.4. |
| Awaken default mode | Block until done. `--background` for daemon-trailing mode. §9. |
| Canvas surface | Deleted entirely. Obsidian's native graph view is the renderer. §1, §12.3. |

---

## 19. References

- v0.1 CLI design: `docs/superpowers/specs/2026-04-27-notient-cli-design.md`
- Pivot decision: `docs/PIVOT-CLI-2026-04-27.md`
- Phase D1 plan (in flight, preserved here): `docs/superpowers/plans/2026-04-28-cli-phase-d.md`
- SurrealDB 3.x docs: `https://surrealdb.com/docs/surrealdb` (vector indexes, graph relations, define statements, full-text search, JWT access, JS SDK).
- The audit corpus that informed this spec is captured in the brainstorming session of 2026-04-29 (Claude Code transcript); the three investigation reports it produced are not checked in but their findings are reflected throughout this document.
