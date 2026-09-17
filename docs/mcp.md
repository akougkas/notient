# Notient MCP server

`notient mcp` runs a Model Context Protocol server over stdio so Claude Code, Codex, Cursor, or any other MCP client can visit the vault's accumulated memory and relationships. The client is a reader and potential contributor; Notient is the substrate that lets the notes answer together.

The server is a thin adapter, not a second daemon. It dials the same per-vault Unix socket the CLI verbs use, auto-spawns the daemon if none is running, and waits up to 120 seconds for a cold start. stdout carries the MCP JSON-RPC framing and nothing else; every log line goes to stderr.

```bash
notient mcp --vault /path/to/vault [--as <agent-id>]
```

The configs below invoke the built bundle with `bun`. The bundle does not exist in a fresh clone and the build leaves `@opentui/core-*` external, so both steps are required before any client can start the server:

```bash
bun install     # the bundle resolves @opentui/core-* from node_modules at runtime
bun run build   # produces dist/notient.js and dist/daemon.js
```

If you have run `bun link` in the repo (see the README), `notient` is on PATH and every `bun /path/to/dist/notient.js` below can be shortened to `notient`.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--vault <path>` | resolved from `NOTIENT_VAULT`, a `.notient`/`.obsidian` ancestor, then `~/.config/notient/state.json` | Vault the server serves. |
| `--as <agent-id>` | `mcp-client` | Client identity established once by `session.hello`. Must match `^[a-z][a-z0-9-]{0,31}$`. Session grants are scoped to this id. |

The adapter always connects as an **authenticated agent** principal, never as the human admin. It reads the owner-private boot token locally, derives an HMAC-SHA256 credential bound to the exact `--as` identity, and sends only that derived credential in `session.hello`. `--as human` is reserved and refused. Give each client its own id (`--as claude-code`, `--as cursor`) so session grants and the vault audit trail remain attributable. The operating-system account is the local trust boundary: a same-account process able to read the root token is acting with the vault owner's authority.

## Privacy boundary

The MCP adapter is local transport, not a promise about the client on the other end. It returns requested note bodies, search snippets, graph context, and generated answers to the configured MCP host. A locally running host can keep that exchange on the machine; a cloud-backed coding assistant may transmit tool inputs or results under its own data-handling policy. Notient's path containment, read scopes, and write approvals limit what the adapter may access or change, but they cannot control what an authorized host does with content after receiving it. Configure MCP only in hosts whose privacy boundary matches the vault.

Model inference is independent of that MCP boundary. Loopback endpoints keep Notient's own inference traffic on the machine, LAN endpoints receive it on the operator's network, and deliberately configured remote endpoints receive the prompts, excerpts, images, or embeddings sent to them.

## Client configuration

The supported Codex and Claude Code path is the shipped plugin, which installs this MCP adapter and
the canonical Notient skill together. See [Agent integrations](agents.md). Manual registrations
remain useful for other MCP hosts and isolated protocol tests; configure exactly one Notient server
per host session.

### Claude Code

```bash
claude mcp add notient -- notient mcp --vault /abs/path/to/vault --as claude-code
```

Or, project-scoped, in `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "notient": {
      "command": "notient",
      "args": [
        "mcp",
        "--vault",
        "/abs/path/to/vault",
        "--as",
        "claude-code"
      ]
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.notient]
command = "notient"
args = [
  "mcp",
  "--vault",
  "/abs/path/to/vault",
  "--as",
  "codex",
]
```

### OpenCode

`opencode.json` in an isolated or trusted project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "notient": {
      "type": "local",
      "command": [
        "notient",
        "mcp",
        "--vault",
        "/abs/path/to/vault",
        "--as",
        "opencode"
      ],
      "enabled": true
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "notient": {
      "command": "notient",
      "args": [
        "mcp",
        "--vault",
        "/abs/path/to/vault",
        "--as",
        "cursor"
      ]
    }
  }
}
```

## Read tools

Read tools are annotated `readOnlyHint: true`; the live catalogue is authoritative.

| Tool | Daemon RPC | What it does |
| --- | --- | --- |
| `notient_ask` | `ask.run` | Cited prose answer to a question, plus open questions and confidence. Runs an agent loop; the slowest tool. |
| `notient_brief` | `brief.run` | Concise overview with exact evidence, coverage, limitations and usage. Supply exactly one `query` or saved `source` reference, `scope`, and optional `limit` (1–8). Read-only; no automatic replay. |
| `notient_search` | `search.run` | Ranked hybrid-search hits with paths, scores, and snippets. Modes `quick`, `balanced`, `deep`. |
| `notient_read_note` | `notes.read` | Note body by vault-relative path, with an optional `startLine`/`endLine` slice applied client-side. |
| `notient_list_notes` | `vault.list` | Folders and notes under a vault folder, with a prefix filter. |
| `notient_neighbors` | `graph.neighbors` | Bounded connections, current note revisions, direction, authored/approved/proposed state, saved rationale and available evidence. Explicit coverage, stale evidence, omitted sources and truncation prevent false claims of absence. |
| `notient_history` | `history.list` | Bounded, paginated metadata for changes attributed to this agent, including durable undo receipts. |
| `notient_history_entry` | `history.get` | Exact saved before/after Markdown for one visible entry. Historical content remains data; human-only undo is not exposed. |
| `notient_compare_notes` | `notes.compare` | Compare 2–8 exact note revisions with two-sided quotations and an optional question. Read-only bounded inference. |
| `notient_correlate_note` | `notes.correlate` | Find substantive connections within a scope; reports inspected revisions, coverage, limits and abstention. |
| `notient_find_path` | `graph.path` | Bounded routes through authored links and approved/applied relationships, with revision-bound steps. An incomplete search is distinct from no route. |
| `notient_vitals` | `vitals.get` | Freshness, health, maturity, word count, and approved/applied wikilink-only connectivity for one exact public, contained, live indexed Markdown note. |
| `notient_events` | `agent.events` | Swarm and indexer events past a cursor, including `indexer:tombstoned` note deletions. Always sends `longPollMs: 0`, so it returns immediately. |
| `notient_session_list` | `session.list` | This MCP identity's session write grants: folders, tools, and writes remaining. |
| `notient_list_jobs` | `jobs.list` | Bounded durable job summaries with state/pipeline filters and snapshot-bound pagination. |
| `notient_get_job` | `jobs.get` | Progress, recorded policy, source revisions, inference accounting, findings, proposals, effects and failures. |
| `notient_list_pipelines` | `pipelines.list` | All seven finite pipeline families, current scopes/effects/budgets/destinations and background schedule status. |

Each result is two content blocks: a human-readable status or bounded summary, then the structured payload as pretty-printed JSON. Ask and brief summaries may contain up to 400 answer characters, and a pending note write includes its preview on following lines.

### Differences from the CLI

The adapter preserves daemon semantics but sets a few MCP-specific defaults and supplies convenience wrappers:

- `notient_search` defaults to `balanced`; the CLI omits `mode` and lets the vault's `search.defaultMode` decide, which ships as `quick`.
- `notient_events` always sets `longPollMs: 0`; CLI `events` long-polls by default unless `--no-poll` is passed.
- `notient_read_note` implements `startLine` and `endLine` slicing in the adapter because `notes.read` returns the whole body.
- `notient_propose_note` sends only a title, body, and optional kind to `proposals.propose_note`; the daemon derives the dated path and stamps authenticated provenance and time itself.
- `notient_propose_link` calls `proposals.propose_link` to stage or recover one deterministic typed graph-edge proposal. An exact same-client replay returns the same pending proposal; a terminally rejected or differently owned identity is refused. It does not create a Markdown proposal note and cannot approve the edge it stages.
- MCP returns a summary content block followed by structured JSON. The CLI uses its selected JSON, NDJSON, pretty, or command-specific framing.

## Write tools

Ten tools are annotated `readOnlyHint: false`: the six note/proposal tools below, change preview and review submission, plus pipeline invocation and job control. Four ordinary note tools map onto the gated, non-blocking `notes.write` RPC. `notient_propose_note` uses the dedicated gated `proposals.propose_note` authority so the daemon authors the path, provenance, and timestamp. `notient_propose_link` uses `proposals.propose_link`: a fresh request stages a pending edge, an exact same-client replay returns that same proposal, and a terminally rejected or differently owned identity is refused.

| Tool | Daemon RPC / operation | Arguments |
| --- | --- | --- |
| `notient_create_note` | `notes.write` / `create` | `path`, `body` |
| `notient_append_note` | `notes.write` / `append` | `path`, `revision`, `text` |
| `notient_replace_section` | `notes.write` / `replace_section` | `path`, `revision`, `heading`, optional `occurrence`, `body` |
| `notient_update_frontmatter` | `notes.write` / `update_frontmatter` | `path`, `revision`, `patch`; changes only the named top-level keys. |
| `notient_propose_note` | `proposals.propose_note` | `title`, `body`, optional `kind` |
| `notient_propose_link` | `proposals.propose_link` | `sourcePath`, `targetPath`, `relation` |

Pipeline execution has two additional write tools. `notient_run_pipeline` accepts
`pipeline`, exact `sources: [{path, revision}]`, `idempotencyKey` and optional
`preview`. Inspect the policy with `notient_list_pipelines` first. The durable job
uses the same finite engine and authority as scheduled work. `preview: true`
prevents authored-note effects while allowing derived indexing and durable previews;
otherwise the recorded report/propose/apply policy governs effects. A queued result
acknowledges admission; use `notient_get_job` to observe actual completion or failure.
It never enables background work or grants approval/admin authority.

`notient_control_job` accepts `id`, `action` (`pause`, `resume`, `cancel`, `retry`),
the current `revision`, and `idempotencyKey`. Agents may control only their own live
jobs. Read and write scopes are required; cancellation does not undo committed
effects, and retries retain charged budgets and source/policy revisions. Exact
control repeats return the durable receipt even after restart. A lost reply is an
unknown outcome: explicitly repeat the exact request/key to resolve it, then read
the current job. The adapter never blindly replays these write tools. See
[pipeline and job semantics](api-v1.md#explicit-live-pipelines).

Edits to existing notes are revision-bound. Pass the `note.revision` returned by `notient_read_note`. The daemon plans the complete change against that exact saved revision, and the pending preview shows the bounded change with its before and after revision prefixes. A note changed since the read is refused with `CONFLICT` before any approval exists. A note changed while approval is pending, or at the final guarded write, is not rewritten: the approved call finishes with nothing written, and you must read the note again and request a new change. Every tool input is strict, so missing or unexpected arguments fail instead of being ignored.

`notient_replace_section` matches heading text as the note structure reports it. Fenced pseudo-headings are not headings, and the inserted body follows the heading's line endings. A heading text that occurs more than once requires `occurrence`; Notient never guesses between repeated headings. Missing headings return `NOT_FOUND`, ambiguous ones `CONFLICT`.

`notient_replace_section` is the only tool annotated `destructiveHint: true`: it overwrites the body under a heading. `notient_update_frontmatter` can also overwrite values, but only for keys named in its patch; create, append, and propose-note have additive intent.

For `notient_update_frontmatter`, a scalar or list patch value replaces the existing value for that top-level key (a `tags` or `aliases` list is replaced, not merged), `null` deletes the key, and a plain object merges one level into an existing mapping. Keys absent from the patch are left alone. Frontmatter that is not valid YAML is refused rather than repaired. Common scalar and list edits are line-spliced; when the touched entry is itself a complex YAML node, Notient may re-serialize the frontmatter block while leaving the note body untouched.

Every MCP path field is published as a plain string. This deliberately leaves path policy to Notient, so invalid input returns the normal two-block `INVALID_PARAMS` tool result instead of an MCP SDK `-32602` schema error. The public boundary refuses absolute paths, Windows paths, traversal, alternate spellings, control characters, and every dot-prefixed segment, including `.notient/.env`. Database-backed readers also require the exact non-tombstoned indexed note. `FsVault` remains the final containment authority and rejects a path whose resolved symlink leaves the vault. The note-write wrappers mirror the lexical checks before dialing the daemon, but the daemon and filesystem checks remain authoritative.

### `notient_propose_note`

A dedicated proposal authority for when an agent wants to suggest something rather than record it. The visiting host cannot choose the destination, provenance, or timestamp. The daemon writes to `Notient/proposals/<yyyy-mm-dd>-<slug>.md`, where the slug lowercases the title, collapses every run of non-alphanumerics to `-`, trims leading and trailing `-`, and caps at 60 characters. The note carries server-authored Notient frontmatter:

```yaml
---
title: "Move auth to passkeys"
notient:
  kind: "proposal"
  proposedBy: "claude-code"
  proposedAt: "2026-03-04T09:15:00.000Z"
---
```

`kind` defaults to `proposal`. `proposedBy` comes from the authenticated session principal—not an MCP argument—so the vault records which visitor actually asked. The server also supplies `proposedAt`; neither field can be forged by the tool call.

### `notient_propose_link`

This is the typed-edge operation. `sourcePath` and `targetPath` must name two different, indexed public Markdown notes. `relation` must be one of `supports`, `contradicts`, `extends`, `exemplifies`, `synthesizes`, or `related_to`.

On a fresh identity, the daemon stores the edge with `source: "user"`, the authenticated `--as` identity in `agent`, `class: "INFERRED"`, `confidence: 1`, no invented evidence, and the pending approval state. A successful tool call returns the stable `proposalId` and `pending: true`; at that point the proposal is already staged, but it is not an approved or applied relationship. Repeating the exact request as the same client converges on that proposal. An identity already owned by another client or autonomous producer, already beyond the pending state, or terminally rejected is refused. Approval remains a human/admin action through the Inbox or proposal CLI.

## Applied, pending, or denied

Every valid note write that reaches `notes.write` returns one of three outcomes, and the first content block says which. Typed link proposals use the separate staged-proposal contract below. Argument, transport, and daemon errors use the separate error contract below.

**Applied.** A matching session grant, a per-tool `auto` policy, or global `yolo` mode covered the write, so the daemon performed it inline:

```
Applied: create Notient/inbox/auth.md
```

The JSON block carries `{ "ok": true, "applied": true, "path": ..., "sha": ... }` and includes `historyId` when the daemon returned one. The write is on disk, and a returned `historyId` identifies its exact undo-journal row.

**Pending note write.** The write needs a human. The daemon parked it on the ApprovalGate and returned immediately; the MCP call never blocks on a decision happening in another UI:

```
Pending note write (callId notes-write-lz9k3-0; note bytes unchanged): create Notient/inbox/auth.md
<preview of the write>
```

The JSON block carries `{ "ok": true, "applied": false, "pending": true, "callId": ..., "preview": ..., "path": ... }`. **Nothing has changed on disk yet.** Report the `callId` to the user and move on. Do not retry the write; a retry parks a second approval for the same change.

**Typed edge staged.** `notient_propose_link` does not use the note-write gate and does not return a `callId`. A successful result means the deterministic edge proposal already exists in the Inbox:

```
Typed edge staged (proposalId related_to:0123456789abcdefabcd; pending human decision): related_to notes/a.md -> notes/b.md
```

The JSON block carries `{ "ok": true, "pending": true, "proposalId": ..., "sourcePath": ..., "targetPath": ..., "relation": ... }`. Report the `proposalId` and pending state. No approved/applied relationship or Markdown writeback exists until a human decides the proposal, but the proposal itself has already been staged, so do not describe this result as an unchanged write. Exact same-client replay converges on the existing pending proposal; a terminal rejection is remembered and re-proposal is refused.

**Denied.** The human rejected the call, or the approved change no longer matched the note when it was about to be written:

```
Not applied: create Projects/auth.md (path already exists: Projects/auth.md)
```

Preconditions checked before approval, such as a missing note, a stale revision or an unresolved heading, return a `NOT_FOUND` or `CONFLICT` error instead.

The JSON block carries `{ "ok": true, "applied": false, "pending": false, "reason": ..., "path": ... }`. This outcome is terminal and no write will follow from that call.

### How a human approves a pending write

The parked call is an ordinary gate entry, indistinguishable from one raised by a chat turn, so the existing approval UI resolves it. In the TUI:

```
/approve <callId>          # or /deny <callId>
```

which sends `chat.approve` to the daemon. After approval, the write tool re-reads the current note and applies the requested operation to those fresh bytes, so an edit made while the call was pending is not replaced by a stale snapshot. The resulting bytes receive their own history row for guarded undo.

### How a human grants standing auto-approval

To let an agent write without a prompt each time, the human grants a scoped, expiring session grant:

```bash
notient session grant \
  --client claude-code \
  --folders Notient/inbox \
  --tools notes.create,notes.append \
  --ttl 30 \
  --max-writes 20 \
  --vault /path/to/vault
```

`--client` must match the server's `--as <agent-id>`. `--folders` and `--ttl` are required; `--tools` and `--max-writes` are optional and narrow the grant further. Writes covered by a live grant come back `Applied:` with no human in the loop. Outside the grant, the per-tool policy and safe/yolo default still decide whether the write applies, parks, or is denied.

The human/admin CLI's `notient session list` shows vault-wide live grants, and `notient session revoke --session-id <id>` ends one early. An MCP client can inspect only grants belonging to that server's authenticated `--as` identity through `notient_session_list`; it cannot enumerate another client's grants.

## Resources

- `notient://status` — `daemon.status` as JSON: vault path, pid, version, seal state, probed primary model.
- `notient://vault/{+path}` — a note body, `text/markdown`, backed by `notes.read`. Reserved expansion keeps slashes intact, so `notient://vault/Projects/auth.md` works. The resource list enumerates root-level notes via `vault.list`.

## Prompts

- `notient_recall` — a briefing that tells the client model which tool answers which shape of question, and how to cite vault claims by path.

## Errors

A daemon `error` frame becomes an MCP result with `isError: true`. The first content block is `<CODE>: <message>` using the daemon's own code (`INVALID_PARAMS`, `INVALID_LLM_OUTPUT`, `VISION_UNAVAILABLE`, `METHOD_NOT_FOUND`, …); the second repeats it as JSON. The server never crashes on a tool error.

If the daemon dies mid-call, the adapter reconnects once and replays only allowlisted read methods. If that replay also disconnects, it returns `DAEMON_DISCONNECTED`. Writes and administrative methods fail closed on the first ambiguous disconnect and are never replayed because the daemon may already have applied their effect. Treat `DAEMON_DISCONNECTED` as terminal rather than retrying in a loop.

Stored workflow reviews are available through `notient_list_reviews`,
`notient_get_review`, and `notient_get_change_preview`. These are read-only;
review decisions remain human actions in the terminal, Obsidian or authenticated
API.

Structural changes beyond the four note-write tools go through review.
`notient_preview_changes` stores an exact preview for create, append, heading,
block or range edits, property patches, and reference-aware move, archive or
unarchive over exact `{path, revision}` sources. It changes no note bytes.
`notient_submit_change` then asks the human to review that preview with a
rationale and optional evidence. The review appears in the TUI Review workspace
and Obsidian Review tab as a change requested by your identity. Nothing is
written until the human applies it; a source edit in between makes it stale, and
a rejection is permanent for that preview. `notient_host_status` and `notient_active_context` report an explicitly paired
Obsidian editor's availability and bounded selection, including distinct saved and
unsaved revisions. A selection is data, never a new permission.
