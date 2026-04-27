# Notient v0.1 — Local-first Agentic CLI for Sentient Vaults

> Design spec. Date: 2026-04-27. Branch: `beta-spec`. Supersedes the never-shipped 4-agent-swarm framing in `.claude/CLAUDE.md` and the Obsidian plugin product surface archived under `.nuked/`.

---

## 1. Product framing

**Notient v0.1 is a local-first agentic CLI for sentient vaults.** A single binary, `notient`, that lets a human or another agent (Claude Code, Codex, Aider, scripts) hold a multi-turn conversation with a single local LLM that understands a specific vault: its notes, its links, its contradictions, its drift, its silences. The vault is not a static folder; the daemon keeps thinking about it in the background, surfacing proposals (new links, contradiction pairs, synthesis clusters, maturity bumps) that the user reviews and accepts. Obsidian, when it is running, is the editor and the source of truth for live state; Notient is the brain.

### Three personas

1. **Human at a TTY.** Types `notient`, lands in a chat REPL. Asks "what did I write last week about test-driven development?" or "find contradictions in my Phase 4 thinking" or "summarize note X with citations". The agent uses tools, streams reasoning, cites sources. Slash escapes to raw commands.
2. **Human in a one-shot.** `notient search query="…" --json`, `notient awaken`, `notient stream --pretty`, `notient apply <id>`. Scriptable, pipeable, deterministic.
3. **Agentic consumer.** Claude Code runs `notient schema` to discover the surface, then `notient chat "…" --ndjson` or `notient search query="…" --json` and parses the output. Notient is a tool the other agent uses to reason about the user's vault.

### Non-goals for v0.1

- No GUI, no Preact, no sidebar, no decorations, no canvas viewer.
- No remote LLM, no cloud sync, no telemetry, no analytics.
- No audio.
- No multi-user / multi-tenant.
- No write-side conflict resolution beyond Obsidian's own (the bridge is the arbiter).
- No plugin system for user-extensible Notient tools (deferred; add later as a `<vault>/.notient/tools/*.ts` loader).

### Tagline (working)

*"Your vault, alive, in the terminal."*

---

## 2. Architecture

### 2.1 Process model

One **daemon per vault**, many thin clients.

```
┌────────────────────────────────────────────────────────────────────┐
│  notient (CLI binary, single Bun-built executable)                 │
│  Entry: src/cli/index.ts                                            │
│                                                                     │
│  Modes:                                                             │
│    notient                          → spawns/connects daemon, TUI   │
│    notient <command> [args] [-f]    → spawns/connects daemon,       │
│                                       single-shot RPC, exit         │
│    notient daemon start|stop|status → daemon lifecycle              │
│    notient schema                    → emits JSON Schema, no daemon │
│    notient init <path>               → bootstraps a vault, no daemon│
└────────────────────────────────────────────────────────────────────┘
                                │
                  Unix socket / Windows named pipe
              <vault>/.notient/notient.sock (Linux/macOS)
              \\.\pipe\notient-<hash>     (Windows)
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│  Daemon (one per vault, idle-exits after N hours)                  │
│  Entry: src/daemon/index.ts → bootstrap() → seal kernel            │
│                                                                     │
│  RPC server: NDJSON over socket                                     │
│  Notient Agent: single LLM, multi-turn loop, tool registry         │
│  Obsidian Bridge | FS Vault Adapter | Substrate tools              │
│  Coordinator: autonomous subagents, pause-on-chat                   │
└────────────────────────────────────────────────────────────────────┘
```

**Auto-spawn rule.** Every client first attempts `connect()`. On `ENOENT` or `ECONNREFUSED`, the client forks `notient daemon start --vault <path> --detached`, polls for socket readiness up to 3 seconds, then connects. The daemon stays warm; subsequent invocations skip the spawn.

**Idle exit.** The daemon tracks `lastRequestAt`. After 4 hours with no client requests AND no autonomous-coordinator activity, it calls `kernel.close()` (persists DB, persists vectors, releases lock) and exits. Tunable via `<vault>/.notient/config.json` → `daemon.idleExitHours`. Set to `0` to keep the daemon up forever.

**Concurrency.** One daemon per vault. The daemon serializes LLM calls through the existing `ReasoningMutex` (chat priority > agent priority). Concurrent RPC connections are accepted; reads (DB+HNSW only) run in parallel with chat turns.

### 2.2 Layered architecture

```
┌────────────────────────────────────────────────────────────┐
│  CLI / TUI (OpenTUI React reconciler, Bun-native)          │
├────────────────────────────────────────────────────────────┤
│  Notient Agent — single LLM, multi-turn loop, tools        │
├────────────────────────────────────────────────────────────┤
│  Obsidian Bridge          │   FS Vault Adapter             │
│  shell-out to `obsidian`  │   reads/writes vault on disk   │
│  CLI when app is running  │   when app is not running OR   │
│  (live buffers, plugins,  │   when the agent needs raw     │
│   daily, templates, eval) │   bytes (chunking, embedding,  │
│                           │   HNSW, sql.js, sidecars)      │
├────────────────────────────────────────────────────────────┤
│  Notient substrate (unchanged):                            │
│  Database, HNSW, IndexerQueue, SearchPipeline,             │
│  SubAgents (linker, synthesizer, contradictionHunter,      │
│  maturityAdvancer), Coordinator, Stream, Vitals,           │
│  Approvals, History, NativeGraphBridge, EchoGuard          │
└────────────────────────────────────────────────────────────┘
```

### 2.3 Module layout

```
src/
├── cli/
│   ├── index.ts              # binary entry; arg parser; mode dispatcher
│   ├── client.ts             # daemon RPC client (auto-spawn, auto-reconnect)
│   ├── tui/
│   │   ├── App.tsx           # OpenTUI root, layout
│   │   ├── ChatView.tsx      # streaming transcript via <Markdown>+<Code>
│   │   ├── InputBar.tsx      # multi-line input with history, completion
│   │   ├── StatusBar.tsx     # daemon | bridge | indexer | model | mutex
│   │   ├── ProposalPanel.tsx # split-pane proposals (toggle on/off)
│   │   ├── slashCommands.ts  # /read /search /awaken /stream /undo /quit
│   │   ├── attachments.ts    # @<path> resolver (md/pdf/code/canvas/base/image)
│   │   └── completion.ts     # tab completion: paths, slash commands, params
│   ├── output.ts             # JSON / NDJSON / --pretty emitter
│   ├── commands/             # one file per single-shot command
│   │   ├── init.ts
│   │   ├── awaken.ts
│   │   ├── search.ts
│   │   ├── chat.ts
│   │   ├── vitals.ts
│   │   ├── stream.ts
│   │   ├── apply.ts
│   │   ├── undo.ts
│   │   ├── history.ts
│   │   ├── propose.ts
│   │   ├── exportCanvas.ts
│   │   ├── health.ts
│   │   ├── schema.ts
│   │   ├── daemon.ts
│   │   └── obsidian.ts       # passthrough to bridge for Obsidian-mirror verbs
│   ├── env.ts                # vault resolution, env var, cwd walk
│   └── schema/
│       └── registry.ts       # single source of truth for commands/tools/events
│
├── daemon/
│   ├── index.ts              # daemon entry; bootstraps kernel; opens socket
│   ├── bootstrap.ts          # extracted from old src/main.ts; kernel wiring
│   ├── rpc.ts                # NDJSON-over-socket protocol; method dispatch
│   ├── lifecycle.ts          # idle-exit timer; PID file; graceful shutdown
│   └── socket.ts             # platform-aware socket path / named pipe
│
├── adapters/
│   ├── vaultAdapter.ts       # VaultAdapter interface (extracted from VaultIO)
│   └── fsVault.ts            # FS implementation (replaces obsidianFacade.ts)
│
├── bridge/
│   ├── obsidianCli.ts        # shell-out to `obsidian`, parse output, capability map
│   ├── obsidianProbe.ts      # liveness probe + version check, 30s polling
│   └── parsers.ts            # JSON/TSV/text response parsers per command
│
├── agent/
│   ├── notientAgent.ts       # the chat agent (wraps existing agentLoop + tools)
│   ├── identity.ts           # Tier 1 system prompt (single agent, not swarm)
│   ├── attachments.ts        # @<path> resolver (md/pdf/code/canvas/base/image)
│   └── tools/
│       ├── vault.ts          # auto-routes Bridge / FS
│       ├── obsidian.ts       # strict-Obsidian verbs (eval, command, plugin:reload)
│       ├── substrate.ts      # search_deep, vitals, stream, apply, undo, propose
│       └── subagent.ts       # on-demand specialists
│
└── core/                     # UNCHANGED — substrate is locked
```

### 2.4 Substrate boundaries (locked)

- **Reasoning host:** dynamo `http://192.168.86.143:1234/v1` (LMStudio).
- **Chat model:** `nemotron-cascade-2-30b-a3b-i1`.
- **Embedding model:** `text-embedding-nomic-embed-text-v2-moe` (Ollama).
- **Database:** sql.js + sql-wasm.wasm.
- **Vectors:** hnswlib-wasm.
- **TUI runtime:** OpenTUI (`@opentui/core@0.1.105` + `@opentui/react@0.1.105`), pinned.
- **Vault data root:** `<vault>/.notient/` (config, db, vectors, lock, sidecars).
- **Notient is not an Obsidian plugin.** Persistence is independent of `<vault>/.obsidian/`.

### 2.5 Dependency churn

```diff
+ "@opentui/core": "0.1.105"     # pinned
+ "@opentui/react": "0.1.105"    # pinned
+ "chokidar": "^4.x"             # vault watcher, WSL-aware
+ "unpdf": "^0.x"                # PDF text extraction (Bun-compatible)

- "obsidian": "^1.4.11"          # plugin SDK
- "preact": "^10.28.2"
- "@preact/signals": "^2.5.1"
- "marked": "^17.0.1"
- "prismjs": "^1.30.0"
- "@types/prismjs": "^1.26.5"
- "preact-render-to-string": "^6.6.7"
```

`package.json` adds `"bin": { "notient": "./dist/notient.js" }` and scripts `build:cli` (wraps `bun build --compile`) and `smoke:cli:phase{A..E}`.

---

## 3. Notient Agent

### 3.1 Tier 1 identity

> *You are Notient, the steward of a sentient vault. You live in your user's terminal. The vault is a directory of markdown notes the user has been thinking in for some time; it has structure, drift, contradictions, half-formed ideas. You have tools to read, write, search, link, contradict-check, synthesize, and surface what the substrate has been noticing in the background while the user wasn't looking.*
>
> *Your operating mode is human-in-the-steering-wheel. You don't write to the vault without permission unless the user has set yolo mode. You cite. You hedge when uncertain. You name your sources by note path. You respect the substrate's existing proposals and never duplicate work the background subagents have already queued.*
>
> *Obsidian, when running, is the editor and the source of truth for live state. When it's down, you read the vault directly. Either way, the user's notes are the ground.*
>
> *You are local. You run on the user's hardware. Nothing leaves the box.*

### 3.2 Eight-layer system prompt

| Layer | Content | Source |
|---|---|---|
| 1. Tier 1 identity | The text above | `src/agent/identity.ts` |
| 2. Voice profile | User's optional voice preferences | `<vault>/.notient/config.json` → `agent.voice` |
| 3. Vault snapshot | size, awakened-at, total notes/chunks/proposals | DB query at turn start |
| 4. Workspace state (Obsidian-up) OR Recent files (FS-only) | active note, open notes, recent searches | Bridge / daemon state |
| 5. Cross-session memory | Top-K most-similar previous conversation summaries | `ConversationIndex.search()` |
| 6. Pinned context | `@<path>` attachments resolved, with `[image: …]` markers when vision is engaged | `src/cli/tui/attachments.ts` |
| 7. Tool catalog | Tool names + one-line descriptions | `ToolRegistry.list()` |
| 8. Approval mode | "safe" / "yolo" + per-tool overrides | Settings |

### 3.3 Tool surface (v0.1)

```
# Vault tools — auto-route Obsidian Bridge / FS Adapter
vault.read(path)
vault.write(path, content, {approve?})
vault.append(path, content, {inline?, approve?})
vault.prepend(path, content, {approve?})
vault.replace_section(path, heading, content)
vault.update_frontmatter(path, patch)
vault.create(path, content, {template?})
vault.move(from, to)
vault.rename(path, name)
vault.delete(path, {permanent?})
vault.list({folder?, ext?})
vault.search(query, {mode: quick|balanced|deep})
vault.outline(path)
vault.backlinks(path)
vault.links(path)
vault.tags({path?})
vault.tasks({path?, status?, daily?})
vault.task_toggle(path, line)
vault.properties({path?, name?})
vault.daily()
vault.daily_append(content)

# Obsidian-only tools — fail visibly when bridge is down
obsidian.eval(code)
obsidian.command(id)
obsidian.commands({filter?})
obsidian.plugin_reload(id)
obsidian.workspace()
obsidian.base_query(file, view, format=json)

# Notient substrate tools — only Notient
notient.search_deep(query, {graphDepth?, synthesis?})
notient.vitals(path)
notient.stream({limit?, agent?})
notient.apply(proposalId, {dry?})
notient.reject(proposalId)
notient.undo({steps?, target?})
notient.history({limit?, target?})
notient.propose(kind, payload)
notient.export_canvas(proposalId)
notient.health()
notient.awaken({batch?, since?})

# Subagent dispatch — on-demand specialists
subagent.linker(notePath, {topK?})
subagent.synthesizer({sinceMs?, epsilon?})
subagent.contradiction_hunter({recentDays?, noteIds?})
subagent.maturity_advancer(notePath)
```

### 3.4 Approval policy

Existing `safe` / `yolo` modes are kept. Per-tool policy layers on top:

```jsonc
{
  "agent": {
    "approvalMode": "safe",
    "perTool": {
      "vault.read":          "auto",
      "vault.write":         "ask",
      "vault.append":        "ask",
      "notient.apply":       "ask",
      "notient.undo":        "auto",
      "obsidian.eval":       "ask",
      "subagent.*":          "auto"
    }
  }
}
```

`ask` fires the existing `ApprovalGate`. `auto` is pre-approved. In `yolo` mode the default for unspecified tools flips to `auto`, but per-tool `ask` overrides stay gated (so `obsidian.eval: ask` is gated even in yolo).

### 3.5 Multi-modal (text + vision, no stubs)

Two paths to vision:

1. **Primary chat model is vision-capable.** Image is sent inline as OpenAI-style `image_url` content. Detected via probe at first image attachment.
2. **Separate `visionLLM` provider** is configured pointing at a VLM endpoint (e.g. mini server). Image is sent there for description; description injected as text into chat context with `[image: foo.png] <model-described-content>` marker. Configured via `<vault>/.notient/config.json` → `vision.endpoint`.

Neither available + image attachment present → fail immediately with `VISION_UNAVAILABLE` and remediation text:

> *"Vision is not supported in this session. Either (a) load a multi-modal model in LMStudio at `<primary baseUrl>`, or (b) configure `vision.endpoint` in `<vault>/.notient/config.json` pointing at a VLM endpoint."*

No stubs. The agent never sees a synthetic `[image: …]` marker that wasn't produced by a real vision model.

### 3.6 Subagent execution

Hybrid: autonomous + on-demand.

- **Autonomous.** `Coordinator` runs inside the daemon. When the system is idle (no chat turn in flight, no awaken running), it schedules subagents in priority order against the `ReasoningMutex`. They scan recent notes, find links / contradictions / cluster opportunities, and write proposals to `staging_edges` / `staging_nodes`. Visible via `notient stream` or `/stream` in the TUI. This is what makes notes "sentient".
- **On-demand.** Each subagent is also exposed as a tool (`subagent.contradiction_hunter`, etc.) the main Notient agent calls explicitly. Same code path, same staging tables, same approval gate.

**Pause-on-chat.** Autonomous subagents naturally yield when chat starts via `ReasoningMutex` priority (`chat` > `agent`). LMStudio serves only one inference at a time; the mutex enforces it.

---

## 4. Daemon RPC, NDJSON event taxonomy, schema discovery

### 4.1 Transport

NDJSON over Unix socket / Windows named pipe. One JSON object per line, both directions.

**Socket location:**
- Linux/macOS/WSL2: `<vault>/.notient/notient.sock`
- Windows native: `\\.\pipe\notient-<sha8(absolute-vault-path)>`

The daemon writes `<vault>/.notient/notient.lock` with `{ pid, instanceId, socketPath, startedAt, version }`.

### 4.2 Envelopes

Request:
```json
{ "id": "req-7c2", "method": "chat.send", "params": { "conversationId": "...", "userMessage": "..." } }
```

Response/event stream (multiple lines per request):
```json
{ "id": "req-7c2", "type": "ack", "method": "chat.send" }
{ "id": "req-7c2", "type": "event", "event": "turn:start", "conversationId": "...", "userMessage": {...} }
{ "id": "req-7c2", "type": "event", "event": "loop:tool_call_started", "callId": "tc-1", "tool": "vault.search", "args": {...} }
{ "id": "req-7c2", "type": "event", "event": "loop:tool_call_result", "callId": "tc-1", "result": {...}, "bridge": "obsidian" }
{ "id": "req-7c2", "type": "event", "event": "loop:assistant_delta", "contentDelta": "Looking at your" }
{ "id": "req-7c2", "type": "event", "event": "loop:done", "finalMessage": {...} }
{ "id": "req-7c2", "type": "event", "event": "turn:complete", "conversation": {...} }
{ "id": "req-7c2", "type": "result", "ok": true }
```

Error:
```json
{ "id": "req-7c2", "type": "error", "code": "BRIDGE_DOWN", "message": "obsidian.eval requires Obsidian running.", "detail": {...} }
```

**Standard error codes:** `BRIDGE_DOWN`, `BRIDGE_TIMEOUT`, `LLM_UNAVAILABLE`, `LLM_TIMEOUT`, `VECTOR_INIT_FAILED`, `DB_LOCKED`, `APPROVAL_DENIED`, `APPROVAL_PENDING`, `INVALID_VAULT`, `INVALID_PROPOSAL`, `VISION_UNAVAILABLE`, `INVALID_PARAMS`, `INTERNAL`.

### 4.3 Event taxonomy

| Event | Producer | Carries |
|---|---|---|
| `daemon:starting` | daemon | `version`, `pid`, `socketPath` |
| `daemon:ready` | daemon | `vault`, `awakenedAt`, `bridgeState` |
| `daemon:shutting_down` | daemon | `reason` |
| `bridge:up` / `bridge:down` | obsidianProbe | `version?`, `error?` |
| `health:tick` | healthMonitor | `primary`, `embedding`, `vision`, `bridge` |
| `indexer:queued` | indexerQueue | `path` |
| `indexer:progress` | indexerQueue | `processed`, `total`, `currentPath` |
| `indexer:note_indexed` | indexerQueue | `path`, `chunks`, `embeddings`, `nodes`, `edges` |
| `indexer:complete` | indexerQueue | `total`, `durationMs` |
| `indexer:error` | indexerQueue | `path`, `error` |
| `coordinator:agent_start` | coordinator | `agent`, `runId`, `trigger` |
| `coordinator:agent_done` | coordinator | `runId`, `agent`, `proposals`, `durationMs`, `ok`, `error?` |
| `coordinator:proposal` | coordinator | `proposalId`, `kind`, `agent`, `score`, `evidence` |
| `search:retrieving` | searchPipeline | `mode` |
| `search:hits` | searchPipeline | `hits[]` |
| `search:expanding` | searchPipeline (deep) | `seedHits`, `depth` |
| `search:synthesizing` | searchPipeline (deep) | `clusterCount` |
| `search:done` | searchPipeline | `result` |
| `search:error` | searchPipeline | `message` |
| `turn:start` | chatService | `conversationId`, `userMessage` |
| `turn:complete` | chatService | `conversation` |
| `turn:aborted` | chatService | `reason` |
| `loop:assistant_delta` | agentLoop | `contentDelta` |
| `loop:reasoning_delta` | agentLoop | `reasoningDelta` |
| `loop:tool_call_started` | agentLoop | `callId`, `tool`, `args`, `bridge?` |
| `loop:tool_call_result` | agentLoop | `callId`, `result`, `durationMs`, `bridge` |
| `loop:tool_call_error` | agentLoop | `callId`, `error`, `code` |
| `loop:approval_pending` | approvalGate | `callId`, `tool`, `args`, `proposed?`, `risk?` |
| `loop:approval_resolved` | approvalGate | `callId`, `approved`, `reason?` |
| `loop:done` | agentLoop | `finalMessage`, `toolMessages` |
| `loop:error` | agentLoop | `message`, `code` |
| `vitals:snapshot` | vitalsService | `path`, `health`, `freshness`, `connectivity`, `maturity` |
| `stream:item` | streamService | `item` |
| `stream:resorted` | streamService | `items[]` |
| `apply:start` | approvalService | `proposalId`, `kind` |
| `apply:done` | approvalService | `proposalId`, `targets[]`, `historyId` |
| `apply:error` | approvalService | `proposalId`, `error`, `code` |
| `undo:start` | historyService | `historyId`, `kind`, `target` |
| `undo:done` | historyService | `historyId`, `restoredTo` |
| `vision:probing` | visionLLM | `provider` |
| `vision:result` | visionLLM | `path`, `description` |
| `vision:unavailable` | visionLLM | `reason`, `remediation` |

### 4.4 RPC method catalog

```
# Lifecycle
daemon.status()
daemon.shutdown()
daemon.config_get(path?)
daemon.config_set(patch)

# Chat
chat.start(topic?, pinnedContext?)
chat.send(conversationId, userMessage, attachments?)   # streams loop:* + turn:*
chat.abort(conversationId)
chat.list(limit?)
chat.load(notePath)

# Vault (auto-route Bridge / FS)
vault.exec(verb, params)                                # streams events per verb

# Search
search.run(query, mode, filters?)                       # streams search:*

# Indexer
awaken.run({batch?, since?})                            # streams indexer:*
reindex.glob(pattern)                                   # streams indexer:*

# Vitals
vitals.get(path)

# Stream / proposals / approvals
stream.list({limit?, agent?, kind?})
stream.subscribe()                                      # live feed of stream:item
apply.proposal(proposalId, dry?)                        # streams apply:*
reject.proposal(proposalId, reason?)
propose.create(kind, payload)

# History / undo
history.list({limit?, target?})
undo.last({steps?})                                     # streams undo:*
undo.target(historyId)                                  # streams undo:*

# Subagent dispatch (on-demand)
subagent.dispatch(name, params)                         # streams coordinator:*

# Canvas export
canvas.export(proposalId, outputPath?)

# Health
health.probe()
```

### 4.5 `notient schema`

Self-describing surface for agentic consumers. Single command, no daemon required. Prints a JSON Schema document covering every CLI command, every RPC method, every tool, every NDJSON event type, every error code, and the per-vault config schema.

```bash
notient schema                       # full schema, JSON
notient schema --section commands
notient schema --section tools
notient schema --section events
notient schema --section rpc
notient schema --section errors
notient schema --section config
```

Schema is generated from `src/cli/schema/registry.ts` — single source of truth so commands, tools, RPC methods, and `--help` output never drift.

---

## 5. External surface conventions

### 5.1 Vault data location

```
<vault>/.notient/
├── config.json          # per-vault settings
├── notient.db           # sql.js database
├── notient.lock         # vault lock + daemon PID
├── sql-wasm.wasm        # bundled, copied on init
├── vectors.bin          # HNSW persisted index
├── conversations/       # markdown chat logs
├── proposals/           # synthesis canvases + proposal markdown
├── searches/            # saved search results as markdown / canvas
└── logs/                # daemon stdout/stderr per session
```

Dot-prefixed so Obsidian's file explorer hides it and the indexer skips it.

### 5.2 Command syntax

- **Obsidian-mirror commands** accept `parameter=value` syntax verbatim:
  ```
  notient daily
  notient daily:append content="- [ ] Buy groceries"
  notient search query="meeting notes"
  notient read file=Recipe
  notient tasks daily
  notient base:query file=Library view=Authors format=json
  ```
- **Notient-native commands** accept POSIX `--flag value` and `--flag=value`:
  ```
  notient awaken --batch 10
  notient chat "summarize my Phase 4 thinking" @notes/phase-4.md
  notient stream --limit 20 --agent contradictionHunter
  notient apply <proposalId> --dry
  ```
- **Global flags** work everywhere: `--vault <path>`, `--json` (default for non-TTY), `--ndjson`, `--pretty` (default for TTY), `--timeout <ms>`, `--quiet`, `--copy`.
- The TUI accepts both forms transparently.

### 5.3 Multi-vault resolution

1. `--vault <path>` flag wins.
2. `NOTIENT_VAULT` env var.
3. Cwd has `.notient/` or `.obsidian/`.
4. Walk up parents.
5. `~/.config/notient/state.json` `lastVault`.
6. Fail with `"No vault. Run 'notient init <path>' first."`.

The daemon process pool keys on absolute vault path. `notient daemon list` shows running daemons; `notient daemon stop --vault <path>` terminates one.

### 5.4 Obsidian degraded mode

Daemon probes `obsidian help` on startup, then polls every 30 seconds. Bridge state is part of every chat turn's context.

| Bucket | When Obsidian up | When Obsidian down |
|---|---|---|
| Read-style (`read`, `tasks`, `tags`, `links`, `backlinks`, `outline`, `search`, `wordcount`, `properties`, `aliases`, `random`, `files`, `folders`, `daily*`, `wordcount`) | Delegate to `obsidian` CLI. | FS adapter silently. Daily-note path resolved from `<vault>/.obsidian/daily-notes.json` or sane defaults. |
| Write-style (`create`, `append`, `prepend`, `move`, `rename`, `delete`, `daily:append`, `daily:prepend`, `property:set`, `property:remove`, `task` toggle, `bookmark`) | Delegate to `obsidian` CLI so link-update fires. | FS atomic-write via existing `atomicWrite` + `mergeFrontmatter`. Internal-link updates on rename/move are best-effort. |
| Strict-Obsidian (`eval`, `devtools`, `dev:*`, `plugin:*`, `theme:*`, `commands` / `command id=`, `hotkeys`, `workspace*`, `tab:*`, `web`, `publish:*`, `sync*`, `base:query`) | Delegate. | Fail with `BRIDGE_DOWN` and remediation text. |

Tool results carry `bridge: "obsidian" | "fs"` so the agent can mention the mode if it matters.

Auto-launch is opt-in via `<vault>/.notient/config.json` → `obsidian.autoLaunch: true`. Default `false`.

### 5.5 Index freshness

Daemon owns a chokidar watcher on the vault root. On Linux/macOS/Windows native: inotify / ReadDirectoryChangesW. Watcher debounces 500ms, filters via `excludePaths`, pushes to `IndexerQueue.enqueue`.

**WSL2 detection.** If `/proc/version` contains `microsoft` AND vault path matches `/mnt/[a-z]/`, daemon switches to **polling mode**: 3s tick, 200-stat budget per pass.

`EchoGuard` prevents loops: write tools pre-mark SHA, watcher computes SHA, sees match, skips reindex.

---

## 6. Phase plan and delivery gates

Five phases. One commit per logical step. One gate command per phase. No phase claims done without the gate green AND a live end-to-end run against the fixture vault.

### Phase A — Scaffold, nuke, FS adapter, daemon skeleton

*Goal:* Every Obsidian-coupled file is gone (archived to `.nuked/`) or rebound. Daemon socket opens. `notient init` and `notient daemon {start,stop,status}` work over the wire. Substrate tests still green.

**Deliverables:**
1. New dirs: `src/cli/`, `src/daemon/`, `src/bridge/`, `src/agent/`, `src/adapters/`.
2. `src/adapters/vaultAdapter.ts` extracts the `VaultIO` contract + extensions.
3. `src/adapters/fsVault.ts` implements `VaultAdapter` over `node:fs` + existing `atomicWrite`.
4. Rebind ~12 substrate consumers: `NativeGraphBridge`, `VitalsService`, `ConversationStore`, `ConversationIndex`, `SavedQueries`, `SearchHistory`, `CanvasFromResults`, `MaturityAdvancer`, `VaultBootstrap`, history inverters, `CoAuthor`.
5. `SettingsService` rebind: constructor takes a generic `{ load(); save(value) }` shape backed by `<vault>/.notient/config.json`.
6. `src/daemon/{index,bootstrap,rpc,socket,lifecycle}.ts`. Methods: `daemon.status`, `daemon.shutdown`, `daemon.config_get`, `daemon.config_set`.
7. `src/cli/{index,client,commands/init,commands/daemon,output,env}.ts`. Auto-spawn-daemon-on-first-call works.
8. **Archive (move-to-`.nuked/`):** `src/main.ts`, `src/adapters/obsidianFacade.ts` + test, `src/ui/**`, `src/styles.css`, `manifest.json`, `src/core/settings/SettingsTab.ts`, obsolete planning docs.
9. Drop deps: `obsidian`, `preact`, `@preact/signals`, `marked`, `prismjs`, `@types/prismjs`, `preact-render-to-string`. Add: `chokidar`, `unpdf`, `@opentui/core@0.1.105`, `@opentui/react@0.1.105`.
10. `package.json` `bin` + scripts: `build:cli`, `smoke:cli:phaseA`.
11. `tests/fixtures/sentient-vault/` with ~10 markdown notes spanning topics, links, contradictions, frontmatter, tasks.
12. `.gitignore` += `/.nuked/`. `tsconfig.json` `exclude` += `".nuked"`. `biome.json` `files.ignore` += `.nuked/**`. `.claude/CLAUDE.md` Archive subsection.

**Gate:** `bun run typecheck && bun run lint && bun test && bun run build:cli && bun run smoke:cli:phaseA`. Smoke runs init on a temp vault, starts daemon, queries status, shuts down — all over socket, asserting NDJSON envelope shape.

**Risks:**
- Bun `--compile` producing a binary that survives bundled `sql-wasm.wasm` + `hnswlib-wasm` + OpenTUI Zig core path resolution. Verify on day 1.
- `SettingsService` rebind ripples through ~20 callsites; mechanical but wide.

### Phase B — Indexer, search, health, vitals, bridge probe, chokidar

*Goal:* The substrate runs end-to-end without a UI.

**Deliverables:**
1. `notient awaken [--batch N] [--since <iso>]` wraps existing `indexNote` + `IndexerQueue`. Streams `indexer:*` events.
2. `notient reindex <glob>`.
3. `notient search query="…" [mode=quick|balanced|deep] [filters]` wraps `SearchPipeline`. Streams `search:*` events.
4. `notient vitals <path>` wraps `VitalsService.computeSnapshot`.
5. `notient health` wraps `HealthMonitor.probeAll` plus bridge probe and optional vision-endpoint probe.
6. `src/bridge/obsidianProbe.ts`: 30s polling.
7. `src/bridge/obsidianCli.ts`: shell-out for read-style verb subset.
8. Daemon: chokidar watcher with WSL-detection → polling fallback.
9. Coordinator runs autonomously inside the daemon (subagent on-demand tools come in Phase C).
10. `smoke:cli:phaseB` integration test: awaken fixture vault, balanced search returns >0 hits, vitals returns sane shape, health is green.

**Gate:** `smoke:cli:phaseB` plus the full template.

**Risks:**
- Embedding LLM cold-start on first awaken; budget 30s for first batch.
- WSL polling cadence on user's actual vault size (vaultex is unmeasured) — tunable via config.

### Phase C — Agent, tools, chat, TUI

*Goal:* `notient` lands in chat REPL. Per-tool approval gates fire mid-chat. Vision works or fails visibly.

**Deliverables:**
1. `src/agent/identity.ts` — Tier 1 prompt.
2. `src/agent/notientAgent.ts` — wraps existing `agentLoop.ts`, assembles eight-layer prompt via refit `ContextManager`.
3. `src/agent/attachments.ts` — `@<path>` resolver: md/text/code/json/csv inline; pdf via `unpdf`; canvas JSON parsed; base via `obsidian base:query format=json` when bridge up else raw JSON; image via vision route or fail.
4. `src/agent/tools/{vault,obsidian,substrate,subagent}.ts`.
5. Per-tool approval policy in `ApprovalGate`.
6. Vision: `visionLLM` slot in kernel. Probe primary, route to endpoint, or fail with `VISION_UNAVAILABLE`.
7. `notient chat "<prompt>" [--ndjson] [@file ...]` single-shot.
8. `src/cli/tui/`: OpenTUI app — `App.tsx`, `ChatView.tsx`, `InputBar.tsx`, `StatusBar.tsx`, `slashCommands.ts`, `attachments.ts`, `completion.ts`. Streaming via OpenTUI React reconciler. Markdown via `<Markdown>`. Code via `<Code>`. Slash commands `/read /search /awaken /vitals /stream /undo /history /quit`.
9. `smoke:cli:phaseC`: programmatic chat round produces `loop:tool_call_started` for `vault.read`, `loop:assistant_delta` stream, `turn:complete`. Image-without-vision fails with `VISION_UNAVAILABLE`.

**Gate:** `smoke:cli:phaseC` plus a live TUI session against the fixture vault, manual checklist of 8 interactions in `docs/superpowers/plans/2026-04-27-cli-phase-c-checklist.md`.

**Risks:**
- OpenTUI streaming pattern is undocumented; budget 1 day to mine OpenCode's source and codify.
- Per-tool approval policy is a new config layer; default-derivation when `approvalMode` flips between safe/yolo needs care.
- Vision: LMStudio `image_url` support varies by model; fail-visibly path covers the unhappy case.

### Phase D — Stream, approvals, apply, undo, propose, canvas, subagent on-demand

*Goal:* "Sentient vault" surface fully exposed.

**Deliverables:**
1. `notient stream [--limit N] [--agent X] [--kind Y] [--watch]`.
2. `notient apply <proposalId> [--dry]`.
3. `notient reject <proposalId> [--reason "…"]`.
4. `notient undo [--steps N]` and `notient undo --target <historyId>`.
5. `notient history [--limit N] [--target <path>]`.
6. `notient propose <kind> <payload-json>`.
7. `notient export-canvas <proposalId>`.
8. **TUI approval cards.** When a tool with `policy: ask` fires mid-chat, the TUI splits a panel showing the proposed action with before/after diff via OpenTUI `<Diff>`. `Y` accepts, `N` rejects, `R` shows reasoning. The agent loop resumes.
9. Subagent on-demand tools wired up.
10. `smoke:cli:phaseD`: agent finds-applies-undoes round trip without manual intervention.

**Gate:** `smoke:cli:phaseD` plus 8-hour daemon soak test.

**Risks:**
- `notient stream --watch` is a long-lived NDJSON RPC stream; resync semantics on client reconnect need tests.
- Subagent on-demand and autonomous can both write to staging. `EchoGuard` and proposal `id` PK collision both already prevent dupes; verify under concurrent load.

### Phase E — Schema, full Obsidian bridge, polish, docs, v0.1.0 tag

*Goal:* Notient is self-describing for agentic consumers. Every Obsidian CLI verb has a Notient passthrough. Cross-platform binaries built.

**Deliverables:**
1. `src/cli/schema/registry.ts` — single source of truth.
2. `notient schema [--section …]`.
3. `--help` everywhere, generated.
4. Full Obsidian bridge surface — write-style + strict-Obsidian verbs.
5. Per-platform compiled binaries: `notient-linux-x64`, `notient-windows-x64.exe` for v0.1; arm64/macOS deferred if cross-compile is painful.
6. `README.md` rewritten with three sections: human quick-start, single-shot recipes, agentic-consumer integration.
7. `docs/agentic-consumers.md` — exact format Claude Code / Codex / Aider should expect.
8. `smoke:cli:phaseE`.
9. `git tag v0.1.0` on `beta-spec`.

**Gate:** every gate from A–D plus `smoke:cli:phaseE`.

**Risks:**
- Cross-platform Bun `--compile` for non-host targets may need a CI matrix or homelab runner. v0.1 ships linux-x64 + windows-x64 from the dev host; arm64/macOS deferred.
- README format for agentic consumers has no precedent; we invent it based on `notient schema`.

### Sequencing

A → B → C → D → E. No phase parallelism. C waits on B's gate green (the agent uses real `vault.search`, real `vitals`). D waits on C's gate green (approval cards live inside the TUI). E can be partially parallelized with D once D's smoke passes.

**Per-phase commits.** Each deliverable inside a phase is its own commit on `beta-spec`. No `git add -A`. Stage by name.

**Phase-end checkpoints.** End of A: demo daemon socket, show what the nuke deleted, get review before B. End of B: live awaken + search demo. End of C: live TUI chat session. End of D: end-to-end propose-apply-undo demo. End of E: agentic-consumer tour and v0.1.0 tag.

---

## 7. Archive-and-nuke policy

Aggressive deletion with a local safety net. Phase A moves files to `.nuked/<original-path>` instead of `git rm`. Git sees deletions; disk keeps bytes. Recovery is `mv .nuked/<path> <path>`.

**Phase A first commit housekeeping:**
1. Append `/.nuked/` to `.gitignore`.
2. Append `".nuked"` to `tsconfig.json` `exclude` array.
3. Add `.nuked/**` to `biome.json` `files.ignore`.
4. Add Archive subsection to `.claude/CLAUDE.md`: *".nuked/ holds pre-pivot code retained for reference. Never import from it. Never restore without explicit approval."*

**Move semantics.** `mv src/main.ts .nuked/src/main.ts` shows as `deleted: src/main.ts` in `git status`. Commit message names the move:

```
chore(nuke): archive Obsidian plugin entry to .nuked/

Moved (not deleted):
- src/main.ts → .nuked/src/main.ts
```

**Aggression policy.** When in doubt during Phase A, move it. Substrate tests fail loudly if we move something the substrate needs; move-back is one command. Erring toward over-archive is cheaper than erring toward leftover dead code.

---

## 8. Hard rules (carry forward)

- TypeScript strict.
- No `console.log` outside the structured CLI emitter (`src/cli/output.ts`) or the existing `debug<Subsystem>` helpers (`debugCoAuthor`, `debugChat`, `debugStream`, `debugVitals`, `debugSearch`).
- No abbreviations: `context` not `ctx`, `error` not `err`, `message` not `msg`, `event` not `evt`, `index` not `idx`, `options` not `opts`.
- No `[noun] - [parenthetical clause]` dash-clause prose anywhere — code, comments, commit messages, docs, `--help` text.
- No emojis in source.
- One commit per logical step on `beta-spec`. No `git add -A`. Stage by name.
- No tests deleted unless the contract being tested is itself removed. UI tests die with the UI; substrate tests stay green throughout.
- Substrate is locked. Reasoning host, chat model, embedding model, sql.js, hnswlib-wasm — none change.

---

## 9. Open risks

| Risk | Phase | Mitigation |
|---|---|---|
| Bun `--compile` doesn't bundle native WASM cleanly | A | Day-1 smoke; fallback is loose-file distribution with shell wrapper. |
| OpenTUI breaks under us pre-1.0 | C, ongoing | Pin `0.1.105`. Bump deliberately. Escape: rewrite `src/cli/tui/**` against another lib. Daemon untouched. |
| OpenTUI streaming pattern undocumented | C | Mine OpenCode's source (production user). 1-day budget. |
| WSL polling cadence wrong for user's vault | B | Tunable via `config.json` → `indexer.pollIntervalMs`. |
| LMStudio `image_url` support varies per model | C | Probe-or-fail. `VISION_UNAVAILABLE` is the unhappy path. |
| Cross-compile pain for arm64/macOS targets | E | v0.1 ships linux-x64 + windows-x64 from dev host; defer rest. |
| Agentic-consumer README has no precedent | E | Invent based on `notient schema`. |
| Substrate tests reference removed UI helpers | A | Tests for archived contracts move with the contracts. Substrate tests stay. |
| Concurrent autonomous + on-demand subagent collisions | D | `EchoGuard` + proposal-id PK already prevent dupes. Test under load. |

---

## 10. Glossary

- **Notient** — the product. Local-first agentic CLI for sentient vaults.
- **Sentient vault** — a vault the substrate keeps thinking about in the background, surfacing proposals.
- **Substrate** — the locked backend: DB, HNSW, indexer, search, agents, coordinator, vitals, stream, approvals, history.
- **Bridge** — `obsidian` CLI shell-out path. Up when Obsidian is running.
- **Adapter** — the FS path. Always available.
- **Subagent** — one of five specialists (linker, synthesizer, contradictionHunter, maturityAdvancer, dbscan helper) that produces proposals to staging tables.
- **Coordinator** — autonomous scheduler for subagents.
- **Proposal** — a row in `staging_edges` or `staging_nodes`. Awaits approval to promote into the live graph and (where applicable) the note.
- **Sentience surface** — what the user sees: `notient stream`, vitals on a note, proposals applied via `notient apply`, undo via `notient undo`.
- **Agentic consumer** — another agent (Claude Code, Codex, Aider) that reads `notient schema` and drives Notient as a tool.
