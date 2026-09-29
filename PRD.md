# Notient: the daily home for a living vault

Product definition, September 28, 2026. This is the user-facing contract for the 0.2.0 Sentient Notes work. `SPRINT.md` remains the sole active implementation plan and observation record. Historical plans explain how Notient arrived here; they do not add requirements to this document.

## The product in one sentence

Notient is a terminal home where a person can think with their Markdown vault, save what matters, and return to notes that have grown more useful through evidence-aware, bounded cultivation.

The note is the unit. A conversation can be exploratory and disposable; it does not have to become a note. When an insight is worth retaining, it belongs on the relevant note with its origin, support, qualification, and relationships. An ordinary Markdown reader must recover that understanding without Notient. AI visits the vault to help develop it. It does not own the writing or grant itself authority.

The founder's “city of intelligent notes” and “GDP of the vault” ideas come from the September 28 spoken direction for this PRD. Notes are residents, links and supported relationships connect them, cultivation is maintenance and learning, and a small daily digest is the public square. The older owner interview expressed a sequence: vaults that breathe, notes that think, knowledge that evolves. The interface should use these metaphors sparingly. It should show useful changes and honest health signals, not a simulation, a feed of jobs, or a score that mistakes word count for intelligence.

## Who it is for and why they return

The first user is a person with an existing, messy Markdown vault who works in a terminal and wants help remembering, connecting, developing, and correcting ideas without surrendering authored prose. The same knowledge must be available to explicitly authorized clients, including coding agents, through CLI and MCP. An agent-owned vault is a second supported journey: its owner grants contributors limited access, retains attributed experience on notes, and can inspect or change its own methodology without claiming authority over a human's vault. Obsidian remains a companion editor, not a second product that must be learned to use the first.

On a good day, the person opens `notient`, gets back to their conversation or starts one, captures a rough thought without choosing a taxonomy, inspects a source behind an answer, and sees at most a few worthwhile developments from the vault. They can say “that is unsupported” or “not now” and see the correction matter later. They can leave without learning about a daemon, database, index tier, graph edge, or pipeline job.

The promise is **less repeated investigation and better notes**, rather than more generated notes or more activity. “Nothing new worth surfacing” is a successful daily outcome when that is what the evidence supports.

## The default journey

### 1. Open

Typing `notient` in an interactive terminal opens the workspace for the known vault. With no known vault, it offers a short, understandable path to select or set one up. `notient --vault <path>` opens that vault; a missing or uninitialized path gets a specific remedy, not an `INTERNAL` error. The runtime starts and stops as needed without becoming an onboarding concept.

The first screen is a focused conversation, not a health dashboard. It identifies the vault and gives three obvious actions in ordinary language: **ask**, **capture a thought**, and **find a note**. A compact developments strip shows up to a few grounded changes or an honest “nothing new worth surfacing”; it is visible beside the conversation, not hidden behind an administrative view. A small status line says whether local reading/search is ready, whether model-assisted work is available, and whether cultivation is paused. It also makes the conversation state clear: resumed thread, new thread, and how to switch. A returning user can continue immediately; a new user sees one or two examples that work with their actual vault rather than a fabricated demo.

Local reading, capture, and lexical search remain usable when inference is absent. The UI says what it can do now, not simply “disconnected.” Model setup is offered at the moment it would help and never blocks model-free work.

### 2. Think, without being forced to file

The composer accepts a question, a rough idea, a comparison, or an instruction to develop a thought. A chat turn is conversation history, not automatically an authored note or a factual finding. Notient can show exact saved passages and their freshness before an answer finishes. It distinguishes what a source says, what it infers, and what remains uncertain. It never says it searched or changed a note unless a tool actually did so.

A result offers a direct next step: open the source, keep an answer on a note, capture the original thought, or request a concrete reviewed change. The person can return from a source without losing their draft, selection, or conversation position. Long model replies and tool chatter should not bury the evidence or the next useful action. Fast and slow models both get a calm working state and legible progress.

### 3. Capture and develop

Capture preserves the person's original words before a reasoning model responds. An autosaved private draft is labelled **draft**, not **saved note**. One explicit save action should create a note in a sensible default inbox and confirm its path; choosing another destination or previewing more detail remains available. The person need not decide a folder, role, or template before getting the thought down. Notient may later propose a better home, connections, questions, or a distilled note. It must retain the origin and avoid turning a rough assertion into established knowledge. The TUI now saves a new capture in one action; independent cultivation requires an enabled, scoped save trigger.

An explicit “keep this” action should move a useful conversation result into note-resident understanding, with evidence and attribution. If the person only wanted to think aloud, leaving the conversation does not create a note. Creating and editing notes are first-class flows. Moving, archiving, and deleting are concrete previewed changes with conflict protection and recovery. The TUI now offers a reviewed, clearly unverified answer addition to an open note. Turning that raw answer into supported retained intelligence remains a separate step. Reviewed deletion moves a note to Trash with undo and qualifies dependent retained understanding; it is available from the note editor, action palette, and slash help, and only a human caller can apply it.

### 4. Let the vault grow, then review

Cultivation studies new input, changed evidence, active work, and unresolved questions within a visible budget and scope. Fresh installation starts safely; the person can choose and later change the scope that permits background work. The system can enrich designated intelligence sections with support and attribution. It asks before changing authored prose, making substantive corrections, moving, or deleting. Any future broader grant must explicitly name its effect and scope; existing grants do not imply delete authority.

The daily surface offers a small number of developments with a reason to care, a note destination, and exact evidence. Each item says whether it was retained, is provisional, awaits review, was deferred, or was rejected. A correction is not a dismissal button: “false,” “unsupported,” “irrelevant,” “already known,” and “not now” have different effects on future suggestions. Changed supporting evidence can reopen a conclusion; unchanged rejected suggestions should not return in new words. Lexical suppression exists, but semantic non-repetition after a rephrased rejection is not yet proven.

The review surface shows the proposed Markdown effect and its evidence, not a call ID or graph-row ID. Approval, refusal with reason, and return to the conversation are direct actions. Concurrent edits and dirty Obsidian buffers must be protected. Undo and partial-failure states must tell the truth about what happened.

### 5. Revisit and share understanding

Opening a note shows its authored thought and its retained intelligence together, with sources, relationships, questions, and qualifications intelligible in Markdown. Notient can add navigation and a concise “what changed” view, but those are views onto the note, not a separate truth store. A later conversation or authorized agent retrieves the corrected context without redoing the investigation. When a supporting source changes, dependent understanding becomes visibly stale or is reconsidered.

Agents and clippers may contribute experiences and claims within grants. Their identity is attribution, not proof. A read-only client may challenge a finding; it may not silently rewrite prose or promote itself to owner. A human or agent owner can select conventions, including PARA/FLAP, custom guidance, or AI-managed organization; Notient infers overlapping note roles without treating a folder as a constitution. It may recommend a new structure, but a substantive move still follows review or an explicit grant. CLI, MCP, TUI, Obsidian, and HTTP/SDK must agree on source revisions, authority, and reviewed effects.

## Interaction requirements

| Surface | Primary behavior | Advanced behavior |
| --- | --- | --- |
| Conversation | Ask, develop, resume, inspect evidence, keep a result, or leave it as a conversation. | Activity details and model options available on demand. |
| Capture | Save original words quickly with a visible destination. | Change destination, apply a convention, or request a developed draft. |
| Notes | Find, read, follow sources and relationships, see what is retained and uncertain. | Inspect revision, provenance, structural suggestions, and detailed vitals. |
| Daily developments | A few grounded changes or an honest “nothing today”; clear pause/scope state. | Jobs, budgets, scheduling, and diagnostics in a secondary surface. |
| Review | Read a concrete proposed effect, approve or reject with a reason, return. | Conflict detail, history, and guarded undo. |

The command palette and `/help` must describe the same user actions. Raw IDs, JSON requests, jobs, graph table names, and database terms belong in advanced CLI/API help. Capture needs an alternative to Ctrl+B, which tmux commonly intercepts; saving needs an alternative to Ctrl+S where terminal flow control intercepts it. A visible palette route must always exist, including in a narrow terminal where the current hint bar can hide Ctrl+P. Search results and note references are selectable rather than forcing a user to type vault-relative paths from memory. Errors name the user's next useful action.

An automatically started runtime may remain briefly after the TUI closes and must exit when idle; active, authorized cultivation may continue within its budget. The workspace should disclose whether work continues after exit and offer a direct pause/stop route. A deliberately installed persistent service is a separate operator choice.

## Vault health without vanity metrics

Health means the vault is **usable and honest**: current note/index coverage, source freshness, meaningful unresolved questions, pending reviewed changes, background scope, and model availability. The default view describes these conditions in plain language. It does not equate more edges, tokens, words, notes, or model calls with growth.

Per-note vitals may help diagnose maintenance. They must not be presented as a measure of understanding until they reflect evidence, qualifications, corrections, and usefulness. Existing health and maturity calculations are structural heuristics, so any current score needs that label. The founder's city analogy can guide a future overview, but a “GDP of the vault” would be misleading unless it measures actual knowledge recovered or work advanced.

## The proof of value

The defining end-to-end scenario uses a narrow, explicitly authorized scope in the real messy vault:

1. Capture a rough thought and add a real source without losing either original.
2. Let bounded cultivation independently surface a useful, evidence-backed development: a supported connection, a qualified question, or a retained source-grounded summary. A note needing no enrichment should produce an honest no-write result, not a manufactured finding.
3. Retain supported understanding on the relevant Markdown note or present a substantive change for review. A plain Markdown read shows the result without the runtime.
4. Reject or correct one claim with a reason. A later session and a separately authorized client retrieve the corrected understanding. To attribute non-repetition to feedback, compare a bounded case without feedback that re-proposes the claim with the same case after rejection, varying its wording. Do not count a no-suggestion rerun alone as proof.
5. Change supporting evidence. Notient marks the dependent conclusion stale or reconsiders it; it does not silently keep an obsolete assertion current.

This is the product demo and a release outcome, not a synthetic throughput benchmark. On the real vault, first rehearse the policy on a copy; then bound cross-note reading for evidence, constrain writes to designated target notes and intelligence sections, record a whole-vault before/after file inventory, and restore the prior paused state. Boot must not start an unbounded interval job before the scoped policy is active. Record actual time to useful evidence, quality of what was retained, whether the correction changed later behavior, and whether the person wanted to use it again. Also exercise no-model local work, a failed/stalled model, a conflicting editor revision, and a note that merits no enrichment.

## Current reality and priority

| Area | Current evidence | Product gap |
| --- | --- | --- |
| Terminal entry | Bare `notient` guides vault selection/setup and opens a conversation with vault, thread, readiness, and developments context. Root CLI help now leads with that experience; rapid assistant deltas are coalesced for terminal rendering without discarding transcript text. Earlier source-level entry behavior was checked in a disposable terminal. | Founder experience with the integrated build in the real vault, including fast and slow model turns, has not been observed. |
| Local work | Draft recovery, one-action capture, conversation resume, note reading/navigation, and model-free lexical TUI search are implemented in source. The capture destination and cultivation guidance now use the same Inbox policy setting. | Model-free TUI search and the aligned capture path have not been observed in an integrated live session. A fresh install has no save trigger by default; the person must review a scoped activation. |
| Review | Inbox decisions, guarded effects, reviewed move/rename, archive, and recoverable deletion now have direct TUI actions with exact previews and human apply. An answer can be appended to an open note through exact human review and labelled as unverified. | These integrated TUI actions have source/typecheck evidence but no founder dogfood run. Keeping an answer this way is not yet supported, attributed intelligence; some decision paths still expose raw IDs. |
| Note intelligence | Markdown-only reconstruction, attributed enrichment, feedback suppression, and changed-source reconsideration have bounded fixture evidence. Source assembly now supplies repeated body labels as leads for a grounded methodology comparison, and the TUI refreshes convention review state on return. | No observed complete capture-to-digest-to-correction loop on the real vault; the model-generated convention and separate activation path still needs live observation. |
| Vault health | Aggregate counts and per-note structural proxies exist; terminal labels now distinguish them from note understanding and distinguish session events from vault-wide findings. | The numbers do not establish understanding or show whether the vault saved investigation. |
| Obsidian | The previously built companion files are installed in the experimental vault. Newer source reports pairing/wakeup failures and a bounded recovery action in the sidebar and settings. | The newer source has not been installed or observed in desktop; automatic startup remains unproven. The companion remains a supporting client. |

The implementation priority is to finish the terminal note-management loop, prove the full narrow cultivation loop, and show that loop in the conversation and note views. Live model and original-vault work waits for the operator's homelab availability. Improve the existing system in place. Keep Obsidian functional, but do not make motion, an orb, or generative layouts prerequisites for this release. No wholesale database or framework replacement is justified by this PRD.

## Boundaries

Notient does not treat contributor text as instructions or human assertions as verified facts. It does not rewrite authored prose because a model prefers a different style. It does not create a note for every chat turn, run unbounded inference to look busy, conceal model failure, or infer write permission from a note's role. New coding-agent plugins, A2A, ACP, and a broad “autonomous city” presentation remain outside the 0.2.0 path in `SPRINT.md`.

This PRD describes intended behavior. Presence of code, a passing schema, or an earlier agent's recorded observation is not proof that the founder can use a complete loop today. The sprint records the direct observations and remaining implementation work.

The product definition draws on the September 28 founder direction, the September 26 owner decisions in `SPRINT.md`, the September 16 historical product review under `.nuked/pre-0.2.0-2026-09-26/planning/internal-docs/`, and the January owner interview retained in git history at `86ff584`. The current-reality table reflects source integration and bounded disposable observations where stated. It does not represent a complete live founder session.
