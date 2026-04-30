# awaken end-to-end deep-dive
beta-spec / 2026-04-30 / dogfood vault `/tmp/notient-dogfood`

substrate state: 120 notes, 1315 blocks, 1388 chunks, 121 tags, 2716 concepts,
3167 claims, 1322 questions, 105 supports, 14 related_to, 50 wikilinks
resolved. daemon healthy. probe ok against
nvidia-nemotron-3-nano-omni-30b-a3b-reasoning (200k configured / 800k loaded)
and text-embedding-nomic-embed-text-v2-moe.

## 1. Contract

`awaken` is the operator-callable verb that turns a vault on disk into a
queryable knowledge graph. The promise is:

  Every markdown note in the vault is parsed, chunked, embedded, and
  enriched with concepts, claims, questions, and edges to related notes.
  After awaken returns, search hits the embeddings, the graph holds
  semantic edges, and the operator can review, approve, or reject any
  agent-proposed edge before it touches a note's body.

Concretely the daemon walks the vault tree, enqueues every `.md` path, and
runs three tiers per note:

  Tier 1: deterministic structural extraction (blocks, wikilinks,
          frontmatter refs, tags, embeds) into SurrealDB
  Tier 2: AST-aware chunking + embedding into the HNSW index on chunk.vector
  Tier 3: LLM extraction (concept, claim, question) over chunks, then the
          linker proposes typed edges to kNN neighbour notes

awaken_run rows persist progress (running / paused / cancelled / completed
/ failed) under a partial-unique index that allows at most one active row.
A pause surfaces as a checkpoint; resume picks up from the same cursor.

The contract the operator should be able to lean on:

  C1. content correctness   the rows in concept/claim/question/edge
                            tables reflect the on-disk markdown as last
                            saved, and a save in flight is eventually
                            absorbed
  C2. progress observability awaken_run.processed and .failed mean what
                            their names say; indexer:* events are routed
                            to the right note path and phase
  C3. provenance            edges carry source = '<agent>'; daemon-written
                            wikilinks attribute back to the writing agent
                            instead of being read as user edits
  C4. operator control      every proposed edge has an approve and a
                            reject path that an operator can drive without
                            opening a SurrealQL prompt
  C5. resilience            crashes and SIGKILL leave a recoverable state;
                            the next boot or `links sync` reconciles
                            without manual db surgery

C1 is partially broken (gap #4 below). C2 is mostly correct after the prior
session's fixes (commits 794c063 and 36c8c72). C3 is correct on a tight
window and broken on a realistic one (findings.md row "daemon_write
provenance window"). C4 is broken end-to-end (gap #1). C5 is graceful-only
(findings.md row "kill -9 mid-awaken").

## 2. Pipeline walk

### 2.1 Tier 1 — structural extraction (`src/core/indexer/tier1.ts`)

Reads:    note body, vault-path universe (`listNotePaths`), existing note
          row if any, existing block ids, daemon_write provenance window
Writes:   single `BEGIN TRANSACTION; ... COMMIT TRANSACTION;` script
          touching `note`, `block`, `wikilink`, `embed`,
          `wikilink_unresolved`, `embed_unresolved`, `frontmatter_ref`,
          `tag`, `tagged`, `contained_in`, `under_heading`
Idempotent: yes by construction. Block rows are reused in place via UPDATE
          for the overlapping prefix; only surplus rows are deleted; only
          new rows are CREATE-d. The transaction stamps `tier1_at` last.
Failure:  any statement raises and the script rolls back; the note retains
          its prior tier1_at (or NONE on a first-time note).

Locked edge cases worth keeping in mind:

- Same-table DELETE+CREATE inside one transaction is broken in
  SurrealDB 2.x/3.x. The block-reuse strategy and the explicit `oldBlockIds`
  binding on the per-table edge cleanup exist to dodge it.
- `option<datetime>` rejects bound `null`; the helpers always serialize
  `undefined` (which becomes SurrealQL `NONE`).
- The pre-pass `prepareNoteRow` writes path/sha/word_count for every
  queued note before per-note processing so cross-note edges resolve on
  the first awaken pass.

### 2.2 Tier 2 — chunking and embedding (`src/core/indexer/tier2.ts` + `chunker.ts`)

Reads:    `BlockSpec[]` from Tier 1 (or re-extracted from disk when Tier 1
          is skipped under a partial filter)
Writes:   `chunk` rows (`note`, `block`, `ord`, `text`, `token_estimate`,
          `vector`, `embed_model`, `embedded_at`); HNSW index entries
          come along automatically once `vector` is set.
Chunker:  the production path is `chunkBlocks` (heading-bounded section
          grouping with paragraph + sentence splits at the `targetTokens`
          floor and `maxTokens` ceiling). The legacy SHA-keyed `chunkNote`
          is still in `chunker.ts` as dead code; nothing imports it
          outside its own test. There is no `tieredSemanticChunker` in
          src/.
Idempotent: chunk row reuse follows the same in-place UPDATE pattern as
          blocks. embed model is recorded so a model change can be detected
          downstream (no consumer reads it today).
Failure:  embedder errors abort the tier; chunk rows without vectors do
          not survive the transaction.

### 2.3 Tier 3 — extraction and linker (`src/core/indexer/tier3.ts`, `extractor.ts`, `agents/linker.ts`)

Reads:    chunks for the active note, plus the kNN neighbour set fetched
          via `linkerNeighbors` (HNSW vector lookup on chunk.vector with
          a self-note exclusion).
Writes:
  - extractor: upserts into `concept` (`label`, `norm_label` UNIQUE on
    norm_label), `claim` (`text`, `sha` UNIQUE on sha), `question`
    (same shape). RELATE `mentions`, `asserts`, `asks` edges with
    `class = 'INFERRED'`, `confidence = 0.7`, `approved = true`.
  - linker: RELATE rows in one of `supports`, `contradicts`, `extends`,
    `exemplifies`, `synthesizes`, `related_to` with `approved = false`,
    `class = 'INFERRED'`, `agent = 'linker'`.
Quality:  the extractor prompt is the single best prompt in the codebase.
          Quality-over-quantity rubric, explicit empty-array contract,
          shape locked by JSON schema. The linker prompt is the worst —
          a one-line system prompt with a threshold-shaped rubric that
          the model anchors against (see gap #2).

### 2.4 Watcher (`src/daemon/watcher.ts`)

Reads:    chokidar events (add, change, unlink, optional rename)
Writes:   nothing directly; calls `enqueue(vaultPath)` to push the path
          into the indexer queue, where `indexNote` orchestrates Tiers
          1–3 again.
Limitation: the watcher does not look at the file body, does not compute
          a content sha, and does not invalidate any tier_at columns. It
          trusts `indexNote` to figure out what changed. `indexNote`
          today reads only the per-tier _at columns to decide which tier
          to skip — so an edited file whose `tier1_at` is set is treated
          as already done.

### 2.5 Operator approval loop (`src/core/approvals/approvalService.ts` + `cli/commands/linksSync.ts`)

`ApprovalService.approveEdge` is a real, well-built three-state writer:
  state 1 (initial proposal)         approved = false, applied = true
  state 2 (writeback in flight)      approved = true,  applied = false
  state 3 (writeback committed)      approved = true,  applied = true

Crashes between states recover via `reconcilePendingApplications`, which
the daemon calls at boot and which the `notient links sync` CLI verb
re-invokes. The atomic write, daemon_write insert, and history row are
all present. The producer side is solid.

What is not present: a way for an operator to drive the state-1-to-state-2
transition without opening a SurrealQL prompt. There is no CLI verb,
no daemon RPC handler, no chat tool entry, no TUI slash command. The
only callers of `approveEdge` are the test suite and
`reconcilePendingApplications`. The approval pipeline ends at the
`proposals` chat tools which are read-only.

## 3. Where leverage lives

Ranked by the operator-perceived quality lift on this dogfood corpus.

### Rank 1 — operator approval verb (architectural gap #1)

A vault with thousands of unapproved proposals nobody can act on is a
search index, not a second brain. The substrate produces real edges;
nothing surfaces them in a form the operator can review at scale. This
is the single highest-leverage fix: it turns the linker output from
inert table rows into a workflow.

### Rank 2 — watcher → re-index correctness (architectural gap #4)

Edits to indexed notes silently do not flow into search. This is
correctness, not polish. An operator who edits a note expecting search to
catch the change instead reads stale chunks. This is invisible until the
operator notices, and then it erodes trust in everything else awaken did.

### Rank 3 — linker quality (architectural gap #2)

The linker is the reason a graph exists. With confidences clustered at
0.6 and the top related_to edge at 0.6814, the operator who sits down to
review proposals immediately concludes the system has nothing useful to
say. Even after gap #1 ships an approval verb, the queue under it has to
contain proposals worth reviewing.

### Rank 4 — extractor output quality

The extractor is the highest-quality producer in the system. A 30%-50%
of concepts are noun phrases an operator would want as anchors
("Stakeholder Trifecta", "embeddings API", "RAG filtering protocols",
"Drive API v3"); some are domain-specific and useful. The other 50% are
extracted UI fragments ("Container Dark", "Elegant Technical"), generic
single words ("structure", "wrappers", "Distributed"), or code-shaped
tokens ("npm-db", "connection_builder"). The prompt explicitly bans
this — the model partially ignores. This is solvable with a sharper
rubric and a post-extraction filter (norm_label degenerate cases:
single-word lowercase, alphanumeric-with-underscores, < 4 chars).

### Rank 5 — vault .env precedence (architectural gap #5)

Real bug, low blast radius. The flip is one line. Operator-doc churn is
the cost; the fix itself is trivial.

## 4. The "living sentient" verdict

Sample evidence (10 random concepts, 10 random claims, 10 random
questions from the dogfood vault):

Concepts (good): Project PIs, Stakeholder Trifecta, embeddings API,
RAG filtering protocols, Drive API v3, CoreDNS, Illumina MiSeq/NextSeq,
Haiku.
Concepts (dross): wrappers, Distributed, Container Dark, Elegant
Technical, structure, npm-db, connection_builder.

Claims (good): "Hermes accelerates I/O-intensive applications by 2-10x
while reducing energy consumption". "Reasoning techniques improve
accuracy on math, physics, logic problems and are crucial for agents.".
"A DTIO evaluation plan follow-up meeting was completed on February 6,
2025." Specific, content-bearing, ground-able to a source note.
Claims (vapid): "Everyone has a role in building this future.",
"Automated validation occurs at every step", "Content management is
integrated with SEO optimization for search engine visibility." These
read like model padding when given a chunk that is mostly preamble.

Questions: highest-quality of the three. Almost every sample is specific
and ground-able ("How will the hierarchical namespace structure be
standardized for tool organization?", "How does the program determine
whether a project is 'transdisciplinary' or 'multi-disciplinary' in
practice?"). The question schema has the strongest rubric in the
extractor prompt and the model produces the cleanest output.

Verdict: the substrate is a real second-brain candidate, not a search
index with extra metadata. The extractor produces material a thoughtful
operator would want to keep. Two layers stand between that material and
a "living sentient" feel:

  1. The linker writes too few high-confidence edges and too many at the
     floor, so the graph that should weave concepts together is sparse
     and untrusted.
  2. There is no operator-driven workflow on top of the proposals — no
     review queue, no batch approve, no per-note suggestion bubble.

Fix those two and the existing extractor work surfaces visibly. Leave
them and the vault stays a passive store.

## 5. Architectural moves

Five concrete proposals. Each names files, a contract change, and a
test. Order reflects the leverage rank above. **None are touched until
the operator approves the order.**

### M1 — Operator approval verb (gap #1)

Files:
  src/cli/commands/proposalsList.ts                       (new)
  src/cli/commands/proposalsApprove.ts                    (new)
  src/cli/commands/proposalsReject.ts                     (new)
  src/cli/index.ts                                        (verb registration)
  src/daemon/handlers/proposals.ts                        (new RPC handlers)
  src/core/chat/tools/proposals.ts                        (add write-gated approve/reject tools)
  src/cli/tui/slashCommands.ts                            (add /approve-edge / /reject-edge to walk pending)

Contract:
  CLI    `notient proposals list [--note <path>] [--agent <name>] [--limit N]`
         `notient proposals approve <id>`
         `notient proposals reject <id> [--reason <text>]`
  RPC    `proposals.list`, `proposals.approve`, `proposals.reject`
  Chat   `proposals.approve` and `proposals.reject` registered with
         `writeGated: true` so they route through ApprovalGate's "ask"
         mode.

Test (TDD, smoke):
  Seed an unapproved related_to edge in a fresh dogfood vault. Run
  `notient proposals approve <id>`. Expect: edge transitions through the
  three states, daemon_write row written, source body acquires the
  `## Related` section, history row written. Reject path: row deleted,
  no daemon_write, no body change.

### M2 — Watcher-driven re-index correctness (gap #4)

Files:
  src/core/db/surreal.ts                  (new helper `fetchNoteShaByPath`)
  src/core/indexer/indexNote.ts           (sha-gated rerun)

Contract:
  In `indexNote`, before computing `runTier1Wanted`:
    storedSha := fetchNoteShaByPath(notePath)
    if storedSha !== null AND storedSha !== bodySha:
       call clearTierAtByPath(path, [1, 2, 3])
       set tierState.tier1Done = false
                tier2Done = false
                tier3Done = false
  Effect: when the on-disk body changes, the next indexNote pass treats
  every tier as un-run and rebuilds chunks, embeddings, concepts, claims,
  and edges. No user-facing flag; the watcher's enqueue path stays
  unchanged.

Test (TDD):
  unit:    construct a note, run indexNote once, assert tier1/2/3
           timestamps set; mutate the body, run indexNote again, assert
           chunkCount > 0 and tier3 ran (linker proposals exist).
  smoke:   on the dogfood vault, append a heading to a note, observe
           chunkCount > 0 and a fresh tier3-done event.

### M3 — Linker as candidate-set ranker (gap #2)

Files:
  src/core/agents/linker.ts                              (rewrite prompt + filter)
  src/core/agents/linker.test.ts                         (extend)

Contract change:
  Today: per-pair score with rubric "confidence < 0.6 means do not
  propose". The model anchors at 0.6 and emits ten edges at the floor.
  Tomorrow: ranking on the candidate set.
    Stage A — model ranks the K kNN neighbours and outputs the M most
              meaningful ones (M ≤ 4) with edge type and one-line
              rationale per kept candidate, NO confidence number.
    Stage B — code post-processes: rank position 1 → confidence 0.95,
              position 2 → 0.85, position 3 → 0.75, position 4 → 0.65.
              Drop everything else. The model's job is "rank and label",
              not "score on a continuous scale", which the literature
              shows is what local LLMs can actually do.
  Alternative: keep per-pair scoring but rephrase the rubric in graded
  terms ("0 = irrelevant, 0.5 = topical overlap only, 0.8 = the same
  argument from a different angle, 0.95 = direct support or
  contradiction"); drop the threshold language. This is cheaper to ship
  but does not eliminate anchoring.
  Recommendation: ranking. The dogfood evidence (every confidence at
  0.6 or 0.95+, nothing in between) is exactly the failure mode rubric
  rephrasing alone does not fix.

Test (TDD):
  unit:    fake provider returns a fixed ranking; assert post-processed
           confidences match the position ladder and that drops below the
           list cap produce no edges.
  dogfood: rerun tier3 over /tmp/notient-dogfood; assert distribution
           (no exact-0.6 cluster, top edges plausible by inspection).

### M4 — Vault .env precedence flip (gap #5)

File:
  src/daemon/bootstrap.ts                                (line 134)

Contract change:
  Today: `processValue ?? fileValue` — process env wins.
  Tomorrow: `fileValue ?? processValue` — vault file wins; process env is
  the fallback.

Test:
  Existing `bootstrap.test.ts` smoke covers env-source loading; extend
  to assert vault `.env` overrides `process.env` for the same key.

Doc churn: `docs/` references that describe precedence (search and
update); README if it documents the rule (search and update); CI
fixture inputs that lean on the current order (none expected;
verify by running `bun test`).

### M5 — Concept extractor noise filter

Files:
  src/core/indexer/extractor.ts                          (prompt sharpen + post-filter)

Contract change:
  Sharpen the prompt's existing ban on generic words with three concrete
  examples drawn from the dogfood corpus ("structure", "wrappers",
  "Distributed"). Add a post-extraction filter in
  `writeExtractionToSurreal` that drops entities matching:
    - single lowercase token of length < 5
    - bare snake_case or kebab-case identifiers (heuristic: no spaces,
      length < 16, contains `_` or `-`)
    - matches `/^[a-z]+ [A-Z][a-z]+$/` (UI design language pattern that
      generated "Container Dark" / "Elegant Technical")

Test:
  unit: feed a chunk that names a real concept ("DeepConf") and a
        bunch of UI tokens; assert only the real concept survives.
  dogfood: rerun tier3 over /tmp/notient-dogfood and re-sample 20
        random concepts; expect zero generic single-word rows.

### Architectural gap #3 — concept/claim taxonomy fields

Reframed. The schema (`src/core/db/schema.surql:73-86`) has no `kind` or
`source` fields on concept or claim, and the spec (§3.2) does not mention
them. The findings.md observation was a SurrealDB quirk: projecting an
absent field on a SCHEMAFULL table returns NONE rather than erroring,
which read as "every row has kind=NONE". There is nothing to wire and
nothing to remove. The right response is to **defer**: there is no
operator pain pointing to a missing taxonomy, the existing flat shape is
working for the extractor and the search pipeline, and adding a
classifier prompt without a downstream consumer is feature for its own
sake. If a future surface (e.g. "show me only definition-style claims"
or "show me only concepts that are people") demands it, revisit then.

## 6. Proposed fix order

Investigation → operator approval → fixes:

  1. M2 (watcher correctness) — small fix, removes a quiet
     correctness bug; lowest risk to ship first
  2. M4 (.env precedence flip) — one-line fix + doc; cheap, gets the
     architectural drift off the books
  3. M1 (approval verb) — the operator-perceived headline change
  4. M3 (linker ranking) — the edge-quality lift that gives M1's queue
     something worth approving
  5. M5 (concept noise filter) — the polish pass on extractor output;
     visible only after a re-tier3 of the dogfood vault, so save for
     last so it benefits from any incidental tier3 work above

Items deferred: gap #3 (no schema or operator pain), the SIGKILL recovery
gap (no architectural fix without boot-time orphan reconciliation; better
to scope its own session), the daemon_write provenance window beyond the
60s already shipped, the indexer:note-indexed dead-fields telemetry (the
brief did not flag it; documented in findings.md row 17 only).

Eight commits is enough to land M2 + M4 + M1 + M3 + M5 with one commit
per fix and a few additional commits for tests, doc updates, and the
deep-dive itself if it commits. Anything more triggers the brief's
"ASK before exceeding eight commits" gate.
