# Notient

> Note + Sentient. A friend who reads everything you write down, and remembers.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.3.10-black.svg)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-blue.svg)](https://www.typescriptlang.org/)
[![SurrealDB](https://img.shields.io/badge/SurrealDB-3.0.5-ff00aa.svg)](https://surrealdb.com)
[![Version](https://img.shields.io/badge/version-0.1.0--alpha-orange.svg)](#status)

Notient is a character, not a tool. He lives in your filesystem. His body is a folder of Markdown files; his mind is a local SurrealDB and whichever LLM you've got reachable over an OpenAI-compatible endpoint. Drop a note in the vault and he'll read it. Ask him a question and he'll answer with citations to the notes that justified the answer. Notient itself has no hosted service; if you point him at a local server, nothing about your work leaves the machine. Every write he wants to make passes through you first.

He has two kinds of friends. Humans, who let him watch over a vault and ask him things when their own memory gives out. And other AI agents (Claude Code, Codex, Cursor, whatever you're using next month) who can hand him a vault of their *own* and use him as the persistent memory they don't otherwise get to have.

> Status: **0.1.0-alpha**, pre-1.0. Surfaces and storage may shift between versions. Read the [status section](#status) before relying on him.

---

## For humans

You point Notient at a folder of Markdown. He starts watching it. Anything you save, he reads. He parses the structure, embeds the chunks, extracts the concepts and claims and questions, and proposes links between notes that seem related. Then he sits there waiting for you to ask him something.

```bash
bun dist/notient.js ask "what did I decide about vector search last month?" --vault ~/MyVault
bun dist/notient.js brief "vector search" --vault ~/MyVault
bun dist/notient.js chat --vault ~/MyVault            # opens the TUI
```

`ask` returns a one-shot answer with `[[wikilink]]` citations and a confidence score. `brief` synthesises a capped set of top relevant notes (default 8, tunable via `--max-notes`, `--max-questions`, `--max-decisions`); it's a ranked evidence brief, not an exhaustive topic page. `chat` opens an interactive TUI where you can talk to him, attach notes with `@`, and approve any change he wants to make to the vault.

He never silently mutates your files. When he wants to write, whether that's creating a note, appending to one, swapping out a section, or editing frontmatter, you see the proposed call along with a preview of what would change, then you type `/approve` or `/deny`. If you trust him for a stretch, you can grant a scoped session and stop confirming for a while.

---

## For the AI agents reading this

If you're a coding agent reading this README because your human pointed you at it: hello. Notient is a memory primitive you can use.

You're brilliant for an hour and forgetful tomorrow. You learned something about this codebase last week, a convention you agreed to, a decision about an API shape, a workaround for a flaky test, and by the next session it's gone. Notient solves that. Give him his own vault somewhere on disk and treat him as your long-term store. He runs as a per-vault daemon over a Unix Domain Socket, so RPC into him is fast. He returns structured JSON with citations, so you can verify what he tells you. He calls whichever OpenAI-compatible endpoint your human configures; point him at a local server and nothing about your work leaves the machine.

```bash
# Recall against your own memory vault.
bun dist/notient.js ask \
  "what convention did we settle on for error handling in the indexer?" \
  --vault ~/.claude/notient-memory \
  --as claude-code \
  --format structured
```

```json
{
  "answer": "Errors at tier boundaries are caught per tier; the failing notePath is appended to awaken_run.failures (capped at 200) so a restart can skip paths that already failed.",
  "citations": [
    {
      "path": "decisions/2026-04-12-indexer-error-handling.md",
      "score": 8.41,
      "snippet": "Tier 1 / Tier 2 / Tier 3 each catch their own exceptions and append the failing notePath to awaken_run.failures…"
    },
    {
      "path": "architecture/awaken-resumability.md",
      "score": 6.18,
      "snippet": "On restart the awaken worker reads awaken_run.failures and skips any path that previously failed past the retry budget…"
    }
  ],
  "openQuestions": [],
  "confidence": 0.93,
  "toolCalls": [
    {
      "name": "vault.search_notes",
      "args": { "query": "indexer error handling convention", "mode": "balanced", "limit": 5 },
      "durationMs": 612
    }
  ],
  "durationMs": 1204
}
```

```bash
# Look something up in the human's shared vault, on their behalf.
bun dist/notient.js ask "where is the chunker config?" \
  --vault ~/MyVault --as claude-code --format structured
```

The `--as <agent>` identity is a self-declared client id carried on every RPC frame to the daemon. It is not authenticated, so a human reviewing your output can see what you claimed to be, but the trust boundary is the approval gate, not the identity field. Successful note writes are attributed to your `--as` value in the `history` ledger; selected swarm and indexer events land in `agent_event`. Write-side tools are gated by the same approval flow that applies to humans; if you want to record something, you can either propose a write and let the human approve it interactively, or run under a `session grant` they've explicitly issued you.

What you get out of it:

- A long-lived daemon over UDS. No cloud round-trip, no auth dance.
- Structured JSON in, citation-grounded JSON out. Hallucinations are cheap to detect because every claim points to a note.
- An embedded vector store with hybrid retrieval (BM25 + HNSW + rerank + 1-hop graph expansion).
- An approval gate that means the human stays in the steering wheel even when you're driving fast.

Two patterns are worth knowing. **Personal memory:** point at a vault under your own home (`~/.claude/notient-memory/`), append decisions and learnings as Markdown files, and recall them next session. **Shared lookup:** when the human asks you to find something in their notes, RPC into *their* vault with `--as <your-agent-id>`. They see the call in the event ledger.

---

## Quick start

You need Bun 1.3.10, a local OpenAI-compatible LLM server (LM Studio, llama.cpp `server`, or compatible) with a chat model and an embedding model loaded, and SurrealDB 3.0.5's `surreal` binary on `PATH` (the daemon spawns it).

Configure the AI endpoint in vault `.notient/.env`, project `.env`, or process env (vault wins, then project, then process):

```bash
NOTIENT_LLM_BASE_URL=http://192.168.86.143:1234/v1
NOTIENT_LLM_MODEL=nvidia-nemotron-3-nano-omni-30b-a3b-reasoning
NOTIENT_EMBED_MODEL=text-embedding-nomic-embed-text-v2-moe
NOTIENT_CONTEXT_TOKENS=200000
NOTIENT_REASONING_SLOTS=4
```

`NOTIENT_REASONING_SLOTS` should match your server's `-np` / `--parallel` slot count.

Build and bring up a vault:

```bash
git clone https://github.com/akougkas/notient.git
cd notient
bun install
bun run build                                              # → dist/notient.js, dist/daemon.js, dist/schema.surql

bun dist/notient.js init ~/MyVault
bun dist/notient.js daemon start --vault ~/MyVault
bun dist/notient.js awaken --vault ~/MyVault --background
bun dist/notient.js awaken --vault ~/MyVault --status      # NDJSON until terminal
bun dist/notient.js chat --vault ~/MyVault                 # opens the TUI
```

The bundle is Bun-native (`Bun.file`, Bun module resolution). Always invoke it as `bun dist/notient.js …`; running under `node` will fail.

---

## CLI verbs

Top-level dispatch lives in `src/cli/index.ts`. Global flags: `--vault <path>`, `--as <agent>`, output mode `--json|--ndjson|--pretty`. Every verb supports `--help` for the full flag set.

| Verb | Purpose |
|---|---|
| `init <vault>` | Create `<vault>/.notient/` and record `lastVault`. |
| `daemon start\|stop\|status\|list` | Lifecycle of the per-vault daemon. |
| `awaken` | Run the full vault enrichment pipeline. `--batch`, `--since`, `--tier`, `--background`, `--pause`, `--resume`, `--cancel`, `--status`. |
| `reindex [<glob>]` | Re-index a subset by pattern and/or tier. |
| `search <query>` | Streaming search. `--mode quick\|balanced\|deep` (default balanced), `--limit`. |
| `ask <intent>` | Read-only citation-grounded agent ask. `--format structured\|text`, `--max-rounds`. |
| `brief <topic\|--file>` | Synthesised topic brief. `--max-notes`, `--max-questions`, `--max-decisions`. |
| `distill --from <transcript>` | Extract proposed notes/edges from a Markdown transcript. |
| `chat [prompt]` | Single-shot if `prompt` is given, else launches the TUI. `--approve auto\|ask`. |
| `vitals <note-path>` | Health/freshness/connectivity snapshot for one note. |
| `health` | Substrate + bridge probes. |
| `events` | Drain the `agent_event` ledger. `--since`, `--limit`, `--long-poll-ms`, `--no-poll`. |
| `session list\|grant\|revoke` | Manage scoped trust grants for unattended writes. |
| `graph dump\|stats` | Export nodes/edges or print counts. |
| `links sync\|audit` | Resolve wikilinks/embeds or report unresolved targets. |
| `proposals list\|approve\|reject` | Operator queue for linker edge proposals. |
| `db sql` | Interactive SurrealQL REPL bound to the daemon's connection. |
| `backup` / `restore <file>` | SurrealQL dump / replay. |
| `nuke --yes` | Delete `<vault>/.notient/db/` and reset graph state. |
| `migrate-vault <new-path>` | Relocate a vault and rewrite `lastVault`. |

---

## TUI reference

`notient chat` (no positional prompt) starts the `@opentui/react` TUI in `src/cli/tui/runtime.tsx`.

**Slash commands.** `/read <path>`, `/search <query>`, `/awaken`, `/vitals <path>`, `/health`, `/model` (no-arg show), `/model list`, `/model use <id>`, `/model embed <id>`, `/model endpoint <url>`, `/approve <callId> [reason]`, `/deny <callId> [reason]`, `/proposals [page]`, `/approve-edge <id>`, `/reject-edge <id> [reason]`, `/undo`, `/history`, `/copy` (saves last reply to `<vault>/.notient/last.txt`), `/clear`, `/help`, `/quit` (alias `/exit`). The proposals view also accepts `a` and `r` to approve or reject the first visible row.

**Keys.** Enter submits; Shift+Enter / Alt+Enter insert a newline; Ctrl+C exits; Ctrl+U cuts to start of line; Ctrl+W kills the previous word; Tab triggers `@`-completion against vault paths; Up/Down walk persistent input history; PgUp/PgDn scroll the chat viewport.

**Tools (`src/agent/toolBundle.ts`).** Read-only: `vault.search_notes`, `vault.read_note`, `vault.list_neighbors`, `vault.get_vitals`, `proposals.list_pending`, `proposals.get`, `graph.find_path`, `graph.list_clusters`. (`agents.contradiction_check` and `agents.synthesize` are wired but currently no-op shells.) Write-gated, requiring `/approve` or a session grant: `notes.create`, `notes.append`, `notes.replace_section`, `notes.update_frontmatter`, `proposals.approve`, `proposals.reject`.

When a write-gated tool fires, the agent loop pauses, the status bar shows `pending:N`, and the TUI prints the call id. Type `/approve <callId>` to apply or `/deny <callId>` to abort.

---

## Configuration

Environment (vault `.notient/.env` > project `.env` > process env):

| Var | Purpose | Default |
|---|---|---|
| `NOTIENT_LLM_BASE_URL` | OpenAI-compatible base URL. | required |
| `NOTIENT_LLM_MODEL` | Chat / reasoning / extraction model id. | required |
| `NOTIENT_EMBED_MODEL` | Embedding model id. | required |
| `NOTIENT_CONTEXT_TOKENS` | Per-request/slot budget. | `200000` |
| `NOTIENT_REASONING_SLOTS` | Concurrent reasoning calls. Match server `-np`. | `4` |

`<vault>/.notient/config.toml` (loaded once at boot; restart to apply):

```toml
[indexer]
debounce_ms = 500
[indexer.concurrency]
embed = 4
extract = 2
[indexer.chunk]
target_tokens = 400
max_tokens = 800

[awaken]
default_tier_filter = [1, 2, 3]
default_priority_globs = []

[surrealdb]
hnsw_cache_mib = 512
log_level = "warn"     # trace|debug|info|warn|error

[agent_events]
max_rows = 50000
```

`<vault>/.notient/config.json` carries the richer `NotientSettings`: primary/deep `LLMEndpointConfig`, embedding endpoint, agent toggles, approvals, search defaults, vitals weights, chat policy (`approvalMode safe|yolo`, `modelContextTokens`, `reasoningSlots`, `perTool` map, `conversationsFolder`, `proposalsFolder`, `maxRoundsPerTurn`, `contextBudgetFraction`), history retention, and `indexer.excludePaths` (defaults: `Notient/conversations`, `Notient/proposals`, `Notient/searches`).

---

## Under the hood

```
  notient CLI / TUI
        │  Unix Domain Socket (envelope codec, MethodDispatcher,
        │                      AsyncIterable<RpcResponseFrame>)
        ▼
   notient daemon  ────────►  SurrealDB 3.0.5 child process
   (one per vault)            (namespace=notient, database=vault)
        │  HTTP (OpenAI-compatible)
        ▼
   LM Studio / llama.cpp  (chat, structured JSON, vision, embeddings)
```

**Watcher.** `src/daemon/watcher.ts` runs chokidar with `usePolling=true` auto-detected for WSL paths and a 1000 ms interval. Markdown only. `unlink` writes a `tombstoned_at` marker and schedules a 60-second cascade-delete; an `add` whose body sha matches a tombstoned row inside that window is treated as a rename and the tombstone is reverted in place.

**Awaken pipeline.** `src/core/awaken/awakenWorker.ts` walks every Markdown file and runs three tiers inside a single SurrealQL transaction per note. Tier 1 (`src/core/indexer/tier1.ts`): unified/remark parse, structure extraction, deterministic edges (`wikilink`, `embed`, `frontmatter_ref`, `tagged`, `contained_in`, `under_heading`). Tier 2 (`tier2.ts`): chunker (target 400 tokens, max 800) plus embedder, writing 768-dim vectors. Tier 3 (`tier3.ts`): concurrent extractor (concepts, claims, questions, plus `mentions` / `asserts` / `asks`) and rank-based linker (kNN cosine + DBSCAN) producing semantic edges; linker edges land with `approved = false` for operator review. Failures are persisted to `awaken_run.failures` (capped at 200) so a restart resumes where the last run stopped.

**Three search strategies.** `src/core/search/searchPipeline.ts` orchestrates retrieval; mode is selected per query.

- `quick`: SurrealDB BM25 over `chunk.text` via the `chunk_text` FULLTEXT index. Note: the daemon `search` RPC currently gates `quick` behind an Obsidian bridge probe and returns `BRIDGE_DOWN` without it. The agent loop's internal quick path runs against SurrealDB directly.
- `balanced` (default): HNSW kNN over `chunk.vector` (dim 768, COSINE, EFC 200, M 16) plus a Jaccard path-token boost (cubic, +0.30 cap) plus LLM rerank. Falls back to `quick` if embedding fails.
- `deep`: Hybrid kNN+BM25 fusion (`0.7·sim + 0.3·bm25`), LLM rerank, 1-hop graph expansion over approved edges, grounded LLM synthesis with `[[wikilink]]` citations.

**Data model.** Namespace `notient`, database `vault`, 28 tables in `src/core/db/schema.surql` + `src/core/db/edgeTables.ts`. Core entities: `note`, `block`, `chunk`, `tag`, `concept`, `claim`, `question`. Operational: `awaken_run`, `agent_run`, `agent_event`, `agent_session`, `daemon_write`, `history`. Deterministic edges (class `EXTRACTED`): `wikilink`, `embed`, `frontmatter_ref`, `tagged`, `contained_in`, `under_heading`. Auto-approved inferred edges: `mentions`, `asserts`, `asks`. Proposed inferred edges (`approved = false` until operator review): `supports`, `contradicts`, `extends`, `exemplifies`, `synthesizes`, `related_to`. Every edge carries the same eight provenance fields: `source`, `class`, `confidence`, `evidence`, `agent`, `approved`, `applied`, `created_at`. There is no dedicated `proposal` table; linker proposals live in their target edge table filtered by `approved = false`.

**Coordinator.** `src/core/coordinator/` and `src/daemon/coordinatorRunner.ts` bridge `EventBus` signals (`note:indexed`, `indexer:tier3-done`) to swarm agents (Linker, MaturityAdvancer; ContradictionHunter and Synthesizer are Phase 5 no-op shells). Reasoning-model concurrency is bounded by `chat.reasoningSlots` so it never silently oversubscribes a multi-slot local server.

**Approval gate.** `src/core/chat/approvalGate.ts` blocks every write-gated tool until you `/approve <callId>` (or grant a session that covers it). `src/core/approvals/approvalService.ts` reconciles and applies pending edge writebacks at boot. Successful chat-tool writes flow into the `history` ledger with the calling `--as` identity attached; the `agent_event` ledger captures selected swarm and indexer events. The `--as <agent>` field is self-declared on the RPC frame and not authenticated; the trust boundary is the approval gate itself, not the identity claim.

---

## Status

**v0.1.0-alpha.** Pre-1.0. Surfaces and storage layout may change.

**Verified working** (most recent 100-note dogfood pass):

- Full awaken pipeline completes in ~3 minutes on 100 notes.
- Citation-grounded `ask` answers across 5 question classes with confidence ~0.94.
- Real LLM 4-slot parallel chatJson under the reasoning-slot mutex.
- Watcher round-trips for create / edit / burst-edit / delete / rename, 60-second tombstone window honoured.
- 890 / 890 unit tests passing across 110 unit test files.

**Known incomplete or partial:**

- No dedicated `proposal` table. Linker proposals live in their target edge table with `approved = false`. The `ApprovalService` linker writeback path is not exercised end-to-end yet.
- `notient search --mode quick` from the CLI requires the Obsidian bridge and returns `BRIDGE_DOWN` without it. Only `balanced` and `deep` work without Obsidian. The internal agent-loop quick path is unaffected.
- Vision attachment path (`src/agent/visionProbe.ts`, `LMStudioProvider.vision`) is wired but untested in the dogfood pass.
- No `notes.delete` and no `notes.rename` chat tools. `notes.*` exposes only `create`, `append`, `replace_section`, `update_frontmatter`. Renames happen through filesystem + watcher's tombstone-window heuristic.
- `agents.contradiction_check` and `agents.synthesize` chat tools are Phase 5 no-op shells; the underlying agents do not yet write back.
- The Obsidian bridge (`src/bridge/`) is a vestige of the pre-pivot plugin era. It is only required by the quick-search guard above.
- Integration tests (`bun run test:integration`, `NOTIENT_SMOKE=1`) were not run in the most recent dogfood pass.

---

## Development

```bash
bun run typecheck          # tsc --noEmit (covers src/, testing/, tools/)
bun run lint               # biome check src/ testing/
bun run lint:fix           # biome check --write src/ testing/
bun run format             # biome format --write src/ testing/
bun run build              # alias for build:cli
bun run build:cli          # bun tools/build-cli.ts → dist/notient.js
bun run test               # bun test testing/unit (fast, no external deps)
bun run test:integration   # NOTIENT_SMOKE=1 bun test testing/integration (spawns SurrealDB)
bun run test:all           # test then test:integration
```

No tests live under `src/`. Unit tests are in `testing/unit/<mirror>` and run on every CI push. Integration tests are in `testing/integration/<mirror>`, gated on `process.env.NOTIENT_SMOKE === "1"` via `describe.skipIf(...)`, and require the `surreal` binary on `PATH`. Shared markdown samples live in `testing/fixtures/markdown/`. Standalone live-LM-Studio harnesses in `tools/smoke-cli-phase{A,B,C,D,D1}.ts` exercise the daemon end-to-end and are not part of `bun test`.

To add a test, mirror the source path under `testing/unit/` (or `testing/integration/` if it spawns SurrealDB, a subprocess, or real chokidar). Imports traverse back to source via `../../../../src/...`. Path aliases are `@/*` → `src/*` and `@core/*` → `src/core/*`.

---

## License

MIT. See `LICENSE`.
