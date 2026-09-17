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
-- Completed structural parses are refreshed after an extractor upgrade, even
-- when authored bytes are unchanged. This is derived state, not frontmatter.
DEFINE FIELD OVERWRITE structural_version ON note TYPE option<int>;
-- Revision-bound authored destinations, including currently missing notes.
-- JSON is runtime validated; Markdown remains the sole source of these values.
DEFINE FIELD OVERWRITE reference_targets ON note TYPE option<string>;
DEFINE FIELD OVERWRITE tier2_at ON note TYPE option<datetime>;
DEFINE FIELD OVERWRITE tier3_at ON note TYPE option<datetime>;
-- Durable hand-off between an embedding-model migration and the boot-time
-- linker-only repair. The applier sets this only after the new vector schema
-- and index are ready; bootstrap clears it note-by-note after the linker has
-- successfully refreshed proposals against rebuilt Tier 2 vectors.
DEFINE FIELD OVERWRITE linker_refresh_pending ON note TYPE bool DEFAULT false;
DEFINE FIELD OVERWRITE tombstoned_at ON note TYPE option<datetime>;
DEFINE FIELD OVERWRITE last_user_edit_at ON note TYPE option<datetime>;
DEFINE FIELD OVERWRITE maturity ON note TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ['raw','adolescent','mature','synthesis-ready'];
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
  ASSERT $value = NONE OR ($value >= 1 AND $value <= 6);
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
DEFINE FIELD OVERWRITE source_revision ON chunk TYPE option<string>;
DEFINE FIELD OVERWRITE start_line ON chunk TYPE option<int>;
DEFINE FIELD OVERWRITE end_line ON chunk TYPE option<int>;
DEFINE FIELD OVERWRITE sha ON chunk TYPE option<string>;
DEFINE FIELD OVERWRITE token_estimate ON chunk TYPE int;
-- The vector width is NOT a constant. The placeholder below is substituted
-- by src/core/db/schemaApplier.ts from the boot-time embedding probe, or from
-- the width recorded in `meta:embedding`. When neither is available the
-- applier rewrites the sized array to a plain unsized one and skips the
-- HNSW index entirely.
DEFINE FIELD OVERWRITE vector ON chunk TYPE option<array<float, {{EMBED_DIM}}>>;
-- Model id plus the schema-enforced vector width form the chunk's immutable
-- embedding identity. NONE is reserved for invalidated, not-yet-rebuilt rows.
DEFINE FIELD OVERWRITE embed_model ON chunk TYPE option<string>
  ASSERT $value = NONE OR string::len($value) > 0;
DEFINE FIELD OVERWRITE embedded_at ON chunk TYPE option<datetime>;
DEFINE FIELD OVERWRITE embed_error ON chunk TYPE option<string>;
DEFINE INDEX OVERWRITE chunk_note_ord ON chunk FIELDS note, ord UNIQUE;

DEFINE ANALYZER OVERWRITE notient_text TOKENIZERS class, blank
  FILTERS lowercase, ascii, snowball(english);

-- Managed indexes. The applier strips this block out of the base schema and
-- (re)defines each statement only when `INFO FOR TABLE chunk` shows it is
-- missing or built at the wrong dimension. Rebuilding an HNSW or FULLTEXT
-- index over a large vault costs minutes, so an unconditional
-- DEFINE INDEX OVERWRITE on every daemon start is not acceptable.
-- BEGIN MANAGED INDEXES
DEFINE INDEX OVERWRITE chunk_vec ON chunk FIELDS vector
  HNSW DIMENSION {{EMBED_DIM}} DIST COSINE EFC 200 M 16;
DEFINE INDEX OVERWRITE chunk_text ON chunk FIELDS text
  FULLTEXT ANALYZER notient_text BM25 HIGHLIGHTS;
-- END MANAGED INDEXES

DEFINE TABLE OVERWRITE tag SCHEMAFULL;
DEFINE FIELD OVERWRITE path ON tag TYPE string
  ASSERT string::matches($value, "^[\\p{L}\\p{N}\\p{M}_/\\-\\p{Extended_Pictographic}\\x{200D}\\x{FE0F}]+$") AND string::matches($value, "\\P{N}") AND !string::matches($value, "^[-/]|/$|//");
DEFINE INDEX OVERWRITE tag_path ON tag FIELDS path UNIQUE;

DEFINE TABLE OVERWRITE concept SCHEMAFULL;
DEFINE FIELD OVERWRITE label ON concept TYPE string;
DEFINE FIELD OVERWRITE norm_label ON concept TYPE string;
DEFINE FIELD OVERWRITE kind ON concept TYPE string DEFAULT 'other'
  ASSERT $value INSIDE ['proper_noun','system','technique','metric','quantity','event','other'];
DEFINE FIELD OVERWRITE source ON concept TYPE string DEFAULT 'extractor'
  ASSERT $value INSIDE ['extractor','user','linker'];
DEFINE INDEX OVERWRITE concept_norm ON concept FIELDS norm_label UNIQUE;

DEFINE TABLE OVERWRITE claim SCHEMAFULL;
DEFINE FIELD OVERWRITE text ON claim TYPE string;
DEFINE FIELD OVERWRITE sha ON claim TYPE string;
DEFINE FIELD OVERWRITE kind ON claim TYPE string DEFAULT 'assertion'
  ASSERT $value INSIDE ['definition','assertion','datum','speculation'];
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
-- (TYPE NORMAL). `links audit` reads those tables directly while the
-- wikilink/embed traversals stay clean.
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
-- `links audit` reads these tables directly. They are not in EDGE_TABLES and
-- do not receive the provenance-fields block.
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
-- ENFORCED makes endpoint ownership a storage invariant: an extractor
-- transaction cannot commit an edge after a concurrent purge removed either
-- the source note/block or the semantic target.
DEFINE TABLE OVERWRITE mentions TYPE RELATION FROM note|block TO concept ENFORCED SCHEMAFULL;
DEFINE TABLE OVERWRITE asserts TYPE RELATION FROM note|block TO claim ENFORCED SCHEMAFULL;
DEFINE TABLE OVERWRITE asks TYPE RELATION FROM note|block TO question ENFORCED SCHEMAFULL;

-- Proposed semantic (Tier 3 linker; class = 'INFERRED', approved = false)
DEFINE TABLE OVERWRITE supports TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE contradicts TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE extends TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE exemplifies TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE synthesizes TYPE RELATION FROM note TO note SCHEMAFULL;
DEFINE TABLE OVERWRITE related_to TYPE RELATION FROM note TO note SCHEMAFULL;

-- §3.5 Operational tables

-- Small key/value side table for facts about the database itself rather than
-- about the vault. The only key today is `embedding`, holding
-- `{ model, dimension }` for the embedding model whose vectors currently
-- populate `chunk.vector`. The schema applier compares it against the boot
-- probe and self-heals when the operator swaps models.
DEFINE TABLE OVERWRITE meta SCHEMAFULL;
DEFINE FIELD OVERWRITE key ON meta TYPE string;
-- FLEXIBLE: a SCHEMAFULL table otherwise rejects nested keys that were never
-- declared, and `value` holds an open-ended payload (`{ model, dimension }`
-- today).
DEFINE FIELD OVERWRITE value ON meta TYPE object FLEXIBLE;
DEFINE FIELD OVERWRITE updated_at ON meta TYPE datetime DEFAULT time::now();
DEFINE INDEX OVERWRITE meta_key ON meta FIELDS key UNIQUE;

-- Derived semantic memory for canonical Markdown conversations. The table
-- stores no transcript or summary text: `summary_hash` binds its native vector
-- to the exact readable summary under `Notient/conversations/`. A row is valid
-- only in the boot-resolved embedding space named by `embed_model` and the
-- schema-enforced vector width.
DEFINE TABLE OVERWRITE conversation_memory SCHEMAFULL;
-- Ownership is a hard privacy boundary. Rows written before this field existed
-- cannot be attributed safely, so discard that derived memory instead of
-- guessing an owner or retaining a compatibility default. Canonical Markdown
-- summaries rebuild it after a subsequent completed turn.
DELETE conversation_memory WHERE client_identity IS NONE;
DEFINE FIELD OVERWRITE conversation_id ON conversation_memory TYPE string
  ASSERT string::len($value) > 0;
DEFINE FIELD OVERWRITE path ON conversation_memory TYPE string
  ASSERT string::len($value) > 0
  AND !string::starts_with($value, "/")
  AND !string::contains($value, "\\");
DEFINE FIELD OVERWRITE topic ON conversation_memory TYPE string;
DEFINE FIELD OVERWRITE client_identity ON conversation_memory TYPE string
  ASSERT string::matches($value, "{{AGENT_ID_PATTERN}}");
DEFINE FIELD OVERWRITE updated_at ON conversation_memory TYPE datetime
  ASSERT $value >= d'1970-01-01T00:00:00Z';
DEFINE FIELD OVERWRITE summary_hash ON conversation_memory TYPE string
  ASSERT string::matches($value, "^[a-f0-9]{64}$");
DEFINE FIELD OVERWRITE embed_model ON conversation_memory TYPE string
  ASSERT string::len($value) > 0;
DEFINE FIELD OVERWRITE vector ON conversation_memory TYPE array<float, {{EMBED_DIM}}>;
DEFINE INDEX OVERWRITE conversation_memory_id ON conversation_memory FIELDS conversation_id UNIQUE;
DEFINE INDEX OVERWRITE conversation_memory_updated ON conversation_memory FIELDS client_identity, updated_at;

-- Filesystem writes and SurrealDB transactions cannot share one atomic
-- commit. ApprovalService therefore persists the exact byte transition here
-- before attempting a vault rename. Bootstrap reconciliation can distinguish
-- "not written", "already written", and "conflicting user edit" without
-- reconstructing or overwriting evidence. The row is deleted atomically with
-- the terminal history receipt and edge-state flip.
DEFINE TABLE OVERWRITE approval_intent SCHEMAFULL;
DEFINE FIELD OVERWRITE edge ON approval_intent
  TYPE record<supports|contradicts|extends|exemplifies|synthesizes|related_to>;
DEFINE FIELD OVERWRITE table_name ON approval_intent TYPE string
  ASSERT $value INSIDE ['supports','contradicts','extends','exemplifies','synthesizes','related_to'];
DEFINE FIELD OVERWRITE edge_created_at ON approval_intent TYPE datetime;
DEFINE FIELD OVERWRITE source_note ON approval_intent TYPE record<note>;
DEFINE FIELD OVERWRITE target_note ON approval_intent TYPE record<note>;
DEFINE FIELD OVERWRITE source_path ON approval_intent TYPE string
  ASSERT string::len($value) > 0
  AND !string::starts_with($value, "/")
  AND !string::contains($value, "\\");
DEFINE FIELD OVERWRITE target_path ON approval_intent TYPE string
  ASSERT string::len($value) > 0
  AND !string::starts_with($value, "/")
  AND !string::contains($value, "\\");
DEFINE FIELD OVERWRITE kind ON approval_intent TYPE string
  ASSERT $value INSIDE ['note.append_section','note.frontmatter'];
DEFINE FIELD OVERWRITE before_body ON approval_intent TYPE string;
DEFINE FIELD OVERWRITE after_body ON approval_intent TYPE string;
DEFINE FIELD OVERWRITE before_sha ON approval_intent TYPE string
  ASSERT string::matches($value, "^[a-f0-9]{64}$");
DEFINE FIELD OVERWRITE after_sha ON approval_intent TYPE string
  ASSERT string::matches($value, "^[a-f0-9]{64}$");
DEFINE FIELD OVERWRITE history_id ON approval_intent TYPE record<history>;
DEFINE FIELD OVERWRITE approved_by ON approval_intent TYPE string
  ASSERT string::len($value) > 0;
DEFINE FIELD OVERWRITE tool_approval ON approval_intent TYPE option<string>;
DEFINE FIELD OVERWRITE producer ON approval_intent TYPE string
  ASSERT string::len($value) > 0;
DEFINE FIELD OVERWRITE prepared_at ON approval_intent TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE write_started_at ON approval_intent TYPE option<datetime>;
-- A note deletion/exclusion supersedes an approval that has not reached its
-- terminal receipt. The request is durable so boot can finish byte-safe
-- rollback after a crash; the row is removed only with the applying edge.
DEFINE FIELD OVERWRITE cancel_requested_at ON approval_intent TYPE option<datetime>;
DEFINE INDEX OVERWRITE approval_intent_edge ON approval_intent FIELDS edge UNIQUE;
DEFINE INDEX OVERWRITE approval_intent_history ON approval_intent FIELDS history_id UNIQUE;
DEFINE INDEX OVERWRITE approval_intent_source ON approval_intent FIELDS source_note;
DEFINE INDEX OVERWRITE approval_intent_target ON approval_intent FIELDS target_note;

-- Ordinary note tools and transcript distillation cross the same filesystem /
-- database boundary as proposal approval. Persist the exact byte transition
-- and deterministic history receipt before the guarded vault mutation. Boot
-- reconciliation may replay `before_body`, finalize `after_body`, or refuse a
-- third value without manufacturing an undo snapshot. These rows are live
-- recovery state and are deliberately excluded from portable backups.
DEFINE TABLE OVERWRITE note_write_intent SCHEMAFULL;
DEFINE FIELD OVERWRITE kind ON note_write_intent TYPE string
  ASSERT $value INSIDE ['notes.move','notes.create','notes.append','notes.replace_section','notes.update_frontmatter'];
DEFINE FIELD OVERWRITE target ON note_write_intent TYPE string
  ASSERT string::len($value) > 0
  AND !string::starts_with($value, "/")
  AND !string::contains($value, "\\");
DEFINE FIELD OVERWRITE destination ON note_write_intent TYPE option<string>;
DEFINE FIELD OVERWRITE before_exists ON note_write_intent TYPE bool;
DEFINE FIELD OVERWRITE before_body ON note_write_intent TYPE string;
DEFINE FIELD OVERWRITE after_body ON note_write_intent TYPE string;
DEFINE FIELD OVERWRITE before_sha ON note_write_intent TYPE string
  ASSERT string::matches($value, "^[a-f0-9]{64}$");
DEFINE FIELD OVERWRITE after_sha ON note_write_intent TYPE string
  ASSERT string::matches($value, "^[a-f0-9]{64}$");
DEFINE FIELD OVERWRITE history_id ON note_write_intent TYPE record<history>;
DEFINE FIELD OVERWRITE client_identity ON note_write_intent TYPE string
  ASSERT string::len($value) > 0;
DEFINE FIELD OVERWRITE prepared_at ON note_write_intent TYPE datetime;
DEFINE FIELD OVERWRITE write_started_at ON note_write_intent TYPE option<datetime>;
DEFINE FIELD OVERWRITE tool_approval ON note_write_intent TYPE option<string>;
DEFINE FIELD OVERWRITE preview_id ON note_write_intent TYPE option<string>;
DEFINE FIELD OVERWRITE abandoned_at ON note_write_intent TYPE option<datetime>;
DEFINE INDEX OVERWRITE note_write_intent_history ON note_write_intent FIELDS history_id UNIQUE;
DEFINE INDEX OVERWRITE note_write_intent_target ON note_write_intent FIELDS target;

DEFINE TABLE OVERWRITE change_preview SCHEMAFULL;
DEFINE FIELD OVERWRITE owner ON change_preview TYPE string;
DEFINE FIELD OVERWRITE payload ON change_preview TYPE string;

DEFINE TABLE OVERWRITE pipeline_job SCHEMAFULL;
DEFINE FIELD OVERWRITE pipeline ON pipeline_job TYPE string ASSERT $value INSIDE ['index-extract','enrich','relate','contradictions','synthesize','inbox','archive'];
DEFINE FIELD OVERWRITE state ON pipeline_job TYPE string ASSERT $value INSIDE ['queued','running','paused','waiting-inference','awaiting-approval','completed','failed','cancelled','partial'];
DEFINE FIELD OVERWRITE revision ON pipeline_job TYPE string ASSERT string::matches($value, '^[a-f0-9]{64}$');
DEFINE FIELD OVERWRITE updated_ms ON pipeline_job TYPE int;
DEFINE FIELD OVERWRITE payload ON pipeline_job TYPE string;
DEFINE INDEX OVERWRITE pipeline_job_state ON pipeline_job FIELDS state;
DEFINE INDEX OVERWRITE pipeline_job_updated ON pipeline_job FIELDS updated_ms;

DEFINE TABLE OVERWRITE job_control_receipt SCHEMAFULL;
DEFINE FIELD OVERWRITE payload ON job_control_receipt TYPE string;

DEFINE TABLE OVERWRITE proposal_review SCHEMAFULL;
DEFINE FIELD OVERWRITE revision ON proposal_review TYPE string;
DEFINE FIELD OVERWRITE state ON proposal_review TYPE string ASSERT $value INSIDE ['pending','approved','rejected','stale'];
DEFINE FIELD OVERWRITE created_ms ON proposal_review TYPE int;
DEFINE FIELD OVERWRITE payload ON proposal_review TYPE string;
DEFINE FIELD OVERWRITE preview_id ON proposal_review TYPE option<string>;
DEFINE FIELD OVERWRITE edge_ids ON proposal_review TYPE option<array<string>>;
DEFINE INDEX OVERWRITE proposal_review_state ON proposal_review FIELDS state;
DEFINE INDEX OVERWRITE proposal_review_preview ON proposal_review FIELDS preview_id;

DEFINE TABLE OVERWRITE mutation_request SCHEMAFULL;
DEFINE FIELD OVERWRITE payload ON mutation_request TYPE string;

DEFINE TABLE OVERWRITE settings_change SCHEMAFULL;
DEFINE FIELD OVERWRITE payload ON settings_change TYPE string;

DEFINE TABLE OVERWRITE change_authority SCHEMAFULL;
DEFINE FIELD OVERWRITE payload ON change_authority TYPE string;
DEFINE FIELD OVERWRITE preview_id ON change_authority TYPE string;
DEFINE FIELD OVERWRITE edge_id ON change_authority TYPE option<string | null>;
DEFINE INDEX OVERWRITE change_authority_preview ON change_authority FIELDS preview_id;
DEFINE INDEX OVERWRITE change_authority_edge ON change_authority FIELDS edge_id;

DEFINE TABLE OVERWRITE daemon_write SCHEMAFULL;
DEFINE FIELD OVERWRITE note ON daemon_write TYPE record<note>;
DEFINE FIELD OVERWRITE sha ON daemon_write TYPE string;
DEFINE FIELD OVERWRITE agent ON daemon_write TYPE string;
DEFINE FIELD OVERWRITE targets ON daemon_write TYPE array<record>;
DEFINE FIELD OVERWRITE approval_intent ON daemon_write TYPE option<record<approval_intent>>;
DEFINE FIELD OVERWRITE written_at ON daemon_write TYPE datetime DEFAULT time::now();
DEFINE INDEX OVERWRITE daemon_write_sha ON daemon_write FIELDS sha;
DEFINE INDEX OVERWRITE daemon_write_note ON daemon_write FIELDS note, written_at;

-- Universal undo log. `before` and `after` use flexible native object
-- envelopes so structured values retain their SurrealDB types and malformed
-- payloads fail closed at the reader boundary.
DEFINE TABLE OVERWRITE history SCHEMAFULL;
DEFINE FIELD OVERWRITE kind ON history TYPE string
  ASSERT $value INSIDE ['chat.auto_approve','note.append_section','note.frontmatter','notes.move','notes.create','notes.append','notes.replace_section','notes.update_frontmatter','proposal.reject'];
DEFINE FIELD OVERWRITE target ON history TYPE string;
DEFINE FIELD OVERWRITE before ON history TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE after ON history TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE tool_approval ON history TYPE option<string>;
DEFINE FIELD OVERWRITE client_identity ON history TYPE string DEFAULT 'human';
DEFINE FIELD OVERWRITE proposal_edge ON history TYPE option<record>;
DEFINE FIELD OVERWRITE proposal_created_at ON history TYPE option<datetime>;
DEFINE FIELD OVERWRITE created_at ON history TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE undo_started_at ON history TYPE option<datetime>;
DEFINE FIELD OVERWRITE undone_at ON history TYPE option<datetime>;
DEFINE FIELD OVERWRITE undo_client_identity ON history TYPE option<string>;
DEFINE INDEX OVERWRITE history_kind ON history FIELDS kind;
DEFINE INDEX OVERWRITE history_target ON history FIELDS target;

DEFINE TABLE OVERWRITE awaken_run SCHEMAFULL;
DEFINE FIELD OVERWRITE status ON awaken_run TYPE string
  ASSERT $value INSIDE ['running','paused','cancelled','completed','failed'];
DEFINE FIELD OVERWRITE started_at ON awaken_run TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE finished_at ON awaken_run TYPE option<datetime>
  ASSERT $value = NONE OR $value >= $this.started_at;
DEFINE FIELD OVERWRITE total ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE processed ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE failed ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE attempted ON awaken_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE tier_filter ON awaken_run TYPE array<int> DEFAULT [1,2,3];
DEFINE FIELD OVERWRITE priority_globs ON awaken_run TYPE array<string> DEFAULT [];
-- Immutable ordered plan captured when the run is created. Resume consumes
-- this plan instead of widening a filtered run to the vault's current files.
DEFINE FIELD OVERWRITE paths ON awaken_run TYPE array<string> DEFAULT [];
DEFINE FIELD OVERWRITE cursor ON awaken_run TYPE option<string>;
DEFINE FIELD OVERWRITE error ON awaken_run TYPE option<string>;
DEFINE FIELD OVERWRITE failure_reason ON awaken_run TYPE option<string>;
-- Vault-relative paths whose tier 1 / 2 / 3 indexing did not complete
-- during this run. Capped server-side by the worker (currently 200) so
-- the row stays small even for vaults with thousands of bad notes.
DEFINE FIELD OVERWRITE failures ON awaken_run TYPE array<string> DEFAULT [];
-- Derived marker that pins a row into the unique index only while its
-- status is in the active set ('running','paused'). The field evaluates
-- to the literal string 'active' for active rows and to NONE for terminal
-- rows. SurrealDB's unique index treats a NONE-valued field as the row
-- being absent from the index, which gives partial-uniqueness semantics:
-- at most one active row coexists, terminal rows release the slot.
-- Choice rationale: SurrealQL's DEFINE INDEX does not expose a WHERE
-- predicate, and a transaction-wrapped check would still race with
-- concurrent writers. The computed field plus a unique index over it is
-- the simplest server-side guard that 3.x accepts.
DEFINE FIELD OVERWRITE active_marker ON awaken_run TYPE option<string>
  VALUE IF status INSIDE ['running','paused'] THEN 'active' ELSE NONE END;
DEFINE INDEX OVERWRITE awaken_run_active_unique ON awaken_run FIELDS active_marker UNIQUE;

-- Operator ledger of swarm discoveries and indexer state. Native UUIDv7
-- record ids are the opaque, time-sortable cursor; payloads stay native in a
-- flexible object envelope.
DEFINE TABLE OVERWRITE agent_event SCHEMAFULL;
DEFINE FIELD OVERWRITE kind ON agent_event TYPE string
  ASSERT $value INSIDE ['chat:usage','job:changed','swarm:contradiction_discovered','swarm:claim_advanced','swarm:link_proposed','indexer:note-indexed','indexer:tombstoned','indexer:error','indexer:warn'];
DEFINE FIELD OVERWRITE payload ON agent_event TYPE object FLEXIBLE;
DEFINE FIELD OVERWRITE ts_ms ON agent_event TYPE int;
DEFINE FIELD OVERWRITE created_at ON agent_event TYPE datetime DEFAULT time::now();
DEFINE INDEX OVERWRITE agent_event_kind ON agent_event FIELDS kind;

-- Scoped trust grants for unattended writes. Folder and tool scopes remain
-- native arrays so storage corruption cannot be normalized into broader
-- authorization. An explicit `"*"` tool entry is the sole all-tools grant.
DEFINE TABLE OVERWRITE agent_session SCHEMAFULL;
DEFINE FIELD OVERWRITE client ON agent_session TYPE string;
DEFINE FIELD OVERWRITE granted_at ON agent_session TYPE int;
DEFINE FIELD OVERWRITE expires_at ON agent_session TYPE int;
DEFINE FIELD OVERWRITE allowed_folders ON agent_session TYPE array<string>
  ASSERT array::len($value) > 0;
DEFINE FIELD OVERWRITE allowed_tools ON agent_session TYPE array<string>
  ASSERT array::len($value) > 0;
DEFINE FIELD OVERWRITE max_writes ON agent_session TYPE option<int>;
DEFINE FIELD OVERWRITE used_writes ON agent_session TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE revoked_at ON agent_session TYPE option<int>;
DEFINE INDEX OVERWRITE agent_session_client ON agent_session FIELDS client;

-- Durable swarm-agent run provenance. Coordinator stamps one row per agent
-- invocation (`linker`, `synthesizer`, `contradictionHunter`, or
-- `maturityAdvancer`); lifecycle and `swarm:*` events carry this row's native
-- `agent_run:<uuid>` record id so every discovery resolves to its execution.
DEFINE TABLE OVERWRITE agent_run SCHEMAFULL;
DEFINE FIELD OVERWRITE agent ON agent_run TYPE string;
DEFINE FIELD OVERWRITE trigger ON agent_run TYPE string;
DEFINE FIELD OVERWRITE note_path ON agent_run TYPE option<string>;
DEFINE FIELD OVERWRITE started_at ON agent_run TYPE int;
DEFINE FIELD OVERWRITE finished_at ON agent_run TYPE option<int>;
DEFINE FIELD OVERWRITE ok ON agent_run TYPE option<bool>;
DEFINE FIELD OVERWRITE error ON agent_run TYPE option<string>;
DEFINE FIELD OVERWRITE proposals_count ON agent_run TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE agent_run_agent ON agent_run FIELDS agent;
DEFINE INDEX OVERWRITE agent_run_started ON agent_run FIELDS started_at;

-- §3.6 Agent identity
DEFINE ACCESS OVERWRITE agent_jwt ON DATABASE TYPE JWT
  ALGORITHM HS512 KEY $NOTIENT_AGENT_JWT_KEY
  AUTHENTICATE { IF $token.iss != "notient" { THROW "bad iss" } }
  DURATION FOR SESSION 24h;
