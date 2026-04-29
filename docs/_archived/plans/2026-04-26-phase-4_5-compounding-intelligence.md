# Notient Phase 4.5 - Compounding Intelligence Layer

**Status:** planning complete, not implemented
**Date:** 2026-04-26
**Placement:** after Phase 4 coding is green, before Phase 5 launch hardening
**Prerequisite:** Phase 4 Stream/Search/Vitals/Chat/Undo exists in source and passes its smoke gate
**Core thesis:** Notient should not become a generic "LLM wiki." Notient should become a local, Obsidian-native knowledge compiler whose outputs compound, remain source-grounded, and are always reviewable, reversible, and inspectable.

---

## 1. Why This Phase Exists

Phase 4 gives Notient its user-facing nervous system:

- Stream
- Vitals
- editor decorations
- native graph bridge
- SearchView
- Chat
- persistent conversations
- safe/yolo write tools
- universal undo

The LLM Wiki idea and the gist comment thread point to the next product leap: answers, syntheses, contradictions, and maintenance work should not vanish into chat history. They should become durable, linked, cited, queryable Obsidian artifacts.

Notient already has a stronger substrate than most LLM Wiki experiments:

- Local-only model calls
- SQLite plus markdown/frontmatter dual-store
- graph nodes and typed edges
- chunk-level evidence
- staged proposals
- approval flow
- undo history
- background agents
- Co-author

Phase 4.5 turns those into a compounding intelligence loop:

```text
Capture -> Compile -> Verify -> Surface -> File back -> Audit -> Improve
```

This is the missing bridge between "agentic notes" and "best intelligent notes in the world."

---

## 2. External Research Summary

Sources reviewed:

- Karpathy LLM Wiki gist: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Gist comments via GitHub API, 674 comments as of 2026-04-26.
- Obsidian Bases official docs: https://help.obsidian.md/bases
- Obsidian Bases syntax docs: https://help.obsidian.md/bases/syntax
- Obsidian accepted file formats: https://help.obsidian.md/file-formats
- Obsidian Properties docs: https://help.obsidian.md/properties
- Microsoft Research arXiv paper linked in the comments: "LLMs Corrupt Your Documents When You Delegate", https://arxiv.org/html/2604.15597v1

### 2.1 What The Gist Gets Right

The core insight is correct: RAG alone re-derives knowledge every time. A useful knowledge system should compile durable intermediate artifacts that grow with each source and each question.

Good ideas to adopt:

- Raw sources should stay immutable.
- Synthesized knowledge should be persistent markdown, not transient chat.
- Ingest/query/lint is the right operational loop.
- `index.md` and `log.md` are valuable human-readable navigation and audit artifacts.
- Good answers should be file-backed into the knowledge base.
- Obsidian is an excellent interface because markdown, wikilinks, graph view, Canvas, Bases, and local files all reinforce the same model.

### 2.2 What The Comments Add

The comment thread is noisy, but several serious patterns recur.

**Truth maintenance is the hard part.**
Commenters repeatedly worry that LLM-generated prose can drift away from the original sources. This is the core risk Notient must design around, not hand-wave.

**Mutable wiki pages are risky as the atomic unit.**
Several commenters argue for Zettelkasten-like atoms with stable IDs. The useful synthesis layer should cite atoms and source spans; it should not silently rewrite canonical source notes.

**Mechanical work must be code, not model effort.**
People implementing this pattern found that hashing, routing, splitting inbox entries, updating indexes, and detecting orphan links should be deterministic services. LLMs should synthesize and judge, not do bookkeeping.

**The hot cache matters.**
A recurring operational insight: agents need a compact "start here" artifact that summarizes current state, conventions, recent changes, and open threads. Without it, every session rediscoveries context.

**Index files scale only to a point.**
Some builders report `index.md` works at modest scale, then graph navigation and real IR/search become primary. Notient should render index-like views from its graph and DB, not make `index.md` the source of truth.

**Ingest needs classification first.**
Documents of different types need different extraction prompts. A paper, meeting transcript, regulation, web clipping, image, PDF, and daily note should not all be summarized by one generic prompt.

**Generated artifacts need a visible status.**
Useful statuses include draft, staged, accepted, superseded, stale, disputed, and archived.

**Conversation can be a source of knowledge.**
One strong counter-frame in the comments: the atomic knowledge event is often not a file, but a conversation where the user corrects, approves, rejects, and clarifies. Notient's Phase 4 markdown conversations make this adoptable.

**Obsidian Bases should replace Dataview as the forward-looking native table layer.**
Official Bases stores views as local `.base` files or embedded YAML, and operates on file properties. Obsidian Properties currently do not handle deeply nested properties well, so Notient should write flat properties for human-visible status.

**Long delegated document editing is dangerous.**
The arXiv paper linked in comments reports substantial degradation across long delegated editing workflows, with document size and interaction length making degradation worse. For Notient this means: avoid uncontrolled rewrite loops; prefer append-only atoms, staged diffs, source-span validation, and undo.

### 2.3 What Notient Should Reject

Do not adopt "the LLM owns the wiki entirely" as written. That conflicts with Notient's trust model.

Do not let generated synthesis become primary evidence. Generated artifacts can be context, not authority, unless they cite human/source spans.

Do not replace Notient's graph/vector/search substrate with a hand-maintained `index.md`.

Do not silently rewrite user notes to maintain a generated wiki. User notes are source material; generated intelligence is a separate layer unless explicitly approved.

Do not chase team permissions, cloud sync, or multi-user wiki governance for v1.0. Those are later product lines.

---

## 3. Product Positioning

Phase 4.5 introduces a new product layer:

**The Notient Intelligence Layer**

This is a vault-native, generated, source-grounded layer that contains:

- answer artifacts
- synthesis notes
- claim atoms
- concept maps
- source ledgers
- research logs
- frontier questions
- lint reports
- Bases dashboards

It is not a replacement for the user's notes. It is a compiled layer over them.

The public language:

```text
Notient does not write over your knowledge.
It compiles a living intelligence layer from your sources,
then asks before anything durable changes.
```

---

## 4. Phase Boundaries

### 4.1 Phase 4 Must Still Ship First

Do not implement Phase 4.5 before Phase 4 code exists. This phase depends on:

- `StreamService`
- `SearchPipeline`
- `ChatService`
- `ConversationStore`
- `HistoryService`
- `VitalsService`
- SearchView actions
- Chat write-gated tools
- universal undo

Phase 4.5 should be planned now so Phase 4 can avoid names and folders that will be awkward to migrate.

### 4.2 Small Phase 4 Adjustments To Preserve Optionality

While implementing Phase 4, keep these hooks:

- Keep `Notient/.index.json` generic enough for multiple indexes, not just conversations/search history.
- Ensure `history.kind` can accept future artifact/source-ledger mutations.
- Do not hardcode all `Notient/*` folders as never indexed. Exclusion must be policy-based by artifact kind.
- Store conversation files with enough metadata to later promote turns into durable knowledge artifacts.
- Search results should carry enough source identity to become citations later.
- Deep Search synthesis cards should preserve cited note paths in structured form, not only markdown text.

---

## 5. Core Concepts

### 5.1 Canonical Source

A canonical source is the thing Notient treats as evidence.

Examples:

- a user-written markdown note
- a clipped article markdown file
- a PDF attachment plus extracted text
- a meeting transcript
- a conversation turn explicitly accepted as durable memory
- a generated atom after user acceptance

Generated synthesis notes are not canonical sources by default. They become context until accepted.

### 5.2 Source Span

A source span is a stable pointer to evidence.

For markdown:

- note path
- heading path when available
- chunk id
- source hash
- optional character range

For PDFs later:

- attachment path
- page number
- text span hash
- optional bounding box

For audio/video later:

- attachment path
- timestamp range
- transcript span hash

Source spans are the answer to the comments' provenance critique.

### 5.3 Knowledge Artifact

A knowledge artifact is Notient-generated or Notient-managed markdown.

Artifact kinds:

- `atom`: one stable claim/question/concept note
- `synthesis`: a cited narrative connecting sources
- `brief`: a short answer or memo from Chat/Search
- `moc`: generated map of content
- `frontier`: open research question or investigation agenda
- `lint_report`: maintenance/audit report
- `conversation_digest`: accepted durable memory from a chat

Artifact statuses:

- `draft`: generated but not reviewed
- `staged`: visible in Stream for approval
- `accepted`: user approved as durable
- `disputed`: contradiction or user correction pending
- `stale`: source changed after artifact generation
- `superseded`: replaced by a newer artifact
- `archived`: retained but out of active flow

### 5.4 Source Authority

Not all files are equal.

Authority levels:

- `primary`: user notes, original papers, original transcripts, raw captures
- `secondary`: imported summaries, clipped articles, generated captions
- `generated`: Notient syntheses, answers, briefs, MOCs
- `unknown`: unclassified

Default rule: grounded answers can cite generated artifacts for orientation, but factual claims must trace to primary or secondary sources.

### 5.5 Atlas

The Atlas is Notient's hot cache and human-readable map.

It is rendered from DB and graph state, not maintained freehand by an LLM.

Files:

- `Notient/Atlas.md`
- `Notient/Activity Log.md`
- `Notient/Research Frontiers.md`
- `Notient/Bases/Artifacts.base`
- `Notient/Bases/Sources.base`
- `Notient/Bases/Maintenance.base`

The Atlas is the first context layer Chat reads before deeper retrieval.

### 5.6 Review Queue

The Review Queue is a user-facing queue of durable knowledge proposals.

It merges:

- Phase 3 staging edges
- Phase 4 write-gated tool approvals
- Phase 4.5 artifact proposals
- lint findings
- stale artifact warnings
- source ingest proposals

It is Stream plus stronger semantics.

---

## 6. Folder And File Conventions

Phase 4 creates:

```text
Notient/conversations/
Notient/proposals/
Notient/searches/
```

Phase 4.5 extends:

```text
Notient/
  Atlas.md
  Activity Log.md
  Research Frontiers.md
  .index.json
  artifacts/
    atoms/
    syntheses/
    briefs/
    mocs/
    lint-reports/
    conversation-digests/
  bases/
    Sources.base
    Artifacts.base
    Maintenance.base
    Research Frontiers.base
  proposals/
  conversations/
  searches/
```

Index policy:

- `Notient/proposals/` is not indexed as evidence.
- `Notient/conversations/` is indexed only as conversation context unless a digest is accepted.
- `Notient/searches/` is indexed only for history unless a result is promoted.
- `Notient/artifacts/*` is indexed with `origin = generated`.
- Accepted atoms can become `origin = accepted_atom` and may be cited, but still retain citations to source spans.

This avoids self-referential drift while still making Notient's own work discoverable.

---

## 7. Frontmatter Conventions

Obsidian Properties and Bases prefer flat properties. Existing nested `notient` blocks can remain for plugin internals, but Phase 4.5 should also write flat properties for human-visible views.

Recommended flat properties:

```yaml
---
notient_kind: synthesis
notient_origin: generated
notient_status: staged
notient_authority: generated
notient_source_count: 7
notient_citation_count: 12
notient_confidence: 0.82
notient_created_by: synthesizer
notient_model: nemotron-cascade-2-30b-a3b-i1
notient_created_at: 2026-04-26T00:00:00Z
notient_updated_at: 2026-04-26T00:00:00Z
notient_supersedes: []
notient_sources:
  - "[[10 Projects/foo]]"
  - "[[30 Resources/bar]]"
tags:
  - notient/artifact
  - notient/synthesis
---
```

Avoid deep nested frontmatter for user-facing properties because Obsidian's Properties view does not handle nested fields as first-class editable properties.

---

## 8. Schema V3

Phase 4.5 should add a v3 migration. SQLite remains the hot/queryable cache; markdown remains portable output.

### 8.1 `source_documents`

```sql
CREATE TABLE IF NOT EXISTS source_documents (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  authority TEXT NOT NULL,
  title TEXT NOT NULL,
  sha TEXT NOT NULL,
  content_type TEXT,
  imported_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  indexed_policy TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS source_documents_path ON source_documents(path);
CREATE INDEX IF NOT EXISTS source_documents_kind ON source_documents(kind);
CREATE INDEX IF NOT EXISTS source_documents_origin ON source_documents(origin);
CREATE INDEX IF NOT EXISTS source_documents_authority ON source_documents(authority);
```

`kind` values:

- `markdown_note`
- `web_clip`
- `pdf`
- `image`
- `audio`
- `video`
- `conversation`
- `generated_artifact`
- `unknown`

`origin` values:

- `human`
- `imported`
- `notient`

`indexed_policy` values:

- `evidence`
- `context_only`
- `excluded`

### 8.2 `source_spans`

```sql
CREATE TABLE IF NOT EXISTS source_spans (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  chunk_id TEXT,
  locator TEXT NOT NULL,
  text_sha TEXT NOT NULL,
  preview TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS source_spans_source ON source_spans(source_id);
CREATE INDEX IF NOT EXISTS source_spans_chunk ON source_spans(chunk_id);
```

`locator` is JSON:

```json
{
  "kind": "markdown",
  "path": "30 Resources/foo.md",
  "heading": "Key Claims",
  "charStart": 120,
  "charEnd": 280
}
```

### 8.3 `knowledge_artifacts`

```sql
CREATE TABLE IF NOT EXISTS knowledge_artifacts (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  model TEXT,
  prompt_hash TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  supersedes_id TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS knowledge_artifacts_path ON knowledge_artifacts(path);
CREATE INDEX IF NOT EXISTS knowledge_artifacts_kind ON knowledge_artifacts(kind);
CREATE INDEX IF NOT EXISTS knowledge_artifacts_status ON knowledge_artifacts(status);
```

### 8.4 `artifact_citations`

```sql
CREATE TABLE IF NOT EXISTS artifact_citations (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
  source_span_id TEXT NOT NULL REFERENCES source_spans(id) ON DELETE CASCADE,
  claim_hash TEXT NOT NULL,
  support_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifact_citations_artifact ON artifact_citations(artifact_id);
CREATE INDEX IF NOT EXISTS artifact_citations_span ON artifact_citations(source_span_id);
```

`support_kind` values:

- `supports`
- `contradicts`
- `quotes`
- `context`

### 8.5 `maintenance_findings`

```sql
CREATE TABLE IF NOT EXISTS maintenance_findings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  proposal TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS maintenance_findings_kind ON maintenance_findings(kind);
CREATE INDEX IF NOT EXISTS maintenance_findings_status ON maintenance_findings(status);
CREATE INDEX IF NOT EXISTS maintenance_findings_target ON maintenance_findings(target_kind, target_id);
```

Finding kinds:

- `uncited_claim`
- `stale_artifact`
- `orphan_atom`
- `broken_link`
- `duplicate_concept`
- `unresolved_contradiction`
- `source_not_integrated`
- `generated_cites_generated`
- `frontier_gap`
- `moc_missing`

---

## 9. Feature Set

### 9.1 Source Ledger

Every indexed or generated file gets a row in `source_documents`.

Why:

- Gives Notient a source-of-truth map.
- Separates evidence from generated prose.
- Allows search filters like "source only", "generated only", "accepted atoms only".
- Enables Bases dashboards.

User-visible behavior:

- Vitals shows source kind and authority.
- Search filters include origin/authority.
- Chat answers can say when they are relying on generated context rather than source evidence.

### 9.2 Source Spans And Citation Validator

Every generated artifact must cite source spans.

Why:

- Solves the "where did this fact come from?" critique.
- Gives Notient the strongest trust story among local PKM tools.
- Enables stale detection when a cited source span changes.

Rules:

- Synthesis artifacts require at least one citation per claim paragraph.
- Atom artifacts require exactly one primary claim and at least one supporting source span.
- MOC artifacts can cite artifacts, but factual claims inside MOCs still need source citations.
- Chat answers can be ephemeral without full span rows, but file-backed answers must validate.

### 9.3 Artifact Store

An `ArtifactStore` owns rendering, parsing, status changes, and frontmatter.

It writes markdown via existing atomic write paths and records every mutation to Phase 4 `HistoryService`.

Artifact templates:

**Atom**

```markdown
# Claim: <short title>

> [!summary]
> One atomic claim, written in the user's domain language.

## Claim

<one precise proposition>

## Evidence

- [[Source Note#Heading]] - cited source-span preview

## Links

- Supports:
- Contradicts:
- Extends:

## Status

accepted | staged | disputed | stale
```

**Synthesis**

```markdown
# <synthesis title>

> [!summary]
> 3-5 sentence executive synthesis.

## Thesis

<the synthesized position, with citations>

## Evidence Map

- Claim -> citations

## Tensions

- Contradiction or uncertainty, cited

## Open Questions

- Question to investigate next

## Sources

- [[source]]
```

**Research Frontier**

```markdown
# Frontier: <question>

## Why This Matters

## What We Know

## What Is Missing

## Best Next Sources To Find

## Related Notes
```

### 9.4 Promote Answer

Phase 4 Chat and Deep Search outputs get durable actions:

- Save as synthesis
- Save as brief
- Create atom
- Create frontier question
- Append to active note
- Add to Activity Log
- Stage links/contradictions

Every action:

- previews the markdown
- validates citations
- routes through approval in safe mode
- records undo history

This is the single most important product behavior borrowed from LLM Wiki: explorations compound.

### 9.5 Conversation Absorption

Phase 4 stores conversations as markdown. Phase 4.5 lets the user intentionally absorb them.

Modes:

- manual: user clicks "Absorb durable insights"
- threshold: after N turns, Notient offers a digest
- end-session: when a chat is closed, Notient proposes a digest

The digest extracts:

- decisions
- user preferences
- corrections to Notient
- durable facts
- new questions
- rejected assumptions

Nothing is written as durable memory without approval.

This adopts the comment-thread insight that conversation is often where knowledge is created.

### 9.6 Atlas And Hot Context

`AtlasService` renders `Notient/Atlas.md` from database queries.

Sections:

- Vault Snapshot
- Active Projects inferred from PARA folders
- Recent Accepted Artifacts
- Recent Source Ingests
- Open Questions
- Unresolved Contradictions
- High-Value Hubs
- Orphans
- Stale Artifacts
- Research Frontiers
- Last 10 Activity Log entries

Chat context budget uses progressive disclosure:

- L0: 200-token status line from Atlas
- L1: 1-2K Atlas summary
- L2: target MOC/artifact summaries
- L3: exact source spans

The model reads the map before it searches deeply.

### 9.7 Activity Log

`Notient/Activity Log.md` is append-only and parseable.

Entry format:

```markdown
## [2026-04-26T13:41:00-05:00] artifact.accepted | Synthesis: GPU Scheduling Notes

- artifact: [[Notient/artifacts/syntheses/gpu-scheduling-notes]]
- sources: 5
- citations: 14
- agent: synthesizer
- model: nemotron-cascade-2-30b-a3b-i1
```

This is human-readable, git-friendly, and easy to parse with simple text tools.

### 9.8 Memory Lint

`MemoryLintService` runs after agent activity, on demand, and optionally during long idle.

Checks:

- generated artifact has uncited factual paragraphs
- artifact cites only generated artifacts
- cited source sha changed since artifact generation
- staged artifact has low citation coverage
- atom has no inbound/outbound graph links
- concept node has duplicate labels
- source has never been integrated into any artifact
- contradiction edge exists but no user-visible tension note exists
- MOC missing for a dense cluster
- broken wikilinks in generated artifacts

Outputs:

- `maintenance_findings` rows
- Stream cards
- optional `Notient/artifacts/lint-reports/YYYY-MM-DD.md`

This is the "lint" operation from the gist, but made concrete and safe.

### 9.9 Research Frontier

`FrontierService` identifies the next best things to investigate.

Signals:

- clusters with many open questions
- contradiction pairs with no resolution
- source-heavy areas with no synthesis
- high-value orphan notes
- stale mature notes
- user-active project folders

Output:

- Stream suggestions
- `Notient/Research Frontiers.md`
- optional frontier artifact files

Important: frontier suggestions are agenda control, not autonomous web browsing. User chooses.

### 9.10 Obsidian Bases Export

Phase 4.5 should generate `.base` files so users can inspect Notient state natively.

Initial Bases:

- `Notient/bases/Sources.base`
- `Notient/bases/Artifacts.base`
- `Notient/bases/Maintenance.base`
- `Notient/bases/Research Frontiers.base`

Because Bases operate on note properties, Phase 4.5 must write flat frontmatter fields on artifact files.

Example `Artifacts.base` views:

- By status
- Stale first
- High confidence
- Needs review
- By source count
- By artifact kind

### 9.11 Ingest Classifier

Before extraction, classify source type.

The existing extractor is generic and chunk-level. Keep it, but add a classifier before specialized extraction.

Source kinds and first strategies:

- Markdown note: existing chunker/extractor
- Web clip markdown: extract title, author, URL, date, claims, quotes
- PDF attachment: register source, index extracted text if available, stage "PDF needs extraction" if not
- Image: register source; later local caption adapter
- Conversation: extract durable decisions/preferences only when approved
- Generated artifact: context-only unless accepted

Phase 4.5 should ship markdown/web-clip/conversation/generated-artifact handling. PDF/image/audio can be scaffolded but not overpromised.

### 9.12 Preservation Harness

The arXiv paper's practical lesson is that long delegated edits corrupt documents. Notient needs tests that assert preservation.

Add a smoke harness for generated artifacts:

1. Create a fixture vault with source notes.
2. Generate artifact proposals.
3. Accept them.
4. Run lint.
5. Undo the latest mutation.
6. Verify original source files are byte-identical unless explicitly modified by an approved write tool.

Add a citation harness:

1. Generate a synthesis from known source spans.
2. Mutate a cited source span.
3. Verify artifact becomes stale.
4. Verify Chat refuses to treat stale artifact as authoritative without warning.

---

## 10. Task Plan

## Task 0: Phase 4 Handoff Reconciliation

**Files:**

- Modify: `.planning/STATE.md`
- Modify: `docs/superpowers/plans/2026-04-25-phase-4-stream.md` only if implementation diverges
- Create or update: `.planning/phase-4.5-compounding-intelligence/STATE.md` if planning state dirs are revived

**Why:** Phase 4 plan currently exists but code does not. Before Phase 4.5 starts, record what Phase 4 actually shipped.

**Acceptance:**

- `.planning/STATE.md` says Phase 4 complete with actual test counts.
- Phase 4.5 prerequisites are all true.
- Any Phase 4 deferrals are explicitly listed.

---

## Task 1: Schema v3 Source Ledger And Artifacts

**Files:**

- Modify: `src/core/db/schema.ts`
- Modify: `src/core/db/migrations.ts`
- Create: `src/core/sources/types.ts`
- Create: `src/core/sources/sourceLedger.ts`
- Create: `src/core/sources/sourceLedger.test.ts`
- Create: `src/core/artifacts/types.ts`
- Create: `src/core/artifacts/artifactStore.ts`
- Create: `src/core/artifacts/artifactStore.test.ts`

**Implementation:**

- Add `source_documents`, `source_spans`, `knowledge_artifacts`, `artifact_citations`, and `maintenance_findings`.
- Migration must be idempotent from v1/v2/v3.
- `SourceLedger.upsertDocument()` computes stable ids from path plus origin.
- `SourceLedger.recordSpan()` stores locator JSON and text hash.
- `ArtifactStore.createDraft()` writes markdown and DB row.
- `ArtifactStore.setStatus()` updates DB, frontmatter, log, and history.

**Tests:**

- v1 -> v3 migration keeps existing rows.
- v2 -> v3 migration keeps staging rows and agent runs.
- source document upsert is stable by path.
- source span stores and retrieves locator.
- artifact create writes markdown and row.
- status transition records history.

**Acceptance:**

- `bun run typecheck && bun run lint && bun test` passes.
- Existing Phase 4 smoke still passes.

---

## Task 2: Artifact Folder Bootstrap And Index Policy

**Files:**

- Modify: Phase 4 `vaultBootstrap.ts`
- Modify: Phase 4 `excludePaths.ts`
- Create: `src/core/indexer/indexPolicy.ts`
- Create: `src/core/indexer/indexPolicy.test.ts`

**Implementation:**

- Ensure `Notient/artifacts/*` and `Notient/bases/*` folders exist.
- Replace path-only exclusion with policy:
  - evidence
  - context_only
  - excluded
- Generated proposals remain excluded.
- Accepted atoms are indexed as accepted generated knowledge, not primary source.
- Syntheses are searchable but cannot satisfy "source evidence only" filters.

**Tests:**

- conversations default to context-only.
- proposals default to excluded.
- accepted atom is indexed with generated authority.
- user notes remain evidence.

---

## Task 3: Source Span Extraction And Citation Validation

**Files:**

- Create: `src/core/citations/sourceSpan.ts`
- Create: `src/core/citations/sourceSpan.test.ts`
- Create: `src/core/citations/citationValidator.ts`
- Create: `src/core/citations/citationValidator.test.ts`
- Modify: `src/core/indexer/indexNote.ts`

**Implementation:**

- During indexing, create source document and span rows for each chunk.
- For markdown chunks, locator includes path, ordinal, and heading if available.
- Validator parses generated markdown and verifies each factual paragraph has a citation.
- Validator maps citations to known source documents and source spans where possible.
- Validator flags generated-only citation chains.

**Tests:**

- markdown note produces source document plus spans.
- citation validator accepts cited paragraphs.
- citation validator flags uncited generated claims.
- citation validator warns when citation points to generated artifact only.
- changed source sha marks artifact stale.

---

## Task 4: Artifact Markdown Templates

**Files:**

- Create: `src/core/artifacts/templates.ts`
- Create: `src/core/artifacts/templates.test.ts`
- Create: `src/core/artifacts/parser.ts`
- Create: `src/core/artifacts/parser.test.ts`

**Implementation:**

- Render templates for atom, synthesis, brief, MOC, frontier, lint report, conversation digest.
- Parse frontmatter and body back into structured artifact metadata.
- Write flat `notient_*` properties.
- Include `tags` that work with Obsidian search and Bases.

**Tests:**

- each template roundtrips.
- frontmatter contains flat properties.
- generated markdown includes source/citation sections.
- parser tolerates user edits without throwing.

---

## Task 5: Promote Answer From Chat And Search

**Files:**

- Modify: Phase 4 Chat UI components
- Modify: Phase 4 Search `SynthesisCard`
- Create: `src/core/artifacts/promoteAnswer.ts`
- Create: `src/core/artifacts/promoteAnswer.test.ts`
- Create: `src/ui/artifacts/PromoteArtifactModal.ts`

**Implementation:**

- Add actions to Chat assistant messages and Deep Search cards:
  - Save as brief
  - Save as synthesis
  - Create atom
  - Create frontier question
  - Append to active note
  - Add to Activity Log
- Modal shows rendered markdown and citation validation results.
- Safe mode requires approval.
- Yolo mode still records undo and shows one-click undo pill.

**Tests:**

- promote Search synthesis creates draft artifact.
- uncited answer cannot be accepted as synthesis without warning.
- promote as brief can be accepted with lower citation strictness.
- undo deletes created artifact and DB rows.

**Acceptance:**

- A user can ask Chat a substantial question, save the answer as a cited synthesis, and find it through SearchView without source pollution.

---

## Task 6: Conversation Absorption

**Files:**

- Modify: Phase 4 `ConversationStore`
- Create: `src/core/chat/conversationAbsorber.ts`
- Create: `src/core/chat/conversationAbsorber.test.ts`
- Modify: Chat UI to expose "Absorb durable insights"

**Implementation:**

- Extract candidate durable insights:
  - user corrections
  - explicit decisions
  - durable preferences
  - rejected assumptions
  - open questions
- Stage a `conversation_digest` artifact.
- Require user approval before digest becomes accepted memory.
- Link digest back to the conversation file.

**Tests:**

- absorber ignores casual chat.
- absorber extracts explicit decisions.
- rejected assumptions become "do not repeat" memory candidates.
- digest approval creates artifact and citations to conversation spans.

---

## Task 7: Atlas And Activity Log

**Files:**

- Create: `src/core/atlas/atlasService.ts`
- Create: `src/core/atlas/atlasService.test.ts`
- Create: `src/core/atlas/activityLog.ts`
- Create: `src/core/atlas/activityLog.test.ts`
- Modify: Phase 4 Chat context manager to include Atlas L0/L1

**Implementation:**

- Render `Notient/Atlas.md` from DB queries.
- Append parseable entries to `Notient/Activity Log.md`.
- Add `atlasService.snapshot({ budget })` for Chat context.
- Refresh on:
  - artifact accepted/rejected
  - source ingested
  - lint finished
  - approval decided

**Tests:**

- Atlas renders stable sections.
- Activity Log appends parseable entries.
- Chat L0/L1 snapshots stay within token/character budgets.
- Atlas render is deterministic for stable DB state.

---

## Task 8: Memory Lint

**Files:**

- Create: `src/core/lint/memoryLintService.ts`
- Create: `src/core/lint/memoryLintService.test.ts`
- Create: `src/core/lint/checks/*.ts`
- Modify: Phase 4 Stream service to include maintenance findings
- Create: `src/ui/sidebar/components/MaintenanceCard.tsx`

**Implementation:**

- Implement deterministic checks first.
- Add LLM-assisted checks only where deterministic evidence is insufficient.
- Emit `maintenance_findings` rows.
- Surface findings in Stream/Review Queue.
- Optionally render lint reports.

**Initial deterministic checks:**

- stale artifact
- broken wikilink
- generated-cites-generated
- orphan artifact
- missing citation
- source not integrated

**Tests:**

- each finding kind has a fixture.
- resolved finding is not re-emitted.
- stale artifact appears when cited source sha changes.
- Stream ranks maintenance findings but does not hide agent proposals.

---

## Task 9: Research Frontier Service

**Files:**

- Create: `src/core/frontier/frontierService.ts`
- Create: `src/core/frontier/frontierService.test.ts`
- Create: `src/core/frontier/frontierRenderer.ts`
- Create: `src/core/frontier/frontierRenderer.test.ts`

**Implementation:**

- Score frontier candidates from:
  - open question nodes
  - unresolved contradictions
  - dense clusters with no synthesis
  - high-value orphan notes
  - stale mature notes
- Render `Notient/Research Frontiers.md`.
- Stage frontier cards in Stream.

**Tests:**

- dense unsynthesized cluster creates frontier.
- resolved contradiction no longer creates frontier.
- user-active project paths boost score.

---

## Task 10: Obsidian Bases Export

**Files:**

- Create: `src/core/bases/baseWriter.ts`
- Create: `src/core/bases/baseWriter.test.ts`
- Create: `src/core/bases/templates.ts`
- Create: `src/core/bases/templates.test.ts`

**Implementation:**

- Generate `.base` files for Sources, Artifacts, Maintenance, Research Frontiers.
- Use flat properties and official Bases YAML syntax.
- Ensure `.base` files are local and git-friendly.

**Tests:**

- generated YAML parses.
- required views exist.
- filters reference valid flat properties.

**Acceptance:**

- Opening `Notient/bases/Artifacts.base` in Obsidian shows accepted/staged/stale generated artifacts with useful columns.

---

## Task 11: Ingest Classifier

**Files:**

- Create: `src/core/ingest/sourceClassifier.ts`
- Create: `src/core/ingest/sourceClassifier.test.ts`
- Create: `src/core/ingest/ingestPlanner.ts`
- Create: `src/core/ingest/ingestPlanner.test.ts`
- Modify: indexer path to call classifier before extraction

**Implementation:**

- Classify source kind and authority before extraction.
- For v1.0, support:
  - markdown note
  - web clip markdown
  - conversation digest
  - generated artifact
- Register unsupported attachments as source documents with `indexed_policy = excluded` or `context_only`, plus a Stream suggestion.
- Do not ship OCR or full PDF parsing unless a local extraction path is already available.

**Tests:**

- web clip with URL metadata classified as `web_clip`.
- generated artifact classified as `generated_artifact`.
- normal vault note classified as `markdown_note`.
- unsupported PDF is registered but not silently treated as extracted evidence.

---

## Task 12: Preservation And Citation Harness

**Files:**

- Create: `scripts/smoke-phase4_5.ts`
- Create: `src/core/testing/preservationHarness.ts`
- Create: fixture files under existing test fixture pattern

**Implementation:**

Smoke flow:

1. Build fixture vault.
2. Index notes.
3. Create source spans.
4. Promote one Deep Search answer into a synthesis.
5. Accept it.
6. Render Atlas.
7. Run Memory Lint.
8. Undo the artifact acceptance.
9. Verify source notes are byte-identical to the original fixture.

**Acceptance:**

```bash
bun run smoke:phase4_5
```

prints:

```text
[smoke] phase4.5: sourceLedger=ok citations=ok promote=ok atlas=ok lint=ok undo=ok preservation=ok
```

---

## Task 13: README And Launch Story Update

**Files:**

- Modify: `README.md`
- Create or modify: launch/docs pages in Phase 5

**Messaging changes:**

- Replace "13 agents" as the central claim with "local graph + compounding intelligence layer."
- Keep the White House model, but clarify agents are capabilities.
- Explain the Source Ledger and Intelligence Layer.
- Add a trust section:
  - source spans
  - citations
  - approvals
  - undo
  - generated-vs-source labels
- Add an Obsidian-native section:
  - markdown
  - wikilinks
  - frontmatter
  - Bases
  - Canvas

**Acceptance:**

- README matches actual implementation.
- No claim says Phase 4.5 features exist before they pass smoke.

---

## 11. Definition Of Done

Phase 4.5 is complete when:

- Schema v3 migrates cleanly from v1/v2.
- Every indexed note has a source document row.
- Every chunk has a source span row.
- A Chat or Deep Search answer can be promoted to a cited artifact.
- Citation validator blocks or warns on uncited durable artifacts.
- Atlas renders from DB state.
- Activity Log appends parseable events.
- Memory Lint emits at least three deterministic finding kinds.
- Stream/Review Queue surfaces artifact and lint proposals.
- Bases files are generated and openable in Obsidian.
- `smoke:phase4_5` verifies source preservation and undo.
- No generated artifact is treated as primary evidence unless accepted and source-cited.

---

## 12. Cut Lines

If schedule tightens, ship in this order:

1. Source Ledger + Source Spans
2. Promote Answer
3. Citation Validator
4. Atlas + Activity Log
5. Memory Lint deterministic checks
6. Bases export
7. Research Frontier
8. Ingest Classifier expansion

Defer if necessary:

- PDF OCR
- image captioning
- audio/video ingestion
- multi-model verification
- cryptographic receipts
- team sharing
- external web search/autoresearch
- full ontology editor

---

## 13. Risks And Mitigations

| Risk | Mitigation |
|------|------------|
| Generated artifacts pollute retrieval | Store origin/authority/index policy; source-only filters by default for grounded claims. |
| LLM rewrites user knowledge incorrectly | No silent user-note rewrites; all durable writes go through approval and undo. |
| Citation validation becomes too strict | Allow briefs with weaker validation; require strict validation only for accepted syntheses/atoms. |
| Too many artifact files clutter vault | Put generated files under `Notient/artifacts/`; Bases and Stream become primary UI. |
| Atlas becomes stale | Render from DB, not freehand; refresh on source/artifact/lint events. |
| Phase 4.5 slows launch | Use cut lines; source ledger/promote/citation are the core. |
| Obsidian nested properties are awkward | Write flat `notient_*` fields for Bases and human Properties view. |
| Local LLMs produce malformed JSON | Keep Phase 3 defensive parsing pattern; never crash coordinator on malformed model output. |

---

## 14. Why This Makes Notient Different

Most LLM Wiki clones are:

```text
files + prompts + generated summaries
```

Notient becomes:

```text
local vault + source ledger + source spans + graph + staged proposals
+ approvals + undo + generated intelligence layer + native Obsidian surfaces
```

This is a substantially stronger product.

The differentiator is not "Notient can summarize notes."

The differentiator is:

```text
Notient compiles your vault into an inspectable, source-grounded,
living intelligence layer while preserving user control.
```

That is the credible path to sentient notes.

---

## 15. Implementation Handoff

When ready to start Phase 4.5:

1. Confirm Phase 4 code is complete and `.planning/STATE.md` reflects reality.
2. Run Phase 4 gates:
   ```bash
   bun run typecheck && bun run lint && bun test
   bun run smoke:phase4
   ```
3. Start Task 1 with schema v3 and source ledger tests.
4. Keep each task independently committable.
5. Update `.planning/STATE.md` after every task group.

Do not start with UI. Start with source identity, provenance, artifacts, and validation. The UI becomes powerful only after the trust substrate is real.

