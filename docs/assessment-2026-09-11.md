# Notient assessment — 2026-09-11

Assessment of local commit `856f290`, prompted by the owner's return to the original thesis: Markdown notes are durable context; local, asynchronous AI helps that context develop and makes it useful to people and visiting agents. This is a private tool approaching its first useful release. Existing-user compatibility, migration frameworks, and commercial platform scope are not requirements.

Scope update, 2026-09-12: the owner requires a complete note-centered API, multiple configurable pipelines available live and asynchronously, and an official Obsidian desktop plugin with a right-sidebar workspace for v0.1.0. The narrower release recommendations below remain historical; the [v0.1.0 coding sprint prompt](notient-v0.1.0-sprint-prompt.md) supersedes their scope. The findings and recorded verification remain evidence about the assessed checkout.

**Recommendation: keep the current foundation and complete a smaller daily-use loop.** The repository already implements most of the necessary surfaces. Its most consequential gaps are background continuity, the evidence behind discoveries, and the route from checkout to an installed tool. Another architecture reset would defer those outcomes.

The proposed first-release promise is: “Keep writing in Obsidian. Notient catches up in the background, offers a few useful discoveries with supporting passages, and lets you or an authorized agent retrieve the relevant context. Changes to your notes remain reviewable.”

The success criterion is repeat usefulness to the owner. Growing the number of graph edges, extracted claims, commands, or tests does not establish that usefulness.

**What exists today**

| Capability | Current implementation | Assessment |
| --- | --- | --- |
| Markdown and Obsidian integration | Filesystem adapter, Markdown parser, frontmatter, wikilinks, block references, watcher | A sound foundation; Obsidian need not be running. |
| Per-vault runtime | Bun daemon, Unix socket, daemon-owned SurrealDB child, local state directory | Appropriate separation from the editor; continuity needs correction. |
| Indexing | Parsing, chunking/embeddings, extraction, linking, resumable explicit awaken runs | Substantial implementation with real database tests. |
| Background discovery | Linker, Synthesizer, ContradictionHunter, MaturityAdvancer, idle coordinator, shared inference scheduler | Present, but the evidence and persistence contracts need work. |
| Personal recall | Lexical, semantic, and graph-assisted search; ask; brief | Implemented. Quality and latency on the owner's present workload remain unmeasured in this assessment. |
| Human interface | OpenTUI Home, Inbox, Explore, Ask, Stream; CLI | Already sufficient surface area for the first release. |
| Headless access | CLI JSON/NDJSON and local daemon RPC | Implemented. |
| MCP | Stdio adapter, 15 tools, resources, recall prompt, plugin metadata | Implemented over the same daemon. Nine read tools and six write/proposal tools. |
| ACP / A2A | No implementation | No demonstrated first-release need. MCP already covers consulting and contributing to the vault. |
| Packaging | Build, package allowlist, executable bundle, local link workflow | Buildable and packable; public delivery remains unfinished. |

The source tree contains approximately 62,901 lines across 248 TypeScript/TSX/SurrealQL files, with approximately 68,749 lines under testing, including fixtures. That is a substantial maintenance surface for one person's tool. The response should be to concentrate changes and freeze peripheral features, rather than commission a general cleanup of every module.

The architectural separation is worth retaining: files hold authored content; the daemon owns shared services and writes; the database supports retrieval and graph operations; CLI, TUI, and MCP adapt those services. Guarded note writes, approval previews, history, path containment, and byte-preserving edits directly serve the owner's trust in the tool. They should remain.

**Findings that affect daily usefulness**

1. **The daemon does not yet provide continuous guardianship.** [The daemon](../src/daemon/index.ts) has a hardcoded four-hour idle exit. Socket traffic and indexer activity refresh the timer, and an explicit background awaken prevents exit, but a quiet vault can eventually lose its watcher. There is no shipped systemd/launchd service installation. [Watcher startup](../src/daemon/watcher.ts) uses `ignoreInitial: true`; ordinary daemon startup does not reconcile the current public files against the stored paths and content hashes. Recovery of already-recorded tombstones and embedding-repair flags does not cover arbitrary edits made while stopped. A temporary-vault probe changed one note and created another while the watcher was stopped: restart enqueued neither. A subsequent online edit was detected, establishing that the watcher itself was running. Fix startup reconciliation and persistent service behavior before relying on unattended use. Reconciliation must also account for offline deletions and events arriving during the scan.

2. **The local context service depends on successful model discovery to start.** [Bootstrap](../src/daemon/bootstrap.ts) awaits chat and embedding catalogs before bringing the runtime online. A missing or unreachable configured endpoint therefore prevents a cold start of functions such as local note access and lexical search. The existing embedding inference probe has a fallback, but that happens after catalog discovery. Separate core availability from inference availability: start the database, file access, watcher, and lexical retrieval; show inference as unavailable; retain pending embedding/extraction work and retry when the endpoint returns. This is useful behavior on a laptop or a home network, without introducing provider compatibility layers.

3. **Autonomous proposals lose their explanations and supporting evidence.** [Linker](../src/core/agents/linker.ts) retrieves supporting chunks and requests a rationale, but its `relateEdge` call supplies neither evidence references nor rationale. [Synthesizer](../src/core/agents/synthesizer.ts) and [ContradictionHunter](../src/core/agents/contradictionHunter.ts) similarly request an `evidence` string and discard it. A real-SurrealDB probe generated one Linker proposal and read the stored row: it had neither evidence nor rationale. The Inbox is wired to display evidence, so this missing data reaches the review experience. Persist a short explanation, supporting passages from the relevant notes, and source revisions. Make those facts the central review card. Display similarity/ranking measures as such; the current percentages are not calibrated probabilities of correctness.

4. **A failed refresh can erase previously pending discoveries.** These workers delete their old pending proposals before retrieval/model execution succeeds. The deletion helper can clear edges touching either end of a note, and the contradiction worker clears its own pending contradiction edges vault-wide before considering its latest limited claim sample. In a real database probe, one existing Linker proposal became zero after an injected provider outage. Generate and validate replacements first, then atomically reconcile only the scope actually examined. Preserve earlier discoveries on failure, cancellation, or unrelated work. A person's review queue needs stable contents and identities.

5. **Some cognitive features are weaker than their names suggest.** The dedicated Synthesizer's model prompt contains the active path and candidate paths, with no note bodies or evidence snippets. The captured prompt confirmed this; the worker proposes a `synthesizes` edge and does not itself produce a substantive synthesis note. The contradiction worker inspects at most the 20 most recently asserted claims by default, which provides very limited historical coverage. Its fixed confidence is `0.85`; the Synthesizer uses `0.8`. The Linker does receive actual content, and query-time deep synthesis is a separate implementation. Concentrate first on making the content-grounded Linker excellent. Treat the other autonomous workers as experimental until their evidence and quality justify routine use. Maturity, word counts, and connectivity can be useful metadata, but they do not establish the value or truth of a note.

6. **Wall-clock adjustment can fail a completed worker.** The full integration run failed once because [AgentRunExecutor](../src/core/coordinator/agentRunExecutor.ts) rejects a finish clock earlier than the start clock, before finalizing the run. Production supplies `Date.now`. The failing five-test file passed on a focused rerun. This establishes an intermittent failure and a concrete sensitivity to a backward clock; this assessment did not identify the operating-system cause of that clock movement. Use monotonic elapsed time for durations and ensure run finalization survives wall-clock correction.

7. **The public repository does not contain the local release candidate.** Read-only `git ls-remote` showed GitHub `main` at `323949c`, 159 commits behind the assessed local HEAD. `v0.1.0-alpha.1` exists locally and was absent from the remote result. The public npm registry returned 404 for `notient` and its latest-version endpoint. `https://notient.org` returned a Hostinger parked-domain page. Consequently, following the current clone instructions obtains an older tree. The August release report's pending-tag status is also stale relative to local state. These observations establish delivery status; nothing was pushed, published, or deployed during this assessment.

**Bound the architecture and the first release**

Keep Bun/TypeScript, SurrealDB, the per-vault daemon, and the shared CLI/TUI/MCP runtime for this cycle. SurrealDB creates real installation and process-management costs, but the implementation depends on its full-text, vector, graph, and transactional capabilities throughout. A database replacement would be a substantial project. Revisit it only if installation, memory use, or recovery proves unacceptable in the private pilot, with measured evidence.

Make the distinction between three kinds of state explicit: authored Markdown; rebuildable indexes and machine inference; human decisions and audit history. Markdown survives a database reset, but a rebuild does not reconstruct every rejection, approval attribution, or history receipt. Decide which of those decisions the owner wants retained, and give that small set a portable representation or export if needed. Do not promise that all state is reconstructible from notes. Do not build compatibility machinery for hypothetical users.

Use one chosen local chat/embedding setup as the documented reference and one supported OS environment for release acceptance. The present Linux/WSL environment is an available starting point. Retain the compatible endpoint boundary, but avoid turning every possible model server into a release obligation. Keep privacy language precise: local inference can keep Notient's own processing local; an authorized cloud-backed MCP host can receive requested note content. Same-account agent identities provide attribution and policy, not an OS sandbox against arbitrary shell access.

Freeze expansion into ACP, A2A, native Windows, another editor plugin, a separate web app, extra autonomous roles, and additional graph export formats until the daily loop earns its place. Keep the existing safety-critical write machinery. Leave advanced database backup/restore and configuration details in operator documentation rather than making them the first-run experience.

**Proposed sequence, with observable completion conditions**

| Order | Work | Done when |
| --- | --- | --- |
| 1 | Make background operation dependable | Starting after downtime catches additions, edits, and deletions without a manual awaken. Core local reads and lexical search work with inference unavailable. Deferred work resumes. A service on the chosen OS stays available through quiet periods and restarts. Wall-clock correction cannot strand a run. |
| 2 | Make one discovery worth reviewing | A proposed connection contains an explanation and supporting passages tied to source revisions. Provider failure leaves the queue intact. Approval previews the concrete file change; an intervening editor change is preserved or produces a clear conflict. A rejected suggestion does not immediately return unchanged. |
| 3 | Establish usefulness on an owner-selected vault | Use the tool for a week. Record useful discoveries, rejected/noisy suggestions, missed expected connections, recall results, response latency, and inference workload. Use a small fixed set of questions with known source notes and several deliberately unanswerable questions. Compare the useful result with the existing Obsidian/direct-search workflow. |
| 4 | Finish one installation and publication path | A fresh environment installs a versioned package, selects a vault and one reference inference setup, diagnoses unavailable prerequisites, and produces its first useful result without reading architecture documentation. CI checks build and package contents as well as source tests. The tested commit, public source, tag, package, and instructions agree. |
| 5 | Publish the small website | One static page on notient.org explains the benefit, shows a real discovery/review example, provides working install instructions, and states the local-processing and MCP boundaries accurately. No accounts, backend, or web application are needed. |

For setup, evolve `init` or add one guided setup command and a `doctor` command. Present what is ready, what is missing, and the next action in ordinary language. The owner should not have to learn three indexing tiers, a database lifecycle, and the distinction between deployment and product settings to obtain a first result. Preserve advanced CLI commands for troubleshooting.

For the agent workflow, lead with retrieving bounded context and cited passages through the existing MCP surface. The visiting agent already has a reasoning model; routing every lookup through Notient's own full answer loop can add unnecessary latency. Keep `ask` available when a locally synthesized answer is useful.

The first demo should show the full value loop: write a note in Obsidian, leave Notient running, receive one useful connection with evidence, review the exact Markdown change, then retrieve the resulting context through either the terminal or an agent. That demo can drive product decisions, acceptance, and the website.

**Verification performed for this assessment**

Environment: Linux x86_64, Bun 1.3.10, SurrealDB 3.0.5. Source code was not modified. Generated `dist` bundles were rebuilt. Temporary fixture probes used local SurrealDB and deterministic model responses; their fixtures and database children were cleaned up.

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed. |
| `bun run lint` | Passed; 490 files checked. |
| `bun run test` | 2,514 passed; 0 failed; 7,090 assertions. |
| `bun run test:integration` | 409 passed; 1 failed; 410 tests across 57 files, 224.92 seconds. Failure: worker finish clock precedes start clock. |
| Focused `tier23.smoke.test.ts` rerun | 5 passed; 0 failed. Does not retroactively turn the full-suite result green. |
| `bun run build` | Passed. |
| Generated CLI version and help | Passed; reports `0.1.0-alpha.1`. |
| `bun pm pack --dry-run --ignore-scripts` | Passed; 50 files, 13.86 MB unpacked. This is package-content validation, not a new clean-install test. |
| Real database discovery probes | Confirmed missing saved evidence/rationale and loss of a prior pending proposal on model failure. |
| Captured synthesis input | Confirmed paths-only model prompt. |
| Real filesystem watcher probe | Confirmed offline add/edit are not enqueued on restart; online edit is enqueued. |
| Public delivery checks | Remote main is older; alpha.1 tag local only; npm name returned 404; domain parked. |

Detailed command logs and the temporary probe script were retained under `/tmp/notient-assessment-*` for this session. The existing [August release report](release-2026-08-30.md) contains historical real-model, 940-note-vault, TUI, and external-agent evidence. Those results were read as historical evidence, not rerun or counted as current passes. This assessment did not benchmark current model quality, run the live-endpoint smoke scripts, interactively inspect the TUI, or alter the owner's real vault. The existing untracked `history.txt` was left untouched.
