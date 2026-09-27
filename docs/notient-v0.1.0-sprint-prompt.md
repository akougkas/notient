# Coding-session prompt: complete Notient v0.1.0

You are implementing the Notient v0.1.0 release in this repository. Execute the sprint below: inspect the current code, implement the changes, verify the product, and prepare the release artifacts. Begin implementation in this session. A plan, architecture essay, set of stubs, or renamed alpha does not satisfy this task.

Read repository instructions and `docs/assessment-2026-09-11.md` first. Treat that assessment as evidence about the earlier checkout, not a fixed specification. The owner's instructions in this prompt supersede its suggestions to limit the release to one discovery workflow, defer an Obsidian plugin, or keep configuration immutable at daemon boot. Recheck the working tree and current behavior before acting. Preserve unrelated changes and the owner's untracked `history.txt`.

**Product objective**

Notient makes a Markdown vault useful as durable, structured context. Obsidian is the primary human authoring environment. AI operates through deliberately designed workflows, invoked live by a person or agent or scheduled asynchronously according to the owner's configuration.

Deliver all of the following in v0.1.0:

- A documented, typed Notient API built around Obsidian note structure and Notient's derived context, relationships, proposals, jobs, and history.
- Reliable file/index synchronization and local access independent of model availability.
- Multiple complete, carefully tuned pipelines for enrichment, relationships, contradictions, synthesis/new notes, inbox processing, and archiving.
- Explicit user control over each pipeline's background triggers, read/write scope, effects, schedule, and resource use.
- An official first-party Obsidian desktop plugin with a powerful right-sidebar workspace and settings UI.
- Consistent CLI, TUI, and MCP access to the same capabilities.
- Tested installation, versioned release artifacts, documentation, and a small website ready for notient.org.

Autonomy is an execution policy across these capabilities. Do not implement a separate autonomous personality, an open-ended agent swarm, or an opaque loop allowed to invent arbitrary actions. A live invocation and a background invocation of a pipeline use the same implementation, output schema, provenance, and mutation rules. They differ in trigger, priority, delivery, and explicit permissions.

This is the owner's private tool. Keep Bun/TypeScript, SurrealDB, the per-vault daemon, existing Markdown infrastructure, and shared write authorities unless a concrete defect requires a focused change. No legacy compatibility layer, multi-tenant service, account system, arbitrary workflow programming language, or database rewrite is required. ACP/A2A and mobile Obsidian are outside this release. The first-party desktop plugin is required; community-directory approval is an external process, not something to claim merely because artifacts build.

**Execution discipline**

Create `docs/sprints/v0.1.0.md` as the working ledger. Track the task IDs below with status, changed components, concrete evidence, and remaining blockers. Work in dependency order and complete vertical slices through the relevant public surface. Keep the ledger current so work can continue across context limits without another assessment cycle. Do not silently drop pipeline families or the plugin to make the sprint appear finished.

Make reasonable implementation decisions and continue. Ask only for information that actually blocks dependent work, after inspecting available context; keep independent work moving. Do not stop after presenting the ledger. Separate implementation completion, verification, and publication status. An unavailable live model or desktop session is an explicit validation gap, not a passing test and not a reason to abandon other implementation work.

Use focused regression tests for synchronization, mutations, scheduling, permissions, and protocol behavior. Avoid tests that merely repeat constants or compare an implementation to itself. Preserve and strengthen existing checks rather than suppressing failures. Keep unrelated refactoring out of the sprint.

**N01 — Establish one note-centered contract and a representative fixture**

Inventory current RPC methods, domain services, wire types, CLI/MCP wrappers, Markdown structures, and mutation paths. Introduce one canonical domain API and runtime schemas, extending existing services rather than building a second engine. Keep database record types and Bun/OpenTUI dependencies out of public client types. Define schema ownership so input validation, typed clients, transport adapters, and API documentation agree.

The public API must support these operation families:

| Family | Required operations and results |
| --- | --- |
| Vault and notes | Capabilities/status; paginated/filterable listing; read full note or selected content; create; append; targeted edits; update properties/tags/aliases; rename/move; archive/unarchive. |
| Obsidian structure | Typed frontmatter and raw Markdown; heading outline; explicit block IDs; heading/block references; tags and aliases; wikilinks and standard Markdown links; embeds/attachment references; callouts and tasks with source locations. |
| Retrieval | Lexical/semantic/hybrid search; note/property/tag/folder filters; bounded context bundles; grounded ask and brief; exact source references and freshness. |
| Correlation | Backlinks/outgoing links; approved and proposed typed relationships; compare selected notes; correlate a note with the vault; graph neighborhood/path lookup; explanations and evidence. |
| Changes and history | Preview change set; apply authorized change set; inspect/approve/reject proposals; retrieve mutation history; guarded undo. |
| Pipelines and jobs | List pipeline definitions/configuration; validate/update policy; run/preview; list/inspect jobs; pause/resume/cancel/retry; subscribe to progress/results. |

Use canonical vault-relative paths and an explicit content revision, such as a SHA-256, for note references. Explicit Obsidian block IDs retain their meaning. Headings without IDs require unambiguous selectors; duplicate headings must not cause edits to the first arbitrary match. Define how source ranges, indexed revisions, and stale citations are represented. Ordinary note reads reflect current files; retrieval must detect or clearly label index lag and never present mismatched source bytes as current evidence.

All write requests carry revision preconditions and idempotency keys where replay could repeat an effect. Use a consistent result/error vocabulary for conflict, denial, unavailable inference, pending approval, cancellation, and partial multi-note application. Specify paging, result bounds, correlation IDs, and long-running job handles. Distinguish model-free reads, model-assisted computations, and mutations in the contract.

Build a small synthetic vault covering duplicate filenames/headings, frontmatter, aliases, CRLF/BOM, fenced code, block references, callouts, tasks, attachments, an inbox, an archive, related and unrelated notes, an actual contradiction, and questions without evidence. Use it throughout the sprint.

Done when the operation matrix is documented, schemas and typed interfaces exist, existing read operations use the canonical boundary, and contract tests exercise real Markdown examples. A types-only facade is not completion of the later API tasks.

**N02 — Make the daemon reliable during downtime and model outages**

Implement startup reconciliation of additions, edits, deletions, exclusions, and renames against stored paths/revisions, accounting for watcher events during the scan. Do not require a manual awaken to catch offline changes. Preserve note bytes. Ensure interrupted indexing and pending model-dependent work resume with bounded retries rather than relying on another editor save.

Start core storage, file access, structural indexing, and lexical retrieval with an unavailable or not-yet-configured model. Expose capability-specific readiness; model failures must not make all local operations inaccessible. Reconcile the existing tier behavior with the durable job work in N05 so there is one owner of deferred work.

Replace the unconditional four-hour idle exit with explicit lifecycle behavior appropriate for persistent background use. Ship user-service install/status/uninstall for Linux/WSL with systemd and macOS launchd, with a documented explicit-start fallback when a service manager is unavailable. Service setup must be idempotent and preserve an already running vault owner. Use monotonic elapsed time for durations and finalize jobs correctly despite wall-clock adjustment.

Done when automated tests prove offline add/edit/delete catch-up, edits during startup, endpoint outage/recovery, crash restart, no duplicate daemon ownership, and clock adjustment. Verify the service on available platforms and record the actual platform coverage.

**N03 — Expose the Notient API as a usable local interface**

Ship an authenticated loopback HTTP API with a documented versioned namespace, streaming job/activity events, a typed TypeScript client, and an OpenAPI document. Retain Unix-socket RPC where useful. HTTP, RPC, CLI, and MCP delegate to the same domain services and mutation/policy authorities. HTTP must not become a proxy to arbitrary database SQL or filesystem paths.

Support ordinary scripts and the Obsidian plugin without requiring them to load daemon internals. Provide discovery/connection status, bounded requests, reconnect/resubscribe behavior, and an explicit cursor/recovery contract for missed events. Implement correlation, context retrieval, and comparison as actual endpoints with citations, rather than documenting future methods.

Bind to loopback by default. Authenticate every note-bearing endpoint and stream. Validate Host/Origin for the intended desktop/browser clients without allowing arbitrary websites to read a local vault. Use scoped credentials and a concrete local pairing/reconnection flow; preserve the existing principal boundary. Keep secrets out of URLs, logs, synced plugin settings, and API responses. Agents cannot grant themselves configuration or approval authority.

Account for Windows Obsidian connecting to a WSL daemon through localhost: explicit endpoint/pairing, daemon-side vault identity, and a plugin-local mapping to the matching vault. Canonical API paths remain vault-relative. Do not assume Windows Obsidian can open a Unix socket or read the daemon's Linux home directory. This does not require a native Windows daemon port.

Done when a client outside the source tree can read a structured note, search, correlate notes, preview/apply an authorized change, run a job, and receive events. Include unauthorized access, cross-vault isolation, connection loss, and event resumption tests. Record actual Windows-to-WSL validation separately from same-process tests.

**N04 — Complete structural writes, relation provenance, and stable review**

Route edits through the existing durable writer and approval/history machinery. Extend it for targeted block/heading/property edits and guarded move/archive/unarchive operations. Preserve CRLF, fences, unrelated frontmatter, aliases, heading/block targets, and bytes outside intentional edits. Archive means a recoverable move to a configured folder; permanent deletion is not required.

For moves, enumerate and preview affected inbound references, preserving aliases, heading/block fragments, embeds, and resolvable relative links. Report ambiguous targets. Multi-file effects need a recoverable journal and honest partial/conflict reporting, not a false claim of filesystem-wide atomicity. Account for an open/dirty Obsidian editor buffer; never force a reload that discards unsaved edits.

Persist every proposed relationship's rationale, evidence passages from the relevant sources, source revisions, producer, pipeline/job/configuration identity, and lifecycle. Treat citations as source references, not invented model metadata. Do not label an uncalibrated similarity or fixed constant as probability of correctness.

Generate and validate replacement proposals before reconciling their examined scope. Failure/cancellation preserves prior proposals. Stable identities prevent duplicates across retries. Rejections survive refreshes and suppress the same suggestion for unchanged source revisions; meaningful new evidence can produce an explicitly new revision. Source changes make a proposal stale until revalidated. Recheck revisions and current permission immediately before applying effects.

A person's explicit Apply click on an exact preview authorizes that bounded change; do not add redundant conversational confirmations. Agent writes and background effects obey their configured authority and approval policy.

Done when contract tests and the public API demonstrate structural edits, archive/unarchive, reference-aware moves, editor conflicts, crash/retry recovery, stable proposals, rejection retention, evidence persistence, and guarded undo.

**N05 — Implement configurable pipeline execution and durable jobs**

Replace hardcoded autonomous scheduling with a finite registry of built-in, hand-tuned pipeline definitions. Each definition declares purpose, supported input selectors, stages, model requirements, typed outputs, potential effects, defaults, and configurable parameters. Avoid an arbitrary DAG builder, plugin scripting engine, or prompt-only general agent.

Each pipeline can run explicitly on selected notes/folders or according to a separately enabled background policy. Expose all of the following through the API, CLI/TUI, and Obsidian settings:

- Background enablement, permitted triggers (save, defined idle period, or scheduled interval), debounce/cooldown, and allowed operating windows/timezone.
- Read scope, write scope, excluded folders/tags, configured destination folders, and allowed property/section targets.
- Effect policy: report only, stage proposals, or apply only the explicitly allowed effects. New-note creation, property changes, body changes, relationship application, and archive/move are separately selectable.
- Per-run note/candidate caps, model-call/token budgets, time limits, concurrency, retry limits, and priority. Enforce budgets at execution, including fan-out/retries; identify estimated versus provider-reported usage.
- Preview/run-now, pause/resume/cancel, last/next run, current work, failures, changes made, proposals awaiting review, and an explanation of why a job ran or was skipped.

Fresh configuration enables structural watching/indexing only. Guided setup visibly offers a recommended background preset; selecting it enables the disclosed model jobs. Default AI mutation behavior is proposal-only. Once the user enables scoped automatic effects, execute them without asking repeatedly. Manual invocation remains available independently of background scheduling.

Store durable job inputs, source/configuration revisions, checkpoints, attempts, budgets, output/proposal references, and an explicit state machine. Recover interrupted work without duplicate effects. Foreground requests take priority without losing interrupted background work. A persisted global background pause, per-pipeline disable, or permission revocation prevents further unauthorized effects from queued/running jobs. Define cancellation and partial-completion semantics.

Effective permissions are the intersection of the caller's authority, vault exclusions, requested scope, and applicable pipeline policy. A general chat `yolo` setting or agent session grant cannot broaden a background pipeline's effect allowlist. Approval of a staged change authorizes that exact reviewed change through the human change API; it does not silently enable future automatic changes.

Prevent feedback loops: Notient-authored edits do not endlessly retrigger enrichment or triage. Coalesce save bursts, avoid repeating work for unchanged inputs, and bound scheduled catch-up after downtime. Use the daemon mutation journal and shared inference scheduler. Treat note content as data; model output can choose only schema-constrained proposals/effects, not new permissions or arbitrary tools.

Add a validated, revision-checked configuration update API for the human operator. Apply scheduling/permission changes promptly and atomically; preserve current configuration on error. Deployment credentials remain in the existing private deployment authority. Show any setting that requires a restart explicitly. No legacy configuration migration is required, but do not reset the owner's existing configuration without an explicit operation.

Done when configuration changes have observable execution effects, restart preserves queued work and pause state, and tests prove scope enforcement, budget limits, policy revocation, deduplication, bounded retries, cancellation, foreground priority, and absence of self-trigger loops.

**N06 — Ship the complete built-in pipeline set**

Implement every row below using N01–N05. Reuse the existing extractor/linker/search/distillation components where sound. Give each pipeline purpose-specific prompts, structured output validation, retrieval/input bounds, and deterministic postprocessing. Empty results and abstention are valid when evidence is insufficient.

| Pipeline | Required outcome |
| --- | --- |
| Index and extract | Current structure, embeddings where configured, concepts/claims/questions with exact evidence. Deferred model stages resume after outages. |
| Enrich notes | Suggest/apply summaries, tags, aliases, or configured properties/sections. Preserve authored material and unrelated properties. Show the reason for suggested metadata. |
| Relate notes | Retrieve relevant candidates and propose typed connections with a concrete explanation and passages from both sides. Also support explicit comparison/correlation of selected notes. |
| Find contradictions | Retrieve potentially conflicting claims across relevant historical notes. Distinguish temporal change, differing assumptions, and genuine contradiction. Show both claims and evidence; abstain from unsupported judgment. The last 20 claims alone are insufficient. |
| Synthesize and create | Produce a useful cited draft note or map of content from selected or retrieved sources. User-configured templates/destinations govern new files. Use actual content; a relation named synthesizes is not this pipeline's output. |
| Process inbox | Process a configured inbox in bounded batches: classify, enrich, relate, suggest destination, and optionally create derived notes. Stage a reviewable change set or apply only allowed effects. Do not mark an item processed before its required effects actually succeed. |
| Review for archive | Recommend eligible notes for archive using configurable criteria and supporting context. Explain why, preview link/path effects, and archive only under a matching explicit policy. Age alone must not be presented as proof of irrelevance. |

Each row needs a live API invocation, background execution, visible configuration, meaningful success and abstention examples, proposed-effect preview, failure behavior, and tests. No placeholder cards, paths-only reasoning, fixed success responses, silent skips counted as success, or renamed old workers counted as completed pipelines.

Done when all seven families run end to end against the synthetic vault and their behavior is exercised with a real configured model where available. Preserve raw validation outcomes and disclose unavailable live-model checks. Do not tune to a single happy-path fixture while ignoring irrelevant/conflicting inputs.

**N07 — Build the official Notient Obsidian desktop plugin**

Add a clearly separated first-party plugin package, for example `integrations/obsidian/`, including `manifest.json`, `main.js` build, `styles.css`, required version metadata, installation instructions, and release ZIP. The existing `plugins/notient/` contains agent integrations; do not conflate it with the Obsidian plugin. Verify supported Obsidian APIs and submission requirements against current official documentation.

The plugin is a client of the daemon API. Keep its build independent of Bun-only code and the root OpenTUI JSX configuration. Use Obsidian APIs for views, commands, native note opening, source navigation, Markdown rendering, settings, and event cleanup. Dispose subscriptions on unload/reload. The daemon keeps working when Obsidian closes.

Implement a polished, resizable right-sidebar workspace with these destinations:

- **Note:** follows the active note; shows meaningful properties, outline, extracted questions/claims, freshness, and pipeline actions on the note or selection.
- **Connections:** approved and proposed relationships, explanations, side-by-side source excerpts, comparison, and navigation to exact headings/blocks.
- **Review:** a unified queue of relationship, metadata, new-note, inbox-routing, and archive proposals with source evidence, readable diffs, approve/reject, and explicit stale/conflict states. Batch review shows its concrete scope and results.
- **Activity:** active/queued/completed/failed jobs, progress, reason for execution, resource use, cancellation/retry, and visible global background pause.
- **Ask/Search:** quick retrieval and grounded answers with clickable citations and useful structured context, available without displacing note inspection and review.

Provide a real pipeline settings interface: enabled state, schedule, scope, destinations, effect permissions, budgets, preview/run-now, and last/next run. A raw JSON editor alone is insufficient. Explain permissions in ordinary language. Distinguish processing a note from being authorized to change it.

Use Obsidian's theme variables and typography, compact readable spacing, native-feeling controls, restrained color, keyboard navigation, and accessible focus/labels. Work in light/dark themes and narrow sidebars. Show actionable empty, loading, disconnected, model-unavailable, cancelled, stale, and conflict states. A disconnected daemon must leave the plugin useful for diagnosis rather than rendering an empty panel. Render Markdown safely using supported host facilities. The active note and your existing authored content remain visually primary.

Provide commands for opening the sidebar, searching, running a pipeline on the current note/selection, opening review, and pausing background work. Handle rapid active-note changes without displaying the previous note's result as current. Pair with the matching vault and respect local editor revisions/dirty buffers.

Done when the built artifact installs into a disposable Obsidian vault and demonstrates API connection, active-note inspection, cited search, multiple pipeline results, diff review/apply, settings changes, job control, and reconnect. Capture screenshots or recordings from the actual plugin where an Obsidian runtime is available; component tests and browser previews alone do not prove host integration. Record any unavailable host/platform verification explicitly.

**N08 — Bring CLI, TUI, and MCP to the same product contract**

Expose structural read/write/search/correlation, pipeline invocation, job inspection, and relevant controls through composable CLI commands with documented machine output. Add background configuration and review/job access to the TUI. Extend MCP for the note API and pipeline/job operations appropriate to a visiting agent's granted authority.

Humans retain administration and approval authority; publishing a control through MCP does not entitle an agent to broaden its access. Preserve correct stdout framing, bounded context responses, reconnect behavior, and no blind mutation replay. A client can discover capabilities instead of guessing which model or pipeline is available.

Update agent integration instructions to favor bounded source/context retrieval when the visiting agent already has its own reasoning model, while preserving locally synthesized answers as a supported operation. Verify the same operation through HTTP, CLI, and MCP reaches the same source revision, proposal/effect policy, and history record.

Done when public-surface tests cover equivalent reads, structural changes, relationship proposals, pipeline jobs, and denial/conflict semantics, and existing useful CLI/TUI behavior remains available through the final documented command set.

**N09 — Validate usefulness, integrity, and the complete product workflows**

Create a compact evaluation pack with known source references, related/unrelated note pairs, genuine and apparent contradictions, expected enrichment, synthesis coverage, inbox outcomes, archive exclusions, and unanswerable questions. Record model/endpoint configuration without secrets. Separate deterministic correctness tests from model-quality observations.

For every pipeline, include at least two useful positive cases, two cases requiring abstention/no change, one provider/interruption failure, and one stale-source or permission-change case. Fix the expected source evidence before tuning. Citation references must resolve to the recorded source revision; fabricated sources, unauthorized changes, lost authored bytes, or duplicate effects fail acceptance. Assess the substance of explanations and synthesized notes as well as schema validity. Report relevance and usefulness separately rather than treating valid JSON or an LLM judge's score as proof of quality.

Complete at least these cross-surface scenarios:

1. Edit in Obsidian, index the change, see enrichment and relationship proposals, review/apply, and retrieve the updated context through MCP.
2. Run comparison and synthesis live on selected notes; inspect cited passages; create a draft through the normal change API.
3. Configure inbox processing with a bounded automatic metadata policy and approval-required moves; observe both behaviors and accurate completion state.
4. Run archive review, inspect justification/reference changes, archive and unarchive safely.
5. Shut down, edit/add/delete files, restart with inference unavailable, retrieve local context, restore inference, and observe deferred work complete.
6. Interrupt a multi-effect job; restart and retry without duplicate files, duplicated appends, lost proposals, or unauthorized post-revocation changes.

Measure retrieval/answer latency, background throughput, resource use, citation correctness, useful versus noisy proposals, and abstention. Report poor results plainly and improve their causal pipeline issues. Do not claim a week of owner use from a short automated run or claim model quality from mocked responses.

Run the existing typecheck, lint, unit, full integration, build, and package checks plus new API/plugin/evaluation checks appropriate to the final tree. Reproduce and fix failures rather than relabeling them. Run the final complete integration pass after relevant source changes. Real-model/desktop tests require available runtime evidence; unmet checks remain visible release blockers or explicitly unverified platform coverage, never fabricated passes.

Done when the implementation supports all scenarios and the release ledger distinguishes verified results, failures, and external validation still needed. No required feature may be deferred merely to make the version label attainable.

**N10 — Finish v0.1.0 installation, documentation, and release artifacts**

Implement or improve guided setup and `notient doctor`: discover/select a vault, diagnose Bun/SurrealDB/endpoint prerequisites, configure one working reference model setup, preview/enable a background preset, install a service, pair the Obsidian plugin, and display a clear next action. Credentials stay private. Core setup works even before inference is available. Verify installation from the actual built tarball outside the source checkout, including external/native TUI dependencies.

Update runtime/package/plugin versions coherently to `0.1.0` only with an honest release ledger. Provide daemon/CLI package, typed client/API documentation, OpenAPI output, Obsidian plugin ZIP, agent integration artifacts, changelog, supported-platform matrix, and clean-install instructions. Check public package/tag names before any publication. Do not overwrite existing release tags.

Extend CI to cover changed domain code, HTTP/client contracts, plugin typecheck/build, generated artifacts, package contents, and real-Surreal integration. Keep live-model and interactive-host evidence distinct from ordinary CI.

Build a small static website for notient.org: the note-centered product explanation, a real plugin/pipeline demonstration, install instructions, API and pipeline documentation links, local-inference versus MCP-host data boundaries, and release/download links that match actual artifacts. Use the frontend-design skill if available; make the page coherent with the product. No hosted application backend is needed.

Prepare exact publication commands/assets and a concise final release report. Push, publish packages, submit the plugin to Obsidian's community directory, or deploy the website only when those external actions are authorized in the session. Complete all locally actionable work before requesting that final authorization. Distinguish first-party plugin artifacts, a submitted directory entry, and approval by Obsidian. External publication or host validation still pending means the release is not publicly complete.

**Final response required from the coding session**

Report completed task IDs; how to install and use the resulting product; API/client examples; each pipeline's actual behavior and defaults; Obsidian screenshots/artifacts where verified; exact test outcomes; remaining limitations or blockers; and prepared/published release artifacts. Link to the updated sprint ledger and release report. Do not end with “I can implement this next.” Execute the work and state its actual completion status.
