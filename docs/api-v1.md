# Note-centered API contract (v0.1.0 work in progress)

This document defines the target v1 boundary and records which parts are connected today. It is not a claim that all target endpoints exist. See [execution ledger](sprints/v0.1.0.md).

`src/api/schema.ts` owns note identities, selections, source references and errors. `src/api/operations.ts` owns operation inputs, change sets, scopes and pipeline policy validation. Public types contain JSON values and vault-relative paths, with no database records, Bun APIs or OpenTUI dependencies. Existing RPC wire types reuse the canonical read types. Server-side `NoteReadService` delegates file access to the existing VaultAdapter and uses the existing Markdown pipeline; clients must never import that service.

| Family | Target operations | Existing authority / implementation state |
| --- | --- | --- |
| Status | capabilities.get | Existing daemon.status, health.probe, vault.stats; `capabilities.get` advertises only implemented canonical operations. |
| Notes | notes.list, notes.read | notes.read connected to canonical current-file service. notes.list connected to a paginated live catalog with path/folder/tag/property filters; existing vault.list retains its shallow UI contract. |
| Structural writing | changes.preview, changes.apply with create, append, selected edit, properties, move, archive, unarchive | Existing notes.write, notesWriteService, approval gate, durable journal and history remain write authority. Exact persisted previews and sequential effects use the existing durable writer; reference-aware moves and guarded undo are implemented, with remaining reference-form/recovery coverage recorded in the ledger. |
| Structure | notes.read structure and selector | Frontmatter mapping/raw YAML/error, exact Markdown, headings/occurrences/sections, explicit block IDs, aliases/tags, wiki and Markdown links/embeds, callouts and tasks implemented. |
| Retrieval | search.run, context.get, ask.run, brief.run | Canonical lexical/semantic/hybrid search, bounded context and scoped grounded ask are connected. `ask.run` returns Markdown, revision-bound citations and provider usage attempts; `brief.run` provides a source-grounded overview and selected findings using the same evidence and budget authority as note comparison. |
| Correlation | notes.compare, notes.correlate, graph.neighbors, graph.path | Canonical bounded graph reads share revision checks, coverage and relationship evidence across the agent, CLI, TUI, MCP and HTTP/SDK. `notes.compare` and `notes.correlate` share bounded, read-only relationship analysis with the pipelines; they return exact two-sided quotations, limitations, abstention and provider accounting. |
| Review/history | proposals.list/get/submit/approve/reject, history.list/get/undo | Canonical review and history share the existing journal and guarded inverters. Undo retains original snapshots and durable started/completed receipts; the TUI, Obsidian, CLI and HTTP/SDK use this authority. MCP exposes read-only history. |
| Pipelines | pipelines.list/validate/configure/run, background.pause | All seven finite families share durable execution. Revision-checked configure/validate/pause use private configuration and persisted receipts; full model-quality acceptance remains pending. |
| Jobs/events | jobs.list/get/control, events.subscribe | Canonical job inspection and revision-checked, idempotent controls share the durable JobService. Persisted ordered events and resumable SSE are connected. |

## Change history and guarded undo

`history.list` accepts optional `path`, `limit` (1–200) and snapshot-bound `cursor`. It returns metadata only, including original actor and any undo receipt; changed inventory requires reloading page one. Reads inspect at most 10,000 entries in five seconds; filter by path above that bound. `history.get {id}` returns exact saved `before`/`after` Markdown, a move destination when present, and the recorded after-image `sources`. Review bodies are limited to 2 MiB total. These are historical snapshots, not a claim about current files.

`history.undo {id, sources, idempotencyKey}` requires a human with read/admin authority and the exact recorded after revision. Revision checks and the existing filesystem compare-and-swap protect newer edits. Connected Obsidian editors guard the effect; an unsaved buffer reports `CONFLICT`. Pairing authority and cancellation are checked again after host acknowledgement, immediately before the effect. Undo preserves the original journal row and records its actor, start and completion. Retrying an interrupted undo validates the current before/after image; retrying a completed undo returns its receipt without replaying the effect. Pending receipts are excluded from retention pruning; completed undos are retained relative to their completion time. No automatic undo is triggered on restart.

Humans can inspect the vault journal; agents can inspect only their own actor's entries and cannot undo. Use **Ctrl+P → Change history** in the TUI, **Review → Change history** in Obsidian, or `notient history` and `notient undo <id>`. Each journal entry describes one file effect; a multi-file move can contain separate reference rewrites and should be reversed in reverse execution order. Historical `notes.history` / `notes.undo` routes are removed.

## Index readiness and search coverage

`graph.neighbors` returns up to 200 current-file-verified connections (50 by default), with authored/approved/proposed state, direction, relationship rationale and available revision-bound evidence. Model assessments are distinct from authored links. Historical evidence whose source revisions changed is marked stale and is not returned as current quotations. Older relationships without provenance are explicitly unavailable. `omitted`, `truncated` and index `coverage` distinguish an incomplete view from no connections. `graph.path` traverses approved/applied relationships and authored links, returning revision-bound notes and steps, with `found`, `not-found` or `incomplete`. A returned route does not promise the shortest route when traversal is truncated. Both reads enforce a 15-second deadline, 256 source-note cap, 1 MiB per note and 16 MiB aggregate read budget including final revision verification. Concurrent source edits return CONFLICT; cancelled reads return CANCELLED. No model runs or authored mutations are required.

`daemon.status.indexing` reports structural and lexical indexing readiness for the
watcher's latest observed inventory. It includes `state`, `generation`, `total`,
`current`, `pending`, `failed`, and up to five `{path, message}` failures.
`total` is null while scanning. A current note has a durable Tier 1/lexical-chunk
receipt for the exact observed source revision; a drained queue alone does not
establish readiness. Failures remain visible until a successful commit, validated
receipt reuse, or removal. States are `scanning`, `indexing`, `current`, `failed`,
`paused`, and `unknown`. Excluded notes do not enter the inventory.

Both search interfaces (quick/balanced/deep and lexical/semantic/hybrid) and
`context.get` return `coverage: {state, indexing, message}`. Coverage is `current`
only when the structural index was current at both ends of retrieval and its
generation did not change. Otherwise it is `incomplete`, or `unknown` when no
readiness observation is available. An empty result with incomplete coverage is
not evidence that the vault has no matching notes. This is a vault-wide structural
coverage report, independent of the query's result limit or narrower scope; it does
not claim that embeddings or AI extraction are complete. Per-hit source freshness
remains separate. Direct reads continue to return current filesystem content.

The CLI emits a `search:coverage` diagnostic for incomplete/unknown coverage and
includes the structured coverage in its terminal result. MCP returns it with the
search payload and summary. The TUI polls status without overlapping requests,
shows current/pending/failed counts on Home, marks stale status explicitly, and
distinguishes “No hits yet” from an empty search against a current index.

## Grounded answers

`ask.run` accepts `{query, scope, maxRoundsPerTurn?}`. It uses the same native tool loop as chat, with read-only search and bounded note tools. Scope is enforced outside model arguments. Responses contain Markdown `answer`, exact `citations` (path, revision, range, quote, score), `openQuestions`, model-reported `confidence`, retrieval `coverage`, tool summaries and provider-accounted inference `attempts`. Multiple nonoverlapping passages may cite the same note. A containing full read replaces its search excerpts. Source revisions are checked again before returning; changing notes yield `CONFLICT`.

An uncited response explicitly abstains. Unavailable inference, cancellation, truncation and invalid model output are errors. HTTP disconnect/abort cancels queued or running work. Runs have ceilings of 180 seconds, 160,000 accounted/reserved tokens, 8,192 generation tokens per request and 2–8 answer generations; up to two capability probes share the same run budget. Aggregate completion counts are never called visible-answer tokens. Index warnings remain visible when retrieval was incomplete.

CLI: `notient ask "What is still unresolved?" --vault /path/to/vault --folder Research` (or `--note Research/topic.md`). MCP `notient_ask` accepts the same optional scope. The Obsidian Ask tab uses this API, renders Markdown, opens exact evidence in the native editor, and cancels through Stop; unsaved active-note content is explicitly excluded.

## Source identity and structural selection

A note reference is `{path, revision}`. `path` is one exact ordinary public vault-relative `.md` path: no traversal, absolute path, hidden segment, alternate separators or Notient-owned transcript/proposal roots. VaultAdapter remains the final symlink, exclusion and filesystem containment authority. SHA-256 `revision` covers UTF-8 encoded full content including BOM and original line endings; it is not the derived block hash.

`notes.list` accepts an optional `query` (up to 256 characters): case-insensitive whitespace-separated terms must all appear in the note's full path. It searches nested filenames, intersects existing scope/property filters, and binds pagination cursors to the query. The TUI note picker uses this same catalog operation.

Tag filters and permission scopes compare exact tag identities case-insensitively,
with an optional leading `#`. `Work` matches `#work`; `Work` does not implicitly
grant access to `Work/Private`. Authored spelling remains unchanged. Archive
protection also covers descendants: protecting `keep` protects `#KEEP/Personal`,
but not `#keeper`.

Source ranges use zero-based UTF-16 string offsets into the exact returned `body`, with an exclusive end. Lines are one-based and describe the offset positions (an exclusive end at the next line is reported on that next line). This matches JavaScript/Obsidian editor strings while SHA-256 covers encoded bytes. Never apply these offsets to normalized or different-revision content.

A heading selector uses exact visible heading text and optionally its one-based document occurrence. Duplicate matches produce CONFLICT without selecting an arbitrary heading. The selected section extends from that heading to the next heading of equal or lower depth, or EOF. Explicit block selectors retain the original Obsidian ID; duplicate IDs conflict. Raw range selectors require a revision. Missing selectors return NOT_FOUND; any supplied obsolete revision returns CONFLICT before selection.

`notes.read` preserves `body` and returns `note`, `structure`, optional `selected` evidence, and `freshness`. Reads are current files. `indexedRevision: null` and `state: unknown` explicitly mean no index revision was established, not that the index is current. The daemon supplies the stored note hash, so reads return `current` or `lagging` when that index row exists. Malformed YAML returns raw YAML and an error while leaving the note readable. Reads are limited to 4 MiB through the bounded descriptor API in production.

Example socket method parameters:

```json
{"path":"Projects/Storage.md","selector":{"kind":"heading","text":"Decision","occurrence":2}}
```

The result's `selected` object contains the path, revision, exact quote and range. Retrieval adapters must verify those bytes before labeling a citation current; canonical retrieval validates current exact evidence; older quick/balanced/deep result adapters retain their existing contracts.

## Comparing notes

`notes.compare {sources, question?}` accepts 2–8 distinct revision-bound notes. `notes.correlate {source, focus?, scope, limit}` retrieves at most seven distinct candidates within the supplied scope. An optional `focus {start, end}` gives UTF-16 offsets of at most 16,000 characters into that exact saved revision; the daemon reads the passage from the saved bytes, anchors the source excerpt there and uses the passage as the question. A range outside the revision is `INVALID_PARAMS`, and a changed revision is `CONFLICT`. Both return `sources`, `comparisons`, `abstained`, `reason`, `coverage`, `limitations`, `attempts`, and `durationMs`. Each supported comparison cites exact quotations from both notes. Judgments distinguish support/development, contradictions under matching conditions, changes over time and different assumptions. Assessment is a textual-support heuristic, not a probability.

The shared execution allows two model calls including one schema correction, a 16,384-token shared reasoning/answer ceiling, 120,000 accounted/reserved tokens and 180 seconds including queue time. Current source revisions are checked again after inference. Truncated, reasoning-only and stale-source responses fail explicitly. These reads create no jobs, proposals, relationships or file changes. Socket disconnect and HTTP cancellation stop the request; clients must not blindly retry inference.

## Execution and transport semantics

Model-free operations are file/structure reads, lexical search, graph lookup, previews, policies, history and job inspection. Semantic retrieval, grounded answers, comparison and pipeline model stages require the corresponding inference capability. Model availability must not authorize effects. Mutations go through the existing writer/approval/history authority.

Every replayable write carries an idempotency key and revision preconditions. Creation requires absence (`expected: null`); mutation requires the source revision. Applying a preview requires that exact preview ID and revision. Multi-note operations report per-effect results and PARTIAL when only a subset succeeds; no filesystem-wide atomicity is promised. Preview submission binds its key to input and per-effect execution reuses durable receipts. Conflict binding for the separately supplied apply key remains unfinished; job controls bind their keys and transitions atomically. Revoked permissions and source revisions are rechecked immediately before effects.

Canonical failures: INVALID_PARAMS, NOT_FOUND, CONFLICT, FORBIDDEN, INFERENCE_UNAVAILABLE, PENDING_APPROVAL, CANCELLED, PARTIAL, LIMIT_EXCEEDED and INTERNAL_ERROR. Existing RPC retains its established transport/authentication/history codes during adapter work. Correlation IDs are caller-selected bounded request IDs and must be echoed in results/events without becoming credentials.

Page limits default to 50 and cap at 200. Implemented notes.list cursors bind to validated filters and a catalog generation (sorted paths and mtimes); a changed generation returns CONFLICT. This is an inventory snapshot, not a filesystem-wide transaction. Each returned note carries its current content revision. Catalog scans cap at 10,000 notes. Search caps at 100 hits; context caps at 50 references and 100,000 characters. Long-running operations return durable job IDs. Event subscriptions need monotonically ordered durable cursors; expired cursors require an explicit snapshot recovery response. HTTP and retained-cursor event reads are implemented; job/event atomicity and complete reconnect acceptance remain N03/N05 work.

## Policy defaults and authority

The schema includes save/idle/interval triggers, debounce, cooldown, IANA timezone/windows, separate read/write scopes, exclusions, destinations, allowed properties/sections, report/propose/apply mode, independently selected effects, and finite budgets. These schema fields are a required contract, not proof of runtime enforcement. Fresh configuration must leave AI background execution disabled. Human configuration and exact-preview approval remain distinct from agent invocation authority. A policy cannot grant authority that the caller lacks.

## Representative fixture

`testing/fixtures/v0.1.0/` includes duplicate Storage filenames and Decision headings; BOM/CRLF/Unicode; typed/commented YAML and aliases; code fences, block references, callouts, tasks and attachments; inbox and archive; contradictory production claims, historical changes, unrelated gardening content and an unanswerable question. It contains synthetic authored data only and is safe to copy into disposable test vaults.

## Available alpha transport (2026-09-12 checkpoint)

The daemon binds HTTP to `127.0.0.1` and records its endpoint in local private daemon state. `daemon.status` and local pairing creation return the endpoint and vault identity. Do not assume a fixed port. `notient pair create --vault /absolute/vault --label local-client --kind human --scopes read,write` creates a single-use five-minute pairing code. `notient pair list` and `notient pair revoke --id <credential-id>` use local human administration. The exchange is `POST /api/v1/pair`; subsequent requests carry `Authorization: Bearer <credential>`. Tokens are hashed in private persistent storage. A credential's read/write/admin scope never changes the effect's revision preconditions.

Implemented operations use `POST /api/v1/<family>/<operation>`, for example `/api/v1/notes/read` and `/api/v1/changes/preview`. `GET /api/v1/discovery` is anonymous discovery; `GET /api/v1/events` is the authenticated SSE stream. The generated [OpenAPI document](openapi-v1.json) and `src/api/results.ts` are the current operation inventory. The fetch-only runtime-validated client ships as the `notient/sdk` package export: one browser-safe ESM bundle with TypeScript declarations, depending only on `zod`.

```ts
import { NotientApiError, NotientClient, type OperationResult } from "notient/sdk";

const credential = await NotientClient.pair(endpoint, pairingCode, vaultId);
const client = new NotientClient({ endpoint, token: credential.token, vaultId });
const note: OperationResult<"notes.read"> = await client.call("notes.read", { path: "Garden.md" });
```

Operation names, inputs and results are typed from the same catalog the daemon validates with, so an unknown operation or malformed input fails at compile time and again at runtime. `operationInputs`, `operationOutputs` and the shared schemas are exported for callers that validate their own payloads. The client never retries a mutation after an ambiguous disconnect; `NotientApiError.outcomeMayBeUnknown` marks those cases. `release:check` installs the tarball, runs a consumer against `notient/sdk` and typechecks it with no access to the source tree.

The CLI reaches the same authority:

```sh
bun dist/notient.js api notes.read --input '{"path":"Projects/Storage.md"}' --vault /absolute/vault --ndjson
bun dist/notient.js api search.run --input '{"query":"Durability","mode":"lexical"}' --vault /absolute/vault --ndjson
```

A change set applies its effects in order and stops at the first conflict, denial or cancellation, reporting `partial` when earlier effects were recorded. A later change may edit a note that an earlier move in the same set relocates: it names the destination path with the moved note's saved source revision, and it edits the planned destination bytes, including rebased links. Relationship changes cannot target a moved note. The inbox pipeline uses this to write its configured processed property as each organized item's final effect.

Configuration, stored reviews and the bounded Obsidian host bridge are implemented operations described below. The official desktop plugin has actual Windows-to-WSL validation in a disposable vault; its remaining workspace features and full N07 acceptance are still in progress.


## Durable job inspection

`jobs.list` accepts optional `pipeline`, `state`, `limit` (1–200, default 50) and
`cursor`. It returns bounded job summaries, `snapshot` and `nextCursor`. The order
is most recently updated first, with a stable ID tie-breaker. Cursors survive daemon
restart for an unchanged inventory, bind to filters, and return CONFLICT if jobs
change. Start a fresh list without the cursor after that conflict. Matching
inventories over 10,000 jobs return LIMIT_EXCEEDED; narrow the filters.

`jobs.get` accepts a job UUID and returns source/configuration revisions, the policy
recorded for the run, progress, attempts, findings, proposals, effects and any
failure. NOT_FOUND is distinct from an empty list. Each inference attempt retains
provider-reported total/reasoning/aggregate-completion usage and unavailable
breakdowns separately from conservative reserved estimates. `chargedTokens` in a
summary is a resource-budget charge, not a visible-answer token count. Internal
derived extraction database checkpoints are not public job output.

Both operations require vault read scope, perform no inference, and do not change
job state. The vault is the access boundary; authorized readers can inspect its
jobs, while execution and controls have separate authority checks.

```sh
notient jobs list --state failed --limit 20 --vault /absolute/vault --ndjson
notient jobs get <job-uuid> --vault /absolute/vault --as codex --ndjson
notient api jobs.list --input '{"pipeline":"enrich","limit":20}' --vault /absolute/vault
```

MCP exposes `notient_list_jobs` and `notient_get_job`. The TUI exposes `/jobs [cursor]`
and `/job <job-uuid>`. All use the same job contracts and storage. HTTP routes are
`POST /api/v1/jobs/list` and `POST /api/v1/jobs/get`.

## Guarded job controls

`jobs.control` requires `{id, action, revision, idempotencyKey}` plus read and write
scopes. A human can control vault jobs; agents can control only their own explicit
live jobs. They cannot control background jobs or grant approval through this API.

| Action | Accepted current states | Result |
| --- | --- | --- |
| pause | queued, running, waiting-inference | paused |
| cancel | queued, running, waiting-inference, paused | cancelled |
| resume | paused | queued |
| retry | failed, partial, waiting-inference | queued |

Other transitions and stale revisions return CONFLICT. Resume/retry also conflict
while an earlier execution is still stopping. A retry retains the original policy,
source revisions, checkpoints, proposals and charged budgets; it grants no fresh
resource budget or permission. A completed job cannot be relabelled cancelled.

The state change and its receipt commit in one database transaction. Exact repeats
of the same caller/key/request return that stored receipt after subsequent job
changes or daemon restart. Reusing a key with different inputs returns CONFLICT.
The result is the job snapshot at control acceptance; use `jobs.get` for current
progress. A client interrupted during control must treat its outcome as unknown
and explicitly repeat the exact request to resolve it. Clients do not blindly
replay mutations. Revoked credentials cannot replay receipts.

Pause/cancel abort active execution and prevent further authorized work. They do
not undo committed effects or erase inference charges. A final effect receipt
racing with cancellation is retained on the job; inspect effects/history before
deciding whether a separate guarded undo is appropriate.

```sh
notient jobs pause <job-uuid> --revision <current-sha256> --idempotency-key pause-1 --vault /absolute/vault
notient jobs cancel <job-uuid> --revision <current-sha256> --idempotency-key cancel-1 --vault /absolute/vault --as codex
```

HTTP uses `POST /api/v1/jobs/control`; MCP uses `notient_control_job`; the TUI uses
`/job <id> <pause|resume|cancel|retry> <revision> <idempotency-key>`.

## Explicit live pipelines

`pipelines.list` returns the seven built-in definitions, current policies,
configuration revision, global background pause state and each scheduler's last/next
run and admission reason. Inspection requires read scope and performs no inference.

`pipelines.run` requires read **and** write scope and
`{pipeline, sources: [{path, revision}], preview?, idempotencyKey}`. Every selected
source must match current bytes and the configured read scope. The job records
caller, source revisions, policy and configuration revision. The caller/key binds
to those submitted inputs: exact repeats return the same job at its current state;
different inputs with the same key return CONFLICT, including concurrent submissions.
The response acknowledges admission, not completed inference or successful effects.
Use `jobs.get` and events for progress, findings, failures and provider accounting.

An explicit live invocation does not require background enablement, and never
enables it. It uses the same engine, policy scopes, destinations, resource budget,
proposal service and mutation authority as scheduled execution. `preview: true`
prevents authored-note effects; derived indexing and durable change previews can
still be stored. Otherwise report/propose/apply behavior follows the recorded
policy. Configuring a policy or approving a proposal requires separate human
authority; no supplied note can grant it.

Detached paired-client jobs recheck the current credential authority at admission,
after recovery, before model stages and before effects. Revocation aborts active
inference and prevents queued/recovered execution; reserved charges remain recorded.
Retries retain the existing run budget. When enabled by `budget.retries`, one
schema-correction request per model stage is allowed after runtime validation
rejects a structured response. It uses the same call/token/duration budget and
receives only the visible JSON and validation errors, never hidden reasoning.

Generation tokens cover reasoning and final output together. A truncated response
retains measured provider usage and fails with `LIMIT_EXCEEDED`; it is not
automatically repeated at the same ceiling. New contradiction policies allow
16,384 generation tokens, based on bounded Qwen validation; existing saved
policies retain their configured limits. Duration, total tokens and model calls
still bound the entire run, including schema corrections.

```sh
notient pipelines list --vault /absolute/vault --ndjson
notient pipelines run enrich --sources '[{"path":"Note.md","revision":"<sha256-from-notes.read>"}]' --preview --idempotency-key enrich-1 --vault /absolute/vault --as codex --ndjson
```

HTTP uses `POST /api/v1/pipelines/list` and `/api/v1/pipelines/run`. MCP exposes
`notient_list_pipelines` and `notient_run_pipeline`. TUI commands are `/pipelines`
and `/pipeline <JSON request>`. Full seven-family model-quality acceptance remains
separate implementation work.

## Runtime workflow preferences

Open **Ctrl+P → Preferences** in the terminal, or **Settings → Notient** in
Obsidian. Both expose read/write scopes, exclusions, destinations, triggers,
timezone/windows, run budgets, supported effects and family-specific parameters.
Review changes before saving. All AI background policies start disabled;
structural watching and explicit manual requests remain independent.

`pipelines.validate` accepts `{pipeline, policy}` with read scope and returns
semantic errors and scope/resource warnings without changing permissions.
`pipelines.configure` accepts `{pipeline, policy, revision, idempotencyKey}`;
`background.pause` accepts `{paused, revision, idempotencyKey}`. Both require a
human principal with explicitly granted **admin** scope. Agents cannot grant
themselves background permissions. Fetch the current revision from `pipelines.list`.

Successful configuration responses contain `{ok, revision, settings, replayed}`.
The existing private `config.json` is the configuration authority; unrelated
product fields and deployment precedence are preserved. Reusing the exact key
returns its historical receipt, so read `pipelines.list` again for current state.
Changed arguments under the same key and stale revisions conflict. An interrupted
save can be confirmed only when the exact desired file remains; otherwise the
daemon refuses to replay it and requires a fresh, reviewed decision.

Pausing background work stops active background runs and prevents admission of
new ones. Manual runs continue unless their own policy changes. Changing a
workflow's policy revokes its active runs before subsequent inference or effects;
unrelated workflow edits do not cancel them. Resuming respects individual enablement,
triggers, scopes and budgets. Already recorded note effects remain in history.

## Chat resource limits

`chat.settings` (read scope) returns `{ok, revision, budget}`. The budget bounds one
chat answer across capability checks, context preparation, tool rounds, nested
analysis and memory refresh: `modelCalls` (1–128), provider-reported `tokens`
(1,024–1,000,000), wall-clock `durationMs` (1,000–3,600,000) and the per-call
`generationTokens` ceiling (1,024–131,072). Reading also adopts direct operator
edits to `config.json`.

`chat.configure` accepts `{budget, revision, idempotencyKey}` and requires a human
principal with admin scope. It uses the same journaled configuration authority,
receipts and conflict rules as `pipelines.configure`, and returns
`{ok, revision, budget, replayed}`. A saved budget governs the next chat turn
without a restart; a turn already running keeps the limits it started with.
Terminal **Ctrl+P → Preferences → Conversation resources** edits these limits with
review before save.

## Stored reviews

`proposals.list` returns bounded pages of durable suggestions, with optional `path`
and `state` filters. Cursors bind the stored proposal inventory and filters; source
freshness is checked against live files on each page. Filtered pages can be empty
with a non-null `nextCursor`; continue that cursor. `proposals.get` returns the
same proposal, provenance, exact source passages, preview identity and decision.
`changes.get` reads the stored before/after preview without regenerating it.

A caller with write scope asks for a human decision on one of its own previews with
`proposals.submit {previewId, previewRevision, rationale, evidence?, idempotencyKey}`.
The daemon records the authenticated requester, derives the reviewed sources from
the preview's change set and rechecks them, so a submission over stale sources is a
`CONFLICT`. Only the preview's owner may submit it, and a preview with unresolved
reference ambiguities cannot be submitted. Submitting the same preview again returns
the existing review, including a rejected one. Submission grants nothing: the
human applies or rejects it with the operations below, every source is validated
again before each effect, and direct `changes.apply` is refused while the review
exists.

A human with read/write scopes can call `proposals.approve` with
`{id, previewId, previewRevision, idempotencyKey}`, or `proposals.reject` with
`{id, revision, idempotencyKey}`. Agents can inspect reviews but cannot grant
approval. Reusing a decision key with different inputs conflicts. An approved
request returns its stored receipt even after a later human edit. A partial
application retains its history; rejecting the remainder neither undoes that
history nor permits interrupted effects to replay on restart. Direct
`changes.apply` cannot bypass a stored review or a rejection.

The in-app chat assistant uses the same path through its `changes.preview` and
`changes.submit_for_review` tools. It acts as its own agent principal,
`assistant:<conversation client>`, which no connecting client can claim because the
colon is outside the wire identity grammar. Idempotency keys are derived from the
planned changes and the preview, never chosen by the model. The tools return effect
summaries without note bodies, pass no approval gate and have no effects; reviews
appear as "Change requested by the assistant".

Scripts reach every catalog operation through the generic command, with the same
validation and authority as HTTP:

```sh
notient api changes.preview --input '{"idempotencyKey":"k1","changes":[...]}' --vault /absolute/vault --as codex
notient api proposals.submit --input '{"previewId":"...","previewRevision":"...","rationale":"...","idempotencyKey":"k2"}' --vault /absolute/vault --as codex
notient api chat.settings --input '{}' --vault /absolute/vault
```

A named agent's `proposals.approve` and `chat.configure` calls are `FORBIDDEN`.

Explicit workflow previews retain reviewable suggestions while leaving authored
notes unchanged. The TUI Review workspace and Obsidian Review tab use these same
operations. Individual link decisions use `links.proposals/approve/reject` on the
local RPC; the existing `notient proposals` link CLI uses those names. The old
RPC names are deliberately replaced, with no alternate decision engine.

`brief.run {query?, source?, focus?, scope, limit?}` requires exactly one topic query or saved note reference. `focus {start, end}` is accepted only with `source` and anchors the brief at that range of the saved revision, with the same rules as `notes.correlate`. It examines at most eight current notes (default eight), returns a cited `summary`, evidence-backed `findings` (`claim`, explicit `decision`, `question`, or two-sided `tension`), inspected `sources`, `coverage`, `limitations`, provider-accounted `attempts`, and monotonic `durationMs`. A question in a note is not proof that it is still unanswered. Empty or insufficient evidence produces an explicit abstention. All inspected revisions are checked again after inference; source changes fail the run. One structured-output correction is allowed within the shared two-call, 180-second budget. The operation is read-only and is never automatically replayed after a disconnect. The old `agent.brief` implementation has been removed.
