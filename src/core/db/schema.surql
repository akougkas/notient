-- Notient vault SurrealDB schema.
-- Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md §3.
-- Idempotent: namespace/database use IF NOT EXISTS; all other DEFINEs use OVERWRITE.
-- Edge-table provenance fields are emitted at runtime by the schema applier
-- using src/core/db/edgeTables.ts; they are intentionally NOT inlined here.

-- §3.1 Namespace and database
DEFINE NAMESPACE IF NOT EXISTS notient;
USE NS notient;
DEFINE DATABASE IF NOT EXISTS vault;
USE DB vault;

-- §3.2 Core entity tables
DEFINE TABLE OVERWRITE note SCHEMAFULL;
DEFINE FIELD OVERWRITE path ON note TYPE string
  ASSERT $value != NONE
  AND !string::starts_with($value, "/")
  AND !string::contains($value, "\\");
DEFINE FIELD OVERWRITE sha ON note TYPE string;
DEFINE FIELD OVERWRITE word_count ON note TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE discovered_at ON note TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE tier1_at ON note TYPE option<datetime>;
DEFINE FIELD OVERWRITE tier2_at ON note TYPE option<datetime>;
DEFINE FIELD OVERWRITE tier3_at ON note TYPE option<datetime>;
DEFINE FIELD OVERWRITE tombstoned_at ON note TYPE option<datetime>;
DEFINE FIELD OVERWRITE last_user_edit_at ON note TYPE option<datetime>;
DEFINE FIELD OVERWRITE maturity ON note TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ['raw','adolescent','draft','review','mature','synthesis-ready'];
DEFINE FIELD OVERWRITE health ON note TYPE option<float>;
DEFINE FIELD OVERWRITE freshness ON note TYPE option<float>;
DEFINE INDEX OVERWRITE note_path ON note FIELDS path UNIQUE;
DEFINE INDEX OVERWRITE note_sha ON note FIELDS sha;
DEFINE INDEX OVERWRITE note_tombstone ON note FIELDS tombstoned_at;

DEFINE TABLE OVERWRITE block SCHEMAFULL;
DEFINE FIELD OVERWRITE note ON block TYPE record<note>;
DEFINE FIELD OVERWRITE block_id ON block TYPE option<string>;
DEFINE FIELD OVERWRITE heading_path ON block TYPE array<string> DEFAULT [];
DEFINE FIELD OVERWRITE heading_slug ON block TYPE option<string>;
DEFINE FIELD OVERWRITE heading_level ON block TYPE option<int>
  ASSERT $value = NONE OR ($value >= 1 AND $value <= 3);
DEFINE FIELD OVERWRITE ord ON block TYPE int;
DEFINE FIELD OVERWRITE start_line ON block TYPE int;
DEFINE FIELD OVERWRITE end_line ON block TYPE int;
DEFINE FIELD OVERWRITE text ON block TYPE string;
DEFINE INDEX OVERWRITE block_note ON block FIELDS note;
DEFINE INDEX OVERWRITE block_heading ON block FIELDS note, heading_slug;
DEFINE INDEX OVERWRITE block_explicit_id ON block FIELDS note, block_id UNIQUE;

DEFINE TABLE OVERWRITE chunk SCHEMAFULL;
DEFINE FIELD OVERWRITE note ON chunk TYPE record<note>;
DEFINE FIELD OVERWRITE block ON chunk TYPE option<record<block>>;
DEFINE FIELD OVERWRITE ord ON chunk TYPE int;
DEFINE FIELD OVERWRITE text ON chunk TYPE string;
DEFINE FIELD OVERWRITE token_estimate ON chunk TYPE int;
DEFINE FIELD OVERWRITE vector ON chunk TYPE option<array<float, 768>>;
DEFINE FIELD OVERWRITE embed_model ON chunk TYPE option<string>;
DEFINE FIELD OVERWRITE embedded_at ON chunk TYPE option<datetime>;
DEFINE INDEX OVERWRITE chunk_note_ord ON chunk FIELDS note, ord UNIQUE;
DEFINE INDEX OVERWRITE chunk_vec ON chunk FIELDS vector
  HNSW DIMENSION 768 DIST COSINE EFC 200 M 16;

DEFINE ANALYZER OVERWRITE notient_text TOKENIZERS class, blank
  FILTERS lowercase, ascii, snowball(english);
DEFINE INDEX OVERWRITE chunk_text ON chunk FIELDS text
  FULLTEXT ANALYZER notient_text BM25 HIGHLIGHTS;

DEFINE TABLE OVERWRITE tag SCHEMAFULL;
DEFINE FIELD OVERWRITE path ON tag TYPE string
  ASSERT string::matches($value, "^[a-z0-9][a-z0-9/_-]*$");
DEFINE INDEX OVERWRITE tag_path ON tag FIELDS path UNIQUE;

DEFINE TABLE OVERWRITE concept SCHEMAFULL;
DEFINE FIELD OVERWRITE label ON concept TYPE string;
DEFINE FIELD OVERWRITE norm_label ON concept TYPE string;
DEFINE INDEX OVERWRITE concept_norm ON concept FIELDS norm_label UNIQUE;

DEFINE TABLE OVERWRITE claim SCHEMAFULL;
DEFINE FIELD OVERWRITE text ON claim TYPE string;
DEFINE FIELD OVERWRITE sha ON claim TYPE string;
DEFINE INDEX OVERWRITE claim_sha ON claim FIELDS sha UNIQUE;

DEFINE TABLE OVERWRITE question SCHEMAFULL;
DEFINE FIELD OVERWRITE text ON question TYPE string;
DEFINE FIELD OVERWRITE sha ON question TYPE string;
DEFINE INDEX OVERWRITE question_sha ON question FIELDS sha UNIQUE;

-- §3.4 Edge tables (15 total). Provenance fields are appended at runtime
-- by the schema applier via src/core/db/edgeTables.ts::provenanceFields().

-- Deterministic (Tier 1; class = 'EXTRACTED').
-- TYPE RELATION enforces `out` as a non-null record, so unresolved
-- wikilink and embed targets persist in the dedicated
-- `wikilink_unresolved` and `embed_unresolved` tables defined below
-- (TYPE NORMAL). The `links audit` CLI verb in Phase 5 reads those
-- tables directly and the wikilink/embed traversals stay clean.
DEFINE TABLE OVERWRITE wikilink TYPE RELATION FROM note|block TO note|block SCHEMAFULL;
DEFINE TABLE OVERWRITE embed TYPE RELATION FROM note|block TO note|block SCHEMAFULL;
DEFINE TABLE OVERWRITE frontmatter_ref TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE tagged TYPE RELATION FROM note|block TO tag SCHEMAFULL;
DEFINE TABLE OVERWRITE contained_in TYPE RELATION FROM block TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE under_heading TYPE RELATION FROM block TO block SCHEMAFULL;

-- Unresolved deterministic ancillary tables. TYPE NORMAL because
-- SurrealDB 3.x TYPE RELATION rejects an option<record> on the
-- implicit `out` field. Each row records the originating note or
-- block plus the raw `[[target]]` text the resolver could not match.
-- Phase 5's `links audit` reads these tables directly. They are NOT
-- in EDGE_TABLES and do not receive the provenance-fields block.
DEFINE TABLE OVERWRITE wikilink_unresolved SCHEMAFULL;
DEFINE FIELD OVERWRITE in ON wikilink_unresolved TYPE record<note|block>;
DEFINE FIELD OVERWRITE raw_target ON wikilink_unresolved TYPE string;
DEFINE FIELD OVERWRITE source ON wikilink_unresolved TYPE string;
DEFINE FIELD OVERWRITE created_at ON wikilink_unresolved TYPE datetime DEFAULT time::now();
DEFINE INDEX OVERWRITE wikilink_unresolved_in ON wikilink_unresolved FIELDS in;

DEFINE TABLE OVERWRITE embed_unresolved SCHEMAFULL;
DEFINE FIELD OVERWRITE in ON embed_unresolved TYPE record<note|block>;
DEFINE FIELD OVERWRITE raw_target ON embed_unresolved TYPE string;
DEFINE FIELD OVERWRITE source ON embed_unresolved TYPE string;
DEFINE FIELD OVERWRITE created_at ON embed_unresolved TYPE datetime DEFAULT time::now();
DEFINE INDEX OVERWRITE embed_unresolved_in ON embed_unresolved FIELDS in;

-- Extracted semantic (Tier 3 extractor; class = 'INFERRED')
DEFINE TABLE OVERWRITE mentions TYPE RELATION FROM note|block TO concept SCHEMAFULL;
DEFINE TABLE OVERWRITE asserts TYPE RELATION FROM note|block TO claim SCHEMAFULL;
DEFINE TABLE OVERWRITE asks TYPE RELATION FROM note|block TO question SCHEMAFULL;

-- Proposed semantic (Tier 3 linker; class = 'INFERRED', approved = false)
DEFINE TABLE OVERWRITE supports TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE contradicts TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE extends TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE exemplifies TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE synthesizes TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE related_to TYPE RELATION FROM note TO note SCHEMAFULL;

-- §3.5 Operational tables
DEFINE TABLE OVERWRITE daemon_write SCHEMAFULL;
DEFINE FIELD OVERWRITE note ON daemon_write TYPE record<note>;
DEFINE FIELD OVERWRITE sha ON daemon_write TYPE string;
DEFINE FIELD OVERWRITE agent ON daemon_write TYPE string;
DEFINE FIELD OVERWRITE targets ON daemon_write TYPE array<record>;
DEFINE FIELD OVERWRITE written_at ON daemon_write TYPE datetime DEFAULT time::now();
DEFINE INDEX OVERWRITE daemon_write_sha ON daemon_write FIELDS sha;
DEFINE INDEX OVERWRITE daemon_write_note ON daemon_write FIELDS note, written_at;

-- Universal undo log. Phase 4 Task 3 records `note.append_section` and
-- `note.frontmatter` rows directly here from `ApprovalService`; Task 4
-- migrates the remaining producers off the SQLite mirror. `before` and
-- `after` are JSON-stringified at insert time because SurrealDB 3.x does
-- not accept `option<any>` for arbitrary nested payloads; the producer
-- and consumer agree on `JSON.parse` at read time.
DEFINE TABLE OVERWRITE history SCHEMAFULL;
DEFINE FIELD OVERWRITE kind ON history TYPE string;
DEFINE FIELD OVERWRITE target ON history TYPE string;
DEFINE FIELD OVERWRITE before ON history TYPE option<string>;
DEFINE FIELD OVERWRITE after ON history TYPE option<string>;
DEFINE FIELD OVERWRITE client_identity ON history TYPE string DEFAULT 'human';
DEFINE FIELD OVERWRITE created_at ON history TYPE datetime DEFAULT time::now();
DEFINE INDEX OVERWRITE history_kind ON history FIELDS kind;
DEFINE INDEX OVERWRITE history_target ON history FIELDS target;

DEFINE TABLE OVERWRITE awaken_run SCHEMAFULL;
DEFINE FIELD OVERWRITE status ON awaken_run TYPE string
  ASSERT $value INSIDE ['running','paused','cancelled','completed','failed'];
DEFINE FIELD OVERWRITE started_at ON awaken_run TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE finished_at ON awaken_run TYPE option<datetime>;
DEFINE FIELD OVERWRITE total ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE processed ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE failed ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE tier_filter ON awaken_run TYPE array<int> DEFAULT [1,2,3];
DEFINE FIELD OVERWRITE priority_globs ON awaken_run TYPE array<string> DEFAULT [];
DEFINE FIELD OVERWRITE cursor ON awaken_run TYPE option<string>;
DEFINE FIELD OVERWRITE error ON awaken_run TYPE option<string>;
DEFINE FIELD OVERWRITE failure_reason ON awaken_run TYPE option<string>;

-- Phase D1 ledger of swarm discoveries surfaced through `notient events
-- --since <cursor>`. The `seq` field is the wire cursor: the producer assigns
-- it monotonically inside a transaction so external clients can drain a
-- consistent stream by passing the highest seq they have seen. `payload` is
-- JSON-stringified at insert time because SurrealDB 3.x does not accept
-- option<any> for arbitrary nested payloads; the producer and consumer agree
-- on JSON.parse at read time. `ts_ms` mirrors the historical SQLite `ts`
-- column so the wire shape stays a number rather than a SurrealDB datetime.
DEFINE TABLE OVERWRITE agent_event SCHEMAFULL;
DEFINE FIELD OVERWRITE seq ON agent_event TYPE int;
DEFINE FIELD OVERWRITE kind ON agent_event TYPE string;
DEFINE FIELD OVERWRITE payload ON agent_event TYPE option<string>;
DEFINE FIELD OVERWRITE ts_ms ON agent_event TYPE int;
DEFINE FIELD OVERWRITE created_at ON agent_event TYPE datetime DEFAULT time::now();
DEFINE INDEX OVERWRITE agent_event_seq ON agent_event FIELDS seq UNIQUE;
DEFINE INDEX OVERWRITE agent_event_kind ON agent_event FIELDS kind;

-- Phase D1 scoped trust grants for unattended writes. `seq` mirrors the
-- numeric id the wire shape exposes so callers see the same stable identifier
-- across the SQLite-era and SurrealDB-era storage. `allowed_folders` and
-- `allowed_tools` stay JSON-stringified because the consumer (ApprovalGate)
-- expects a string array on read; encoding parity with the SQLite mirror
-- keeps the JSON.parse path identical.
DEFINE TABLE OVERWRITE agent_session SCHEMAFULL;
DEFINE FIELD OVERWRITE seq ON agent_session TYPE int;
DEFINE FIELD OVERWRITE client ON agent_session TYPE string;
DEFINE FIELD OVERWRITE granted_at ON agent_session TYPE int;
DEFINE FIELD OVERWRITE expires_at ON agent_session TYPE int;
DEFINE FIELD OVERWRITE allowed_folders ON agent_session TYPE string;
DEFINE FIELD OVERWRITE allowed_tools ON agent_session TYPE string;
DEFINE FIELD OVERWRITE max_writes ON agent_session TYPE option<int>;
DEFINE FIELD OVERWRITE used_writes ON agent_session TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE revoked_at ON agent_session TYPE option<int>;
DEFINE INDEX OVERWRITE agent_session_seq ON agent_session FIELDS seq UNIQUE;
DEFINE INDEX OVERWRITE agent_session_client ON agent_session FIELDS client;

-- Phase D1 swarm-agent run provenance. Coordinator stamps one row per
-- agent invocation (`linker`, `synthesizer`, `contradictionHunter`,
-- `maturityAdvancer`); `swarm:*` ledger rows reference `seq` so the agent
-- streams UI can join an event back to the run that emitted it. Migration
-- of the Coordinator producer is scoped for a follow-on task; this schema
-- definition lands now so the table exists when that migration runs.
DEFINE TABLE OVERWRITE agent_run SCHEMAFULL;
DEFINE FIELD OVERWRITE seq ON agent_run TYPE int;
DEFINE FIELD OVERWRITE agent ON agent_run TYPE string;
DEFINE FIELD OVERWRITE trigger ON agent_run TYPE string;
DEFINE FIELD OVERWRITE note_path ON agent_run TYPE option<string>;
DEFINE FIELD OVERWRITE started_at ON agent_run TYPE int;
DEFINE FIELD OVERWRITE finished_at ON agent_run TYPE option<int>;
DEFINE FIELD OVERWRITE ok ON agent_run TYPE option<bool>;
DEFINE FIELD OVERWRITE error ON agent_run TYPE option<string>;
DEFINE FIELD OVERWRITE proposals_count ON agent_run TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE agent_run_seq ON agent_run FIELDS seq UNIQUE;
DEFINE INDEX OVERWRITE agent_run_agent ON agent_run FIELDS agent;
DEFINE INDEX OVERWRITE agent_run_started ON agent_run FIELDS started_at;

-- §3.6 Agent identity
DEFINE ACCESS OVERWRITE agent_jwt ON DATABASE TYPE JWT
  ALGORITHM HS512 KEY $NOTIENT_AGENT_JWT_KEY
  AUTHENTICATE { IF $token.iss != "notient" { THROW "bad iss" } }
  DURATION FOR SESSION 24h;
