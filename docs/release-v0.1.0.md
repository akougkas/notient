# Notient v0.1.0

Released September 17, 2026. CLI, daemon and SDK **0.1.0**; Obsidian desktop plugin
**0.1.0**. This is the first public release. It is early software: read the known
limits before trusting it with a vault you care about. The sections after
"Historical checkpoints" are the working record of how it got here.

## What works

The terminal workspace supports persistent conversations, rendered Markdown, exact
source navigation, capture and editing, grounded briefs, note comparison, graph
exploration, review, guarded history and live preferences. CLI, MCP (32 tools),
authenticated HTTP, the typed `notient/sdk` client and the Obsidian sidebar reach
the same operations. Agents and the in-app assistant can plan exact changes and
ask for review; only a person applies, rejects or undoes. `notient setup` guides a
first run and ends in the read-only doctor report. All seven pipeline families are
implemented and off by default.

New in the Obsidian plugin: four selection commands, in the command palette and the
editor menu. **Ask about selection**, **Brief from selection**, **Find connections
for selection** and **Propose an edit to the selection** bind the selected passage
to the note's saved revision with exact file offsets across a byte-order mark, CRLF
line endings and frontmatter. An edit is only ever a reviewed preview. A note that
changed or has unsaved edits is a conflict, never a recompute. `brief.run` and
`notes.correlate` gained an optional `focus` range for this.

## How it was verified

| Check | Result |
| --- | --- |
| Full unit suite | **2,662 passed, 0 failed** |
| Full integration suite, one run, nothing else running | **540 passed, 0 failed** of 540 in 656 s. Run on the tree immediately before these notes were written; that tree and the release commit differ only in this document and the ledger |
| Evaluation pack, deterministic (part of the integration run) | **43 passed, 0 failed**: 42 fixed cases across seven pipelines through a real daemon; a fabricated quotation fails 9 cases |
| Evaluation pack, real model (September 16 and 17) | A LAN inference host, `qwen3.8-27b`, sequential, 22 runs. Every citation resolved byte-exact; no fabricated source. 3 runs exhausted the reasoning ceiling; 1 synthesis joined unrelated notes before its instruction was corrected and re-probed |
| Root and Obsidian typechecks and builds | Passed |
| Lint | 0 errors, **139 warnings** (unchanged baseline; not warning-free) |
| Release package | `release:prepare` from the clean release commit; `release:check` clean-installed that exact tarball and exercised packaged CLI/OpenTUI imports, BOM/CRLF read, graph, reviewed append and receipt replay, exact undo across restart, read-only paired HTTP, the installed `notient/sdk` runtime and declarations, and 32-tool stdio MCP with zero generation calls; `sha256sum -c SHA256SUMS` passed |
| Install from the public release | Performed after publication from a clean directory: download by URL, checksum, global install, `--version`, `setup`, `doctor`, one lexical search. The result is recorded in the ledger and on the release page |
| Documented commands | Every `notient` command in the README and the model-free commands in Getting started were run as written against a fresh temporary vault; `ask`, `brief --file` and `chat` ran once each against the real model. Two documentation gaps found and fixed (search modes, backup precondition) |
| Remote CI | `.github/workflows/ci.yml` (unit, integration, installed package) needs no model and no Obsidian. It first ran remotely with this release; its result for the tagged commit is recorded in the ledger and on the release page |

### The plugin ZIP in a real Obsidian

Windows Obsidian 1.13.7 with an isolated profile and a disposable vault, a WSL
daemon on this build, driven over the Chrome DevTools protocol. The three installed
files were byte-identical to the ZIP payload (`sha256sum -c`), and the payload is
byte-identical to the one in the published ZIP. Screenshots are kept privately.

- Sidebar renders; pairing with `read,write,host` succeeds.
- The four selection commands appear in the palette and the editor context menu.
  With no selection, and with an unsaved buffer, each explains itself and does
  nothing.
- On a note with a BOM, CRLF line endings, frontmatter and emoji, editor offset 238
  mapped to saved offset 248 and the daemon's range read returned the byte-identical
  passage.
- **Ask about selection**: rendered Markdown answer with one verified source in
  15.6 s. **Brief from selection**: 4 cards from 2 sources in 69.0 s; opening a
  cited source selected exactly the quoted passage. **Find connections for
  selection**: one two-sided connection to a related note in 110.2 s.
- **Propose an edit**: exact before/after in Review, file untouched until apply;
  after apply the bytes were exactly the planned result with BOM and CRLF kept, and
  the open editor synchronized.
- Review listed a change requested by an agent (`release-agent`) and one requested
  by the in-app assistant (`assistant:human`, one real 22.8 s chat turn). Both showed
  rationale and exact diff.
- A dirty buffer vetoed the apply with "Unsaved Obsidian edits in … Save or close
  that editor, then review the current revision"; the buffer and the file were
  preserved. After saving, the same review applied and the editor synchronized.
- Change history listed the changes. Undo without `admin` was refused with
  "history.undo requires admin scope"; with `admin` it restored the exact earlier
  bytes and the editor synchronized.
- After a daemon stop and start the plugin reconnected by itself in 8.6 s, host
  protection reattached and a sidebar search worked.

Two defects were found only by this pass. Obsidian's `Vault.read` drops a
byte-order mark, so the plugin computed a different revision than the daemon for
such notes; saved notes are now read as raw bytes. And a stale earlier pairing keeps
its editor protection, which blocks writes until it is revoked; this is intended
fail-closed behaviour and is now documented.

## Measured real-model latency

A LAN inference host serving `qwen3.8-27b`, one request at a time:

| Operation | Measured |
| --- | --- |
| `ask` on a small vault | 15.6 s, 16.3 s |
| `ask` on the owner's 961-note experimental vault | 31.7 s |
| `brief` from a note | 30.8 s (2-note vault), 69.0 s (selection, 2 sources) |
| Connections for a selection | 110.2 s |
| In-app assistant planning and submitting one change | 22.8 s |
| Pipelines: one-note enrichment, contradiction, relate | 60 to 120 s, 122 s, 213 s |

Most of that time is model reasoning. Visible-answer token usage is unavailable
from this provider and is never inferred from aggregate completion usage.

## Known limits

- **Latency** is the main quality limit, as measured above. Earlier complex
  comparison and brief attempts on the large vault timed out, lacked two-sided
  evidence or abstained despite relevant sources. Those failures remain recorded.
- **No native Windows daemon.** Windows Obsidian was validated against a WSL daemon.
- **macOS is unverified.** It is implemented and covered by deterministic tests; no
  real macOS host or service was exercised.
- **The plugin is not in the Obsidian community directory.** It installs from the
  release ZIP. Mobile is unsupported.
- **The cross-surface acceptance scenarios were not run as one pass.** The six N09
  scenarios were exercised separately. The full N01 to N10 MVP is not accepted, and
  background throughput and resource use are unmeasured.
- Obsidian rewrites a note that has a BOM or CRLF line endings as plain LF when it
  saves it. Notient then refuses earlier reviews and undo for that note as stale.
  Observed in the host pass; the refusal is the guarantee working.
- Pairing a vault again leaves the previous pairing's editor protection in force
  until `notient pair revoke` removes it.
- A vault reached through a symlinked directory fails its configuration check. Use
  the real path.
- `notient search --mode balanced|deep` and `notient backup` need configured models
  and say so; `quick` search, reading and the structural index do not.
- A whole-note read is cited as one range covering everything that was read, which
  is exact and coarse. In Obsidian, selecting such a citation excludes the
  frontmatter that the Properties view owns.
- Vision has not been accepted. Lint has 139 warnings.
- Not published to npm; the website in `website/` is not deployed.

## Assets

`notient-0.1.0.tgz`, `notient-obsidian-0.1.0.zip`, `openapi-v1.json`, `INSTALL.md`
and `SHA256SUMS` are attached to the
[GitHub release](https://github.com/akougkas/notient/releases/tag/v0.1.0).
`bun run release:prepare` assembles them from a clean committed tree and
`bun run release:check <tarball>` clean-installs that exact package without
inference. Raw model and vault evidence and credentials are excluded from all
assets and from this repository. The [ledger](sprints/v0.1.0.md) keeps the working
record, including failures.

# Historical checkpoints

The sections below describe earlier local candidates and are kept unedited apart
from neutral wording for private locations.

## Historical candidate before release, September 17, 2026

CLI/daemon remains **0.1.0-alpha.1**; the Obsidian desktop development plugin is
**0.0.1**. These are local candidate versions, not a completed v0.1.0 release.
No push, tag, package publication, plugin submission or website deployment has
been authorized or performed. The sections below this one are historical.

The terminal workspace supports persistent conversations, rendered Markdown, exact
source navigation, capture and editing, grounded briefs, note comparison, graph
exploration, review, guarded history and live preferences. CLI, MCP (32 tools),
authenticated HTTP, the typed `notient/sdk` client and the Obsidian sidebar reach
the same operations. Agents and the in-app assistant can plan exact changes and
ask for review; only a person applies, rejects or undoes. `notient setup` guides a
first run and ends in the read-only doctor report. All seven pipeline families are
implemented and off by default.

Verification of the final tree:

| Check | Result |
| --- | --- |
| Full unit suite | **2,658 passed, 0 failed** |
| Full integration suite | **538 passed, 1 failed** of 539 in 773 s. The failure was a 15-second startup deadline in the outage smoke, where an unreachable port timed out instead of refusing. The deadline was widened and the file then passed 3 of 3 runs. The full suite was not repeated after that one-line test change. An earlier full run in this session was **496/0** |
| Evaluation pack, deterministic | **43 passed, 0 failed**: 42 fixed cases across seven pipelines through a real daemon; a fabricated quotation fails 9 cases |
| Evaluation pack, real model | the LAN inference host `qwen3.8-27b`, sequential, 22 runs. Every citation resolved byte-exact; no fabricated source. 3 runs exhausted the reasoning ceiling; 1 synthesis joined unrelated notes before its instruction was corrected and re-probed |
| Root and Obsidian typechecks/builds | Passed |
| Lint | Passed with **139 warnings**; not warning-free |
| Visible terminal pass | Herdr, disposable vault: preferences edit and save, agent-requested change inspected and applied. Four defects found and fixed |
| Clean-installed candidate | Packaged CLI/OpenTUI imports, BOM/CRLF read, graph, reviewed append and receipt replay, exact undo across restart, read-only paired HTTP, **installed `notient/sdk` runtime and declarations**, **32-tool stdio MCP**; no inference requests |
| Guided setup | Live run against the LAN inference host catalog on a disposable vault: private env written mode 600, doctor passed |
| Owner's experimental vault (the experimental vault) | Daemon moved to this build. Structural index version 4 rebuilt **895/895** notes with no inference. **961 original notes**, both private configurations and **168 Git-status entries** byte-identical before and after. Doctor all green. One real `ask` returned a correct grounded answer in **31.7 s** with two revision-bound citations |

Not verified in this candidate: the Obsidian plugin ZIP in an actual Obsidian
runtime (last verified at `1ebafa9`; the plugin source changed only through shared
API modules), native Windows or macOS hosts and remote CI. A whole-note read is
cited as one range covering everything that was read, which is exact and coarse.

Real-model latency is the main quality limit. One-note enrichment took 60–120
seconds, a contradiction 122 seconds and a relate run 213 seconds, mostly
reasoning. Earlier complex comparison and brief attempts on the experimental vault timed out,
lacked two-sided evidence or abstained despite relevant sources. Those failures
remain recorded. Visible-answer token usage is unavailable from this provider and
is never inferred from aggregate completion usage.

`bun run release:prepare` assembles a CLI tarball, plugin ZIP, OpenAPI,
installation notes, source/version manifest and SHA-256 checksums under ignored
`artifacts/` from a clean committed tree. `bun run release:check <tarball>`
clean-installs that exact package and exercises it without inference. The
candidate manifest records source identity; it does not manufacture acceptance.

Material limits for this alpha:

- The full N01–N10 MVP is not accepted. The six cross-surface scenarios have not
  been run as one acceptance pass, and background throughput and resource use
  are unmeasured.
- Selection-scoped native Obsidian workflows and broad host acceptance remain
  open. Plugin 0.0.1 is a development distribution, not a community-directory
  entry. Vision has not been accepted.
- Native Windows daemon startup is unsupported. Windows desktop validation uses
  WSL; native macOS host and service validation is unavailable.
- The website in `website/` is built and not deployed. Its release paragraph
  states that nothing is published.

The [ledger](sprints/v0.1.0.md) preserves failures and private evidence locations.
Raw model and vault evidence and credentials are excluded from candidate assets.

## Historical checkpoint: public jobs and live pipelines, 2026-09-16

Runtime/package remains **0.1.0-alpha.1**. The complete N01–N10 MVP is not accepted
and nothing has been pushed, published or deployed. This section supersedes the
older operation inventory below; historical evidence is retained separately.

Three verified implementation slices now expose the existing durable engine:

- `jobs.list/get`: bounded summaries, snapshot-bound pagination, full progress,
  source/policy revisions, provider accounting, findings, effects and failures.
- `jobs.control`: revision-guarded pause/resume/cancel/retry, caller ownership,
  finite transitions and atomic durable idempotency receipts. Completed jobs cannot
  be relabelled cancelled. Cancellation retains charged inference and committed
  effects; exact receipt replay survives daemon restart.
- `pipelines.list/run`: all seven finite families, current policies and schedule
  status, explicit revision-bound live invocation and durable admission. Detached
  jobs recheck paired-client revocation before inference/effects and after recovery.
  Fresh configuration keeps AI background work disabled.

HTTP and the typed client, CLI, TUI slash commands and MCP use the same services.
Actual daemon tests exercise these surfaces, including stdio MCP, paired read-only
credentials, detached revocation and process restart. OpenAPI is regenerated.

| Check | September 16 evidence |
| --- | --- |
| Full unit suite | **2,549 passed, 0 failed**, 7,264 assertions, 187 files. |
| Full integration suite | **437 passed, 0 failed**, 2,200 assertions, 61 files, 312.80 s. |
| Final focused job/pipeline regression | **23 passed, 0 failed**, 185 assertions; includes fractional-duration retry, exhausted budget, schema correction, revocation and receipt preservation. |
| Final public-surface regression | **26 passed, 0 failed**, 234 assertions, after the final relationship-direction prompt correction. |
| Typecheck/build/whitespace | Passed. |
| Lint | Passed with **28 complexity warnings**: 26 inherited, plus CLI dispatch and the expanded model fixture. |
| Actual the LAN inference host/Qwen protocol | Reasoning answer, structured evidence and multi-step tools completed; five requests used 6,759 provider-reported total tokens. |
| Actual Qwen pipeline execution | Successful representative previews for all seven families across bounded synthetic runs; exact findings and failures retained privately. This is not full N06 acceptance. |
| the experimental vault | CLI as codex produced a cited SWMR flush/refresh answer in 29.524 s. Index current at 895/895. Exact 168-entry git status, config/deployment hashes and source revision preserved. |
| Packaging/Obsidian hosts | Earlier tarball checks are historical. No new plugin/host, Windows/macOS or final tarball acceptance is claimed. |

The real-model runs found and drove fixes for a fractional-duration retry that
could strand a job at `running`, provider JSON Schema constraints being ignored,
and missing comparison abstention explanations. Runtime validation remains
authoritative. A bounded schema correction, when retries are enabled, uses the
same run budget and only visible JSON plus validation errors. Remaining duration
rounds down; exhausted duration fails before dispatch. Reasoning, aggregate
completion, provider total and unavailable visible-answer usage remain distinct.

Earlier 12,288-token/180-second comparison and inbox probes include actual
truncation/timeouts and are preserved as failures. Final contradiction/inbox
previews under an explicit 24,576-token shared ceiling, 300-second duration and
65,000-token run budget completed in 38.562/97.357 seconds, charging 4,408/11,767
provider total tokens. Archive review proposed a completed migration and abstained
on a note with an unfinished task. These previews preserve authored source bytes.
Manual review also caught a directed `extends` edge whose endpoints disagreed with
its rationale. Explicit direction instructions corrected the retest: relate took
27.674 seconds (3,492 provider total tokens); inbox took 77.025 seconds across three
calls (9,699 provider total tokens), with matching directed evidence, metadata,
summary and a filing-move preview. The earlier wrong-direction output remains a
quality failure in the ledger. Representative successes do not establish broad
quality or all-family background/writeback acceptance.

Use `notient pipelines list`, `notient pipelines run`, `notient jobs list|get`,
and `notient jobs pause|resume|cancel|retry`; see [API semantics](api-v1.md) for exact
inputs and [MCP tools](mcp.md). TUI commands are `/pipelines`, `/pipeline`, `/jobs`,
and `/job`. Queue admission is not a successful pipeline result.

Next bounded phase is canonical proposal inspection and human review, followed by
configuration controls/settings. Remaining release work includes new durable-state
backup/restore coverage, full background and partial-effect acceptance, domain-agent
parity, the official Obsidian plugin/native bridge, packaged SDK, final installation
checks, CI, website and release assets. The [ledger](sprints/v0.1.0.md) records exact
failures, decisions, private evidence locations and the resume point.

## Historical September 12 checkpoint

The owner requested a workable stopping point on 2026-09-12. This alpha checkpoint supports a real local daemon, canonical note reading/retrieval, scoped HTTP pairing and revision-checked structural preview/apply through the existing history authority. It is **not the complete v0.1.0 MVP**. No task N01–N10 is fully accepted; package/runtime remains `0.1.0-alpha.1`. The [sprint](notient-v0.1.0-sprint-prompt.md) still defines full scope and the [execution ledger](sprints/v0.1.0.md) records the exact resume point and failures.

## What is usable at this checkpoint

- Model-independent daemon boot, current structured note reads and lexical retrieval. Read results include authored Markdown, properties, headings, explicit blocks, links/embeds, tasks, callouts, revisions and freshness. Catalog and context retrieval are bounded and scope-filtered.
- Loopback HTTP starts with the daemon and uses the existing scope-checked dispatcher. Local human administration creates single-use pairing codes and revokes persistent scoped credentials. Canonical CLI `api` calls and HTTP converge on the same note and mutation authorities.
- Exact durable change previews support creation, append, selected edits, property changes and reference-aware move/archive/unarchive. Applying an exact preview uses revision checks, stable per-effect receipts, the existing filesystem journal and mutation history. Repeating the same preview returns its prior receipt. Multi-effect operations report partial outcomes honestly.
- Provider execution separates reasoning from visible answers and tool arguments, preserves provider accounting categories, rejects incomplete/truncated/reasoning-only final responses, and checkpoints budget reservations before network dispatch. Embedding identity can resolve after an initial outage without restarting the daemon.
- Existing persistent service commands and canonical MCP note reads remain available. Current build includes the CLI, daemon and database schema. A fetch-only validated HTTP client exists in source, alongside generated [OpenAPI](openapi-v1.json); packaging that SDK for external consumption remains unfinished.

## Implemented internally, still unfinished as product workflows

The production daemon now composes persisted jobs, live background settings, a finite configured coordinator, all seven pipeline stage implementations, exact-evidence plans and the existing proposal/writeback authority. Fresh configuration enables structural watching only; AI background pipelines are disabled. Deterministic integration verifies enrichment, explicit metadata-write permission, approval/receipt replay, live revocation, outage waiting/resume, rejection suppression and token ceilings.

**Canonical pipeline/job/configuration controls and the new review operations are not yet registered in the public dispatcher.** Their integration tests call internal services directly. Consequently this checkpoint does not offer a complete public pipeline workflow, usable pipeline settings UI, or full seven-family acceptance. The current canonical operation inventory is only `capabilities.get`, `notes.read`, `notes.list`, `search.run`, `context.get`, `changes.preview`, `changes.apply`, and `events.subscribe`, plus pairing and SSE transport routes.

## Historical September 12 verification

| Check | Current evidence |
| --- | --- |
| Typecheck | Passed against the current source tree. |
| Lint | Passed with **26 complexity warnings**, 533 files checked; not a warning-free pass. |
| Full unit suite | **2,539 passed, 0 failed**, 7,197 assertions, 186 files, 15.69 seconds. |
| Full integration suite | **417 passed, 0 failed**, 1,961 assertions, 58 files, 256.48 seconds against the final relevant source tree. |
| Build and whitespace | CLI, daemon and schema build passed; `git diff --check` passed. |
| Clean tarball install | Installed outside checkout; installed CLI version/help and native OpenTUI core/React imports passed. |
| Installed daemon operation | Actual packaged daemon boot, BOM/CRLF-preserving canonical read, preview/apply, duplicate receipt replay and clean shutdown passed on disposable files. This exercises the patched SurrealDB decoder through stored previews/history. |
| Seven pipeline integration cases | Real SurrealDB/filesystem and deterministic HTTP model fixture: 7 passed, 0 failed, 30 assertions. This proves those control paths, not Qwen pipeline usefulness. |
| Actual the LAN inference host/Qwen | Reasoning-heavy answer, evidence-backed structured JSON and three-round tool conversation passed; details below. |
| Owner preservation | the experimental vault status identical at 168 pre-existing entries; deployment config unchanged. Owner repository history/sprint/assessment documents preserved. |
| Obsidian/macOS/Windows host | Plugin and host bridge not implemented. Actual Obsidian, Windows-to-WSL desktop and macOS service validation remain unverified. |

Current logs are a private evidence directory,integration-final,typecheck-final,lint-final,build-final}.log`. The first full unit run failed seven cases; correcting stale test contracts and inspection of batch embedding recovery led to the passing rerun. The first integration run had **416 passes and one failure** in the expected CLI command list, which omitted `api` and `pair`; the expectation was corrected. Original failed logs remain a private evidence directory. Earlier BOM-decoding, structural replay and SQL revision-guard failures remain in the ledger. Historical 2,526/414 results belong to the previous checkpoint and are not current acceptance.

Prior-session WSL user-systemd installation/status/idempotent installation/unit verification/uninstallation passed on a disposable vault. That platform check was not repeated during this wrap-up. It is separate from current package/daemon verification.

## Actual reasoning-model evidence

Rechecked a LAN inference host: exact model `qwen3.8-27b` was available and loaded. Native discovery advertised reasoning and tool support; an independent per-request reasoning-token ceiling was not established. Execution accounts for the shared generation ceiling and does not assume a disable-thinking hint was honored.

The current synthetic provider probe completed a reasoning-heavy optimal scheduling answer with a correct ten-minute schedule and critical-path proof, exact-evidence contradiction JSON, and a three-round list/read/read/answer conversation. The tool run included two calls in one batch and correctly matched tool-result IDs. Five requests totaled **5,411 provider-reported tokens**. Reasoning and aggregate completion are recorded separately; visible-answer token counts were unavailable and were not inferred. Raw private requests, responses and accounting are under a private evidence directory. Reproduction helper: `tools/evaluate-v010-provider.ts`.

The prior-session the experimental vault extraction remains useful historical evidence: a 1,400-token request exhausted its ceiling in reasoning with no answer despite the thinking hint; the same source completed with a 4,096-token ceiling. The current session's protocol probe used synthetic content. Neither establishes all-seven-pipeline quality or actual owner-vault end-to-end workflows. the experimental vault's saved mini/ornith deployment was not changed or represented as a the LAN inference host deployment test.

## Using the implemented portion

After `bun install` and `bun run build`, these canonical operations can connect to the local vault daemon:

```sh
bun dist/notient.js api notes.read --input '{"path":"Projects/Storage.md"}' --vault /absolute/path/to/vault --ndjson
bun dist/notient.js api search.run --input '{"query":"Durability","mode":"lexical"}' --vault /absolute/path/to/vault --ndjson
bun dist/notient.js pair create --vault /absolute/path/to/vault --label local-client --kind human --scopes read,write --ndjson
```

`notes.read` optionally accepts an exact heading/block selector or revision-bound range. Its source revision is the precondition for later change previews. Apply requires the exact `previewId` and preview revision returned by `changes.preview`. See [API documentation](api-v1.md) for the HTTP routes, source SDK and limits, and [services](services.md) for service lifecycle commands. HTTP binds to the endpoint reported by daemon status/pairing; no fixed port is assumed.

## Resume requirements and material limits

1. Complete the existing pipeline/job/configuration/review public handlers and domain agent tools, then CLI/TUI/MCP parity. All seven pipeline families need substantive live/background outcomes and model-quality/abstention evaluation.
2. Close recovery and authority gaps: conflicting apply/control idempotency keys, policy revocation during boot reconciliation, multi-effect/partial review recovery, atomic job/event publication, scheduling/admission edge cases and complete outage/restart acceptance. Retain the same mutation and approval authorities.
3. Finish structural edge cases, including frontmatter/reference-style move rewriting and inbox processed-property behavior. Connect the host dirty-buffer veto before claiming editor-safe mutation.
4. Implement the official Obsidian sidebar/settings/commands/review/job controls and authenticated bounded native host bridge. Validate actual Obsidian editor state, source navigation, cleanup and Windows-to-WSL vault mapping.
5. Finish guided setup/doctor, packaged SDK, CI and acceptance pack, plugin ZIP, release assets and notient.org. Keep alpha version until the implementation and ledger justify v0.1.0.

These are remaining engineering tasks, not permission blockers. This checkpoint stops because the owner asked to wrap up; the expanded sprint has not been reduced.

## Artifact and publication status

Current alpha tarball: a private evidence directory. Size: 2,530,717 bytes. SHA-256: `75a4c0eee33088a890a181f3cf83e8be9e79fa42920c81a36419934c75883f75`. Installed outside the checkout at a private evidence directory.

Package evidence and installed-daemon logs are retained beside the tarball. Temporary test vault and per-vault daemon/database state were removed after clean shutdown. `/tmp` artifacts and logs are local checkpoint evidence, not permanent publication or archival storage.

No push, tag, package publication, plugin submission or website deployment occurred. No actual Obsidian screenshots/recordings were produced. The owner subsequently requested a local checkpoint commit. No released product is implied.

## Subsequent live TUI correction

The Herdr demonstration exposed stale strict TUI status/note-read decoders. They now validate the current status fields and use the canonical structured note-read schema. The correction passed 372 focused TUI unit tests, 2 real-daemon integration tests, typecheck and build. Full-suite totals and the tarball above precede this correction; neither is asserted to verify the final commit. The demo was paused at the owner's request. See the ledger's final section for actual MCP/tool results and the recoverable the experimental vault deployment changes.
