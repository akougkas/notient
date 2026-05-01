# Notient

> **Local-first agentic CLI for sentient Markdown vaults.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.3.10-black.svg)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-blue.svg)](https://www.typescriptlang.org/)
[![SurrealDB](https://img.shields.io/badge/SurrealDB-3.0.5-ff00aa.svg)](https://surrealdb.com)
[![Version](https://img.shields.io/badge/version-0.1.0--alpha-orange.svg)](#status)

Notient (Note + Sentient) turns a Markdown vault into a queryable, self-organising knowledge base. It indexes notes into an embedded SurrealDB, runs a local OpenAI-compatible LLM for chat and embeddings, and lets you talk to your vault from a TUI or single-shot CLI verbs. Everything stays on your machine. Every write is human-in-the-loop.

> Status: **0.1.0-alpha**, pre-1.0, not yet feature-complete. Surfaces and storage may shift between versions.

---

## What it does today

- **Watcher pipeline.** A long-lived daemon owns a chokidar watcher (with WSL polling auto-detected) that observes the vault. `add` / `change` / `unlink` events enqueue tier-1/2/3 indexing. `unlink` writes a `tombstoned_at` marker and schedules a 60-second cascade-delete; an `add` whose body sha matches a tombstoned row inside that window is treated as a rename and the tombstone is reverted in place.
- **Awaken pipeline.** A vault-wide indexer driver walks every Markdown file and runs three tiers inside a single SurrealQL transaction per note:
  - **Tier 1**: unified/remark parse, structure extraction, deterministic edges (`wikilink`, `embed`, `frontmatter_ref`, `tagged`, `contained_in`, `under_heading`).
  - **Tier 2**: chunker (target 400 tokens, max 800) plus embedder against your local embedding endpoint, writing 768-dim vectors.
  - **Tier 3**: concurrent extractor (concepts, claims, questions) and rank-based linker (kNN cosine + DBSCAN) producing semantic edges. Linker edges land with `approved = false` for operator review.
- **Three search strategies.**
  - `quick`: SurrealDB BM25 over `chunk.text`. Note: the daemon `search` RPC currently gates `quick` behind an Obsidian bridge probe and returns `BRIDGE_DOWN` without it. The agent loop's internal quick path runs against SurrealDB directly.
  - `balanced` (default): HNSW kNN over `chunk.vector` plus a Jaccard path-token boost (cubic, +0.30 cap) plus LLM rerank. Falls back to `quick` if embedding fails.
  - `deep`: Hybrid kNN+BM25 fusion (0.7·sim + 0.3·bm25), LLM rerank, 1-hop graph expansion over approved edges, grounded LLM synthesis with `[[wikilink]]` citations.
- **Citation-grounded ask.** `notient ask` returns `{ answer, citations, confidence, openQuestions }` from a non-interactive read-only agent loop. Verified on a 100-note dogfood pass with confidence ~0.94 on real BM25 questions.
- **TUI chat.** `notient chat` (no prompt) opens an `@opentui/react` TUI with slash commands, `@`-completion against vault paths, persistent history, and a status bar reporting model, pending tool calls, and approximate token usage.
- **Approval gate.** Four write-side `notes.*` tools (`create`, `append`, `replace_section`, `update_frontmatter`) plus `proposals.approve` / `proposals.reject` are blocked until you run `/approve <callId>` (or `/deny <callId>`) in the TUI, or until a session grant covers them.

---

## Architecture at a glance

Three boundaries to keep in mind:

```
  notient CLI / TUI
        │
        │  Unix Domain Socket  (envelope codec, MethodDispatcher,
        │                       AsyncIterable<RpcResponseFrame>)
        ▼
   notient daemon  ────────►  SurrealDB 3.0.5 child process
   (one per vault)            (namespace=notient, database=vault,
        │                      schema applied at boot)
        │
        │  HTTP (OpenAI-compatible)
        ▼
   LM Studio / llama.cpp
   (chat, structured JSON, vision, embeddings)
```

- **CLI ↔ daemon over UDS.** The CLI connects to a per-vault socket and spawns the daemon on demand if no socket exists. Streams come back as `AsyncIterable<RpcResponseFrame>`.
- **Daemon ↔ SurrealDB.** The daemon owns the `surreal` child process. All persistence routes through `SurrealConnection`. Schema is applied at startup from `dist/schema.surql` plus runtime-emitted edge tables.
- **Daemon ↔ LLM.** Every chat, structured JSON call, vision call, and embedding goes through `LLMProvider`. The current production implementation is `LMStudioProvider`. Vision is probed at boot.
- **Watcher.** chokidar with `usePolling=true` for WSL paths and a 1000 ms interval. Markdown only. The 60-second tombstone window is what turns sequential `unlink`/`add` events into renames.
- **Coordinator.** Bridges `EventBus` signals (`note:indexed`, `indexer:tier3-done`) to background swarm agents. Reasoning-model concurrency is bounded by `chat.reasoningSlots` so it never silently oversubscribes a multi-slot local server.

---

## Quick start

### Prerequisites

- **Bun 1.3.10.** The bundle uses Bun-native APIs (`Bun.file`, Bun module resolution, `__require`). Running under `node` will fail.
- **A local OpenAI-compatible LLM server** (LM Studio, llama.cpp `server`, or any compatible alternative) with a chat model and an embedding model loaded.
- **SurrealDB 3.0.5** is bundled by way of the daemon spawning the `surreal` binary; integration tests require it on `PATH`.

### Configure your AI endpoint

Notient reads env vars from process env, then project `.env`, then `<vault>/.notient/.env` (the vault file wins for vault-scoped configuration):

```bash
NOTIENT_LLM_BASE_URL=http://192.168.86.143:1234/v1
NOTIENT_LLM_MODEL=nvidia-nemotron-3-nano-omni-30b-a3b-reasoning
NOTIENT_EMBED_MODEL=text-embedding-nomic-embed-text-v2-moe
NOTIENT_CONTEXT_TOKENS=200000
NOTIENT_REASONING_SLOTS=4
```

`NOTIENT_REASONING_SLOTS` should match your server's `-np` / `--parallel` slot count.

### Install and build

```bash
git clone https://github.com/akougkas/notient.git
cd notient
bun install
bun run build           # → dist/notient.js, dist/daemon.js, dist/schema.surql
```

### First run

```bash
bun dist/notient.js init ~/MyVault
bun dist/notient.js daemon start --vault ~/MyVault
bun dist/notient.js awaken --vault ~/MyVault --background
bun dist/notient.js awaken --vault ~/MyVault --status     # NDJSON until terminal
bun dist/notient.js chat --vault ~/MyVault                # opens the TUI
```

Always invoke the bundle as `bun dist/notient.js <verb>`. The build is Bun-native and is not Node-compatible.

---

## CLI verbs

Top-level dispatch lives in `src/cli/index.ts`. Global flags: `--vault <path>`, `--as <agent>` (client identity), output mode `--json|--ndjson|--pretty`. Each verb supports `--help`.

| Verb | Purpose | Example |
|---|---|---|
| `init <vault>` | Create `<vault>/.notient/` config and record `lastVault`. | `bun dist/notient.js init ~/MyVault` |
| `daemon start\|stop\|status\|list` | Lifecycle of the per-vault daemon. | `bun dist/notient.js daemon start --vault ~/MyVault` |
| `awaken` | Run the full vault enrichment pipeline. Flags: `--batch`, `--since`, `--tier`, `--background`, `--pause`, `--resume`, `--cancel`, `--status`. | `bun dist/notient.js awaken --vault ~/MyVault --background` |
| `reindex [<glob>]` | Re-index a subset by pattern and/or tier. | `bun dist/notient.js reindex "Inbox/**/*.md" --vault ~/MyVault --tier 2,3` |
| `search <query>` | Streaming search. `--mode quick\|balanced\|deep` (default balanced), `--limit`. | `bun dist/notient.js search "vector search" --vault ~/MyVault --mode deep` |
| `ask <intent>` | Read-only citation-grounded agent ask. `--format structured\|text`, `--max-rounds`. | `bun dist/notient.js ask "what does the vector search note claim" --vault ~/MyVault` |
| `brief <topic\|--file>` | Synthesised topic brief. `--max-notes`, `--max-questions`, `--max-decisions`. | `bun dist/notient.js brief "vector search" --vault ~/MyVault` |
| `distill --from <transcript>` | Extract proposed notes/edges from a Markdown transcript. | `bun dist/notient.js distill --from chat.md --vault ~/MyVault --dry-run` |
| `chat [prompt]` | Single-shot if `prompt` is given, else launches the TUI. `--approve auto\|ask`. | `bun dist/notient.js chat --vault ~/MyVault` |
| `vitals <note-path>` | Health/freshness/connectivity snapshot for one note. | `bun dist/notient.js vitals "0002-vector-search.md" --vault ~/MyVault` |
| `health` | Substrate + bridge probes. | `bun dist/notient.js health --vault ~/MyVault` |
| `events` | Drain the `agent_event` ledger. `--since`, `--limit`, `--long-poll-ms`, `--no-poll`. | `bun dist/notient.js events --vault ~/MyVault --long-poll-ms 5000` |
| `session list\|grant\|revoke` | Manage scoped trust grants for unattended writes. | `bun dist/notient.js session grant --vault ~/MyVault --tools notes.append --ttl 30` |
| `graph dump\|stats` | Export nodes/edges or print counts. | `bun dist/notient.js graph stats --vault ~/MyVault --json` |
| `links sync\|audit` | Resolve wikilinks/embeds or report unresolved targets. | `bun dist/notient.js links audit --vault ~/MyVault --json` |
| `proposals list\|approve\|reject` | Operator queue for linker edge proposals. | `bun dist/notient.js proposals list --vault ~/MyVault` |
| `db sql` | Interactive SurrealQL REPL bound to the daemon's connection. | `bun dist/notient.js db sql --vault ~/MyVault` |
| `backup` | SurrealQL dump under `<vault>/.notient/backups/`. | `bun dist/notient.js backup --vault ~/MyVault` |
| `restore <file.surql>` | Replay a dump into the daemon's database. | `bun dist/notient.js restore backup.surql --vault ~/MyVault` |
| `nuke --yes` | Delete `<vault>/.notient/db/` and reset graph state. | `bun dist/notient.js nuke --vault ~/MyVault --yes` |
| `migrate-vault <new-path>` | Relocate a vault and rewrite `lastVault`. | `bun dist/notient.js migrate-vault /new/path --vault /old/path` |

Run `<verb> --help` for the full flag set.

---

## TUI reference

`notient chat` (no positional prompt) starts the `@opentui/react` TUI defined in `src/cli/tui/runtime.tsx`.

**Slash commands:** `/read <path>`, `/search <query>`, `/awaken`, `/vitals <path>`, `/health`, `/model` (no-arg show), `/model list`, `/model use <id>`, `/model embed <id>`, `/model endpoint <url>`, `/approve <callId> [reason]`, `/deny <callId> [reason]`, `/proposals [page]`, `/approve-edge <id>`, `/reject-edge <id> [reason]`, `/undo`, `/history`, `/copy` (saves last reply to `<vault>/.notient/last.txt`), `/clear`, `/help`, `/quit` (alias `/exit`). The proposals view also accepts `a` and `r` to approve or reject the first visible row.

**Keybindings:** Enter submits; Shift+Enter and Alt+Enter insert a newline; Ctrl+C exits; Ctrl+U cuts to start of line; Ctrl+W kills the previous word; Tab triggers `@`-completion against vault paths; Up/Down walk the input history (persisted to `<vault>/.notient/history.txt`); PgUp/PgDn scroll the chat viewport.

**Chat tools (`src/agent/toolBundle.ts`):**

- Read-only: `vault.search_notes`, `vault.read_note`, `vault.list_neighbors`, `vault.get_vitals`, `proposals.list_pending`, `proposals.get`, `graph.find_path`, `graph.list_clusters`. (`agents.contradiction_check` and `agents.synthesize` are wired but currently no-op shells.)
- Write-gated, requires `/approve` or a session grant: `notes.create`, `notes.append`, `notes.replace_section`, `notes.update_frontmatter`, `proposals.approve`, `proposals.reject`.

When a write-gated tool is invoked, the agent loop pauses, the status bar shows `pending:N`, and the TUI prints the call id. Use `/approve <callId>` to apply or `/deny <callId>` to abort.

---

## Configuration

Environment variables (vault `.notient/.env` wins over project `.env` wins over process env):

| Var | Purpose | Default |
|---|---|---|
| `NOTIENT_LLM_BASE_URL` | OpenAI-compatible base URL. | required |
| `NOTIENT_LLM_MODEL` | Chat / reasoning / extraction model id. | required |
| `NOTIENT_EMBED_MODEL` | Embedding model id. | required |
| `NOTIENT_CONTEXT_TOKENS` | Per-request/slot budget. | `200000` |
| `NOTIENT_REASONING_SLOTS` | Concurrent reasoning calls. Match server `-np`. | `4` |

`<vault>/.notient/config.toml` (loaded once at boot; restart to apply changes):

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

`<vault>/.notient/config.json` carries the richer `NotientSettings` shape: primary/deep `LLMEndpointConfig`, embedding endpoint, agent toggles, approvals, search defaults, vitals weights, chat policy (`approvalMode safe|yolo`, `modelContextTokens`, `reasoningSlots`, `perTool` map, `conversationsFolder`, `proposalsFolder`, `maxRoundsPerTurn`, `contextBudgetFraction`), history retention, and `indexer.excludePaths` (defaults: `Notient/conversations`, `Notient/proposals`, `Notient/searches`).

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
- No `notes.delete` and no `notes.rename` chat tools. `notes.*` exposes only `create`, `append`, `replace_section`, `update_frontmatter`. Renames happen only through filesystem + watcher's tombstone-window heuristic.
- `agents.contradiction_check` and `agents.synthesize` chat tools are Phase 5 no-op shells; the underlying agents do not yet write back.
- The Obsidian bridge (`src/bridge/`) is a vestige of the pre-pivot plugin era. It is only required by the quick-search guard above.
- Integration tests (`bun run test:integration`, `NOTIENT_SMOKE=1`) were not run in the most recent dogfood pass.

---

## Development

```bash
bun run typecheck         # tsc --noEmit (covers src/, testing/, tools/)
bun run lint              # biome check src/ testing/
bun run lint:fix          # biome check --write src/ testing/
bun run format            # biome format --write src/ testing/
bun run build             # alias for build:cli
bun run build:cli         # bun tools/build-cli.ts → dist/notient.js
bun run test              # bun test testing/unit (fast, no external deps)
bun run test:integration  # NOTIENT_SMOKE=1 bun test testing/integration (spawns SurrealDB)
bun run test:all          # test then test:integration
```

**Test layout.** No tests live under `src/`. Unit tests are in `testing/unit/<mirror>` and run on every CI push. Integration tests are in `testing/integration/<mirror>`, gated on `process.env.NOTIENT_SMOKE === "1"` via `describe.skipIf(...)`, and require the `surreal` binary on `PATH`. Shared markdown samples live in `testing/fixtures/markdown/`. Standalone live-LM-Studio harnesses in `tools/smoke-cli-phase{A,B,C,D,D1}.ts` exercise the daemon end-to-end and are not part of `bun test`.

**Adding a test.** Mirror the source path under `testing/unit/` (or `testing/integration/` if it spawns SurrealDB, a subprocess, or real chokidar). Imports traverse back to source via `../../../../src/...`. Path aliases are `@/*` → `src/*` and `@core/*` → `src/core/*`.

---

## Philosophy

- **Local-only.** No cloud APIs. Every model call hits a local OpenAI-compatible endpoint you run.
- **Human-in-the-loop.** Writes are gated by an approval flow or an explicit session grant. The agent never silently mutates the vault.
- **Citation-grounded.** Answers cite `[[wikilinks]]` to actual notes. The synthesis step in deep search and the `ask` agent both require evidence.

---

## License

MIT. See `LICENSE`.
