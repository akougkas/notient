# Changelog

All notable changes to Notient are documented in this file. The format follows
Keep a Changelog, and the project uses Semantic Versioning.

## 0.1.0 - 2026-09-17

First public release. Changes since 0.1.0-alpha.1:

- Agents, scripts and the in-app assistant plan exact, revision-bound changes and
  submit them for review. Only a person applies, rejects or undoes them. Legacy
  note tools require the caller's saved revision and refuse edits made during
  approval instead of recomputing them.
- Obsidian: four selection commands in the command palette and editor menu (ask,
  brief, find connections, propose an edit). A selection is bound to the saved
  revision with exact file offsets across BOM, CRLF and frontmatter. An edit is
  always a reviewed preview; a changed or unsaved note is a conflict.
- Obsidian: saved notes are read as raw bytes, so a note with a byte-order mark
  keeps the daemon's revision and offsets. `Vault.read` had silently dropped it.
- `brief.run` and `notes.correlate` accept an optional `focus` range of the saved
  source revision.
- `notient setup` guides a first run and ends in the read-only doctor report.
- The typed HTTP client ships as the `notient/sdk` package export.
- One Unicode-aware Obsidian tag grammar; structural index version 4.
- Live, reviewable chat resource limits in the workspace preferences.
- Inbox items are marked processed only as their final applied effect.
- Relate shares the contradiction reasoning ceiling; synthesis abstains when
  selected notes share only a generic theme.
- A fixed evaluation pack for the seven pipelines, with a deterministic runner and
  a sequential real-model probe.
- Fixed: conversation listing racing the post-answer memory save, review key
  hints never drawn, value editors starting before the value, menu ranking.

## 0.1.0-alpha.1 - 2026-08-30

This is the sentient hard-cut alpha. The `.1` identifier preserves the already-published
`0.1.0-alpha` release identity; no earlier compatibility contract is carried forward.

### The notes become sentient

- Made each Markdown file the source of truth while giving the vault durable
  memory in a local SurrealDB graph. The watcher perceives file changes, and the
  three-tier indexer derives structure, embeddings, concepts, claims,
  questions, evidence, and relationships.
- Added `ask`, `brief`, vitals, events, and conversational recall so the notes
  can answer together. Generated answers keep citations tied to retrieved note
  paths and evidence; an uncited grounded answer or any fabricated path makes
  the entire result fail closed.
- Added extraction by bounded note windows, content-addressed chunks, and
  Linker's typed-edge proposals with chunk-level evidence so edits can preserve
  the identity of unchanged knowledge.

### Local daemon and lifecycle

- Added a per-vault daemon over a Unix socket, with its SurrealDB child, lock,
  credentials, and process records stored outside the vault. Vault-local
  Markdown and configuration remain portable.
- Added a boot-intent record and shared instance ownership across the lock and
  process record. Clients wait through an in-progress shutdown instead of
  starting a competing daemon for the same vault.
- Added a controlled awaken pipeline with tier selection, background runs,
  status, pause, resume, cancellation, checkpointed progress, and diagnostic
  failures. Checkpointed reconciliation bounds failure recovery, and a missing
  resume cursor advances by the stored ordering instead of restarting the
  vault.
- Made graceful shutdown close request admission and drain accepted RPC work,
  approval reconciliation, the indexer queue, awaken workers, and event-ledger
  writes before closing the database and child process.
- Added Markdown watcher handling for editor-style saves, short-window renames,
  persisted deletion tombstones, configured exclusions, and all dot-prefixed
  path segments.

### Retrieval and graph

- Added three retrieval modes: model-free BM25 quick search with a
  natural-language fallback, vector-assisted balanced search with reranking,
  and deep reciprocal-rank fusion with graph expansion and grounded synthesis.
- Added deterministic Markdown relationships and inferred concepts, claims,
  questions, and typed relationships. Deep retrieval expands only through
  approved graph edges; pending typed-edge proposals remain visible for operator
  review without influencing answers.
- Added note-level deduplication after deep fusion, block-anchored wikilink
  resolution, bounded vector-distance confidence, and citation resolution from
  an answer directly into the corresponding note.
- Made embedding-model changes preserve Tier 3 knowledge and evidence while
  rebuilding Tier 2 vectors and refreshing vector-derived linker proposals.

### Human-gated, reversible writes

- Added gated note creation, append, section replacement, and frontmatter
  updates. Policy evaluates scoped session grants, per-tool rules, and safe or
  yolo mode, then reports an explicit applied, pending, or denied outcome. A
  dedicated proposal-note operation derives its internal path and authenticated
  provenance on the server instead of accepting either from the caller.
- Added human-mediated relationship approval with previews and durable
  application state in the graph. Every decision keeps proposer, structural
  source, and approving principal as separate durable authorities.
- Made pending writes recompute their edit from fresh note bytes after approval,
  avoiding stale-snapshot overwrites. Common frontmatter edits and relationship
  writeback preserve unrelated Markdown bytes, YAML, lists, and code fences.
- Added an attributed history ledger and exact-row undo. Undo refuses to replace
  a note that has changed since the selected history record.
- Routed transcript distillation through one approval decision for the proposed
  batch. Dry runs remain read-only, and every applied proposal note receives its
  own creation history record.
- Added a schemafull write-ahead intent for relationship approvals. The exact
  proposal revision, endpoint paths, before/after bytes, hashes, approver, and
  deterministic receipt survive the filesystem/database commit gap; recovery
  retries only those frozen bytes, refuses external-edit conflicts, and cannot
  manufacture a false undo snapshot. Approval retries return the original
  receipt, and concurrent reconcilers converge on one history and daemon-write
  identity.

### TUI workspace

- Added a five-view terminal workspace for Home, Inbox, Ask, Explore, and Stream,
  with a persistent status bar, composer, navigation, notices, and approval
  actions.
- Made panel geometry derive from terminal dimensions for compact, standard,
  and wide layouts. Stable gutters, bounded labels, a fully painted palette,
  and non-overlapping scrollbars keep the workspace legible across sizes and
  terminal backgrounds.
- Added live vault vitals, current awaken status, typed-edge totals, discoveries
  from the preceding hour, grouped proposal review, citation-to-note navigation,
  and a deduplicated event stream with substring filtering.
- Kept completed chat turns navigable from the composer and bounded Inbox,
  Explore, and Stream cursors to the rows actually visible on screen.

### MCP and CLI

- Added an installable `notient` CLI for initialization, lifecycle, awakening,
  retrieval, chat, graph inspection, events, proposals, history, sessions,
  backup, restore, and operator database access.
- Added a stdio MCP adapter with fifteen tools, two resources, and one recall
  prompt. Four ordinary note tools use the canonical non-blocking write gate.
  A dedicated proposal-note authority derives its artifact path and stamps
  authenticated provenance, while a separate typed-link authority can only
  stage a note-to-note edge for human approval.
- Reserved MCP stdout for JSON-RPC frames, placed diagnostics on stderr, and
  closed the server when its host closes stdin. Read calls may reconnect and
  replay once; writes and administrative calls fail closed after an ambiguous
  disconnect.
- Made repeated initialization preserve existing vault settings and made CLI
  search honor the vault's configured default mode.

### Reliability and security

- Added per-connection principals established by `session.hello`, admin-scoped
  methods, principal-scoped approvals and aborts, a ten-second hello deadline,
  a 64-connection limit, ordered pipelined frames, and a 4 MiB frame cap. The
  reserved human presents the boot root token; every named visitor presents an
  HMAC-SHA256 credential bound to its exact identity and that boot.
- Anchored vault traversal to verified directory descriptors and rejected
  absolute paths, traversal, every symlink component, hidden paths, devices,
  and internal Notient artifacts from ordinary note access. Distillation admits
  only canonical public Markdown or a principal-visible canonical conversation,
  rejects symlinks and non-regular files, and enforces a 1 MiB ceiling before
  provider invocation.
- Secured local state independently of process umask: state directories are
  current-user-owned mode `0700`, the Unix socket and ephemeral root token are
  verified mode `0600`, and process cleanup requires exact child-generation
  proof. Native Windows refuses startup and directs operators to WSL2 because
  the runtime cannot prove an equivalent named-pipe ACL.
- Added authenticated records-only graph backup and empty-target restore. The
  signed envelope binds the vault secret and exact embedding identity;
  maintenance drains writers, restore verifies Markdown and graph invariants,
  and a durable quarantine prevents an unverified generation from reopening.
- Made replayed SurrealDB transactions idempotent for session grants, ledger
  rows, and other retried writes, including the lost-response case.
- Preserved code while normalizing Markdown chunks, validated embedding response
  order and vector counts, rechunked context overflows, and quarantined only an
  irreducible bad chunk instead of failing its whole note.
- Added structured daemon and model-stream errors, bounded model-name matching,
  and reasoning-tag cleanup that does not remove quoted prose.
